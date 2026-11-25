import { databaseId } from '../../models/document-identity.js';
import { effectiveQuantities } from '../sales-orders/sales-read.service.js';
import { exact } from '../../models/model-utils.js';
import { freeQuantities, stockQuantities } from '../../shared/utils/stock-availability-read.js';
import {
  stocktakeLockedLocations,
  sourceContext,
  locationAt,
  guardLocations,
  freeQuantity,
  beginStock,
  balanceAt,
  moveStock,
  verifyCapacity,
  remainingReservation,
} from '../../shared/utils/stock.js';
import mongoose from 'mongoose';
import { movementList } from '../../shared/utils/movement-list.js';
import {
  optionFields,
  movementDetailFields,
  requirementFields,
  executionFields,
  differenceFields,
  approvalFields,
} from '../../shared/utils/movement-read-fields.js';
import {
  WarehouseTransferRequest,
  TransferDispatch,
  TransferReceipt,
  InternalTransferRequirement,
  TransferOrder,
  ApprovalHistory,
  SalesOrder,
  WarehouseIssueRequest,
  SupplyAllocation,
  Warehouse,
  WarehouseLocation,
  StockHoldingPoint,
  InventoryBalance,
  ProductBatch,
  Product,
  Uom,
  Conversion,
  StockDiscrepancy,
  User,
  StockReservation,
  DefectReport,
} from '../../models/runtime.js';
import { requirePermission, requireWarehouseAccess, isOwner, hasPermission, canAccessWarehouse } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { dto } from '../../shared/utils/persistence.js';
import { notFoundError, validationError, forbiddenError } from '../../shared/utils/ApiError.js';
import { transferStockCheck } from './transfer-stock-check.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { completeTransferIfReady, completionBlocker, putawayBlocker } from './transfer-completion.js';
import { command, checkVersion, saveVersion, newId, same, hash } from '../../shared/utils/document-command.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';

export { proposeDifference, reviewDifference } from './transfer-differences.js';

async function transferWarehouseDisplay(documents) {
  if(!documents.length)return [];
  const warehouses=await Warehouse.find({_id:{$in:documents.flatMap(d=>[d.header.sourceWarehouseId,d.header.destinationWarehouseId])}}).select('_id code name').lean();
  const byId=new Map(warehouses.map(w=>[String(w._id),w]));
  const ref=id=>{const w=byId.get(String(id));return w?{id:String(w._id),code:w.code,name:w.name}:null;};
  return documents.map(d=>({...d,sourceWarehouse:ref(d.header.sourceWarehouseId),destinationWarehouse:ref(d.header.destinationWarehouseId)}));
}
async function scope(user) {
  const role=currentRole(user)?.code;
  if(isOwner(user)||role==='ACCOUNTANT')return {};
  if(role==='SALES'){
    const orders=await SalesOrder.find({createdBy:user._id}).distinct('_id');
    const requests=await WarehouseIssueRequest.find({'header.salesOrderId':{$in:orders}}).distinct('_id');
    const ids=await SupplyAllocation.find({'demandRef.documentId':{$in:[...orders,...requests]},'sourceRef.documentType':'warehouse_transfer_requests'}).distinct('sourceRef.documentId');
    return {_id:{$in:ids}};
  }
  return {$or:[{'header.sourceWarehouseId':{$in:user.warehouseIds||[]}},{'header.destinationWarehouseId':{$in:user.warehouseIds||[]}}]};
}
export async function listTransfers(user,query){
  requirePermission(user,'stock_transfer:read');
  const castQuery = { ...query };
  for (const field of ['sourceWarehouseId', 'destinationWarehouseId']) if (query[field]) castQuery[field] = databaseId(query[field]);
  const result = await movementList(WarehouseTransferRequest, await scope(user), castQuery, ['header.sourceWarehouseId', 'header.destinationWarehouseId'], 'COMPLETED');
  return { ...result, items: await transferWarehouseDisplay(result.items) };
}
const dispatchWarehouseFields = ['header.sourceWarehouseId', 'header.destinationWarehouseId'];

export async function transferDispatchScope(user) {
  const requestScope = await scope(user);
  const requestIds = await WarehouseTransferRequest.find(requestScope).distinct('_id');
  return { 'header.requestId': { $in: requestIds } };
}

export async function listDispatches(user, query) {
  requirePermission(user, 'stock_transfer:read');
  const receivable = query.receivable === 'true';
  const sales = currentRole(user)?.code === 'SALES';
  if (receivable) requirePermission(user, 'stock_transfer:receive');
  const filter = await transferDispatchScope(user);
  if (receivable) {
    const requestIds = await WarehouseTransferRequest.find({
      _id: filter['header.requestId'],
      workflowStatus: 'APPROVED',
      ...(!isOwner(user) && { 'header.destinationWarehouseId': { $in: user.warehouseIds ?? [] } }),
    }).distinct('_id');
    const dispatchFilter = { 'header.requestId': { $in: requestIds }, workflowStatus: 'POSTED', 'header.dispatchedBy': { $ne: user._id } };
    const lineIds = await TransferDispatch.find(dispatchFilter).distinct('items._id');
    const points = await StockHoldingPoint.find({ dispatchLineId: { $in: lineIds }, type: 'IN_TRANSIT' }).select('dispatchLineId').lean();
    const balances = await InventoryBalance.find({ holdingPointId: { $in: points.map(point => point._id) },
      ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: { $gt: 0 } }).distinct('holdingPointId');
    const remainingPoints = new Set(balances.map(String));
    const remainingLines = points.filter(point => remainingPoints.has(String(point._id))).map(point => point.dispatchLineId);
    Object.assign(filter, dispatchFilter, { 'items._id': { $in: remainingLines } });
  }
  const castQuery = { ...query };
  for (const key of ['sourceWarehouseId', 'destinationWarehouseId']) if (query[key]) castQuery[key] = databaseId(query[key]);
  const result = await movementList(TransferDispatch, filter, castQuery, dispatchWarehouseFields, 'POSTED');
  return { ...result, items: sales ? result.items.map(row => ({
    _id: row._id, documentNo: row.documentNo, workflowStatus: row.workflowStatus,
  })) : await transferWarehouseDisplay(result.items) };
}

export async function getDispatch(user, id) {
  requirePermission(user, 'stock_transfer:read');
  if(currentRole(user)?.code === 'SALES')throw notFoundError();
  const dispatch = await TransferDispatch.findOne({_id:id}).select(movementDetailFields).lean();
  if(!dispatch)throw notFoundError();
  const request=await WarehouseTransferRequest.findOne({$and:[await scope(user),{_id:dispatch.header.requestId}]}).select('header.sourceWarehouseId header.destinationWarehouseId workflowStatus').lean();
  if(!request)throw notFoundError();
  const [transfer]=await transferWarehouseDisplay([dto(request)]);
  const canReceive = hasPermission(user, 'stock_transfer:receive') && dispatch.workflowStatus === 'POSTED'
    && transfer.workflowStatus === 'APPROVED' && String(dispatch.header.dispatchedBy) !== String(user._id)
    && (isOwner(user) || (user.warehouseIds ?? []).some(id => String(id) === String(transfer.header.destinationWarehouseId)));
  const value = dto(dispatch);
  let receivableLines=[];
  if(canReceive){
    const points=await StockHoldingPoint.find({dispatchLineId:{$in:dispatch.items.map(item=>item._id)}}).select('_id dispatchLineId').lean();
    const balances=points.length?await InventoryBalance.find({holdingPointId:{$in:points.map(point=>point._id)}}).select('holdingPointId quantityBase').lean():[];
    receivableLines=transitProgress([dispatch],points,balances)[0].lines;
  }
  return { ...value, header: { ...value.header, destinationWarehouseId: transfer.header.destinationWarehouseId },
    sourceWarehouse: transfer.sourceWarehouse, destinationWarehouse: transfer.destinationWarehouse,
    receivableLines };
}

function transitProgress(dispatches,points,balances){
  const pointsByLine=new Map(points.map(point=>[String(point.dispatchLineId),String(point._id)])),quantityByPoint=new Map();
  for(const balance of balances){const key=String(balance.holdingPointId);quantityByPoint.set(key,(quantityByPoint.get(key)??exact('0')).plus(String(balance.quantityBase)));}
  return dispatches.map(dispatch=>({dispatchId:String(dispatch._id),lines:dispatch.items.map(item=>{
    const remaining=quantityByPoint.get(pointsByLine.get(String(item._id)))??exact('0');
    return {lineId:String(item._id),piecesPerCarton:item.packagingSnapshot?.baseUnitsPerPackage,dispatchedQtyBase:String(item.qtyBase),remainingQtyBase:remaining.toFixed(),receivedQtyBase:dispatch.workflowStatus==='POSTED'?exact(item.qtyBase).minus(remaining).toFixed():'0'};
  })}));
}

