import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { validationError, versionConflict } from '../../shared/utils/ApiError.js';
import { requireWarehouseAccess } from '../../shared/utils/access.js';
import { same, newId, hash } from '../../shared/utils/document-command.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import { splitForDelivery, splitForDamage } from './delivery-split.js';
import { guardLocations, sourceContext, balanceAt, freeQuantity, verifyCapacity, remainingReservation, heldQuantity, unreservedPendingTaskQuantity } from '../../shared/utils/stock.js';

async function saveBalancePortions(balance, nextQtyBase, kept, session) {
  balance.quantityBase = nextQtyBase;
  // Keep subdocument identity of the portions that stay, as moveStock does.
  const keptIds = new Set(kept.map(row => String(row._id)));
  balance.packagingPortions.pull(...balance.packagingPortions.filter(row => !keptIds.has(String(row._id))).map(row => row._id));
  for (const portion of kept) {
    const retained = balance.packagingPortions.id(portion._id);
    if (!retained) { balance.packagingPortions.push(portion); continue; }
    retained.quantityBase = portion.quantityBase;
    if (portion.sealedPackCount != null) retained.sealedPackCount = portion.sealedPackCount;
    if (portion.measuredVolumeMm3 !== undefined) retained.measuredVolumeMm3 = portion.measuredVolumeMm3;
    if (portion.extraOccupiedVolumeMm3 !== undefined) retained.extraOccupiedVolumeMm3 = portion.extraOccupiedVolumeMm3;
    if (portion.updatedBy) retained.updatedBy = portion.updatedBy;
  }
  await balance.validate();
  const written = await m.InventoryBalance.collection.updateOne(
    { _id: balance._id, version: balance.version },
    { $set: { quantityBase: balance.quantityBase, packagingPortions: balance.packagingPortions.map(portion => portion.toObject()), updatedAt: new Date() }, $inc: { version: 1 } },
    { session },
  );
  if (written.matchedCount !== 1) throw versionConflict('Tồn đã thay đổi');
}

