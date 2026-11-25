import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as models from '../src/models/runtime.js';
import { freeQuantity, freeQuantities } from '../src/shared/utils/stock.js';
import { availableStock, availableStocks } from '../src/modules/replenishments/replenishment.evaluation.js';

// Mocked-model equivalence test (25/11/2026): the batched read path used by low-stock alerts and the owner
// dashboard must return exactly what the per-balance path returns. No database connection is opened.
const query = (value) => ({
  select: () => query(value), session: () => query(value), lean: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});
afterEach(() => mock.restoreAll());

const [P1, W1, L1, H1, B1, BAL1, BAL2, TASK1, DEF1] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => c.repeat(24));

function stubData() {
  const balances = [
    { _id: BAL1, holdingPointId: H1, batchId: B1, quantityBase: '100', qualityStatus: 'GOOD', ownerType: 'STORE' },
    { _id: BAL2, holdingPointId: H1, batchId: B1, quantityBase: '40', qualityStatus: 'GOOD', ownerType: 'STORE' },
  ];
  const reservation = (balanceId, extra = {}) => ({ balanceId, reservedQty: '10', consumedQty: '0', releasedQty: '0', movedQty: '0', ...extra });
  const reservations = [reservation(BAL1), reservation(BAL1, { executionRef: { documentType: 'transfer_orders', documentId: TASK1 }, reservedQty: '5' })];
  const task = { _id: TASK1, workflowStatus: 'OPEN', items: [{ _id: 'a'.repeat(24), qtyBase: '12', details: { sourceBalanceId: BAL1 } }] };
  const defect = { holds: [{ _id: 'b'.repeat(24), status: 'ACTIVE', allocations: [{ balanceId: BAL2, quantityBase: '7' }], events: [] }] };
  const inIds = (value, id) => (value?.$in ?? [value]).map(String).includes(String(id));
  mock.method(models.StockReservation, 'find', (filter) => query(reservations.filter((row) => inIds(filter.balanceId, row.balanceId)
    && (!filter['executionRef.documentType'] || (row.executionRef?.documentType === filter['executionRef.documentType'] && inIds(filter['executionRef.documentId'], row.executionRef.documentId))))));
  mock.method(models.TransferOrder, 'find', () => query([task]));
  mock.method(models.StockTransaction, 'find', () => query([]));
  mock.method(models.DefectReport, 'find', () => query([defect]));
  mock.method(models.WarehouseLocation, 'find', () => query([{ _id: L1, warehouseId: W1 }]));
  mock.method(models.StocktakeLocationLock, 'find', () => query([]));
  mock.method(models.StockHoldingPoint, 'find', () => query([{ _id: H1, locationId: L1 }]));
  mock.method(models.ProductBatch, 'find', () => query([{ _id: B1, productId: P1 }]));
  mock.method(models.InventoryBalance, 'find', () => query(balances));
  return balances;
}

test('freeQuantities matches freeQuantity per balance', async () => {
  const balances = stubData();
  const bulk = await freeQuantities(balances);
  for (const balance of balances) assert.equal(bulk.get(String(balance._id)).toFixed(), (await freeQuantity(balance)).toFixed());
  // BAL1: 100 - (10 + 5 reserved) - (12 pending - 5 covered) = 78; BAL2: 40 - 7 held = 33
  assert.equal(bulk.get(BAL1).toFixed(), '78');
  assert.equal(bulk.get(BAL2).toFixed(), '33');
});

test('availableStocks matches availableStock for a product×warehouse pair', async () => {
  stubData();
  const single = await availableStock(P1, W1);
  const bulk = await availableStocks([{ productId: P1, warehouseId: W1 }]);
  assert.equal(bulk.get(`${P1}:${W1}`).toFixed(), single.toFixed());
  assert.equal(single.toFixed(), '111');
});