export async function getTransfer(user,id){
  requirePermission(user,'stock_transfer:read');
  const sales = currentRole(user)?.code === 'SALES';
  const request=await WarehouseTransferRequest.findOne({$and:[await scope(user),{_id:id}]}).select(movementDetailFields + (sales ? '' : ' items.sourceLocations')).lean();if(!request)throw notFoundError();
  const [[display],dispatches]=await Promise.all([transferWarehouseDisplay([dto(request)]),TransferDispatch.find({'header.requestId':id}).select(movementDetailFields).lean()]);
  const receipts=await TransferReceipt.find({'header.dispatchId':{$in:dispatches.map(row=>row._id)}}).select(movementDetailFields).lean();
  if(sales)return {...display,dispatches:dispatches.map(row=>({id:String(row._id),workflowStatus:row.workflowStatus})),receipts:receipts.map(row=>({id:String(row._id),workflowStatus:row.workflowStatus}))};
  const [requirements,approvals,differences,points,effective]=await Promise.all([
    InternalTransferRequirement.find({'header.sourceDocumentId':{$in:[...dispatches,...receipts].map(row=>row._id)}}).select(requirementFields).lean(),
    ApprovalHistory.find({subjectType:'warehouse_transfer_requests',subjectId:id}).select(approvalFields).lean(),
    StockDiscrepancy.find({'header.sourceRef.documentId':{$in:dispatches.map(d=>d._id)}}).select(differenceFields).lean(),
    StockHoldingPoint.find({dispatchLineId:{$in:dispatches.flatMap(d=>d.items.map(i=>i._id))}}).select('_id dispatchLineId').lean(),
    effectiveQuantities(receipts.filter(r=>r.workflowStatus==='POSTED')),
  ]);
  const [tasks,transitBalances]=await Promise.all([
    TransferOrder.find({'header.requirementId':{$in:requirements.map(row=>row._id)}}).select(executionFields).lean(),
    InventoryBalance.find({holdingPointId:{$in:points.map(p=>p._id)}}).select('holdingPointId quantityBase').lean(),
  ]);
  const progress=transitProgress(dispatches,points,transitBalances);
  const lineProgress=request.items.map(item=>{const sent=dispatches.filter(d=>d.workflowStatus==='POSTED').flatMap(d=>d.items).filter(i=>String(i.details.requestLineId)===String(item._id));const sentIds=sent.map(i=>String(i._id));const received=receipts.filter(r=>r.workflowStatus==='POSTED').flatMap(r=>r.items).filter(i=>sentIds.includes(String(i.details.dispatchLineId)));const sum=rows=>rows.reduce((n,i)=>n.plus(effective.get(String(i._id))??String(i.qtyBase)),exact('0')).toFixed();return {lineId:String(item._id),dispatchedQtyBase:sent.reduce((n,i)=>n.plus(String(i.qtyBase)),exact('0')).toFixed(),receivedGoodQtyBase:sum(received.filter(i=>i.details.qualityCode==='GOOD')),receivedDamagedQtyBase:sum(received.filter(i=>i.details.qualityCode==='DAMAGED')),transitQtyBase:progress.flatMap(p=>p.lines).filter(l=>sentIds.includes(l.lineId)).reduce((n,l)=>n.plus(l.remainingQtyBase),exact('0')).toFixed(),unresolvedQtyBase:differences.filter(d=>d.workflowStatus==='OPEN').flatMap(d=>d.items).filter(i=>sentIds.includes(String(i.details.sourceLineId))).reduce((n,i)=>n.plus(String(i.qtyBase)),exact('0')).toFixed(),writtenOffQtyBase:differences.filter(d=>d.workflowStatus==='RESOLVED'&&d.header?.resolutionMode==='WRITE_OFF').flatMap(d=>d.items).filter(i=>sentIds.includes(String(i.details.sourceLineId))).reduce((n,i)=>n.plus(String(i.qtyBase)),exact('0')).toFixed()};});
  const stockCheck=['PENDING_APPROVAL','APPROVED','REVISION_REQUIRED'].includes(request.workflowStatus)?await transferStockCheck(request):undefined;
  return {...display,stockCheck,lineProgress,differences:differences.map(dto),progress,dispatches:dispatches.map(dto),receipts:receipts.map(dto),internalRequirements:requirements.map(dto),tasks:tasks.map(dto),approvals:approvals.map(dto)};
}

export async function getPutawayTask(user,id) {
  requirePermission(user,'stock_transfer:read');requirePermission(user,'stock_transfer:receive');
  const task=await TransferOrder.findById(id).select('_id documentNo workflowStatus version header.warehouseId header.taskKind header.requirementId items.details.toLocationId items.sources.documentId items.sources.itemId').lean();
  if(!task||task.header.taskKind!=='PUTAWAY'||!task.header.requirementId)throw notFoundError();
  requireWarehouseAccess(user,task.header.warehouseId);
  const requirement=await InternalTransferRequirement.findById(task.header.requirementId).select('_id header.sourceDocumentId header.taskKind header.warehouseId').lean();
  const receipt=requirement&&await TransferReceipt.findById(requirement.header.sourceDocumentId).select('_id documentNo header.dispatchId header.warehouseId items._id items.productNameSnapshot items.lotId items.lotLabelSnapshot items.qtyBase items.baseUnitSnapshot items.details.qualityCode items.details.receivingLocationId').lean();
  const dispatch=receipt&&await TransferDispatch.findById(receipt.header.dispatchId).select('header.requestId').lean();
  const request=dispatch&&await WarehouseTransferRequest.findById(dispatch.header.requestId).select('workflowStatus header.destinationWarehouseId').lean();
  if(!receipt||!request||String(request.header.destinationWarehouseId)!==String(task.header.warehouseId)||String(receipt.header.warehouseId)!==String(task.header.warehouseId)||String(requirement.header.warehouseId)!==String(task.header.warehouseId))throw notFoundError();
  const locationIds=[...task.items.map(item=>item.details?.toLocationId),...receipt.items.map(item=>item.details?.receivingLocationId)].filter(Boolean);
  const missingLots=receipt.items.filter(item=>!item.lotLabelSnapshot&&item.lotId).map(item=>item.lotId);
  const [locations,warehouse,batches]=await Promise.all([
    locationIds.length?WarehouseLocation.find({_id:{$in:locationIds},warehouseId:task.header.warehouseId}).select('_id code name').lean():[],
    Warehouse.findById(task.header.warehouseId).select('code name').lean(),
    missingLots.length?ProductBatch.find({_id:{$in:missingLots}}).select('_id manufacturerLot').lean():[],
  ]);
  return {id:String(task._id),documentNo:task.documentNo,status:task.workflowStatus,version:task.version,warehouseId:String(task.header.warehouseId),warehouseLabel:warehouse?.name||warehouse?.code||null,requestId:String(request._id),requestStatus:request.workflowStatus,receiptId:String(receipt._id),receiptNo:receipt.documentNo,
    lines:receipt.items.filter(item=>item.details.qualityCode!=='DAMAGED').map(item=>{
      const planned=task.items.find(row=>row.sources?.some(link=>String(link.documentId)===String(receipt._id)&&String(link.itemId)===String(item._id)));
      const target=locations.find(row=>String(row._id)===String(planned?.details.toLocationId));
      const source=locations.find(row=>String(row._id)===String(item.details.receivingLocationId));
      const batch=batches.find(row=>String(row._id)===String(item.lotId));
      return {receiptLineId:String(item._id),productName:item.productNameSnapshot,lotLabel:item.lotLabelSnapshot||batch?.manufacturerLot||null,fromLocationLabel:source?.name||source?.code||null,qtyBase:String(item.qtyBase),baseUnit:item.baseUnitSnapshot,toLocationId:planned?.details.toLocationId?String(planned.details.toLocationId):null,toLocationLabel:target?.name||target?.code||null};
    })};
}

