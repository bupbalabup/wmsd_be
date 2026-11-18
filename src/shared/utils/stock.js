import { InventoryBalance, StockHoldingPoint, StockReservation, StockTransaction, StocktakeLocationLock,
  WarehouseLocation, Warehouse, ProductBatch, Product, DefectReport, TransferOrder } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { checkBinCapacity } from '../../models/capacity.js';
import { validationError, versionConflict } from './ApiError.js';
import { newId, same, hash } from './document-command.js';

export const remainingReservation = row => exact(row.reservedQty).minus(String(row.consumedQty)).minus(String(row.releasedQty)).minus(String(row.movedQty));

// Initialization and ordinary stock commands serialize on the same warehouse.
// This also covers newly created bins outside an opening draft's original scope.
export async function guardWarehouses(ids, session) {
  for (const warehouseId of [...new Set(ids.filter(Boolean).map(String))].sort()) {
    const warehouse = await Warehouse.findOneAndUpdate({ _id: warehouseId, isActive: true }, { $inc: { stockOperationVersion: 1 } }, { session, returnDocument: 'after', timestamps: false });
    if (!warehouse) throw validationError('Kho đã ngừng hoạt động');
  }
}
export async function guardLocations(ids, session) {
  const scoped = await WarehouseLocation.find({ _id: { $in: ids.filter(Boolean) } }).select('warehouseId').session(session);
  await guardWarehouses(scoped.map(location => location.warehouseId), session);
  for (const locationId of [...new Set(ids.filter(Boolean).map(String))].sort()) {
    const location = await WarehouseLocation.findOneAndUpdate({ _id: locationId, isActive: true }, { $inc: { operationVersion: 1 } }, { session, returnDocument: 'after' });
    if (!location || !await Warehouse.exists({ _id: location.warehouseId, isActive: true }).session(session)) throw validationError('Kho hoặc vị trí đã ngừng hoạt động');
    if (await StocktakeLocationLock.exists({ locationId, status: 'LOCKED' }).session(session)) throw validationError('Vị trí đang khóa kiểm kê');
  }
}
export async function locationAt(id, warehouseId, kinds, session) {
  const location = await WarehouseLocation.findOne({ _id: id, warehouseId, isActive: true }).session(session);
  if (!location || (kinds?.length && !kinds.includes(location.locationType))) throw validationError('Vị trí không thuộc kho hoặc sai loại');
  return location;
}
export async function sourceContext(id, session) {
  const balance = await InventoryBalance.findById(id).session(session);
  if (!balance) throw validationError('Không tìm thấy tồn nguồn');
  const point = await StockHoldingPoint.findById(balance.holdingPointId).session(session);
  const batch = await ProductBatch.findById(balance.batchId).session(session);
  const product = batch && await Product.findById(batch.productId).session(session);
  if (!point || !batch || !product) throw validationError('Tồn thiếu điểm giữ hàng, lô hoặc sản phẩm');
  const location = point.locationId ? await WarehouseLocation.findById(point.locationId).session(session) : null;
  return { balance, point, batch, product, location };
}
export async function balanceAt(pointFields, source, qualityStatus, session) {
  let point = await StockHoldingPoint.findOne(pointFields).session(session);
  if (!point) point = await new StockHoldingPoint(pointFields).save({ session });
  const fields = { holdingPointId: point._id, batchId: source.batchId,
    qualityStatus, ownerType: source.ownerType, ownerId: source.ownerId ?? null };
  return await InventoryBalance.findOne(fields).session(session) ??
    await new InventoryBalance({ ...fields, quantityBase: '0', version: 0, packagingPortions: [] }).save({ session });
}
export async function pendingTaskQuantity(balanceId, session, excludeTaskId) {
  const tasks = await TransferOrder.find({ ...(excludeTaskId && { _id: { $ne: excludeTaskId } }), workflowStatus: { $in: ['OPEN','DRAFT','PARTIAL'] }, 'items.details.sourceBalanceId': balanceId }).session(session).lean();
  const transactions=await StockTransaction.find({sourceType:'transfer_orders',sourceId:{$in:tasks.map(t=>t._id)}}).session(session).lean();
  return tasks.reduce((total,task)=>total.plus(task.items.filter(item=>same(item.details?.sourceBalanceId,balanceId)).reduce((n,item)=>{
    const actual=transactions.filter(t=>same(t.sourceId,task._id)).flatMap(t=>t.movements).filter(m=>same(m.sourceLineId,item._id)&&same(m.fromBalanceId,balanceId)).reduce((v,m)=>v.plus(String(m.quantityBase)),exact('0'));
    return n.plus(exact(item.qtyBase).minus(actual));
  },exact('0'))),exact('0'));
}
export async function freeQuantity(balance, session, excludeTaskId) {
  const reservations = await StockReservation.find({ balanceId: balance._id }).session(session);
  const reserved = reservations.reduce((sum,row) => sum.plus(remainingReservation(row)), exact('0'));
  const pending = await unreservedPendingTaskQuantity(balance._id, session, excludeTaskId);
  return exact(balance.quantityBase).minus(reserved).minus(pending).minus(await heldQuantity(balance._id, session));
}
// Sales picking tasks are backed by execution reservations. Count that stock
// once; relocation/putaway tasks without reservations still consume headroom.
export async function unreservedPendingTaskQuantity(balanceId, session, excludeTaskId) {
  const pending = await pendingTaskQuantity(balanceId, session, excludeTaskId);
  const tasks = await TransferOrder.find({ ...(excludeTaskId && {_id:{$ne:excludeTaskId}}), workflowStatus:{$in:['OPEN','DRAFT','PARTIAL']}, 'items.details.sourceBalanceId':balanceId }).session(session);
  const reservations = await StockReservation.find({balanceId,'executionRef.documentType':'transfer_orders','executionRef.documentId':{$in:tasks.map(t=>t._id)}}).session(session);
  const covered=reservations.reduce((n,r)=>n.plus(remainingReservation(r)),exact('0'));
  return pending.gt(covered)?pending.minus(covered):exact('0');
}
export function heldOnBalance(reports, balanceId, excludeHoldId) {
  return reports.reduce((sum, report) => sum.plus(report.holds.filter(hold => hold.status === 'ACTIVE' && !same(hold._id, excludeHoldId)).reduce((n, hold) => {
    const allocation = hold.allocations.filter(row => same(row.balanceId, balanceId)).reduce((v, row) => v.plus(String(row.quantityBase)), exact('0'));
    const resolved = hold.allocations.length === 1 ? hold.events.filter(event => ['RELEASED','CONSUMED','RECEIVED'].includes(event.kind)).reduce((v,event) => v.plus(String(event.quantityBase)), exact('0')) : exact('0');
    return n.plus(allocation.gt(resolved) ? allocation.minus(resolved) : '0');
  }, exact('0'))), exact('0'));
}
export async function heldQuantity(balanceId, session, excludeHoldId) {
  const reports = await DefectReport.find({ holds: { $elemMatch: { status: 'ACTIVE', 'allocations.balanceId': balanceId } } }).session(session);
  return heldOnBalance(reports, balanceId, excludeHoldId);
}
export function beginStock(document, user, operation, input) {
  const requestHash = hash({ document: String(document._id), operation, input });
  return new StockTransaction({ sourceType: document.constructor.collection.name, sourceId: document._id,
    operation, eventKey: String(document.version), requestKey: hash({ user: String(user._id), document: String(document._id), operation, key: input.operationKey ?? input.idempotencyKey }),
    requestHash, performedBy: user._id, occurredAt: new Date(), recordedAt: new Date(), movements: [] });
}

