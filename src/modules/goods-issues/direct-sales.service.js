import * as s from '../return-workflows/native.shared.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import { dto } from '../../shared/utils/persistence.js';
import { freeQuantity } from '../../shared/utils/stock.js';
const { m, exact, same, command, checkVersion, saveVersion, requireWarehouseAccess, requirePermission, validationError, notFoundError, sum } = s;
const role = user => currentRole(user)?.code;
const replay = (id, user, session) => access(user, id, session);
const active = doc => !['CANCELLED', 'CLOSED', 'COMPLETED', 'DELIVERED'].includes(doc.workflowStatus);

export async function access(user, id, session, write = false) {
  const issue = await m.SalesGoodsIssue.findById(id).session(session);
  if (!issue || issue.header.fulfillmentMode !== 'DIRECT') throw notFoundError();
  const order = await m.SalesOrder.findById(issue.header.salesOrderId).session(session);
  if (!order || (role(user) === 'SALES' && !same(order.createdBy, user._id))) throw notFoundError();
  if (write || !['OWNER', 'ACCOUNTANT', 'SALES'].includes(role(user))) requireWarehouseAccess(user, issue.header.warehouseId);
  return { issue, order };
}

export async function returnedQuantity(itemId, session) {
  const receipts = await m.FailedDeliveryReceipt.find({ workflowStatus: 'POSTED', 'items.details.salesIssueLineId': itemId }).session(session);
  let total = exact('0');
  for (const receipt of receipts) for (const row of receipt.items.filter(i => same(i.details.salesIssueLineId, itemId))) total = total.plus(await s.effectivePosted(receipt, row._id, session));
  return total;
}
export const confirmedQuantity = (issue, itemId) => sum((issue.customerReceipts || []).filter(r => same(r.issueLineId, itemId)), 'quantityBase');

export async function updateOrderProgress(order, session) {
  const issues = await m.SalesGoodsIssue.find({ 'header.salesOrderId': order._id, workflowStatus: 'POSTED' }).session(session);
  const completed = order.items.every(item => {
    const received = issues.reduce((n, issue) => n.plus(issue.items.filter(i => same(i.salesOrderItemId, item._id)).reduce((v, row) => v.plus(confirmedQuantity(issue, row._id)), exact('0'))), exact('0'));
    return received.plus(sum((order.cancellations || []).filter(c => same(c.salesOrderLineId, item._id)), 'cancelledQtyBase')).eq(String(item.qtyBase));
  });
  order.workflowStatus = completed ? issues.length ? 'DELIVERED' : 'CANCELLED' : issues.length ? 'PARTIAL' : 'OPEN';
}

