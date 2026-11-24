import { StockReversal, StockTransaction, TransferOrder, GoodsInspection, GoodsArrival, PurchaseReceipt, CustodyReceipt, SupplierReturn, StocktakeCount, DefectReport, models } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { requirePermission, requireWarehouseAccess } from '../../shared/utils/access.js';
import { validationError, notFoundError } from '../../shared/utils/ApiError.js';
import { command, checkVersion, saveVersion, same } from '../../shared/utils/document-command.js';
import { dto } from '../../shared/utils/persistence.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import { guardLocations, sourceContext, splitPortions, beginStock, freeQuantity, verifyCapacity } from '../../shared/utils/stock.js';
import { purchaseOrderQuantities, receivingStatus } from '../purchase-orders/purchase-order.service.js';
import { findPurchase, newDocument, evidenceFor, replayPurchase } from './purchase-core.js';
import { restoredCustodyPortions, transferCustodyStock } from './purchase-custody.service.js';
import { prepare, activePo, inspectionSource } from './po-receiving.service.js';

async function checkDependentDocuments(receipt, custody, session) {
  for (const [collection, Model] of models) {
    if (!Model.schema.path('items') || collection === 'stock_reversals' || (custody && collection === 'goods_inspections')) continue;
    const dependent = await Model.findOne({
      workflowStatus: { $nin: ['CANCELLED', 'REJECTED', 'REVERSED'] },
      $or: [{ 'sources.documentId': receipt._id }, { 'items.sources.documentId': receipt._id }],
    }).select('documentKind documentNo workflowStatus').session(session);
    if (!dependent) continue;
    if (custody && collection === 'goods_receipts' && dependent.documentKind === 'PURCHASE') {
      const action = dependent.workflowStatus === 'DRAFT' ? 'Hủy' : 'Đảo';
      throw validationError(`${action} phiếu nhập ${dependent.documentNo} trước`);
    }
    throw validationError(`Có chứng từ phụ thuộc trong ${collection}: ${dependent.documentNo} (${dependent.workflowStatus})`);
  }
}

export async function eligible(receipt, actor, session) {
  if (receipt.workflowStatus !== 'POSTED') throw validationError('Phiếu chưa ghi hoặc đã đảo');
  const custody = receipt.documentKind === 'CUSTODY_RECEIPT';
  if (custody && receipt.header.ownerType !== 'SUPPLIER') throw validationError('Chỉ đảo phiếu giữ hộ nhà cung cấp');
  const original = await StockTransaction.findById(receipt.stockTransactionId).session(session);
  if (!original?.movements.length || original.reversedTransactionId ||
      await StockTransaction.exists({ reversedTransactionId: original._id }).session(session)) {
    throw validationError('Giao dịch gốc không đủ điều kiện đảo');
  }
  if (custody) await checkDependentDocuments(receipt, custody, session);

  const locations = [], balances = new Map(), portionIds = new Map();
  let restored;
  // Simulate deductions in the same order as posting, including shared balances.
  for (const move of [...original.movements].reverse()) {
    const item = receipt.items.id(move.sourceLineId);
    if (!item || (move.fromBalanceId && (custody || !item.custodyBalanceId)) || !move.toBalanceId) {
      throw validationError('Giao dịch không phải nhập mua thuần');
    }
    const balanceId = String(move.toBalanceId);
    let state = balances.get(balanceId);
    if (!state) {
      const { balance, location } = await sourceContext(move.toBalanceId, session);
      if (!location || !same(location.warehouseId, receipt.header.warehouseId)) throw validationError('Sai phạm vi nguồn nhập');
      if (await TransferOrder.exists({
        workflowStatus: { $in: ['DRAFT', 'OPEN', 'PARTIAL'] }, 'items.details.sourceBalanceId': move.toBalanceId,
      }).session(session)) throw validationError('Đã lập lệnh sử dụng nguồn tồn');
      if (await StocktakeCount.exists({
        locationId: location._id, recordedAt: { $gte: original.recordedAt },
      }).session(session)) throw validationError('Nguồn đã được kiểm kê sau nhập');
      if (await DefectReport.exists({
        holds: { $elemMatch: { status: 'ACTIVE', 'allocations.balanceId': move.toBalanceId } },
      }).session(session)) throw validationError('Tồn đang bị chặn');
      state = { location, portions: balance.packagingPortions, free: await freeQuantity(balance, session), required: exact('0') };
      balances.set(balanceId, state);
      locations.push(location._id);
    }

    const amount = exact(move.quantityBase);
    let ids = new Set((move.packagingPortionIds ?? []).map(String));
    // shortcut: historical movements without portion IDs use the full balance until there is a reliable backfill.
    let chosen = ids.size ? state.portions.filter(portion => ids.has(String(portion._id))) : state.portions;
    const quantity = portions => portions.reduce((sum, portion) => sum.plus(String(portion.quantityBase)), exact('0'));
    if (custody && chosen.length && ids.size && quantity(chosen).lt(amount)) {
      restored ??= await restoredCustodyPortions(receipt, session);
      ids = new Set([...ids, ...(restored.get(String(move.sourceLineId)) ?? [])]);
      chosen = state.portions.filter(portion => ids.has(String(portion._id)));
    }
    let kept;
    try {
      if (ids.size && !quantity(chosen).eq(amount)) throw validationError('Lượng theo quy cách gốc đã thay đổi');
      ({ kept } = splitPortions(chosen, amount, actor._id));
    } catch (error) {
      if (!ids.size || error.statusCode !== 400) throw error;
      throw validationError(`Hàng của phiếu đã bị chuyển, xuất hoặc mở thùng tại vị trí ${state.location.code}`);
    }
    state.required = state.required.plus(amount);
    if (state.required.gt(state.free)) throw validationError(`Hàng đang được giữ chỗ hoặc chờ chuyển, chỉ còn khả dụng ${state.free.toFixed()}`);
    state.portions = ids.size
      ? [...state.portions.filter(portion => !ids.has(String(portion._id))), ...kept]
      : kept;
    portionIds.set(String(move._id), [...ids]);
  }
  if (!custody) await checkDependentDocuments(receipt, custody, session);
  return { original, locations, portionIds };
}

