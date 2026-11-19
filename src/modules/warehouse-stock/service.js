import { databaseId } from '../../models/document-identity.js';
import mongoose from 'mongoose';
import * as m from '../../models/runtime.js';
import { exact, ExactDecimal } from '../../models/model-utils.js';
import { isOwner, requirePermission, requireWarehouseAccess, hasPermission } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { dto, serialize, page, transaction } from '../../shared/utils/persistence.js';
import { command, checkVersion, same, saveVersion } from '../../shared/utils/document-command.js';
import { remainingReservation, verifyCapacity, guardWarehouses } from '../../shared/utils/stock.js';
import { stockQuantities } from '../../shared/utils/stock-availability-read.js';
import { blindCountScope } from '../../shared/utils/blind-count.js';
import { notFoundError, validationError } from '../../shared/utils/ApiError.js';
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const warehouseScope = user => isOwner(user) ? {} : { _id: { $in: user.warehouseIds || [] } };
async function scopeContext(user, query = {}, session, scopedWarehouses) {
  if (query.warehouseId) requireWarehouseAccess(user, query.warehouseId);
  const warehouses = scopedWarehouses ?? await m.Warehouse.find({ ...warehouseScope(user), ...(query.warehouseId && { _id: query.warehouseId }) }).select('_id code name isActive clearHeightMm').session(session).lean();
  const locations = await m.WarehouseLocation.find({ warehouseId: { $in: warehouses.map(w => w._id) }, ...(query.locationId && { _id: query.locationId }) }).select('_id warehouseId code name isActive isPickable').session(session).lean();
  const dispatches = query.locationId ? [] : await m.TransferDispatch.find({ 'header.sourceWarehouseId': { $in: warehouses.map(w => w._id) } }).select('_id header.sourceWarehouseId items._id').session(session).lean();
  const points = await m.StockHoldingPoint.find({ $or: [{ locationId: { $in: locations.map(l => l._id) } }, { dispatchLineId: { $in: dispatches.flatMap(d => d.items.map(i => i._id)) } }] }).select('_id type locationId dispatchLineId').session(session).lean();
  return { warehouses, locations, dispatches, points };
}
export async function options(user, permission) {
  requirePermission(user, permission);
  const warehouses = await m.Warehouse.find(warehouseScope(user)).select('_id code name isActive clearHeightMm').lean();
  const base={warehouses:warehouses.map(dto),capturedAt:new Date().toISOString()};
  if(permission==='warehouse_location:read')return base;
  const ctx=await scopeContext(user,{},undefined,warehouses);
  const balances=await m.InventoryBalance.find({holdingPointId:{$in:ctx.points.map(p=>p._id)},...(currentRole(user)?.code==='SALES'&&{ownerType:'STORE',qualityStatus:'GOOD'})}).select('_id batchId').lean();
  const batches=await m.ProductBatch.find({_id:{$in:balances.map(b=>b.batchId)},...(currentRole(user)?.code==='SALES'&&{identificationStatus:'VERIFIED'})}).select('_id productId manufacturerLot').lean();
  const products=await m.Product.find({_id:{$in:batches.map(b=>b.productId)},...(currentRole(user)?.code==='SALES'&&{isActive:true})}).select('_id sku name').lean();
  const operations=permission==='stock_movement:read'?await m.StockTransaction.distinct('operation',{$or:[{'movements.fromBalanceId':{$in:balances.map(b=>b._id)}},{'movements.toBalanceId':{$in:balances.map(b=>b._id)}}]}):[];
  const productIds=new Set(products.map(product=>String(product._id)));
  return {...base,locations:ctx.locations.map(l=>({id:String(l._id),warehouseId:String(l.warehouseId),code:l.code,name:l.name})),products:products.map(dto),batches:batches.filter(b=>productIds.has(String(b.productId))).map(dto),operations:operations.sort()};
}
export async function warehouseList(user) {
  requirePermission(user, 'warehouse_location:read');
  const rows = await m.Warehouse.find(warehouseScope(user)).select('-layout3d -layout3dApplied -layout3dAppliedAt').sort({ code: 1 }).lean();
  const locationCounts = await m.WarehouseLocation.aggregate([{ $match: { warehouseId: { $in: rows.map(r => r._id) } } }, { $group: { _id: '$warehouseId', count: { $sum: 1 }, activeCount: { $sum: { $cond: ['$isActive', 1, 0] } } } }]);
  const counts = new Map(locationCounts.map(row => [String(row._id), row]));
  return { items: rows.map(row => ({ ...dto(row), locationCount: counts.get(String(row._id))?.count ?? 0, activeLocationCount: counts.get(String(row._id))?.activeCount ?? 0 })), total: rows.length, capturedAt: new Date().toISOString() };
}
async function warehouseReplay(id, user, session) { const row = await m.Warehouse.findById(id).session(session); if (!row) throw notFoundError(); requireWarehouseAccess(user, row._id); return row; }
export function saveWarehouse(user, id, input) {
  return command(user, id ? 'UPDATE_WAREHOUSE' : 'CREATE_WAREHOUSE', id ? 'warehouse_location:update' : 'warehouse_location:create', id, input, warehouseReplay, async (session, actor) => {
    requirePermission(actor, id ? 'warehouse_location:update' : 'warehouse_location:create');
    const { idempotencyKey, expectedUpdatedAt, ...fields } = input;
    let row;
    if (!id) {
      row = await new m.Warehouse({ ...fields, isActive: fields.isActive ?? true }).save({ session });
    } else {
      row = await warehouseReplay(id, actor, session);
      const currentUpdatedAt = row.updatedAt?.toISOString();
      if (!expectedUpdatedAt || currentUpdatedAt !== new Date(expectedUpdatedAt).toISOString()) throw validationError('Kho đã thay đổi, hãy tải lại');
      if (fields.code !== row.code) throw validationError('Mã kho không được đổi sau khi tạo');
      if (row.isActive && fields.isActive === false) {
        const locations = await m.WarehouseLocation.find({ warehouseId: row._id }).select('_id').session(session);
        const locationIds = locations.map(l => l._id);
        const lockedLocations = await m.StocktakeLocationLock.exists({ locationId: { $in: locationIds }, status: 'LOCKED' }).session(session);
        if (lockedLocations) throw validationError('Không thể ngừng kho đang khóa kiểm kê');
        const points = await m.StockHoldingPoint.find({ locationId: { $in: locationIds } }).select('_id').session(session);
        const balances = await m.InventoryBalance.find({ holdingPointId: { $in: points.map(p => p._id) }, quantityBase: { $gt: 0 } }).session(session);
        const reservations = await m.StockReservation.find({ balanceId: { $in: balances.map(b => b._id) } }).session(session);
        const openTasks = await m.TransferOrder.exists({ workflowStatus: { $in: ['OPEN', 'PARTIAL', 'DRAFT'] }, $or: [{ 'items.details.fromLocationId': { $in: locationIds } }, { 'items.details.toLocationId': { $in: locationIds } }] }).session(session);
        if (balances.length || reservations.some(r => remainingReservation(r).gt(0)) || openTasks) throw validationError('Không thể ngừng kho còn tồn, giữ hàng hoặc nhiệm vụ mở');
      }
      const nextUpdatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
      const updated = await m.Warehouse.findOneAndUpdate({ _id: row._id, updatedAt: row.updatedAt }, { $set: { ...fields, updatedAt: nextUpdatedAt } }, { session, timestamps: false, returnDocument: 'after', runValidators: true });
      if (!updated) throw validationError('Kho đã thay đổi, hãy tải lại');
      row = updated;
      const locationIds = await m.WarehouseLocation.find({ warehouseId: row._id }).distinct('_id').session(session);
      if (locationIds.length) await verifyCapacity(locationIds, session);
    }
    row.status = row.isActive ? 'ACTIVE' : 'INACTIVE';
    return { document: row, versionBefore: 0 };
  });
}
export async function warehouseDetail(user, id) { requirePermission(user, 'warehouse_location:read'); const row = await warehouseReplay(id, user); const locations = await m.WarehouseLocation.find({ warehouseId: row._id }).select('_id code name locationType isActive').sort({ code: 1 }).lean(); return { ...dto(row), locations: locations.map(dto) }; }
export async function locations(user, query) {
  requirePermission(user, 'warehouse_location:read');
  const context = await scopeContext(user, query);
  const filter = { _id: { $in: context.locations.map(l => l._id) }, ...(query.active && { isActive: query.active === 'true' }), ...(query.type && { locationType: query.type }) };
  if (query.q) filter.$or = ['code','name','areaCode','description'].map(key => ({ [key]: new RegExp(escape(query.q), 'i') }));
  const result = await page(m.WarehouseLocation, filter, query);
  return { ...result, warehouses: context.warehouses.map(dto), items: result.items.map(item => ({ ...item, warehouse: context.warehouses.find(w => same(w._id,item.warehouseId))?.name ?? null })) };
}
async function getLocation(user,id,session) {
  const row = await m.WarehouseLocation.findById(id).session(session);
  if (!row) throw notFoundError(); requireWarehouseAccess(user,row.warehouseId); return row;
}
export async function locationDetail(user,id) {
  requirePermission(user,'warehouse_location:read');
  return transaction(async session => {
    const row = await getLocation(user,id,session), warehouse = await m.Warehouse.findById(row.warehouseId).session(session).lean();
    const points = await m.StockHoldingPoint.find({locationId:id}).session(session).lean();
    const balances = await m.InventoryBalance.find({holdingPointId:{$in:points.map(p=>p._id)}}).session(session).lean();
    const locks = await m.StocktakeLocationLock.find({locationId:id,status:'LOCKED'}).select('_id stocktakeId').session(session).lean();
    const tasks = await m.TransferOrder.countDocuments({workflowStatus:{$in:['OPEN','PARTIAL','DRAFT']},$or:[{'items.details.fromLocationId':id},{'items.details.toLocationId':id}]}).session(session);
    const batches = await m.ProductBatch.find({_id:{$in:balances.map(b=>b.batchId)}}).session(session).lean();
    const products = await m.Product.find({_id:{$in:batches.map(b=>b.productId)}}).session(session).lean();
    const volume = await verifyLocationVolume(row,warehouse,balances);
    const blind = (await blindCountScope(user, session)).has(row._id);
    return {...dto(row),warehouse:warehouse?dto(warehouse):null,locked:locks.length>0,openTaskCount:tasks,capacity:volume&&blind?{...volume,occupiedMm3:null}:volume,blindCount:blind,
      stock:balances.filter(b=>exact(b.quantityBase).gt(0)).map(b=>{const batch=batches.find(l=>same(l._id,b.batchId)),product=products.find(p=>same(p._id,batch?.productId));return {id:String(b._id),batch:batch?.manufacturerLot??null,product:product?.name??null,sku:product?.sku??null,unit:product?.baseUnit??null,quality:b.qualityStatus,ownerType:b.ownerType,quantityBase:blind?null:String(b.quantityBase)};})};
  });
}
async function verifyLocationVolume(location,warehouse,balances) {
  if(!location.usableLengthMm||!location.usableWidthMm||!warehouse?.clearHeightMm)return null;
  const capacity=exact(location.usableLengthMm).mul(String(location.usableWidthMm)).mul(String(warehouse.clearHeightMm));
  let used=exact('0');
  for(const b of balances)for(const p of b.packagingPortions??[]){if(p.measuredVolumeMm3!=null)used=used.plus(String(p.measuredVolumeMm3));else if(p.packagingState==='SEALED'&&p.packagingSnapshot?.outerLengthMm)used=used.plus(exact(p.packagingSnapshot.outerLengthMm).mul(String(p.packagingSnapshot.outerWidthMm)).mul(String(p.packagingSnapshot.outerHeightMm)).mul(p.sealedPackCount));else if(exact(p.quantityBase).gt(0))return {capacityMm3:capacity.toFixed(),occupiedMm3:null};used=used.plus(String(p.extraOccupiedVolumeMm3??'0'));}
  return {capacityMm3:capacity.toFixed(),occupiedMm3:used.toFixed()};
}
async function bindLocationSlots(actor, location, binding, session) {
  requirePermission(actor, 'warehouse_location:update');
  const warehouse = await m.Warehouse.findOne({
    _id: location.warehouseId, updatedAt: new Date(binding.expectedUpdatedAt),
  }).select('layout3d updatedAt').session(session);
  if (!warehouse) throw validationError('Bản vẽ kho đã thay đổi. Hãy tải lại trước khi chọn ô.');
  const requested = new Set(binding.slotIds);
  const locationId = String(location._id);
  for (const zone of warehouse.layout3d?.zones ?? []) {
    for (const slot of zone.slots) {
      if (requested.delete(slot.id)) {
        if (slot.locationId === locationId) continue;
        if (slot.locationId) throw validationError(`Ô ${slot.name} đã gán cho vị trí khác.`);
        if (!location.isActive) throw validationError('Chỉ được gán ô mới cho vị trí đang hoạt động.');
        slot.locationId = locationId;
      } else if (slot.locationId === locationId) {
        delete slot.locationId;
      }
    }
  }
  if (requested.size) throw validationError('Ô đã chọn không tồn tại trên bản vẽ của kho này.');
  const updatedAt = new Date(Math.max(Date.now(), warehouse.updatedAt.getTime() + 1));
  await m.Warehouse.updateOne({_id:warehouse._id}, {$set:{layout3d:warehouse.layout3d, updatedAt}}, {session,timestamps:false});
}

