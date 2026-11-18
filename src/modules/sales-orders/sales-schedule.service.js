import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { command, checkVersion, saveVersion, same, newId, hash } from '../../shared/utils/document-command.js';
import { validationError, notFoundError, forbiddenError } from '../../shared/utils/ApiError.js';
import { vnDay, vnMidnight } from '../../shared/utils/vn-date.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { orderSource } from './sales-read.service.js';
import { guardLocations, fifoCandidates, remainingReservation, sourceContext } from '../../shared/utils/stock.js';

export const lotLabel = async (lotId, session) => (await m.ProductBatch.findById(lotId).select('manufacturerLot').session(session).lean())?.manufacturerLot ?? String(lotId);

// Split `quantity` of one lot in one warehouse over pick locations, oldest receipt first,
// and hold each part. Throws with the missing quantity when the warehouse cannot cover it.
export async function allocateAndReserve({ order, scheduleId, delivery, line, soLine, warehouse, actor, session, quantity = line.qtyBase }) {
  const candidates = await fifoCandidates(delivery.warehouseId, line.lotId, session);
  let left = exact(quantity);
  for (const candidate of candidates) {
    if (!left.gt(0)) break;
    const take = candidate.free.lt(left) ? candidate.free : left;
    await guardLocations([candidate.locationId], session);
    const allocation = { _id: newId(), balanceId: candidate.balance._id, locationId: candidate.locationId, qtyBase: take.toFixed() };
    const reservation = await new m.StockReservation({
      demandRef: { documentType: 'sales_orders', documentId: order._id, itemId: soLine._id },
      executionRef: { documentType: 'delivery_schedules', documentId: scheduleId, itemId: allocation._id },
      balanceId: candidate.balance._id, reservedQty: take.toFixed(),
      creationKey: hash({ ds: String(scheduleId), allocation: String(allocation._id) }), createdBy: actor._id,
    }).save({ session });
    allocation.reservationId = reservation._id;
    // Concurrent transactions touching the same stock conflict here and are retried.
    await m.InventoryBalance.updateOne({ _id: candidate.balance._id }, { $inc: { version: 1 } }, { session });
    line.allocations.push(allocation);
    left = left.minus(take);
  }
  if (left.gt(0)) {
    const product = await m.Product.findById(soLine.productId).select('name').session(session).lean();
    throw validationError(`Không đủ hàng khả dụng: lần giao ${delivery.seq}, kho ${warehouse.code ?? warehouse.name}, ${product?.name ?? 'sản phẩm'} lô ${await lotLabel(line.lotId, session)} còn thiếu ${left.toFixed()} (đơn vị gốc)`);
  }
}

// ---- Editing and cancelling (stage 2) ----
const EDITABLE = ['PLANNED', 'ON_HOLD'];
const active = delivery => delivery.status !== 'CANCELLED';
const zero = () => exact('0');
const total = rows => rows.reduce((n, row) => n.plus(String(row.qtyBase)), zero());

// Give back `quantity` (default: everything still held) of a reservation.
async function release(reservationId, quantity, actor, session) {
  const reservation = reservationId && await m.StockReservation.findById(reservationId).session(session);
  if (!reservation) return;
  const open = remainingReservation(reservation), amount = quantity == null ? open : exact(quantity);
  if (amount.gt(open)) throw validationError('Bản ghi giữ hàng không đủ để nhả');
  if (!amount.gt(0)) return;
  reservation.releasedQty = exact(reservation.releasedQty).plus(amount).toFixed();
  reservation.updatedBy = actor._id;
  await reservation.save({ session });
}
const releaseAll = async (allocations, actor, session) => { for (const a of allocations) await release(a.reservationId, null, actor, session); };

