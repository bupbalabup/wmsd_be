import test,{afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import * as models from '../src/models/runtime.js';
import { completionBlocker } from '../src/modules/transfers/transfer-completion.js';
afterEach(()=>mock.restoreAll());
const query=value=>({select(){return this;},session(){return this;},lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
function fixture(){
  const state={shipped:'8',received:'8',transit:false,difference:false,task:'CONFIRMED',requirement:'COMPLETED'};
  mock.method(models.TransferDispatch,'find',()=>query([{_id:'dispatch',workflowStatus:'POSTED',items:[{_id:'dispatch-line',qtyBase:state.shipped,details:{requestLineId:'line'}}]}]));
  mock.method(models.TransferReceipt,'find',()=>query([{_id:'receipt',items:[{_id:'receipt-line',qtyBase:state.received,details:{dispatchLineId:'dispatch-line',qualityCode:'GOOD'}}]}]));
  mock.method(models.StockHoldingPoint,'find',()=>query([{_id:'point'}]));
  mock.method(models.StockDiscrepancy,'exists',()=>query(state.difference));
  mock.method(models.InventoryBalance,'exists',()=>query(state.transit));
  mock.method(models.InternalTransferRequirement,'find',()=>query([{_id:'requirement',workflowStatus:state.requirement,header:{sourceDocumentId:'receipt'}}]));
  mock.method(models.TransferOrder,'find',()=>query([{_id:'task',workflowStatus:state.task,header:{requirementId:'requirement'}}]));
  mock.method(models.StockTransaction,'find',filter=>query(filter.reversedTransactionId?.$exists===false?[{_id:'tx',movements:[{sourceLineId:'receipt-line',quantityBase:state.received}]}]:[]));
  return state;
}
const request={_id:'request',items:[{_id:'line',approvedQtyBase:'8'}]};
test('automatic completion requires quantity, receipt, transit, variance and confirmed TO agreement',async()=>{
  const state=fixture();assert.equal(await completionBlocker(request),null);
  state.task='OPEN';assert.match(await completionBlocker(request),/cất xong/);
  state.task='CONFIRMED';state.requirement='OPEN';assert.match(await completionBlocker(request),/cất xong/);
  state.requirement='COMPLETED';state.difference=true;assert.match(await completionBlocker(request),/chênh lệch/);
  state.difference=false;state.transit=true;assert.match(await completionBlocker(request),/đang chuyển/);
  state.transit=false;state.received='4';assert.match(await completionBlocker(request),/nhận đủ/);
  state.received='8';state.shipped='4';assert.match(await completionBlocker(request),/xuất đủ/);
});
test('completion comparison preserves decimal differences above Number precision',async()=>{
  const state=fixture();state.shipped=state.received='9007199254740993.000001';
  assert.equal(await completionBlocker({...request,items:[{_id:'line',approvedQtyBase:state.shipped}]}),null);
  assert.match(await completionBlocker({...request,items:[{_id:'line',approvedQtyBase:'9007199254740993.000002'}]}),/xuất đủ/);
});
