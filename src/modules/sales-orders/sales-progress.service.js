// Customer purchase request progress (26/11/2026): which documents reference a request, how much of each line
// has really been delivered, what stock is left for the lot, and the shortage alerts sent to Owner and Accountant.
import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { same } from '../../shared/utils/document-command.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { fifoCandidates, remainingReservation } from '../../shared/utils/stock.js';
import { effectiveQuantities } from './sales-read.service.js';
import { createInAppNotification } from '../delivery-orders/delivery-notifications.js';

const zero = () => exact('0');
const CLOSED = ['CANCELLED', 'REJECTED'];
const itemIds = order => order.items.map(item => item._id);

/** Goods issues raised against any line of the request (every issue path stores salesOrderItemId on its lines). */
export const requestIssues = (order, session) =>
  m.SalesGoodsIssue.find({ $or: [{ 'items.salesOrderItemId': { $in: itemIds(order) } }, { 'header.salesOrderId': order._id }] }).session(session);

/** Documents that execute the request. Cancelled or rejected documents do not count. */
export async function orderReferences(order, session) {
  const [issues, deliveries, requests] = await Promise.all([
    requestIssues(order, session),
    m.DeliveryOrder.find({ 'header.salesOrderId': order._id }).select('documentNo workflowStatus header.scheduleId').session(session).lean(),
    m.WarehouseIssueRequest.find({ 'header.salesOrderId': order._id }).select('documentNo workflowStatus').session(session).lean(),
  ]);
  const row = (type, label, path) => doc => ({ type, label, id: String(doc._id), documentNo: doc.documentNo, workflowStatus: doc.workflowStatus, scheduleFlow: Boolean(doc.header?.scheduleId), path: `${path}/${encodeURIComponent(String(doc._id))}` });
  return [
    ...issues.filter(doc => !CLOSED.includes(doc.workflowStatus)).map(row('sales_goods_issues', 'Phiếu xuất kho', '/goods-issues')),
    ...deliveries.filter(doc => !CLOSED.includes(doc.workflowStatus)).map(row('delivery_orders', 'Lệnh giao hàng', '/outbound-deliveries')),
    ...requests.filter(doc => !CLOSED.includes(doc.workflowStatus)).map(row('warehouse_issue_requests', 'Yêu cầu xuất kho', '/issue-requests')),
  ];
}

// Delivery orders made from the delivery schedule are not a blocker: the schedule service decides per delivery
// (a paused DO can be reworked, a DO that is created, issued or handed over locks its own delivery).
export async function assertNoReferences(order, session) {
  const references = (await orderReferences(order, session)).filter(r => !r.scheduleFlow);
  if (references.length) throw validationError(`Yêu cầu đã có chứng từ tham chiếu (${references.map(r => r.documentNo).join(', ')}), không sửa được`);
}

/**
 * Per request line: ordered, issued (posted goods issues, reversals excluded), returned as undelivered, delivered,
 * cancelled, still to deliver, reserved for the request, free stock of the lot and the shortage.
 * Free stock is counted in the warehouses of the delivery plan, or in every active warehouse without a plan.
 */
