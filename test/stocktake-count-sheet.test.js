import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as models from '../src/models/runtime.js';
import { getCountSheet } from '../src/modules/stocktake-closure/stocktake-count-sheet.service.js';

const id = value => new mongoose.Types.ObjectId(value);
const hex = char => char.repeat(24);
const warehouseId = hex('a'), loc1 = hex('b'), loc2 = hex('c'), loc3 = hex('d'), batch1 = hex('e'), batch2 = hex('f'), product1 = hex('1'), product2 = hex('2');
const counterId = hex('3'), otherCounterId = hex('4'), supplierId = hex('5');
const ST = 'KK - T - 261115 - 000001';
const user = (code = 'WAREHOUSE', warehouseIds = [warehouseId], permissions = ['stocktake:export'], _id = counterId) => ({
  _id: id(_id), isActive: true, warehouseIds, roleId: { code, isActive: true, permissionIds: permissions.map(code => ({ code })) },
});
const rows = value => ({ select: () => ({ lean: async () => value }) });
const document = (header = {}, workflowStatus = 'COUNTING') => ({
  _id: ST, documentNo: ST, workflowStatus,
  header: { warehouseId: id(warehouseId), scopeVersion: 2, scopeLocationIds: [id(loc2), id(loc1), id(loc3)], cutoffAt: new Date('2026-11-14T00:00:00Z'), activatedAt: new Date('2026-11-14T00:00:00Z'), assignedCounterIds: [id(counterId)], ...header },
});
const snapshot = (n, overrides = {}) => ({ _id: id(String(n).repeat(24)), locationId: id(loc1), batchId: id(batch1), ownerType: 'STORE', qualityStatus: 'GOOD', baseUnitSnapshot: 'PIECE', bookQtyBase: '12', ...overrides });

function setup({ record = document(), snapshots = [snapshot(6), snapshot(7, { batchId: id(batch2), ownerType: 'SUPPLIER', ownerId: id(supplierId), qualityStatus: 'DAMAGED', baseUnitSnapshot: 'BOX', bookQtyBase: '3' }), snapshot(8, { locationId: id(loc2) })] } = {}) {
  const calls = {};
  mock.method(models.Stocktake, 'findById', value => { calls.id = value; return { select: () => ({ lean: async () => record }) }; });
  mock.method(models.StocktakeSnapshot, 'find', filter => { calls.snapshots = filter; return { select: fields => { calls.snapshotFields = fields; return { lean: async () => snapshots }; } }; });
  mock.method(models.ProductBatch, 'find', () => rows([{ _id: id(batch1), productId: id(product1), manufacturerLot: 'LOT-1' }, { _id: id(batch2), productId: id(product2), manufacturerLot: 'LOT-2' }]));
  mock.method(models.Product, 'find', () => rows([{ _id: id(product1), sku: 'SKU-A', name: 'Tile A' }, { _id: id(product2), sku: 'SKU-B', name: 'Tile B' }]));
  mock.method(models.Warehouse, 'find', () => rows([{ _id: id(warehouseId), code: 'WH-T', name: 'Test warehouse' }]));
  mock.method(models.WarehouseLocation, 'find', () => rows([{ _id: id(loc1), code: 'A-01', name: 'Aisle 1' }, { _id: id(loc2), code: 'A-02', name: 'Aisle 2' }, { _id: id(loc3), code: 'A-03', name: 'Aisle 3' }]));
  mock.method(models.User, 'find', () => rows([{ _id: id(counterId), username: 'staff', fullName: 'Staff One' }]));
  mock.method(models.Supplier, 'find', () => rows([{ _id: id(supplierId), code: 'SUP-1', name: 'Supplier One' }]));
  mock.method(models.Uom, 'find', () => rows([{ code: 'PIECE', name: 'Viên' }, { code: 'BOX', name: 'Thùng' }]));
  mock.method(models.Customer, 'find', () => assert.fail('No customer-owned snapshot exists'));
  // Reads must never write or read counts, locks or current balances.
  for (const model of [models.Stocktake, models.StocktakeSnapshot, models.StocktakeCount, models.StocktakeLocationLock, models.InventoryBalance])
    for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'bulkWrite'])
      mock.method(model, method, () => assert.fail(`${model.modelName}.${method} must not be called by a read`));
  for (const model of [models.StocktakeCount, models.StocktakeLocationLock, models.InventoryBalance])
    mock.method(model, 'find', () => assert.fail(`${model.modelName} must not be read for a count sheet`));
  return calls;
}
afterEach(() => mock.restoreAll());

