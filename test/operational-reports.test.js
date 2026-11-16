import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as models from '../src/models/runtime.js';
import { operationalReport, reportOptions, reportGroups } from '../src/modules/operational-reports/operational-reports.service.js';
import { reportQuery } from '../src/modules/operational-reports/operational-reports.routes.js';

const W1 = 'a'.repeat(24), W2 = 'b'.repeat(24);
const ALL = ['inventory', 'purchases', 'receipts', 'issues', 'sales', 'transfers', 'defects', 'returns', 'supplierReturns', 'stocktakes', 'adjustments'];
const EXPECTED = {
  OWNER: ALL,
  ACCOUNTANT: ['purchases', 'receipts'],
  WAREHOUSE: ['inventory', 'transfers', 'stocktakes', 'adjustments'],
  SALES: [],
};
const user = (code, { warehouseIds = [W1], permissions = ['report:read'] } = {}) => ({
  isActive: true, warehouseIds, roleId: { code, permissionIds: permissions.map(code => ({ code })) },
});
const FINANCIAL = /revenue|cost|price|profit|amount|total|margin/i;
const documentModels = { purchases: 'PurchaseOrder', receipts: 'GoodsReceipt', issues: 'DeliveryOrder', transfers: 'WarehouseTransferRequest', defects: 'DefectReport', returns: 'CustomerReturn', supplierReturns: 'SupplierReturn', stocktakes: 'Stocktake', adjustments: 'StockAdjustment' };
const priced = fields => ({ ...fields, unitPrice: '9', unitCost: '5', totalAmount: '100', revenue: '1', profit: '1' });
const document = { _id: 'd1', documentNo: 'DOC-1', documentKind: 'X', workflowStatus: 'OPEN', createdAt: new Date('2026-11-01'), header: { warehouseId: W1 }, ...priced({}),
  items: [{ _id: 'i1', productNameSnapshot: 'Tile', qtyBase: '4', baseUnitSnapshot: 'PIECE', ...priced({}) }] };

// Every model read resolves from `data` (default: no rows); the filters are recorded for assertions.
function setup(data = {}) {
  const calls = [];
  const sessions = mock.method(mongoose, 'startSession', async () => ({ withTransaction: async work => work(), endSession: async () => {} }));
  for (const [name, Model] of Object.entries(models)) {
    if (typeof Model?.find !== 'function') continue;
    mock.method(Model, 'find', filter => {
      calls.push([name, filter]);
      const rows = data[name] ?? [];
      const chain = { session: () => chain, select: () => chain, lean: async () => rows, then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) };
      return chain;
    });
  }
  return { calls, sessions, of: name => calls.filter(([model]) => model === name).map(([, filter]) => filter) };
}
const keys = value => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : [];
const forbidden = error => error.statusCode === 403;

afterEach(() => mock.restoreAll());

for (const [role, groups] of Object.entries(EXPECTED)) {
  test(`${role} is offered exactly its permitted groups`, async () => {
    setup({ Warehouse: [{ _id: W1, code: 'WH', name: 'Main' }] });
    assert.deepEqual(reportGroups(user(role)), groups);
    const options = await reportOptions(user(role));
    assert.deepEqual(options.groups, groups);
    assert.deepEqual(options.warehouses.map(w => [w.id, w.code, w.name]), [[W1, 'WH', 'Main']]);
  });

  test(`${role} may run permitted groups and is refused every other group`, async () => {
    const harness = setup();
    for (const group of ALL) {
      if (groups.includes(group)) {
        const report = await operationalReport(user(role), { group });
        assert.equal(report.group, group);
        assert.ok(Array.isArray(report.rows));
      } else {
        const before = harness.calls.length;
        await assert.rejects(operationalReport(user(role), { group }), forbidden, `${role} must not run ${group}`);
        assert.equal(harness.calls.length, before, 'a refused group must not read any model');
      }
    }
  });
}

