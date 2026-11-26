import { newBusinessDocument } from '../../shared/utils/document-number.js';
import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { ApiError, validationError, notFoundError, versionConflict } from '../../shared/utils/ApiError.js';
import { requirePermission, requireWarehouseAccess, canAccessWarehouse, hasPermission, isOwner } from '../../shared/utils/access.js';
import { command, newId, same, saveVersion, checkVersion, hash } from '../../shared/utils/document-command.js';
import { transaction, serialize } from '../../shared/utils/persistence.js';
import { balanceAt, sourceContext, guardLocations, locationAt, beginStock, splitPortions, retainPortions, remainingReservation, pendingTaskQuantity, heldQuantity, verifyCapacity, receiveStock } from '../../shared/utils/stock.js';
export { m, exact, ApiError, validationError, notFoundError, versionConflict, requirePermission, requireWarehouseAccess, canAccessWarehouse, hasPermission, command, newId, same, saveVersion, checkVersion, hash, transaction, serialize, balanceAt, sourceContext, guardLocations, locationAt, beginStock, splitPortions, remainingReservation, pendingTaskQuantity, heldQuantity, verifyCapacity, receiveStock };
export const resources = {
 'defects': [m.DefectReport,'defect:read'], 'customer-returns': [m.CustomerReturn,'customer_return:read'],
 'failed-deliveries': [m.FailedDelivery,'failed_delivery:read'], 'supplier-returns': [m.SupplierReturn,'supplier_return:read'],
};
export const sum = (rows, field = 'qtyBase') => rows.reduce((n,row) => n.plus(String(row[field] ?? '0')), exact('0'));
export const source = (doc,item,relationCode='SOURCE',qty) => ({ subjectCollection: doc.constructor.collection.name, documentId:doc._id, ...(item && {itemId:item._id}), relationCode, ...(qty && {linkedQty:String(qty)}) });
export const ref = (doc,item) => ({ documentType:doc.constructor.collection.name, documentId:doc._id, ...(item && {itemId:item._id}), revision:doc.version });
export function envelope(Model,user,header,items=[],status='OPEN',note) {return newBusinessDocument(Model,user,header,items,status,note);}
export function copy(sourceItem,quantity,lineNo=1,extra={}) {
 const amount=exact(quantity),factor=exact(sourceItem.baseUnitsPerUnit),entered=amount.div(factor);
 if(!amount.gt(0)||!entered.mul(factor).eq(amount)||entered.decimalPlaces()>6) throw validationError('Lượng không biểu diễn chính xác theo quy đổi lịch sử');
 return {_id:newId(),lineNo,lineKind:'STANDARD',productId:sourceItem.productId,lotId:sourceItem.lotId,enteredUnit:sourceItem.enteredUnit,baseUnitSnapshot:sourceItem.baseUnitSnapshot,baseUnitsPerUnit:String(sourceItem.baseUnitsPerUnit),packagingSnapshot:sourceItem.packagingSnapshot,enteredQty:entered.toFixed(),qtyBase:amount.toFixed(),productNameSnapshot:sourceItem.productNameSnapshot,...extra};
}
export async function fromBalance(balance,quantity,session,extra={}) {
 const batch=await m.ProductBatch.findById(balance.batchId).session(session),product=batch&&await m.Product.findById(batch.productId).session(session);
 if(!batch||!product?.isActive||batch.identificationStatus!=='VERIFIED'||(product.wholeBaseUnits&&!exact(quantity).isInteger()))throw validationError('Lô hoặc số lượng không hợp lệ');
 return {_id:newId(),lineNo:1,lineKind:'STANDARD',productId:product._id,lotId:batch._id,enteredUnit:product.baseUnit,baseUnitSnapshot:product.baseUnit,baseUnitsPerUnit:'1',enteredQty:String(quantity),qtyBase:String(quantity),productNameSnapshot:product.name,...extra};
}
export async function scoped(Model,id,user,session,permission) {
 if(permission)requirePermission(user,permission);
 const doc=await Model.findById(id).session(session);
 if(!doc)throw notFoundError();
 let warehouse=doc.header?.warehouseId;
 if(!warehouse&&Model===m.DefectReport){
  const balances=await m.InventoryBalance.find({_id:{$in:doc.items.map(i=>i.balanceId).filter(Boolean)}}).session(session);
  const points=await m.StockHoldingPoint.find({_id:{$in:balances.map(b=>b.holdingPointId)}}).session(session);
  const locations=await m.WarehouseLocation.find({_id:{$in:points.map(p=>p.locationId).filter(Boolean)}}).session(session);
  const ids=[...new Set(locations.map(l=>String(l.warehouseId)))];if(ids.length===1)warehouse=ids[0];
 }
 if(!warehouse&&Model===m.SalesOrder){const requests=await m.WarehouseIssueRequest.find({'header.salesOrderId':doc._id}).session(session);const accessible=requests.find(r=>canAccessWarehouse(user,r.header.requestedWarehouseId));warehouse=accessible?.header.requestedWarehouseId;}
 if(!warehouse&&Model===m.SalesOrder){const requests=await m.WarehouseIssueRequest.find({'header.salesOrderId':doc._id}).session(session);warehouse=requests.find(r=>canAccessWarehouse(user,r.header.requestedWarehouseId))?.header.requestedWarehouseId;}
 // Owner's list scope is {} so legacy defects without a resolvable warehouse are listed; keep detail consistent.
 if(!warehouse&&Model===m.DefectReport&&isOwner(user))return doc;
 if(!warehouse)throw notFoundError('Không xác định được kho của hồ sơ');
 requireWarehouseAccess(user,warehouse);
 if(Model===m.CustomerReturn && hasPermission(user,'customer_return:create')&&!hasPermission(user,'customer_return:inspect')&&!hasPermission(user,'customer_return:approve_exception')&&!same(doc.createdBy,user._id))throw notFoundError();
 return doc;
}
export const replay = Model => (id,user,session) => scoped(Model,id,user,session);
export async function evidence(doc,ids,session) {
 if(!ids?.length)throw validationError('Cần chứng cứ đã tải lên');
 const rows=await m.Attachment.find({_id:{$in:ids},ownerDocumentId:doc._id,status:'ATTACHED',accessCategory:'BUSINESS'}).session(session);
 if(rows.length!==new Set(ids.map(String)).size)throw validationError('Chứng cứ không thuộc hồ sơ hoặc chưa được lưu');
 return rows;
}
export async function itemById(Model,itemId,user,session) {
 const doc=await Model.findOne({'items._id':itemId}).session(session);if(!doc)throw notFoundError();
 if(doc.header?.warehouseId)requireWarehouseAccess(user,doc.header.warehouseId);
 return {doc,item:doc.items.id(itemId)};
}
export async function lockSource(doc,item,session) {
 const sourceKey=`${doc.constructor.collection.name}:${doc._id}:${item._id}`;
 await m.ReturnSourceLock.updateOne({sourceKey},{$setOnInsert:{sourceKind:doc.constructor.collection.name,sourceDocumentId:doc._id,sourceItemId:item._id},$inc:{version:1}},{session,upsert:true});
}
export const remainingClaim = claim => exact(claim.claimedQtyBase)
  .minus(sum(claim.events.filter(e => e.kind === 'RECEIVED' || e.kind === 'RELEASED'), 'quantityBase'))
  .plus(sum(claim.events.filter(e => e.kind === 'REACQUIRED'), 'quantityBase'));