const locationReplay = (id,user,session) => getLocation(user,id,session);
export function saveLocation(user,id,input) {
  return command(user,id?'UPDATE_STORAGE_LOCATION':'CREATE_STORAGE_LOCATION',id?'warehouse_location:update':'warehouse_location:create',id,input,locationReplay,async(session,actor)=>{
    const {idempotencyKey,expectedVersion,layoutBinding,...fields}=input;
    let row;
    if(id){
      row=await getLocation(actor,id,session);
      const warehouseId=input.warehouseId??String(row.warehouseId);
      requireWarehouseAccess(actor,warehouseId);
      await guardWarehouses([warehouseId],session);
      const warehouse=await m.Warehouse.findOne({_id:warehouseId,isActive:true}).session(session);if(!warehouse)throw validationError('Kho không hoạt động');
      checkVersion(row,expectedVersion);if(!same(row.warehouseId,warehouseId))throw validationError('Không đổi kho của vị trí');
      // Contend with every stock command and stocktake activation on the same location.
      await m.WarehouseLocation.updateOne({_id:id,version:expectedVersion},{$inc:{operationVersion:1}},{session});
      if(await m.StocktakeLocationLock.exists({locationId:id,status:'LOCKED'}).session(session))throw validationError('Vị trí đang khóa kiểm kê');
      const openTask=await m.TransferOrder.exists({workflowStatus:{$in:['OPEN','PARTIAL','DRAFT']},$or:[{'items.details.fromLocationId':id},{'items.details.toLocationId':id}]}).session(session);
      const points=await m.StockHoldingPoint.find({locationId:id}).session(session).lean();
      const balances=await m.InventoryBalance.find({holdingPointId:{$in:points.map(p=>p._id)}}).session(session);
      const reservations=await m.StockReservation.find({balanceId:{$in:balances.map(b=>b._id)}}).session(session);
      const busy=balances.some(b=>exact(b.quantityBase).gt(0))||openTask||reservations.some(r=>remainingReservation(r).gt(0));
      const next={isActive:fields.isActive??row.isActive,locationType:fields.locationType??row.locationType,isPickable:fields.isPickable??row.isPickable};
      if((!next.isActive||next.locationType!==row.locationType||next.isPickable!==row.isPickable)&&busy)throw validationError('Còn hàng, giữ hàng hoặc nhiệm vụ mở; không đổi loại/trạng thái/khả năng lấy hàng');
      if(openTask){
        const changesCode=fields.code!==undefined&&fields.code!==row.code;
        const changesSize=['usableLengthMm','usableWidthMm'].some(k=>fields[k]!==undefined&&(row[k]==null||!exact(fields[k]).eq(exact(row[k]))));
        if(changesCode||changesSize)throw validationError('Vị trí còn nhiệm vụ mở');
      }
      row.set(fields);row.operationVersion+=1;row=await saveVersion(row,expectedVersion,session);await verifyCapacity([id],session);
    }else{
      requireWarehouseAccess(actor,input.warehouseId);
      await guardWarehouses([input.warehouseId],session);
      const warehouse=await m.Warehouse.findOne({_id:input.warehouseId,isActive:true}).session(session);if(!warehouse)throw validationError('Kho không hoạt động');
      row=await new m.WarehouseLocation({...fields,version:1}).save({session});
    }
    if (layoutBinding) await bindLocationSlots(actor, row, layoutBinding, session);
    row.status=row.isActive?'ACTIVE':'INACTIVE';return {document:row,versionBefore:expectedVersion??0};
  });
}
const inventoryFields = { _id:1, holdingPointId:1, batchId:1, quantityBase:1, qualityStatus:1, ownerType:1, version:1 };
const inventoryJoins = () => [
  {$lookup:{from:m.ProductBatch.collection.name,localField:'batchId',foreignField:'_id',pipeline:[{$project:{_id:1,productId:1,manufacturerLot:1,identificationStatus:1}}],as:'batch'}},
  {$unwind:'$batch'},
  {$lookup:{from:m.Product.collection.name,localField:'batch.productId',foreignField:'_id',pipeline:[{$project:{_id:1,name:1,sku:1,baseUnit:1,isActive:1}}],as:'product'}},
  {$unwind:'$product'},
];
const salesInventoryFilter = user => currentRole(user)?.code==='SALES'
  ? [{ $match:{ownerType:'STORE',qualityStatus:'GOOD','batch.identificationStatus':'VERIFIED','product.isActive':true} }] : [];