test('a user without report:read gets no options and no report, even as Owner role code', async () => {
  const harness = setup();
  for (const code of ['OWNER', 'ACCOUNTANT', 'WAREHOUSE']) {
    await assert.rejects(reportOptions(user(code, { permissions: [] })), forbidden);
    await assert.rejects(operationalReport(user(code, { permissions: [] }), { group: 'inventory' }), forbidden);
  }
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.sessions.mock.callCount(), 0);
});

test('an inactive account or a missing role gets nothing', async () => {
  setup();
  assert.deepEqual(reportGroups({ isActive: true, roleId: null }), []);
  await assert.rejects(reportOptions({ ...user('OWNER'), isActive: false }), forbidden);
  await assert.rejects(operationalReport({ isActive: true, warehouseIds: [W1] }, { group: 'inventory' }), forbidden);
});

test('a custom role holding report:read is offered no group and cannot run one', async () => {
  const harness = setup();
  const custom = user('STORE_AUDITOR');
  assert.deepEqual((await reportOptions(custom)).groups, []);
  for (const group of ALL) await assert.rejects(operationalReport(custom, { group }), forbidden);
  assert.equal(harness.sessions.mock.callCount(), 0);
});

test('filtering by a foreign warehouse is refused before any report read', async () => {
  const harness = setup();
  await assert.rejects(operationalReport(user('WAREHOUSE'), { group: 'inventory', warehouseId: W2 }), forbidden);
  await assert.rejects(operationalReport(user('WAREHOUSE', { warehouseIds: [] }), { group: 'transfers', warehouseId: W1 }), forbidden);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.sessions.mock.callCount(), 0);
});

test('the Owner may filter by any warehouse and is not limited by assignment', async () => {
  const harness = setup({ Warehouse: [{ _id: W2 }] });
  const owner = user('OWNER', { warehouseIds: [] });
  await operationalReport(owner, { group: 'purchases', warehouseId: W2 });
  assert.deepEqual(harness.of('Warehouse'), [{ _id: W2 }]);
  harness.calls.length = 0;
  await operationalReport(owner, { group: 'purchases' });
  assert.deepEqual(harness.of('Warehouse'), [{}]);
});

test('without a warehouse filter a non-Owner is limited to the assigned warehouses', async () => {
  const harness = setup({ Warehouse: [{ _id: W1 }], WarehouseTransferRequest: [document] });
  const staff = user('WAREHOUSE', { warehouseIds: [W1] });
  await operationalReport(staff, { group: 'stocktakes' });
  assert.deepEqual(harness.of('Warehouse'), [{ _id: { $in: [W1] } }]);
  assert.deepEqual(harness.of('Stocktake'), [{ 'header.warehouseId': { $in: [W1] } }]);
  harness.calls.length = 0;
  await operationalReport(staff, { group: 'transfers' });
  assert.deepEqual(harness.of('WarehouseTransferRequest')[0].$or, [{ 'header.sourceWarehouseId': { $in: [W1] } }, { 'header.destinationWarehouseId': { $in: [W1] } }]);
});

test('a permitted warehouse filter narrows the read to that warehouse', async () => {
  const harness = setup({ Warehouse: [{ _id: W1 }] });
  await operationalReport(user('ACCOUNTANT', { warehouseIds: [W1, W2] }), { group: 'receipts', warehouseId: W1 });
  assert.deepEqual(harness.of('Warehouse'), [{ _id: W1 }]);
  assert.deepEqual(harness.of('GoodsReceipt'), [{ 'header.warehouseId': { $in: [W1] } }]);
});

test('the date range is applied to the document creation date', async () => {
  const harness = setup({ Warehouse: [{ _id: W1 }] });
  const range = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T23:59:59.000Z' };
  await operationalReport(user('ACCOUNTANT'), { group: 'purchases', ...range });
  assert.deepEqual(harness.of('PurchaseOrder')[0].createdAt, { $gte: new Date(range.from), $lte: new Date(range.to) });
});

