import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as models from '../src/models/runtime.js';
import { getResolutionPlan } from '../src/modules/stocktake-closure/stocktake-resolution.service.js';

const id = value => new mongoose.Types.ObjectId(value);
const hex = char => char.repeat(24);
const warehouseId = hex('a'), locationId = hex('b'), batchId = hex('c'), productId = hex('d'), balanceId = hex('e'), otherBalanceId = hex('f');
const planId = hex('1'), previousPlanId = hex('2'), itemId = hex('3'), snapshotId = hex('4'), countId = hex('5'), userId = hex('6'), reviewerId = hex('7'), evidenceId = hex('8'), lostEvidenceId = hex('9');
const ST = 'KK - T - 261115 - 000001';
const user = (code = 'WAREHOUSE', warehouseIds = [warehouseId], permissions = ['stock_adjustment:read']) => ({
  isActive: true, warehouseIds, roleId: { code, isActive: true, permissionIds: permissions.map(code => ({ code })) },
});
const rows = value => ({ select: () => ({ lean: async () => value }) });
const BOOK = '9007199254740993.25', COUNTED = '9007199254740990.75';

const plan = (overrides = {}) => ({
  _id: id(planId), documentNo: 'PAXLKK - T - 261115 - 000002', documentKind: 'ST_RESOLUTION', workflowStatus: 'APPROVED', version: 2,
  createdBy: id(userId), occurredAt: new Date('2026-11-15T01:00:00Z'),
  header: { stocktakeId: ST, planVersion: 2, scopeVersion: 1, previousPlanId: id(previousPlanId), reason: 'Missing tiles', proposedBy: id(userId), proposedAt: new Date('2026-11-15T01:00:00Z'), approvalId: id(hex('0')) },
  items: [{ _id: id(itemId), lineNo: 1, lineKind: 'ST_RESOLUTION', productId: id(productId), lotId: id(batchId), baseUnitSnapshot: 'PIECE', productNameSnapshot: 'Test tile', qtyBase: '2.5', details: { countId: id(countId), actionKind: 'DELTA', deltaQty: '-2.5', fromBalanceId: id(balanceId) } }],
  selectedCounts: [{ snapshotId: id(snapshotId), countId: id(countId) }],
  reviewDecisions: [{ decisionId: id(hex('0')), revision: 2, reviewedBy: id(reviewerId), reviewedAt: new Date('2026-11-15T02:00:00Z'), decision: 'APPROVE', reason: 'Checked' }],
  executionRecords: [{ itemId: id(itemId), performedBy: id(userId), performedAt: new Date('2026-11-15T03:00:00Z'), quantityBase: '1.25', evidenceIds: [id(evidenceId), id(lostEvidenceId)] }],
  ...overrides,
});
const document = (plans = [plan()]) => ({
  _id: ST, documentNo: ST, workflowStatus: 'APPROVED', version: 9,
  header: { warehouseId: id(warehouseId), scopeVersion: 1, scopeLocationIds: [id(locationId)], cutoffAt: new Date('2026-11-14T00:00:00Z'), assignedCounterIds: [id(userId)], selectedCounts: [] },
  resolutionPlans: plans,
});
const snapshot = { _id: id(snapshotId), locationId: id(locationId), batchId: id(batchId), sourceBalanceId: id(balanceId), ownerType: 'STORE', qualityStatus: 'GOOD', bookQtyBase: BOOK, baseUnitSnapshot: 'PIECE', origin: 'BOOK' };
const count = { _id: id(countId), snapshotId: id(snapshotId), locationId: id(locationId), targetType: 'STOCK', attemptNo: 1, countedQtyBase: COUNTED, baseUnitSnapshot: 'PIECE', countedBy: id(userId), countedAt: new Date('2026-11-14T05:00:00Z') };

function setup({ record = document(), snapshots = [snapshot], counts = [count], evidence = [{ _id: id(evidenceId), status: 'ATTACHED', originalName: 'proof.jpg', mediaType: 'image/jpeg' }] } = {}) {
  const calls = {};
  mock.method(models.Stocktake, 'findOne', filter => { calls.findOne = filter; return { select: () => ({ lean: async () => record }) }; });
  mock.method(models.StocktakeCount, 'find', filter => { calls.counts = filter; return rows(counts); });
  mock.method(models.StocktakeSnapshot, 'find', filter => { calls.snapshots = filter; return rows(snapshots); });
  mock.method(models.Attachment, 'find', filter => { calls.evidence = filter; return rows(evidence); });
  mock.method(models.Warehouse, 'find', () => rows([{ _id: id(warehouseId), code: 'WH-T', name: 'Test warehouse' }]));
  mock.method(models.WarehouseLocation, 'find', filter => { calls.locations = filter; return rows([{ _id: id(locationId), warehouseId: id(warehouseId), code: 'A-01', name: 'Aisle' }]); });
  mock.method(models.ProductBatch, 'find', () => rows([{ _id: id(batchId), productId: id(productId), manufacturerLot: 'LOT-T' }]));
  mock.method(models.Product, 'find', () => rows([{ _id: id(productId), sku: 'SKU-T', name: 'Test tile' }]));
  mock.method(models.User, 'find', () => rows([{ _id: id(userId), username: 'staff', fullName: 'Staff' }, { _id: id(reviewerId), username: 'owner', fullName: 'Owner' }]));
  for (const model of [models.Stocktake, models.StocktakeSnapshot, models.StocktakeCount, models.ApprovalHistory, models.StockAdjustment, models.Attachment])
    for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'bulkWrite'])
      mock.method(model, method, () => assert.fail(`${model.modelName}.${method} must not be called by a read`));
  return calls;
}
afterEach(() => mock.restoreAll());

