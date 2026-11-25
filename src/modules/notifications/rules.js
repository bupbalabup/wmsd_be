import * as m from '../../models/runtime.js';
import { same } from '../../shared/utils/document-command.js';

const send = (title, permission, userId, warehouseId) => ({ title, permission, userId, warehouseId });
const requester = (title, doc) => send(title, null, doc.createdBy, doc.header?.warehouseId);
const submitted = ({ op }) => op.resultCode === 'SUBMITTED'
  ? [send('Yêu cầu bổ sung hàng chờ duyệt', 'replenishment_request:approve')] : [];
const po = title => () => [send(title, 'goods_receipt_inspection:create')];
const direct = title => async ({ doc }) => {
  if (doc.header.fulfillmentMode !== 'DIRECT') return [];
  const order = await m.SalesOrder.findById(doc.header.salesOrderId).select('createdBy');
  return order ? [send(title, null, order.createdBy, doc.header.warehouseId)] : [];
};
const customerInspection = ({ doc, op }) => doc.workflowStatus !== 'INSPECTED' ? [] : [
  send('Phiếu trả hàng đã kiểm tra, chờ quyết định', 'customer_return:accept', doc.createdBy),
  send('Phiếu trả hàng ngoại lệ cần xem xét', 'customer_return:approve_exception'),
].filter(notice => notice.permission === (doc.inspections?.some(row =>
  row.returnVersion === op.versionAfter && row.portions.some(part => part.eligibilityStatus === 'CASE_REVIEW' && part.damageCause !== 'NONE'))
  ? 'customer_return:approve_exception' : 'customer_return:accept'));
const customerDecision = ({ op }) => ['ACCEPTED', 'REJECTED'].includes(op.resultCode)
  ? [send(op.resultCode === 'ACCEPTED' ? 'Phiếu trả hàng đã duyệt, chờ nhập' : 'Phiếu trả hàng đã từ chối, kiểm tra bàn giao', 'customer_return:post')] : [];