test('document group rows carry no revenue, cost, price or profit field', async () => {
  for (const [group, name] of Object.entries(documentModels)) {
    setup({ Warehouse: [{ _id: W1 }], [name]: [document] });
    const { rows } = await operationalReport(user('OWNER'), { group });
    assert.equal(rows.length, 1, group);
    assert.deepEqual(keys(rows).filter(key => FINANCIAL.test(key)), [], `${group} row leaks a financial field`);
    assert.equal(rows[0].items[0].qtyBase, '4');
    mock.restoreAll();
  }
});

test('sales rows carry no financial field', async () => {
  setup({
    Warehouse: [{ _id: W1 }],
    WarehouseIssueRequest: [{ header: { salesOrderId: 's1' }, items: [{ details: { salesOrderLineId: 'l1' } }] }],
    SalesOrder: [{ _id: 's1', documentNo: 'SO-1', workflowStatus: 'DELIVERED', createdAt: new Date(), ...priced({}), deliveryConfirmations: [],
      items: [{ _id: 'l1', productNameSnapshot: 'Tile', qtyBase: '4', baseUnitSnapshot: 'PIECE', ...priced({}) }] }],
  });
  const { rows } = await operationalReport(user('OWNER'), { group: 'sales' });
  assert.equal(rows[0].items.length, 1);
  assert.deepEqual(keys(rows).filter(key => FINANCIAL.test(key)), []);
});

test('inventory rows carry quantities as exact decimals and no financial field', async () => {
  setup({
    Warehouse: [{ _id: W1, name: 'Main' }],
    WarehouseLocation: [{ _id: 'l1', warehouseId: W1, code: 'A-01', isActive: true, isPickable: true }],
    StockHoldingPoint: [{ _id: 'p1', locationId: 'l1', type: 'STORAGE' }],
    InventoryBalance: [{ _id: 'b1', holdingPointId: 'p1', batchId: 'c1', quantityBase: '9007199254740993.25', ownerType: 'STORE', qualityStatus: 'GOOD', ...priced({}) }],
    ProductBatch: [{ _id: 'c1', productId: 'pr1', manufacturerLot: 'LOT', identificationStatus: 'VERIFIED', ...priced({}) }],
    Product: [{ _id: 'pr1', name: 'Tile', sku: 'T-1', baseUnit: 'PIECE', isActive: true, ...priced({}) }],
  });
  const { rows } = await operationalReport(user('WAREHOUSE'), { group: 'inventory' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].physicalQtyBase, '9007199254740993.25');
  assert.equal(rows[0].unit, 'PIECE');
  assert.deepEqual(keys(rows).filter(key => FINANCIAL.test(key)), []);
});

test('reports only read: no model write is attempted', async () => {
  setup({ Warehouse: [{ _id: W1 }], PurchaseOrder: [document] });
  for (const Model of Object.values(models)) for (const write of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteMany', 'bulkWrite']) {
    if (typeof Model?.[write] === 'function') mock.method(Model, write, () => assert.fail(`report must not call ${write}`));
  }
  await operationalReport(user('ACCOUNTANT'), { group: 'purchases' });
});

test('filters are optional and the group defaults to inventory', () => {
  assert.deepEqual(reportQuery.parse({}), { group: 'inventory' });
  assert.deepEqual(reportQuery.parse({ group: 'receipts', warehouseId: W1, from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }).group, 'receipts');
});

test('a reversed date range is rejected, an equal range is accepted', () => {
  assert.equal(reportQuery.safeParse({ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }).success, false);
  assert.equal(reportQuery.safeParse({ from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }).success, true);
  assert.equal(reportQuery.safeParse({ from: '2026-11-01T12:00:00+07:00', to: '2026-11-01T04:00:00Z' }).success, false);
});

test('malformed filters are rejected', () => {
  for (const bad of [
    { from: 'yesterday' }, { to: '2026-13-45T00:00:00Z' }, { from: '2026-11-01' }, { from: '2026-11-01T00:00:00' },
    { from: '' }, { warehouseId: 'not-an-id' }, { warehouseId: W1.slice(1) }, { group: 'movements' }, { group: 'INVENTORY' }, { status: 'OPEN' },
  ]) assert.equal(reportQuery.safeParse(bad).success, false, JSON.stringify(bad));
});