async function inventoryRows(user, rows, view, session) {
  if(!rows.length)return [];
  const sales=currentRole(user)?.code==='SALES',summary=view==='summary';
  const locationIds=[...new Set(rows.flatMap(row=>row.location?[String(row.location._id)]:[]))];
  const locks=locationIds.length?await m.StocktakeLocationLock.find({locationId:{$in:locationIds},status:'LOCKED'}).select('locationId').session(session).lean():[];
  const frozenLocations=new Set(locks.map(row=>String(row.locationId)));
  const blind=await blindCountScope(user,session);
  const eligible=row=>row.warehouse?.isActive&&row.point?.type!=='IN_TRANSIT'&&!frozenLocations.has(String(row.location?._id))
    &&row.ownerType==='STORE'&&row.qualityStatus==='GOOD'&&row.batch.identificationStatus==='VERIFIED'&&row.product.isActive&&row.location?.isActive;
  const quantities=await stockQuantities(summary||sales?rows.filter(row=>eligible(row)&&row.location.isPickable):rows,session);
  return rows.map(row=>{
    const {point,location,warehouse,batch,product}=row,transit=point?.type==='IN_TRANSIT';
    const amounts=quantities.get(String(row._id));
    const available=eligible(row)&&location.isPickable?ExactDecimal.max(0,amounts.free).toFixed():'0';
    const base={id:String(row._id),warehouse:warehouse?.name??null,location:location?.code??(transit?'Đang chuyển':null),
      product:product.name,sku:product.sku,batch:batch.manufacturerLot,unit:product.baseUnit,availableQtyBase:blind.has(location?._id)?null:available};
    if(blind.has(location?._id)){
      const hidden={...base,availableQtyBase:null,blindCount:true};
      if(sales)return hidden;
      return {...hidden,quality:row.qualityStatus,ownerType:row.ownerType,physicalQtyBase:null,usableQtyBase:null,transitQtyBase:'0',custodyQtyBase:null,reservedQtyBase:null,heldQtyBase:null,pendingQtyBase:null,frozen:true,version:row.version};
    }
    if(!summary)Object.assign(base,{warehouseId:warehouse?String(warehouse._id):null,locationId:location?String(location._id):null,
      productId:String(product._id),batchId:String(batch._id)});
    if(sales)return base;
    Object.assign(base,{quality:row.qualityStatus,ownerType:row.ownerType,physicalQtyBase:transit?'0':String(row.quantityBase)});
    if(summary)return base;
    return {...base,usableQtyBase:eligible(row)?ExactDecimal.max(0,exact(row.quantityBase).minus(amounts.held)).toFixed():'0',
      transitQtyBase:transit?String(row.quantityBase):'0',custodyQtyBase:row.ownerType==='STORE'?'0':String(row.quantityBase),
      reservedQtyBase:amounts.reserved.toFixed(),heldQtyBase:amounts.held.toFixed(),pendingQtyBase:amounts.pending.toFixed(),
      frozen:frozenLocations.has(String(location?._id)),version:row.version};
  });
}

