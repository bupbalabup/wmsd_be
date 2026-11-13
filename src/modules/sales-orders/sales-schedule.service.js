import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { newId, hash } from '../../shared/utils/document-command.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { guardLocations, fifoCandidates } from '../../shared/utils/stock.js';

export const lotLabel = async (lotId, session) => (await m.ProductBatch.findById(lotId).select('manufacturerLot').session(session).lean())?.manufacturerLot ?? String(lotId);

// Split `quantity` of one lot in one warehouse over pick locations, oldest receipt first,
// and hold each part. Throws with the missing quantity when the warehouse cannot cover it.
export async function allocateAndReserve({ order, scheduleId, delivery, line, soLine, warehouse, actor, session }) {
  const candidates = await fifoCandidates(delivery.warehouseId, line.lotId, session);
  let left = exact(line.qtyBase);
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
