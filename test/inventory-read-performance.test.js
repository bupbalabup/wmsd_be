import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as m from '../src/models/runtime.js';
import { inventory, inventoryDetail } from '../src/modules/warehouse-stock/service.js';
import { stockQuantities } from '../src/shared/utils/stock-availability-read.js';
import { listQuery } from '../src/modules/warehouse-stock/validation.js';

afterEach(() => mock.restoreAll());
const id = n => n.toString(16).padStart(24, '0');
const user = (code = 'WAREHOUSE', permissions = ['inventory:read']) => ({
  isActive: true, warehouseIds: [id(1)], roleId: { code, isActive: true, permissionIds: permissions.map(code => ({ code })) },
});
const warehouse = { _id: id(1), name: 'Warehouse', isActive: true };
const location = { _id: id(2), warehouseId: id(1), code: 'A1', isActive: true, isPickable: true };
const point = { _id: id(3), type: 'LOCATION', locationId: id(2) };
const balance = { _id: id(4), holdingPointId: id(3), quantityBase: '100.125', ownerType: 'STORE', qualityStatus: 'GOOD', version: 2,
  batch: { _id: id(5), manufacturerLot: 'LOT', identificationStatus: 'VERIFIED' },
  product: { _id: id(6), name: 'Tile', sku: 'SKU', baseUnit: 'PIECE', isActive: true } };

function setup(rows = [balance], { locks = [] } = {}) {
  const reads = [], session = { withTransaction: async work => work(), endSession: async () => {} };
  mock.method(mongoose, 'startSession', async () => session);
  const chain = (model, value) => ({
    select(fields) { assert.ok(fields && !fields.startsWith('-'), model + ' must select consumed fields'); return this; },
    session(value) { assert.equal(value, session); return this; }, lean: async () => value,
  });
  for (const [Model, value] of [
    [m.Warehouse, [warehouse]], [m.WarehouseLocation, [location]], [m.TransferDispatch, []], [m.StockHoldingPoint, [point]],
    [m.StocktakeLocationLock, locks], [m.StockReservation, []], [m.TransferOrder, []], [m.DefectReport, []], [m.StockTransaction, []],
  ]) mock.method(Model, 'find', query => { reads.push({ model: Model.modelName, query }); return chain(Model.modelName, value); });
  mock.method(m.InventoryBalance, 'aggregate', pipeline => {
    reads.push({ model: 'aggregate', pipeline });
    assert.equal(pipeline[1].$project.packagingPortions, undefined);
    assert.equal(pipeline[1].$project.quantityBase, 1);
    for (const stage of pipeline.filter(stage => stage.$lookup)) assert.ok(stage.$lookup.pipeline[0].$project);
    const detail = !!pipeline[0].$match._id;
    return { session(value) { assert.equal(value, session); return Promise.resolve(detail ? rows.map(row => ({ ...row, warehouse, location, point })) : [{ items: rows, total: [{ value: rows.length }] }]); } };
  });
  return reads;
}

test('inventory pages use constant batch reads and summary excludes detail data', async () => {
  for (const count of [1, 20, 100]) {
    mock.restoreAll();
    const reads = setup(Array.from({ length: count }, (_, n) => ({ ...balance, _id: id(100 + n) })));
    const result = await inventory(user(), { page: 1, limit: count, view: 'summary' });
    assert.equal(result.total, count);
    assert.equal(reads.length, 9); // scope 4 + aggregation 1 + locks 1 + stock 3 (no open tasks).
    assert.equal(result.items[0].availableQtyBase, '100.125');
    assert.equal(result.items[0].physicalQtyBase, '100.125');
    for (const field of ['reservedQtyBase', 'heldQtyBase', 'pendingQtyBase', 'usableQtyBase', 'version', 'productId']) assert.equal(result.items[0][field], undefined);
    assert.equal(result.warehouses, undefined);
  }
});

test('detail starts at the requested ID, without loading a warehouse-wide scope or a count', async () => {
  const reads = setup();
  const row = await inventoryDetail(user(), id(4));
  assert.equal(reads.length, 5); // targeted aggregation + locks + stock 3.
  assert.equal(reads[0].pipeline[0].$match._id.toString(), id(4));
  assert.ok(!reads[0].pipeline.some(stage => stage.$facet));
  assert.equal(row.reservedQtyBase, '0');
  assert.equal(row.usableQtyBase, '100.125');
  assert.equal(row.version, 2);
  assert.equal(row.locationId, id(2));
});