export async function reversalPreflight(user, id, kind = 'GR_PURCHASE') {
  requirePermission(user, 'goods_receipt_inspection:reverse');
  requirePermission(user, 'goods_receipt_inspection:post');
  const receipt = await findPurchase(id, user, null, { kind });
  try {
    await eligible(receipt, user);
    return { eligible: true, receiptVersion: receipt.version };
  } catch (error) {
    if (error.statusCode !== 400) throw error;
    return { eligible: false, reason: error.message, receiptVersion: receipt.version };
  }
}

async function replayReversal(id, user, session) {
  const document = await StockReversal.findById(id).session(session);
  if (!document) throw notFoundError();
  for (const warehouseId of document.header.warehouseIds) requireWarehouseAccess(user, warehouseId);
  return document;
}

export async function getReversal(user, id) {
  requirePermission(user, 'goods_receipt_inspection:read');
  return dto(await replayReversal(id, user));
}

export function reverseReceipt(user, id, input, kind = 'GR_PURCHASE') {
  const custody = kind === 'CUSTODY_RECEIPT';
  return command(user, custody ? 'REVERSE_CUSTODY_RECEIPT' : 'REVERSE_PURCHASE_RECEIPT',
    'goods_receipt_inspection:reverse', id, input, (resultId, actor, session) => {
      requirePermission(actor, 'goods_receipt_inspection:post');
      return replayReversal(resultId, actor, session);
    }, async (session, actor) => {
      requirePermission(actor, 'goods_receipt_inspection:post');
      const receipt = await findPurchase(id, actor, session, { kind });
      checkVersion(receipt, input.expectedVersion);
      await evidenceFor(actor, receipt, input.evidenceIds, session);
      const { original, locations, portionIds } = await eligible(receipt, actor, session);
      await guardLocations(locations, session);
      const po = custody ? null : await findPurchase(receipt.header.purchaseOrderId, actor, session, { kind: 'PO' });
      if (po) checkVersion(po, input.expectedPoVersion);

      const reversal = await newDocument(StockReversal, 'REV', actor, {
        originalTransactionId: original._id,
        sourceDocument: { documentType: receipt.constructor.collection.name, documentId: receipt._id, revision: receipt.version },
        sourceVersion: receipt.version,
        warehouseIds: [receipt.header.warehouseId],
        requestedBy: actor._id,
        requestedAt: new Date(),
        reason: input.reason,
      }, original.movements.map((move, index) => copyItem(receipt.items.id(move.sourceLineId), move.quantityBase, {
        lineNo: index + 1,
        sources: [{ subjectCollection: 'stock_transactions', documentId: original._id, itemId: move._id,
          linkedQty: String(move.quantityBase), relationCode: 'REVERSES' }],
      })));
      reversal.evidenceIds = input.evidenceIds ?? [];

      const posting = beginStock(reversal, actor, 'REVERSAL', input);
      posting.reversedTransactionId = original._id;
      for (const move of [...original.movements].reverse()) {
        const item = receipt.items.id(move.sourceLineId);
        const reversalItem = reversal.items.find(row => row.sources.some(ref => same(ref.itemId, move._id)));
        let target = null;
        if (!custody && item.custodyBalanceId) {
          const ctx = await sourceContext(item.custodyBalanceId, session);
          if (ctx.balance.ownerType !== 'SUPPLIER' || !same(ctx.balance.ownerId, receipt.header.supplierId)) {
            throw validationError('Sai nguồn chủ hàng');
          }
          target = ctx.balance;
          await guardLocations([ctx.location._id], session);
          locations.push(ctx.location._id);
        }
        await transferCustodyStock(move.toBalanceId, target, {
          ...reversalItem.toObject(), qtyBase: String(move.quantityBase),
        }, posting, actor, session, portionIds.get(String(move._id)));
      }
      await verifyCapacity(locations, session);
      await posting.save({ session });
      receipt.workflowStatus = 'REVERSED';
      await saveVersion(receipt, receipt.version, session);
      if (po) {
        // CLOSED POs keep their approved cancellation of the unreceived remainder.
        // The Accountant reopens it with POST /purchase-orders/:id/reopen (user decision 23/11/2026).
        if (po.workflowStatus !== 'CLOSED') po.workflowStatus = receivingStatus(await purchaseOrderQuantities(po, session));
        await saveVersion(po, po.version, session);
      }
      reversal.workflowStatus = 'POSTED';
      reversal.stockTransactionId = posting._id;
      reversal.postedBy = actor._id;
      reversal.postedAt = new Date();
      await reversal.save({ session });
      return { document: reversal, stockTransactionId: posting._id, reason: input.reason };
    });
}

