import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import * as stock from '../src/modules/warehouse-stock/service.js';
import { saveLayout } from '../src/modules/warehouse-stock/layout.js';
import * as transfers from '../src/modules/transfers/transfer.service.js';
import * as differences from '../src/modules/transfers/transfer-differences.js';
import { getTransfer } from '../src/modules/transfers/transfer.service.js';
import { freeQuantity } from '../src/shared/utils/stock.js';
const enabled=process.env.RUN_HIEUDT_SCOPE_TESTS==='1';
const run=(name,fn)=>test(name,{skip:!enabled},fn);
const key=()=>new mongoose.Types.ObjectId().toString();
let owner,a,b,sales,wa,wb,source,stage,receiving,storage,quarantine,product,batch,balance;
const page={page:1,limit:20};
test.before(async()=>{
 if(!enabled)return;
 await mongoose.connect('mongodb://127.0.0.1:27018/wmsd_hieudt_scope_test_'+key()+'?replicaSet=hieudt-test',{serverSelectionTimeoutMS:5000});
 const models=[...m.models.values()];for(let start=0;start<models.length;start+=6)await Promise.all(models.slice(start,start+6).map(async Model=>{await Model.createCollection();await Model.createIndexes();}));
 const permissions=await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p=>({code:p.code,name:p.code,description:p.description})));
 const roles={};for(const code of ['OWNER','WAREHOUSE','SALES'])roles[code]=await m.Role.create({code,name:code,permissionIds:permissions.filter(p=>ROLE_PERMISSIONS[code].includes(p.code)).map(p=>p._id)});
 [wa,wb]=await m.Warehouse.create([{code:'A',name:'Kho A',lengthMm:'10000',widthMm:'10000',clearHeightMm:'3000'},{code:'B',name:'Kho B',lengthMm:'10000',widthMm:'10000',clearHeightMm:'3000'}]);
 const user=async(name,role,warehouse)=>{const u=await m.User.create({username:name,fullName:name,passwordHash:'test-only',roleId:roles[role]._id,warehouseIds:[warehouse._id]});return m.User.findById(u._id).populate({path:'roleId',populate:{path:'permissionIds'}});};
 owner=await user('owner','OWNER',wa);a=await user('source','WAREHOUSE',wa);b=await user('destination','WAREHOUSE',wb);sales=await user('sales','SALES',wa);
 const loc=async(warehouse,code,type)=>m.WarehouseLocation.create({warehouseId:warehouse._id,code,name:code,locationType:type,isPickable:type==='STORAGE',usableLengthMm:'5000',usableWidthMm:'5000'});
 source=await loc(wa,'SRC','STORAGE');stage=await loc(wa,'STAGE','STAGING');receiving=await loc(wb,'IN','RECEIVING');storage=await loc(wb,'STORE','STORAGE');quarantine=await loc(wb,'Q','QUARANTINE');
 await m.Uom.create({code:'PIECE',name:'Viên'});const category=await m.Category.create({code:'TEST',name:'Test'});
 product=await m.Product.create({sku:'TILE',name:'Gạch thử',manufacturerCode:'TEST',categoryId:category._id,color:'White',baseUnit:'PIECE',wholeBaseUnits:true,lengthMm:'600',widthMm:'600',heightMm:'10'});
 batch=await m.ProductBatch.create({productId:product._id,manufacturerLot:'LOT',identificationStatus:'VERIFIED',piecesPerCarton:4,cartonLengthMm:'620',cartonWidthMm:'620',cartonHeightMm:'50'});
 const point=await m.StockHoldingPoint.create({type:'LOCATION',locationId:source._id});balance=await m.InventoryBalance.create({holdingPointId:point._id,batchId:batch._id,qualityStatus:'GOOD',ownerType:'STORE',quantityBase:'40',version:0,packagingPortions:[{packagingState:'SEALED',sealedPackCount:10,quantityBase:'40',createdBy:a._id,packagingSnapshot:{packageUnit:'BOX',baseUnitsPerPackage:'4',outerLengthMm:'620',outerWidthMm:'620',outerHeightMm:'50'}}]});
});
test.after(async()=>{if(enabled){assert.match(mongoose.connection.name,/^wmsd_hieudt_scope_test_/);await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
run('Owner without any warehouse assignments manages 3D functions in every warehouse',async()=>{
 const actor={...owner.toObject(),warehouseIds:[]};
 assert.deepEqual(new Set((await stock.warehouseList(actor)).items.map(item=>item.id)),new Set([String(wa._id),String(wb._id)]));
 const layout={points:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],height:3,doors:[],functions:[{id:'staging',name:'Khu tập kết'}]};
 for(const warehouse of [wa,wb]){
  const detail=await stock.warehouseDetail(actor,String(warehouse._id));
  const input={layout,expectedUpdatedAt:new Date(detail.updatedAt).toISOString(),apply:true};
  const saved=await saveLayout(actor,String(warehouse._id),input);
  assert.deepEqual(saved.layout.functions,layout.functions);
  const updated=await stock.warehouseDetail(actor,String(warehouse._id));
  assert.deepEqual(updated.layout3dApplied.functions,layout.functions);
 }
 const grants=(...codes)=>codes.map(code=>({code,isActive:true}));
 const editor={...a.toObject(),roleId:{code:'CUSTOM_EDITOR',permissionIds:grants('warehouse_location:update')}};
 const next={layout:{...layout,functions:[]},expectedUpdatedAt:(await m.Warehouse.findById(wa._id)).updatedAt.toISOString()};
 await assert.rejects(saveLayout(editor,String(wa._id),next),{code:'ERR-CORE-403-001'});
 editor.roleId.permissionIds.push(...grants('warehouse_layout_function:update'));
 await assert.rejects(saveLayout(editor,String(wb._id),next),{code:'ERR-CORE-403-002'});
 const changed=await saveLayout(editor,String(wa._id),next);
 assert.deepEqual(changed.layout.functions,[]);
});
run('3D slot saves only same-warehouse active links and can clear a retained inactive link',async()=>{
 const warehouseId=String(wa._id);
 const slot={id:'slot',name:'Ô A-01',x:0,y:0,width:1,length:1,locationId:String(source._id)};
 const layout={points:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],height:3,doors:[],
  functions:[{id:'f',name:'Lưu trữ'}],zones:[{id:'zone',name:'Khu A',x:1,y:1,width:2,length:2,rotation:0,color:'#ffffff',functionId:'f',slots:[slot]}]};
 const current=async()=>new Date((await stock.warehouseDetail(owner,warehouseId)).updatedAt).toISOString();
 const save=async(apply=false)=>saveLayout(owner,warehouseId,{layout,expectedUpdatedAt:await current(),apply});
 slot.locationId=String(storage._id);
 await assert.rejects(save(),/thuộc kho này/);
 slot.locationId=key();
 await assert.rejects(save(),/thuộc kho này/);
 slot.locationId=String(source._id);
 await save(true);
 const read=await stock.warehouseDetail(owner,warehouseId);
 assert.equal(read.layout3dApplied.zones[0].slots[0].locationId,String(source._id));
 await m.WarehouseLocation.updateOne({_id:stage._id},{$set:{isActive:false}});
 try{
  slot.locationId=String(stage._id);
  await assert.rejects(save(),/đã ngừng hoạt động/);
  await m.WarehouseLocation.updateOne({_id:stage._id},{$set:{isActive:true}});
  await save();
  await m.WarehouseLocation.updateOne({_id:stage._id},{$set:{isActive:false}});
  assert.equal((await save()).layout.zones[0].slots[0].locationId,String(stage._id));
  delete slot.locationId;
  await save(true);
  const final=await stock.warehouseDetail(owner,warehouseId);
  assert.equal(final.layout3dApplied.zones[0].slots[0].locationId,undefined);
  assert.equal((await m.InventoryBalance.findById(balance._id)).quantityBase.toString(),'40');
 }finally{await m.WarehouseLocation.updateOne({_id:stage._id},{$set:{isActive:true}});}
});
run('3D slot size and location usable size stay synchronised both ways',async()=>{
 const warehouseId=String(wa._id);
 const extra=await m.WarehouseLocation.create({warehouseId:wa._id,code:'SYNC',name:'Đồng bộ',locationType:'STAGING',isPickable:false,usableLengthMm:'4000',usableWidthMm:'2000'});
 const twin=await m.WarehouseLocation.create({warehouseId:wa._id,code:'TWIN',name:'Hai ô',locationType:'STAGING',isPickable:false,usableLengthMm:'1000',usableWidthMm:'1000'});
 const slot={id:'sync-slot',name:'Ô S',x:0,y:0,width:2,length:4,locationId:String(extra._id)};
 const layout={points:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],height:3,doors:[],functions:[{id:'f',name:'Lưu trữ'}],
  zones:[{id:'sync-zone',name:'Khu S',x:1,y:1,width:5,length:5,rotation:0,color:'#ffffff',functionId:'f',slots:[slot]}]};
 const stamp=async()=>(await m.Warehouse.findById(wa._id)).updatedAt.toISOString();
 const save=async()=>saveLayout(owner,warehouseId,{layout,expectedUpdatedAt:await stamp()});
 // Linking a slot whose size already matches changes nothing.
 assert.deepEqual((await save()).syncedLocations,[]);
 // Resizing the slot on the drawing updates the catalogue, with an audit entry.
 slot.width=2.5;slot.length=3.25;
 const saved=await save();
 assert.deepEqual(saved.syncedLocations,['SYNC']);
 let row=await m.WarehouseLocation.findById(extra._id);
 assert.equal(String(row.usableLengthMm),'3250');assert.equal(String(row.usableWidthMm),'2500');assert.equal(row.version,extra.version+1);
 assert.ok(await m.AuditLog.exists({action:'SYNC_LOCATION_SIZE_FROM_LAYOUT'}));
 // Saving again without touching the slot does not rewrite the location edited in the catalogue.
 await m.WarehouseLocation.updateOne({_id:extra._id},{$set:{usableLengthMm:'3000'}});
 assert.deepEqual((await save()).syncedLocations,[]);
 assert.equal(String((await m.WarehouseLocation.findById(extra._id)).usableLengthMm),'3000');
 // Editing the location resizes its single slot when it fits the zone…
 const edit=async(length,width)=>{const current=await stock.locationDetail(owner,String(extra._id));
  return stock.saveLocation(owner,String(extra._id),{warehouseId,code:'SYNC',name:'Đồng bộ',locationType:'STAGING',isPickable:false,isActive:true,usableLengthMm:length,usableWidthMm:width,expectedVersion:current.version,idempotencyKey:key()});};
 await edit('4500','3000');
 let drawn=(await m.Warehouse.findById(wa._id)).layout3d.zones[0].slots[0];
 assert.equal(drawn.length,4.5);assert.equal(drawn.width,3);
 // …and leaves the drawing alone when it would overflow the zone.
 await edit('6000','3000');
 drawn=(await m.Warehouse.findById(wa._id)).layout3d.zones[0].slots[0];
 assert.equal(drawn.length,4.5);
 // A location on two slots is reported, not resized.
 Object.assign(slot,{length:4.5,width:3});
 layout.zones[0].slots=[slot,{id:'t1',name:'T1',x:3.5,y:0,width:1,length:1,locationId:String(twin._id)},{id:'t2',name:'T2',x:3.5,y:1.5,width:1.5,length:1,locationId:String(twin._id)}];
 const twinSave=await save();
 assert.ok(twinSave.warnings.some(warning=>warning.includes('TWIN')));
 assert.equal(String((await m.WarehouseLocation.findById(twin._id)).usableWidthMm),'1000');
 // Shrinking below the stock already stored is rejected and the drawing is not saved.
 const before=await stamp();
 layout.zones[0].slots=[{...slot,id:'src-slot',name:'Ô SRC',width:0.1,length:0.1,locationId:String(source._id)}];
 await assert.rejects(save(),/không đủ chỗ/);
 assert.equal(await stamp(),before);
});
run('a new unlinked slot becomes a storage location named after the slot when the layout is saved',async()=>{
 const warehouseId=String(wb._id);
 const stamp=async()=>(await m.Warehouse.findById(warehouseId)).updatedAt.toISOString();
 const layout={points:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],height:3,doors:[],
  functions:[{id:'stg',name:'Khu tập kết'},{id:'f',name:'Lưu trữ'}],
  zones:[{id:'auto-z',name:'Khu T',x:0,y:0,width:4,length:4,rotation:0,color:'#ffffff',functionId:'stg',slots:[{id:'auto-1',name:'TK-01',x:0,y:0,width:1.5,length:2}]},
   {id:'auto-s',name:'Khu L',x:5,y:0,width:4,length:4,rotation:0,color:'#ffffff',functionId:'f',slots:[{id:'auto-2',name:'L-01',x:0,y:0,width:1,length:1}]}]};
 const saved=await saveLayout(owner,warehouseId,{layout,expectedUpdatedAt:await stamp()});
 assert.deepEqual(saved.createdLocations,['TK-01','L-01']);
 const staging=await m.WarehouseLocation.findOne({warehouseId:wb._id,code:'TK-01'}).lean();
 assert.equal(staging.locationType,'STAGING');assert.equal(staging.isPickable,false);assert.equal(staging.name,'Khu T / TK-01');
 assert.equal(String(staging.usableLengthMm),'2000');assert.equal(String(staging.usableWidthMm),'1500');
 assert.equal((await m.WarehouseLocation.findOne({warehouseId:wb._id,code:'L-01'}).lean()).locationType,'STORAGE');
 assert.equal(saved.layout.zones[0].slots[0].locationId,String(staging._id));
 assert.ok(await m.AuditLog.exists({action:'CREATE_LOCATION_FROM_LAYOUT_SLOT'}));
 // Saving again creates nothing; an unlinked slot that is already on the drawing is left alone.
 const kept=saved.layout;kept.zones[1].slots[0]={...kept.zones[1].slots[0]};delete kept.zones[1].slots[0].locationId;
 await m.Warehouse.updateOne({_id:wb._id},{$set:{layout3d:kept}},{timestamps:false});
 assert.deepEqual((await saveLayout(owner,warehouseId,{layout:kept,expectedUpdatedAt:await stamp()})).createdLocations,[]);
 // Asked explicitly, an unlinked slot that was already on the drawing becomes a location too.
 kept.zones[1].slots[0].name='L-09';
 const asked=await saveLayout(owner,warehouseId,{layout:kept,expectedUpdatedAt:await stamp(),createLocationForSlots:['auto-2']});
 assert.deepEqual(asked.createdLocations,['L-09']);assert.ok(asked.layout.zones[1].slots[0].locationId);
 kept.zones[1].slots[0].locationId=asked.layout.zones[1].slots[0].locationId;
 await assert.rejects(saveLayout(owner,warehouseId,{layout:kept,expectedUpdatedAt:await stamp(),createLocationForSlots:['missing']}),/không có trên bản vẽ/);
 // A slot whose name is already a location code is rejected and nothing is saved.
 const before=await stamp();
 kept.zones[1].slots.push({id:'auto-3',name:'store',x:2,y:2,width:1,length:1});
 await assert.rejects(saveLayout(owner,warehouseId,{layout:kept,expectedUpdatedAt:before}),/mã vị trí store đã có/);
 assert.equal(await stamp(),before);
 assert.equal(await m.WarehouseLocation.countDocuments({warehouseId:wb._id,code:/^(TK|L)-/}),3);
 // Without permission to create locations the drawing still saves, with a warning.
 const grants=(...codes)=>codes.map(code=>({code,isActive:true}));
 const editor={...b.toObject(),roleId:{code:'CUSTOM_EDITOR',permissionIds:grants('warehouse_location:update')}};
 kept.zones[1].slots[1].name='L-02';
 const limited=await saveLayout(editor,warehouseId,{layout:kept,expectedUpdatedAt:before});
 assert.deepEqual(limited.createdLocations,[]);assert.ok(limited.warnings.some(w=>w.includes('không có quyền tạo vị trí')));
 assert.equal(limited.layout.zones[1].slots[1].locationId,undefined);
});
run('UC38–44 location commands, scope, inventory details and freeze/capacity checks use native data',async()=>{
 const body={idempotencyKey:key(),warehouseId:String(wa._id),code:'NEW',name:'Vị trí mới',areaCode:'A',locationType:'STORAGE',isActive:true,isPickable:true,usableLengthMm:'2000',usableWidthMm:'2000'};
 const result=await stock.saveLocation(owner,null,body);assert.equal((await stock.saveLocation(owner,null,body)).id,result.id);
 await assert.rejects(stock.saveLocation(a,null,{...body,idempotencyKey:key(),code:'NO'}));
 const edit={...body,idempotencyKey:key(),expectedVersion:1,name:'Đã sửa'};await stock.saveLocation(owner,result.id,edit);await assert.rejects(stock.saveLocation(owner,result.id,{...edit,idempotencyKey:key()}));
 const loc=await stock.locationDetail(owner,result.id);assert.equal(loc.name,'Đã sửa');assert.equal(loc.openTaskCount,0);
 await assert.rejects(stock.locationDetail(b,result.id));
 const row=await stock.inventoryDetail(a,String(balance._id));assert.equal(row.physicalQtyBase,'40');assert.equal(row.availableQtyBase,'40');assert.equal(row.usableQtyBase,'40');const facets=await stock.options(a,'stock_movement:read');assert.equal(facets.products[0].sku,'TILE');assert.equal(facets.batches[0].manufacturerLot,'LOT');assert.ok(facets.locations.every(l=>l.warehouseId===String(wa._id)));
 await assert.rejects(stock.inventoryDetail(b,String(balance._id)));
 const restricted=await stock.inventoryDetail(sales,String(balance._id));assert.equal(restricted.availableQtyBase,'40');assert.equal(restricted.physicalQtyBase,undefined);
 const existing=await stock.locationDetail(owner,String(source._id));await assert.rejects(stock.saveLocation(owner,String(source._id),{...body,code:source.code,idempotencyKey:key(),expectedVersion:existing.version,isActive:false}));
 const lock=await m.StocktakeLocationLock.create({stocktakeId:new mongoose.Types.ObjectId(),locationId:result.id,scopeVersion:1,lockedAt:new Date(),lockedBy:a._id,status:'LOCKED'});
 await assert.rejects(stock.saveLocation(owner,result.id,{...edit,idempotencyKey:key(),expectedVersion:loc.version}),/khóa/);await m.StocktakeLocationLock.deleteOne({_id:lock._id});
});
run('transfer source locations persist and cap both the request and each dispatch', async () => {
  const second = await m.WarehouseLocation.create({ warehouseId: wa._id, code: 'SRC-2', name: 'Ô thứ hai', locationType: 'STORAGE', isPickable: true });
  const point = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: second._id });
  const secondBalance = await m.InventoryBalance.create({ holdingPointId: point._id, batchId: batch._id, qualityStatus: 'GOOD', ownerType: 'STORE', quantityBase: '10', version: 0 });
  const allocations = [{ sourceBalanceId: String(balance._id), qtyBase: '3' }, { sourceBalanceId: String(secondBalance._id), qtyBase: '5' }];
  const body = (enteredQty, sourceLocations) => ({ idempotencyKey: key(), sourceWarehouseId: String(wa._id), destinationWarehouseId: String(wb._id), reason: 'Cần hàng',
    lines: [{ productId: String(product._id), lotId: String(batch._id), enteredUnit: 'PIECE', enteredQty, sourceLocations }] });

  await assert.rejects(transfers.createRequest(a, body('7', allocations)), /Tổng số lượng các ô/);
  await assert.rejects(transfers.createRequest(a, body('45', [{ ...allocations[0], qtyBase: '40.5' }, { ...allocations[1], qtyBase: '4.5' }])), /yêu cầu số lượng nguyên/);
  await assert.rejects(transfers.createRequest(a, body('46', [{ ...allocations[0], qtyBase: '41' }, allocations[1]])), /Vị trí SRC chỉ còn 40/);
  const lock = await m.StocktakeLocationLock.create({ stocktakeId: new mongoose.Types.ObjectId(), locationId: second._id, scopeVersion: 1, lockedAt: new Date(), lockedBy: a._id, status: 'LOCKED' });
  await assert.rejects(transfers.createRequest(a, body('8', allocations)), /Vị trí SRC-2 đang khóa kiểm kê/);
  await m.StocktakeLocationLock.deleteOne({ _id: lock._id });

  const request = await transfers.createRequest(a, body('8', allocations));
  const detail = await getTransfer(a, request.id);
  assert.deepEqual(detail.items[0].sourceLocations.map(({ locationCode, qtyBase }) => ({ locationCode, qtyBase })), [
    { locationCode: 'SRC', qtyBase: '3' }, { locationCode: 'SRC-2', qtyBase: '5' },
  ]);
  const revised = [{ ...allocations[0], qtyBase: '2' }, { ...allocations[1], qtyBase: '6' }];
  await transfers.updateRequest(a, request.id, { ...body('8', revised), expectedVersion: detail.version });
  const updated = await getTransfer(a, request.id);
  assert.equal(updated.items[0]._id, detail.items[0]._id);
  assert.deepEqual(updated.items[0].sourceLocations.map(location => location.qtyBase), ['2', '6']);
  assert.equal((await freeQuantity(await m.InventoryBalance.findById(balance._id))).toFixed(), '40');

  await transfers.reviewRequest(owner, request.id, { idempotencyKey: key(), expectedVersion: updated.version, decision: 'APPROVE', reason: 'Đủ căn cứ' });
  const dispatch = (version, qtyBase) => ({ idempotencyKey: key(), expectedVersion: version,
    lines: [{ requestLineId: detail.items[0]._id, sourceBalanceId: String(balance._id), stagingLocationId: String(stage._id), qtyBase }] });
  let approved = await getTransfer(a, request.id);
  await assert.rejects(transfers.createDispatch(a, request.id, dispatch(approved.version, '3')), /vượt số lượng có thể xuất theo phân bổ/);
  const first = await transfers.createDispatch(a, request.id, dispatch(approved.version, '1'));
  approved = await getTransfer(a, request.id);
  await assert.rejects(transfers.createDispatch(a, request.id, dispatch(approved.version, '2')), /vượt số lượng có thể xuất theo phân bổ/);
  await transfers.cancelDraftDispatch(a, first.id, { idempotencyKey: key(), expectedVersion: 1, reason: 'Gom lại một đợt' });
  approved = await getTransfer(a, request.id);
  const replacement = dispatch(approved.version, '2');
  replacement.lines.push({ ...replacement.lines[0], sourceBalanceId: String(secondBalance._id), qtyBase: '6' });
  const saved = await transfers.createDispatch(a, request.id, replacement);
  await transfers.cancelDraftDispatch(a, saved.id, { idempotencyKey: key(), expectedVersion: 1, reason: 'Kết thúc kiểm tra' });

  const forty = await transfers.createRequest(a, body('160', [{ ...allocations[0], qtyBase: '40' }]));
  const fortyDetail = await getTransfer(a, forty.id);
  assert.equal(fortyDetail.items[0].qtyBase, '160');
  assert.equal(fortyDetail.items[0].sourceLocations[0].qtyBase, '40');

  const partial = await transfers.createRequest(a, body('12', revised));
  const partialDetail = await getTransfer(a, partial.id);
  assert.equal(partialDetail.items[0].qtyBase, '12');
  assert.deepEqual(partialDetail.items[0].sourceLocations.map(location => location.qtyBase), ['2', '6']);
  await transfers.reviewRequest(owner, partial.id, { idempotencyKey: key(), expectedVersion: partialDetail.version, decision: 'APPROVE', reason: 'Chấp nhận phần chưa phân bổ' });
  const partialApproved = await getTransfer(a, partial.id);
  const extra = dispatch(partialApproved.version, '7');
  extra.lines[0].requestLineId = partialApproved.items[0]._id;
  await assert.rejects(transfers.createDispatch(a, partial.id, extra), /vượt số lượng có thể xuất theo phân bổ/);
  extra.idempotencyKey = key();
  extra.lines[0].qtyBase = '6';
  extra.lines.push({ ...extra.lines[0], sourceBalanceId: String(secondBalance._id) });
  const partialDispatch = await transfers.createDispatch(a, partial.id, extra);
  await transfers.cancelDraftDispatch(a, partialDispatch.id, { idempotencyKey: key(), expectedVersion: 1, reason: 'Kết thúc kiểm tra' });
});

