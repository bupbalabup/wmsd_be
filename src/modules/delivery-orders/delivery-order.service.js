import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { command, checkVersion, saveVersion, same, newId, hash } from '../../shared/utils/document-command.js';
import { sourceLink } from '../../shared/utils/document-copy.js';
import { dto, page, transaction } from '../../shared/utils/persistence.js';
import { requirePermission, requireWarehouseAccess } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { validationError, notFoundError } from '../../shared/utils/ApiError.js';
import { vnDay, vnMidnight } from '../../shared/utils/vn-date.js';
import { beginStock, sourceContext, freeQuantity, remainingReservation } from '../../shared/utils/stock.js';
import { escapeRegex } from '../../shared/utils/domain.js';
import { settle } from '../sales-orders/sales-schedule.service.js';
import { syncAllocationChain } from '../sales-orders/reservation-tree.js';
import { takeForDelivery, deductForIssueReport, reserveReplacementPick } from './delivery-stock.js';
import { createInAppNotification } from './delivery-notifications.js';

// Warehouse staff may create a delivery order from two days before the planned day (Vietnam time).
export const WINDOW_DAYS = 2;
export const createFromDay = plannedOn => vnDay(new Date(vnMidnight(vnDay(plannedOn)).getTime() - WINDOW_DAYS * 864e5));
const scheduleRef = schedule => [{ documentType: 'delivery_schedules', documentId: schedule._id }];
const unrestricted = user => ['OWNER', 'ACCOUNTANT', 'SALES', 'ADMIN'].includes(currentRole(user)?.code);
const isSales = user => currentRole(user)?.code === 'SALES';
const allocFail = message => Object.assign(validationError(message), { allocationFailure: true });

async function authorizeDo(id, actor, session) {
  const delivery = await m.DeliveryOrder.findById(id).session(session);
  if (!delivery) throw notFoundError();
  requireWarehouseAccess(actor, delivery.header.warehouseId);
}
async function loadDeliveryOrder(id, actor, session) {
  const doc = await m.DeliveryOrder.findById(id).session(session);
  if (!doc || !doc.header.scheduleId) throw notFoundError();
  requireWarehouseAccess(actor, doc.header.warehouseId);
  const schedule = await m.DeliverySchedule.findById(doc.header.scheduleId).session(session);
  const delivery = schedule?.deliveries.id(doc.header.deliveryId);
  if (!delivery || !same(delivery.doId, doc._id)) throw validationError('Lần giao không khớp với DO');
  return { doc, schedule, delivery };
}

// An allocation made at schedule time may be stale by the day the delivery order is created.
async function checkAllocation(delivery, line, allocation, session) {
  const hint = 'nhờ sales sửa lịch giao và bấm "thử giữ lại hàng"';
  const ctx = await sourceContext(allocation.balanceId, session).catch(() => null);
  const where = ctx?.location?.code ?? String(allocation.locationId);
  const prefix = `Lần giao ${delivery.seq}: vị trí ${where}`;
  if (!ctx || !ctx.location || !ctx.location.isActive || ctx.location.locationType !== 'STORAGE' || !ctx.location.isPickable || !same(ctx.location.warehouseId, delivery.warehouseId)
    || ctx.balance.qualityStatus !== 'GOOD' || ctx.balance.ownerType !== 'STORE' || !same(ctx.balance.batchId, line.lotId))
    throw allocFail(`${prefix} không còn hợp lệ; ${hint}`);
  if (await m.StocktakeLocationLock.exists({ locationId: ctx.location._id, status: 'LOCKED' }).session(session)) throw allocFail(`${prefix} đang khóa kiểm kê; ${hint}`);
  const reservation = allocation.reservationId && await m.StockReservation.findById(allocation.reservationId).session(session);
  if (!reservation || remainingReservation(reservation).lt(exact(allocation.qtyBase)) || exact(ctx.balance.quantityBase).lt(exact(allocation.qtyBase)))
    throw allocFail(`${prefix} không còn đủ hàng; ${hint}`);
}