// Outbound may open cartons; explicit LOOSE relocation may split existing loose
// stock with conservative volume bounds. Other movements keep whole portions.
export function splitPortions(portions, quantity, actorId, { allowOpening = false, allowLooseSplit = false } = {}) {
  let remaining = exact(quantity);
  const kept = [], taken = [];
  const ordered = allowOpening ? [...portions].sort((a, b) => Number(a.packagingState === 'SEALED') - Number(b.packagingState === 'SEALED')) : portions;
  for (const original of ordered) {
    const portion = original.toObject ? original.toObject() : { ...original };
    const available = exact(portion.quantityBase);
    if (remaining.isZero()) { kept.push(portion); continue; }
    if (remaining.gte(available)) { taken.push(portion); remaining = remaining.minus(available); continue; }
    if ((allowOpening || (allowLooseSplit && portion.packagingState === 'LOOSE')) && (portion.packagingState !== 'SEALED' || portion.measuredVolumeMm3 != null || exact(portion.extraOccupiedVolumeMm3 || '0').gt(0) || !remaining.div(String(portion.packagingSnapshot?.baseUnitsPerPackage || '1')).isInteger())) {
      const snapshot = portion.packagingSnapshot;
      const cartonVolume = snapshot?.outerLengthMm && snapshot.outerWidthMm && snapshot.outerHeightMm
        ? exact(String(snapshot.outerLengthMm)).mul(String(snapshot.outerWidthMm)).mul(String(snapshot.outerHeightMm)) : null;
      const perPack = exact(String(snapshot?.baseUnitsPerPackage || '1'));
      const cartonBound = cartonVolume?.mul(available.div(perPack).ceil());
      let bound = portion.measuredVolumeMm3 ?? portion.volumeUpperBoundMm3 ?? cartonBound?.toFixed();
      if (portion.packagingState === 'SEALED' && cartonBound && (bound == null || cartonBound.gt(String(bound)))) bound = cartonBound.toFixed();
      if (bound == null || !exact(bound).gt(0)) throw validationError('Thiếu kích thước hoặc giới hạn thể tích đã biết để mở/tách thùng');
      const open = (qty, id, upperBound) => ({ ...portion, _id: id, packagingState: portion.packagingState === 'LOOSE' ? 'LOOSE' : 'OPEN', quantityBase: qty.toFixed(),
        sealedPackCount: undefined, measuredVolumeMm3: undefined, extraOccupiedVolumeMm3: undefined,
        volumeUpperBoundMm3: exact(upperBound).plus(String(portion.extraOccupiedVolumeMm3 || '0')).mul(1000000).ceil().div(1000000).toFixed(), updatedBy: actorId });
      if (portion.packagingState === 'SEALED' && cartonVolume && portion.measuredVolumeMm3 == null && !exact(portion.extraOccupiedVolumeMm3 || '0').gt(0)) {
        const wholeTaken = remaining.dividedToIntegerBy(perPack), looseTaken = remaining.mod(perPack), wholeKept = exact(portion.sealedPackCount).minus(wholeTaken).minus(1);
        if (wholeTaken.gt(0)) taken.push({ ...portion, _id: newId(), sealedPackCount: wholeTaken.toNumber(), quantityBase: wholeTaken.mul(perPack).toFixed(), updatedBy: actorId });
        taken.push(open(looseTaken, newId(), cartonVolume));
        if (wholeKept.gt(0)) kept.push({ ...portion, sealedPackCount: wholeKept.toNumber(), quantityBase: wholeKept.mul(perPack).toFixed(), updatedBy: actorId });
        kept.push(open(perPack.minus(looseTaken), wholeKept.gt(0) ? newId() : portion._id, cartonVolume));
      } else {
        taken.push(open(remaining, newId(), bound));
        kept.push(open(available.minus(remaining), portion._id, bound));
      }
      remaining = exact('0'); continue;
    }
    if (portion.packagingState !== 'SEALED' || portion.measuredVolumeMm3 != null || exact(portion.extraOccupiedVolumeMm3 ?? '0').gt(0)) {
      throw validationError('Phần hàng mở/lẻ cần được đo và tách quy cách trước khi chuyển một phần');
    }
    const packs = remaining.div(String(portion.packagingSnapshot.baseUnitsPerPackage));
    if (!packs.isInteger()) throw validationError('Không tự mở thùng; chọn lượng nguyên thùng hoặc phần hàng lẻ đã đo');
    taken.push({ ...portion, _id: newId(), sealedPackCount: packs.toNumber(), quantityBase: remaining.toFixed(), updatedBy: actorId });
    kept.push({ ...portion, sealedPackCount: portion.sealedPackCount - packs.toNumber(), quantityBase: available.minus(remaining).toFixed(), updatedBy: actorId });
    remaining = exact('0');
  }
  if (!remaining.isZero()) throw validationError('Quy cách tồn không đủ số lượng');
  return { kept, taken };
}
export function retainPortions(balance, kept) {
  const keptIds = new Set(kept.map(row => String(row._id)));
  balance.packagingPortions.pull(...balance.packagingPortions.filter(row => !keptIds.has(String(row._id))).map(row => row._id));
  for (const portion of kept) {
    const retained = balance.packagingPortions.id(portion._id);
    if (!retained) { balance.packagingPortions.push(portion); continue; }
    for (const field of ['quantityBase', 'packagingState', 'sealedPackCount', 'measuredVolumeMm3', 'volumeUpperBoundMm3', 'extraOccupiedVolumeMm3', 'updatedBy']) retained[field] = portion[field];
  }
}
async function saveBalance(balance, beforeVersion, session) {
  await balance.validate();
  const result = await InventoryBalance.updateOne({ _id: balance._id, version: beforeVersion },
    { $set: { quantityBase: balance.quantityBase, packagingPortions: balance.packagingPortions }, $inc: { version: 1 } }, { session });
  if (result.matchedCount !== 1) throw versionConflict('Tồn đã thay đổi');
}
export async function moveStock(sourceId, destinationId, quantity, itemId, stockTransaction, user, session, { preserveReservations = false, excludeTaskId, portionIds, allowOpening = false, packagingState } = {}) {
  if (same(sourceId, destinationId)) throw validationError('Nguồn và đích phải khác nhau');
  const source = await InventoryBalance.findById(sourceId).session(session);
  const destination = await InventoryBalance.findById(destinationId).session(session);
  if (!source || !destination || !same(source.batchId, destination.batchId) || source.ownerType !== destination.ownerType || String(source.ownerId) !== String(destination.ownerId)) throw validationError('Không đổi lô hoặc chủ hàng khi chuyển tồn');
  const amount = exact(quantity), from = exact(source.quantityBase), to = exact(destination.quantityBase);
  const batch = await ProductBatch.findById(source.batchId).session(session);
  const product = batch && await Product.findById(batch.productId).session(session);
  if (!product || (product.wholeBaseUnits && !amount.isInteger())) throw validationError('Lượng chuyển không đúng đơn vị gốc');
  if (!amount.gt(0) || amount.gt(from)) throw validationError('Không đủ tồn nguồn');
  const reservations = await StockReservation.find({ balanceId: sourceId }).session(session);
  const reserved = reservations.reduce((sum,row) => sum.plus(remainingReservation(row)), exact('0'));
  const pending = await unreservedPendingTaskQuantity(sourceId, session, excludeTaskId);
  if (amount.plus(pending).plus(preserveReservations ? '0' : reserved).plus(await heldQuantity(sourceId, session)).gt(from)) throw validationError('Lượng chuyển thuộc phần hàng đang bị chặn');
  if (amount.plus(pending).plus(preserveReservations ? '0' : reserved).gt(from)) throw validationError('Tồn đã được giữ hoặc lập lệnh khác');
  // portionIds limits the split to the portions of one source line (e.g. one receipt line in a shared receiving balance).
  const inPool = row => (portionIds === undefined || portionIds.some(id => same(id, row._id))) && (!packagingState || row.packagingState === packagingState);
  const split = splitPortions(source.packagingPortions.filter(inPool), amount, user._id, { allowOpening, allowLooseSplit: packagingState === 'LOOSE' });
  const kept = [...source.packagingPortions.filter(row => !inPool(row)).map(row => row.toObject ? row.toObject() : { ...row }), ...split.kept], taken = split.taken;
  // Retain existing subdocuments rather than recasting their immutable creation
  // timestamps when an earlier portion is removed from the array.
  retainPortions(source, kept);
  destination.packagingPortions.push(...taken);
  source.quantityBase = from.minus(amount).toFixed(); destination.quantityBase = to.plus(amount).toFixed();
  const movementId = newId();
  if (preserveReservations) {
    let toMove = amount.minus(from.minus(reserved));
    for (const reservation of reservations) {
      if (toMove.lte(0)) break;
      const available = remainingReservation(reservation), portion = available.lt(toMove) ? available : toMove;
      if (!portion.gt(0)) continue;
      const result = await StockReservation.updateOne({ _id: reservation._id, version: reservation.version },
        { $set: { movedQty: exact(reservation.movedQty).plus(portion).toFixed(), updatedBy: user._id }, $inc: { version: 1 } }, { session });
      if (result.matchedCount !== 1) throw versionConflict('Giữ hàng đã thay đổi');
      await new StockReservation({ demandRef: reservation.demandRef, executionRef: reservation.executionRef,
        balanceId: destinationId, reservedQty: portion.toFixed(), previousReservationId: reservation._id,
        sourceAllocationId: reservation.sourceAllocationId, originMovementId: movementId,
        creationKey: hash({ movement: String(movementId), source: String(reservation._id) }), createdBy: user._id }).save({ session });
      toMove = toMove.minus(portion);
    }
  }
  await saveBalance(source, source.version, session);
  await saveBalance(destination, destination.version, session);
  stockTransaction.movements.push({ _id: movementId, transactionId: stockTransaction._id, lineNo: stockTransaction.movements.length + 1,
    sourceLineId: itemId, fromBalanceId: sourceId, toBalanceId: destinationId, quantityBase: amount.toFixed(),
    fromBefore: from.toFixed(), fromAfter: source.quantityBase, toBefore: to.toFixed(), toAfter: destination.quantityBase });
  return destination;
}
export async function verifyCapacity(locationIds, session) {
  const points = await StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locationIds } }).session(session).lean();
  const balances = await InventoryBalance.find({ holdingPointId: { $in: points.map(point => point._id) } }).session(session).lean();
  const locations = await WarehouseLocation.find({ _id: { $in: locationIds } }).session(session).lean();
  const warehouses = await Warehouse.find({ _id: { $in: locations.map(location => location.warehouseId) } }).session(session).lean();
  const batches = await ProductBatch.find({ _id: { $in: balances.map(balance => balance.batchId) } }).session(session).lean();
  try { checkBinCapacity({ stock_holding_points: points, inventory_balances: balances, warehouse_locations: locations, warehouses, product_batches: batches }); }
  catch (error) { throw validationError(error.message); }
}

