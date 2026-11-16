import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryBalance, Product, ProductBatch } from '../src/models/runtime.js';
import { receiveStock } from '../src/shared/utils/stock.js';

test('receiveStock estimates explicit portions, checking only the dimensions each state needs', async t => {
  const batch = { productId: 'product', identificationStatus: 'VERIFIED',
    piecesPerCarton: 4, cartonLengthMm: '12.345', cartonWidthMm: '9.876', cartonHeightMm: '1.234' };
  const product = { isActive: true, wholeBaseUnits: true, lengthMm: '1.234', widthMm: '2.345', heightMm: '3.456' };
  t.mock.method(ProductBatch, 'findById', () => ({ session: async () => batch }));
  t.mock.method(Product, 'findById', () => ({ session: async () => product }));
  const write = t.mock.method(InventoryBalance, 'updateOne', async () => ({ matchedCount: 1 }));
  const balance = { quantityBase: '0', packagingPortions: [], validate: async () => {} };
  const item = { qtyBase: '8', productId: batch.productId };
  const posting = { movements: [] };
  const user = { _id: 'user' };
  const portions = [
    { packagingState: 'OPEN', quantityBase: '5' },
    { packagingState: 'LOOSE', quantityBase: '3' },
  ];
  await receiveStock(balance, item, portions, posting, user);
  assert.deepEqual(balance.packagingPortions.map(p => p.measuredVolumeMm3), ['300.897', '30.002']);
  assert.equal(portions[0].measuredVolumeMm3, undefined);

  batch.cartonHeightMm = '0';
  await assert.rejects(receiveStock(balance, item, portions, posting, user),
    /Thiếu kích thước lô\/sản phẩm, cần nhập thể tích thực đo/);
  assert.equal(balance.quantityBase, '8');
  assert.equal(write.mock.callCount(), 1);
  await receiveStock(balance, item, [{ ...portions[0], measuredVolumeMm3: '123.456' }, portions[1]], posting, user);
  assert.deepEqual(balance.packagingPortions.slice(-2).map(p => p.measuredVolumeMm3), ['123.456', '30.002']);

  delete product.heightMm;
  await assert.rejects(receiveStock(balance, item, undefined, posting, user, undefined, 'LOOSE'),
    /Thiếu kích thước lô\/sản phẩm, cần nhập thể tích thực đo/);
});

test('receiveStock rejects a missing lot even with a measured volume', async t => {
  t.mock.method(ProductBatch, 'findById', () => ({ session: async () => null }));
  const balance = { quantityBase: '0', packagingPortions: [] };
  const item = { qtyBase: '1', productId: 'product' };
  const posting = { movements: [] };
  const user = { _id: 'user' };
  const portion = { packagingState: 'LOOSE', quantityBase: '1' };

  await assert.rejects(receiveStock(balance, item, [portion], posting, user),
    /Thiếu kích thước lô\/sản phẩm, cần nhập thể tích thực đo/);
  await assert.rejects(receiveStock(balance, item, [{ ...portion, measuredVolumeMm3: '10' }], posting, user),
    /Lô hoặc lượng nhập không hợp lệ/);
  assert.equal(balance.quantityBase, '0');
  assert.deepEqual(balance.packagingPortions, []);
  assert.deepEqual(posting.movements, []);
});