export async function lineProgress(order, schedule, session, visibleIssues) {
  const issues = visibleIssues ?? await requestIssues(order, session);
  const posted = issues.filter(doc => doc.workflowStatus === 'POSTED');
  const issued = await effectiveQuantities(posted, session);
  const issueLineIds = posted.flatMap(doc => doc.items.map(item => item._id));
  const receipts = issueLineIds.length ? await m.FailedDeliveryReceipt.find({ workflowStatus: 'POSTED', 'items.details.salesIssueLineId': { $in: issueLineIds } }).session(session) : [];
  const returned = await effectiveQuantities(receipts, session);
  const reservations = await m.StockReservation.find({ 'demandRef.documentId': order._id }).session(session).lean();
  const planWarehouses = new Map();
  for (const delivery of schedule?.deliveries ?? []) {
    if (delivery.status === 'CANCELLED') continue;
    for (const line of delivery.lines) {
      const key = String(line.soLineId);
      planWarehouses.set(key, new Set([...(planWarehouses.get(key) ?? []), String(delivery.warehouseId)]));
    }
  }
  const allWarehouses = (await m.Warehouse.find({ isActive: true }).select('_id').session(session).lean()).map(w => String(w._id));
  const freeCache = new Map();
  const freeOf = async (warehouseId, lotId) => {
    const key = `${warehouseId}:${lotId}`;
    if (!freeCache.has(key)) freeCache.set(key, (await fifoCandidates(warehouseId, lotId, session)).reduce((sum, c) => sum.plus(c.free), zero()));
    return freeCache.get(key);
  };
  const lotIds = order.items.map(item => item.lotId).filter(Boolean);
  const lots = new Map((lotIds.length ? await m.ProductBatch.find({ _id: { $in: lotIds } }).select('manufacturerLot').session(session).lean() : []).map(lot => [String(lot._id), lot.manufacturerLot]));
  const rows = [];
  for (const item of order.items) {
    const lines = posted.flatMap(doc => doc.items.filter(row => same(row.salesOrderItemId, item._id)).map(row => ({ doc, row })));
    const issuedQty = lines.reduce((sum, { row }) => sum.plus(issued.get(String(row._id)) ?? '0'), zero());
    const lineSet = new Set(lines.map(({ row }) => String(row._id)));
    const returnedQty = receipts.flatMap(doc => doc.items).filter(row => lineSet.has(String(row.details?.salesIssueLineId)))
      .reduce((sum, row) => sum.plus(returned.get(String(row._id)) ?? '0'), zero());
    const cancelledQty = (order.cancellations || []).filter(c => same(c.salesOrderLineId, item._id)).reduce((sum, c) => sum.plus(String(c.cancelledQtyBase)), zero());
    const deliveredQty = issuedQty.minus(returnedQty);
    const remaining = exact(String(item.qtyBase)).minus(deliveredQty).minus(cancelledQty);
    const remainingQty = remaining.gt(0) ? remaining : zero();
    const reservedQty = reservations.filter(r => same(r.demandRef?.itemId, item._id)).reduce((sum, r) => {
      const left = remainingReservation(r);
      return left.gt(0) ? sum.plus(left) : sum;
    }, zero());
    let availableQty = zero();
    if (item.lotId) for (const warehouseId of planWarehouses.get(String(item._id)) ?? allWarehouses) availableQty = availableQty.plus(await freeOf(warehouseId, item.lotId));
    const missing = remainingQty.minus(reservedQty).minus(availableQty);
    rows.push({
      lineId: String(item._id), lineNo: item.lineNo, productId: String(item.productId), lotId: item.lotId ? String(item.lotId) : null, lotCode: item.lotId ? lots.get(String(item.lotId)) ?? null : null,
      productName: item.productNameSnapshot, baseUnit: item.baseUnitSnapshot, enteredUnit: item.enteredUnit, baseUnitsPerUnit: String(item.baseUnitsPerUnit),
      orderedQtyBase: String(item.qtyBase), issuedQtyBase: issuedQty.toFixed(), returnedUndeliveredQtyBase: returnedQty.toFixed(),
      deliveredQtyBase: deliveredQty.toFixed(), cancelledQtyBase: cancelledQty.toFixed(), remainingQtyBase: remainingQty.toFixed(),
      reservedQtyBase: reservedQty.toFixed(), availableQtyBase: availableQty.toFixed(), shortageQtyBase: (missing.gt(0) ? missing : zero()).toFixed(),
      issues: lines.map(({ doc, row }) => ({ id: String(doc._id), documentNo: doc.documentNo, workflowStatus: doc.workflowStatus, postedAt: doc.postedAt ?? null, qtyBase: issued.get(String(row._id))?.toFixed() ?? '0' })),
    });
  }
  return rows;
}

/** Tells every active Owner and Accountant how much of which lot is missing for the request. */
export async function notifySalesShortage(order, shortages, session) {
  if (!shortages.length) return;
  const roles = await m.Role.find({ code: { $in: ['OWNER', 'ACCOUNTANT'] }, isActive: true }).select('_id').session(session).lean();
  if (!roles.length) return;
  const users = await m.User.find({ isActive: true, roleId: { $in: roles.map(r => r._id) } }).select('_id').session(session).lean();
  const message = `Yêu cầu ${order.documentNo}${order.header?.customerName ? ` (${order.header.customerName})` : ''} chưa đủ hàng: ${shortages.join('; ')}. Cần lập đề nghị bổ sung và đơn mua hàng.`;
  for (const user of users) {
    await createInAppNotification({
      recipientId: user._id, type: 'SALES_SHORTAGE',
      eventKey: `SALES_SHORTAGE:${order._id}`, dedupKey: `SALES_SHORTAGE:${order._id}:${order.version}:${user._id}`,
      sourceType: 'sales_orders', sourceId: order._id, sourceVersion: order.version,
      title: `Thiếu hàng cho yêu cầu ${order.documentNo}`, message, session,
    });
  }
}