const missingVolumeDimensions = 'Thiếu kích thước lô/sản phẩm, cần nhập thể tích thực đo';
function isPositiveDecimal(value) {
  const decimal = exact(value ?? 0);
  return decimal.isFinite() && decimal.gt(0);
}

function estimateVolume(state, quantity, batch, product) {
  const dims = state === 'OPEN'
    ? [batch?.cartonLengthMm, batch?.cartonWidthMm, batch?.cartonHeightMm]
    : [product?.lengthMm, product?.widthMm, product?.heightMm];
  if (!dims.every(isPositiveDecimal) || (state === 'OPEN' && !isPositiveDecimal(batch?.piecesPerCarton))) {
    throw validationError(missingVolumeDimensions);
  }
  const units = state === 'OPEN' ? exact(quantity).div(batch.piecesPerCarton).ceil() : exact(quantity);
  return dims.reduce((volume, dim) => volume.mul(String(dim)), units).toDecimalPlaces(3).toFixed();
}

export async function receiveStock(balance, item, portions, posting, user, session, condition) {
  const batch = await ProductBatch.findById(balance.batchId).session(session);
  const product = batch && await Product.findById(batch.productId).session(session);
  const amount = exact(item.qtyBase);
  if ((!batch || !product) && (!portions?.length || portions.some(row => row.packagingState !== 'SEALED' && row.measuredVolumeMm3 == null))) {
    throw validationError(missingVolumeDimensions);
  }
  if (!batch || batch.identificationStatus !== 'VERIFIED' || !product?.isActive || !same(batch.productId, item.productId) || (product.wholeBaseUnits && !amount.isInteger())) throw validationError('Lô hoặc lượng nhập không hợp lệ');
  let packaging = portions;
  if (!packaging?.length) {
    const cartonDims = [batch.cartonLengthMm, batch.cartonWidthMm, batch.cartonHeightMm];
    const hasCartonSize = isPositiveDecimal(batch.piecesPerCarton) && cartonDims.every(isPositiveDecimal);
    const packagingSnapshot = hasCartonSize ? { packageUnit: 'Thùng', baseUnitsPerPackage: String(batch.piecesPerCarton),
      outerLengthMm: batch.cartonLengthMm, outerWidthMm: batch.cartonWidthMm, outerHeightMm: batch.cartonHeightMm } : undefined;
    if (condition === 'LOOSE' || ['OPENED', 'TORN', 'UNKNOWN'].includes(condition)) {
      packaging = [{ packagingState: condition === 'LOOSE' ? 'LOOSE' : 'OPEN', quantityBase: amount.toFixed(), packagingSnapshot }];
    } else {
      if (!isPositiveDecimal(batch.piecesPerCarton)) throw validationError(missingVolumeDimensions);
      const perCarton = exact(batch.piecesPerCarton);
      const fullCartons = amount.dividedToIntegerBy(perCarton);
      const looseQty = amount.mod(perCarton);
      packaging = [];
      if (fullCartons.gt(0)) {
        if (!hasCartonSize) throw validationError(missingVolumeDimensions);
        packaging.push({ packagingState: 'SEALED', sealedPackCount: fullCartons.toNumber(), quantityBase: fullCartons.mul(perCarton).toFixed(), packagingSnapshot });
      }
      if (looseQty.gt(0)) {
        packaging.push({ packagingState: 'LOOSE', quantityBase: looseQty.toFixed(), packagingSnapshot });
      }
    }
  }
  if (!packaging.reduce((sum,row) => sum.plus(String(row.quantityBase)), exact('0')).eq(amount)) throw validationError('Tổng quy cách khác lượng thực nhập');
  const received = packaging.map(row => ({
    ...row,
    ...(row.packagingState !== 'SEALED' && row.measuredVolumeMm3 == null
      ? { measuredVolumeMm3: estimateVolume(row.packagingState, row.quantityBase, batch, product) }
      : {}),
    _id: newId(),
    createdBy: user._id,
  }));
  const before = exact(balance.quantityBase);
  balance.quantityBase = before.plus(amount).toFixed();
  balance.packagingPortions.push(...received);
  await saveBalance(balance, balance.version, session);
  posting.movements.push({ transactionId: posting._id, lineNo: posting.movements.length + 1,
    packagingPortionIds: received.map(row=>row._id), sourceLineId: item._id, toBalanceId: balance._id, quantityBase: amount.toFixed(), toBefore: before.toFixed(), toAfter: balance.quantityBase });
}