// This is a selection aid only. Every BF04 write command rechecks the active
// warehouse, lot, balance, quality and source quantities inside its transaction.
// Active warehouse staff of one warehouse who may pick and hand over transfer goods.
export async function pickAssignees(user,warehouseId){
  requirePermission(user,'stock_transfer:dispatch');
  requireWarehouseAccess(user,warehouseId);
  const users=await User.find({isActive:true,warehouseIds:warehouseId}).select('_id fullName roleId').populate({path:'roleId',populate:{path:'permissionIds'}}).lean(false);
  return users.filter(row=>hasPermission(row,'stock_transfer:dispatch')&&currentRole(row)?.code==='WAREHOUSE').map(row=>({id:String(row._id),fullName:row.fullName}));
}
export async function transferOptions(user, warehouseId, mode='stock') {
  requirePermission(user,'stock_transfer:read');
  const warehouses=await Warehouse.find({isActive:true}).select('_id code name isActive').lean();
  // Destination catalogue is store-wide; operational data stays warehouse-scoped.
  if(currentRole(user)?.code==='SALES')return {warehouses:warehouses.map(dto),sourceWarehouseIds:[],locations:[],holdingPoints:[],balances:[],batches:[],products:[]};
  const sourceWarehouseIds=warehouses.filter(row=>isOwner(user)||(user.warehouseIds||[]).some(id=>String(id)===String(row._id))).map(row=>String(row._id));
  if(!warehouseId)return {warehouses:warehouses.map(dto),sourceWarehouseIds,locations:[],holdingPoints:[],balances:[],batches:[],products:[]};
  // Staff who may raise requests can look at any warehouse's stock so a destination can ask for goods it does not hold.
  if(!hasPermission(user,'stock_transfer:create'))requireWarehouseAccess(user,warehouseId);
  const locations=await WarehouseLocation.find({warehouseId,isActive:true}).select(optionFields.location).lean();
  if(mode==='locations'){const frozen=await stocktakeLockedLocations(locations.map(row=>row._id));return {warehouses:warehouses.map(dto),sourceWarehouseIds,locations:locations.map(row=>({...dto(row),lockedByStocktake:frozen.has(String(row._id))})),holdingPoints:[],balances:[],batches:[],products:[],units:[],conversions:[]};}
  const holdingPoints=await StockHoldingPoint.find({locationId:{$in:locations.map(row=>row._id)}}).select(optionFields.point).lean();
  const balances=(await InventoryBalance.find({holdingPointId:{$in:holdingPoints.map(row=>row._id)},quantityBase:{$gt:0}}).select(optionFields.balance).lean());
  const [batches,products,units,available]=await Promise.all([
    ProductBatch.find({_id:{$in:balances.map(row=>row.batchId)},identificationStatus:'VERIFIED'}).select(optionFields.batch).lean(),
    Product.find({isActive:true}).select(optionFields.product + ' wholeBaseUnits').lean(),Uom.find({isActive:true}).select('code name isCarton areaMm2').lean(),freeQuantities(balances),
  ]);
  const conversions=await Conversion.find({productId:{$in:products.map(row=>row._id)},validFrom:{$lte:new Date()}}).select(optionFields.conversion).sort({validFrom:-1}).lean();
  const seenConversions=new Set();
  const currentConversions=conversions.filter(row=>{const key=JSON.stringify([String(row.productId),String(row.productBatchId||''),String(row.uomId)]);if(seenConversions.has(key))return false;seenConversions.add(key);return true;});
  const unitById=new Map(units.map(unit=>[String(unit._id),dto(unit)]));
  // Stocktake-locked locations (any role) stay listed but flagged, with nothing selectable.
  const frozen=await stocktakeLockedLocations(locations.map(row=>row._id)),frozenPoints=new Set(holdingPoints.filter(row=>frozen.has(String(row.locationId))).map(row=>String(row._id)));
  return {warehouses:warehouses.map(dto),sourceWarehouseIds,locations:locations.map(row=>({...dto(row),lockedByStocktake:frozen.has(String(row._id))})),holdingPoints:holdingPoints.map(dto),balances:balances.map(b=>{const lockedByStocktake=frozenPoints.has(String(b.holdingPointId));return {...dto(b),lockedByStocktake,availableQtyBase:lockedByStocktake?'0':available.get(String(b._id)).toFixed()};}),batches:batches.map(dto),products:products.map(dto),units:units.map(dto),conversions:currentConversions.map(row=>({...dto(row),basePerUnit:exact(row.basePerUnit).toFixed(),uom:unitById.get(String(row.uomId))||null}))};
}

// A request may be raised by staff of either warehouse: the source (push) or the destination (asking for goods).
function requireRequestWarehouse(actor,sourceWarehouseId,destinationWarehouseId){
  if(!canAccessWarehouse(actor,sourceWarehouseId)&&!canAccessWarehouse(actor,destinationWarehouseId))requireWarehouseAccess(actor,sourceWarehouseId);
}
function addLot(map,lineId,lotId){
  if(!lotId)return;
  const key=String(lineId);
  if(!map.has(key))map.set(key,new Set());
  map.get(key).add(String(lotId));
}
async function find(Model,id,session) { const row=await Model.findById(id).session(session); if(!row)throw notFoundError(); return row; }
async function requestReplay(id,user,session) {
  const request=await find(WarehouseTransferRequest,id,session);
  if(!canAccessWarehouse(user,request.header.sourceWarehouseId)&&!canAccessWarehouse(user,request.header.destinationWarehouseId))throw forbiddenError();
  return request;
}
async function dispatchReplay(id,user,session) {
  const dispatch=await find(TransferDispatch,id,session),request=await find(WarehouseTransferRequest,dispatch.header.requestId,session);
  requireWarehouseAccess(user,request.header.sourceWarehouseId);return dispatch;
}
async function receiptReplay(id,user,session) {
  const receipt=await find(TransferReceipt,id,session);
  requireWarehouseAccess(user,receipt.header.warehouseId);return receipt;
}
async function taskReplay(id,user,session) {
  const task=await find(TransferOrder,id,session);
  requireWarehouseAccess(user,task.header.warehouseId);
  requirePermission(user,task.header.taskKind==='PICK'?'stock_transfer:dispatch':'stock_transfer:receive');
  return task;
}
const document=async(Model,prefix,user,header,session,items=[],status='OPEN')=>new Model({...await nextDocumentFields(Model,prefix,header.warehouseId||header.sourceWarehouseId,session),workflowStatus:status,version:1,createdBy:user._id,header,items});
async function automaticPutaway(receipt,actor,session) {
  if(!receipt.items.some(item=>item.details.qualityCode!=='DAMAGED'))return null;
  const existing=await InternalTransferRequirement.findOne({'header.sourceDocumentId':receipt._id}).session(session);
  if(existing)return {requirement:existing,task:await TransferOrder.findOne({'header.requirementId':existing._id}).session(session)};
  const requirement=await document(InternalTransferRequirement,'ITR',actor,{warehouseId:receipt.header.warehouseId,sourceDocumentId:receipt._id,sourceType:receipt.constructor.collection.name,taskKind:'PUTAWAY'},session);
  const task=await document(TransferOrder,'TO',actor,{warehouseId:receipt.header.warehouseId,taskKind:'PUTAWAY',assignedTo:actor._id,requirementId:requirement._id},session);
  // No physical target is invented: task lines are planned when the receiver selects destinations.
  requirement.sources=[sourceLink(receipt)];task.sources=[sourceLink(requirement)];
  await requirement.save({session});await task.save({session});return {requirement,task};
}
async function planPutaway(task,requirement,receipt,destinations,session) {
  const rows=receipt.items.filter(item=>item.details.qualityCode!=='DAMAGED');
  if(destinations.length!==rows.length||new Set(destinations.map(row=>String(row.receiptLineId))).size!==rows.length||destinations.some(row=>!rows.some(item=>same(item._id,row.receiptLineId))))throw validationError('Chọn vị trí đích cho tất cả dòng hàng tốt');
  if(task.items.length){
    for(const item of task.items){
      const source=item.sources.find(link=>same(link.documentId,receipt._id));
      const selected=destinations.find(row=>same(row.receiptLineId,source?.itemId));
      if(!selected)throw validationError('Dòng cất hàng không khớp phiếu nhận');
      await locationAt(selected.locationId,task.header.warehouseId,['STORAGE'],session);
      item.details.toLocationId=selected.locationId;
    }
    return;
  }
  for(const [i,row]of rows.entries()){
    const ctx=await sourceContext(row.details.destinationBalanceId,session);
    if(ctx.balance.qualityStatus!=='GOOD'||ctx.balance.ownerType!=='STORE'||!same(ctx.batch._id,row.lotId)||!same(ctx.product._id,row.productId)||ctx.location?.locationType!=='RECEIVING')throw validationError('Tồn cất hàng không khớp phiếu nhận hàng tốt');
    const selected=destinations.find(value=>same(value.receiptLineId,row._id));
    const target=await locationAt(selected.locationId,task.header.warehouseId,['STORAGE'],session);
    if(!ctx.location||!same(ctx.location.warehouseId,task.header.warehouseId)||same(ctx.location._id,target._id))throw validationError('Vị trí nguồn hoặc đích không hợp lệ');
    const fields={lineNo:i+1,lineKind:'WAREHOUSE_TASK',sources:[sourceLink(receipt,row,row.qtyBase)],details:{sourceBalanceId:ctx.balance._id,sourceBalanceVersion:ctx.balance.version,fromLocationId:ctx.location._id,toLocationId:target._id,qualityCode:ctx.balance.qualityStatus}};
    requirement.items.push(copyItem(row,row.qtyBase,fields));task.items.push(copyItem(row,row.qtyBase,fields));
  }
}
function isTransferSource(ctx, item, warehouseId) {
  return ctx.product.isActive && ctx.batch.identificationStatus === 'VERIFIED' &&
    same(ctx.product._id, item.productId) && (!item.lotId || same(ctx.batch._id, item.lotId)) &&
    ctx.balance.ownerType === 'STORE' && ctx.balance.qualityStatus === 'GOOD' &&
    ctx.location?.isActive && ctx.location.locationType === 'STORAGE' && same(ctx.location.warehouseId, warehouseId);
}

