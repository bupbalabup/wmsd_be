import {
  PurchaseReceipt,
  GoodsInspection,
  GoodsArrival,
  ApprovalHistory,
  StockTransaction,
  StockReversal,
  InventoryBalance,
  DefectReport,
} from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { checkVersion, saveVersion, same } from '../../shared/utils/document-command.js';
import { requirePermission } from '../../shared/utils/access.js';
import { validationError, versionConflict } from '../../shared/utils/ApiError.js';
import {
  sourceContext,
  guardLocations,
  locationAt,
  balanceAt,
  splitPortions,
  freeQuantity,
  verifyCapacity,
} from '../../shared/utils/stock.js';
import { findPurchase } from '../../shared/utils/purchase-core.js';

export async function custody(id, actor, session, version) {
  const d = await findPurchase(id, actor, session, { kind: 'CUSTODY_RECEIPT' });
  if (version != null) checkVersion(d, version);
  if (d.workflowStatus !== 'POSTED' || d.header.ownerType !== 'SUPPLIER') {
    throw validationError('Cần phiếu giữ hộ NCC đã post');
  }
  return d;
}

export async function origin(d, item, session) {
  const ref = item.sources.find(r => r.subjectCollection === 'goods_inspections');
  const inspection = ref && await GoodsInspection.findById(ref.documentId).session(session);
  const row = inspection?.items.id(ref.itemId);
  const arrival = inspection && await GoodsArrival.findById(inspection.header.arrivalId).session(session);
  const arrived = arrival?.items.id(row?.details.inspectedSourceLineId);
  if (!row || !arrived || !same(arrival.header.supplierId, d.header.ownerId)) {
    throw validationError('Nguồn giữ hộ không hợp lệ');
  }
  return { inspection, row, arrival, arrived };
}

export async function allocations(d, item, session) {
  const posting = await StockTransaction.findById(d.stockTransactionId).session(session);
  const moves = posting?.movements.filter(m => same(m.sourceLineId, item._id)) || [];
  if (moves.length !== 1) throw validationError('Thiếu nguồn tồn giữ hộ');
  return moves[0];
}

// An ownership reversal can return cartons split from the original group under new portion IDs.
export async function restoredCustodyPortions(receipt, session) {
  const purchases = await PurchaseReceipt.find({
    workflowStatus: 'REVERSED',
    'items.sources': { $elemMatch: { subjectCollection: 'custody_receipts', documentId: receipt._id } },
    stockTransactionId: { $exists: true },
  }).select('items stockTransactionId').session(session);
  const restored = new Map();
  if (!purchases.length) return restored;
  const reversals = await StockReversal.find({
    'header.originalTransactionId': { $in: purchases.map(purchase => purchase.stockTransactionId) },
    workflowStatus: 'POSTED',
  }).select('header.originalTransactionId items stockTransactionId').session(session);
  for (const reversal of reversals) {
    const purchase = purchases.find(row => same(row.stockTransactionId, reversal.header.originalTransactionId));
    const original = await StockTransaction.findById(purchase.stockTransactionId).session(session);
    const returned = await StockTransaction.findOne({
      _id: reversal.stockTransactionId,
      reversedTransactionId: purchase.stockTransactionId,
    }).session(session);
    for (const movement of returned?.movements ?? []) {
      const reversedItem = reversal.items.id(movement.sourceLineId);
      const originalMove = original?.movements.find(move => reversedItem?.sources.some(ref => same(ref.itemId, move._id)));
      const purchaseItem = purchase.items.id(originalMove?.sourceLineId);
      const source = purchaseItem?.sources.find(ref => ref.subjectCollection === 'custody_receipts' && same(ref.documentId, receipt._id));
      if (!source?.itemId || !movement.toBalanceId || !same(originalMove.fromBalanceId, movement.toBalanceId) ||
          !same(originalMove.toBalanceId, movement.fromBalanceId)) continue;
      const key = String(source.itemId);
      const ids = restored.get(key) ?? new Set();
      for (const id of movement.packagingPortionIds ?? []) ids.add(String(id));
      restored.set(key, ids);
    }
  }
  return restored;
}