// Keep the allocations of a line that are still usable (same warehouse and lot, stock GOOD,
// location not frozen) up to `wanted`; give back the rest of them.
async function keepAllocations(previous, wanted, warehouseId, lotId, actor, session) {
  let left = exact(wanted);
  const kept = [];
  for (const allocation of previous.allocations) {
    const context = await sourceContext(allocation.balanceId, session).catch(() => null);
    const usable = context && left.gt(0) && context.balance.qualityStatus === 'GOOD' && context.balance.ownerType === 'STORE' && same(context.balance.batchId, lotId)
      && context.location?.isActive && context.location.locationType === 'STORAGE' && context.location.isPickable && same(context.location.warehouseId, warehouseId)
      && !await m.StocktakeLocationLock.exists({ locationId: context.location._id, status: 'LOCKED' }).session(session);
    if (!usable) { await release(allocation.reservationId, null, actor, session); continue; }
    const quantity = exact(allocation.qtyBase), take = quantity.gt(left) ? left : quantity;
    if (take.lt(quantity)) await release(allocation.reservationId, quantity.minus(take), actor, session);
    kept.push({ ...allocation, qtyBase: take.toFixed() });
    left = left.minus(take);
  }
  return kept;
}
async function editableOrder(actor, id, session) {
  const order = await m.SalesOrder.findById(id).session(session);
  if (!order) throw notFoundError();
  if (!same(order.createdBy, actor._id)) throw forbiddenError('Chỉ người tạo SO được sửa hoặc hủy');
  if (order.workflowStatus !== 'OPEN') throw validationError('SO không còn mở');
  return order;
}
const orderSchedule = async (id, session) => {
  const schedule = await m.DeliverySchedule.findOne({ salesOrderId: id }).session(session);
  if (!schedule) throw validationError('SO cũ không có lịch giao, không xử lý theo luồng mới');
  return schedule;
};
export const settle = (order, deliveries) => {
  const live = deliveries.filter(active);
  order.workflowStatus = live.length && live.every(d => d.status === 'HANDED_OVER') ? 'COMPLETED' : 'OPEN';
};

