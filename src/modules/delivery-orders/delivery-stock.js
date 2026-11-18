import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { validationError, versionConflict } from '../../shared/utils/ApiError.js';
import { requireWarehouseAccess } from '../../shared/utils/access.js';
import { same } from '../../shared/utils/document-command.js';
import { splitForDelivery } from './delivery-split.js';
import { guardLocations, sourceContext, remainingReservation, heldQuantity, unreservedPendingTaskQuantity } from '../../shared/utils/stock.js';

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
  balance.quantityBase = before.minus(amount).toFixed();
  // Keep subdocument identity of the portions that stay, as moveStock does.
  const keptIds = new Set(kept.map(row => String(row._id)));
  balance.packagingPortions.pull(...balance.packagingPortions.filter(row => !keptIds.has(String(row._id))).map(row => row._id));
  for (const portion of kept) {
    const retained = balance.packagingPortions.id(portion._id);
    if (!retained) { balance.packagingPortions.push(portion); continue; }
    retained.quantityBase = portion.quantityBase;
    if (portion.sealedPackCount != null) retained.sealedPackCount = portion.sealedPackCount;
    if (portion.updatedBy) retained.updatedBy = portion.updatedBy;
  }
  await balance.validate();
  const written = await m.InventoryBalance.collection.updateOne({ _id: balance._id, version: balance.version },
    { $set: { quantityBase: balance.quantityBase, packagingPortions: balance.packagingPortions.map(portion => portion.toObject()), updatedAt: new Date() }, $inc: { version: 1 } }, { session });
  if (written.matchedCount !== 1) throw versionConflict('Tồn đã thay đổi');
  const consumed = await m.StockReservation.updateOne({ _id: own._id, version: own.version },
    { $set: { consumedQty: exact(own.consumedQty).plus(amount).toFixed(), updatedBy: actor._id }, $inc: { version: 1 } }, { session });
  if (consumed.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
  posting.movements.push({ transactionId: posting._id, lineNo: posting.movements.length + 1, sourceLineId: item._id,
    fromBalanceId: balance._id, quantityBase: amount.toFixed(), fromBefore: before.toFixed(), fromAfter: balance.quantityBase });
}