export async function createDeliveryOrder(user, input) {
  try {
    return await command(user, 'CREATE_DELIVERY_ORDER', 'delivery_order:create', input.scheduleId, input, authorizeDo, async (session, actor) => {
    const schedule = await m.DeliverySchedule.findById(input.scheduleId).session(session);
    if (!schedule) throw notFoundError();
    checkVersion(schedule, input.expectedVersion);
    const delivery = schedule.deliveries.id(input.deliveryId);
    if (!delivery) throw notFoundError();
    requireWarehouseAccess(actor, delivery.warehouseId);
    if (delivery.status !== 'PLANNED') throw validationError('Lần giao không ở trạng thái Chưa tạo DO');
    const from = createFromDay(delivery.plannedOn);
    if (vnDay() < from) throw validationError(`Chỉ được tạo DO từ ngày ${from} (trước ngày giao tối đa ${WINDOW_DAYS} ngày)`);
    const order = await m.SalesOrder.findById(schedule.salesOrderId).session(session);
    if (!order || order.workflowStatus !== 'OPEN') throw validationError('SO không còn mở');
    const doc = new m.DeliveryOrder({ ...await nextDocumentFields(m.DeliveryOrder, 'OD', delivery.warehouseId, session), workflowStatus: 'CREATED', version: 1, createdBy: actor._id,
      header: { warehouseId: delivery.warehouseId, salesOrderId: order._id, scheduleId: schedule._id, deliveryId: delivery._id, plannedOn: delivery.plannedOn,
        recipientName: order.header.recipientName, recipientPhone: order.header.recipientPhone, deliveryAddress: order.header.deliveryAddressSnapshot }, items: [] });
    for (const line of delivery.lines) {
      const soLine = order.items.id(line.soLineId);
      if (!soLine) throw validationError('Dòng SO của lần giao không còn tồn tại');
      // Phương án A: follow any moved reservation chain before checking/creating DO.
      const synced = [];
      let changed = false;
      for (const allocation of line.allocations) {
        const res = await syncAllocationChain(allocation.toObject ? allocation.toObject() : allocation, session);
        if (res.changed) changed = true;
        synced.push(...res.allocations);
      }
      if (changed) line.allocations = synced;
      let allocated = exact('0');
      for (const allocation of line.allocations) {
        await checkAllocation(delivery, line, allocation, session);
        allocated = allocated.plus(exact(allocation.qtyBase));
        // Pick lines are kept in base units so any allocation split is exact.
        doc.items.push({ _id: newId(), lineNo: doc.items.length + 1, lineKind: 'OUTBOUND_DELIVERY', productId: soLine.productId, lotId: line.lotId,
          enteredUnit: soLine.baseUnitSnapshot, baseUnitSnapshot: soLine.baseUnitSnapshot, baseUnitsPerUnit: '1', enteredQty: String(allocation.qtyBase), qtyBase: String(allocation.qtyBase),
          productNameSnapshot: soLine.productNameSnapshot, packagingSnapshot: soLine.packagingSnapshot?.toObject?.() ?? soLine.packagingSnapshot,
          sources: [sourceLink(order, soLine, allocation.qtyBase)],
          details: { soLineId: soLine._id, locationId: allocation.locationId, balanceId: allocation.balanceId, allocationId: allocation._id, reservationId: allocation.reservationId } });
      }
      if (!allocated.eq(exact(line.qtyBase))) throw allocFail(`Lần giao ${delivery.seq}: số lượng phân bổ khác số lượng lần giao; ${'nhờ sales sửa lịch giao'}`);
    }
    delivery.status = 'DO_CREATED';
    delivery.doId = doc._id;
    schedule.updatedBy = actor._id;
    await doc.save({ session });
    await saveVersion(schedule, schedule.version, session);
    return { document: doc, versionBefore: 0, resultRefs: scheduleRef(schedule) };
    });
  } catch (err) {
    if (err?.allocationFailure) {
      try {
        const schedule = await m.DeliverySchedule.findById(input.scheduleId).lean();
        const delivery = schedule?.deliveries?.find(d => same(d._id, input.deliveryId));
        const order = schedule && await m.SalesOrder.findById(schedule.salesOrderId).select('createdBy documentNo').lean();
        if (schedule && delivery && order?.createdBy) {
          await createInAppNotification({
            recipientId: order.createdBy,
            type: 'DELIVERY_ALLOCATION_INVALID',
            eventKey: `DELIVERY_ALLOCATION_INVALID:${schedule._id}:${delivery._id}`,
            dedupKey: `DELIVERY_ALLOCATION_INVALID:${schedule._id}:${delivery._id}:${schedule.version}:${hash(err.message).slice(0, 12)}`,
            sourceType: 'delivery_schedules',
            sourceId: schedule._id,
            sourceVersion: schedule.version,
            warehouseIds: [delivery.warehouseId],
            title: `Lần giao ${delivery.seq} (${order.documentNo}) chưa tạo được DO`,
            message: err.message,
          });
        }
      } catch { /* notification is best-effort after aborted tx */ }
    }
    throw err;
  }
}

