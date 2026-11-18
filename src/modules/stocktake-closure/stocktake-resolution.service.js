import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { serialize } from '../../shared/utils/persistence.js';
import { requirePermission, requireWarehouseAccess } from '../../shared/utils/access.js';
import { notFoundError } from '../../shared/utils/ApiError.js';
import { buildResolutionScope, buildResolutionPlanFilter } from './stocktake-resolution.query.js';
import { isBlind } from './stocktake-closure.service.js';

const READ = 'stock_adjustment:read';
const ids = rows => [...new Set(rows.filter(value => value != null).map(String))];
const label = row => ({ id: String(row._id), code: row.code, name: row.name });
const userLabel = row => ({ id: String(row._id), username: row.username, fullName: row.fullName });
const findUsers = userIds => (userIds.length ? m.User.find({ _id: { $in: userIds } }).select('_id username fullName').lean() : Promise.resolve([]));

// Maps a location to the plan lines that touch it: through the selected count, or either balance endpoint.
async function resolveLocationRefs(scope, locationId) {
  const stocktakeIds = await m.Stocktake.distinct('_id', scope);
  if (!stocktakeIds.length) return null;
  const snapshots = await m.StocktakeSnapshot.find({ stocktakeId: { $in: stocktakeIds }, locationId }).select('_id sourceBalanceId').lean();
  if (!snapshots.length) return null;
  const counts = await m.StocktakeCount.find({ stocktakeId: { $in: stocktakeIds }, snapshotId: { $in: snapshots.map(row => row._id) } }).select('_id').lean();
  const countIds = counts.map(row => row._id), balanceIds = snapshots.map(row => row.sourceBalanceId).filter(Boolean);
  return countIds.length || balanceIds.length ? { countIds, balanceIds } : null;
}

export async function listResolutionPlans(user, query) {
  requirePermission(user, READ);
  // Plans of a session counting again (cancelled by "Mở lại bước đếm") are not listed: their lines, lots and
  // locations would hint at the blind book. They reappear once the session is reconciled again.
  // Same rule as isBlind: counting, or cancelled without ever being reconciled.
  const scope = { ...buildResolutionScope(user, query), $nor: [{ workflowStatus: 'COUNTING' }, { workflowStatus: 'CANCELLED', 'header.lastReconciledAt': null, 'header.lastReconciledBy': null }] };
  const empty = { items: [], total: 0, page: query.page, limit: query.limit, lookups: { warehouses: [], users: [] } };
  let locationRefs = null;
  if (query.locationId) {
    locationRefs = await resolveLocationRefs(scope, query.locationId);
    if (!locationRefs) return empty;
  }
  const filter = buildResolutionPlanFilter(query, locationRefs);
  const [result] = await m.Stocktake.aggregate([
    { $match: scope },
    { $unwind: '$resolutionPlans' },
    { $match: filter },
    { $sort: { 'resolutionPlans.header.proposedAt': -1, 'resolutionPlans._id': -1 } },
    { $facet: {
      items: [
        { $skip: (query.page - 1) * query.limit },
        { $limit: query.limit },
        { $project: {
          _id: 0,
          id: '$resolutionPlans._id',
          documentNo: '$resolutionPlans.documentNo',
          planVersion: '$resolutionPlans.header.planVersion',
          workflowStatus: '$resolutionPlans.workflowStatus',
          reason: '$resolutionPlans.header.reason',
          proposedBy: { $ifNull: ['$resolutionPlans.header.proposedBy', '$resolutionPlans.createdBy'] },
          proposedAt: { $ifNull: ['$resolutionPlans.header.proposedAt', '$resolutionPlans.occurredAt'] },
          scopeVersion: '$resolutionPlans.header.scopeVersion',
          lineCount: { $size: { $ifNull: ['$resolutionPlans.items', []] } },
          stocktakeId: '$_id',
          stocktakeNo: '$documentNo',
          stocktakeStatus: '$workflowStatus',
          warehouseId: '$header.warehouseId',
        } },
      ],
      total: [{ $count: 'value' }],
    } },
  ]);
  const items = serialize(result?.items || []);
  const [warehouses, users] = await Promise.all([
    items.length ? m.Warehouse.find({ _id: { $in: ids(items.map(row => row.warehouseId)) } }).select('_id code name').lean() : [],
    findUsers(ids(items.map(row => row.proposedBy))),
  ]);
  return {
    items, total: result?.total?.[0]?.value ?? 0, page: query.page, limit: query.limit,
    lookups: { warehouses: warehouses.map(label), users: users.map(userLabel) },
  };
}

