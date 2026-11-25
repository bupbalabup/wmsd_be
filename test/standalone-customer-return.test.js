import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as m from '../src/models/runtime.js';
import { issueSource, standaloneSaleReturnAllowance } from '../src/modules/return-workflows/native.shared.js';

test('standalone SALE goods issue is a customer-return source without a Sales Order', async () => {
  const warehouseId = new mongoose.Types.ObjectId();
  const creatorId = new mongoose.Types.ObjectId();
  const lineId = new mongoose.Types.ObjectId();
  const balanceId = new mongoose.Types.ObjectId();
  const doc = new m.SalesGoodsIssue({
    documentNo: 'PXB-TEST', documentKind: 'GI_SALE', workflowStatus: 'POSTED', version: 1, createdBy: creatorId,
    header: { warehouseId, issueKind: 'SALE', referenceNo: 'LEGACY-SALE', issuedToName: 'Customer' },
    items: [{ _id: lineId, lineNo: 1, lineKind: 'SALES_GOODS_ISSUE', productId: new mongoose.Types.ObjectId(), lotId: new mongoose.Types.ObjectId(), enteredUnit: 'PIECE', baseUnitSnapshot: 'PIECE', baseUnitsPerUnit: '1', qtyBase: '4', enteredQty: '4', productNameSnapshot: 'Tile' }],
  });
  const user = { _id: creatorId, roleId: { code: 'SALES' }, warehouseIds: [warehouseId] };
  const restore = [];
  const replace = (target, key, value) => { const original = target[key]; target[key] = value; restore.push(() => { target[key] = original; }); };
  replace(m.SalesGoodsIssue, 'findOne', () => ({ session: async () => doc }));
  replace(m.ReturnSourceLock, 'updateOne', async () => ({ acknowledged: true }));
  replace(m.StockTransaction, 'find', () => ({ session: async () => [{ _id: new mongoose.Types.ObjectId(), movements: [{ sourceLineId: lineId, fromBalanceId: balanceId, quantityBase: '4' }] }] }));
  replace(m.StockTransaction, 'findOne', () => ({ session: async () => null }));
  replace(m.SalesOrder, 'findById', () => { throw new Error('standalone issue must not load a Sales Order'); });
  try {
    const source = await issueSource(String(lineId), user);
    assert.equal(source.standaloneSale, true);
    assert.equal(source.so, undefined);
    assert.equal(source.issued.toFixed(), '4');
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});

test('standalone SALE return cap subtracts known undelivered receipts and open delivery claims', () => {
  assert.equal(standaloneSaleReturnAllowance('8', '2', '1').toFixed(), '5');
  assert.equal(standaloneSaleReturnAllowance('4', '6', '0').toFixed(), '0');
});