test('detail returns before, counted and difference as exact decimals beyond double precision', async () => {
  const calls = setup();
  const result = await getResolutionPlan(user(), planId);
  assert.deepEqual(calls.findOne, { 'resolutionPlans._id': planId });
  assert.deepEqual(calls.counts, { stocktakeId: ST, _id: { $in: [countId] } });
  assert.deepEqual(calls.snapshots.$or, [{ _id: { $in: [snapshotId] } }, { sourceBalanceId: { $in: [balanceId] } }]);
  const line = result.plan.items[0];
  assert.deepEqual(line.variance, { locationId, qualityStatus: 'GOOD', baseUnit: 'PIECE', bookQtyBase: BOOK, countedQtyBase: COUNTED, differenceBase: '-2.5' });
  assert.equal(line.snapshotId, snapshotId);
  assert.equal(line.fromSnapshotId, snapshotId);
  assert.equal(line.toSnapshotId, null);
  assert.equal(line.executedQtyBase, '1.25');
  assert.equal(line.details.deltaQty, '-2.5');
  assert.equal(line.lotId, batchId);
  assert.equal(result.snapshots[0].bookQtyBase, BOOK);
  assert.equal(result.counts[0].countedQtyBase, COUNTED);
});

test('detail carries stocktake header, version links, decisions, executions and lookup labels', async () => {
  setup({ record: document([plan({ _id: id(previousPlanId), documentNo: 'PAXLKK - T - 261115 - 000001', workflowStatus: 'REJECTED', version: 1, header: { ...plan().header, planVersion: 1, previousPlanId: undefined } }), plan()]) });
  const result = await getResolutionPlan(user(), planId);
  assert.equal(result.plan.id, planId);
  assert.equal(result.plan.planVersion, 2);
  assert.equal(result.plan.previousPlanId, previousPlanId);
  assert.equal(result.plan.proposedAt, '2026-11-15T01:00:00.000Z');
  assert.deepEqual(result.versions.map(row => [row.id, row.planVersion, row.workflowStatus]), [[previousPlanId, 1, 'REJECTED'], [planId, 2, 'APPROVED']]);
  assert.deepEqual(result.stocktake.header, { warehouseId, scopeVersion: 1, scopeLocationIds: [locationId], plannedAt: null, cutoffAt: '2026-11-14T00:00:00.000Z', activatedAt: null, completedAt: null });
  assert.equal(result.stocktake.documentNo, ST);
  assert.equal(result.plan.reviewDecisions[0].reviewedBy, reviewerId);
  assert.equal(result.plan.reviewDecisions[0].decision, 'APPROVE');
  assert.equal(result.plan.executionRecords[0].performedBy, userId);
  assert.deepEqual(result.lookups.warehouses, [{ id: warehouseId, code: 'WH-T', name: 'Test warehouse' }]);
  assert.deepEqual(result.lookups.locations, [{ id: locationId, code: 'A-01', name: 'Aisle', warehouseId }]);
  assert.deepEqual(result.lookups.batches, [{ id: batchId, productId, manufacturerLot: 'LOT-T' }]);
  assert.deepEqual(result.lookups.products, [{ id: productId, sku: 'SKU-T', name: 'Test tile' }]);
  assert.deepEqual(result.lookups.users.map(row => row.id).sort(), [reviewerId, userId].sort());
  assert.equal('passwordHash' in result.lookups.users[0], false);
});

test('unresolvable evidence keeps its identity and is marked unavailable', async () => {
  setup();
  const [record] = (await getResolutionPlan(user(), planId)).plan.executionRecords;
  assert.deepEqual(record.evidence, [
    { id: evidenceId, available: true, status: 'ATTACHED', originalName: 'proof.jpg', mediaType: 'image/jpeg' },
    { id: lostEvidenceId, available: false },
  ]);
});

test('missing snapshot or count leaves the line readable without a fabricated variance', async () => {
  setup({ snapshots: [], counts: [] });
  const result = await getResolutionPlan(user(), planId);
  const line = result.plan.items[0];
  assert.equal(line.variance, null);
  assert.equal(line.snapshotId, null);
  assert.equal(line.fromSnapshotId, null);
  assert.equal(line.qtyBase, '2.5');
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(result.counts, []);
  assert.deepEqual(result.lookups.locations, []);
});

test('unknown plan is not found and loads nothing else', async () => {
  setup({ record: null });
  await assert.rejects(getResolutionPlan(user(), planId), error => error.statusCode === 404);
  assert.equal(models.StocktakeCount.find.mock.callCount(), 0);
});

test('out-of-scope warehouse is refused before related reads', async () => {
  setup();
  await assert.rejects(getResolutionPlan(user('WAREHOUSE', [hex('0')]), planId), error => error.statusCode === 403 && error.code === 'ERR-CORE-403-002');
  assert.equal(models.StocktakeCount.find.mock.callCount(), 0);
  assert.equal(models.StocktakeSnapshot.find.mock.callCount(), 0);
  assert.equal(models.User.find.mock.callCount(), 0);
});

test('missing permission is refused before the document is read; owner needs no assignment', async () => {
  setup();
  await assert.rejects(getResolutionPlan(user('WAREHOUSE', [warehouseId], ['stocktake:read']), planId), error => error.statusCode === 403);
  assert.equal(models.Stocktake.findOne.mock.callCount(), 0);
  const result = await getResolutionPlan(user('OWNER', []), planId);
  assert.equal(result.plan.id, planId);
});
