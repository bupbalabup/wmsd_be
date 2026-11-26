import { exact } from '../../models/model-utils.js';
import { stockQuantities } from '../../shared/utils/stock-availability-read.js';
import { stocktakeLockedLocations, remainingReservation } from '../../shared/utils/stock.js';
import { InventoryBalance, ProductBatch, StockHoldingPoint, StockReservation, WarehouseLocation } from '../../models/runtime.js';

/**
 * Read-side aid for the pick confirmation screen: per request line of an OPEN PICK task, the planned quantity and
 * every storage bin (ô) the storekeeper may pick from with its available quantity (own reservation counted back in).
 * The confirm command rechecks everything inside its transaction.
 */
export async function pickPlans(tasks, dispatches) {
  const open = tasks.filter((task) => task.workflowStatus === 'OPEN' && task.header?.taskKind === 'PICK');
  const plans = new Map();
  if (!open.length) return plans;
  const dispatchItems = dispatches.flatMap((dispatch) => dispatch.items ?? []);
  const groupsByTask = new Map();
  for (const task of open) {
    const groups = new Map();
    for (const item of task.items ?? []) {
      const origin = dispatchItems.find((row) => row.lineNo === item.lineNo && String(row.details?.sourceBalanceId) === String(item.details?.sourceBalanceId));
      if (!origin) continue;
      const key = String(origin.details.requestLineId);
      const group = groups.get(key) ?? { requestLineId: key, productId: String(item.productId), productName: item.productNameSnapshot, lotIds: new Set(), baseUnit: item.baseUnitSnapshot, plannedQtyBase: exact('0'), rows: [] };
      group.lotIds.add(String(item.lotId));
      group.plannedQtyBase = group.plannedQtyBase.plus(String(item.qtyBase));
      group.rows.push({ taskLineId: String(item._id), sourceBalanceId: String(item.details.sourceBalanceId), qtyBase: String(item.qtyBase) });
      groups.set(key, group);
    }
    groupsByTask.set(String(task._id), { task, groups });
  }
  const lotIds = [...new Set([...groupsByTask.values()].flatMap(({ groups }) => [...groups.values()].flatMap((group) => [...group.lotIds])))];
  const batches = await ProductBatch.find({ _id: { $in: lotIds }, identificationStatus: 'VERIFIED' }).select('_id manufacturerLot').lean();
  const lotLabel = new Map(batches.map((batch) => [String(batch._id), batch.manufacturerLot]));
  const warehouseIds = [...new Set(open.map((task) => String(task.header.warehouseId)))];
  const locations = await WarehouseLocation.find({ warehouseId: { $in: warehouseIds }, isActive: true, locationType: 'STORAGE' }).select('_id code warehouseId').lean();
  const points = await StockHoldingPoint.find({ locationId: { $in: locations.map((row) => row._id) } }).select('_id locationId').lean();
  const balances = batches.length ? await InventoryBalance.find({ holdingPointId: { $in: points.map((row) => row._id) }, batchId: { $in: batches.map((row) => row._id) },
    ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: { $gt: 0 } }).select('_id holdingPointId batchId quantityBase').lean() : [];
  const [quantities, frozen, reservations] = await Promise.all([
    stockQuantities(balances),
    stocktakeLockedLocations(locations.map((row) => row._id)),
    StockReservation.find({ 'executionRef.documentType': 'transfer_orders', 'executionRef.documentId': { $in: open.map((task) => task._id) } }).lean(),
  ]);
  const locationById = new Map(locations.map((row) => [String(row._id), row]));
  const locationOfPoint = new Map(points.map((row) => [String(row._id), locationById.get(String(row.locationId))]));
  for (const { task, groups } of groupsByTask.values()) {
    plans.set(String(task._id), [...groups.values()].map((group) => {
      const ownedAt = (balanceId) => reservations.filter((row) => String(row.executionRef.documentId) === String(task._id) && String(row.balanceId) === balanceId)
        .reduce((sum, row) => sum.plus(remainingReservation(row)), exact('0'));
      const bins = balances.filter((balance) => group.lotIds.has(String(balance.batchId)) && String(locationOfPoint.get(String(balance.holdingPointId))?.warehouseId) === String(task.header.warehouseId))
        .map((balance) => {
          const location = locationOfPoint.get(String(balance.holdingPointId)), id = String(balance._id), locked = frozen.has(String(location._id));
          const free = locked ? exact('0') : exact(quantities.get(id).free).plus(ownedAt(id));
          return { sourceBalanceId: id, locationCode: location.code, availableQtyBase: (free.lt(0) ? exact('0') : free).toFixed(), lockedByStocktake: locked };
        });
      // A bin already on the task stays listed even if it no longer shows stock, so it can be reduced to zero.
      for (const row of group.rows) if (!bins.some((bin) => bin.sourceBalanceId === row.sourceBalanceId)) bins.push({ sourceBalanceId: row.sourceBalanceId, locationCode: '', availableQtyBase: '0', lockedByStocktake: false });
      return { requestLineId: group.requestLineId, productName: group.productName, lotLabel: [...group.lotIds].map((id) => lotLabel.get(id)).filter(Boolean).join(', ') || undefined,
        baseUnit: group.baseUnit, plannedQtyBase: group.plannedQtyBase.toFixed(), rows: group.rows, bins };
    }));
  }
  return plans;
}