export function confirmIssue(user, id, input) {
  return command(user, 'CONFIRM_DELIVERY_ISSUE', 'delivery_order:confirm_issue', id, input, authorizeDo, async (session, actor) => {
    const { doc, schedule, delivery } = await loadDeliveryOrder(id, actor, session);
    checkVersion(doc, input.expectedVersion);
    if (doc.workflowStatus !== 'CREATED' || delivery.status !== 'DO_CREATED') throw validationError('DO không ở trạng thái Đã tạo');
    const posting = beginStock(doc, actor, 'SALES_ISSUE', input);
    for (const item of doc.items) await takeForDelivery(item, posting, actor, session);
    await posting.save({ session });
    doc.workflowStatus = 'ISSUED';
    doc.header.issuedBy = actor._id;
    doc.header.issuedAt = new Date();
    doc.stockTransactionId = posting._id;
    doc.updatedBy = actor._id;
    delivery.status = 'ISSUED';
    schedule.updatedBy = actor._id;
    const saved = await saveVersion(doc, input.expectedVersion, session);
    await saveVersion(schedule, schedule.version, session);
    return { document: saved, versionBefore: input.expectedVersion, stockTransactionId: posting._id, resultRefs: scheduleRef(schedule) };
  });
}

export function confirmHandover(user, id, input) {
  return command(user, 'CONFIRM_DELIVERY_HANDOVER', 'delivery_order:confirm_handover', id, input, authorizeDo, async (session, actor) => {
    const { doc, schedule, delivery } = await loadDeliveryOrder(id, actor, session);
    checkVersion(doc, input.expectedVersion);
    if (doc.workflowStatus !== 'ISSUED' || delivery.status !== 'ISSUED') throw validationError('DO chưa xác nhận hàng ra khỏi kho');
    doc.workflowStatus = 'HANDED_OVER';
    doc.header.handedOverBy = actor._id;
    doc.header.handedOverAt = new Date();
    doc.updatedBy = actor._id;
    delivery.status = 'HANDED_OVER';
    schedule.updatedBy = actor._id;
    const order = await m.SalesOrder.findById(schedule.salesOrderId).session(session);
    const before = order.workflowStatus;
    settle(order, schedule.deliveries);
    if (order.workflowStatus !== before) { order.updatedBy = actor._id; await saveVersion(order, order.version, session); }
    const saved = await saveVersion(doc, input.expectedVersion, session);
    await saveVersion(schedule, schedule.version, session);
    return { document: saved, versionBefore: input.expectedVersion, resultRefs: scheduleRef(schedule) };
  });
}


