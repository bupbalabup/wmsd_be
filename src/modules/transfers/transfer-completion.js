import { TransferDispatch,TransferReceipt,InternalTransferRequirement,TransferOrder,StockDiscrepancy,StockHoldingPoint,InventoryBalance } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { saveVersion } from '../../shared/utils/document-command.js';
import { effectiveQuantities } from '../sales-orders/sales-read.service.js';

// Called inside the parent's locked transaction, never from a read endpoint.
export async function completionBlocker(request,session) {
  const dispatches=await TransferDispatch.find({'header.requestId':request._id,workflowStatus:{$ne:'CANCELLED'}})
    .select('_id workflowStatus items._id items.qtyBase items.details.requestLineId').session(session).lean();
  if(!dispatches.length||dispatches.some(row=>row.workflowStatus!=='POSTED'))return 'Còn phiếu xuất chưa hoàn tất';
  const dispatched=new Map(),requestByDispatchLine=new Map();
  for(const row of dispatches)for(const item of row.items){
    const key=String(item.details.requestLineId);requestByDispatchLine.set(String(item._id),key);
    dispatched.set(key,(dispatched.get(key)??exact('0')).plus(String(item.qtyBase)));
  }
  if(request.items.some(item=>!(dispatched.get(String(item._id))??exact('0')).eq(String(item.approvedQtyBase))))return 'Chưa xuất đủ lượng duyệt';
  const ids=dispatches.map(row=>row._id);
  if(await StockDiscrepancy.exists({'header.sourceRef.documentId':{$in:ids},workflowStatus:'OPEN'}).session(session))return 'Còn hồ sơ chênh lệch chưa giải quyết';
  const points=await StockHoldingPoint.find({dispatchLineId:{$in:[...requestByDispatchLine.keys()]}}).select('_id').session(session).lean();
  if(await InventoryBalance.exists({holdingPointId:{$in:points.map(row=>row._id)},quantityBase:{$gt:0}}).session(session))return 'Còn hàng đang chuyển hoặc chênh lệch chưa giải quyết';
  const receipts=await TransferReceipt.find({'header.dispatchId':{$in:ids},workflowStatus:'POSTED'})
    .select('_id items._id items.qtyBase items.details.dispatchLineId items.details.qualityCode').session(session).lean();
  const lost=await writtenOffByRequestLine(ids,requestByDispatchLine,session);
  if(!receipts.length&&!lost.size)return 'Chưa nhận hàng';
  // Transit loss written off by the owner counts as accounted for, alongside what was received.
  const effective=await effectiveQuantities(receipts,session),received=new Map(lost);
  for(const receipt of receipts)for(const item of receipt.items){
    const key=requestByDispatchLine.get(String(item.details.dispatchLineId));
    received.set(key,(received.get(key)??exact('0')).plus(effective.get(String(item._id))??String(item.qtyBase)));
  }
  if(request.items.some(item=>!(received.get(String(item._id))??exact('0')).eq(String(item.approvedQtyBase))))return 'Chưa nhận đủ lượng duyệt';
  return putawayBlocker(receipts,session,ids);
}
export async function writtenOffByRequestLine(dispatchIds,requestByDispatchLine,session){
  const rows=await StockDiscrepancy.find({'header.sourceRef.documentId':{$in:dispatchIds},workflowStatus:'RESOLVED','header.resolutionMode':'WRITE_OFF'})
    .select('items.qtyBase items.details.sourceLineId').session(session).lean();
  const totals=new Map();
  for(const item of rows.flatMap(row=>row.items)){
    const key=requestByDispatchLine.get(String(item.details.sourceLineId));
    if(key)totals.set(key,(totals.get(key)??exact('0')).plus(String(item.qtyBase)));
  }
  return totals;
}
export async function putawayBlocker(receipts,session,dispatchIds=[]) {
  const good=receipts.filter(row=>row.items.some(item=>item.details.qualityCode!=='DAMAGED'));
  if(good.length||dispatchIds.length){
    const requirements=await InternalTransferRequirement.find({'header.sourceDocumentId':{$in:[...dispatchIds,...good.map(row=>row._id)]}})
      .select('_id workflowStatus header.sourceDocumentId').session(session).lean();
    const tasks=await TransferOrder.find({'header.requirementId':{$in:requirements.map(row=>row._id)}})
      .select('_id workflowStatus header.requirementId').session(session).lean();
    if(requirements.some(row=>row.workflowStatus!=='COMPLETED')||tasks.some(row=>row.workflowStatus!=='CONFIRMED'))return 'Chưa cất xong mọi phiếu nhận hoặc TO liên quan';
    for(const receipt of good){
      const requirement=requirements.find(row=>String(row.header.sourceDocumentId)===String(receipt._id));
      const related=tasks.filter(row=>String(row.header.requirementId)===String(requirement?._id));
      if(requirement?.workflowStatus!=='COMPLETED'||!related.length||related.some(row=>row.workflowStatus!=='CONFIRMED'))return 'Chưa cất xong mọi phiếu nhận';
    }
  }
  return null;
}
export async function completeTransferIfReady(request,actor,session) {
  if(request.workflowStatus!=='APPROVED'||await completionBlocker(request,session))return false;
  request.workflowStatus='COMPLETED';request.header.closedBy=actor._id;request.header.closedAt=new Date();
  await saveVersion(request,request.version,session);return true;
}