const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));

export async function getResolutionPlan(user, planId) {
  requirePermission(user, READ);
  const document = await m.Stocktake.findOne({ 'resolutionPlans._id': planId }).select('documentNo workflowStatus version header resolutionPlans').lean();
  const stocktake = document && serialize(document);
  const plan = stocktake?.resolutionPlans.find(row => String(row._id) === String(planId));
  if (!plan) throw notFoundError();
  requireWarehouseAccess(user, stocktake.header.warehouseId);
  for (const key of ['items', 'selectedCounts', 'reviewDecisions', 'executionRecords']) plan[key] ||= [];

  const scope = { stocktakeId: stocktake._id };
  const countIds = ids(plan.items.map(item => item.details?.countId));
  const balanceIds = ids(plan.items.flatMap(item => [item.details?.fromBalanceId, item.details?.toBalanceId]));
  const counts = serialize(await m.StocktakeCount.find({ ...scope, _id: { $in: countIds } }).select('_id snapshotId locationId targetType attemptNo countedQtyBase baseUnitSnapshot countedBy countedAt').lean());
  const snapshotIds = ids(counts.map(row => row.snapshotId));
  const snapshots = serialize(await m.StocktakeSnapshot.find({
    ...scope, scopeVersion: plan.header.scopeVersion,
    $or: [{ _id: { $in: snapshotIds } }, { sourceBalanceId: { $in: balanceIds } }],
  }).select('_id locationId batchId sourceBalanceId ownerType ownerId qualityStatus bookQtyBase baseUnitSnapshot origin').lean());
  const evidenceIds = ids(plan.executionRecords.flatMap(record => record.evidenceIds || []));
  const evidence = new Map(serialize(evidenceIds.length ? await m.Attachment.find({ _id: { $in: evidenceIds } }).select('_id status originalName mediaType').lean() : []).map(row => [String(row._id), row]));

  const countById = new Map(counts.map(row => [String(row._id), row]));
  const snapshotById = new Map(snapshots.map(row => [String(row._id), row]));
  const snapshotByBalance = new Map(snapshots.filter(row => row.sourceBalanceId).map(row => [String(row.sourceBalanceId), row]));
  const lines = plan.items.map(item => {
    const details = item.details || {};
    const count = countById.get(String(details.countId));
    const snapshot = count && snapshotById.get(String(count.snapshotId));
    const done = plan.executionRecords.filter(record => String(record.itemId) === String(item._id))
      .reduce((total, record) => total.plus(record.quantityBase), exact('0'));
    return {
      id: String(item._id), lineNo: item.lineNo, productId: item.productId, lotId: item.lotId ?? null,
      productNameSnapshot: item.productNameSnapshot, baseUnitSnapshot: item.baseUnitSnapshot, qtyBase: item.qtyBase,
      executedQtyBase: done.toFixed(),
      details: pick(details, ['actionKind', 'deltaQty', 'countId', 'fromBalanceId', 'toBalanceId', 'holdId', 'reasonCode', 'reasonNote']),
      snapshotId: snapshot ? String(snapshot._id) : null,
      fromSnapshotId: snapshotByBalance.get(String(details.fromBalanceId))?._id ?? null,
      toSnapshotId: snapshotByBalance.get(String(details.toBalanceId))?._id ?? null,
      // Exact decimals from the frozen snapshot and the selected count; null when either record is unavailable.
      variance: snapshot ? {
        locationId: snapshot.locationId, qualityStatus: snapshot.qualityStatus, baseUnit: snapshot.baseUnitSnapshot,
        bookQtyBase: snapshot.bookQtyBase, countedQtyBase: count.countedQtyBase,
        differenceBase: exact(count.countedQtyBase).minus(snapshot.bookQtyBase).toFixed(),
      } : null,
    };
  });

  const locationIds = ids(snapshots.map(row => row.locationId));
  const lotIds = ids(plan.items.map(item => item.lotId));
  const userIds = ids([plan.createdBy, plan.header.proposedBy, plan.header.closedBy,
    ...plan.reviewDecisions.map(row => row.reviewedBy), ...plan.executionRecords.map(row => row.performedBy)]);
  const [warehouses, locations, batches, users] = await Promise.all([
    m.Warehouse.find({ _id: stocktake.header.warehouseId }).select('_id code name').lean(),
    locationIds.length ? m.WarehouseLocation.find({ _id: { $in: locationIds }, warehouseId: stocktake.header.warehouseId }).select('_id warehouseId code name').lean() : [],
    lotIds.length ? m.ProductBatch.find({ _id: { $in: lotIds } }).select('_id productId manufacturerLot').lean() : [],
    findUsers(userIds),
  ]);
  const productIds = ids([...plan.items.map(item => item.productId), ...batches.map(row => row.productId)]);
  const products = productIds.length ? await m.Product.find({ _id: { $in: productIds } }).select('_id sku name').lean() : [];

  const versions = stocktake.resolutionPlans
    .map(row => ({ id: String(row._id), documentNo: row.documentNo, planVersion: row.header.planVersion, workflowStatus: row.workflowStatus }))
    .sort((a, b) => a.planVersion - b.planVersion);
  const header = stocktake.header;
  const result = {
    plan: {
      id: String(plan._id), documentNo: plan.documentNo, workflowStatus: plan.workflowStatus, version: plan.version,
      planVersion: plan.header.planVersion, scopeVersion: plan.header.scopeVersion, previousPlanId: plan.header.previousPlanId ?? null,
      reason: plan.header.reason ?? null, note: plan.note ?? null, createdBy: plan.createdBy,
      proposedBy: plan.header.proposedBy ?? plan.createdBy, proposedAt: plan.header.proposedAt ?? plan.occurredAt ?? null,
      approvalId: plan.header.approvalId ?? null, closureBatchId: plan.header.closureBatchId ?? null,
      closedBy: plan.header.closedBy ?? null, closedAt: plan.header.closedAt ?? null,
      items: lines,
      selectedCounts: plan.selectedCounts.map(row => pick(row, ['snapshotId', 'countId'])),
      reviewDecisions: plan.reviewDecisions.map(row => pick(row, ['decisionId', 'revision', 'reviewedBy', 'reviewedAt', 'decision', 'reason'])),
      executionRecords: plan.executionRecords.map(record => ({
        ...pick(record, ['itemId', 'performedBy', 'performedAt', 'quantityBase', 'transactionId', 'note']),
        evidence: (record.evidenceIds || []).map(id => {
          const row = evidence.get(String(id));
          return row ? { id: String(id), available: true, status: row.status, originalName: row.originalName, mediaType: row.mediaType } : { id: String(id), available: false };
        }),
      })),
    },
    stocktake: {
      id: String(stocktake._id), documentNo: stocktake.documentNo, workflowStatus: stocktake.workflowStatus, version: stocktake.version,
      header: pick(header, ['warehouseId', 'scopeVersion', 'scopeLocationIds', 'plannedAt', 'cutoffAt', 'activatedAt', 'completedAt']),
    },
    versions,
    snapshots: snapshots.map(row => ({ ...pick(row, ['locationId', 'batchId', 'sourceBalanceId', 'ownerType', 'ownerId', 'qualityStatus', 'bookQtyBase', 'baseUnitSnapshot', 'origin']), id: String(row._id) })),
    counts: counts.map(row => ({ ...pick(row, ['snapshotId', 'locationId', 'targetType', 'attemptNo', 'countedQtyBase', 'baseUnitSnapshot', 'countedBy', 'countedAt']), id: String(row._id) })),
    lookups: {
      warehouses: warehouses.map(label),
      locations: locations.map(row => ({ ...label(row), warehouseId: String(row.warehouseId) })),
      batches: batches.map(row => ({ id: String(row._id), productId: String(row.productId), manufacturerLot: row.manufacturerLot })),
      products: products.map(row => ({ id: String(row._id), sku: row.sku, name: row.name })),
      users: users.map(userLabel),
    },
  };
  // While the session counts blind again, a cancelled plan keeps only its identity: lines, selected counts,
  // executions, snapshots and counts would reveal the frozen book.
  if (!isBlind(stocktake)) return result;
  return {
    ...result, plan: { ...result.plan, items: [], selectedCounts: [], executionRecords: [] }, snapshots: [], counts: [],
    lookups: { ...result.lookups, locations: [], batches: [], products: [] },
  };
}