// Ownership changes and handback preserve the packaging already measured at intake.
export async function transferCustodyStock(sourceId, target, item, posting, actor, session, preferredIds) {
  const ctx = await sourceContext(sourceId, session);
  const source = ctx.balance;
  const amount = exact(item.qtyBase);
  if (!amount.gt(0) || amount.gt(await freeQuantity(source, session))) {
    throw validationError('Không đủ tồn chưa giữ');
  }
  if (await DefectReport.exists({ holds: { $elemMatch: { status: 'ACTIVE', 'allocations.balanceId': sourceId } } }).session(session)) {
    throw validationError('Tồn đang bị chặn');
  }
  const chosen = preferredIds?.length
    ? source.packagingPortions.filter(p => preferredIds.some(id => same(id, p._id)))
    : source.packagingPortions;
  const split = splitPortions(chosen, amount, actor._id);
  const kept = preferredIds?.length
    ? [...source.packagingPortions.filter(p => !preferredIds.some(id => same(id, p._id))), ...split.kept]
    : split.kept;
  const taken = split.taken;
  const before = exact(source.quantityBase);
  source.packagingPortions = kept;
  source.quantityBase = before.minus(amount).toFixed();
  await source.validate();
  const result = await InventoryBalance.updateOne(
    { _id: source._id, version: source.version },
    { $set: { quantityBase: source.quantityBase, packagingPortions: kept }, $inc: { version: 1 } },
    { session },
  );
  if (result.matchedCount !== 1) throw versionConflict('Tồn đã đổi');
  const move = {
    transactionId: posting._id,
    lineNo: posting.movements.length + 1,
    sourceLineId: item._id,
    fromBalanceId: source._id,
    quantityBase: amount.toFixed(),
    fromBefore: before.toFixed(),
    fromAfter: source.quantityBase,
    packagingPortionIds: taken.map(p => p._id),
  };
  if (target) {
    const previous = exact(target.quantityBase);
    target.quantityBase = previous.plus(amount).toFixed();
    target.packagingPortions.push(...taken);
    await target.validate();
    const write = await InventoryBalance.updateOne(
      { _id: target._id, version: target.version },
      { $set: { quantityBase: target.quantityBase, packagingPortions: target.packagingPortions }, $inc: { version: 1 } },
      { session },
    );
    if (write.matchedCount !== 1) throw versionConflict('Tồn đích đã đổi');
    Object.assign(move, { toBalanceId: target._id, toBefore: previous.toFixed(), toAfter: target.quantityBase });
  }
  posting.movements.push(move);
}

export async function postOwnedCustody(receipt, item, po, posting, actor, session) {
  requirePermission(actor, 'purchase_custody:execute');
  const ref = item.sources.find(s => s.subjectCollection === 'custody_receipts');
  const d = ref && await custody(ref.documentId, actor, session);
  const original = d?.items.id(ref.itemId);
  if (!original) throw validationError('Sai nguồn giữ hộ');
  const decision = await ApprovalHistory.findById(receipt.custodyDecisionId).session(session);
  if (!decision || decision.reviewedContent.action !== 'ACCEPT' || !same(decision.subjectId, d._id)) {
    throw validationError('Thiếu quyết định nhận sở hữu');
  }
  const move = await allocations(d, original, session);
  if (!same(move.toBalanceId, item.custodyBalanceId)) throw validationError('Sai balance nguồn');
  const ctx = await sourceContext(item.custodyBalanceId, session);
  if (ctx.balance.ownerType !== 'SUPPLIER' || !same(ctx.balance.ownerId, po.header.supplierId) ||
      !same(ctx.location?.warehouseId, po.header.warehouseId) || !same(ctx.balance.batchId, item.lotId)) {
    throw validationError('Sai chủ/lô/kho giữ hộ');
  }
  const inspection = await GoodsInspection.findById(item.inspectionId).session(session);
  const checked = inspection?.items.id(item.inspectionResultId);
  if (!checked || checked.details.qualityCode !== 'GOOD') throw validationError('Chưa có kết quả GOOD');
  const ids = move.packagingPortionIds?.length
    ? [...move.packagingPortionIds, ...((await restoredCustodyPortions(d, session)).get(String(original._id)) ?? [])]
    : undefined;
  await locationAt(item.destinationLocationId, po.header.warehouseId, ['RECEIVING'], session);
  await guardLocations([ctx.location._id, item.destinationLocationId], session);
  const target = await balanceAt(
    { type: 'LOCATION', locationId: item.destinationLocationId },
    { batchId: item.lotId, ownerType: 'STORE', ownerId: null },
    'GOOD',
    session,
  );
  await transferCustodyStock(item.custodyBalanceId, target, item, posting, actor, session, ids);
  await verifyCapacity([ctx.location._id, item.destinationLocationId], session);
  await saveVersion(d, d.version, session);
}