test('permissions, warehouse scope, missing records and Sales redaction remain enforced', async () => {
  const reads = setup();
  await assert.rejects(inventoryDetail(user('WAREHOUSE', []), id(4)), error => error.statusCode === 403);
  assert.equal(reads.length, 0);
  await assert.rejects(inventoryDetail({ ...user(), warehouseIds: [id(99)] }, id(4)), error => error.statusCode === 404);
  const sales = await inventoryDetail(user('SALES'), id(4));
  for (const field of ['physicalQtyBase', 'reservedQtyBase', 'heldQtyBase', 'quality', 'ownerType', 'version']) assert.equal(sales[field], undefined);
  assert.equal(sales.availableQtyBase, '100.125');
  const pipeline = reads.findLast(row => row.pipeline).pipeline;
  assert.ok(pipeline.some(stage => stage.$match?.['batch.identificationStatus'] === 'VERIFIED'));
  mock.restoreAll(); setup([]);
  await assert.rejects(inventoryDetail(user(), id(4)), error => error.statusCode === 404);
});

test('frozen, nonpickable, inactive, custody, damaged and transit rows cannot become available', async () => {
  for (const change of [{ qualityStatus: 'DAMAGED' }, { ownerType: 'SUPPLIER' }, { product: { ...balance.product, isActive: false } }, { batch: { ...balance.batch, identificationStatus: 'PENDING' } }]) {
    mock.restoreAll();
    const reads = setup([{ ...balance, ...change }]);
    const result = await inventory(user(), { page: 1, limit: 20, view: 'summary' });
    assert.equal(result.items[0].availableQtyBase, '0');
    assert.equal(reads.length, 6); // no stock reads for an ineligible summary row.
  }
  mock.restoreAll();
  setup([balance], { locks: [{ locationId: id(2) }] });
  assert.equal((await inventoryDetail(user(), id(4))).availableQtyBase, '0');
  mock.restoreAll(); setup();
  for (const [target, key, value] of [[location, 'isPickable', false], [warehouse, 'isActive', false], [point, 'type', 'IN_TRANSIT']]) {
    const old = target[key]; target[key] = value;
    try { assert.equal((await inventoryDetail(user(), id(4))).availableQtyBase, '0'); } finally { target[key] = old; }
  }
});

test('stock breakdown keeps partial task, covered reservation and resolved hold arithmetic exact', async () => {
  setup();
  const chain = value => ({ select() { return this; }, session() { return this; }, lean: async () => value });
  mock.method(m.StockReservation, 'find', () => chain([{ balanceId: id(4), reservedQty: '10.25', consumedQty: '2', releasedQty: '0', movedQty: '0', executionRef: { documentType: 'transfer_orders', documentId: 'TO-1' } }]));
  mock.method(m.TransferOrder, 'find', () => chain([{ _id: 'TO-1', items: [{ _id: id(7), qtyBase: '30.5', details: { sourceBalanceId: id(4) } }] }]));
  mock.method(m.StockTransaction, 'find', () => chain([{ sourceId: 'TO-1', movements: [{ sourceLineId: id(7), fromBalanceId: id(4), quantityBase: '5.25' }] }]));
  mock.method(m.DefectReport, 'find', () => chain([{ holds: [{ status: 'ACTIVE', allocations: [{ balanceId: id(4), quantityBase: '4.125' }], events: [{ kind: 'RELEASED', quantityBase: '1.125' }] }] }]));
  const quantities = (await stockQuantities([balance])).get(id(4));
  assert.equal(quantities.reserved.toFixed(), '8.25');
  assert.equal(quantities.pending.toFixed(), '17');
  assert.equal(quantities.held.toFixed(), '3');
  assert.equal(quantities.free.toFixed(), '71.875');
});

test('summary/full validation is strict and the existing full/Excel response remains available', async () => {
  assert.equal(listQuery.parse({ view: 'summary' }).view, 'summary');
  assert.equal(listQuery.safeParse({ view: 'everything' }).success, false);
  setup();
  const result = await inventory(user(), { page: 1, limit: 20 });
  assert.equal(result.items[0].reservedQtyBase, '0');
  assert.equal(result.items[0].usableQtyBase, '100.125');
  assert.equal(result.warehouses[0].id, id(1));
});
