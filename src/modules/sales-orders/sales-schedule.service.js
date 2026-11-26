import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { command, checkVersion, saveVersion, same, newId, hash } from '../../shared/utils/document-command.js';
import { sourceLink } from '../../shared/utils/document-copy.js';
import { validationError, versionConflict, notFoundError, forbiddenError } from '../../shared/utils/ApiError.js';
import { vnDay, vnMidnight } from '../../shared/utils/vn-date.js';
import { toBaseQuantity } from '../../shared/utils/conversions.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { orderSource } from './sales-read.service.js';
import { guardLocations, fifoCandidates, remainingReservation, sourceContext } from '../../shared/utils/stock.js';
import { resolveActiveReservations, releaseReservationTree } from './reservation-tree.js';
import { createInAppNotification } from '../delivery-orders/delivery-notifications.js';
import { assertNoReferences, notifySalesShortage } from './sales-progress.service.js';

export const lotLabel = async (lotId, session) => (await m.ProductBatch.findById(lotId).select('manufacturerLot').session(session).lean())?.manufacturerLot ?? String(lotId);

// Split `quantity` of one lot in one warehouse over pick locations, oldest receipt first,
// and hold each part. Throws with the missing quantity when the warehouse cannot cover it.
// With allowShortfall the reservation takes what is free and reports the rest instead of failing, so a request can be recorded
// before stock exists and the shortage can drive a purchase order (26/11/2026).
export async function allocateAndReserve({ order, scheduleId, delivery, line, soLine, warehouse, actor, session, quantity = line.qtyBase, allowShortfall = false }) {
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
    if (allowShortfall) return { shortfall: left.toFixed(), message: `lần giao ${delivery.seq}, kho ${warehouse.code ?? warehouse.name}, ${product?.name ?? 'sản phẩm'} lô ${await lotLabel(line.lotId, session)} thiếu ${left.toFixed()} (đơn vị gốc)` };
    throw validationError(`Không đủ hàng khả dụng: lần giao ${delivery.seq}, kho ${warehouse.code ?? warehouse.name}, ${product?.name ?? 'sản phẩm'} lô ${await lotLabel(line.lotId, session)} còn thiếu ${left.toFixed()} (đơn vị gốc)`);
  }
}

// ---- Editing and cancelling (stage 2 + stage 4 ON_HOLD resolution) ----
const EDITABLE = ['PLANNED', 'ON_HOLD'];
const active = delivery => delivery.status !== 'CANCELLED';
const zero = () => exact('0');
const total = rows => rows.reduce((n, row) => n.plus(String(row.qtyBase)), zero());