async function makeRequestItem(line, lineNo, warehouseId, session, previous) {
  const item = await makeItem(line, lineNo, session, { previous, includeLotLabel: !!line.lotId });
  const allocations = line.sourceLocations ?? previous?.sourceLocations;
  if (!allocations?.length) return item;
  if (!item.lotId) throw validationError('Chọn lô trước khi phân bổ vị trí nguồn');
  const total = allocations.reduce((sum, row) => sum.plus(String(row.qtyBase)), exact('0'));
  if (total.gt(item.qtyBase)) throw validationError('Tổng số lượng các ô vượt số lượng yêu cầu theo đơn vị gốc');

  const contexts = [];
  const locations = new Set();
  for (const row of allocations) {
    const ctx = await sourceContext(row.sourceBalanceId, session);
    if (!isTransferSource(ctx, item, warehouseId)) throw validationError('Vị trí nguồn không có tồn hợp lệ của sản phẩm và lô đã chọn');
    const locationId = String(ctx.location._id);
    if (locations.has(locationId)) throw validationError(`Vị trí ${ctx.location.code} đã được chọn`);
    locations.add(locationId);
    if (ctx.product.wholeBaseUnits && !exact(row.qtyBase).isInteger()) {
      throw validationError(`Vị trí ${ctx.location.code} yêu cầu số lượng nguyên theo đơn vị gốc`);
    }
    contexts.push({ ctx, qtyBase: String(row.qtyBase) });
  }
  const locked = await stocktakeLockedLocations([...locations], session);
  const quantities = await stockQuantities(contexts.map(({ ctx }) => ctx.balance), session);
  item.sourceLocations = contexts.map(({ ctx, qtyBase }) => {
    if (locked.has(String(ctx.location._id))) throw validationError(`Vị trí ${ctx.location.code} đang khóa kiểm kê`);
    const free = quantities.get(String(ctx.balance._id)).free;
    if (free.lt(qtyBase)) throw validationError(`Vị trí ${ctx.location.code} chỉ còn ${free.gt(0) ? free.toFixed() : '0'} ${item.baseUnitSnapshot} khả dụng`);
    return { sourceBalanceId: ctx.balance._id, locationId: ctx.location._id, locationCode: ctx.location.code, qtyBase };
  });
  return item;
}