function blocker(document, action, message) {
  return {
    documentType: document.constructor.collection.name,
    documentId: String(document._id),
    documentNo: document.documentNo,
    workflowStatus: document.workflowStatus,
    action,
    message,
  };
}

function receiptBlocker(document, suffix, label) {
  if (document.workflowStatus === 'DRAFT') return blocker(document, 'CANCEL_' + suffix, `Hủy ${label} ${document.documentNo}`);
  if (document.workflowStatus === 'POSTED') return blocker(document, 'REVERSE_' + suffix, `Đảo ${label} ${document.documentNo}`);
  return blocker(document, null, `${document.constructor.collection.name} ${document.documentNo} (${document.workflowStatus})`);
}

async function correctionBlockers(inspection, session) {
  const id = inspection._id;
  const resolved = ['CANCELLED', 'REVERSED'];
  const custodyReceipts = await CustodyReceipt.find({ 'items.sources.documentId': id })
    .select('documentNo workflowStatus').sort('documentNo').session(session);
  const custodyIds = custodyReceipts.map(receipt => receipt._id);
  const custodyLinked = { subjectCollection: 'custody_receipts', documentId: { $in: custodyIds } };
  const receipts = await PurchaseReceipt.find({
    workflowStatus: { $nin: resolved },
    $or: [
      { 'items.inspectionId': id },
      { sources: { $elemMatch: custodyLinked } },
      { 'items.sources': { $elemMatch: custodyLinked } },
    ],
  }).select('documentNo workflowStatus sources items.sources').sort('documentNo').session(session);
  const heldIds = new Set(custodyIds.map(String));
  const isFromCustody = receipt => [...(receipt.sources ?? []), ...receipt.items.flatMap(item => item.sources ?? [])]
    .some(ref => ref.subjectCollection === 'custody_receipts' && heldIds.has(String(ref.documentId)));
  const ordered = [...receipts.filter(isFromCustody), ...receipts.filter(receipt => !isFromCustody(receipt))];
  const blockers = ordered.map(receipt => receiptBlocker(receipt, 'RECEIPT', 'phiếu nhập'));
  for (const receipt of custodyReceipts) {
    if (resolved.includes(receipt.workflowStatus)) continue;
    const row = receiptBlocker(receipt, 'CUSTODY', 'phiếu giữ hộ');
    if (row.action === 'REVERSE_CUSTODY') row.message += '. Nếu có phiếu nhập từ hàng giữ hộ, đảo phiếu nhập trước.';
    blockers.push(row);
  }
  const replacements = await GoodsInspection.find({
    'header.previousInspectionId': id, workflowStatus: { $ne: 'CANCELLED' },
  }).select('documentNo workflowStatus').sort('documentNo').session(session);
  for (const replacement of replacements) {
    blockers.push(blocker(replacement, 'USE_REPLACEMENT', `Đã có bản thay thế ${replacement.documentNo}`));
  }
  const returns = await SupplierReturn.find({
    'items.sources.documentId': id, workflowStatus: { $ne: 'CANCELLED' },
  }).select('documentNo workflowStatus').sort('documentNo').session(session);
  for (const document of returns) {
    blockers.push(blocker(document, null, `supplier_returns ${document.documentNo} (${document.workflowStatus})`));
  }
  return blockers;
}