// ---- Phase 4: Issue Reporting & Alternatives ----
export async function getIssueAlternatives(user, id, lineId, query) {
  requirePermission(user, 'delivery_order:report_issue');
  return transaction(async session => {
    const doc = await m.DeliveryOrder.findById(id).session(session);
    if (!doc || !doc.header.scheduleId) throw notFoundError();
    requireWarehouseAccess(user, doc.header.warehouseId);
    if (doc.workflowStatus !== 'CREATED') throw validationError('Chỉ xem vị trí thay thế khi DO ở trạng thái Đã tạo');
    const item = doc.items.id(lineId);
    if (!item) throw notFoundError('Không tìm thấy dòng lấy hàng trên DO');
    const product = await m.Product.findById(item.productId).select('wholeBaseUnits').session(session).lean();
    const targetShortQty = query.shortQty ? exact(query.shortQty) : exact(item.qtyBase);
    if (!targetShortQty.gt(0) || targetShortQty.gt(exact(item.qtyBase))) {
      throw validationError('Số lượng thiếu/hỏng vượt quá số lượng dòng lấy hàng');
    }
    if (product?.wholeBaseUnits && !targetShortQty.isInteger()) {
      throw validationError('Số lượng thiếu/hỏng không đúng đơn vị gốc');
    }
    const frozen = await m.StocktakeLocationLock.find({ status: 'LOCKED' }).session(session).distinct('locationId');
    const locations = await m.WarehouseLocation.find({
      warehouseId: doc.header.warehouseId, _id: { $nin: frozen }, isActive: true, locationType: 'STORAGE', isPickable: true,
    }).session(session).lean();
    const points = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locations.map(l => l._id) } }).session(session).lean();
    const balances = await m.InventoryBalance.find({
      holdingPointId: { $in: points.map(p => p._id) }, _id: { $ne: item.details.balanceId }, batchId: item.lotId,
      ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: { $gt: 0 },
    }).session(session).lean();
    const receipts = balances.length
      ? await m.StockTransaction.aggregate([
          { $unwind: '$movements' },
          { $match: { 'movements.toBalanceId': { $in: balances.map(b => b._id) } } },
          { $group: { _id: '$movements.toBalanceId', firstReceivedAt: { $min: '$occurredAt' } } },
        ]).session(session)
      : [];
    const allReservations = balances.length
      ? await m.StockReservation.find({ balanceId: { $in: balances.map(b => b._id) } }).session(session).lean()
      : [];
    const activeByBalance = new Map();
    const soIds = new Set();
    for (const r of allReservations) {
      const rem = remainingReservation(r);
      if (!rem.gt(0)) continue;
      const k = String(r.balanceId);
      (activeByBalance.get(k) ?? activeByBalance.set(k, []).get(k)).push({ row: r, rem });
      if (r.demandRef?.documentType === 'sales_orders' && r.demandRef.documentId) soIds.add(String(r.demandRef.documentId));
    }
    const salesOrders = soIds.size ? await m.SalesOrder.find({ _id: { $in: [...soIds] } }).select('documentNo').session(session).lean() : [];
    const soNoById = new Map(salesOrders.map(o => [String(o._id), o.documentNo]));
    const sorted = balances.map(b => {
      const pt = points.find(p => same(p._id, b.holdingPointId));
      const loc = locations.find(l => same(l._id, pt?.locationId));
      const firstReceivedAt = receipts.find(r => same(r._id, b._id))?.firstReceivedAt ?? null;
      return { balance: b, location: loc, firstReceivedAt };
    }).filter(x => x.location).sort((a, b) =>
      (a.firstReceivedAt ? +new Date(a.firstReceivedAt) : Infinity) - (b.firstReceivedAt ? +new Date(b.firstReceivedAt) : Infinity)
      || String(a.balance._id).localeCompare(String(b.balance._id)),
    );
    const selectable = [];
    const held = [];
    let totalAvail = exact('0');
    for (const { balance, location, firstReceivedAt } of sorted) {
      const free = await freeQuantity(balance, session);
      if (free.gt(0)) {
        totalAvail = totalAvail.plus(free);
        selectable.push({
          balanceId: String(balance._id), locationId: String(location._id),
          locationCode: location.code, locationName: location.name,
          availableQtyBase: free.toFixed(),
          firstReceivedAt: firstReceivedAt ? new Date(firstReceivedAt).toISOString() : null,
        });
      }
      const holds = activeByBalance.get(String(balance._id)) ?? [];
      if (holds.length) {
        const totalHeld = holds.reduce((n, h) => n.plus(h.rem), exact('0'));
        const grouped = new Map();
        for (const { row, rem } of holds) {
          const docType = row.demandRef?.documentType ?? 'OTHER';
          const docId = row.demandRef?.documentId ? String(row.demandRef.documentId) : '';
          const k = `${docType}:${docId}`;
          const prev = grouped.get(k) ?? {
            documentType: docType,
            salesOrderId: docType === 'sales_orders' ? docId : null,
            soDocumentNo: docType === 'sales_orders' ? (soNoById.get(docId) ?? docId) : null,
            documentId: docId || null,
            qtyBase: exact('0'),
          };
          prev.qtyBase = prev.qtyBase.plus(rem);
          grouped.set(k, prev);
        }
        held.push({
          balanceId: String(balance._id), locationId: String(location._id),
          locationCode: location.code, locationName: location.name,
          heldQtyBase: totalHeld.toFixed(),
          orders: [...grouped.values()].map(o => ({ ...o, qtyBase: o.qtyBase.toFixed() })),
        });
      }
    }
    return {
      deliveryOrderId: String(doc._id), lineId: String(item._id), lotId: String(item.lotId),
      requestedShortQtyBase: targetShortQty.toFixed(), totalAvailableQtyBase: totalAvail.toFixed(),
      canCover: totalAvail.gte(targetShortQty), selectable, held,
    };
  });
}

