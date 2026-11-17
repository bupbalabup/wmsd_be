import test,{afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import { StockReservation,TransferOrder,StockTransaction,DefectReport,Warehouse,WarehouseLocation,StockHoldingPoint,InventoryBalance,WarehouseTransferRequest,TransferDispatch,TransferReceipt,InternalTransferRequirement,ApprovalHistory,StockDiscrepancy } from '../src/models/runtime.js';
import { freeQuantities } from '../src/shared/utils/stock-availability-read.js';
import { freeQuantity } from '../src/shared/utils/stock.js';
import { transferOptions,getTransfer,getDispatch } from '../src/modules/transfers/transfer-read.service.js';
import { optionsQuery } from '../src/modules/transfers/transfer-read.validation.js';
afterEach(()=>mock.restoreAll());
const chain=value=>({select(){return this;},session(){return this;},lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
const matches=(value,filter)=>filter?.$in?filter.$in.map(String).includes(String(value)):String(value)===String(filter);
function fixture(){
  const reservations=[{balanceId:'a',reservedQty:'10',consumedQty:'2',releasedQty:'0',movedQty:'0',executionRef:{documentType:'transfer_orders',documentId:'t1'}},
    {balanceId:'b',reservedQty:'2',consumedQty:'0',releasedQty:'0',movedQty:'0',executionRef:{documentType:'transfer_orders',documentId:'t1'}}];
  const tasks=[{_id:'t1',items:[{_id:'i1',qtyBase:'30',details:{sourceBalanceId:'a'}}]},
    {_id:'t2',items:[{_id:'i2',qtyBase:'3',details:{sourceBalanceId:'b'}}]}];
  const transactions=[{sourceId:'t1',movements:[{sourceLineId:'i1',fromBalanceId:'a',quantityBase:'5'}]}];
  const reports=[{holds:[{_id:'h',status:'ACTIVE',allocations:[{balanceId:'a',quantityBase:'4'}],events:[{kind:'RELEASED',quantityBase:'1'}]}]}];
  mock.method(StockReservation,'find',q=>chain(reservations.filter(r=>matches(r.balanceId,q.balanceId)&&(!q['executionRef.documentId']||matches(r.executionRef.documentId,q['executionRef.documentId'])))));
  mock.method(TransferOrder,'find',q=>chain(tasks.filter(t=>t.items.some(i=>matches(i.details.sourceBalanceId,q['items.details.sourceBalanceId'])))));
  mock.method(StockTransaction,'find',q=>chain(transactions.filter(t=>matches(t.sourceId,q.sourceId))));
  mock.method(DefectReport,'find',q=>chain(reports.filter(r=>r.holds.some(h=>h.allocations.some(a=>matches(a.balanceId,q.holds.$elemMatch['allocations.balanceId']))))));
  return [{_id:'a',quantityBase:'100'},{_id:'b',quantityBase:'20'},{_id:'c',quantityBase:'0.125'}];
}
test('batch availability matches transaction helper for partial trips, covered reservations and resolved holds',async()=>{
  const balances=fixture(),batch=await freeQuantities(balances);
  for(const balance of balances)assert.equal(batch.get(balance._id).toFixed(),(await freeQuantity(balance)).toFixed());
  assert.equal(batch.get('a').toFixed(),'72');assert.equal(batch.get('b').toFixed(),'15');assert.equal(batch.get('c').toFixed(),'0.125');
});
test('availability query budget stays four for 1000 balances, zero for empty input',async()=>{
  const balances=fixture();
  const all=[...balances,...Array.from({length:997},(_,i)=>({_id:`extra-${i}`,quantityBase:'10'}))];
  await freeQuantities([]);
  for(const model of [StockReservation,TransferOrder,StockTransaction,DefectReport])assert.equal(model.find.mock.callCount(),0);
  const result=await freeQuantities(all);assert.equal(result.size,1000);
  for(const model of [StockReservation,TransferOrder,StockTransaction,DefectReport])assert.equal(model.find.mock.callCount(),1);
});
const wh='a'.repeat(24);
const user={isActive:true,_id:'b'.repeat(24),warehouseIds:[wh],roleId:{code:'WAREHOUSE',isActive:true,permissionIds:[{code:'stock_transfer:read'}]}};
test('destination location options do not load balances, products or design payloads and preserve warehouse scope',async()=>{
  assert.deepEqual(optionsQuery.parse({warehouseId:wh,mode:'locations'}),{warehouseId:wh,mode:'locations'});
  assert.equal(optionsQuery.safeParse({mode:'all'}).success,false);
  let projection;
  mock.method(Warehouse,'find',()=>({select(fields){projection=fields;return chain([{_id:wh,code:'W1',name:'Warehouse'}]);}}));
  mock.method(WarehouseLocation,'find',q=>{assert.equal(q.warehouseId,wh);return chain([{_id:'loc',warehouseId:wh,code:'A1'}]);});
  for(const model of [StockHoldingPoint,InventoryBalance])mock.method(model,'find',()=>assert.fail('locations-only must not load stock'));
  const result=await transferOptions(user,wh,'locations');assert.equal(result.locations.length,1);assert.deepEqual(result.balances,[]);
  assert.equal(projection,'_id code name isActive');
  await assert.rejects(transferOptions(user,'c'.repeat(24),'locations'),error=>error.statusCode===403);
});
test('parallel detail reads preserve transit and received quantities and still scope the request',async()=>{
  mock.method(WarehouseTransferRequest,'findOne',q=>{assert.ok(q.$and[0].$or);return chain({_id:'request',header:{sourceWarehouseId:wh,destinationWarehouseId:'c'.repeat(24)},items:[{_id:'request-line',qtyBase:'8'}]});});
  mock.method(Warehouse,'find',()=>chain([{_id:wh,code:'W1',name:'Source'}]));
  mock.method(TransferDispatch,'find',()=>chain([{_id:'dispatch',workflowStatus:'POSTED',items:[{_id:'dispatch-line',qtyBase:'8',details:{requestLineId:'request-line'}}]}]));
  mock.method(TransferReceipt,'find',()=>chain([{_id:'receipt',workflowStatus:'POSTED',items:[{_id:'receipt-line',qtyBase:'3',details:{dispatchLineId:'dispatch-line',qualityCode:'GOOD'}}]}]));
  for(const model of [InternalTransferRequirement,ApprovalHistory,StockDiscrepancy,TransferOrder,StockTransaction])mock.method(model,'find',()=>chain([]));
  mock.method(StockHoldingPoint,'find',()=>chain([{_id:'point',dispatchLineId:'dispatch-line'}]));
  mock.method(InventoryBalance,'find',()=>chain([{holdingPointId:'point',quantityBase:'5'}]));
  const result=await getTransfer(user,'request');
  assert.equal(result.progress[0].lines[0].remainingQtyBase,'5');
  assert.equal(result.lineProgress[0].receivedGoodQtyBase,'3');
  assert.equal(result.lineProgress[0].dispatchedQtyBase,'8');
  assert.equal(result.lineProgress[0].transitQtyBase,'5');
});
test('receipt source reads only its dispatch and transit, without expanding the whole transfer',async()=>{
  const receiver={...user,roleId:{...user.roleId,permissionIds:[{code:'stock_transfer:read'},{code:'stock_transfer:receive'}]}};
  mock.method(TransferDispatch,'findOne',()=>chain({_id:'dispatch',workflowStatus:'POSTED',header:{requestId:'request',dispatchedBy:'sender'},items:[{_id:'line',qtyBase:'10'}]}));
  const request=mock.method(WarehouseTransferRequest,'findOne',q=>{assert.ok(q.$and[0].$or);return chain({_id:'request',workflowStatus:'APPROVED',header:{sourceWarehouseId:'c'.repeat(24),destinationWarehouseId:wh}});});
  mock.method(Warehouse,'find',()=>chain([]));
  mock.method(StockHoldingPoint,'find',()=>chain([{_id:'point',dispatchLineId:'line'}]));
  mock.method(InventoryBalance,'find',()=>chain([{holdingPointId:'point',quantityBase:'7'}]));
  for(const model of [TransferReceipt,TransferOrder,InternalTransferRequirement,ApprovalHistory,StockDiscrepancy])mock.method(model,'find',()=>assert.fail('receipt source must not expand sibling documents'));
  const result=await getDispatch(receiver,'dispatch');assert.equal(result.receivableLines[0].remainingQtyBase,'7');
  assert.equal(result.receivableLines[0].receivedQtyBase,'3');assert.equal(request.mock.callCount(),1);
  request.mock.mockImplementation(()=>chain(null));
  await assert.rejects(getDispatch(receiver,'dispatch'),error=>error.statusCode===404);
});
