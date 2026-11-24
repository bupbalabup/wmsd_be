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

// Split stock from GOOD to DAMAGED within the same bin.
// Preserves total occupied volume in the bin so checkBinCapacity stays accurate even on a full bin.
export function splitForDamage(portions, quantity, actorId) {
  const now = new Date();
  let remaining = exact(quantity);
  const list = portions.map(portion => portion.toObject ? portion.toObject() : { ...portion });
  const order = list.map((_, index) => index).sort((a, b) => (list[a].packagingState === 'SEALED') - (list[b].packagingState === 'SEALED') || a - b);
  const keptBy = new Map();
  const taken = [];
  for (const index of order) {
    const portion = list[index], available = exact(portion.quantityBase);
    if (remaining.isZero()) { keptBy.set(index, [portion]); continue; }
    if (remaining.gte(available)) {
      keptBy.set(index, []);
      taken.push({ ...portion, _id: newId(), createdBy: actorId, updatedBy: actorId, createdAt: now, updatedAt: now });
      remaining = remaining.minus(available);
      continue;
    }
    if (portion.packagingState !== 'SEALED') {
      const keptQty = available.minus(remaining);
      const splitVol = (raw) => {
        if (raw == null) return [undefined, undefined];
        const total = exact(String(raw));
        const takenPart = total.mul(remaining).div(available).toDecimalPlaces(3);
        return [total.minus(takenPart).toFixed(), takenPart.toFixed()];
      };
      const [keptMeasured, takenMeasured] = splitVol(portion.measuredVolumeMm3);
      const [keptExtra, takenExtra] = splitVol(portion.extraOccupiedVolumeMm3);
      keptBy.set(index, [{
        ...portion,
        quantityBase: keptQty.toFixed(),
        ...(keptMeasured !== undefined && { measuredVolumeMm3: keptMeasured }),
        ...(keptExtra !== undefined && { extraOccupiedVolumeMm3: keptExtra }),
        updatedBy: actorId,
      }]);
      taken.push({
        _id: newId(),
        packagingState: 'LOOSE',
        packagingSnapshot: portion.packagingSnapshot,
        ...(portion.packagingKey && { packagingKey: portion.packagingKey }),
        quantityBase: remaining.toFixed(),
        ...(takenMeasured !== undefined && { measuredVolumeMm3: takenMeasured }),
        ...(takenExtra !== undefined && { extraOccupiedVolumeMm3: takenExtra }),
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      });
      remaining = exact('0');
      continue;
    }
    const perPack = exact(String(portion.packagingSnapshot.baseUnitsPerPackage));
    const wholePacks = remaining.div(perPack).floor(), pieces = remaining.minus(wholePacks.mul(perPack));
    const packsLeft = exact(String(portion.sealedPackCount)).minus(wholePacks).minus(pieces.gt(0) ? 1 : 0);
    const kept = [];
    if (packsLeft.gt(0)) {
      kept.push({ ...portion, sealedPackCount: packsLeft.toNumber(), quantityBase: perPack.mul(packsLeft).toFixed(), updatedBy: actorId });
    }
    if (wholePacks.gt(0)) {
      taken.push({
        ...portion,
        _id: newId(),
        sealedPackCount: wholePacks.toNumber(),
        quantityBase: perPack.mul(wholePacks).toFixed(),
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (pieces.gt(0)) {
      const outer = ['outerLengthMm', 'outerWidthMm', 'outerHeightMm'].map(key => portion.packagingSnapshot[key]);
      const hasOuter = outer.every(value => value != null);
      const cartonVol = hasOuter ? outer.reduce((n, value) => n.mul(String(value)), exact('1')) : null;
      const takenPieceVol = cartonVol ? cartonVol.mul(pieces).div(perPack).toDecimalPlaces(3) : null;
      const keptOpenVol = cartonVol ? cartonVol.minus(takenPieceVol) : null;
      kept.push({
        _id: newId(),
        packagingState: 'OPEN',
        packagingSnapshot: portion.packagingSnapshot,
        ...(portion.packagingKey && { packagingKey: portion.packagingKey }),
        quantityBase: perPack.minus(pieces).toFixed(),
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
        ...(keptOpenVol != null && { measuredVolumeMm3: keptOpenVol.toFixed() }),
      });
      taken.push({
        _id: newId(),
        packagingState: 'LOOSE',
        packagingSnapshot: portion.packagingSnapshot,
        ...(portion.packagingKey && { packagingKey: portion.packagingKey }),
        quantityBase: pieces.toFixed(),
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
        ...(takenPieceVol != null && { measuredVolumeMm3: takenPieceVol.toFixed() }),
      });
    }
    keptBy.set(index, kept);
    remaining = exact('0');
  }
  if (!remaining.isZero()) throw validationError('Quy cách tồn không đủ số lượng');
  return { kept: list.flatMap((_, index) => keptBy.get(index) ?? []), taken };
}