run('UC53–56/120 dispatch reserves once, partial mixed receipt and linked difference resolution preserve stock',async()=>{
 const request=await transfers.createRequest(a,{idempotencyKey:key(),sourceWarehouseId:String(wa._id),destinationWarehouseId:String(wb._id),reason:'Cần hàng',lines:[{productId:String(product._id),enteredUnit:'PIECE',enteredQty:'8'}]});
 await assert.rejects(transfers.reviewRequest(a,request.id,{idempotencyKey:key(),expectedVersion:1,decision:'APPROVE',reason:'self'}));
 await transfers.reviewRequest(owner,request.id,{idempotencyKey:key(),expectedVersion:1,decision:'REVISE',reason:'Bổ sung lý do'});
 let req=await m.WarehouseTransferRequest.findById(request.id);await transfers.updateRequest(a,request.id,{idempotencyKey:key(),expectedVersion:req.version,sourceWarehouseId:String(wa._id),destinationWarehouseId:String(wb._id),reason:'Đã bổ sung',lines:[{productId:String(product._id),enteredUnit:'PIECE',enteredQty:'8'}]});
 req=await m.WarehouseTransferRequest.findById(request.id);await transfers.reviewRequest(owner,request.id,{idempotencyKey:key(),expectedVersion:req.version,decision:'APPROVE',reason:'Đủ căn cứ'});
 req=await m.WarehouseTransferRequest.findById(request.id);const dispatchBody={idempotencyKey:key(),expectedVersion:req.version,lines:[{requestLineId:String(req.items[0]._id),sourceBalanceId:String(balance._id),stagingLocationId:String(stage._id),qtyBase:'8'}]};
 const dispatch=await transfers.createDispatch(a,request.id,dispatchBody);assert.equal((await transfers.createDispatch(a,request.id,dispatchBody)).replayed,true);assert.equal((await freeQuantity(await m.InventoryBalance.findById(balance._id))).toFixed(),'32');
 await transfers.cancelDraftDispatch(a,dispatch.id,{idempotencyKey:key(),expectedVersion:1,reason:'Đổi phiếu nháp'});assert.equal((await freeQuantity(await m.InventoryBalance.findById(balance._id))).toFixed(),'40');
 req=await m.WarehouseTransferRequest.findById(request.id);const replacement=await transfers.createDispatch(a,request.id,{...dispatchBody,idempotencyKey:key(),expectedVersion:req.version});dispatch.id=replacement.id;
 const task=await transfers.createRequirement(a,dispatch.id,{idempotencyKey:key(),expectedVersion:1});await transfers.confirmTask(a,task.id,{idempotencyKey:key(),expectedVersion:1,recipientName:'Người nhận thực tế'});
 let sent=await m.TransferDispatch.findById(dispatch.id);const report=await differences.proposeDifference(b,dispatch.id,{idempotencyKey:key(),expectedVersion:sent.version,reason:'Chưa nhận được hàng',lines:[{dispatchLineId:String(sent.items[0]._id),qtyBase:'8'}]});
 sent=await m.TransferDispatch.findById(dispatch.id);await assert.rejects(transfers.receiveTransfer(a,dispatch.id,{idempotencyKey:key(),expectedVersion:sent.version,lines:[{dispatchLineId:String(sent.items[0]._id),locationId:String(receiving._id),qtyBase:'8',qualityCode:'GOOD'}]}));
 const received=await transfers.receiveTransfer(b,dispatch.id,{idempotencyKey:key(),expectedVersion:sent.version,lines:[{dispatchLineId:String(sent.items[0]._id),locationId:String(receiving._id),qtyBase:'4',qualityCode:'GOOD'},{dispatchLineId:String(sent.items[0]._id),locationId:String(quarantine._id),qtyBase:'4',qualityCode:'DAMAGED',damageReason:'Vỡ khi vận chuyển'}]});
 await differences.reviewDifference(owner,report.id,{idempotencyKey:key(),expectedVersion:1,decision:'APPROVE',reason:'Đã nhận đủ theo phiếu liên kết',receiptId:received.id});
 const receipt=await m.TransferReceipt.findById(received.id);const good=receipt.items.find(i=>i.details.qualityCode==='GOOD');const putaway=await transfers.createRequirement(b,received.id,{idempotencyKey:key(),expectedVersion:receipt.version});await transfers.confirmTask(b,putaway.id,{idempotencyKey:key(),expectedVersion:putaway.version,destinations:[{receiptLineId:String(good._id),locationId:String(storage._id)}]});
 await assert.rejects(differences.reviewDifference(b,report.id,{idempotencyKey:key(),expectedVersion:1,decision:'APPROVE',reason:'self',receiptId:received.id}));
 const detail=await getTransfer(b,request.id);assert.equal(detail.workflowStatus,'COMPLETED');assert.equal(detail.lineProgress[0].receivedGoodQtyBase,'4');assert.equal(detail.lineProgress[0].receivedDamagedQtyBase,'4');assert.equal(detail.lineProgress[0].transitQtyBase,'0');assert.equal(detail.progress[0].lines[0].remainingQtyBase,'0');assert.equal(detail.differences[0].workflowStatus,'RESOLVED');
 const logs=await stock.movements(b,page);assert.ok(logs.total>0);const event=await stock.movements(b,page,logs.items[0].id);assert.ok(event.to||event.from);const hidden=(await stock.movements(a,page)).items.find(e=>!e.from&&e.to);if(hidden)assert.equal(hidden.from,null);
 const inventory=await stock.inventory(b,page);assert.equal(inventory.items.find(r=>r.quality==='DAMAGED').availableQtyBase,'0');
});
run('catalogue and drawing share slot bindings in one warehouse transaction',async()=>{
 const warehouseId=String(wa._id);
 const stamp=async()=>(await m.Warehouse.findById(warehouseId)).updatedAt.toISOString();
 const slot={id:'one',name:'Ô 1',x:0,y:0,width:1,length:1};
 const layout={points:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],height:3,doors:[],
   functions:[{id:'f',name:'Lưu trữ'}],zones:[{id:'z',name:'Khu A',x:1,y:1,width:4,length:2,rotation:0,color:'#ffffff',functionId:'f',
     slots:[slot,{...slot,id:'two',name:'Ô 2',x:2,locationId:String(source._id)}]}]};
 // Slot 'one' already exists on the drawing, so saving does not turn it into a location of its own.
 await m.Warehouse.updateOne({_id:warehouseId},{$set:{layout3d:layout}},{timestamps:false});
 await saveLayout(owner,warehouseId,{layout,expectedUpdatedAt:await stamp(),apply:true});
 const body={warehouseId,code:'BOUND',name:'Vị trí liên kết',locationType:'STORAGE',isActive:true,isPickable:true,usableLengthMm:'800',usableWidthMm:'1000'};
 const create={...body,idempotencyKey:key(),layoutBinding:{slotIds:['one'],expectedUpdatedAt:await stamp()}};
 const result=await stock.saveLocation(owner,null,create);
 assert.equal((await stock.saveLocation(owner,null,create)).id,result.id);
 const detail=await stock.locationDetail(owner,result.id);
 assert.equal(detail.warehouse.layout3d.zones[0].slots[0].locationId,result.id);
 assert.equal(detail.warehouse.layout3dApplied.zones[0].slots[0].locationId,undefined);
 const edit=(slotIds,expectedUpdatedAt)=>stock.saveLocation(owner,result.id,{...body,expectedVersion:1,idempotencyKey:key(),layoutBinding:{slotIds,expectedUpdatedAt}});
 await assert.rejects(edit([],create.layoutBinding.expectedUpdatedAt),/đã thay đổi/);
 await assert.rejects(edit(['two'],await stamp()),/vị trí khác/);
 await assert.rejects(edit(['missing'],await stamp()),/không tồn tại/);
 await assert.rejects(stock.saveLocation(owner,null,{...create,warehouseId:String(wb._id),code:'WRONG',idempotencyKey:key(),layoutBinding:{slotIds:['one'],expectedUpdatedAt:(await m.Warehouse.findById(wb._id)).updatedAt.toISOString()}}),/không tồn tại/);
 assert.equal(await m.WarehouseLocation.countDocuments({code:'WRONG'}),0);
 await edit([],await stamp());
 const final=await stock.warehouseDetail(owner,warehouseId);
 assert.equal(final.layout3d.zones[0].slots[0].locationId,undefined);
 assert.equal(final.layout3d.zones[0].slots[1].locationId,String(source._id));
});
