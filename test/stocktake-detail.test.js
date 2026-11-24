import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as models from '../src/models/runtime.js';
import { getStocktake } from '../src/modules/stocktake-closure/stocktake-closure.service.js';

const warehouseId = 'a'.repeat(24), locationId = 'b'.repeat(24), batchId = 'c'.repeat(24), productId = 'd'.repeat(24);
const stocktakeId = 'KK - T - 261115 - 000001';
const user = (code = 'WAREHOUSE', warehouseIds = [warehouseId], permissions = ['stocktake:read']) => ({
  isActive: true, warehouseIds, roleId: { code, permissionIds: permissions.map(code => ({ code })) },
});
const snapshot = { _id: 'e'.repeat(24), locationId, batchId, bookQtyBase: '9007199254740993.25', baseUnitSnapshot: 'PIECE', origin: 'BOOK' };
const document = {
  _id: stocktakeId, documentNo: stocktakeId, workflowStatus: 'RECONCILING',
  header: { warehouseId, scopeVersion: 2, scopeLocationIds: [locationId] },
};
const query = rows => ({ select: () => ({ lean: async () => rows }) });

function setup({ record = document, snapshots = [snapshot], missing = false } = {}) {
  const scope = { stocktakeId, scopeVersion: 2 };
  const lookups = [];
  mock.method(models.Stocktake, 'findById', id => {
    assert.equal(id, stocktakeId);
    return { session: async () => record };
  });
  mock.method(models.StocktakeSnapshot, 'find', filter => { assert.deepEqual(filter, scope); return Promise.resolve(snapshots); });
  mock.method(models.StocktakeCount, 'find', filter => {
    assert.deepEqual(filter, scope);
    return { sort: async order => { assert.deepEqual(order, { attemptNo: -1 }); return []; } };
  });
  mock.method(models.StocktakeLocationLock, 'find', filter => { assert.deepEqual(filter, scope); return Promise.resolve([]); });
  mock.method(models.Warehouse, 'find', filter => {
    lookups.push(filter);
    assert.deepEqual(filter, { _id: warehouseId });
    return query(missing ? [] : [{ _id: warehouseId, code: 'WH-T', name: 'Test warehouse' }]);
  });
  mock.method(models.WarehouseLocation, 'find', filter => {
    lookups.push(filter);
    assert.deepEqual(filter, { _id: { $in: [locationId] }, warehouseId });
    return query(missing ? [] : [{ _id: locationId, warehouseId, code: 'A-01', name: 'Test location' }]);
  });
  mock.method(models.ProductBatch, 'find', filter => {
    lookups.push(filter);
    assert.deepEqual(filter, { _id: { $in: snapshots.length ? [batchId] : [] } });
    return query(missing || !snapshots.length ? [] : [{ _id: batchId, productId, manufacturerLot: 'LOT-T' }]);
  });
  mock.method(models.Product, 'find', filter => {
    lookups.push(filter);
    assert.deepEqual(filter, { _id: { $in: missing || !snapshots.length ? [] : [productId] } });
    return query(missing || !snapshots.length ? [] : [{ _id: productId, sku: 'SKU-T', name: 'Test tile', baseUnit: 'PIECE' }]);
  });
  mock.method(models.Conversion, 'find', () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }));
  mock.method(models.Uom, 'find', () => query([{ _id: 'f'.repeat(24), code: 'PIECE', name: 'Viên' }]));
  mock.method(models.InventoryBalance, 'find', () => assert.fail('Stocktake detail must not query current balances'));
  return lookups;
}

afterEach(() => mock.restoreAll());

test('detail has projected labels with stocktake-only permission and preserves frozen decimal/unit', async () => {
  const lookups = setup();
  const result = await getStocktake(user(), stocktakeId);
  assert.deepEqual(result.lookups, {
    warehouses: [{ id: warehouseId, code: 'WH-T', name: 'Test warehouse' }],
    locations: [{ id: locationId, warehouseId, code: 'A-01', name: 'Test location' }],
    batches: [{ id: batchId, productId, manufacturerLot: 'LOT-T' }],
    products: [{ id: productId, sku: 'SKU-T', name: 'Test tile', uomCode: 'PIECE', uomName: 'Viên' }],
    units: [{ id: 'f'.repeat(24), code: 'PIECE', name: 'Viên' }],
    conversions: [],
  });
  assert.equal(lookups.length, 4);
  assert.equal(result.snapshots[0].bookQtyBase, snapshot.bookQtyBase);
  assert.equal(result.snapshots[0].baseUnitSnapshot, 'PIECE');
  assert.equal(result.snapshots[0].uomName, 'Viên');
  assert.equal(result.lines[0].bookQtyBase, snapshot.bookQtyBase);
  assert.equal(result.lines[0].uomCode, 'PIECE');
  assert.equal(document.workflowStatus, 'RECONCILING');
});

test('denied warehouse is rejected before snapshot or label reads', async () => {
  const lookups = setup();
  await assert.rejects(getStocktake(user('WAREHOUSE', []), stocktakeId), error => error.statusCode === 403);
  assert.equal(lookups.length, 0);
  assert.equal(models.StocktakeSnapshot.find.mock.callCount(), 0);
});

test('missing permission is rejected before reading the document', async () => {
  setup();
  await assert.rejects(getStocktake(user('WAREHOUSE', [warehouseId], []), stocktakeId), error => error.statusCode === 403);
  assert.equal(models.Stocktake.findById.mock.callCount(), 0);
});

test('owner may inspect a warehouse without assignment; missing references remain empty', async () => {
  setup({ missing: true });
  const result = await getStocktake(user('OWNER', []), stocktakeId);
  assert.deepEqual(result.lookups, { warehouses: [], locations: [], batches: [], products: [], units: [{ id: 'f'.repeat(24), code: 'PIECE', name: 'Viên' }], conversions: [] });
  assert.equal(result.snapshots[0].id, snapshot._id);
});

test('empty snapshot scope does not query unrelated products or batches', async () => {
  setup({ snapshots: [] });
  const result = await getStocktake(user(), stocktakeId);
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(result.lookups.batches, []);
  assert.deepEqual(result.lookups.products, []);
});

test('missing stocktake returns not found before related reads', async () => {
  const lookups = setup({ record: null });
  await assert.rejects(getStocktake(user(), stocktakeId), error => error.statusCode === 404);
  assert.equal(lookups.length, 0);
});