async function remainingOrder(order, item, session) {
  const issues = await m.SalesGoodsIssue.find({ workflowStatus: { $ne: 'CANCELLED' }, 'items.salesOrderItemId': item._id }).session(session);
  let used = exact('0');
  for (const issue of issues) for (const row of issue.items.filter(i => same(i.salesOrderItemId, item._id))) {
    used = used.plus(issue.workflowStatus === 'POSTED' ? await s.effectivePosted(issue, row._id, session) : String(row.qtyBase));
    used = used.minus(await returnedQuantity(row._id, session));
  }
  return exact(item.qtyBase).minus(used).minus(sum((order.cancellations || []).filter(c => same(c.salesOrderLineId, item._id)), 'cancelledQtyBase'));
}
async function stockSource(user, balanceId, warehouseId, productId, lotId, session) {
  const ctx = await s.sourceContext(balanceId, session);
  requireWarehouseAccess(user, warehouseId);
  if (!same(ctx.location?.warehouseId, warehouseId) || ctx.location.locationType !== 'STORAGE' || !ctx.location.isPickable
    || !same(ctx.product._id, productId) || (lotId && !same(ctx.batch._id, lotId)) || !ctx.product.isActive
    || ctx.batch.identificationStatus !== 'VERIFIED' || ctx.balance.ownerType !== 'STORE' || ctx.balance.qualityStatus !== 'GOOD') throw validationError('Nguồn tồn không đủ điều kiện xuất');
  return ctx;
}
export function create(user, input) {
  return command(user, 'CREATE_DIRECT_ISSUE', 'goods_issue:create', input.salesOrderId, input, replay, async (session, actor) => {
    if (role(actor) === 'SALES') throw new s.ApiError(403, 'Kho lập phiếu xuất từ đơn bán');
    requireWarehouseAccess(actor, input.warehouseId);
    if (!await m.Warehouse.exists({ _id: input.warehouseId, isActive: true }).session(session)) throw validationError('Kho không hoạt động');
    const order = await m.SalesOrder.findById(input.salesOrderId).session(session);
    if (!order || !active(order)) throw validationError('Đơn bán đã kết thúc');
    checkVersion(order, input.expectedVersion);
    if (await m.WarehouseIssueRequest.exists({ 'header.salesOrderId': order._id, workflowStatus: { $nin: ['CANCELLED', 'CLOSED'] } }).session(session)) throw validationError('Đơn đang có yêu cầu xuất cũ; hoàn tất hoặc hủy yêu cầu trước');
    const issue = new m.SalesGoodsIssue({ ...await nextDocumentFields(m.SalesGoodsIssue, 'GI', input.warehouseId, session), workflowStatus: 'DRAFT', version: 1, createdBy: actor._id, note: input.note,
      header: { warehouseId: input.warehouseId, fulfillmentMode: 'DIRECT', salesOrderId: order._id, customerId: order.header.customerId }, sources: [sourceLink(order)], items: [] });
    for (const row of input.lines) {
      const item = order.items.id(row.salesOrderLineId);
      if (!item) throw validationError('Dòng không thuộc đơn bán');
      await s.lockSource(order, item, session);
      const planned = sum(issue.items.filter(i => same(i.salesOrderItemId, item._id)));
      if (exact(row.qtyBase).plus(planned).gt(await remainingOrder(order, item, session))) throw validationError('Vượt số lượng đơn bán còn được xuất');
      await s.assertWholeQuantity(item.productId, row.qtyBase, session);
      const ctx = await stockSource(actor, row.sourceBalanceId, input.warehouseId, item.productId, item.lotId, session);
      if (exact(row.qtyBase).plus(sum(issue.items.filter(i => same(i.sourceBalanceId, row.sourceBalanceId)))).gt(await freeQuantity(ctx.balance, session))) throw validationError('Không đủ tồn tự do');
      issue.items.push(copyItem(item, row.qtyBase, { lineNo: issue.items.length + 1, lineKind: 'SALES_GOODS_ISSUE', details: {}, lotId: ctx.batch._id, sourceBalanceId: ctx.balance._id,
        enteredUnit: item.baseUnitSnapshot, baseUnitsPerUnit: '1', enteredQty: row.qtyBase, packagingSnapshot: ctx.balance.packagingPortions[0]?.packagingSnapshot,
        salePriceSnapshot: { saleUnit: item.enteredUnit, baseUnitsPerSaleUnit: item.baseUnitsPerUnit, unitSellingPrice: item.unitSellingPrice, salesOrderRevision: item.priceRevision },
        salesOrderItemId: item._id, sources: [sourceLink(order, item, row.qtyBase)] }));
    }
    await issue.save({ session });
    await saveVersion(order, order.version, session);
    return { document: issue };
  });
}
export async function post(issue, order, actor, input, session) {
  if (issue.workflowStatus !== 'DRAFT' || !active(order)) throw validationError('Phiếu hoặc đơn bán không còn cho phép xuất');
  const posting = s.beginStock(issue, actor, 'PGI', input);
  for (const item of issue.items) {
    const soItem = order.items.id(item.salesOrderItemId);
    if (!soItem) throw validationError('Dòng đơn bán không tồn tại');
    await s.lockSource(order, soItem, session);
    if ((await remainingOrder(order, soItem, session)).lt(0)) throw validationError('Số lượng đơn bán đã thay đổi');
    await stockSource(actor, item.sourceBalanceId, issue.header.warehouseId, item.productId, item.lotId, session);
    await s.takeStock(item.sourceBalanceId, String(item.qtyBase), item._id, posting, actor, session, { allowOpening: true });
  }
  await posting.save({ session });
  issue.workflowStatus = 'POSTED'; issue.postedAt = new Date(); issue.postedBy = actor._id; issue.stockTransactionId = posting._id;
  issue.header.issuedToName = input.recipientName;
  issue.header.issuedAt = new Date(); issue.header.issuedBy = actor._id;
  order.workflowStatus = 'PARTIAL';
  await saveVersion(order, order.version, session);
  return posting;
}
export function confirmCustomerReceipt(user, id, input) {
  return command(user, 'CONFIRM_ISSUE_CUSTOMER_RECEIPT', 'delivery_confirmation:confirm', id, input, replay, async (session, actor) => {
    if (role(actor) !== 'SALES') throw new s.ApiError(403, 'Sales xác nhận khách nhận hàng');
    const { issue, order } = await access(actor, id, session);
    checkVersion(issue, input.expectedVersion);
    if (issue.workflowStatus !== 'POSTED') throw validationError('Phiếu chưa ghi xuất');
    if (new Date(input.receivedAt) > new Date() || new Date(input.receivedAt) < issue.postedAt) throw validationError('Thời điểm nhận phải từ lúc xuất kho đến hiện tại');
    await s.evidence(issue, input.evidenceIds, session);
    for (const row of input.lines) {
      const item = issue.items.id(row.lineId); if (!item) throw validationError('Dòng không thuộc phiếu');
      await s.assertWholeQuantity(item.productId, row.qtyBase, session);
      await s.lockSource(issue, item, session);
      if (confirmedQuantity(issue, item._id).plus(row.qtyBase).plus(await returnedQuantity(item._id, session)).plus(await s.claimTotal(item._id, 'FD', session)).gt(await s.effectivePosted(issue, item._id, session))) throw validationError('Vượt lượng đã xuất chưa khách nhận');
      issue.customerReceipts ??= [];
      issue.customerReceipts.push({ issueLineId: item._id, quantityBase: row.qtyBase, recipientName: input.recipientName, receivedAt: input.receivedAt, recordedBy: actor._id, recordedAt: new Date(), evidenceIds: input.evidenceIds });
    }
    const document = await saveVersion(issue, input.expectedVersion, session);
    await updateOrderProgress(order, session);
    await saveVersion(order, order.version, session);
    return { document, versionBefore: input.expectedVersion };
  });
}
export function receiveUndelivered(user, id, input) {
  return command(user, 'RECEIVE_UNDELIVERED_ISSUE', 'failed_delivery:post', id, input, replay, async (session, actor) => {
    if (role(actor) === 'SALES') throw new s.ApiError(403, 'Kho nhận lại hàng chưa giao');
    const { issue, order } = await access(actor, id, session, true);
    checkVersion(issue, input.expectedVersion);
    if (issue.workflowStatus !== 'POSTED') throw validationError('Phiếu chưa ghi xuất');
    await s.evidence(issue, input.evidenceIds, session);
    const receipt = await s.envelope(m.FailedDeliveryReceipt, actor, { warehouseId: issue.header.warehouseId, goodsIssueId: issue._id, receivedAt: new Date(), receivedBy: actor._id }, [], 'DRAFT', input.reason);
    const posting = s.beginStock(receipt, actor, 'GR_FD', input);
    for (const row of input.lines) {
      const item = issue.items.id(row.lineId); if (!item) throw validationError('Dòng không thuộc phiếu');
      await s.lockSource(issue, item, session);
      if (exact(row.qtyBase).plus(confirmedQuantity(issue, item._id)).plus(await returnedQuantity(item._id, session)).plus(await s.claimTotal(item._id, 'FD', session)).gt(await s.effectivePosted(issue, item._id, session))) throw validationError('Vượt lượng chưa khách nhận');
      await s.assertWholeQuantity(item.productId, row.qtyBase, session);
      receipt.items.push(copyItem(item, row.qtyBase, { lineNo: receipt.items.length + 1, lineKind: 'FAILED_DELIVERY_RECEIPT', details: { salesIssueLineId: item._id }, sources: [sourceLink(issue, item, row.qtyBase, 'UNDELIVERED_RETURN')] }));
      await s.postIn(receipt, receipt.items.at(-1), actor, session, posting, row);
    }
    receipt.evidenceIds = input.evidenceIds;
    await s.savePosted(receipt, posting, actor, session);
    await saveVersion(order, order.version, session);
    return { document: await saveVersion(issue, input.expectedVersion, session), versionBefore: input.expectedVersion, stockTransactionId: posting._id, resultRefs: [s.ref(receipt)] };
  });
}