export async function inventory(user,query) {
  requirePermission(user,'inventory:read');
  return transaction(async session=>{
    const ctx=await scopeContext(user,query,session);
    const fields={...inventoryFields};
    if(query.view==='summary')delete fields.version;
    const pipeline=[{$match:{holdingPointId:{$in:ctx.points.map(p=>p._id)},...(query.balanceId&&{_id:databaseId(query.balanceId)}),
      ...(query.batchId&&{batchId:databaseId(query.batchId)}),...(query.quality&&{qualityStatus:query.quality}),...(query.ownerType&&{ownerType:query.ownerType})}},
      {$project:fields},...inventoryJoins()];
    if(query.productId)pipeline.push({$match:{'product._id':databaseId(query.productId)}});
    if(query.q){
      const regex=new RegExp(escape(query.q),'i');
      const matchingLocations=new Set(ctx.locations.filter(l=>regex.test(l.code)||regex.test(l.name??'')).map(l=>String(l._id)));
      const points=ctx.points.filter(p=>matchingLocations.has(String(p.locationId))).map(p=>p._id);
      pipeline.push({$match:{$or:[...['product.name','product.sku','batch.manufacturerLot'].map(k=>({[k]:regex})),{holdingPointId:{$in:points}}]}});
    }
    pipeline.push(...salesInventoryFilter(user),{$sort:{'product.name':1,_id:1}},{$facet:{items:[{$skip:(query.page-1)*query.limit},{$limit:query.limit}],total:[{$count:'value'}]}});
    const [result]=await m.InventoryBalance.aggregate(pipeline).session(session);
    const byId=rows=>new Map(rows.map(row=>[String(row._id),row]));
    const points=byId(ctx.points),locations=byId(ctx.locations),warehouses=byId(ctx.warehouses);
    const dispatchWarehouses=new Map(ctx.dispatches.flatMap(d=>d.items.map(item=>[String(item._id),d.header.sourceWarehouseId])));
    const rows=result.items.map(row=>{
      const point=points.get(String(row.holdingPointId)),location=locations.get(String(point?.locationId));
      return {...row,point,location,warehouse:warehouses.get(String(location?.warehouseId??dispatchWarehouses.get(String(point?.dispatchLineId))))};
    });
    const items=await inventoryRows(user,rows,query.view,session);
    return {items,total:result.total[0]?.value??0,page:query.page,limit:query.limit,
      ...(query.view!=='summary'&&{warehouses:ctx.warehouses.map(dto)}),capturedAt:new Date().toISOString()};
  });
}