export const rules = {
  POST_GOODS_ISSUE: direct('Hàng đã xuất kho, chờ xác nhận khách nhận'),
  RECEIVE_UNDELIVERED_ISSUE: direct('Hàng chưa giao đã nhập lại kho'),
  CREATE_REPLENISHMENT: submitted,
  SUBMIT_REPLENISHMENT: submitted,
  REVIEW_REPLENISHMENT: ({ op, doc }) => [
    requester('Yêu cầu bổ sung hàng đã có quyết định', doc),
    ...(op.resultCode === 'APPROVED' ? [send('Có thể lập đơn mua hàng', 'purchase_order:create')] : []),
  ],
  CONFIRM_PURCHASE_ORDER: po('Đơn mua hàng đã xác nhận'),
  RESCHEDULE_PO_EXPECTED_ON: po('Đơn mua hàng đã đổi ngày dự kiến'),
  REOPEN_PURCHASE_ORDER: po('Đơn mua hàng đã mở lại để nhận tiếp'),
  POST_PURCHASE_CUSTODY: () => [send('Hàng giữ hộ chờ quyết định', 'purchase_custody:decide')],
  DECIDE_PURCHASE_CUSTODY: () => [send('Hàng giữ hộ đã có quyết định xử lý', 'purchase_custody:execute')],
  SUBMIT_OTHER_RECEIPT: ({ op }) => op.resultCode === 'PENDING_APPROVAL'
    ? [send('Phiếu nhập khác chờ duyệt', 'goods_receipt_other:approve')] : [],
  APPROVE_OTHER_RECEIPT: ({ op, doc }) => [op.resultCode === 'APPROVED'
    ? send('Phiếu nhập khác đã duyệt, chờ ghi nhập', 'goods_receipt_other:post', doc.createdBy)
    : requester('Phiếu nhập khác đã có quyết định', doc)],
  CREATE_TRANSFER_REQUEST: () => [send('Yêu cầu điều chuyển chờ duyệt', 'stock_transfer:approve')],
  REVIEW_TRANSFER_REQUEST: ({ op, doc }) => op.resultCode === 'APPROVED'
    ? [send('Yêu cầu đã duyệt, chờ xuất điều chuyển', 'stock_transfer:dispatch', null, doc.header.sourceWarehouseId)]
    : [requester('Yêu cầu điều chuyển đã có quyết định', doc)],
  CONFIRM_TRANSFER_TASK: ({ original, doc }) => original.header.taskKind === 'PICK'
    ? [send('Hàng điều chuyển đã xuất, chờ kho đích nhận', 'stock_transfer:receive', null, doc.header.destinationWarehouseId)] : [],
  RECEIVE_TRANSFER: async ({ op, doc }) => {
    const ref = op.resultRefs.find(row => row.documentType === 'transfer_orders');
    return ref && await m.TransferOrder.exists({ _id: ref.documentId, workflowStatus: 'OPEN' })
      ? [{ ...send('Hàng điều chuyển đã nhận, chờ cất hàng', 'stock_transfer:receive', null, doc.header.destinationWarehouseId), includeActor: true }] : [];
  },
  REPORT_TRANSFER_DIFFERENCE: () => [send('Chênh lệch điều chuyển chờ xem xét', 'stock_transfer:approve_variance')],
  REVIEW_TRANSFER_DIFFERENCE: ({ original }) => [requester('Chênh lệch điều chuyển đã có quyết định', original)],
  SUBMIT_STOCKTAKE_PLAN: () => [send('Phương án kiểm kê chờ duyệt', 'stock_adjustment:approve')],
  REVIEW_STOCKTAKE_PLAN: async ({ op }) => {
    const decision = await m.ApprovalHistory.findById(op.decisionId).select('requestedBy decision');
    return decision?.requestedBy ? [send(decision.decision === 'APPROVE'
      ? 'Phương án kiểm kê đã duyệt, có thể thực hiện' : 'Phương án kiểm kê đã có quyết định', null, decision.requestedBy)] : [];
  },
  CREATE_CR: () => [send('Phiếu khách trả chờ kiểm tra', 'customer_return:inspect')],
  INSPECT_CR: customerInspection,
  REASSESS_CR: customerInspection,
  DECIDE_CR: customerDecision,
  EXCEPTION_CR: customerDecision,
  RECEIVE_CR: ({ op, doc }) => op.resultCode === 'COMPLETED' ? [requester('Đã ghi nhận hàng khách trả', doc)] : [],
  HANDBACK_CR: ({ doc }) => [requester('Đã bàn giao lại hàng cho khách', doc)],
  PROPOSE_DEFECT: () => [send('Phương án xử lý hàng lỗi chờ duyệt', 'defect:approve')],
  DECIDE_DEFECT: async ({ op }) => {
    const decision = await m.ApprovalHistory.findById(op.decisionId).select('requestedBy decision');
    return decision ? [
      ...(decision.requestedBy ? [send('Phương án xử lý hàng lỗi đã có quyết định', null, decision.requestedBy)] : []),
      ...(decision.decision === 'APPROVE' ? [send('Phương án hàng lỗi đã duyệt, chờ thực hiện', 'defect:execute')] : []),
    ] : [];
  },
  CREATE_SR: () => [send('Phiếu trả nhà cung cấp chờ thỏa thuận', 'supplier_return:record_agreement')],
  AGREEMENT_SR: ({ op }) => op.resultCode === 'READY'
    ? [send('Phiếu trả nhà cung cấp chờ xuất', 'supplier_return:dispatch')] : [],
  DISPATCH_SR: () => [send('Đã xuất hàng trả nhà cung cấp, chờ biên nhận', 'supplier_return:record_agreement')],
  ACK_SR: ({ doc }) => [requester('Nhà cung cấp đã phản hồi phiếu trả hàng', doc)],
  CLOSE_SR: ({ op, doc }) => op.resultCode === 'COMPLETED'
    ? [requester('Phiếu trả nhà cung cấp đã đóng', doc)] : [],
};

export async function resolveSource(event, op) {
  const Model = Object.values(m).find(Model => Model?.collection?.name === event.sourceType);
  const original = await Model?.findById(event.sourceId).lean();
  if (!original) return null;
  let doc = original;
  let sourceType = event.sourceType;
  let sourceId = original._id;
  let sourceVersion = event.sourceVersion;
  if (event.eventType.endsWith('STOCKTAKE_PLAN')) {
    sourceType = 'stocktakes';
  } else if (['transfer_orders', 'stock_discrepancies'].includes(sourceType) || event.eventType === 'RECEIVE_TRANSFER') {
    let dispatchId = original.header.dispatchId ?? original.header.sourceRef?.documentId;
    if (sourceType === 'transfer_orders') {
      if (original.header.taskKind !== 'PICK') return null;
      const requirement = await m.InternalTransferRequirement.findById(original.header.requirementId).lean();
      dispatchId = requirement?.header.sourceDocumentId;
    }
    const dispatch = await m.TransferDispatch.findById(dispatchId).lean();
    doc = await m.WarehouseTransferRequest.findById(dispatch?.header.requestId).lean();
    sourceType = 'warehouse_transfer_requests';
    sourceId = doc?._id;
    sourceVersion = doc?.version;
  }
  if (!sourceId) return null;
  return { original, doc, sourceType, sourceId, sourceVersion };
}