export function createRequest(user,input) {
  return command(user,'CREATE_TRANSFER_REQUEST','stock_transfer:create',null,input,requestReplay,async(session,actor)=>{
    requireRequestWarehouse(actor,input.sourceWarehouseId,input.destinationWarehouseId);
    if(same(input.sourceWarehouseId,input.destinationWarehouseId)||await Warehouse.countDocuments({_id:{$in:[input.sourceWarehouseId,input.destinationWarehouseId]},isActive:true}).session(session)!==2)throw validationError('Chọn hai kho hoạt động khác nhau');
    const items=[];for(const [i,row]of input.lines.entries())items.push(await makeRequestItem(row,i+1,input.sourceWarehouseId,session));
    const request=await document(WarehouseTransferRequest,'TR',actor,{sourceWarehouseId:input.sourceWarehouseId,destinationWarehouseId:input.destinationWarehouseId,neededOn:input.neededOn,reason:input.reason,requestedBy:actor._id,requestedAt:new Date()},session,items,'PENDING_APPROVAL');
    await request.save({session});return{document:request};
  });
}
export function reviewRequest(user,id,input) {
  return command(user,'REVIEW_TRANSFER_REQUEST','stock_transfer:approve',id,input,requestReplay,async(session,actor)=>{
    const request=await requestReplay(id,actor,session);checkVersion(request,input.expectedVersion);
    if(request.workflowStatus!=='PENDING_APPROVAL'||same(request.createdBy,actor._id))throw validationError('Không thể duyệt yêu cầu hoặc tự duyệt');
    // Per-line approval: lines not listed keep the requested quantity; 0 drops the line from the transfer.
    const approvedByLine=new Map(request.items.map(item=>[String(item._id),exact(String(item.qtyBase))]));
    if(input.decision==='APPROVE'&&input.lines){
      for(const row of input.lines){
        const item=request.items.id(row.lineId);if(!item)throw validationError('Dòng duyệt không thuộc yêu cầu');
        const approved=exact(row.approvedQtyBase);
        if(approved.gt(String(item.qtyBase)))throw validationError(`${item.productNameSnapshot||'Dòng hàng'}: lượng duyệt vượt lượng yêu cầu`);
        approvedByLine.set(String(item._id),approved);
      }
    }
    if(input.decision==='APPROVE'){
      if(![...approvedByLine.values()].some(value=>value.gt(0)))throw validationError('Cần duyệt ít nhất một dòng có số lượng lớn hơn 0; nếu không hãy từ chối yêu cầu');
      // Stock is not reserved until dispatch, so confirm now that the approved quantity is still free at the source.
      const checks=new Map((await transferStockCheck(request,session)).map(row=>[row.lineId,row]));
      for(const item of request.items){
        const approved=approvedByLine.get(String(item._id)),free=exact(checks.get(String(item._id)).sourceFreeQtyBase);
        if(approved.gt(free))throw validationError(`${item.productNameSnapshot||'Dòng hàng'}${item.lotLabelSnapshot?` (lô ${item.lotLabelSnapshot})`:''}: chỉ còn ${free.toFixed()} ${item.baseUnitSnapshot} khả dụng tại kho nguồn, không đủ ${approved.toFixed()} để duyệt`);
      }
    }
    const reviewReason=input.reason??(input.lines?.length?'Duyệt, điều chỉnh số lượng một số dòng':'Duyệt');
    const approval=await new ApprovalHistory({decisionKey:hash({id,version:request.version,key:input.idempotencyKey}),
      subjectType:'warehouse_transfer_requests',subjectId:request._id,subjectRevision:request.version,decisionScope:'TRANSFER',
      reviewedContent:request.toObject(),decision:input.decision,reason:reviewReason,requestedBy:request.createdBy,decidedBy:actor._id,decidedAt:new Date(),recordedAt:new Date(),
      authoritySnapshot:{roleCode:currentRole(actor).code,permissionCode:'stock_transfer:approve',warehouseIds:actor.warehouseIds},
      itemDecisions:request.items.map(item=>{const approved=input.decision==='APPROVE'?approvedByLine.get(String(item._id)).toFixed():'0';return{itemId:item._id,approvedQtyBase:approved,outcome:input.decision==='APPROVE'&&exact(approved).eq(0)?'REJECT':input.decision};})}).save({session});
    for(const item of request.items){
      item.approvedQtyBase=input.decision==='APPROVE'?approvedByLine.get(String(item._id)).toFixed():'0';
      // A lowered approval must not leave planned bin quantities above what may be dispatched.
      let room=exact(item.approvedQtyBase);
      for(const entry of item.sourceLocations??[]){const keep=exact(String(entry.qtyBase)).gt(room)?room:exact(String(entry.qtyBase));entry.qtyBase=keep.toFixed();room=room.minus(keep);}
      if(item.sourceLocations?.length)item.sourceLocations=item.sourceLocations.filter(entry=>exact(String(entry.qtyBase)).gt(0));
    }
    request.workflowStatus=input.decision==='APPROVE'?'APPROVED':input.decision==='REVISE'?'REVISION_REQUIRED':'REJECTED';request.header.approvedRevision=request.version;
    request.header.approvedVersion=request.version+1;request.header.reviewedBy=actor._id;request.header.reviewedAt=new Date();
    request.header.approvalStatus=request.workflowStatus;if(input.decision==='REJECT')request.header.rejectionReason=input.reason;
    return{document:await saveVersion(request,input.expectedVersion,session),versionBefore:input.expectedVersion,decisionId:approval._id};
  });
}
export function createDispatch(user,id,input) {
  return command(user,'CREATE_TRANSFER_DISPATCH','stock_transfer:dispatch',id,input,dispatchReplay,async(session,actor)=>{
    const request=await find(WarehouseTransferRequest,id,session);requireWarehouseAccess(actor,request.header.sourceWarehouseId);checkVersion(request,input.expectedVersion);
    if(request.workflowStatus!=='APPROVED')throw validationError('Yêu cầu chưa được duyệt hoặc đã đóng');
    const existing=await TransferDispatch.find({'header.requestId':id,workflowStatus:{$ne:'CANCELLED'}}).session(session);
    const totals = new Map(), sourceTotals = new Map();
    const addTotal = (map, key, qtyBase) => {
      const total = (map.get(key) ?? exact('0')).plus(String(qtyBase));
      map.set(key, total);
      return total;
    };
    const sourceKey = (lineId, balanceId) => `${lineId}:${balanceId}`;
    for (const item of existing.flatMap(row => row.items)) {
      addTotal(totals, String(item.details.requestLineId), item.qtyBase);
      addTotal(sourceTotals, sourceKey(item.details.requestLineId, item.details.sourceBalanceId), item.qtyBase);
    }
    const outbound=await document(TransferDispatch,'TD',actor,{requestId:request._id,dispatchedBy:actor._id,dispatchedAt:new Date(),approvedRevision:request.header.approvedRevision,sourceWarehouseId:request.header.sourceWarehouseId,destinationWarehouseId:request.header.destinationWarehouseId},session,[],'DRAFT');
    for(const [i,row]of input.lines.entries()){
      const origin=request.items.id(row.requestLineId);if(!origin)throw validationError('Dòng không thuộc TR');
      const ctx=await sourceContext(row.sourceBalanceId,session);
      if (!isTransferSource(ctx, origin, request.header.sourceWarehouseId)) throw validationError('Tồn không đủ điều kiện xuất');
      const total = addTotal(totals, String(origin._id), row.qtyBase);
      const approved = exact(origin.approvedQtyBase);
      if (total.gt(approved)) throw validationError('Tổng các đợt vượt lượng duyệt');
      if (origin.sourceLocations?.length) {
        if (ctx.product.wholeBaseUnits && !exact(row.qtyBase).isInteger()) throw validationError(`Vị trí ${ctx.location.code} yêu cầu số lượng nguyên theo đơn vị gốc`);
        addTotal(sourceTotals, sourceKey(origin._id, ctx.balance._id), row.qtyBase);
        const unfilledPlan = origin.sourceLocations.reduce((sum, entry) => {
          const sent = sourceTotals.get(sourceKey(origin._id, entry.sourceBalanceId)) ?? exact('0');
          const remaining = exact(entry.qtyBase).minus(sent);
          return remaining.gt(0) ? sum.plus(remaining) : sum;
        }, exact('0'));
        // Unplanned picking must leave room for quantities still planned at other bins.
        if (total.plus(unfilledPlan).gt(approved)) {
          throw validationError(`Vị trí ${ctx.location.code} vượt số lượng có thể xuất theo phân bổ và phần còn lại của yêu cầu`);
        }
      }
      await locationAt(row.stagingLocationId,request.header.sourceWarehouseId,['STAGING'],session);
      await guardLocations([ctx.location._id,row.stagingLocationId],session);
      if(exact(row.qtyBase).gt(await freeQuantity(ctx.balance,session)))throw validationError('Không đủ tồn khả dụng để giữ cho phiếu xuất');
      const lock=await InventoryBalance.updateOne({_id:ctx.balance._id,version:ctx.balance.version},{$inc:{version:1}},{session});if(lock.matchedCount!==1)throw validationError('Tồn đã thay đổi');
      await new StockReservation({demandRef:{documentType:'warehouse_transfer_requests',documentId:request._id,itemId:origin._id},executionRef:{documentType:'transfer_dispatches',documentId:outbound._id},balanceId:ctx.balance._id,reservedQty:row.qtyBase,creationKey:hash({dispatch:String(outbound._id),line:i}),createdBy:actor._id}).save({session});
      outbound.items.push(copyItem(origin,row.qtyBase,{lineNo:i+1,lineKind:'TRANSFER_OUTBOUND',lotId:ctx.batch._id,
        ...(origin.sourceLocations?.length && { enteredUnit: origin.baseUnitSnapshot, baseUnitsPerUnit: '1', enteredQty: row.qtyBase }),
        sources:[sourceLink(request,origin,row.qtyBase)],details:{requestLineId:origin._id,sourceBalanceId:ctx.balance._id,stagingLocationId:row.stagingLocationId}}));
    }
    // A request line that has no fixed lot must not silently mix lots: tiles of different lots can differ in tone and size.
    const lotsByRequestLine=new Map();
    for(const item of existing.flatMap(row=>row.items))addLot(lotsByRequestLine,item.details.requestLineId,item.lotId);
    for(const item of outbound.items)addLot(lotsByRequestLine,item.details.requestLineId,item.lotId);
    const mixed=request.items.filter(origin=>!origin.lotId&&(lotsByRequestLine.get(String(origin._id))?.size??0)>1);
    if(mixed.length){
      if(!input.acceptMixedLots)throw validationError(`${mixed.map(origin=>origin.productNameSnapshot||'Dòng hàng').join(', ')} sẽ được xuất từ nhiều lô, có thể lệch tông màu hoặc kích thước. Chọn một lô duy nhất hoặc xác nhận chấp nhận trộn lô`);
      outbound.header.mixedLots=true;outbound.header.mixedLotAcceptedBy=actor._id;
    }
    outbound.sources=[sourceLink(request)];await outbound.save({session});
    // Contending dispatches must write the same request before consuming its allowance.
    await saveVersion(request,request.version,session);
    return{document:outbound};
  });
}
export function createRequirement(user,id,input) {
  return command(user,'CREATE_TRANSFER_REQUIREMENT','stock_transfer:read',id,input,taskReplay,async(session,actor)=>{
    let source=await TransferDispatch.findById(id).session(session),picking=Boolean(source);
    if(!source)source=await find(TransferReceipt,id,session);
    const outbound=picking?source:await find(TransferDispatch,source.header.dispatchId,session);
    const request=await find(WarehouseTransferRequest,outbound.header.requestId,session);
    requirePermission(actor,picking?'stock_transfer:dispatch':'stock_transfer:receive');
    const warehouseId=picking?request.header.sourceWarehouseId:request.header.destinationWarehouseId;requireWarehouseAccess(actor,warehouseId);
    if(!picking&&!input.destinations){
      const existing=await InternalTransferRequirement.findOne({'header.sourceDocumentId':source._id}).session(session);
      if(existing){const task=await TransferOrder.findOne({'header.requirementId':existing._id}).session(session);if(!task)throw validationError('Yêu cầu nội bộ thiếu TO');return {document:task,versionBefore:task.version};}
      checkVersion(source,input.expectedVersion);
      if(source.workflowStatus!=='POSTED'||request.workflowStatus!=='APPROVED')throw validationError('Nguồn chưa đủ điều kiện');
      await saveVersion(request,request.version,session);await saveVersion(source,source.version,session);
      const created=await automaticPutaway(source,actor,session);
      if(!created)throw validationError('Phiếu nhận toàn hàng lỗi không cần lệnh xếp hàng');
      return {document:created.task,resultRefs:[{documentType:'internal_transfer_requirements',documentId:created.requirement._id,revision:created.requirement.version}]};
    }
    checkVersion(source,input.expectedVersion);
    if(source.workflowStatus!==(picking?'DRAFT':'POSTED')||request.workflowStatus!=='APPROVED')throw validationError('Nguồn chưa đủ điều kiện');
    // Lock the source document before checking the one-to-one relationship. A
    // concurrent creator will retry against the new version and see the ITR.
    await saveVersion(source,source.version,session);
    if(await InternalTransferRequirement.exists({'header.sourceDocumentId':id}).session(session))throw validationError('Nguồn đã có yêu cầu nội bộ');
    const requirement=await document(InternalTransferRequirement,'ITR',actor,{warehouseId,sourceDocumentId:source._id,sourceType:source.constructor.collection.name,taskKind:picking?'PICK':'PUTAWAY'},session);
    let assignee=actor;
    if(input.assigneeId&&!picking)throw validationError('Chỉ chọn người thực hiện cho TO lấy hàng');
    if(picking&&input.assigneeId&&!same(input.assigneeId,actor._id)){
      assignee=await User.findById(input.assigneeId).populate({path:'roleId',populate:{path:'permissionIds'}}).session(session);
      if(!assignee||!assignee.isActive||!canAccessWarehouse(assignee,warehouseId)||!hasPermission(assignee,'stock_transfer:dispatch'))throw validationError('Người thực hiện không thuộc kho nguồn hoặc không có quyền xuất kho');
    }else if(picking&&!input.assigneeId&&currentRole(actor)?.code!=='WAREHOUSE'){
      // Created by someone who is not warehouse staff (e.g. the owner): default to the warehouse keeper when there is exactly one.
      const staff=(await User.find({isActive:true,warehouseIds:warehouseId}).populate({path:'roleId',populate:{path:'permissionIds'}}).session(session))
        .filter(row=>currentRole(row)?.code==='WAREHOUSE'&&hasPermission(row,'stock_transfer:dispatch'));
      if(staff.length===1)assignee=staff[0];
    }
    const task=await document(TransferOrder,'TO',actor,{warehouseId,taskKind:picking?'PICK':'PUTAWAY',assignedTo:assignee._id,requirementId:requirement._id},session);
    const rows=source.items.filter(item=>picking||item.details.qualityCode!=='DAMAGED');
    const destinations=input.destinations??[];
    if(!picking&&(destinations.length!==rows.length||new Set(destinations.map(row=>row.receiptLineId)).size!==rows.length))throw validationError('Chọn đích cho tất cả dòng hàng tốt');
    if(!rows.length)throw validationError('Phiếu nhận toàn hàng lỗi không cần lệnh xếp hàng');
    const ownedReservations=picking?await StockReservation.find({'executionRef.documentType':'transfer_dispatches','executionRef.documentId':source._id}).session(session):[];
    const totals=new Map();
    for(const [i,row]of rows.entries()){
      const ctx=await sourceContext(picking?row.details.sourceBalanceId:row.details.destinationBalanceId,session);
      const destinationId=picking?row.details.stagingLocationId:destinations.find(value=>same(value.receiptLineId,row._id))?.locationId;
      const to=await locationAt(destinationId,warehouseId,[picking?'STAGING':'STORAGE'],session);
      if(!ctx.location||!same(ctx.location.warehouseId,warehouseId)||same(ctx.location._id,to._id))throw validationError('Vị trí nguồn hoặc đích không hợp lệ');
      const total=(totals.get(String(ctx.balance._id))??exact('0')).plus(String(row.qtyBase));totals.set(String(ctx.balance._id),total);
      if(total.gt((await freeQuantity(ctx.balance,session)).plus(ownedReservations.filter(r=>same(r.balanceId,ctx.balance._id)).reduce((n,r)=>n.plus(remainingReservation(r)),exact('0')))))throw validationError('Không đủ tồn để lập lệnh');
      const fields={lineNo:i+1,lineKind:'WAREHOUSE_TASK',sources:[sourceLink(source,row,row.qtyBase)],details:{sourceBalanceId:ctx.balance._id,sourceBalanceVersion:ctx.balance.version,fromLocationId:ctx.location._id,toLocationId:to._id,qualityCode:ctx.balance.qualityStatus,ownerType:ctx.balance.ownerType,ownerId:ctx.balance.ownerId}};
      requirement.items.push(copyItem(row,row.qtyBase,fields));task.items.push(copyItem(row,row.qtyBase,fields));
    }
    await guardLocations(task.items.flatMap(row=>[row.details.fromLocationId,row.details.toLocationId]),session);
    requirement.sources=[sourceLink(source)];task.sources=[sourceLink(requirement)];
    if(!rows.length){requirement.workflowStatus='COMPLETED';task.workflowStatus='CONFIRMED';}
    await requirement.save({session});await task.save({session});
    for(const reservation of ownedReservations){reservation.executionRef={documentType:'transfer_orders',documentId:task._id};reservation.updatedBy=actor._id;await saveVersion(reservation,reservation.version,session);}
    return{document:task,resultRefs:[{documentType:'internal_transfer_requirements',documentId:requirement._id,revision:requirement.version}]};
  });
}
export function confirmTask(user,id,input) {
  return command(user,'CONFIRM_TRANSFER_TASK','stock_transfer:read',id,input,taskReplay,async(session,actor)=>{
    const task=await taskReplay(id,actor,session);checkVersion(task,input.expectedVersion);
    if(task.workflowStatus!=='OPEN'||!task.header.requirementId)throw validationError('Lệnh không còn mở hoặc không thuộc BF04');
    const requirement=await find(InternalTransferRequirement,task.header.requirementId,session),picking=task.header.taskKind==='PICK';
    if(picking&&input.destinations)throw validationError('Đích cất hàng chỉ dùng cho TO PUTAWAY');
    requirePermission(actor,picking?'stock_transfer:dispatch':'stock_transfer:receive');
    const source=await find(picking?TransferDispatch:TransferReceipt,requirement.header.sourceDocumentId,session);
    const outbound=picking?source:await find(TransferDispatch,source.header.dispatchId,session),request=await find(WarehouseTransferRequest,outbound.header.requestId,session);
    if(request.workflowStatus!=='APPROVED'||source.workflowStatus!==(picking?'DRAFT':'POSTED')||requirement.workflowStatus!=='OPEN')throw validationError('Nguồn không còn hiệu lực');
    if(picking&&!same(outbound.createdBy,actor._id)&&!same(task.header.assignedTo,actor._id))throw forbiddenError('Chỉ người lập phiếu xuất hoặc người được giao lấy hàng được xác nhận');
    if(!picking&&(input.pickedLines||input.shortReason))throw validationError('Lấy thiếu chỉ dùng cho TO lấy hàng');
    await saveVersion(request,request.version,session);
    if(!picking&&input.destinations)await planPutaway(task,requirement,source,input.destinations,session);
    if(!picking&&!task.items.length)throw validationError('Chọn vị trí đích cho tất cả dòng hàng tốt');
    const locations=task.items.flatMap(item=>[item.details.fromLocationId,item.details.toLocationId]);await guardLocations(locations,session);
    if(picking&&!input.recipientName?.trim())throw validationError('Cần tên người nhận bàn giao');
    if(picking&&input.pickedLines?.length){
      // Short pick: release the unpicked part of each reservation and shrink the task, requirement and dispatch lines to what was really picked.
      if(!input.shortReason)throw validationError('Nhập lý do lấy thiếu');
      const picked=new Map(input.pickedLines.map(row=>[row.taskLineId,exact(row.pickedQtyBase)]));
      for(const key of picked.keys())if(!task.items.id(key))throw validationError('Dòng lấy hàng không thuộc TO');
      for(const item of [...task.items]){
        const pickedQty=picked.get(String(item._id));if(!pickedQty)continue;
        const planned=exact(String(item.qtyBase));
        if(pickedQty.gt(planned))throw validationError('Lượng lấy vượt lượng trong TO');
        if(pickedQty.eq(planned))continue;
        let release=planned.minus(pickedQty);
        const held=await StockReservation.find({'executionRef.documentType':'transfer_orders','executionRef.documentId':task._id,balanceId:item.details.sourceBalanceId}).session(session);
        for(const reservation of held){
          const room=remainingReservation(reservation),part=room.lt(release)?room:release;
          if(part.lte(0))continue;
          reservation.releasedQty=exact(String(reservation.releasedQty)).plus(part).toFixed();reservation.updatedBy=actor._id;
          await saveVersion(reservation,reservation.version,session);release=release.minus(part);
        }
        const origin=outbound.items.id(item.sources.find(link=>same(link.documentId,source._id))?.itemId);
        const mirror=requirement.items.find(row=>row.lineNo===item.lineNo&&same(row.details.sourceBalanceId,item.details.sourceBalanceId));
        const shrink=(row)=>{
          if(!row)return;
          if(pickedQty.eq(0)){row.deleteOne();return;}
          row.qtyBase=pickedQty.toFixed();
          const entered=pickedQty.div(String(row.baseUnitsPerUnit));row.enteredQty=(entered.decimalPlaces()>6?entered.toDecimalPlaces(6):entered).toFixed();
        };
        shrink(origin);shrink(mirror);shrink(item);
      }
      if(!task.items.length)throw validationError('Cần lấy ít nhất một dòng; nếu không hãy hủy phiếu xuất');
      outbound.header.shortPickReason=input.shortReason;
    }
    if(picking){const reservations=await StockReservation.find({'executionRef.documentType':'transfer_orders','executionRef.documentId':task._id}).session(session);for(const r of reservations){r.consumedQty=exact(r.consumedQty).plus(remainingReservation(r)).toFixed();r.updatedBy=actor._id;await saveVersion(r,r.version,session);}}
    const posting=beginStock(picking?outbound:task,actor,picking?'TRANSFER_DISPATCH':'TRANSFER_PUTAWAY',input);
    for(const item of task.items){
      const ctx=await sourceContext(item.details.sourceBalanceId,session),origin=source.items.id(item.sources.find(link=>same(link.documentId,source._id))?.itemId);
      if(!origin||!same(ctx.batch._id,item.lotId)||ctx.balance.qualityStatus!==item.details.qualityCode||!ctx.product.isActive)throw validationError('Nguồn không khớp lệnh');
      await locationAt(item.details.toLocationId,task.header.warehouseId,[picking?'STAGING':'STORAGE'],session);
      const destination=await balanceAt({type:'LOCATION',locationId:item.details.toLocationId},ctx.balance,ctx.balance.qualityStatus,session);
      await moveStock(ctx.balance._id,destination._id,item.qtyBase,picking?origin._id:item._id,posting,actor,session,{excludeTaskId:id,allowOpening:picking});
      if(picking){
        const transit=await balanceAt({type:'IN_TRANSIT',dispatchLineId:origin._id},ctx.balance,ctx.balance.qualityStatus,session);
        await moveStock(destination._id,transit._id,item.qtyBase,origin._id,posting,actor,session,{excludeTaskId:id,allowOpening:true});
      }
    }
    await verifyCapacity(locations,session);await posting.save({session});
    if(picking){outbound.handovers ??= [];outbound.handovers.push({...await nextDocumentFields(TransferDispatch,'HO',outbound.header.sourceWarehouseId,session),workflowStatus:'CONFIRMED',version:1,createdBy:actor._id,header:{relatedDocumentId:outbound._id,recipientName:input.recipientName,vehiclePlate:input.vehiclePlate,driverName:input.driverName,driverPhone:input.driverPhone,note:input.note,handedOverAt:new Date(),confirmedBy:actor._id},items:outbound.items.map((i,index)=>copyItem(i,i.qtyBase,{lineNo:index+1,sources:[sourceLink(outbound,i,i.qtyBase)]}))});outbound.workflowStatus='POSTED';outbound.header.dispatchedBy=actor._id;outbound.header.dispatchedAt=new Date();outbound.stockTransactionId=posting._id;await saveVersion(outbound,outbound.version,session);
      let draftReceipt = await TransferReceipt.findOne({ 'header.dispatchId': outbound._id, workflowStatus: 'DRAFT' }).session(session);
      if (!draftReceipt) {
        draftReceipt = await document(
          TransferReceipt,
          'MWTR',
          actor,
          {
            dispatchId: outbound._id,
            warehouseId: request.header.destinationWarehouseId,
            receivedBy: actor._id,
            receivedAt: new Date(),
          },
          session,
          outbound.items.map((origin, index) =>
            copyItem(origin, origin.qtyBase, {
              lineNo: index + 1,
              lineKind: 'TRANSFER_RECEIPT',
              sources: [sourceLink(outbound, origin, origin.qtyBase)],
              details: { dispatchLineId: origin._id, qualityCode: 'GOOD' },
            }),
          ),
          'DRAFT',
        );
        draftReceipt.sources = [sourceLink(outbound)];
        await draftReceipt.save({ session });
      }
    }
    requirement.workflowStatus='COMPLETED';await saveVersion(requirement,requirement.version,session);
    task.workflowStatus='CONFIRMED';task.header.confirmedBy=actor._id;task.header.confirmedAt=new Date();task.stockTransactionId=posting._id;
    const saved=await saveVersion(task,input.expectedVersion,session);
    if(!picking)await completeTransferIfReady(request,actor,session);
    return{document:saved,versionBefore:input.expectedVersion,stockTransactionId:posting._id};
  });
}
export function receiveTransfer(user,id,input) {
  return command(user,'RECEIVE_TRANSFER','stock_transfer:receive',id,input,receiptReplay,async(session,actor)=>{
    const outbound=await find(TransferDispatch,id,session);checkVersion(outbound,input.expectedVersion);
    const request=await find(WarehouseTransferRequest,outbound.header.requestId,session);requireWarehouseAccess(actor,request.header.destinationWarehouseId);
    if(outbound.workflowStatus!=='POSTED'||request.workflowStatus!=='APPROVED')throw validationError('Nguồn chưa thực xuất hoặc đã đóng');
    if(same(outbound.header.dispatchedBy,actor._id))throw forbiddenError('Người nhận phải khác người xuất');
    await saveVersion(request,request.version,session);
    await guardLocations(input.lines.map(row=>row.locationId),session);
    const now = new Date();
    const existingDraft = await TransferReceipt.findOne({ 'header.dispatchId': outbound._id, workflowStatus: 'DRAFT' }).session(session);
    const receipt = existingDraft ?? await document(
      TransferReceipt,
      'MWTR',
      actor,
      {
        dispatchId: outbound._id,
        warehouseId: request.header.destinationWarehouseId,
        receivedBy: actor._id,
        receivedAt: now,
      },
      session,
      [],
      'POSTED',
    );
    if (existingDraft) {
      receipt.workflowStatus = 'POSTED';
      receipt.postedBy = actor._id;
      receipt.postedAt = now;
      receipt.occurredAt = now;
      receipt.header.receivedBy = actor._id;
      receipt.header.receivedAt = now;
      receipt.header.damageReportIds = [];
      receipt.items = [];
    } else {
      receipt.postedBy = actor._id;
      receipt.postedAt = now;
    }
    const posting=beginStock(receipt,actor,'TRANSFER_RECEIPT',input);
    for(const [i,row]of input.lines.entries()){
      const origin=outbound.items.id(row.dispatchLineId);if(!origin)throw validationError('Dòng không thuộc phiếu xuất');
      await locationAt(row.locationId,request.header.destinationWarehouseId,[row.qualityCode==='DAMAGED'?'QUARANTINE':'RECEIVING'],session);
      const point=await StockHoldingPoint.findOne({type:'IN_TRANSIT',dispatchLineId:origin._id}).session(session);
      const transit=point&&await InventoryBalance.findOne({holdingPointId:point._id,batchId:origin.lotId,ownerType:'STORE',qualityStatus:'GOOD'}).session(session);
      if(!transit)throw validationError('Không có hàng đang chuyển');
      const destination=await balanceAt({type:'LOCATION',locationId:row.locationId},transit,row.qualityCode,session);
      const item=copyItem(origin,row.qtyBase,{lineNo:i+1,lineKind:'TRANSFER_RECEIPT',sources:[sourceLink(outbound,origin,row.qtyBase)],details:{dispatchLineId:origin._id,qualityCode:row.qualityCode,destinationBalanceId:destination._id,receivingLocationId:row.locationId}});
      receipt.items.push(item);await moveStock(transit._id,destination._id,row.qtyBase,item._id,posting,actor,session);
      if(row.qualityCode==='DAMAGED'){
        const reportItem = copyItem(item,row.qtyBase,{lineNo:1,lineKind:'STANDARD',balanceId:destination._id,ownerType:'STORE',sources:[sourceLink(receipt,item,row.qtyBase)]});
        const report=await document(DefectReport,'DEF',actor,{warehouseId:receipt.header.warehouseId,discoveredAt:new Date(),reason:row.damageReason,reportedBy:actor._id},session,[reportItem]);
        report.holds.push({
          _id: newId(), defectReportLineId: reportItem._id, recordedBy: actor._id, recordedAt: new Date(),
          reason: row.damageReason, evidenceIds: [], allocations: [{ balanceId: destination._id, quantityBase: row.qtyBase }],
          events: [], status: 'ACTIVE', version: 1,
        });
        report.sources=[sourceLink(receipt)];await report.save({session});receipt.header.damageReportIds.push(report._id);
      }
    }
    await verifyCapacity(input.lines.map(row=>row.locationId),session);await posting.save({session});
    receipt.stockTransactionId=posting._id;receipt.sources=[sourceLink(outbound)];await receipt.save({session});
    const putaway=await automaticPutaway(receipt,actor,session);
    await saveVersion(outbound,outbound.version,session);
    const remainingItems = [];
    for (const origin of outbound.items) {
      const point = await StockHoldingPoint.findOne({ type: 'IN_TRANSIT', dispatchLineId: origin._id }).session(session);
      const transit = point && await InventoryBalance.findOne({
        holdingPointId: point._id,
        batchId: origin.lotId,
        ownerType: 'STORE',
        qualityStatus: 'GOOD',
      }).session(session);
      if (transit && exact(transit.quantityBase).gt(0)) {
        remainingItems.push(
          copyItem(origin, String(transit.quantityBase), {
            lineNo: remainingItems.length + 1,
            lineKind: 'TRANSFER_RECEIPT',
            sources: [sourceLink(outbound, origin, String(transit.quantityBase))],
            details: { dispatchLineId: origin._id, qualityCode: 'GOOD' },
          }),
        );
      }
    }
    if (remainingItems.length) {
      const nextDraft = await document(
        TransferReceipt,
        'MWTR',
        actor,
        {
          dispatchId: outbound._id,
          warehouseId: request.header.destinationWarehouseId,
          receivedBy: actor._id,
          receivedAt: now,
        },
        session,
        remainingItems,
        'DRAFT',
      );
      nextDraft.sources = [sourceLink(outbound)];
      await nextDraft.save({ session });
    }
    await completeTransferIfReady(request,actor,session);
    return{document:receipt,stockTransactionId:posting._id,...(putaway&&{resultRefs:[{documentType:'transfer_orders',documentId:putaway.task._id,revision:putaway.task.version}]})};
  });
}
export function closeRequest(user,id,input) {
  return command(user,'CLOSE_TRANSFER_REQUEST','stock_transfer:receive',id,input,requestReplay,async(session,actor)=>{
    const request=await find(WarehouseTransferRequest,id,session);checkVersion(request,input.expectedVersion);requireWarehouseAccess(actor,request.header.destinationWarehouseId);
    if(request.workflowStatus!=='APPROVED')throw validationError('Yêu cầu không còn mở');
    const blocker=await completionBlocker(request,session);if(blocker)throw validationError(blocker);
    request.workflowStatus='COMPLETED';request.header.closedBy=actor._id;request.header.closedAt=new Date();
    return{document:await saveVersion(request,input.expectedVersion,session),versionBefore:input.expectedVersion};
  });
}