export async function inventoryDetail(user,id) {
  requirePermission(user,'inventory:read');
  return transaction(async session=>{
    const lookup=(Model,localField,foreignField,fields,as)=>({$lookup:{from:Model.collection.name,localField,foreignField,pipeline:[{$project:fields}],as}});
    const [row]=await m.InventoryBalance.aggregate([
      {$match:{_id:databaseId(id)}},{$project:inventoryFields},...inventoryJoins(),...salesInventoryFilter(user),
      lookup(m.StockHoldingPoint,'holdingPointId','_id',{_id:1,type:1,locationId:1,dispatchLineId:1},'point'),{$unwind:'$point'},
      lookup(m.WarehouseLocation,'point.locationId','_id',{_id:1,warehouseId:1,code:1,isActive:1,isPickable:1},'locations'),
      lookup(m.TransferDispatch,'point.dispatchLineId','items._id',{_id:1,'header.sourceWarehouseId':1},'dispatches'),
      {$set:{location:{$arrayElemAt:['$locations',0]},warehouseId:{$ifNull:[{$arrayElemAt:['$locations.warehouseId',0]},{$arrayElemAt:['$dispatches.header.sourceWarehouseId',0]}]}}},
      lookup(m.Warehouse,'warehouseId','_id',{_id:1,name:1,isActive:1},'warehouse'),{$unwind:'$warehouse'},
      {$project:{locations:0,dispatches:0,warehouseId:0}},
    ]).session(session);
    if(!row||(!isOwner(user)&&!(user.warehouseIds??[]).some(wh=>same(wh,row.warehouse._id))))throw notFoundError();
    return (await inventoryRows(user,[row],'full',session))[0];
  });
}

