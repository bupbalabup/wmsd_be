import { databaseId } from '../../models/document-identity.js';
import { effectiveQuantities } from '../sales-orders/sales-read.service.js';
import { exact } from '../../models/model-utils.js';
import { freeQuantities } from '../../shared/utils/stock-availability-read.js';
import { stocktakeLockedLocations } from '../../shared/utils/stock.js';
import mongoose from 'mongoose';
import { movementList } from '../../shared/utils/movement-list.js';
import { optionFields,movementDetailFields,requirementFields,executionFields,differenceFields,approvalFields } from '../../shared/utils/movement-read-fields.js';
import { WarehouseTransferRequest, TransferDispatch, TransferReceipt, InternalTransferRequirement, TransferOrder, ApprovalHistory, SalesOrder, WarehouseIssueRequest, SupplyAllocation, Warehouse, WarehouseLocation, StockHoldingPoint, InventoryBalance, ProductBatch, Product, Uom, Conversion, StockDiscrepancy } from '../../models/runtime.js';
import { requirePermission, requireWarehouseAccess, isOwner, hasPermission } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { dto } from '../../shared/utils/persistence.js';
import { notFoundError } from '../../shared/utils/ApiError.js';
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
  const request=await WarehouseTransferRequest.findOne({$and:[await scope(user),{_id:id}]}).select(movementDetailFields).lean();if(!request)throw notFoundError();
  const [[display],dispatches]=await Promise.all([transferWarehouseDisplay([dto(request)]),TransferDispatch.find({'header.requestId':id}).select(movementDetailFields).lean()]);
  const receipts=await TransferReceipt.find({'header.dispatchId':{$in:dispatches.map(row=>row._id)}}).select(movementDetailFields).lean();
  if(currentRole(user)?.code==='SALES')return {...display,dispatches:dispatches.map(row=>({id:String(row._id),workflowStatus:row.workflowStatus})),receipts:receipts.map(row=>({id:String(row._id),workflowStatus:row.workflowStatus}))};
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
  const lineProgress=request.items.map(item=>{const sent=dispatches.filter(d=>d.workflowStatus==='POSTED').flatMap(d=>d.items).filter(i=>String(i.details.requestLineId)===String(item._id));const sentIds=sent.map(i=>String(i._id));const received=receipts.filter(r=>r.workflowStatus==='POSTED').flatMap(r=>r.items).filter(i=>sentIds.includes(String(i.details.dispatchLineId)));const sum=rows=>rows.reduce((n,i)=>n.plus(effective.get(String(i._id))??String(i.qtyBase)),exact('0')).toFixed();return {lineId:String(item._id),dispatchedQtyBase:sent.reduce((n,i)=>n.plus(String(i.qtyBase)),exact('0')).toFixed(),receivedGoodQtyBase:sum(received.filter(i=>i.details.qualityCode==='GOOD')),receivedDamagedQtyBase:sum(received.filter(i=>i.details.qualityCode==='DAMAGED')),transitQtyBase:progress.flatMap(p=>p.lines).filter(l=>sentIds.includes(l.lineId)).reduce((n,l)=>n.plus(l.remainingQtyBase),exact('0')).toFixed(),unresolvedQtyBase:differences.filter(d=>d.workflowStatus!=='RESOLVED').flatMap(d=>d.items).filter(i=>sentIds.includes(String(i.details.sourceLineId))).reduce((n,i)=>n.plus(String(i.qtyBase)),exact('0')).toFixed()};});
  return {...display,lineProgress,differences:differences.map(dto),progress,dispatches:dispatches.map(dto),receipts:receipts.map(dto),internalRequirements:requirements.map(dto),tasks:tasks.map(dto),approvals:approvals.map(dto)};
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
export async function transferOptions(user, warehouseId, mode='stock') {
  requirePermission(user,'stock_transfer:read');
  const warehouses=await Warehouse.find({isActive:true}).select('_id code name isActive').lean();
  // Destination catalogue is store-wide; operational data stays warehouse-scoped.
  if(currentRole(user)?.code==='SALES')return {warehouses:warehouses.map(dto),sourceWarehouseIds:[],locations:[],holdingPoints:[],balances:[],batches:[],products:[]};
  const sourceWarehouseIds=warehouses.filter(row=>isOwner(user)||(user.warehouseIds||[]).some(id=>String(id)===String(row._id))).map(row=>String(row._id));
  if(!warehouseId)return {warehouses:warehouses.map(dto),sourceWarehouseIds,locations:[],holdingPoints:[],balances:[],batches:[],products:[]};
  requireWarehouseAccess(user,warehouseId);
  const locations=await WarehouseLocation.find({warehouseId,isActive:true}).select(optionFields.location).lean();
  if(mode==='locations'){const frozen=await stocktakeLockedLocations(locations.map(row=>row._id));return {warehouses:warehouses.map(dto),sourceWarehouseIds,locations:locations.map(row=>({...dto(row),lockedByStocktake:frozen.has(String(row._id))})),holdingPoints:[],balances:[],batches:[],products:[],units:[],conversions:[]};}
  const holdingPoints=await StockHoldingPoint.find({locationId:{$in:locations.map(row=>row._id)}}).select(optionFields.point).lean();
  const balances=(await InventoryBalance.find({holdingPointId:{$in:holdingPoints.map(row=>row._id)},quantityBase:{$gt:0}}).select(optionFields.balance).lean());
  const [batches,products,units,available]=await Promise.all([
    ProductBatch.find({_id:{$in:balances.map(row=>row.batchId)},identificationStatus:'VERIFIED'}).select(optionFields.batch).lean(),
    Product.find({isActive:true}).select(optionFields.product).lean(),Uom.find({isActive:true}).select('code name isCarton').lean(),freeQuantities(balances),
  ]);
  const conversions=await Conversion.find({productId:{$in:products.map(row=>row._id)},validFrom:{$lte:new Date()}}).select(optionFields.conversion).sort({validFrom:-1}).lean();
  const seenConversions=new Set();
  const currentConversions=conversions.filter(row=>{const key=JSON.stringify([String(row.productId),String(row.productBatchId||''),String(row.uomId)]);if(seenConversions.has(key))return false;seenConversions.add(key);return true;});
  const unitById=new Map(units.map(unit=>[String(unit._id),dto(unit)]));
  // Stocktake-locked locations (any role) stay listed but flagged, with nothing selectable.
  const frozen=await stocktakeLockedLocations(locations.map(row=>row._id)),frozenPoints=new Set(holdingPoints.filter(row=>frozen.has(String(row.locationId))).map(row=>String(row._id)));
  return {warehouses:warehouses.map(dto),sourceWarehouseIds,locations:locations.map(row=>({...dto(row),lockedByStocktake:frozen.has(String(row._id))})),holdingPoints:holdingPoints.map(dto),balances:balances.map(b=>{const lockedByStocktake=frozenPoints.has(String(b.holdingPointId));return {...dto(b),lockedByStocktake,availableQtyBase:lockedByStocktake?'0':available.get(String(b._id)).toFixed()};}),batches:batches.map(dto),products:products.map(dto),units:units.map(dto),conversions:currentConversions.map(row=>({...dto(row),uom:unitById.get(String(row.uomId))||null}))};
}