// Take one pick line of a delivery order out of stock and consume the reservation
// that was made for exactly that allocation (not another delivery's hold).
export async function takeForDelivery(item, posting, actor, session) {
  const { balanceId, reservationId, locationId } = item.details;
  const { balance, location, product } = await sourceContext(balanceId, session);
  if (!location || !same(location._id, locationId)) throw validationError('Vị trí lấy hàng không khớp tồn');
  requireWarehouseAccess(actor, location.warehouseId);
  await guardLocations([location._id], session);
  const amount = exact(item.qtyBase), before = exact(balance.quantityBase);
  if (!amount.gt(0) || (product.wholeBaseUnits && !amount.isInteger())) throw validationError('Lượng xuất không đúng đơn vị gốc');
  if (balance.qualityStatus !== 'GOOD') throw validationError(`Tồn tại ${location.code} không còn ở trạng thái tốt`);
  const reservations = await m.StockReservation.find({ balanceId }).session(session);
  const own = reservations.find(row => same(row._id, reservationId));
  if (!own || remainingReservation(own).lt(amount)) throw validationError(`Bản ghi giữ hàng tại ${location.code} không còn đủ`);
  const others = reservations.filter(row => row !== own).reduce((n, row) => n.plus(remainingReservation(row)), exact('0'));
  const blocked = await heldQuantity(balanceId, session), pending = await unreservedPendingTaskQuantity(balanceId, session);
  if (amount.plus(others).plus(blocked).plus(pending).gt(before)) throw validationError(`Không đủ tồn tại ${location.code} (tồn đang bị chặn hoặc giữ cho chứng từ khác)`);
  // An odd number of pieces opens a sealed carton (decided with Đăng); see delivery-split.js.
  const { kept } = splitForDelivery(balance.packagingPortions, amount, actor._id);
  await saveBalancePortions(balance, before.minus(amount).toFixed(), kept, session);
  const consumed = await m.StockReservation.updateOne(
    { _id: own._id, version: own.version },
    { $set: { consumedQty: exact(own.consumedQty).plus(amount).toFixed(), updatedBy: actor._id }, $inc: { version: 1 } },
    { session },
  );
  if (consumed.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
  posting.movements.push({
    transactionId: posting._id,
    lineNo: posting.movements.length + 1,
    sourceLineId: item._id,
    fromBalanceId: balance._id,
    quantityBase: amount.toFixed(),
    fromBefore: before.toFixed(),
    fromAfter: balance.quantityBase,
  });
}

// Deduct `shortQty` immediately from the GOOD balance of a reported DO line:
// - SHORTAGE: reduce GOOD stock and record a POSTED StockAdjustment (-shortQty)
// - DAMAGED: move GOOD stock to DAMAGED balance at the same location and verify capacity
export async function deductForIssueReport({ item, shortQty, kind, reason, doc, posting, actor, session }) {
  const { balanceId, reservationId, locationId } = item.details;
  const { balance, location, product } = await sourceContext(balanceId, session);
  if (!location || !same(location._id, locationId)) throw validationError('Vị trí báo cáo không khớp tồn');
  requireWarehouseAccess(actor, location.warehouseId);
  await guardLocations([location._id], session);
  const amount = exact(shortQty), itemQty = exact(item.qtyBase), before = exact(balance.quantityBase);
  if (!amount.gt(0) || amount.gt(itemQty)) throw validationError('Số lượng thiếu/hỏng không hợp lệ');
  if (product.wholeBaseUnits && !amount.isInteger()) throw validationError('Số lượng thiếu/hỏng không đúng đơn vị gốc');
  if (balance.qualityStatus !== 'GOOD') throw validationError(`Tồn tại ${location.code} không còn ở trạng thái tốt`);
  const reservations = await m.StockReservation.find({ balanceId }).session(session);
  const own = reservations.find(row => same(row._id, reservationId));
  if (!own || remainingReservation(own).lt(amount)) throw validationError(`Bản ghi giữ hàng tại ${location.code} không còn đủ`);
  const others = reservations.filter(row => row !== own).reduce((n, row) => n.plus(remainingReservation(row)), exact('0'));
  const blocked = await heldQuantity(balanceId, session), pending = await unreservedPendingTaskQuantity(balanceId, session);
  if (itemQty.plus(others).plus(blocked).plus(pending).gt(before)) {
    throw validationError(`Không đủ tồn vật lý tại ${location.code} để xử lý báo cáo (tồn đang bị chặn hoặc giữ cho chứng từ khác)`);
  }

  let adjustment = null;
  if (kind === 'SHORTAGE') {
    const { kept } = splitForDelivery(balance.packagingPortions, amount, actor._id);
    await saveBalancePortions(balance, before.minus(amount).toFixed(), kept, session);
    posting.movements.push({
      transactionId: posting._id,
      lineNo: posting.movements.length + 1,
      sourceLineId: item._id,
      fromBalanceId: balance._id,
      quantityBase: amount.toFixed(),
      fromBefore: before.toFixed(),
      fromAfter: balance.quantityBase,
    });
    const delta = amount.negated().toFixed();
    adjustment = new m.StockAdjustment({
      ...await nextDocumentFields(m.StockAdjustment, 'ADJ', doc.header.warehouseId, session),
      workflowStatus: 'POSTED',
      version: 1,
      createdBy: actor._id,
      occurredAt: new Date(),
      postedBy: actor._id,
      postedAt: new Date(),
      stockTransactionId: posting._id,
      note: reason,
      sources: [sourceLink(doc, item, amount.toFixed(), 'DELIVERY_SHORTAGE')],
      header: { warehouseId: doc.header.warehouseId, deliveryOrderId: doc._id },
      items: [
        copyItem(item, amount.toFixed(), {
          lineNo: 1,
          lineKind: 'ADJUSTMENT',
          details: { deltaQty: delta },
          stockBalanceId: balance._id,
          quantityDeltaBase: delta,
          beforeQty: before.toFixed(),
          afterQty: balance.quantityBase,
          reason,
          sources: [sourceLink(doc, item, amount.toFixed(), 'DELIVERY_SHORTAGE')],
        }),
      ],
    });
    await adjustment.save({ session });
  } else {
    const { kept, taken } = splitForDamage(balance.packagingPortions, amount, actor._id);
    await saveBalancePortions(balance, before.minus(amount).toFixed(), kept, session);
    const damaged = await balanceAt({ type: 'LOCATION', locationId: location._id }, balance, 'DAMAGED', session);
    const damagedBefore = exact(damaged.quantityBase);
    damaged.packagingPortions.push(...taken);
    damaged.quantityBase = damagedBefore.plus(amount).toFixed();
    await damaged.validate();
    const damagedWrite = await m.InventoryBalance.collection.updateOne(
      { _id: damaged._id, version: damaged.version },
      { $set: { quantityBase: damaged.quantityBase, packagingPortions: damaged.packagingPortions.map(p => p.toObject()), updatedAt: new Date() }, $inc: { version: 1 } },
      { session },
    );
    if (damagedWrite.matchedCount !== 1) throw versionConflict('Tồn hàng hỏng đã thay đổi');
    await verifyCapacity([location._id], session);
    posting.movements.push({
      transactionId: posting._id,
      lineNo: posting.movements.length + 1,
      sourceLineId: item._id,
      fromBalanceId: balance._id,
      toBalanceId: damaged._id,
      quantityBase: amount.toFixed(),
      fromBefore: before.toFixed(),
      fromAfter: balance.quantityBase,
      toBefore: damagedBefore.toFixed(),
      toAfter: damaged.quantityBase,
    });
  }

  const released = await m.StockReservation.updateOne(
    { _id: own._id, version: own.version },
    { $set: { releasedQty: exact(own.releasedQty).plus(amount).toFixed(), updatedBy: actor._id }, $inc: { version: 1 } },
    { session },
  );
  if (released.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
  return { adjustment };
}

export async function reserveReplacementPick({ pick, doc, order, schedule, soLine, lotId, actor, session }) {
  const ctx = await sourceContext(pick.balanceId, session).catch(() => null);
  if (!ctx || !ctx.location || !ctx.location.isActive || ctx.location.locationType !== 'STORAGE' || !ctx.location.isPickable
    || !same(ctx.location.warehouseId, doc.header.warehouseId) || ctx.balance.qualityStatus !== 'GOOD'
    || ctx.balance.ownerType !== 'STORE' || !same(ctx.balance.batchId, lotId)) {
    throw validationError('Vị trí lấy bù không hợp lệ hoặc không cùng kho/lô');
  }
  await guardLocations([ctx.location._id], session);
  const pickQty = exact(pick.qty);
  if (!pickQty.gt(0) || (ctx.product.wholeBaseUnits && !pickQty.isInteger())) {
    throw validationError(`Số lượng lấy bù tại ${ctx.location.code} không hợp lệ`);
  }
  const free = await freeQuantity(ctx.balance, session);
  if (free.lt(pickQty)) {
    throw validationError(`Vị trí ${ctx.location.code} chỉ còn ${free.toFixed()} khả dụng, không đủ lấy bù ${pickQty.toFixed()}`);
  }
  const allocationId = newId();
  const reservation = await new m.StockReservation({
    demandRef: { documentType: 'sales_orders', documentId: order._id, itemId: soLine._id },
    executionRef: { documentType: 'delivery_schedules', documentId: schedule._id, itemId: allocationId },
    balanceId: ctx.balance._id,
    reservedQty: pickQty.toFixed(),
    creationKey: hash({ ds: String(schedule._id), allocation: String(allocationId) }),
    createdBy: actor._id,
  }).save({ session });
  const touched = await m.InventoryBalance.updateOne(
    { _id: ctx.balance._id, version: ctx.balance.version },
    { $inc: { version: 1 } },
    { session },
  );
  if (touched.matchedCount !== 1) throw versionConflict('Tồn lấy bù đã thay đổi');
  return {
    allocation: { _id: allocationId, balanceId: ctx.balance._id, locationId: ctx.location._id, qtyBase: pickQty.toFixed(), reservationId: reservation._id },
    location: ctx.location,
    reservation,
  };
}