export function reportIssue(user, id, input) {
  return command(user, 'REPORT_DELIVERY_ISSUE', 'delivery_order:report_issue', id, input, authorizeDo, async (session, actor) => {
    const { doc, schedule, delivery } = await loadDeliveryOrder(id, actor, session);
    checkVersion(doc, input.expectedVersion);
    if (doc.workflowStatus !== 'CREATED' || delivery.status !== 'DO_CREATED') throw validationError('DO không ở trạng thái Đã tạo');
    const item = doc.items.id(input.lineId);
    if (!item) throw notFoundError('Không tìm thấy dòng lấy hàng trên DO');
    const scheduleLine = delivery.lines.find(l => same(l.soLineId, item.details.soLineId) && same(l.lotId, item.lotId));
    const allocation = scheduleLine && (scheduleLine.allocations.id(item.details.allocationId) || scheduleLine.allocations.find(a => same(a.reservationId, item.details.reservationId)));
    if (!scheduleLine || !allocation) throw validationError('Không tìm thấy phân bổ tương ứng trên lịch giao');
    const order = await m.SalesOrder.findById(schedule.salesOrderId).session(session);
    const soLine = order?.items.id(item.details.soLineId);
    if (!order || !soLine) throw validationError('Đơn bán hàng hoặc dòng SO không còn tồn tại');
    const shortQty = exact(input.shortQty), itemQty = exact(item.qtyBase);
    if (!shortQty.gt(0) || shortQty.gt(itemQty)) throw validationError('Số lượng thiếu/hỏng không được vượt quá số lượng dòng');
    if (input.picks.some(p => same(p.balanceId, item.details.balanceId))) {
      throw validationError('Không được chọn chính vị trí đang báo cáo thiếu/hỏng để lấy bù');
    }
    const picksSum = input.picks.reduce((n, p) => n.plus(exact(p.qty)), exact('0'));
    if (input.picks.length > 0 && !picksSum.eq(shortQty)) {
      throw validationError('Tổng số lượng lấy bù phải bằng đúng số lượng thiếu/hỏng, hoặc không chọn vị trí nào để tạm dừng DO');
    }
    const posting = beginStock(doc, actor, 'DELIVERY_ISSUE_REPORT', input);
    const { adjustment } = await deductForIssueReport({ item, shortQty, kind: input.kind, reason: input.reason, doc, posting, actor, session });
    await posting.save({ session });
    const originalLineId = item._id, originalLocationId = item.details.locationId, originalBalanceId = item.details.balanceId, lotId = item.lotId;
    const remainOnLine = itemQty.minus(shortQty);
    if (remainOnLine.gt(0)) {
      item.enteredQty = remainOnLine.toFixed();
      item.qtyBase = remainOnLine.toFixed();
      if (item.sources?.[0]) item.sources[0].linkedQty = remainOnLine.toFixed();
      allocation.qtyBase = remainOnLine.toFixed();
    } else {
      doc.items.pull(item._id);
      scheduleLine.allocations.pull(allocation._id);
    }
    const reportId = newId(), now = new Date(), reportPicks = [];
    if (input.picks.length > 0) {
      for (const pick of input.picks) {
        const reserved = await reserveReplacementPick({ pick, doc, order, schedule, soLine, lotId, actor, session });
        scheduleLine.allocations.push(reserved.allocation);
        doc.items.push({
          _id: newId(), lineNo: doc.items.length + 1, lineKind: 'OUTBOUND_DELIVERY', productId: soLine.productId, lotId,
          enteredUnit: soLine.baseUnitSnapshot, baseUnitSnapshot: soLine.baseUnitSnapshot, baseUnitsPerUnit: '1',
          enteredQty: reserved.allocation.qtyBase, qtyBase: reserved.allocation.qtyBase,
          productNameSnapshot: soLine.productNameSnapshot,
          packagingSnapshot: soLine.packagingSnapshot?.toObject?.() ?? soLine.packagingSnapshot,
          sources: [sourceLink(order, soLine, reserved.allocation.qtyBase)],
          details: {
            soLineId: soLine._id, locationId: reserved.allocation.locationId, balanceId: reserved.allocation.balanceId,
            allocationId: reserved.allocation._id, reservationId: reserved.allocation.reservationId,
          },
        });
        reportPicks.push({
          balanceId: reserved.allocation.balanceId, locationId: reserved.allocation.locationId,
          qtyBase: reserved.allocation.qtyBase, reservationId: reserved.allocation.reservationId,
        });
      }
      doc.issueReports.push({
        _id: reportId, lineId: originalLineId, soLineId: soLine._id, lotId, locationId: originalLocationId, balanceId: originalBalanceId,
        kind: input.kind, shortQtyBase: shortQty.toFixed(), reason: input.reason, picks: reportPicks, shortfallQtyBase: '0',
        status: 'CLOSED', reportedBy: actor._id, reportedAt: now, closedBy: actor._id, closedAt: now,
        stockTransactionId: posting._id, ...(adjustment && { adjustmentId: adjustment._id }),
      });
    } else {
      doc.workflowStatus = 'ON_HOLD';
      delivery.status = 'ON_HOLD';
      doc.issueReports.push({
        _id: reportId, lineId: originalLineId, soLineId: soLine._id, lotId, locationId: originalLocationId, balanceId: originalBalanceId,
        kind: input.kind, shortQtyBase: shortQty.toFixed(), reason: input.reason, picks: [], shortfallQtyBase: shortQty.toFixed(),
        status: 'OPEN', reportedBy: actor._id, reportedAt: now,
        stockTransactionId: posting._id, ...(adjustment && { adjustmentId: adjustment._id }),
      });
      await createInAppNotification({
        recipientId: order.createdBy,
        type: 'DELIVERY_ORDER_ON_HOLD',
        eventKey: `DELIVERY_ORDER_ON_HOLD:${doc._id}`,
        dedupKey: `DELIVERY_ORDER_ON_HOLD:${doc._id}:${reportId}`,
        sourceType: 'delivery_orders',
        sourceId: doc._id,
        sourceVersion: input.expectedVersion + 1,
        warehouseIds: [doc.header.warehouseId],
        title: `Lệnh giao hàng ${doc.documentNo} tạm dừng`,
        message: `DO ${doc.documentNo} (đơn ${order.documentNo}, lần giao ${delivery.seq}) báo cáo ${input.kind === 'DAMAGED' ? 'hàng hỏng' : 'thiếu hàng'} ${shortQty.toFixed()} ${soLine.baseUnitSnapshot}. Lý do: ${input.reason}`,
        session,
      });
    }
    doc.items.forEach((row, idx) => { row.lineNo = idx + 1; });
    doc.updatedBy = actor._id;
    schedule.updatedBy = actor._id;
    const saved = await saveVersion(doc, input.expectedVersion, session);
    await saveVersion(schedule, schedule.version, session);
    return {
      document: saved, versionBefore: input.expectedVersion, stockTransactionId: posting._id,
      resultRefs: [...scheduleRef(schedule), ...(adjustment ? [{ documentType: 'stock_adjustments', documentId: adjustment._id }] : [])],
      reason: input.reason,
    };
  });
}