test('sheet groups frozen snapshot rows by location, keeps empty locations and carries the book quantity with its unit (blind count removed 22 Nov 2026)', async () => {
  const calls = setup();
  const sheet = await getCountSheet(user(), ST);
  assert.deepEqual(calls.snapshots, { stocktakeId: ST, scopeVersion: 2, origin: 'BOOK' });
  assert.equal(calls.snapshotFields.includes('bookQtyBase'), true);
  assert.deepEqual(sheet.stocktake, { id: ST, documentNo: ST, workflowStatus: 'COUNTING', scopeVersion: 2, cutoffAt: '2026-11-14T00:00:00.000Z', activatedAt: '2026-11-14T00:00:00.000Z' });
  assert.deepEqual(sheet.warehouse, { id: warehouseId, code: 'WH-T', name: 'Test warehouse' });
  assert.deepEqual(sheet.counters, [{ id: counterId, username: 'staff', fullName: 'Staff One' }]);
  assert.deepEqual(sheet.locations.map(row => [row.code, row.rows.length, row.emptyConfirmation]), [['A-01', 2, false], ['A-02', 1, false], ['A-03', 0, true]]);
  assert.deepEqual(sheet.locations[0].rows[1], {
    snapshotId: '7'.repeat(24), productId: product2, sku: 'SKU-B', productName: 'Tile B', batchId: batch2, manufacturerLot: 'LOT-2', qualityStatus: 'DAMAGED',
    ownerType: 'SUPPLIER', ownerId: supplierId, owner: { code: 'SUP-1', name: 'Supplier One' }, baseUnit: 'BOX', uomCode: 'BOX', uomName: 'Thùng', bookQtyBase: '3',
  });
  assert.equal(sheet.locations[0].rows[0].owner, null);
  assert.equal(sheet.locations[0].rows[0].ownerId, null);
  assert.equal(sheet.locations[2].locationId, loc3);
  assert.equal(sheet.locations[0].rows[0].bookQtyBase, '12');
  assert.equal(sheet.locations[0].rows[0].uomName, 'Viên');
});

test('an activated session whose scope was empty at cutoff lists only empty-location rows', async () => {
  setup({ snapshots: [] });
  const sheet = await getCountSheet(user(), ST);
  assert.equal(sheet.locations.length, 3);
  assert.equal(sheet.locations.every(row => row.emptyConfirmation && row.rows.length === 0), true);
});

test('missing stocktake:export is refused before the document is read', async () => {
  setup();
  await assert.rejects(getCountSheet(user('WAREHOUSE', [warehouseId], ['stocktake:read']), ST), error => error.statusCode === 403);
  assert.equal(models.Stocktake.findById.mock.callCount(), 0);
});

test('unknown stocktake is not found', async () => {
  setup({ record: null });
  await assert.rejects(getCountSheet(user(), ST), error => error.statusCode === 404);
  assert.equal(models.StocktakeSnapshot.find.mock.callCount(), 0);
});

test('unassigned warehouse is refused before counter check or snapshot read', async () => {
  setup();
  await assert.rejects(getCountSheet(user('WAREHOUSE', [hex('9')]), ST), error => error.statusCode === 403 && error.code === 'ERR-CORE-403-002');
  assert.equal(models.StocktakeSnapshot.find.mock.callCount(), 0);
});

test('staff who is not an assigned counter is refused; owner is exempt', async () => {
  setup();
  await assert.rejects(getCountSheet(user('WAREHOUSE', [warehouseId], ['stocktake:export'], otherCounterId), ST), error => error.statusCode === 403 && error.code === 'ERR-CORE-403-001');
  assert.equal(models.StocktakeSnapshot.find.mock.callCount(), 0);
  const sheet = await getCountSheet(user('OWNER', [], ['stocktake:export'], otherCounterId), ST);
  assert.equal(sheet.locations.length, 3);
});

test('session without a snapshot (not activated) is refused with a validation error', async () => {
  setup({ record: document({ activatedAt: undefined }, 'PLANNED') });
  await assert.rejects(getCountSheet(user(), ST), error => error.statusCode === 400 && /chưa kích hoạt/.test(error.message));
  assert.equal(models.StocktakeSnapshot.find.mock.callCount(), 0);
});

test('producing the sheet twice returns identical content', async () => {
  setup();
  assert.deepEqual(await getCountSheet(user(), ST), await getCountSheet(user(), ST));
});