export function closePartialRequest(user,id,input) {
  return command(user,'CLOSE_TRANSFER_REQUEST_PARTIAL','stock_transfer:read',id,input,requestReplay,async(session,actor)=>{
    const request=await find(WarehouseTransferRequest,id,session);checkVersion(request,input.expectedVersion);
    // Stopping the remaining quantity is allowed for the receiving warehouse, the shipping warehouse, or the owner.
    const byDestination=hasPermission(actor,'stock_transfer:receive')&&canAccessWarehouse(actor,request.header.destinationWarehouseId);
    const bySource=hasPermission(actor,'stock_transfer:dispatch')&&canAccessWarehouse(actor,request.header.sourceWarehouseId);
    if(!byDestination&&!bySource&&!isOwner(actor))throw forbiddenError('Chỉ kho nhận, kho xuất hoặc chủ cửa hàng được dừng phần còn lại');
    if(request.workflowStatus!=='APPROVED')throw validationError('Yêu cầu không còn mở');
    const dispatches=await TransferDispatch.find({'header.requestId':id,workflowStatus:{$ne:'CANCELLED'}}).session(session);
    if(!dispatches.length||dispatches.some(row=>row.workflowStatus!=='POSTED'))throw validationError('Còn phiếu xuất chưa hoàn tất');
    const points=await StockHoldingPoint.find({dispatchLineId:{$in:dispatches.flatMap(row=>row.items.map(item=>item._id))}}).session(session);
    if(await InventoryBalance.exists({holdingPointId:{$in:points.map(row=>row._id)},quantityBase:{$gt:0}}).session(session))throw validationError('Còn hàng đang chuyển hoặc chênh lệch chưa giải quyết');
    if(await StockDiscrepancy.exists({'header.sourceRef.documentId':{$in:dispatches.map(d=>d._id)},workflowStatus:'OPEN'}).session(session))throw validationError('Còn hồ sơ chênh lệch chưa giải quyết');
    const receipts=await TransferReceipt.find({'header.dispatchId':{$in:dispatches.map(row=>row._id)},workflowStatus:'POSTED'}).session(session);
    if(!receipts.length&&!await StockDiscrepancy.exists({'header.sourceRef.documentId':{$in:dispatches.map(d=>d._id)},'header.resolutionMode':'WRITE_OFF'}).session(session))throw validationError('Chưa nhận hàng tại kho đích');
    const pendingPutaway=await putawayBlocker(receipts,session,dispatches.map(row=>row._id));if(pendingPutaway)throw validationError(pendingPutaway);
    const shipped=request.items.map(item=>{const dispatched=dispatches.flatMap(row=>row.items).filter(row=>same(row.details.requestLineId,item._id)).reduce((sum,row)=>sum.plus(String(row.qtyBase)),exact('0'));return {itemId:item._id,approvedQtyBase:String(item.approvedQtyBase),dispatchedQtyBase:dispatched.toFixed(),shortfallQtyBase:exact(String(item.approvedQtyBase)).minus(dispatched).toFixed()};});
    if(!shipped.some(row=>exact(row.shortfallQtyBase).gt(0)))throw validationError('Đơn đã đủ lượng duyệt; hệ thống tự hoàn tất khi các TO và kiểm nhận đã xong');
    request.workflowStatus='COMPLETED';request.header.closedBy=actor._id;request.header.closedAt=new Date();request.header.closureMode='PARTIAL';request.header.closureReason=input.reason;
    return{document:await saveVersion(request,input.expectedVersion,session),versionBefore:input.expectedVersion,shipped};
  });
}

