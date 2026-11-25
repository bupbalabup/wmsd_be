import { GoodsInspection, GoodsArrival, PurchaseReceipt, CustodyReceipt, SupplierReturn } from '../../models/runtime.js';
import { requirePermission } from '../../shared/utils/access.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { command, checkVersion, saveVersion } from '../../shared/utils/document-command.js';
import { sourceLink } from '../../shared/utils/document-copy.js';
import { findPurchase, newDocument, evidenceFor, replayPurchase, activePo } from '../../shared/utils/purchase-core.js';
import { prepare, inspectionSource } from './goods-inspection.service.js';

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
