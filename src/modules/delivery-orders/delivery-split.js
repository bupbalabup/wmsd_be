import { exact } from '../../models/model-utils.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { newId } from '../../shared/utils/document-command.js';

// Split stock for goods that leave the warehouse (delivery orders only; the shared
// splitPortions keeps refusing to open a carton for transfers).
// Order of use: loose/open pieces first, then whole sealed cartons, and a sealed carton
// is opened only for the last pieces. The leftover of an opened carton stays as an OPEN
// portion that keeps the carton's outer volume, so location capacity is still counted.
export function splitForDelivery(portions, quantity, actorId) {
  const now = new Date();
  let remaining = exact(quantity);
  const list = portions.map(portion => portion.toObject ? portion.toObject() : { ...portion });
  const order = list.map((_, index) => index).sort((a, b) => (list[a].packagingState === 'SEALED') - (list[b].packagingState === 'SEALED') || a - b);
  const keptBy = new Map();
  for (const index of order) {
    const portion = list[index], available = exact(portion.quantityBase);
    if (remaining.isZero()) { keptBy.set(index, [portion]); continue; }
    if (remaining.gte(available)) { keptBy.set(index, []); remaining = remaining.minus(available); continue; }
    if (portion.packagingState !== 'SEALED') {
      // Open or loose pieces are counted one by one; the measured volume stays as it was.
      keptBy.set(index, [{ ...portion, quantityBase: available.minus(remaining).toFixed(), updatedBy: actorId }]);
      remaining = exact('0');
      continue;
    }
    const perPack = exact(String(portion.packagingSnapshot.baseUnitsPerPackage));
    const wholePacks = remaining.div(perPack).floor(), pieces = remaining.minus(wholePacks.mul(perPack));
    const packsLeft = exact(String(portion.sealedPackCount)).minus(wholePacks).minus(pieces.gt(0) ? 1 : 0);
    const kept = [];
    if (packsLeft.gt(0)) kept.push({ ...portion, sealedPackCount: packsLeft.toNumber(), quantityBase: perPack.mul(packsLeft).toFixed(), updatedBy: actorId });
    if (pieces.gt(0)) {
      const outer = ['outerLengthMm', 'outerWidthMm', 'outerHeightMm'].map(key => portion.packagingSnapshot[key]);
      kept.push({ _id: newId(), packagingState: 'OPEN', packagingSnapshot: portion.packagingSnapshot, ...(portion.packagingKey && { packagingKey: portion.packagingKey }),
        quantityBase: perPack.minus(pieces).toFixed(), createdBy: actorId, updatedBy: actorId, createdAt: now, updatedAt: now,
        ...(outer.every(value => value != null) && { measuredVolumeMm3: outer.reduce((n, value) => n.mul(String(value)), exact('1')).toFixed(0) }) });
    }
    keptBy.set(index, kept);
    remaining = exact('0');
  }
  if (!remaining.isZero()) throw validationError('Quy cách tồn không đủ số lượng');
  return { kept: list.flatMap((_, index) => keptBy.get(index) ?? []) };
}