async function releaseOne(reservation, amount, actor, session) {
  if (!amount.gt(0)) return;
  const res = await m.StockReservation.updateOne(
    { _id: reservation._id, version: reservation.version },
    { $set: { releasedQty: exact(reservation.releasedQty).plus(amount).toFixed(), updatedBy: actor._id }, $inc: { version: 1 } },
    { session },
  );
  if (res.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
}
const releaseAll = async (allocations, actor, session) => {
  for (const a of allocations) await releaseReservationTree(a.reservationId, null, actor, session);
};

// Keep the allocations of a line that are still usable (following any moved reservation chain
// in the same warehouse and lot, stock GOOD, location not frozen) up to `wanted`; give back the rest.
async function keepAllocations(previous, wanted, warehouseId, lotId, actor, session) {
  let left = exact(wanted);
  const kept = [];
  for (const allocation of previous.allocations) {
    const { active: activeRows } = await resolveActiveReservations(allocation.reservationId, session);
    for (const row of activeRows) {
      const open = remainingReservation(row);
      if (!open.gt(0)) continue;
      const context = await sourceContext(row.balanceId, session).catch(() => null);
      const physical = context ? exact(context.balance.quantityBase) : zero();
      const usable = context && left.gt(0) && physical.gt(0) && context.balance.qualityStatus === 'GOOD' && context.balance.ownerType === 'STORE'
        && same(context.balance.batchId, lotId) && context.location?.isActive && context.location.locationType === 'STORAGE' && context.location.isPickable
        && same(context.location.warehouseId, warehouseId) && !await m.StocktakeLocationLock.exists({ locationId: context.location._id, status: 'LOCKED' }).session(session);
      if (!usable) {
        await releaseOne(row, open, actor, session);
        continue;
      }
      const cap = open.lt(physical) ? open : physical;
      const take = cap.lt(left) ? cap : left;
      const giveBack = open.minus(take);
      if (giveBack.gt(0)) await releaseOne(row, giveBack, actor, session);
      if (take.gt(0)) {
        kept.push({
          _id: same(row._id, allocation.reservationId) ? allocation._id : newId(),
          balanceId: row.balanceId,
          locationId: context.location._id,
          qtyBase: take.toFixed(),
          reservationId: row._id,
        });
        left = left.minus(take);
      }
    }
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

function closeOpenIssueReports(doDoc, actorId, now) {
  for (const report of doDoc.issueReports ?? []) {
    if (report.status === 'OPEN') {
      report.status = 'CLOSED';
      report.closedBy = actorId;
      report.closedAt = now;
    }
  }
}

export function updateSalesOrderSchedule(user, id, input) {
  return command(user, 'UPDATE_SALES_ORDER', 'sales_order:update', id, input, (id, actor, session) => orderSource(actor, id, session, { replay: true }), async (session, actor) => {
    const order = await editableOrder(actor, id, session);
    checkVersion(order, input.expectedVersion);
    // 26/11/2026: a request can be edited only while no goods issue, delivery order or issue request references it.
    await assertNoReferences(order, session);
    const schedule = await orderSchedule(id, session);
    // 1. Header
    const header = input.header ?? {};
    if (header.customerName !== undefined) order.header.customerName = header.customerName;
    if (header.customerPhone !== undefined) order.header.customerPhone = header.customerPhone;
    if (header.deliveryAddress) order.header.deliveryAddressSnapshot = header.deliveryAddress;
    if (header.recipientName) order.header.recipientName = header.recipientName;
    if (header.recipientPhone) order.header.recipientPhone = header.recipientPhone;
    if (header.note !== undefined) order.note = header.note;
    // 2. Order lines: change, remove or add
    const keyed = new Map(order.items.map(item => [String(item._id), item]));
    const removed = new Set();
    let lineNo = Math.max(0, ...order.items.map(item => item.lineNo));
    for (const row of input.lines ?? []) {
      if (!row.lineId) {
        if (!row.clientLineKey || !row.productId || !row.lotId || !row.enteredUnit || !row.quantity || row.unitSellingPrice == null) throw validationError('Dòng mới cần mã dòng, sản phẩm, lô, đơn vị, số lượng và đơn giá');
        if (keyed.has(row.clientLineKey)) throw validationError('clientLineKey bị trùng');
        const item = await makeItem({ productId: row.productId, lotId: row.lotId, enteredUnit: row.enteredUnit, enteredQty: row.quantity }, ++lineNo, session, { lineKind: 'SALES_ORDER' });
        const price = { unitSellingPrice: row.unitSellingPrice, lineAmount: exact(row.unitSellingPrice).mul(item.enteredQty).toFixed(), priceRevision: 1 };
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
      if (row.unitSellingPrice !== undefined) item.set({ unitSellingPrice: row.unitSellingPrice, priceRevision: (item.priceRevision ?? 0) + 1 });
      if (item.unitSellingPrice != null) item.lineAmount = exact(item.unitSellingPrice).mul(String(item.enteredQty)).toFixed();
    }
    for (const key of removed) keyed.delete(key);
    const remaining = [...keyed.values()];
    if (!remaining.length) throw validationError('SO phải còn ít nhất một dòng');
    order.orderAmount = remaining.reduce((sum, item) => sum.plus(String(item.lineAmount)), zero()).toFixed();
    if (new Set(remaining.map(item => `${item.productId}:${item.lotId}`)).size !== remaining.length) throw validationError('Hai dòng không được trùng sản phẩm và lô');
    // 3. Which deliveries can still change
    const old = schedule.toObject().deliveries;
    const locked = old.filter(d => active(d) && !EDITABLE.includes(d.status));
    const editable = old.filter(d => EDITABLE.includes(d.status));
    const lockedQty = new Map();
    for (const d of locked) for (const l of d.lines) lockedQty.set(String(l.soLineId), (lockedQty.get(String(l.soLineId)) ?? zero()).plus(String(l.qtyBase)));
    for (const item of order.items) {
      const floor = lockedQty.get(String(item._id)) ?? zero();
      if (removed.has(String(item._id))) { if (floor.gt(0)) throw validationError(`Dòng ${item.lineNo}: đã có lần giao bị khóa, không xóa được`); continue; }
      if (exact(item.qtyBase).lt(floor)) throw validationError(`Dòng ${item.lineNo}: số lượng SO thấp hơn ${floor.toFixed()} đã nằm trong các lần giao bị khóa`);
    }
    // 4. Resolve the wanted deliveries
    const warehouses = new Map((await m.Warehouse.find({ _id: { $in: input.deliveries.map(d => d.warehouseId) }, isActive: true }).session(session).lean()).map(w => [String(w._id), w]));
    const products = new Map((await m.Product.find({ _id: { $in: remaining.map(item => item.productId) } }).select('wholeBaseUnits').session(session).lean()).map(product => [String(product._id), product]));
    const uoms = new Map((await m.Uom.find({ code: { $in: remaining.map(item => item.enteredUnit) } }).session(session).lean()).map(uom => [uom.code, uom]));
    const ids = input.deliveries.map(d => d.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw validationError('Lần giao bị lặp');
    for (const did of ids) if (!editable.some(d => same(d._id, did))) throw validationError('Lần giao đã có DO đang chạy, đã xong hoặc đã hủy, không sửa được');
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
        const product = products.get(String(soLine.productId));
        if (!product) throw validationError(`Dòng ${soLine.lineNo}: không tìm thấy sản phẩm`);
        const qtyBase = toBaseQuantity(l.quantity, String(soLine.baseUnitsPerUnit), product, uoms.get(soLine.enteredUnit));
        if (!qtyBase.gt(0) || qtyBase.decimalPlaces() > 6 || (product.wholeBaseUnits && !qtyBase.isInteger())) throw validationError(`Lần giao ${index + 1}: số lượng không quy đổi chính xác sang đơn vị gốc`);
        sums.set(String(soLine._id), (sums.get(String(soLine._id)) ?? zero()).plus(qtyBase));
        lines.push({ soLine, qtyBase });
      }
      wanted.push({ previous, index, day, warehouseId: d.warehouseId, warehouse, lines });
    }
    for (const item of remaining) if (!(sums.get(String(item._id)) ?? zero()).eq(String(item.qtyBase))) throw validationError(`Dòng ${item.lineNo}: tổng các lần giao ${(sums.get(String(item._id)) ?? zero()).toFixed()} khác số lượng SO ${item.qtyBase} (đơn vị gốc)`);

    const now = new Date();
    const touchedDoRefs = [];

    // 5. Give stock back first (including cancelled ON_HOLD DOs), then take what is missing
    for (const d of editable) {
      if (!wanted.some(w => w.previous && same(w.previous._id, d._id))) {
        for (const l of d.lines) await releaseAll(l.allocations, actor, session);
        if (d.doId) {
          const doDoc = await m.DeliveryOrder.findById(d.doId).session(session);
          if (doDoc && ['CREATED', 'ON_HOLD'].includes(doDoc.workflowStatus)) {
            closeOpenIssueReports(doDoc, actor._id, now);
            doDoc.workflowStatus = 'CANCELLED';
            doDoc.cancelledBy = actor._id;
            doDoc.cancelledAt = now;
            doDoc.cancelReason = input.reason;
            doDoc.updatedBy = actor._id;
            const savedDo = await saveVersion(doDoc, doDoc.version, session);
            touchedDoRefs.push({ documentType: 'delivery_orders', documentId: savedDo._id });
          }
        }
      }
    }

    let seq = Math.max(0, ...old.map(d => d.seq));
    wanted.sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
    const next = [];
    for (const w of wanted) {
      const hasOnHoldDo = w.previous?.status === 'ON_HOLD' && Boolean(w.previous.doId);
      const delivery = {
        _id: w.previous?._id ?? newId(),
        seq: w.previous?.seq ?? ++seq,
        plannedOn: w.previous && vnDay(w.previous.plannedOn) === w.day ? w.previous.plannedOn : vnMidnight(w.day),
        warehouseId: w.warehouseId,
        status: hasOnHoldDo ? 'DO_CREATED' : (w.previous?.status ?? 'PLANNED'),
        ...(w.previous?.doId && { doId: w.previous.doId }),
        warehouse: w.warehouse,
        lines: [],
      };
      const sameWarehouse = w.previous && same(w.previous.warehouseId, w.warehouseId);
      for (const l of w.lines) {
        const before = w.previous?.lines.find(x => same(x.soLineId, l.soLine._id));
        const allocations = before ? (sameWarehouse ? await keepAllocations(before, l.qtyBase, w.warehouseId, l.soLine.lotId, actor, session) : (await releaseAll(before.allocations, actor, session), [])) : [];
        delivery.lines.push({ _id: before?._id ?? newId(), soLineId: l.soLine._id, lotId: l.soLine.lotId, qtyBase: l.qtyBase.toFixed(), allocations, soLine: l.soLine });
      }
      for (const before of w.previous?.lines ?? []) if (!w.lines.some(l => same(l.soLine._id, before.soLineId))) await releaseAll(before.allocations, actor, session);
      next.push(delivery);
    }
    const shortages = [];
    for (const delivery of next) {
      for (const line of delivery.lines) {
        const missing = exact(line.qtyBase).minus(total(line.allocations));
        if (missing.gt(0)) {
          const result = await allocateAndReserve({ order, scheduleId: schedule._id, delivery, line, soLine: line.soLine, warehouse: delivery.warehouse, actor, session, quantity: missing.toFixed(), allowShortfall: true });
          if (result?.shortfall) shortages.push(result.message);
        }
      }
      // Resume ON_HOLD DO in-place (keep same _id & documentNo, rebuild pick lines, close OPEN reports, notify warehouse)
      if (delivery.doId) {
        const doDoc = await m.DeliveryOrder.findById(delivery.doId).session(session);
        if (!doDoc || !['ON_HOLD', 'CREATED'].includes(doDoc.workflowStatus)) {
          throw validationError('DO của lần giao không ở trạng thái có thể cập nhật');
        }
        const rebuiltItems = [];
        for (const line of delivery.lines) {
          for (const allocation of line.allocations) {
            rebuiltItems.push({
              _id: newId(),
              lineNo: rebuiltItems.length + 1,
              lineKind: 'OUTBOUND_DELIVERY',
              productId: line.soLine.productId,
              lotId: line.lotId,
              enteredUnit: line.soLine.baseUnitSnapshot,
              baseUnitSnapshot: line.soLine.baseUnitSnapshot,
              baseUnitsPerUnit: '1',
              enteredQty: String(allocation.qtyBase),
              qtyBase: String(allocation.qtyBase),
              productNameSnapshot: line.soLine.productNameSnapshot,
              packagingSnapshot: line.soLine.packagingSnapshot?.toObject?.() ?? line.soLine.packagingSnapshot,
              sources: [sourceLink(order, line.soLine, allocation.qtyBase)],
              details: {
                soLineId: line.soLine._id,
                locationId: allocation.locationId,
                balanceId: allocation.balanceId,
                allocationId: allocation._id,
                reservationId: allocation.reservationId,
              },
            });
          }
        }
        doDoc.items = rebuiltItems;
        doDoc.workflowStatus = 'CREATED';
        doDoc.header.warehouseId = delivery.warehouseId;
        doDoc.header.plannedOn = delivery.plannedOn;
        doDoc.header.recipientName = order.header.recipientName;
        doDoc.header.recipientPhone = order.header.recipientPhone;
        doDoc.header.deliveryAddress = order.header.deliveryAddressSnapshot;
        closeOpenIssueReports(doDoc, actor._id, now);
        doDoc.updatedBy = actor._id;
        const savedDo = await saveVersion(doDoc, doDoc.version, session);
        touchedDoRefs.push({ documentType: 'delivery_orders', documentId: savedDo._id });

        const whRole = await m.Role.findOne({ code: 'WAREHOUSE', isActive: true }).select('_id').session(session).lean();
        const whUsers = whRole
          ? await m.User.find({ isActive: true, roleId: whRole._id, warehouseIds: delivery.warehouseId }).select('_id').session(session).lean()
          : [];
        for (const whUser of whUsers) {
          await createInAppNotification({
            recipientId: whUser._id,
            type: 'DELIVERY_ORDER_RESUMED',
            eventKey: `DELIVERY_ORDER_RESUMED:${savedDo._id}`,
            dedupKey: `DELIVERY_ORDER_RESUMED:${savedDo._id}:${savedDo.version}:${whUser._id}`,
            sourceType: 'delivery_orders',
            sourceId: savedDo._id,
            sourceVersion: savedDo.version,
            warehouseIds: [delivery.warehouseId],
            title: `Lệnh giao hàng ${savedDo.documentNo} đã sẵn sàng trở lại`,
            message: `Sales đã xử lý xong DO ${savedDo.documentNo} (đơn ${order.documentNo}, lần giao ${delivery.seq}). Kho có thể tiếp tục lấy và xuất hàng.`,
            session,
          });
        }
      }
    }
    for (const key of removed) order.items.pull(key);
    // 6. Save
    const cancelled = editable.filter(d => !wanted.some(w => w.previous && same(w.previous._id, d._id))).map(d => ({ ...d, status: 'CANCELLED', lines: d.lines.map(l => ({ ...l, allocations: [] })) }));
    const finalDeliveries = [...old.filter(d => !EDITABLE.includes(d.status)), ...cancelled, ...next.map(({ warehouse, lines, ...d }) => ({ ...d, lines: lines.map(({ soLine, ...l }) => l) }))].sort((a, b) => a.seq - b.seq);
    settle(order, finalDeliveries);
    order.updatedBy = actor._id;
    // The shortage note always reflects the latest plan.
    if (shortages.length) order.note = `Chưa đủ hàng khả dụng, cần bổ sung hàng: ${shortages.join('; ')}`.slice(0, 2000);
    else if (/^Chưa đủ hàng khả dụng/.test(order.note ?? '')) order.note = undefined;
    schedule.deliveries = finalDeliveries;
    schedule.updatedBy = actor._id;
    const saved = await saveVersion(order, input.expectedVersion, session);
    await saveVersion(schedule, schedule.version, session);
    await notifySalesShortage(saved, shortages, session);
    return {
      document: saved,
      versionBefore: input.expectedVersion,
      resultRefs: [{ documentType: 'delivery_schedules', documentId: schedule._id }, ...touchedDoRefs],
      reason: input.reason,
    };
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
        closeOpenIssueReports(doc, actor._id, now);
        doc.workflowStatus = 'CANCELLED'; doc.cancelledBy = actor._id; doc.cancelledAt = now; doc.cancelReason = input.reason; doc.updatedBy = actor._id;
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