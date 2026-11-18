import test,{mock,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/models/runtime.js';
import { movementListPipeline } from '../src/shared/utils/movement-list.js';
import { listQuery } from '../src/modules/transfers/transfer-read.validation.js';
import { locationMovementOptions,getLocationMovement } from '../src/modules/location-movements/location-movement.service.js';
import { transferOptions,getTransfer,getDispatch } from '../src/modules/transfers/transfer-read.service.js';
import { optionFields } from '../src/shared/utils/movement-read-fields.js';
afterEach(()=>mock.restoreAll());

// Apply Mongo inclusion projections to synthetic records, so omitted dependencies fail tests.
function projected(row,fields){
  if(!fields)return row;
  const tree={};for(const field of fields.split(/\s+/)){let node=tree;const parts=field.split('.');for(const key of parts)node=node[key]??={};}
  const pick=(value,shape)=>Array.isArray(value)?value.map(item=>pick(item,shape)):Object.fromEntries(Object.keys(shape).filter(key=>value?.[key]!==undefined).map(key=>[key,Object.keys(shape[key]).length?pick(value[key],shape[key]):value[key]]));
  return pick(row,tree);
}
function query(rows,single=false){let fields;return {select(value){fields=value;return this;},sort(){return this;},session(){return this;},lean:async()=>single?projected(rows,fields):rows.map(row=>projected(row,fields))};}
const wh='a'.repeat(24);
const actor={_id:'u',isActive:true,warehouseIds:[wh],roleId:{code:'WAREHOUSE',isActive:true,permissionIds:[{code:'stock_relocation:create'},{code:'stock_relocation:read'},{code:'stock_transfer:read'}]}};
function catalogue(){
  const unused='x'.repeat(20000);
  mock.method(m.Warehouse,'find',()=>query([{_id:wh,code:'WH',name:'Warehouse',isActive:true,layout3d:{unused}}]));
  mock.method(m.WarehouseLocation,'find',()=>query([{_id:'loc',warehouseId:wh,code:'A1',name:'Bin',locationType:'STORAGE',isActive:true,isAllocatable:true,unused}]));
  mock.method(m.StockHoldingPoint,'find',()=>query([{_id:'point',locationId:'loc',type:'LOCATION',unused}]));
  mock.method(m.InventoryBalance,'find',()=>query([{_id:'balance',holdingPointId:'point',batchId:'batch',version:2,quantityBase:'8',qualityStatus:'GOOD',ownerType:'STORE',packagingPortions:[{packagingState:'SEALED',sealedPackCount:1,quantityBase:'4',unused},{packagingState:'OPEN',quantityBase:'3',unused},{packagingState:'LOOSE',quantityBase:'1',unused}],unused}]));
  mock.method(m.ProductBatch,'find',()=>query([{_id:'batch',productId:'product',manufacturerLot:'LOT1',piecesPerCarton:4,identificationStatus:'VERIFIED',unused}]));
  mock.method(m.Product,'find',()=>query([{_id:'product',name:'Tile',sku:'T1',baseUnit:'PIECE',isActive:true,unused}]));
  mock.method(m.Uom,'find',()=>query([{_id:'uom',code:'CARTON',name:'Thùng',isCarton:true,unused}]));
  mock.method(m.Conversion,'find',()=>query([{_id:'conv',productId:'product',productBatchId:'batch',uomId:'uom',basePerUnit:'4',unused}]));
}
test('summary list projection omits item arrays while full/export preserves quantities, scope and facets',()=>{
  assert.equal(listQuery.safeParse({view:'unknown'}).success,false);
  const scope={'header.warehouseId':wh};
  const summary=movementListPipeline(scope,{view:'summary',q:'TR'},['header.warehouseId'],'warehouses');
  const full=movementListPipeline(scope,{q:'TR'},['header.warehouseId'],'warehouses');
  assert.deepEqual(summary[0],{$match:scope});
  assert.deepEqual(summary[1].$facet.total,full[1].$facet.total);
  assert.deepEqual(summary[1].$facet.summary,full[1].$facet.summary);
  const fields=summary[1].$facet.items.at(-1).$project;
  assert.equal(fields.items,undefined);assert.equal(fields.documentNo,1);assert.equal(fields.createdAt,1);
  assert.equal(full[1].$facet.items.at(-1).$project['items.qtyBase'],1);
  for(const field of ['occurredAt','postedAt','updatedAt','note','items.note'])assert.equal(full[1].$facet.items.at(-1).$project[field],1);
  const lookup=summary[1].$facet.warehouses.find(stage=>stage.$lookup).$lookup;
  assert.deepEqual(lookup.pipeline,[{$project:{_id:1,name:1,code:1}}]);
});
test('both option endpoints retain selection and packaging fields without unused catalogue payload',async()=>{
  catalogue();for(const model of [m.StockReservation,m.TransferOrder,m.DefectReport])mock.method(model,'find',()=>query([]));
  const relocation=await locationMovementOptions(actor,wh),transfer=await transferOptions(actor,wh);
  assert.deepEqual(relocation.balances[0].packagingPortions,[{packagingState:'SEALED',sealedPackCount:1,quantityBase:'4'},{packagingState:'OPEN',quantityBase:'3'},{packagingState:'LOOSE',quantityBase:'1'}]);
  assert.equal(transfer.balances[0].packagingPortions[0].sealedPackCount,undefined);
  for(const data of [relocation,transfer]){
    assert.equal(data.products[0].name,'Tile');assert.equal(data.products[0].baseUnit,'PIECE');
    assert.equal(data.balances[0].version,2);assert.equal(data.balances[0].quantityBase,'8');
    assert.equal(data.balances[0].packagingPortions[0].packagingState,'SEALED');
    assert.equal(data.conversions[0].basePerUnit,'4');assert.equal(data.batches[0].piecesPerCarton,4);
    assert.equal(JSON.stringify(data).includes('unused'),false);assert.equal(JSON.stringify(data).includes('layout3d'),false);
    assert.ok(Buffer.byteLength(JSON.stringify(data))<3000);
  }
  assert.ok(optionFields.balance.includes('packagingPortions.packagingState'));
});
test('relocation detail retains edit versions, package factors, posted quantities and performer names',async()=>{
  catalogue();
  mock.method(m.TransferOrder,'findById',()=>query({_id:'move',documentNo:'LCV-1',workflowStatus:'PARTIAL',version:3,createdBy:'u',header:{warehouseId:wh,taskKind:'RELOCATE',reason:'Move',unused:'omit'},items:[{_id:'line',productNameSnapshot:'Tile',lotId:'batch',qtyBase:'8',enteredQty:'2',enteredUnit:'CARTON',baseUnitSnapshot:'PIECE',packagingSnapshot:{baseUnitsPerPackage:'4',unused:'omit'},details:{sourceBalanceId:'balance',sourceBalanceVersion:2,fromLocationId:'loc',toLocationId:'loc',unused:'omit'}}],unused:'omit'},true));
  mock.method(m.StockTransaction,'find',()=>query([{_id:'tx',occurredAt:'2026-11-17',operation:'RELOCATE',performedBy:'u',movements:[{sourceLineId:'line',quantityBase:'4',unused:'omit'}],unused:'omit'}]));
  mock.method(m.User,'find',()=>query([{_id:'u',fullName:'Warehouse Staff',passwordHash:'never-read',unused:'omit'}]));
  const data=await getLocationMovement(actor,'move');
  assert.equal(data.version,3);assert.equal(data.items[0].details.sourceBalanceVersion,2);
  assert.equal(data.items[0].packagingSnapshot.baseUnitsPerPackage,'4');
  assert.equal(data.transactions[0].movements[0].quantityBase,'4');assert.equal(data.transactions[0].performedByName,'Warehouse Staff');
  assert.equal(JSON.stringify(data).includes('unused'),false);assert.equal(JSON.stringify(data).includes('passwordHash'),false);
  await assert.rejects(getLocationMovement({...actor,warehouseIds:[]},'move'),error=>error.statusCode===403);
});
test('projected transfer detail and receipt source preserve progress, discrepancy caps and command versions',async()=>{
  catalogue();
  const request={_id:'request',version:4,workflowStatus:'APPROVED',header:{sourceWarehouseId:'source',destinationWarehouseId:wh},items:[{_id:'request-line',qtyBase:'8',approvedQtyBase:'8'}],unused:'omit'};
  const dispatch={_id:'dispatch',version:2,workflowStatus:'POSTED',header:{requestId:'request',dispatchedBy:'sender'},items:[{_id:'dispatch-line',qtyBase:'8',packagingSnapshot:{baseUnitsPerPackage:'4'},details:{requestLineId:'request-line'}}],unused:'omit'};
  mock.method(m.WarehouseTransferRequest,'findOne',()=>query(request,true));
  mock.method(m.TransferDispatch,'find',()=>query([dispatch]));
  mock.method(m.TransferDispatch,'findOne',()=>query(dispatch,true));
  mock.method(m.TransferReceipt,'find',()=>query([{_id:'receipt',version:1,workflowStatus:'POSTED',items:[{_id:'receipt-line',qtyBase:'3',details:{dispatchLineId:'dispatch-line',qualityCode:'GOOD',receivingLocationId:'loc'}}],unused:'omit'}]));
  mock.method(m.InternalTransferRequirement,'find',()=>query([{_id:'requirement',workflowStatus:'OPEN',header:{sourceDocumentId:'receipt',taskKind:'PUTAWAY'},unused:'omit'}]));
  mock.method(m.TransferOrder,'find',()=>query([{_id:'task',version:3,workflowStatus:'OPEN',header:{warehouseId:wh,taskKind:'PUTAWAY'},unused:'omit'}]));
  mock.method(m.ApprovalHistory,'find',()=>query([]));
  mock.method(m.StockDiscrepancy,'find',()=>query([{_id:'difference',version:2,workflowStatus:'OPEN',header:{sourceRef:{documentId:'dispatch'}},items:[{qtyBase:'1',details:{sourceLineId:'dispatch-line'}}],unused:'omit'}]));
  m.StockHoldingPoint.find.mock.mockImplementation(()=>query([{_id:'point',dispatchLineId:'dispatch-line',unused:'omit'}]));
  m.InventoryBalance.find.mock.mockImplementation(()=>query([{_id:'balance',holdingPointId:'point',quantityBase:'5',unused:'omit'}]));
  mock.method(m.StockTransaction,'find',filter=>query(filter.reversedTransactionId?.$exists===false?[{_id:'transaction',movements:[{sourceLineId:'receipt-line',quantityBase:'2',unused:'omit'}],unused:'omit'}]:[]));
  const detail=await getTransfer(actor,'request');
  assert.equal(detail.version,4);assert.equal(detail.tasks[0].version,3);
  assert.equal(detail.internalRequirements[0].header.sourceDocumentId,'receipt');
  assert.equal(detail.receipts[0].items[0].details.receivingLocationId,'loc');
  assert.equal(detail.lineProgress[0].receivedGoodQtyBase,'2');assert.equal(detail.lineProgress[0].unresolvedQtyBase,'1');
  assert.equal(detail.progress[0].lines[0].remainingQtyBase,'5');assert.equal(detail.progress[0].lines[0].piecesPerCarton,'4');
  const receiver={...actor,roleId:{...actor.roleId,permissionIds:[...actor.roleId.permissionIds,{code:'stock_transfer:receive'}]}};
  const receiptSource=await getDispatch(receiver,'dispatch');
  assert.equal(receiptSource.version,2);assert.equal(receiptSource.receivableLines[0].remainingQtyBase,'5');
  assert.equal(JSON.stringify([detail,receiptSource]).includes('unused'),false);
});