export async function claimTotal(sourceId,kind,session) {
 const claims=await m.ReturnQuantityClaim.find({sourceLineId:sourceId,claimKind:kind}).session(session);
  // Received claims remain charged to the original source; released portions can only be used again after reacquisition.
 return claims.reduce((n,c)=>n.plus(exact(c.claimedQtyBase)
  .minus(sum(c.events.filter(e=>e.kind==='RELEASED'),'quantityBase'))
  .plus(sum(c.events.filter(e=>e.kind==='REACQUIRED'),'quantityBase'))),exact('0'));
}
export async function reacquireClaim(itemId,quantity,document,user,session) {
 const claim=await m.ReturnQuantityClaim.findOne({requestLineId:itemId}).session(session);
 if(!claim||!exact(quantity).gt(0))throw validationError('Không có hạn mức đã giải phóng để cấp lại');
 const released=sum(claim.events.filter(e=>e.kind==='RELEASED'),'quantityBase');
 const reacquired=sum(claim.events.filter(e=>e.kind==='REACQUIRED'),'quantityBase');
 if(exact(quantity).gt(released.minus(reacquired)))throw validationError('Hạn mức đã giải phóng không còn đủ để cấp lại');
 const before=claim.version;
 claim.events.push({kind:'REACQUIRED',quantityBase:String(quantity),sourceRef:ref(document),performedBy:user._id,performedAt:new Date()});
 claim.version++;
 await claim.validate();
 const result=await m.ReturnQuantityClaim.updateOne({_id:claim._id,version:before},{$set:{events:claim.events},$inc:{version:1}},{session});
 if(result.matchedCount!==1)throw versionConflict();
 return claim;
}
export async function resolveClaim(itemId,quantity,kind,document,user,session) {
 const claim=await m.ReturnQuantityClaim.findOne({requestLineId:itemId}).session(session);
 if(!claim||exact(quantity).gt(remainingClaim(claim)))throw validationError('Vượt hạn mức trả còn lại');
 const before=claim.version;claim.events.push({kind,quantityBase:String(quantity),sourceRef:ref(document),performedBy:user._id,performedAt:new Date()});claim.version++;
 await claim.validate();const result=await m.ReturnQuantityClaim.updateOne({_id:claim._id,version:before},{$set:{events:claim.events},$inc:{version:1}},{session});if(result.matchedCount!==1)throw versionConflict();
}
async function activeSourceTransactions(doc,session) {
 const roots=await m.StockTransaction.find({sourceId:doc._id,reversedTransactionId:{$exists:false}}).session(session);
 const active=[];
 for(const root of roots){let isActive=true,current=root,seen=new Set();while(current){if(seen.has(String(current._id)))throw validationError('Lịch sử đảo có vòng lặp');seen.add(String(current._id));const next=await m.StockTransaction.findOne({reversedTransactionId:current._id}).session(session);if(!next)break;isActive=!isActive;current=next;}if(isActive)active.push(root);}
 return active;
}
export async function effectivePosted(doc,itemId,session) {
 if(doc.workflowStatus!=='POSTED')return exact('0');
 const roots=await activeSourceTransactions(doc,session);
 let total=exact('0');
 for(const root of roots)total=total.plus(sum(root.movements.filter(x=>same(x.sourceLineId,itemId)&&(['GI_SALE','GI_SUPPLIER_RETURN'].includes(doc.documentKind)?x.fromBalanceId:x.toBalanceId)),'quantityBase'));
 return total;
}
export async function postedIssueLots(doc,itemId,session) {
 if(doc.workflowStatus!=='POSTED')return [];
 const totals=new Map();
 for(const transaction of await activeSourceTransactions(doc,session))for(const movement of transaction.movements.filter(row=>same(row.sourceLineId,itemId)&&row.fromBalanceId)){
  const key=String(movement.fromBalanceId);totals.set(key,(totals.get(key)??exact('0')).plus(String(movement.quantityBase)));
 }
 const balances=await m.InventoryBalance.find({_id:{$in:[...totals.keys()]}}).select('batchId').session(session);
 const batches=await m.ProductBatch.find({_id:{$in:balances.map(row=>row.batchId).filter(Boolean)}}).select('manufacturerLot').session(session);
 const byLot=new Map();
 for(const balance of balances){if(!balance.batchId)continue;const batch=batches.find(row=>same(row._id,balance.batchId));if(!batch)continue;const key=String(balance.batchId);byLot.set(key,(byLot.get(key)??exact('0')).plus(totals.get(String(balance._id))??'0'));}
 if(!byLot.size){const item=doc.items.id(itemId);if(item?.lotId){const batch=await m.ProductBatch.findById(item.lotId).select('manufacturerLot').session(session);const quantity=await effectivePosted(doc,itemId,session);if(batch&&quantity.gt(0)){batches.push(batch);byLot.set(String(item.lotId),quantity);}}}
 return [...byLot].map(([lotId,quantityBase])=>({lotId,manufacturerLot:batches.find(row=>String(row._id)===lotId)?.manufacturerLot??'—',quantityBase:quantityBase.toFixed()})).sort((a,b)=>a.manufacturerLot.localeCompare(b.manufacturerLot)||a.lotId.localeCompare(b.lotId));
}
export async function committedCustomerReturnLot(sourceLineId,lotId,session) {
 const docs=await m.CustomerReturn.find({'items.details.originalIssueLineId':sourceLineId,'items.lotId':lotId}).select('items').session(session);
 const lineIds=docs.flatMap(doc=>doc.items.filter(item=>same(item.details?.originalIssueLineId,sourceLineId)&&same(item.lotId,lotId)).map(item=>item._id));
 const claims=await m.ReturnQuantityClaim.find({requestLineId:{$in:lineIds},claimKind:'CR'}).session(session);
 return claims.reduce((total,claim)=>total.plus(exact(claim.claimedQtyBase).minus(sum(claim.events.filter(event=>event.kind==='RELEASED'),'quantityBase')).plus(sum(claim.events.filter(event=>event.kind==='REACQUIRED'),'quantityBase'))),exact('0'));
}
export async function undeliveredReturnedQuantity(itemId,session) {
 const receipts=await m.FailedDeliveryReceipt.find({workflowStatus:'POSTED','items.details.salesIssueLineId':itemId}).session(session);let total=exact('0');
 for(const receipt of receipts)for(const row of receipt.items.filter(i=>same(i.details.salesIssueLineId,itemId)))total=total.plus(await effectivePosted(receipt,row._id,session));
 return total;
}
export function standaloneSaleReturnAllowance(issued,undelivered,openFailedDelivery) {
 const available=exact(issued).minus(String(undelivered)).minus(String(openFailedDelivery));return available.gt(0)?available:exact('0');
}
export async function issueSource(itemId,user,session,{allowWarehouseCreatedStandalone=false}={}) {
 const {doc,item}=await itemById(m.SalesGoodsIssue,itemId,user,session);
 if(doc.header.fulfillmentMode==='DIRECT'){
  const so=await m.SalesOrder.findById(doc.header.salesOrderId).session(session),soItem=so?.items.id(item.salesOrderItemId);
  if(!soItem||!same(soItem.productId,item.productId))throw validationError('Dòng phiếu xuất không khớp yêu cầu mua hàng của khách');
  if(user.roleId?.code==='SALES'&&!same(so.createdBy,user._id))throw notFoundError();
  await lockSource(doc,item,session);
  return {doc,item,so,soItem,issued:await effectivePosted(doc,itemId,session),delivered:sum((doc.customerReceipts||[]).filter(r=>same(r.issueLineId,itemId)),'quantityBase')};
 }
 if(doc.documentKind==='GI_SALE'&&doc.header.issueKind==='SALE'&&doc.header.referenceNo&&!doc.header.salesOrderId){
  if(user.roleId?.code==='SALES'&&!same(doc.createdBy,user._id)&&!(allowWarehouseCreatedStandalone&&hasPermission(user,'customer_return:create')))throw notFoundError();
  await lockSource(doc,item,session);
  return {doc,item,issued:await effectivePosted(doc,itemId,session),customerName:doc.header.customerName,customerPhone:doc.header.customerPhone,standaloneSale:true};
 }
 const od=await m.DeliveryOrder.findOne({'items._id':item.details.outboundDeliveryLineId}).session(session);
 const odItem=od?.items.id(item.details.outboundDeliveryLineId);
 const wir=odItem&&await m.WarehouseIssueRequest.findOne({'items._id':odItem.details.issueRequestLineId}).session(session);
 const wirItem=wir?.items.id(odItem.details.issueRequestLineId);
 const so=wirItem&&await m.SalesOrder.findById(wir.header.salesOrderId).session(session);
 const soItem=so?.items.id(wirItem.details.salesOrderLineId);
 if(!soItem||!same(od.header.issueRequestId,wir._id)||![odItem,wirItem,soItem].every(i=>same(i.productId,item.productId)))throw validationError('Chuỗi SO/WIR/OD/GI không hợp lệ');
 await lockSource(doc,item,session);
 const issued=await effectivePosted(doc,itemId,session);
 const delivered=sum(so.deliveryConfirmations.filter(c=>c.workflowStatus==='CONFIRMED').flatMap(c=>c.items).filter(i=>same(i.details.salesIssueLineId,itemId)));
 return {doc,item,od,odItem,wir,wirItem,so,soItem,issued,delivered};
}
export async function takeStock(balanceId,quantity,itemId,posting,user,session,{holdId,reservationDocumentId,allowOpening=false}={}) {
 const ctx=await sourceContext(balanceId,session),{balance,location,product}=ctx;
 if(!location)throw validationError('Tồn nguồn không nằm trong ô kho');requireWarehouseAccess(user,location.warehouseId);await guardLocations([location._id],session);
 const amount=exact(quantity),before=exact(balance.quantityBase);
 if(!amount.gt(0)||(product.wholeBaseUnits&&!amount.isInteger()))throw validationError('Lượng thực hiện không hợp lệ');
 const reservations=await m.StockReservation.find({balanceId}).session(session);
 const own=reservations.filter(r=>same(r.demandRef.documentId,reservationDocumentId)),other=reservations.filter(r=>!same(r.demandRef.documentId,reservationDocumentId));
 const blocked=await heldQuantity(balanceId,session,holdId),pending=await pendingTaskQuantity(balanceId,session);
 if(amount.plus(sum(other.map(r=>({qtyBase:remainingReservation(r)})))).plus(blocked).plus(pending).gt(before))throw validationError('Không đủ tồn tự do hoặc tồn đang bị chặn');
 const {kept,taken}=splitPortions(balance.packagingPortions,amount,user._id,{allowOpening});balance.quantityBase=before.minus(amount).toFixed();
 // Keep subdocument identity when consuming an earlier arrival, as moveStock does.
 retainPortions(balance,kept);
 await balance.validate();
 // The document is validated above; native persistence preserves each retained
 // portion's timestamps instead of applying array-replacement timestamps.
 const result=await m.InventoryBalance.collection.updateOne({_id:balance._id,version:balance.version},{$set:{quantityBase:balance.quantityBase,packagingPortions:balance.packagingPortions.map(portion=>portion.toObject()),updatedAt:new Date()},$inc:{version:1}},{session});if(result.matchedCount!==1)throw versionConflict();
 let consume=amount;for(const r of own){const available=remainingReservation(r),q=available.lt(consume)?available:consume;if(!q.gt(0))continue;const result=await m.StockReservation.updateOne({_id:r._id,version:r.version},{$set:{consumedQty:exact(r.consumedQty).plus(q).toFixed()},$inc:{version:1}},{session});if(result.matchedCount!==1)throw versionConflict();consume=consume.minus(q);}
 posting.movements.push({transactionId:posting._id,lineNo:posting.movements.length+1,sourceLineId:itemId,fromBalanceId:balance._id,quantityBase:amount.toFixed(),fromBefore:before.toFixed(),fromAfter:balance.quantityBase});
 return {ctx,portions:taken};
}
export async function postIn(doc,item,user,session,posting,{locationId,qualityCode,ownerType='STORE',ownerId=null,portions}={}) {
 const loc=await locationAt(locationId,doc.header.warehouseId,qualityCode==='GOOD'?['RECEIVING','STORAGE','CUSTODY']:['QUARANTINE','CUSTODY'],session);
 if(ownerType==='STORE'&&loc.locationType==='CUSTODY')throw validationError('Hàng sở hữu không nhập vào ô giữ hộ');
 await guardLocations([loc._id],session);
 const balance=await balanceAt({type:'LOCATION',locationId:loc._id},{batchId:item.lotId,ownerType,ownerId},qualityCode,session);
 await receiveStock(balance,item,portions,posting,user,session);await verifyCapacity([loc._id],session);return balance;
}
export async function savePosted(doc,posting,user,session) {
 await posting.save({session});doc.stockTransactionId=posting._id;doc.postedBy=user._id;doc.postedAt=new Date();doc.workflowStatus='POSTED';await doc.save({session});return doc;
}
export async function assertWholeQuantity(productId, quantity, session) {
 const product = await m.Product.findById(productId).select('wholeBaseUnits').session(session);
 if (!product || product.wholeBaseUnits && !exact(quantity).isInteger()) throw validationError('Số lượng phải nguyên theo đơn vị gốc của sản phẩm');
}