export function cancelRequest(user,id,input) {
  return command(user,'CANCEL_TRANSFER_REQUEST','stock_transfer:update',id,input,requestReplay,async(session,actor)=>{
    const request=await find(WarehouseTransferRequest,id,session);checkVersion(request,input.expectedVersion);requireRequestWarehouse(actor,request.header.sourceWarehouseId,request.header.destinationWarehouseId);
    if(!same(request.createdBy,actor._id))throw forbiddenError('Chỉ người lập yêu cầu mới được hủy');
    if(!['PENDING_APPROVAL','REVISION_REQUIRED','APPROVED'].includes(request.workflowStatus))throw validationError('Đơn không còn ở trạng thái có thể hủy');
    const dispatches=await TransferDispatch.find({'header.requestId':id,workflowStatus:{$ne:'CANCELLED'}}).session(session);
    if(dispatches.length)throw validationError('Đơn đã phát sinh phiếu xuất; hãy hủy phiếu xuất nháp hoặc dùng dừng chuyển tiếp');
    request.workflowStatus='CANCELLED';request.cancelledBy=actor._id;request.cancelledAt=new Date();request.cancelReason=input.reason;request.header.approvalStatus='CANCELLED';
    return{document:await saveVersion(request,input.expectedVersion,session),versionBefore:input.expectedVersion};
  });
}