export async function options(user, query) {
  requirePermission(user, 'goods_issue:create');
  return s.transaction(async session => {
    const warehouses = await m.Warehouse.find({ isActive: true, ...(role(user) !== 'OWNER' && { _id: { $in: user.warehouseIds || [] } }) }).select('code name').session(session);
    const orders = await m.SalesOrder.find({ workflowStatus: { $nin: ['CANCELLED', 'CLOSED', 'COMPLETED', 'DELIVERED'] }, ...(role(user) === 'SALES' && { createdBy: user._id }) }).sort({ createdAt: -1 }).limit(100).session(session);
    const choices = [];
    for (const order of orders) {
      if (await m.WarehouseIssueRequest.exists({ 'header.salesOrderId': order._id, workflowStatus: { $nin: ['CANCELLED', 'CLOSED'] } }).session(session)) continue;
      const lines = [];
      for (const item of order.items) {
        const left = await remainingOrder(order, item, session);
        if (left.gt(0)) lines.push({ id: String(item._id), productId: String(item.productId), lotId: item.lotId && String(item.lotId), name: item.productNameSnapshot, unit: item.baseUnitSnapshot, remainingQtyBase: left.toFixed() });
      }
      if (lines.length) choices.push({ id: String(order._id), documentNo: order.documentNo, version: order.version, lines });
    }
    const locations = await m.WarehouseLocation.find({ warehouseId: { $in: warehouses.map(w => w._id) }, isActive: true, locationType: 'STORAGE', isPickable: true }).session(session);
    const points = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locations.map(l => l._id) } }).session(session);
    const balances = await m.InventoryBalance.find({ holdingPointId: { $in: points.map(p => p._id) }, ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: { $gt: 0 } }).session(session);
    const batches = await m.ProductBatch.find({ _id: { $in: balances.map(b => b.batchId) }, identificationStatus: 'VERIFIED' }).session(session);
    const stockSources = [];
    for (const balance of balances) {
      const batch = batches.find(b => same(b._id, balance.batchId)); if (!batch) continue;
      const point = points.find(p => same(p._id, balance.holdingPointId)), location = locations.find(l => same(l._id, point.locationId));
      const available = await freeQuantity(balance, session); if (!available.gt(0)) continue;
      stockSources.push({ id: String(balance._id), productId: String(batch.productId), lotId: String(batch._id), warehouseId: String(location.warehouseId), label: location.code + ' · ' + batch.manufacturerLot + ' · ' + available.toFixed(), availableQtyBase: available.toFixed() });
    }
    return { warehouses: warehouses.map(dto), orders: choices, stockSources };
  });
}
