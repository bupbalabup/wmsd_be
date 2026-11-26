import * as direct from './direct-sales.service.js';
import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { command, checkVersion, saveVersion, same, hash, newId } from '../../shared/utils/document-command.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import { dto, transaction } from '../../shared/utils/persistence.js';
import { requirePermission, requireWarehouseAccess, hasPermission, isOwner } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { validationError, notFoundError, forbiddenError } from '../../shared/utils/ApiError.js';
import { escapeRegex } from '../../shared/utils/domain.js';
import { guardLocations, sourceContext, locationAt, beginStock, remainingReservation, freeQuantity, stocktakeLockedLocations } from '../../shared/utils/stock.js';
import { takeStock } from '../return-workflows/native.shared.js';
import { stockQuantities } from '../../shared/utils/stock-availability-read.js';
import { orderSource, redactPrices, effectiveQuantities } from '../sales-orders/sales-read.service.js';
import { toBaseQuantity } from '../../shared/utils/conversions.js';

const active = doc => !['CANCELLED', 'CLOSED', 'COMPLETED', 'DELIVERED'].includes(doc.workflowStatus);
const ref = (doc, item) => ({ documentType: doc.constructor.collection.name, documentId: doc._id, itemId: item._id });
const manual = issue => !!issue.header.referenceNo;
const sales = actor => currentRole(actor)?.code === 'SALES';
async function deliverySource(actor, id, session, write = false) {
  const delivery = await m.DeliveryOrder.findById(id).session(session);
  if (!delivery) throw notFoundError();
  if (write || !['OWNER', 'ACCOUNTANT', 'SALES'].includes(currentRole(actor)?.code)) requireWarehouseAccess(actor, delivery.header.warehouseId);
  const request = await m.WarehouseIssueRequest.findById(delivery.header.issueRequestId).session(session);
  if (!request) throw notFoundError();
  const order = await orderSource(actor, request.header.salesOrderId, session);
  if (write && (!active(delivery) || !active(request) || !active(order))) throw validationError('Chứng từ nguồn đã kết thúc');
  return { delivery, request, order };
}
export async function issueSource(actor, id, session, write = false) {
  const issue = await m.SalesGoodsIssue.findById(id).session(session);
  if (!issue) throw notFoundError();
  if (issue.header.fulfillmentMode === 'DIRECT') return direct.access(actor, id, session, write);
  if (manual(issue)) {
    if (sales(actor)) {
      if (!same(issue.createdBy, actor._id) || issue.header.issueKind !== 'SALE') throw notFoundError();
      requireWarehouseAccess(actor, issue.header.warehouseId);
    } else if (write || !['OWNER', 'ACCOUNTANT'].includes(currentRole(actor)?.code)) requireWarehouseAccess(actor, issue.header.warehouseId);
    return { issue };
  }
  let deliveryId = issue.header.deliveryOrderId;
  if (!deliveryId) {
    const deliveries = await m.DeliveryOrder.find({ 'items._id': { $in: issue.items.map(i => i.details?.outboundDeliveryLineId).filter(Boolean) } }).session(session).distinct('_id');
    if (deliveries.length !== 1) throw notFoundError('Không xác định được lệnh giao nguồn của phiếu');
    [deliveryId] = deliveries;
  }
  const context = await deliverySource(actor, deliveryId, session, write);
  if (!same(issue.header.warehouseId, context.delivery.header.warehouseId)) throw validationError('Kho phiếu xuất không khớp nguồn');
  if (issue.items.some(i => !context.delivery.items.id(i.details?.outboundDeliveryLineId))) throw validationError('Dòng phiếu xuất không khớp lệnh giao nguồn');
  return { issue, ...context };
}
const replay = async (id, actor, session) => {
  const context = await issueSource(actor, id, session);
  if (!manual(context.issue) || !sales(actor)) requireWarehouseAccess(actor, context.issue.header.warehouseId);
  return context;
};
const tasksFor = (id, session) => m.TransferOrder.find({ 'sources.subjectCollection': 'sales_goods_issues', 'sources.documentId': id }).session(session);
async function reservationsFor(id, session) {
  return m.StockReservation.find({ 'executionRef.documentId': id }).session(session);
}
async function eligible(reservation, item, warehouseId, session, kind = 'STORAGE') {
  const ctx = await sourceContext(reservation.balanceId, session);
  if (!ctx.product.isActive || ctx.batch.identificationStatus !== 'VERIFIED' || !same(ctx.product._id, item.productId)
    || (item.lotId && !same(item.lotId, ctx.batch._id)) || ctx.balance.qualityStatus !== 'GOOD' || ctx.balance.ownerType !== 'STORE'
    || !same(ctx.location?.warehouseId, warehouseId) || ctx.location.locationType !== kind || (kind === 'STORAGE' && !ctx.location.isPickable)) {
    throw validationError('Hàng, lô hoặc vị trí không còn đủ điều kiện xuất');
  }
  await guardLocations([ctx.location._id], session);
  return ctx;
}
async function moveReservation(parent, document, item, quantity, actor, session) {
  if (exact(quantity).gt(remainingReservation(parent))) throw validationError('Vượt số lượng giữ hàng còn lại');
  parent.movedQty = exact(parent.movedQty).plus(quantity).toFixed();
  await saveVersion(parent, parent.version, session);
  return new m.StockReservation({ demandRef: parent.demandRef, executionRef: ref(document, item), balanceId: parent.balanceId,
    reservedQty: quantity, previousReservationId: parent._id, createdBy: actor._id,
    creationKey: hash({ document: String(document._id), line: String(item._id), parent: String(parent._id) }),
  }).save({ session });
}
export function createIssue(user, input) {
  if (input.salesOrderId) return direct.create(user, input);
  if (input.issueKind) return createManualIssue(user, input);
  return command(user, 'CREATE_GOODS_ISSUE', 'goods_issue:create', input.deliveryOrderId, input, replay, async (session, actor) => {
    if (sales(actor)) throw forbiddenError('Sales phải tạo phiếu chờ duyệt bằng mã đơn tham chiếu');
    const { delivery, request, order } = await deliverySource(actor, input.deliveryOrderId, session, true);
    checkVersion(delivery, input.expectedVersion);
    const issue = new m.SalesGoodsIssue({ ...await nextDocumentFields(m.SalesGoodsIssue, 'GI', delivery.header.warehouseId, session),
      workflowStatus: 'DRAFT', version: 1, createdBy: actor._id, note: input.note,
      header: { warehouseId: delivery.header.warehouseId, deliveryOrderId: delivery._id }, sources: [sourceLink(delivery)], items: [] });
    for (const row of input.lines) {
      const reservation = await m.StockReservation.findById(row.reservationId).session(session);
      const source = reservation && same(reservation.executionRef?.documentId, delivery._id) && delivery.items.id(reservation.executionRef.itemId);
      if (!source) throw validationError('Giữ hàng không thuộc lệnh giao');
      const ctx = await eligible(reservation, source, delivery.header.warehouseId, session);
      if (ctx.product.wholeBaseUnits && !exact(row.qtyBase).isInteger()) throw validationError('Số lượng phải nguyên đơn vị gốc');
      const wir = request.items.id(source.details.issueRequestLineId), so = wir && order.items.id(wir.details.salesOrderLineId);
      if (!so) throw validationError('Đứt chuỗi yêu cầu xuất và yêu cầu mua hàng của khách');
      const item = copyItem(source, row.qtyBase, { lineNo: issue.items.length + 1, lineKind: 'SALES_GOODS_ISSUE', salesOrderItemId: so._id,
        details: { outboundDeliveryLineId: source._id }, sources: [sourceLink(delivery, source, row.qtyBase)],
        salePriceSnapshot: { saleUnit: so.enteredUnit, baseUnitsPerSaleUnit: so.baseUnitsPerUnit, unitSellingPrice: so.unitSellingPrice, salesOrderRevision: so.priceRevision } });
      issue.items.push(item);
      await moveReservation(reservation, issue, item, row.qtyBase, actor, session);
    }
    await issue.save({ session });
    await saveVersion(delivery, delivery.version, session);
    return { document: issue };
  });
}
function createManualIssue(user, input) {
  return command(user, 'CREATE_MANUAL_GOODS_ISSUE', 'goods_issue:create', null, input, replay, async (session, actor) => {
    if (sales(actor) && input.issueKind !== 'SALE') throw forbiddenError('Sales chỉ được tạo phiếu xuất bán');
    requireWarehouseAccess(actor, input.warehouseId);
    if (!await m.Warehouse.exists({ _id: input.warehouseId, isActive: true }).session(session)) throw validationError('Kho không còn hoạt động');
    const issue = new m.SalesGoodsIssue({ ...await nextDocumentFields(m.SalesGoodsIssue, input.issueKind === 'OTHER' ? 'GI_OTHER' : 'GI', input.warehouseId, session),
      documentKind: input.issueKind === 'OTHER' ? 'GI_OTHER' : 'GI_SALE', workflowStatus: sales(actor) ? 'PENDING_APPROVAL' : 'DRAFT', version: 1, createdBy: actor._id,
      note: input.note, header: { warehouseId: input.warehouseId, issueKind: input.issueKind, referenceNo: input.referenceNo, reasonText: input.reasonText,
        ...(input.issueKind === 'SALE' && { customerName: input.customerName, customerPhone: input.customerPhone }) }, items: [] });
    for (const row of input.lines) {
      const product = await m.Product.findOne({ _id: row.productId, isActive: true }).session(session);
      if (!product || !await m.Uom.exists({ code: product.baseUnit, isActive: true }).session(session)) throw validationError('Sản phẩm hoặc đơn vị không còn hoạt động');
      let factor = exact('1'), unit = await m.Uom.findOne({ code: product.baseUnit, isActive: true }).session(session), packagingSnapshot;
      if (row.conversionId) {
        const conversion = await m.Conversion.findOne({ _id: row.conversionId, productId: product._id, validFrom: { $lte: new Date() } }).session(session);
        unit = conversion && await m.Uom.findOne({ _id: conversion.uomId, isActive: true }).session(session);
        const batch = conversion?.productBatchId && await m.ProductBatch.findOne({ _id: conversion.productBatchId, productId: product._id, identificationStatus: 'VERIFIED' }).session(session);
        if (!conversion || !unit || (conversion.productBatchId && !batch)) throw validationError('Quy đổi không còn hợp lệ');
        const latest = await m.Conversion.findOne({ productId: product._id, productBatchId: conversion.productBatchId ?? null, uomId: unit._id, validFrom: { $lte: new Date() } }).sort({ validFrom: -1 }).session(session);
        if (!same(latest?._id, conversion._id)) throw validationError('Quy đổi đã thay đổi, hãy tải lại danh mục');
        factor = exact(String(conversion.basePerUnit));
        if (unit.isCarton && batch) packagingSnapshot = { packageUnit: unit.code, baseUnitsPerPackage: factor.toFixed(), outerLengthMm: batch.cartonLengthMm, outerWidthMm: batch.cartonWidthMm, outerHeightMm: batch.cartonHeightMm };
      }
      const enteredQty = row.quantity ?? row.qtyBase, qtyBase = toBaseQuantity(enteredQty, factor, product, unit).toFixed();
      if (product.wholeBaseUnits && !exact(qtyBase).isInteger()) throw validationError('Quy đổi phải ra số nguyên đơn vị gốc');
      issue.items.push({ _id: newId(), lineNo: issue.items.length + 1, lineKind: 'SALES_GOODS_ISSUE', productId: product._id,
        enteredUnit: unit.code, baseUnitSnapshot: product.baseUnit, baseUnitsPerUnit: factor.toFixed(), enteredQty, qtyBase, packagingSnapshot, productNameSnapshot: product.name, note: row.note, details: {} });
    }
    return { document: await issue.save({ session }) };
  });
}
export function approveIssue(user, id, input) {
  return command(user, 'APPROVE_GOODS_ISSUE', 'goods_issue:approve', id, input, replay, async (session, actor) => {
    if (!isOwner(actor)) throw forbiddenError('Chỉ Store Owner được duyệt phiếu xuất');
    const { issue } = await issueSource(actor, id, session, true);
    checkVersion(issue, input.expectedVersion);
    if (!manual(issue) || issue.workflowStatus !== 'PENDING_APPROVAL' || same(issue.createdBy, actor._id)) throw validationError('Phiếu không ở trạng thái chờ người khác duyệt');
    issue.workflowStatus = 'DRAFT'; issue.approvedBy = actor._id; issue.approvedAt = new Date();
    return { document: await saveVersion(issue, input.expectedVersion, session), versionBefore: input.expectedVersion };
  });
}
export function updateIssue(user, id, input) {
  return command(user, 'UPDATE_GOODS_ISSUE', 'goods_issue:update', id, input, replay, async (session, actor) => {
    const { issue, delivery } = await issueSource(actor, id, session, true);
    if (issue.header.fulfillmentMode === 'DIRECT') throw validationError('Hủy và lập lại phiếu để đổi nguồn tồn');
    checkVersion(issue, input.expectedVersion);
    if (!(manual(issue) && sales(actor) ? issue.workflowStatus === 'PENDING_APPROVAL' : issue.workflowStatus === 'DRAFT') || (await tasksFor(id, session)).length) throw validationError('Chỉ sửa phiếu trước khi lập lệnh soạn và đúng trạng thái');
    if (input.lines.length !== issue.items.length) throw validationError('Cập nhật đủ các dòng đã lập');
    const reservations = await reservationsFor(id, session);
    if (manual(issue)) {
      for (const row of input.lines) {
        const item = issue.items.id(row.lineId), product = item && await m.Product.findOne({ _id: item.productId, isActive: true }).session(session);
        if (!item || !product || (product.wholeBaseUnits && !exact(row.qtyBase).isInteger())) throw validationError('Dòng hoặc số lượng không hợp lệ');
        item.qtyBase = row.qtyBase; item.enteredQty = row.qtyBase; item.enteredUnit = item.baseUnitSnapshot; item.baseUnitsPerUnit = '1'; item.packagingSnapshot = undefined;
      }
      if (input.note !== undefined) issue.note = input.note;
      issue.updatedBy = actor._id;
      return { document: await saveVersion(issue, input.expectedVersion, session), versionBefore: input.expectedVersion };
    }
    for (const row of input.lines) {
      const item = issue.items.id(row.lineId), own = reservations.find(r => same(r.executionRef.itemId, row.lineId));
      if (!item || !own) throw validationError('Dòng không thuộc phiếu xuất');
      const ctx = await eligible(own, item, issue.header.warehouseId, session);
      if (ctx.product.wholeBaseUnits && !exact(row.qtyBase).isInteger()) throw validationError('Số lượng phải nguyên đơn vị gốc');
      const parent = await m.StockReservation.findById(own.previousReservationId).session(session);
      if (!parent || !same(parent.executionRef?.documentId, delivery._id)) throw validationError('Không tìm thấy giữ hàng nguồn');
      const delta = exact(row.qtyBase).minus(String(item.qtyBase));
      if (delta.gt(remainingReservation(parent))) throw validationError('Vượt lượng còn lại của lệnh giao');
      parent.movedQty = exact(parent.movedQty).plus(delta).toFixed();
      await saveVersion(parent, parent.version, session);
      own.reservedQty = row.qtyBase;
      await saveVersion(own, own.version, session);
      const changed = copyItem(item, row.qtyBase, { _id: item._id, lineKind: item.lineKind, details: item.details.toObject(), salesOrderItemId: item.salesOrderItemId, salePriceSnapshot: item.salePriceSnapshot,
        sources: [sourceLink(delivery, delivery.items.id(item.details.outboundDeliveryLineId), row.qtyBase)] });
      issue.items[issue.items.indexOf(item)] = changed;
    }
    if (input.note !== undefined) issue.note = input.note;
    issue.updatedBy = actor._id;
    await saveVersion(delivery, delivery.version, session);
    return { document: await saveVersion(issue, input.expectedVersion, session), versionBefore: input.expectedVersion };
  });
}
export function createIssuePicking(user, id, input) {
  return command(user, 'CREATE_GOODS_ISSUE_PICKING', 'picking_task:create', id, input,
    async (taskId, actor, session) => {
      const task = await m.TransferOrder.findById(taskId).session(session);
      if (!task) throw notFoundError();
      return replay(task.sources[0].documentId, actor, session);
    }, async (session, actor) => {
      const { issue } = await issueSource(actor, id, session, true);
      if (sales(actor)) throw forbiddenError('Sales không thực hiện soạn hàng');
      requireWarehouseAccess(actor, issue.header.warehouseId);
      checkVersion(issue, input.expectedVersion);
      if (issue.workflowStatus !== 'DRAFT' || (await tasksFor(id, session)).length) throw validationError('Phiếu đã có lệnh soạn hoặc không còn nháp');
      if (manual(issue)) return allocateManualPicking(issue, actor, input, session);
      if (!input.destinations) throw validationError('Chọn tập kết cho phiếu từ lệnh giao');
      if (input.destinations.length !== issue.items.length) throw validationError('Chọn tập kết cho mọi dòng');
      const reservations = await reservationsFor(id, session);
      const task = new m.TransferOrder({ ...await nextDocumentFields(m.TransferOrder, 'PICK', issue.header.warehouseId, session),
        workflowStatus: 'OPEN', version: 1, createdBy: actor._id,
        header: { warehouseId: issue.header.warehouseId, taskKind: 'PICK', assignedTo: actor._id }, sources: [sourceLink(issue)], items: [] });
      for (const item of issue.items) {
        const own = reservations.find(r => same(r.executionRef.itemId, item._id));
        if (!own || !remainingReservation(own).eq(String(item.qtyBase))) throw validationError('Giữ hàng không khớp phiếu');
        const ctx = await eligible(own, item, issue.header.warehouseId, session);
        const target = input.destinations.find(row => same(row.lineId, item._id));
        if (!target) throw validationError('Thiếu vị trí tập kết');
        const location = await locationAt(target.locationId, issue.header.warehouseId, ['STAGING'], session);
        await guardLocations([location._id], session);
        const pick = copyItem(item, item.qtyBase, { lineNo: task.items.length + 1, lineKind: 'WAREHOUSE_TASK', sources: [sourceLink(issue, item, item.qtyBase)],
          details: { sourceBalanceId: ctx.balance._id, sourceBalanceVersion: ctx.balance.version, fromLocationId: ctx.location._id, toLocationId: location._id, qualityCode: 'GOOD' } });
        task.items.push(pick);
        await moveReservation(own, task, pick, String(item.qtyBase), actor, session);
      }
      await task.save({ session });
      await saveVersion(issue, issue.version, session);
      return { document: task, resultRefs: [{ documentType: 'sales_goods_issues', documentId: issue._id }] };
    });
}
async function allocateManualPicking(issue, actor, input, session) {
  if (!input.allocations?.length) throw validationError('Chọn tồn nguồn và tập kết cho từng dòng');
  const task = new m.TransferOrder({ ...await nextDocumentFields(m.TransferOrder, 'PICK', issue.header.warehouseId, session),
    workflowStatus: 'OPEN', version: 1, createdBy: actor._id, header: { warehouseId: issue.header.warehouseId, taskKind: 'PICK', assignedTo: actor._id }, sources: [sourceLink(issue)], items: [] });
  const totals = new Map();
  for (const row of input.allocations) {
    const item = issue.items.id(row.lineId);
    if (!item) throw validationError('Dòng không thuộc phiếu xuất');
    const ctx = await eligible({ balanceId: row.sourceBalanceId }, item, issue.header.warehouseId, session);
    if (ctx.product.wholeBaseUnits && !exact(row.qtyBase).isInteger()) throw validationError('Số lượng phải nguyên đơn vị gốc');
    await locationAt(row.locationId, issue.header.warehouseId, ['STAGING'], session);
    await guardLocations([row.locationId], session);
    if (exact(row.qtyBase).gt(await freeQuantity(ctx.balance, session))) throw validationError('Không đủ tồn khả dụng để soạn');
    const total = (totals.get(String(item._id)) ?? exact('0')).plus(row.qtyBase);
    if (total.gt(String(item.qtyBase))) throw validationError('Tổng lượng soạn vượt phiếu xuất');
    totals.set(String(item._id), total);
    const pick = copyItem(item, row.qtyBase, { lineNo: task.items.length + 1, lineKind: 'WAREHOUSE_TASK', lotId: ctx.batch._id, sources: [sourceLink(issue, item, row.qtyBase)],
      details: { sourceBalanceId: ctx.balance._id, sourceBalanceVersion: ctx.balance.version, fromLocationId: ctx.location._id, toLocationId: row.locationId, qualityCode: 'GOOD' } });
    task.items.push(pick);
    const locked = await m.InventoryBalance.updateOne({ _id: ctx.balance._id, version: ctx.balance.version }, { $inc: { version: 1 } }, { session });
    if (locked.matchedCount !== 1) throw validationError('Tồn nguồn đã thay đổi');
    await new m.StockReservation({ demandRef: ref(issue, item), executionRef: ref(task, pick), balanceId: ctx.balance._id, reservedQty: row.qtyBase,
      creationKey: hash({ task: String(task._id), line: String(pick._id) }), createdBy: actor._id }).save({ session });
  }
  if (issue.items.some(i => !totals.get(String(i._id))?.eq(String(i.qtyBase)))) throw validationError('Phân bổ đủ lượng của mọi dòng phiếu xuất');
  await task.save({ session }); await saveVersion(issue, issue.version, session);
  return { document: task, resultRefs: [{ documentType: 'sales_goods_issues', documentId: issue._id }] };
}
export function cancelIssue(user, id, input) {
  return command(user, 'CANCEL_GOODS_ISSUE', 'goods_issue:update', id, input, replay, async (session, actor) => {
    const { issue, delivery } = await issueSource(actor, id, session, true);
    checkVersion(issue, input.expectedVersion);
    const tasks = await tasksFor(id, session);
    const cancellable = manual(issue) && sales(actor) ? issue.workflowStatus === 'PENDING_APPROVAL' : issue.workflowStatus === 'DRAFT';
    if (!cancellable || tasks.some(t => !['OPEN', 'CANCELLED'].includes(t.workflowStatus))
      || await m.StockTransaction.exists({ sourceId: { $in: tasks.map(t => t._id) } }).session(session)) throw validationError('Không thể hủy sau khi đã bắt đầu soạn');
    const reservations = await m.StockReservation.find({ 'executionRef.documentId': { $in: [issue._id, ...tasks.map(t => t._id)] } }).session(session);
    for (const own of reservations) {
      const amount = remainingReservation(own);
      if (!amount.gt(0)) continue;
      if (manual(issue)) {
        own.releasedQty = exact(own.releasedQty).plus(amount).toFixed();
        await saveVersion(own, own.version, session);
        continue;
      }
      let root = own;
      const seen = new Set();
      while (!same(root.executionRef?.documentId, delivery._id)) {
        if (seen.has(String(root._id))) throw validationError('Giữ hàng nguồn không hợp lệ');
        seen.add(String(root._id));
        root = await m.StockReservation.findById(root.previousReservationId).session(session);
        if (!root) throw validationError('Không tìm thấy giữ hàng nguồn');
      }
      root.movedQty = exact(root.movedQty).minus(amount).toFixed();
      await saveVersion(root, root.version, session);
      own.releasedQty = exact(own.releasedQty).plus(amount).toFixed();
      await saveVersion(own, own.version, session);
    }
    for (const task of tasks.filter(t => t.workflowStatus === 'OPEN')) { task.workflowStatus = 'CANCELLED'; await saveVersion(task, task.version, session); }
    issue.workflowStatus = 'CANCELLED'; issue.cancelledBy = actor._id; issue.cancelledAt = new Date(); issue.cancelReason = input.reason;
    if (delivery) await saveVersion(delivery, delivery.version, session);
    return { document: await saveVersion(issue, input.expectedVersion, session), versionBefore: input.expectedVersion, reason: input.reason };
  });
}
export function postIssue(user, id, input) {
  return command(user, 'POST_GOODS_ISSUE', 'goods_issue:post', id, input, replay, async (session, actor) => {
    const { issue, delivery, order } = await issueSource(actor, id, session, true);
    if (sales(actor)) throw forbiddenError('Sales không xác nhận xuất kho');
    requireWarehouseAccess(actor, issue.header.warehouseId);
    checkVersion(issue, input.expectedVersion);
    if (issue.header.fulfillmentMode === 'DIRECT') {
      const posting = await direct.post(issue, order, actor, input, session);
      await saveVersion(issue, input.expectedVersion, session);
      return { document: issue, versionBefore: input.expectedVersion, stockTransactionId: posting._id };
    }
    const tasks = await tasksFor(id, session);
    if (issue.workflowStatus !== 'PICKED' || !tasks.length || tasks.some(t => t.workflowStatus !== 'CONFIRMED')) throw validationError('Cần soạn xong trước khi ghi xuất');
    const reservations = await reservationsFor(id, session);
    const posting = beginStock(issue, actor, issue.header.issueKind === 'OTHER' ? 'OTHER_ISSUE' : 'PGI', input);
    for (const item of issue.items) {
      const own = reservations.filter(r => same(r.executionRef.itemId, item._id) && remainingReservation(r).gt(0));
      if (!own.reduce((n, r) => n.plus(remainingReservation(r)), exact('0')).eq(String(item.qtyBase))) throw validationError('Lượng đã soạn không khớp phiếu xuất');
      for (const reservation of own) {
        await eligible(reservation, item, issue.header.warehouseId, session, 'STAGING');
        const quantity = remainingReservation(reservation).toFixed();
        reservation.consumedQty = exact(reservation.consumedQty).plus(quantity).toFixed();
        await saveVersion(reservation, reservation.version, session);
        await takeStock(reservation.balanceId, quantity, item._id, posting, actor, session, { allowOpening: true });
      }
    }
    await posting.save({ session });
    issue.handovers ??= [];
    issue.handovers.push({ ...await nextDocumentFields(m.SalesGoodsIssue, 'HO', issue.header.warehouseId, session),
      workflowStatus: 'CONFIRMED', version: 1, createdBy: actor._id,
      header: { relatedDocumentId: issue._id, recipientName: input.recipientName, vehiclePlate: input.vehiclePlate, handedOverAt: new Date(), confirmedBy: actor._id },
      items: issue.items.map((item, index) => copyItem(item, item.qtyBase, { lineNo: index + 1, sources: [sourceLink(issue, item, item.qtyBase)] })) });
    issue.workflowStatus = 'POSTED'; issue.postedAt = new Date(); issue.postedBy = actor._id;
    issue.header.issuedAt = issue.postedAt; issue.header.issuedBy = actor._id; issue.occurredAt = issue.postedAt; issue.stockTransactionId = posting._id;
    if (delivery) await saveVersion(delivery, delivery.version, session);
    if (order) await saveVersion(order, order.version, session);
    return { document: await saveVersion(issue, input.expectedVersion, session), versionBefore: input.expectedVersion, stockTransactionId: posting._id };
  });
}