// ---- Reads ----
async function scopedFilter(user, query) {
  if (query.warehouseId && !unrestricted(user)) requireWarehouseAccess(user, query.warehouseId);
  const warehouses = query.warehouseId ? [query.warehouseId] : unrestricted(user) ? null : (user.warehouseIds || []);
  const orders = isSales(user) ? await m.SalesOrder.find({ createdBy: user._id }).distinct('_id') : null;
  return { warehouses, orders };
}
const inRange = (value, query) => (!query.from || +new Date(value) >= +new Date(query.from)) && (!query.to || +new Date(value) <= +new Date(query.to));

export async function listDeliverySchedules(user, query) {
  requirePermission(user, 'delivery_schedule:read');
  const { warehouses, orders } = await scopedFilter(user, query);
  const wanted = d => (!warehouses || warehouses.some(w => same(w, d.warehouseId))) && (!query.status || d.status === query.status) && inRange(d.plannedOn, query);
  const schedules = await m.DeliverySchedule.find({ ...(orders && { salesOrderId: { $in: orders } }), ...(warehouses && { 'deliveries.warehouseId': { $in: warehouses } }) }).lean();
  const matched = schedules.flatMap(schedule => schedule.deliveries.filter(wanted).map(delivery => ({ schedule, delivery })));
  matched.sort((a, b) => +new Date(a.delivery.plannedOn) - +new Date(b.delivery.plannedOn) || String(a.schedule._id).localeCompare(String(b.schedule._id)) || a.delivery.seq - b.delivery.seq);
  const start = (query.page - 1) * query.limit, slice = matched.slice(start, start + query.limit);
  // Names only: no prices reach warehouse staff.
  const sources = await m.SalesOrder.find({ _id: { $in: [...new Set(slice.map(row => String(row.schedule.salesOrderId)))] } }).select('header.recipientName header.recipientPhone items._id items.productNameSnapshot').lean();
  const today = vnDay();
  const items = slice.map(({ schedule, delivery }) => {
    const order = sources.find(row => same(row._id, schedule.salesOrderId));
    const from = createFromDay(delivery.plannedOn);
    return { id: String(delivery._id), scheduleId: String(schedule._id), scheduleVersion: schedule.version, salesOrderId: String(schedule.salesOrderId), seq: delivery.seq,
      plannedOn: delivery.plannedOn, warehouseId: String(delivery.warehouseId), status: delivery.status, doId: delivery.doId ? String(delivery.doId) : null,
      recipientName: order?.header?.recipientName ?? null, createDoFrom: from, canCreateNow: delivery.status === 'PLANNED' && today >= from,
      lines: delivery.lines.map(line => ({ soLineId: String(line.soLineId), lotId: String(line.lotId), qtyBase: String(line.qtyBase), productName: order?.items?.find(i => same(i._id, line.soLineId))?.productNameSnapshot ?? null })) };
  });
  return { items, total: matched.length, page: query.page, limit: query.limit };
}

