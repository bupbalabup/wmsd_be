import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPortions } from '../src/shared/utils/stock.js';
import { checkBinCapacity } from '../src/models/capacity.js';

const actor = '507f1f77bcf86cd799439011';
const stock = () => [{ _id: 'original', packagingState: 'SEALED', sealedPackCount: 3, quantityBase: '12', createdBy: actor,
  packagingSnapshot: { baseUnitsPerPackage: '4', outerLengthMm: '10', outerWidthMm: '10', outerHeightMm: '10' } }];
test('outbound opening preserves whole cartons and exact opened remainders without inventing measurements', () => {
  assert.throws(() => splitPortions(stock(), '6', actor), /nguyên thùng/);
  const split = splitPortions(stock(), '6', actor, { allowOpening: true });
  assert.deepEqual(split.kept.map(p => [p.packagingState, p.quantityBase]), [['SEALED', '4'], ['OPEN', '2']]);
  assert.deepEqual(split.taken.map(p => [p.packagingState, p.quantityBase]), [['SEALED', '4'], ['OPEN', '2']]);
  const opened = split.kept.find(p => p.packagingState === 'OPEN');
  assert.equal(opened.measuredVolumeMm3, undefined); assert.equal(opened.volumeUpperBoundMm3, '1000'); assert.equal(opened.sealedPackCount, undefined);
  const next = splitPortions(split.kept, '1', actor, { allowOpening: true });
  assert.equal(next.kept.find(p => p.packagingState === 'SEALED').sealedPackCount, 1);
  assert.equal(next.kept.find(p => p.packagingState === 'OPEN').quantityBase, '1');
  assert.equal(next.taken[0].quantityBase, '1'); assert.equal(next.taken[0].packagingState, 'OPEN');
  const declaredTooSmall = splitPortions([{ ...stock()[0], measuredVolumeMm3: '1' }], '6', actor, { allowOpening: true });
  assert.equal(declaredTooSmall.kept[0].volumeUpperBoundMm3, '3000');
  assert.equal(declaredTooSmall.taken[0].volumeUpperBoundMm3, '3000');
});
test('splitting existing loose stock keeps its known occupied-volume bound and requires one when unknown', () => {
  const source = [{ _id: 'loose', packagingState: 'LOOSE', quantityBase: '5', measuredVolumeMm3: '125', createdBy: actor }];
  const split = splitPortions(source, '2', actor, { allowOpening: true });
  assert.equal(split.kept[0].volumeUpperBoundMm3, '125'); assert.equal(split.taken[0].volumeUpperBoundMm3, '125');
  assert.equal(split.kept[0].measuredVolumeMm3, undefined);
  assert.throws(() => splitPortions([{ ...source[0], measuredVolumeMm3: undefined }], '2', actor, { allowOpening: true }), /giới hạn thể tích/);
});
test('capacity accounts for opened-stock upper bounds and rejects overflow', () => {
  const data = { warehouses: [{ _id: 'wh', clearHeightMm: '10' }], warehouse_locations: [{ _id: 'bin', warehouseId: 'wh', usableLengthMm: '10', usableWidthMm: '10' }],
    stock_holding_points: [{ _id: 'point', type: 'LOCATION', locationId: 'bin' }], product_batches: [{ _id: 'batch' }],
    inventory_balances: [{ holdingPointId: 'point', batchId: 'batch', quantityBase: '2', packagingPortions: [{ packagingState: 'OPEN', quantityBase: '2', volumeUpperBoundMm3: '1000' }] }] };
  assert.equal(checkBinCapacity(data).get('bin').toFixed(), '1000');
  data.inventory_balances[0].packagingPortions[0].volumeUpperBoundMm3 = '1001';
  assert.throws(() => checkBinCapacity(data), /capacity exceeded/);
});
