import * as m from '../../models/runtime.js';
import { serialize } from '../../shared/utils/persistence.js';
import { isOwner, requirePermission, requireWarehouseAccess } from '../../shared/utils/access.js';
import { idString } from '../../shared/utils/domain.js';
import { forbiddenError, notFoundError, validationError } from '../../shared/utils/ApiError.js';

const ids = rows => [...new Set(rows.filter(value => value != null).map(String))];
const byCode = (a, b) => String(a.code ?? '~').localeCompare(String(b.code ?? '~')) || a.locationId.localeCompare(b.locationId);

/**
 * Count sheet built from the activation snapshot (UC-121). Read-only: no count, lock or current balance is
 * read. Since 22 Nov 2026 the book quantity is no longer hidden from counters, so each row carries it with
 * the base unit code and name; printed sheets may still omit the column.
 */
export async function getCountSheet(user, id) {
  requirePermission(user, 'stocktake:export');
  const document = await m.Stocktake.findById(id).select('documentNo workflowStatus header').lean();
  if (!document) throw notFoundError();
  const header = serialize(document.header);
  requireWarehouseAccess(user, header.warehouseId);
  if (!isOwner(user) && !(header.assignedCounterIds || []).some(counterId => idString(counterId) === idString(user._id)))
    throw forbiddenError('Bạn không được phân công đếm trong đợt kiểm kê này');
  // Snapshots are captured at activation only, so an unactivated session has none.
  if (!header.activatedAt) throw validationError('Đợt kiểm kê chưa kích hoạt nên chưa có mốc tồn để lập phiếu đếm');

  // Only BOOK entries exist at the cutoff; discovered rows are recorded later by counters.
  const snapshots = serialize(await m.StocktakeSnapshot.find({ stocktakeId: document._id, scopeVersion: header.scopeVersion, origin: 'BOOK' })
    .select('_id locationId batchId ownerType ownerId qualityStatus baseUnitSnapshot bookQtyBase').lean());
  const batches = serialize(await m.ProductBatch.find({ _id: { $in: ids(snapshots.map(row => row.batchId)) } }).select('_id productId manufacturerLot').lean());
  const supplierIds = ids(snapshots.filter(row => row.ownerType === 'SUPPLIER').map(row => row.ownerId));
  const customerIds = ids(snapshots.filter(row => row.ownerType === 'CUSTOMER').map(row => row.ownerId));
  const [warehouses, locations, products, counters, suppliers, customers] = await Promise.all([
    m.Warehouse.find({ _id: header.warehouseId }).select('_id code name').lean(),
    m.WarehouseLocation.find({ _id: { $in: header.scopeLocationIds }, warehouseId: header.warehouseId }).select('_id code name').lean(),
    m.Product.find({ _id: { $in: ids(batches.map(row => row.productId)) } }).select('_id sku name').lean(),
    m.User.find({ _id: { $in: header.assignedCounterIds || [] } }).select('_id username fullName').lean(),
    supplierIds.length ? m.Supplier.find({ _id: { $in: supplierIds } }).select('_id code name').lean() : [],
    customerIds.length ? m.Customer.find({ _id: { $in: customerIds } }).select('_id code name').lean() : [],
  ]);

  const unitNames = new Map((await m.Uom.find({ code: { $in: ids(snapshots.map(row => row.baseUnitSnapshot)) } }).select('code name').lean()).map(row => [row.code, row.name]));
  const batchById = new Map(batches.map(row => [String(row._id), row]));
  const productById = new Map(products.map(row => [String(row._id), row]));
  const locationById = new Map(locations.map(row => [String(row._id), row]));
  const owners = new Map([...suppliers, ...customers].map(row => [String(row._id), { code: row.code, name: row.name }]));
  const rowsByLocation = new Map();
  for (const snapshot of snapshots) {
    const batch = batchById.get(String(snapshot.batchId)), product = batch && productById.get(String(batch.productId));
    const rows = rowsByLocation.get(String(snapshot.locationId)) || [];
    rows.push({
      snapshotId: String(snapshot._id), productId: batch ? String(batch.productId) : null, sku: product?.sku ?? null, productName: product?.name ?? null,
      batchId: String(snapshot.batchId), manufacturerLot: batch?.manufacturerLot ?? null, qualityStatus: snapshot.qualityStatus,
      ownerType: snapshot.ownerType, ownerId: snapshot.ownerId ?? null, owner: owners.get(String(snapshot.ownerId)) ?? null,
      baseUnit: snapshot.baseUnitSnapshot, uomCode: snapshot.baseUnitSnapshot ?? null, uomName: unitNames.get(snapshot.baseUnitSnapshot) ?? null, bookQtyBase: String(snapshot.bookQtyBase),
    });
    rowsByLocation.set(String(snapshot.locationId), rows);
  }
  const sheetLocations = ids(header.scopeLocationIds).map(locationId => {
    const location = locationById.get(locationId), rows = rowsByLocation.get(locationId) || [];
    rows.sort((a, b) => String(a.sku ?? '~').localeCompare(String(b.sku ?? '~')) || String(a.manufacturerLot ?? '').localeCompare(String(b.manufacturerLot ?? '')) || a.snapshotId.localeCompare(b.snapshotId));
    return { locationId, code: location?.code ?? null, name: location?.name ?? null, rows, emptyConfirmation: rows.length === 0 };
  }).sort(byCode);
  const warehouse = warehouses[0];
  return {
    stocktake: { id: String(document._id), documentNo: document.documentNo, workflowStatus: document.workflowStatus, scopeVersion: header.scopeVersion, cutoffAt: header.cutoffAt ?? null, activatedAt: header.activatedAt },
    warehouse: warehouse ? { id: String(warehouse._id), code: warehouse.code, name: warehouse.name } : { id: String(header.warehouseId), code: null, name: null },
    counters: counters.map(row => ({ id: String(row._id), username: row.username, fullName: row.fullName })),
    locations: sheetLocations,
  };
}
