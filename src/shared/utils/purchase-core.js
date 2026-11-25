import { newBusinessDocument } from './document-number.js';
import {
  PurchaseOrder,
  GoodsArrival,
  GoodsInspection,
  PurchaseReceipt,
  TransferOrder,
  CustodyReceipt,
  CustodyRelease,
  OtherGoodsReceipt,
  Attachment,
} from '../../models/runtime.js';
import { isOwner, requireWarehouseAccess } from './access.js';
import { currentRole } from './userRole.js';
import { notFoundError, validationError } from './ApiError.js';
import { command, checkVersion, saveVersion } from './document-command.js';

export const purchaseModels = {
  PO: PurchaseOrder,
  ARRIVAL: GoodsArrival,
  INSPECTION: GoodsInspection,
  GR_PURCHASE: PurchaseReceipt,
  OTHER: OtherGoodsReceipt,
  TO: TransferOrder,
  CUSTODY_RECEIPT: CustodyReceipt,
  CUSTODY_RELEASE: CustodyRelease,
};

export const newDocument = (Model, prefix, user, header, items = [], status = 'DRAFT') =>
  newBusinessDocument(Model, user, header, items, status);

export function purchaseWarehouseFilter(user, id) {
  const all = isOwner(user) || currentRole(user)?.code === 'ACCOUNTANT';
  if (id) {
    if (!all) requireWarehouseAccess(user, id);
    return { 'header.warehouseId': id };
  }
  return all ? {} : { 'header.warehouseId': { $in: user.warehouseIds ?? [] } };
}

const purchaseIdFilter = id => (/^[a-f\d]{24}$/i.test(id) ? { $or: [{ _id: id }, { documentNo: id }] } : { documentNo: id });

// List filters accept a PO _id or documentNo; historical POs keep an ObjectId _id, so linked headers store that.
export async function purchaseOrderRef(id) {
  const po = await PurchaseOrder.findOne(purchaseIdFilter(id)).select('_id').lean();
  return po?._id ?? id;
}

export async function findPurchase(id, user, session, { kind, readOnly = false } = {}) {
  let document;
  const filter = purchaseIdFilter(id);
  const candidates = kind ? [purchaseModels[kind]] : Object.values(purchaseModels);
  for (const Model of candidates) {
    if (!Model) throw notFoundError();
    document = await Model.findOne(filter).session(session);
    if (document) break;
  }
  if (!document) throw notFoundError();
  if (!(readOnly && currentRole(user)?.code === 'ACCOUNTANT')) requireWarehouseAccess(user, document.header.warehouseId);
  return document;
}

export async function evidenceFor(user, document, ids, session, required = false) {
  if (required && !ids?.length) throw validationError('Thiếu bằng chứng');
  if (new Set(ids || []).size !== (ids || []).length) throw validationError('Bằng chứng trùng');
  for (const id of ids || []) {
    const evidence = await Attachment.findOne({
      _id: id,
      status: 'ATTACHED',
      ownerDocumentId: document._id,
      ownerDocumentType: document.constructor.collection.name,
    }).session(session);
    if (!evidence) throw validationError('Bằng chứng không thuộc chứng từ hoặc chưa gắn');
  }
}

export const replayPurchase = (id, user, session) => findPurchase(id, user, session);

export async function activePo(user, id, expectedVersion, session) {
  const po = await findPurchase(id, user, session, { kind: 'PO' });
  checkVersion(po, expectedVersion);
  if (!['OPEN', 'PARTIAL'].includes(po.workflowStatus)) {
    throw validationError('PO không còn mở để nhận hàng');
  }
  return po;
}

export function cancelDraft(user, id, kind, input) {
  return command(
    user,
    'CANCEL_' + kind,
    'goods_receipt_inspection:update',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const document = await findPurchase(id, actor, session, { kind });
      checkVersion(document, input.expectedVersion);
      if (document.workflowStatus !== 'DRAFT') {
        throw validationError('Chỉ hủy phiếu nháp');
      }
      if (kind === 'CUSTODY_RECEIPT' && document.header.ownerType !== 'SUPPLIER') {
        throw validationError('Chỉ hủy phiếu giữ hộ nhà cung cấp');
      }
      document.workflowStatus = 'CANCELLED';
      document.cancelledBy = actor._id;
      document.cancelledAt = new Date();
      document.cancelReason = input.reason;
      // The arrival is created with the inspection; a cancelled draft must not leave it DRAFT.
      if (kind === 'INSPECTION') {
        const arrival = await GoodsArrival.findById(document.header.arrivalId).session(session);
        if (arrival?.workflowStatus === 'DRAFT') {
          arrival.workflowStatus = 'CANCELLED';
          arrival.cancelledBy = actor._id;
          arrival.cancelledAt = document.cancelledAt;
          arrival.cancelReason = input.reason;
          await saveVersion(arrival, arrival.version, session);
        }
      }
      if (kind === 'GR_PURCHASE') {
        const po = await findPurchase(document.header.purchaseOrderId, actor, session, { kind: 'PO' });
        checkVersion(po, input.expectedPoVersion);
        await saveVersion(po, po.version, session);
      }
      return {
        document: await saveVersion(document, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        reason: input.reason,
      };
    },
  );
}