async function readableDeliveries(user, query = {}, session) {
  const role = currentRole(user)?.code;
  const orders = await m.SalesOrder.find({ ...(role === 'SALES' && { createdBy: user._id }), ...(query.salesOrderId && { _id: query.salesOrderId }) }).session(session).distinct('_id');
  const requests = await m.WarehouseIssueRequest.find({ 'header.salesOrderId': { $in: orders }, ...(query.issueRequestId && { _id: query.issueRequestId }),
    ...(query.sourceRequest && { documentNo: new RegExp(escapeRegex(query.sourceRequest), 'i') }),
    ...(!['OWNER', 'ACCOUNTANT', 'SALES', 'WAREHOUSE'].includes(role) && { 'header.requestedWarehouseId': { $in: user.warehouseIds || [] } }),
  }).session(session).distinct('_id');
  return m.DeliveryOrder.find({ 'header.issueRequestId': { $in: requests },
    ...(!['OWNER', 'ACCOUNTANT', 'SALES'].includes(role) && { 'header.warehouseId': { $in: user.warehouseIds || [] } }),
    ...(query.deliveryOrderId && { _id: query.deliveryOrderId }),
  }).session(session);
}
async function present(issue, context, session) {
  const warehouse = await m.Warehouse.findById(issue.header.warehouseId).select('code name').session(session);
  return { ...redactPrices(dto(issue)), warehouse: warehouse && dto(warehouse), manualReference: manual(issue),
    deliveryOrder: context.delivery ? { id: String(context.delivery._id), documentNo: context.delivery.documentNo } : null,
    issueRequest: context.request ? { id: String(context.request._id), documentNo: context.request.documentNo } : null,
    salesOrder: context.order ? { id: String(context.order._id), documentNo: context.order.documentNo } : null };
}
export async function listIssues(user, query) {
  requirePermission(user, 'goods_issue:read');
  return transaction(async session => {
    const deliveries = await readableDeliveries(user, query, session);
    const manualFilter = { 'header.referenceNo': { $exists: true },
      ...(sales(user) ? { createdBy: user._id, 'header.issueKind': 'SALE', 'header.warehouseId': { $in: user.warehouseIds || [] } } : !['OWNER', 'ACCOUNTANT'].includes(currentRole(user)?.code) ? { 'header.warehouseId': { $in: user.warehouseIds || [] } } : {}),
      ...(query.sourceRequest && { 'header.referenceNo': new RegExp(escapeRegex(query.sourceRequest), 'i') }),
      ...((query.deliveryOrderId || query.salesOrderId || query.issueRequestId) && { _id: { $in: [] } }) };
    const directOrders = await m.SalesOrder.find({ ...(sales(user) && { createdBy: user._id }), ...(query.salesOrderId && { _id: query.salesOrderId }), ...(query.sourceRequest && { documentNo: new RegExp(escapeRegex(query.sourceRequest), 'i') }) }).session(session).distinct('_id');
    const directFilter = { 'header.fulfillmentMode': 'DIRECT', 'header.salesOrderId': { $in: directOrders }, ...(!['OWNER', 'ACCOUNTANT', 'SALES'].includes(currentRole(user)?.code) && { 'header.warehouseId': { $in: user.warehouseIds || [] } }), ...((query.deliveryOrderId || query.issueRequestId) && { _id: { $in: [] } }) };
    const filter = { $or: [directFilter,{ 'header.deliveryOrderId': { $in: deliveries.map(d => d._id) } },
      { 'header.deliveryOrderId': { $exists: false }, 'header.referenceNo': { $exists: false }, 'items.details.outboundDeliveryLineId': { $in: deliveries.flatMap(d => d.items.map(i => i._id)) } }, manualFilter],
      ...(query.warehouseId && { 'header.warehouseId': query.warehouseId }) };
    if (query.status) filter.workflowStatus = query.status;
    if (query.q) filter.documentNo = new RegExp(escapeRegex(query.q), 'i');
    if (query.from || query.to) filter.occurredAt = { ...(query.from && { $gte: new Date(query.from) }), ...(query.to && { $lte: new Date(query.to) }) };
    const total = await m.SalesGoodsIssue.countDocuments(filter).session(session);
    const issues = await m.SalesGoodsIssue.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).session(session);
    const items = [];
    for (const issue of issues) items.push(await present(issue, await issueSource(user, issue._id, session), session));
    return { items, total, page: query.page, limit: query.limit };
  });
}
export async function getIssue(user, id) {
  requirePermission(user, 'goods_issue:read');
  return transaction(async session => {
    const context = await issueSource(user, id, session), { issue } = context;
    const tasks = await tasksFor(id, session);
    const postings = await m.StockTransaction.find({ sourceId: { $in: tasks.map(t => t._id) }, operation: 'SALES_PICK' }).session(session);
    const confirmedWithoutLedger = tasks.filter(t => t.workflowStatus === 'CONFIRMED' && !postings.some(p => same(p.sourceId, t._id))).flatMap(t => t.items);
    const issuePostings = await m.StockTransaction.find({ sourceId: issue._id, reversedTransactionId: { $exists: false } }).session(session);
    const units = await m.Uom.find({ code: { $in: [...new Set(issue.items.flatMap(item => [item.enteredUnit, item.baseUnitSnapshot]))] } }).select('code name').session(session);
    const issued = await effectiveQuantities([issue], session);
    const lots = await m.ProductBatch.find({ _id: { $in: [...issue.items.map(i => i.lotId), ...tasks.flatMap(t => t.items.map(i => i.lotId))].filter(Boolean) } }).session(session);
    const locationIds = tasks.flatMap(t => t.items.flatMap(i => [i.details.fromLocationId, i.details.toLocationId]));
    const reservations = await reservationsFor(id, session);
    const balances = await m.InventoryBalance.find({ _id: { $in: [...issue.items.map(i => i.sourceBalanceId).filter(Boolean), ...reservations.map(r => r.balanceId), ...issuePostings.flatMap(p => p.movements.map(v => v.fromBalanceId))] } }).session(session);
    const points = await m.StockHoldingPoint.find({ _id: { $in: balances.map(b => b.holdingPointId) } }).session(session);
    const locations = await m.WarehouseLocation.find({ _id: { $in: [...locationIds, ...points.map(p => p.locationId)] } }).session(session);
    const rows = issue.items.map(item => {
      const work = tasks.flatMap(t => t.items).filter(i => i.sources.some(s => same(s.documentId, issue._id) && same(s.itemId, item._id)));
      const picked = postings.flatMap(p => p.movements).filter(v => work.some(i => same(i._id, v.sourceLineId)));
      const sourceBalances = [...(item.sourceBalanceId ? [item.sourceBalanceId] : []), ...reservations.filter(r => same(r.executionRef.itemId, item._id)).map(r => r.balanceId), ...issuePostings.flatMap(p => p.movements.filter(v => same(v.sourceLineId, item._id)).map(v => v.fromBalanceId))];
      const sourceLocations = work.length ? work.map(i => i.details.fromLocationId) : sourceBalances.map(balanceId => points.find(p => same(p._id, balances.find(b => same(b._id, balanceId))?.holdingPointId))?.locationId);
      const labels = ids => [...new Set(ids.map(id => locations.find(l => same(l._id, id))?.code).filter(Boolean))];
      // Historical full confirmations may predate SALES_PICK ledger records.
      const prepared = work.length ? picked.reduce((n, p) => n.plus(String(p.quantityBase)), exact('0'))
        .plus(confirmedWithoutLedger.filter(i => work.some(w => same(w._id, i._id))).reduce((n, i) => n.plus(String(i.qtyBase)), exact('0'))).toFixed() : issue.workflowStatus === 'POSTED' ? null : '0';
      return { ...redactPrices(dto(item)), enteredUnitName: units.find(unit => unit.code === item.enteredUnit)?.name ?? item.enteredUnit,
        baseUnitName: units.find(unit => unit.code === item.baseUnitSnapshot)?.name ?? item.baseUnitSnapshot,
        lotLabel: [...new Set(lots.filter(l => same(l._id, item.lotId) || work.some(w => same(w.lotId, l._id))).map(l => l.manufacturerLot))].join(', ') || 'Chọn khi soạn',
        sourceLocations: labels(sourceLocations), stagingLocations: labels(work.map(i => i.details.toLocationId)), preparedQtyBase: prepared, issuedQtyBase: issued.get(String(item._id))?.toFixed() ?? '0' };
    });
    if (issue.header.fulfillmentMode === 'DIRECT') {
      for (const row of rows) {
        row.customerReceivedQtyBase = direct.confirmedQuantity(issue, row.id || row._id).toFixed();
        row.undeliveredReturnedQtyBase = (await direct.returnedQuantity(row.id || row._id, session)).toFixed();
        row.unconfirmedQtyBase = exact(row.issuedQtyBase).minus(row.customerReceivedQtyBase).minus(row.undeliveredReturnedQtyBase).toFixed();
      }
      const operate = isOwner(user) || (user.warehouseIds || []).some(w => same(w, issue.header.warehouseId));
      const receipts = await m.FailedDeliveryReceipt.find({ 'items.details.salesIssueLineId': { $in: issue.items.map(i => i._id) }, workflowStatus: 'POSTED' }).session(session);
      return { ...await present(issue, context, session), items: rows, tasks: [], stagingLocations: [], undeliveredReceipts: receipts.map(dto),
        capabilities: { canEdit: false, canCancel: operate && issue.workflowStatus === 'DRAFT' && hasPermission(user, 'goods_issue:update'), canCreatePicking: false, canPost: operate && issue.workflowStatus === 'DRAFT' && hasPermission(user, 'goods_issue:post'),
          canConfirmCustomer: rows.some(row => exact(row.unconfirmedQtyBase).gt(0)) && sales(user) && hasPermission(user, 'delivery_confirmation:confirm') && issue.workflowStatus === 'POSTED', canReceiveUndelivered: rows.some(row => exact(row.unconfirmedQtyBase).gt(0)) && operate && !sales(user) && hasPermission(user, 'failed_delivery:post') && issue.workflowStatus === 'POSTED' } };
    }
    const operate = isOwner(user) || (user.warehouseIds || []).some(w => same(w, issue.header.warehouseId));
    const mayEdit = manual(issue) && sales(user) ? same(issue.createdBy, user._id) && issue.workflowStatus === 'PENDING_APPROVAL' : operate && issue.workflowStatus === 'DRAFT';
    const canEdit = mayEdit && hasPermission(user, 'goods_issue:update') && !tasks.length;
    const canCancel = mayEdit && hasPermission(user, 'goods_issue:update') && tasks.every(t => t.workflowStatus === 'OPEN') && !postings.length;
    const stagingLocations = operate && hasPermission(user, 'picking_task:create') ? await m.WarehouseLocation.find({ warehouseId: issue.header.warehouseId, isActive: true, locationType: 'STAGING' }).select('code').session(session) : [];
    const stockSources = [];
    if (manual(issue) && operate && !sales(user) && hasPermission(user, 'picking_task:create') && issue.workflowStatus === 'DRAFT') {
      const storage = await m.WarehouseLocation.find({ warehouseId: issue.header.warehouseId, isActive: true, locationType: 'STORAGE', isPickable: true }).session(session);
      const sourcePoints = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: storage.map(l => l._id) } }).session(session);
      const batches = await m.ProductBatch.find({ productId: { $in: issue.items.map(i => i.productId) }, identificationStatus: 'VERIFIED' }).session(session);
      const stock = await m.InventoryBalance.find({ holdingPointId: { $in: sourcePoints.map(p => p._id) }, batchId: { $in: batches.map(b => b._id) }, ownerType: 'STORE', qualityStatus: 'GOOD' }).session(session);
      const frozen = await stocktakeLockedLocations(storage.map(l => l._id), session);
      for (const balance of stock) {
        const point = sourcePoints.find(p => same(p._id, balance.holdingPointId));
        if (frozen.has(String(point.locationId))) continue; // locked by a stocktake: nothing selectable
        const available = await freeQuantity(balance, session);
        if (!available.gt(0)) continue;
        const batch = batches.find(b => same(b._id, balance.batchId));
        stockSources.push({ id: String(balance._id), productId: String(batch.productId), lotLabel: batch.manufacturerLot, location: storage.find(l => same(l._id, point.locationId)).code, availableQtyBase: available.toFixed() });
      }
    }
    return { ...await present(issue, context, session), items: rows, stockSources, stagingLocations: stagingLocations.map(dto), tasks: tasks.map(t => ({ id: String(t._id), documentNo: t.documentNo, workflowStatus: t.workflowStatus, version: t.version, assignedTo: String(t.header.assignedTo),
      canConfirm: operate && hasPermission(user, 'picking_task:confirm') && same(t.header.assignedTo, user._id) && ['OPEN', 'PARTIAL'].includes(t.workflowStatus),
      items: t.items.map(i => ({ ...redactPrices(dto(i)), lotLabel: lots.find(l => same(l._id, i.lotId))?.manufacturerLot ?? '—',
        sourceLocation: locations.find(l => same(l._id, i.details.fromLocationId))?.code ?? '—', stagingLocation: locations.find(l => same(l._id, i.details.toLocationId))?.code ?? '—',
        actualQtyBase: confirmedWithoutLedger.some(c => same(c._id, i._id)) ? String(i.qtyBase) : postings.filter(p => same(p.sourceId, t._id)).flatMap(p => p.movements).filter(v => same(v.sourceLineId, i._id)).reduce((n, v) => n.plus(String(v.quantityBase)), exact('0')).toFixed() })) })),
      capabilities: { canEdit, canCancel, canApprove: isOwner(user) && hasPermission(user, 'goods_issue:approve') && issue.workflowStatus === 'PENDING_APPROVAL' && !same(issue.createdBy, user._id), canCreatePicking: operate && !sales(user) && hasPermission(user, 'picking_task:create') && issue.workflowStatus === 'DRAFT' && !tasks.length,
        canPost: operate && hasPermission(user, 'goods_issue:post') && issue.workflowStatus === 'PICKED' && tasks.length > 0 && tasks.every(t => t.workflowStatus === 'CONFIRMED') } };
  });
}
async function warehouseIssueAvailability(user, warehouseId, session) {
  requireWarehouseAccess(user, warehouseId);
  if (!await m.Warehouse.exists({ _id: warehouseId, isActive: true }).session(session)) throw validationError('Kho không còn hoạt động');
  const storage = await m.WarehouseLocation.find({ warehouseId, isActive: true, locationType: 'STORAGE', isPickable: true }).select('_id').session(session).lean();
  const locationIds = storage.map(location => location._id);
  const frozen = await stocktakeLockedLocations(locationIds, session);
  const points = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locationIds.filter(id => !frozen.has(String(id))) } }).select('_id').session(session).lean();
  const stock = await m.InventoryBalance.find({ holdingPointId: { $in: points.map(point => point._id) }, ownerType: 'STORE', qualityStatus: 'GOOD' }).select('batchId quantityBase').session(session).lean();
  const batches = await m.ProductBatch.find({ _id: { $in: stock.map(balance => balance.batchId) }, identificationStatus: 'VERIFIED' }).select('productId').session(session).lean();
  const productsByBatch = new Map(batches.map(batch => [String(batch._id), String(batch.productId)]));
  const eligibleBalances = stock.filter(balance => productsByBatch.has(String(balance.batchId)));
  const quantities = await stockQuantities(eligibleBalances, session), totals = new Map();
  for (const balance of eligibleBalances) {
    const available = quantities.get(String(balance._id)).free;
    if (!available.gt(0)) continue;
    const productId = productsByBatch.get(String(balance.batchId));
    totals.set(productId, (totals.get(productId) ?? exact('0')).plus(available));
  }
  return { lines: [], availableByProduct: Object.fromEntries([...totals].map(([id, quantity]) => [id, quantity.toFixed()])) };
}

