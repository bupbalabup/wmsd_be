import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { validationError, versionConflict } from '../../shared/utils/ApiError.js';
import { same, newId } from '../../shared/utils/document-command.js';
import { remainingReservation, sourceContext } from '../../shared/utils/stock.js';

// Traverse any StockReservation splits/relocations (previousReservationId) rooted at `rootReservationId`.
export async function resolveActiveReservations(rootReservationId, session) {
  if (!rootReservationId) return { tree: [], active: [] };
  const root = await m.StockReservation.findById(rootReservationId).session(session);
  if (!root) return { tree: [], active: [] };
  const tree = [root];
  const seen = new Set([String(root._id)]);
  let frontier = [root._id];
  while (frontier.length) {
    const children = await m.StockReservation.find({ previousReservationId: { $in: frontier } }).session(session);
    const next = [];
    for (const child of children) {
      const k = String(child._id);
      if (seen.has(k)) continue;
      seen.add(k);
      tree.push(child);
      next.push(child._id);
    }
    frontier = next;
  }
  const active = tree.filter(row => remainingReservation(row).gt(0));
  return { tree, active };
}

// Release `quantity` (or everything remaining when quantity == null) across the reservation tree.
export async function releaseReservationTree(rootReservationId, quantity, actor, session) {
  const { active } = await resolveActiveReservations(rootReservationId, session);
  if (!active.length) {
    if (quantity != null && exact(quantity).gt(0)) throw validationError('Bản ghi giữ hàng không đủ để nhả');
    return;
  }
  if (quantity == null) {
    for (const row of active) {
      const open = remainingReservation(row);
      if (!open.gt(0)) continue;
      const res = await m.StockReservation.updateOne(
        { _id: row._id, version: row.version },
        { $set: { releasedQty: exact(row.releasedQty).plus(open).toFixed(), updatedBy: actor._id }, $inc: { version: 1 } },
        { session },
      );
      if (res.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
    }
    return;
  }
  let left = exact(quantity);
  const totalOpen = active.reduce((sum, row) => sum.plus(remainingReservation(row)), exact('0'));
  if (left.gt(totalOpen)) throw validationError('Bản ghi giữ hàng không đủ để nhả');
  for (const row of active) {
    if (!left.gt(0)) break;
    const open = remainingReservation(row);
    const take = open.lt(left) ? open : left;
    if (!take.gt(0)) continue;
    const res = await m.StockReservation.updateOne(
      { _id: row._id, version: row.version },
      { $set: { releasedQty: exact(row.releasedQty).plus(take).toFixed(), updatedBy: actor._id }, $inc: { version: 1 } },
      { session },
    );
    if (res.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
    left = left.minus(take);
  }
}

// Sync one schedule allocation along its moved reservation chain (Phương án A).
export async function syncAllocationChain(allocation, session) {
  if (!allocation?.reservationId) return { changed: false, allocations: [allocation] };
  const { active } = await resolveActiveReservations(allocation.reservationId, session);
  if (active.length === 1 && same(active[0]._id, allocation.reservationId) && same(active[0].balanceId, allocation.balanceId)) {
    return { changed: false, allocations: [allocation] };
  }
  const needed = exact(allocation.qtyBase);
  const totalOpen = active.reduce((sum, row) => sum.plus(remainingReservation(row)), exact('0'));
  if (totalOpen.lt(needed)) return { changed: false, allocations: [allocation] };
  let left = needed;
  const mapped = [];
  let reusedOriginalId = false;
  for (const row of active) {
    if (!left.gt(0)) break;
    const open = remainingReservation(row);
    const take = open.lt(left) ? open : left;
    if (!take.gt(0)) continue;
    const ctx = await sourceContext(row.balanceId, session).catch(() => null);
    const allocId = !reusedOriginalId ? (reusedOriginalId = true, allocation._id) : newId();
    mapped.push({
      _id: allocId,
      balanceId: row.balanceId,
      locationId: ctx?.location?._id ?? allocation.locationId,
      qtyBase: take.toFixed(),
      reservationId: row._id,
    });
    left = left.minus(take);
  }
  return { changed: true, allocations: mapped };
}