export function updateRequest(user,id,input) {
 return command(user,'UPDATE_TRANSFER_REQUEST','stock_transfer:update',id,input,requestReplay,async(session,actor)=>{
  const request=await requestReplay(id,actor,session);checkVersion(request,input.expectedVersion);requireRequestWarehouse(actor,request.header.sourceWarehouseId,request.header.destinationWarehouseId);
  if(!same(request.createdBy,actor._id)||!['REVISION_REQUIRED','PENDING_APPROVAL'].includes(request.workflowStatus))throw validationError('Chỉ người lập được sửa yêu cầu chưa duyệt hoặc được trả lại');
  if(!same(request.header.sourceWarehouseId,input.sourceWarehouseId)||!same(request.header.destinationWarehouseId,input.destinationWarehouseId))throw validationError('Giữ nguyên kho của yêu cầu; cần kho khác thì lập đơn mới');
  if(await TransferDispatch.exists({'header.requestId':id,workflowStatus:{$ne:'CANCELLED'}}).session(session))throw validationError('Đã phát sinh phiếu xuất');
  const items=[];for(const [i,line]of input.lines.entries()){const previous=request.items.find(p=>same(p.productId,line.productId)&&String(p.lotId??'')===String(line.lotId??''));items.push(await makeRequestItem(line,i+1,request.header.sourceWarehouseId,session,previous));}
  request.items=items;request.header.reason=input.reason;request.header.neededOn=input.neededOn;request.workflowStatus='PENDING_APPROVAL';request.header.approvalStatus='PENDING_APPROVAL';
  return {document:await saveVersion(request,input.expectedVersion,session),versionBefore:input.expectedVersion};
 });
}

export function cancelDraftDispatch(user,id,input){
 return command(user,'CANCEL_TRANSFER_DISPATCH','stock_transfer:dispatch',id,input,dispatchReplay,async(session,actor)=>{
  const dispatch=await dispatchReplay(id,actor,session);checkVersion(dispatch,input.expectedVersion);
  if(dispatch.workflowStatus!=='DRAFT'||!same(dispatch.createdBy,actor._id))throw validationError('Chỉ người lập được hủy phiếu xuất nháp chưa bàn giao');
  const requirements=await InternalTransferRequirement.find({'header.sourceDocumentId':id}).session(session);
  const tasks=await TransferOrder.find({'header.requirementId':{$in:requirements.map(r=>r._id)}}).session(session);
  if(tasks.some(t=>t.workflowStatus!=='OPEN'))throw validationError('Nhiệm vụ không còn mở');
  const reservations=await StockReservation.find({$or:[{'executionRef.documentType':'transfer_dispatches','executionRef.documentId':id},{'executionRef.documentType':'transfer_orders','executionRef.documentId':{$in:tasks.map(t=>t._id)}}]}).session(session);
  for(const reservation of reservations){reservation.releasedQty=exact(reservation.releasedQty).plus(remainingReservation(reservation)).toFixed();reservation.updatedBy=actor._id;await saveVersion(reservation,reservation.version,session);await InventoryBalance.updateOne({_id:reservation.balanceId},{$inc:{version:1}},{session});}
  for(const doc of [...tasks,...requirements,dispatch]){doc.workflowStatus='CANCELLED';doc.cancelledBy=actor._id;doc.cancelledAt=new Date();doc.cancelReason=input.reason;await saveVersion(doc,doc.version,session);}
  const request=await find(WarehouseTransferRequest,dispatch.header.requestId,session);await saveVersion(request,request.version,session);
  return {document:dispatch,versionBefore:input.expectedVersion,reason:input.reason};
 });
}