export async function issueOptions(user, query) {
  requirePermission(user, 'goods_issue:create');
  return transaction(async session => {
    if (query.warehouseId && !query.deliveryOrderId) return warehouseIssueAvailability(user, query.warehouseId, session);
    if (!query.deliveryOrderId) {
      const deliveries = (await readableDeliveries(user, query, session)).filter(d => active(d)
        && (isOwner(user) || (user.warehouseIds || []).some(w => same(w, d.header.warehouseId)))
        && (!query.q || d.documentNo.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))).slice(0, 100);
      const warehouses = await m.Warehouse.find({ isActive: true, ...(!isOwner(user) && { _id: { $in: user.warehouseIds || [] } }) }).select('code name').session(session);
      const products = await m.Product.find({ isActive: true }).select('sku name baseUnit wholeBaseUnits').session(session);
      const units = await m.Uom.find({ isActive: true }).select('code name isCarton areaMm2').session(session);
      const batches = await m.ProductBatch.find({ identificationStatus: 'VERIFIED' }).select('productId').session(session);
      const conversions = await m.Conversion.find({ productId: { $in: products.map(p => p._id) }, uomId: { $in: units.map(u => u._id) }, validFrom: { $lte: new Date() }, $or: [{ productBatchId: null }, { productBatchId: { $in: batches.map(b => b._id) } }] }).sort({ validFrom: -1 }).session(session);
      const current = conversions.filter((c, index) => conversions.findIndex(r => same(r.productId, c.productId) && String(r.productBatchId || '') === String(c.productBatchId || '') && same(r.uomId, c.uomId)) === index);
      const choices = current.filter((c, index) => current.findIndex(r => same(r.productId, c.productId) && same(r.uomId, c.uomId) && exact(String(r.basePerUnit)).eq(String(c.basePerUnit))) === index);
      return { deliveries: deliveries.map(d => ({ id: String(d._id), documentNo: d.documentNo })), warehouses: warehouses.map(dto), products: products.map(product => ({ ...dto(product), baseUnitName: units.find(unit => unit.code === product.baseUnit)?.name ?? product.baseUnit })), units: units.map(dto),
        conversions: choices.map(c => ({ id: String(c._id), productId: String(c.productId), unit: units.find(u => same(u._id, c.uomId)).name, isArea: units.find(u => same(u._id, c.uomId)).areaMm2 != null, basePerUnit: String(c.basePerUnit) })), salesOnly: sales(user), lines: [], locations: [] };
    }
    const context = await deliverySource(user, query.deliveryOrderId, session, true), { delivery } = context;
    const reservations = await reservationsFor(delivery._id, session);
    const lines = [];
    const open = [];
    for (const reservation of reservations.filter(r => remainingReservation(r).gt(0))) {
      const item = delivery.items.id(reservation.executionRef.itemId);
      if (!item) continue;
      open.push({ reservation, item, ctx: await sourceContext(reservation.balanceId, session) });
    }
    // One lock query for every source location instead of one per reservation.
    const locked = await stocktakeLockedLocations(open.map(row => row.ctx.location?._id).filter(Boolean), session);
    for (const { reservation, item, ctx } of open) {
      if (ctx.location && locked.has(String(ctx.location._id))) continue; // locked by a stocktake: not selectable
      lines.push({ reservationId: String(reservation._id), productName: item.productNameSnapshot, lotLabel: ctx.batch.manufacturerLot,
        sourceLocation: ctx.location?.code, baseUnit: item.baseUnitSnapshot, remainingQtyBase: remainingReservation(reservation).toFixed() });
    }
    const locations = await m.WarehouseLocation.find({ warehouseId: delivery.header.warehouseId, isActive: true, locationType: 'STAGING' }).select('code').session(session);
    return { delivery: { id: String(delivery._id), documentNo: delivery.documentNo, version: delivery.version }, lines, locations: locations.map(dto) };
  });
}