export function updateSalesOrderSchedule(user, id, input) {
  return command(user, 'UPDATE_SALES_ORDER', 'sales_order:update', id, input, (id, actor, session) => orderSource(actor, id, session, { replay: true }), async (session, actor) => {
    const order = await editableOrder(actor, id, session);
    checkVersion(order, input.expectedVersion);
    const schedule = await orderSchedule(id, session);
    // 1. Header
    const header = input.header ?? {};
    if (header.customerId) {
      if (!await m.Customer.exists({ _id: header.customerId }).session(session)) throw validationError('Khách hàng không hợp lệ');
      order.header.customerId = header.customerId;
    }
    if (header.deliveryAddress) order.header.deliveryAddressSnapshot = header.deliveryAddress;
    if (header.recipientName) order.header.recipientName = header.recipientName;
    if (header.recipientPhone) order.header.recipientPhone = header.recipientPhone;
    if (header.note !== undefined) order.note = header.note;
    if (header.orderAmount !== undefined) order.orderAmount = header.orderAmount;
    // 2. Order lines: change, remove or add
    const keyed = new Map(order.items.map(item => [String(item._id), item]));
    const removed = new Set();
    let lineNo = Math.max(0, ...order.items.map(item => item.lineNo));
    for (const row of input.lines ?? []) {
      if (!row.lineId) {
        if (!row.clientLineKey || !row.productId || !row.lotId || !row.enteredUnit || !row.quantity) throw validationError('Dòng mới cần clientLineKey, sản phẩm, lô, đơn vị và số lượng');
        if (keyed.has(row.clientLineKey)) throw validationError('clientLineKey bị trùng');
        const item = await makeItem({ productId: row.productId, lotId: row.lotId, enteredUnit: row.enteredUnit, enteredQty: row.quantity }, ++lineNo, session, { lineKind: 'SALES_ORDER' });
        const price = row.unitSellingPrice == null ? {} : { unitSellingPrice: row.unitSellingPrice, lineAmount: exact(row.unitSellingPrice).mul(item.enteredQty).toFixed(), priceRevision: 1 };
        order.items.push({ ...item, ...price, details: {} });
        keyed.set(row.clientLineKey, order.items[order.items.length - 1]);
        continue;
      }
      const item = order.items.id(row.lineId);
      if (!item) throw validationError('Dòng SO không tồn tại');
      if (row.remove) { removed.add(String(item._id)); continue; }
      if (row.enteredUnit && !row.quantity) throw validationError('Đổi đơn vị phải kèm số lượng');
      if (row.quantity) {
        const made = await makeItem({ productId: item.productId, lotId: item.lotId, enteredUnit: row.enteredUnit ?? item.enteredUnit, enteredQty: row.quantity }, item.lineNo, session, { lineKind: 'SALES_ORDER', previous: item });
        item.set({ enteredUnit: made.enteredUnit, baseUnitSnapshot: made.baseUnitSnapshot, baseUnitsPerUnit: made.baseUnitsPerUnit, enteredQty: made.enteredQty, qtyBase: made.qtyBase, packagingSnapshot: made.packagingSnapshot });
      }
      if (row.unitSellingPrice !== undefined) {
        if (row.unitSellingPrice === null) item.set({ unitSellingPrice: undefined, lineAmount: undefined });
        else item.set({ unitSellingPrice: row.unitSellingPrice, priceRevision: (item.priceRevision ?? 0) + 1 });
      }
      if (item.unitSellingPrice != null) item.lineAmount = exact(item.unitSellingPrice).mul(String(item.enteredQty)).toFixed();
    }
    for (const key of removed) keyed.delete(key);
    const remaining = [...keyed.values()];
    if (!remaining.length) throw validationError('SO phải còn ít nhất một dòng');
    if (new Set(remaining.map(item => `${item.productId}:${item.lotId}`)).size !== remaining.length) throw validationError('Hai dòng không được trùng sản phẩm và lô');
    // 3. Which deliveries can still change
    const old = schedule.toObject().deliveries;
    const locked = old.filter(d => active(d) && !EDITABLE.includes(d.status));
    const editable = old.filter(d => EDITABLE.includes(d.status));
    if (editable.some(d => d.doId)) throw validationError('Lần giao có DO đang tạm dừng sẽ được hỗ trợ ở giai đoạn báo cáo vấn đề');
    const lockedQty = new Map();
    for (const d of locked) for (const l of d.lines) lockedQty.set(String(l.soLineId), (lockedQty.get(String(l.soLineId)) ?? zero()).plus(String(l.qtyBase)));
    for (const item of order.items) {
      const floor = lockedQty.get(String(item._id)) ?? zero();
      if (removed.has(String(item._id))) { if (floor.gt(0)) throw validationError(`Dòng ${item.lineNo}: đã có lần giao bị khóa, không xóa được`); continue; }
      if (exact(item.qtyBase).lt(floor)) throw validationError(`Dòng ${item.lineNo}: số lượng SO thấp hơn ${floor.toFixed()} đã nằm trong các lần giao bị khóa`);
    }
    // 4. Resolve the wanted deliveries
    const warehouses = new Map((await m.Warehouse.find({ _id: { $in: input.deliveries.map(d => d.warehouseId) }, isActive: true }).session(session).lean()).map(w => [String(w._id), w]));
    const wholeCache = new Map();
    const whole = async productId => { const k = String(productId); if (!wholeCache.has(k)) wholeCache.set(k, (await m.Product.findById(productId).select('wholeBaseUnits').session(session).lean())?.wholeBaseUnits); return wholeCache.get(k); };
    const ids = input.deliveries.map(d => d.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw validationError('Lần giao bị lặp');
    for (const did of ids) if (!editable.some(d => same(d._id, did))) throw validationError('Lần giao đã có DO, đã xong hoặc đã hủy, không sửa được');
    const today = vnDay();
    const sums = new Map(lockedQty);
    const wanted = [];
    for (const [index, d] of input.deliveries.entries()) {
      const previous = d.id ? editable.find(e => same(e._id, d.id)) : null;
      const day = vnDay(d.plannedOn);
      if ((!previous || vnDay(previous.plannedOn) !== day) && day < today) throw validationError(`Lần giao ${index + 1}: ngày giao không được sớm hơn hôm nay`);
      const warehouse = warehouses.get(String(d.warehouseId));
      if (!warehouse) throw validationError(`Lần giao ${index + 1}: kho không hoạt động`);
      if (new Set(d.lines.map(l => l.lineKey)).size !== d.lines.length) throw validationError(`Lần giao ${index + 1}: dòng bị lặp`);
      const lines = [];
      for (const l of d.lines) {
        const soLine = keyed.get(l.lineKey);
        if (!soLine) throw validationError(`Lần giao ${index + 1}: dòng ${l.lineKey} không có trong SO`);
        const qtyBase = exact(l.quantity).mul(String(soLine.baseUnitsPerUnit));
        if (!qtyBase.gt(0) || qtyBase.decimalPlaces() > 6 || (await whole(soLine.productId) && !qtyBase.isInteger())) throw validationError(`Lần giao ${index + 1}: số lượng không quy đổi chính xác sang đơn vị gốc`);
        sums.set(String(soLine._id), (sums.get(String(soLine._id)) ?? zero()).plus(qtyBase));
        lines.push({ soLine, qtyBase });
      }
      wanted.push({ previous, index, day, warehouseId: d.warehouseId, warehouse, lines });
    }
    for (const item of remaining) if (!(sums.get(String(item._id)) ?? zero()).eq(String(item.qtyBase))) throw validationError(`Dòng ${item.lineNo}: tổng các lần giao ${(sums.get(String(item._id)) ?? zero()).toFixed()} khác số lượng SO ${item.qtyBase} (đơn vị gốc)`);
    // 5. Give stock back first, then take what is missing
    for (const d of editable) if (!wanted.some(w => w.previous && same(w.previous._id, d._id))) for (const l of d.lines) await releaseAll(l.allocations, actor, session);
    let seq = Math.max(0, ...old.map(d => d.seq));
    wanted.sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
    const next = [];
    for (const w of wanted) {
      const delivery = { _id: w.previous?._id ?? newId(), seq: w.previous?.seq ?? ++seq, plannedOn: w.previous && vnDay(w.previous.plannedOn) === w.day ? w.previous.plannedOn : vnMidnight(w.day),
        warehouseId: w.warehouseId, status: w.previous?.status ?? 'PLANNED', warehouse: w.warehouse, lines: [] };
      const sameWarehouse = w.previous && same(w.previous.warehouseId, w.warehouseId);
      for (const l of w.lines) {
        const before = w.previous?.lines.find(x => same(x.soLineId, l.soLine._id));
        const allocations = before ? (sameWarehouse ? await keepAllocations(before, l.qtyBase, w.warehouseId, l.soLine.lotId, actor, session) : (await releaseAll(before.allocations, actor, session), [])) : [];
        delivery.lines.push({ _id: before?._id ?? newId(), soLineId: l.soLine._id, lotId: l.soLine.lotId, qtyBase: l.qtyBase.toFixed(), allocations, soLine: l.soLine });
      }
      for (const before of w.previous?.lines ?? []) if (!w.lines.some(l => same(l.soLine._id, before.soLineId))) await releaseAll(before.allocations, actor, session);
      next.push(delivery);
    }
    for (const delivery of next)
      for (const line of delivery.lines) {
        const missing = exact(line.qtyBase).minus(total(line.allocations));
        if (missing.gt(0)) await allocateAndReserve({ order, scheduleId: schedule._id, delivery, line, soLine: line.soLine, warehouse: delivery.warehouse, actor, session, quantity: missing.toFixed() });
      }
    for (const key of removed) order.items.pull(key);
    // 6. Save
    const cancelled = editable.filter(d => !wanted.some(w => w.previous && same(w.previous._id, d._id))).map(d => ({ ...d, status: 'CANCELLED', lines: d.lines.map(l => ({ ...l, allocations: [] })) }));
    const finalDeliveries = [...old.filter(d => !EDITABLE.includes(d.status)), ...cancelled, ...next.map(({ warehouse, lines, ...d }) => ({ ...d, lines: lines.map(({ soLine, ...l }) => l) }))].sort((a, b) => a.seq - b.seq);
    settle(order, finalDeliveries);
    order.updatedBy = actor._id;
    schedule.deliveries = finalDeliveries;
    schedule.updatedBy = actor._id;
    const saved = await saveVersion(order, input.expectedVersion, session);
    await saveVersion(schedule, schedule.version, session);
    return { document: saved, versionBefore: input.expectedVersion, resultRefs: [{ documentType: 'delivery_schedules', documentId: schedule._id }], reason: input.reason };
  });
}

export function cancelSalesOrder(user, id, input) {
  return command(user, 'CANCEL_SALES_ORDER', 'sales_order:cancel', id, input, (id, actor, session) => orderSource(actor, id, session, { replay: true }), async (session, actor) => {
    const order = await editableOrder(actor, id, session);
    checkVersion(order, input.expectedVersion);
    const schedule = await orderSchedule(id, session);
    const old = schedule.toObject().deliveries;
    if (old.some(d => ['ISSUED', 'HANDED_OVER'].includes(d.status))) throw validationError('Đã có lần giao xuất kho; hãy hủy phần còn lại bằng cách sửa lịch giao và giảm số lượng SO');
    const now = new Date();
    for (const d of old.filter(active)) {
      for (const l of d.lines) await releaseAll(l.allocations, actor, session);
      const doc = d.doId && await m.DeliveryOrder.findById(d.doId).session(session);
      if (doc && ['CREATED', 'ON_HOLD'].includes(doc.workflowStatus)) {
        doc.workflowStatus = 'CANCELLED'; doc.cancelledBy = actor._id; doc.cancelledAt = now; doc.cancelReason = input.reason;
        await saveVersion(doc, doc.version, session);
      }
    }
    schedule.deliveries = old.map(d => active(d) ? { ...d, status: 'CANCELLED', lines: d.lines.map(l => ({ ...l, allocations: [] })) } : d);
    schedule.updatedBy = actor._id;
    order.workflowStatus = 'CANCELLED'; order.cancelledBy = actor._id; order.cancelledAt = now; order.cancelReason = input.reason; order.updatedBy = actor._id;
    const saved = await saveVersion(order, input.expectedVersion, session);
    await saveVersion(schedule, schedule.version, session);
    return { document: saved, versionBefore: input.expectedVersion, resultRefs: [{ documentType: 'delivery_schedules', documentId: schedule._id }], reason: input.reason };
  });
}
