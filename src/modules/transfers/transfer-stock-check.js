import { exact } from '../../models/model-utils.js';
import { WarehouseLocation, StockHoldingPoint, InventoryBalance, ProductBatch } from '../../models/runtime.js';
import { stockQuantities } from '../../shared/utils/stock-availability-read.js';

// Sellable stock (GOOD, store-owned, in STORAGE bins) of the given products in one warehouse, grouped by product and lot.
async function warehouseStock(warehouseId, productIds, session, withFree) {
  const locations = await WarehouseLocation.find({ warehouseId, isActive: true, locationType: 'STORAGE' }).select('_id').session(session).lean();
  const points = await StockHoldingPoint.find({ locationId: { $in: locations.map(row => row._id) } }).select('_id').session(session).lean();
  const batches = await ProductBatch.find({ productId: { $in: productIds }, identificationStatus: 'VERIFIED' }).select('_id productId manufacturerLot').session(session).lean();
  const balances = await InventoryBalance.find({ holdingPointId: { $in: points.map(row => row._id) }, batchId: { $in: batches.map(row => row._id) },
    qualityStatus: 'GOOD', ownerType: 'STORE', quantityBase: { $gt: 0 } }).select('_id batchId quantityBase').session(session).lean();
  const quantities = withFree ? await stockQuantities(balances, session) : null;
  const batchById = new Map(batches.map(row => [String(row._id), row]));
  const result = new Map();
  for (const balance of balances) {
    const batch = batchById.get(String(balance.batchId));
    const qty = withFree ? quantities.get(String(balance._id)).free : exact(String(balance.quantityBase));
    const lots = result.get(String(batch.productId)) ?? new Map();
    const lot = lots.get(String(batch._id)) ?? { lotId: String(batch._id), lotLabel: batch.manufacturerLot, qty: exact('0') };
    lot.qty = lot.qty.plus(qty.gt(0) ? qty : '0');
    lots.set(String(batch._id), lot);
    result.set(String(batch.productId), lots);
  }
  return result;
}

// Per request line: free stock at the source (total and per lot) and on-hand stock at the destination.
export async function transferStockCheck(request, session) {
  const productIds = [...new Set(request.items.map(item => String(item.productId)))];
  const [source, destination] = await Promise.all([
    warehouseStock(request.header.sourceWarehouseId, productIds, session, true),
    warehouseStock(request.header.destinationWarehouseId, productIds, session, false),
  ]);
  const sum = lots => [...(lots?.values() ?? [])].reduce((n, lot) => n.plus(lot.qty), exact('0'));
  return request.items.map(item => {
    const lots = source.get(String(item.productId));
    const eligible = [...(lots?.values() ?? [])].filter(lot => !item.lotId || lot.lotId === String(item.lotId));
    return {
      lineId: String(item._id),
      sourceFreeQtyBase: eligible.reduce((n, lot) => n.plus(lot.qty), exact('0')).toFixed(),
      sourceLots: [...(lots?.values() ?? [])].map(lot => ({ lotId: lot.lotId, lotLabel: lot.lotLabel, freeQtyBase: lot.qty.toFixed() })),
      destinationQtyBase: sum(destination.get(String(item.productId))).toFixed(),
    };
  });
}