export async function listDeliveryOrders(user, query) {
  requirePermission(user, 'delivery_order:read');
  const { warehouses, orders } = await scopedFilter(user, query);
  const filter = { 'header.deliveryId': { $exists: true }, ...(warehouses && { 'header.warehouseId': { $in: warehouses } }), ...(orders && { 'header.salesOrderId': { $in: orders } }) };
  if (query.salesOrderId) filter['header.salesOrderId'] = orders ? { $in: orders.filter(id => same(id, query.salesOrderId)) } : query.salesOrderId;
  if (query.q) filter.documentNo = new RegExp(escapeRegex(query.q), 'i');
  if (query.status) filter.workflowStatus = query.status;
  if (query.from || query.to) filter['header.plannedOn'] = { ...(query.from && { $gte: new Date(query.from) }), ...(query.to && { $lte: new Date(query.to) }) };
  return page(m.DeliveryOrder, filter, query, 'documentNo workflowStatus version createdAt header issueReports');
}

export async function getDeliveryOrder(user, id) {
  requirePermission(user, 'delivery_order:read');
  return transaction(async session => {
    const doc = await m.DeliveryOrder.findById(id).session(session).lean();
    if (!doc || !doc.header.deliveryId) throw notFoundError();
    if (!unrestricted(user)) requireWarehouseAccess(user, doc.header.warehouseId);
    if (isSales(user) && !await m.SalesOrder.exists({ _id: doc.header.salesOrderId, createdBy: user._id }).session(session)) throw notFoundError();
    const locationIds = [
      ...doc.items.map(item => item.details.locationId),
      ...(doc.issueReports ?? []).map(r => r.locationId),
      ...(doc.issueReports ?? []).flatMap(r => (r.picks ?? []).map(p => p.locationId)),
    ].filter(Boolean);
    const places = locationIds.length ? await m.WarehouseLocation.find({ _id: { $in: locationIds } }).select('code name').session(session).lean() : [];
    const codeOf = locId => places.find(p => same(p._id, locId))?.code ?? null;
    const out = dto(doc);
    out.items = out.items.map((item, i) => ({ ...item, id: String(doc.items[i]._id), details: { ...item.details, locationCode: codeOf(doc.items[i].details.locationId) } }));
    out.issueReports = (out.issueReports ?? []).map((report, i) => ({
      ...report, id: String(doc.issueReports[i]._id), locationCode: codeOf(doc.issueReports[i].locationId),
      picks: (report.picks ?? []).map((p, j) => ({ ...p, id: String(doc.issueReports[i].picks[j]._id), locationCode: codeOf(doc.issueReports[i].picks[j].locationId) })),
    }));
    return out;
  });
}