export async function correctionPreflight(user, id) {
  requirePermission(user, 'goods_receipt_inspection:update');
  const inspection = await findPurchase(id, user, null, { kind: 'INSPECTION' });
  const inspectionVersion = inspection.version;
  if (inspection.workflowStatus !== 'CONFIRMED') {
    return { eligible: false, blockers: [], inspectionVersion, reason: 'Chỉ thay kết quả đã xác nhận' };
  }
  if (!await GoodsArrival.exists({ _id: inspection.header.arrivalId })) {
    return { eligible: false, blockers: [], inspectionVersion, reason: 'Thiếu hồ sơ hàng đến' };
  }
  const blockers = await correctionBlockers(inspection);
  return { eligible: blockers.length === 0, blockers, inspectionVersion };
}

export function replaceInspection(user, id, input) {
  return command(user, 'REPLACE_GOODS_INSPECTION', 'goods_receipt_inspection:update', id, input, replayPurchase, async (session, actor) => {
    const { inspection, arrival } = await inspectionSource(actor, id, session);
    checkVersion(inspection, input.expectedVersion);
    if (inspection.workflowStatus !== 'CONFIRMED') throw validationError('Chỉ thay kết quả đã xác nhận');
    const blockers = await correctionBlockers(inspection, session);
    if (blockers.length) throw validationError(`Cần xử lý ${blockers.length} chứng từ trước khi sửa kết quả kiểm`, blockers);
    await evidenceFor(actor, inspection, input.evidenceIds, session);
    const po = await activePo(actor, arrival.header.purchaseOrderId, input.expectedPoVersion, session);
    const newArrival = await newDocument(GoodsArrival, 'ARR', actor, {
      ...arrival.header.toObject(), recordedAt: undefined, arrivedAt: new Date(input.arrivedAt),
      deliveryReference: input.deliveryReference, deliveredBy: input.deliveredBy,
    });
    const document = await newDocument(GoodsInspection, 'INS', actor, {
      arrivalId: newArrival._id, warehouseId: arrival.header.warehouseId,
      previousInspectionId: inspection._id, correctionReason: input.reason, participants: [actor._id],
    });
    newArrival.sources = [sourceLink(po), sourceLink(arrival, null, null, 'CORRECTION')];
    document.sources = [sourceLink(newArrival), sourceLink(inspection, null, null, 'REPLACES')];
    await prepare(po, input, actor, session, newArrival, document);
    await newArrival.save({ session });
    await document.save({ session });
    await saveVersion(inspection, inspection.version, session);
    return { document, reason: input.reason };
  });
}