export async function movements(user,query,id) {
  requirePermission(user,'stock_movement:read');
  const ctx=await scopeContext(user,query);
  const filter={holdingPointId:{$in:ctx.points.map(p=>p._id)},...(query.balanceId&&{_id:query.balanceId}),...(query.batchId&&{batchId:query.batchId})};
  if(query.productId){const batches=await m.ProductBatch.find({productId:query.productId}).select('_id').lean();filter.batchId={$in:batches.map(b=>b._id)};}
  const balances=await m.InventoryBalance.find(filter).select('_id').lean(),balanceIds=balances.map(b=>b._id);
  const match={...((query.from||query.to)&&{occurredAt:{...(query.from&&{$gte:new Date(query.from)}),...(query.to&&{$lte:new Date(query.to)})}}),...(query.operation&&{operation:query.operation})};
  const pipeline=[{$match:match},{$unwind:'$movements'},{$match:{$or:[{'movements.fromBalanceId':{$in:balanceIds}},{'movements.toBalanceId':{$in:balanceIds}}]}}];
  if(query.q){const regex=new RegExp(escape(query.q),'i');const products=await m.Product.find({$or:[{name:regex},{sku:regex}]}).select('_id').lean();const batches=await m.ProductBatch.find({$or:[{manufacturerLot:regex},{productId:{$in:products.map(p=>p._id)}}]}).select('_id').lean();const locationIds=ctx.locations.filter(l=>regex.test(l.code)||regex.test(l.name??'')).map(l=>l._id);const points=ctx.points.filter(p=>locationIds.some(l=>same(l,p.locationId))).map(p=>p._id);const matching=await m.InventoryBalance.find({_id:{$in:balanceIds},$or:[{batchId:{$in:batches.map(b=>b._id)}},{holdingPointId:{$in:points}}]}).select('_id').lean();const ids=matching.map(b=>b._id);pipeline.push({$match:{$or:[{operation:regex},{'movements.fromBalanceId':{$in:ids}},{'movements.toBalanceId':{$in:ids}}]}});}
  if(id)pipeline.push({$match:{'movements._id':databaseId(id)}});
  pipeline.push({$sort:{occurredAt:-1,'movements._id':-1}},{$facet:{items:[{$skip:id?0:(query.page-1)*query.limit},{$limit:id?1:query.limit}],total:[{$count:'value'}]}});
  const [result]=await m.StockTransaction.aggregate(pipeline);const items=[];const blind=await blindCountScope(user);
  const endpoint=async balanceId=>{
    if(!balanceId||!balanceIds.some(b=>same(b,balanceId)))return null;
    const b=await m.InventoryBalance.findById(balanceId).lean(),point=ctx.points.find(p=>same(p._id,b?.holdingPointId)),location=ctx.locations.find(l=>same(l._id,point?.locationId));
    const batch=b&&await m.ProductBatch.findById(b.batchId).lean(),product=batch&&await m.Product.findById(batch.productId).lean();
    return {balanceId:String(balanceId),warehouse:ctx.warehouses.find(w=>same(w._id,location?.warehouseId))?.name??null,location:location?.code??'Đang chuyển',product:product?.name??null,sku:product?.sku??null,batch:batch?.manufacturerLot??null,quality:b?.qualityStatus,ownerType:b?.ownerType,unit:product?.baseUnit};
  };
  for(const t of result.items){const move=t.movements,from=await endpoint(move.fromBalanceId),to=await endpoint(move.toBalanceId);
    const performer=await m.User.findById(t.performedBy).select('fullName username').lean();
    let source=null;const Model=m.models.get(t.sourceType);
    const permissions={transfer_orders:'stock_relocation:read',transfer_dispatches:'stock_transfer:read',transfer_receipts:'stock_transfer:read',warehouse_transfer_requests:'stock_transfer:read',goods_receipts:'goods_receipt:read',sales_goods_issues:'goods_issue:read'};
    if(Model&&permissions[t.sourceType]){const doc=await Model.findById(t.sourceId).select('documentNo header note documentKind').lean();const permission=t.sourceType==='transfer_orders'&&doc?.header?.taskKind!=='RELOCATE'?'stock_transfer:read':t.sourceType==='goods_receipts'&&doc?.documentKind==='TRANSFER'?'stock_transfer:read':permissions[t.sourceType];if(doc&&hasPermission(user,permission))source={documentNo:doc.documentNo,type:t.sourceType,reason:doc.header?.reason??doc.note??null};}
    const hideFrom=blind.has(move.fromBalanceId),hideTo=blind.has(move.toBalanceId),hidden=Boolean(hideFrom||hideTo);
    items.push({id:String(move._id),transactionId:String(t._id),operation:t.operation,occurredAt:t.occurredAt,recordedAt:t.recordedAt,performedBy:performer?.fullName??performer?.username??null,source,quantityBase:hidden?null:String(move.quantityBase),blindCount:hidden,from:from?{...from,before:hidden?null:String(move.fromBefore),after:hidden?null:String(move.fromAfter)}:null,to:to?{...to,before:hidden?null:String(move.toBefore),after:hidden?null:String(move.toAfter)}:null});
  }
  const rows=items;
  if(id){if(!rows[0])throw notFoundError();return serialize(rows[0]);}
  return {items:serialize(rows),total:result.total[0]?.value??0,page:query.page,limit:query.limit,warehouses:ctx.warehouses.map(dto)};
}

export async function overview(user){requirePermission(user,'inventory:read');const ctx=await scopeContext(user);const [balanceCount,openRelocations,pendingTransfers]=await Promise.all([m.InventoryBalance.countDocuments({holdingPointId:{$in:ctx.points.map(p=>p._id)},quantityBase:{$gt:0}}),m.TransferOrder.countDocuments({'header.warehouseId':{$in:ctx.warehouses.map(w=>w._id)},'header.taskKind':'RELOCATE',workflowStatus:{$in:['OPEN','PARTIAL']}}),m.WarehouseTransferRequest.countDocuments({workflowStatus:{$nin:['COMPLETED','REJECTED','CANCELLED']},$or:[{'header.sourceWarehouseId':{$in:ctx.warehouses.map(w=>w._id)}},{'header.destinationWarehouseId':{$in:ctx.warehouses.map(w=>w._id)}}]})]);return {warehouseCount:ctx.warehouses.length,locationCount:ctx.locations.length,balanceCount,openRelocations,pendingTransfers};}
