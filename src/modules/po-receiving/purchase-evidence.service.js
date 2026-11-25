import { createHash } from 'node:crypto';
import { Attachment } from '../../models/runtime.js';
import { requirePermission, hasPermission } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { ApiError, notFoundError, validationError } from '../../shared/utils/ApiError.js';
import { newId, command, checkVersion, saveVersion } from '../../shared/utils/document-command.js';
import { dto } from '../../shared/utils/persistence.js';
import { findPurchase, replayPurchase } from '../../shared/utils/purchase-core.js';
import { evidenceStorage, inspectFile } from '../../shared/utils/evidence-storage.js';
async function parent(user,id,write=false,session){
  const document=await findPurchase(id,user,session,{readOnly:!write});
  const permission=document.documentKind==='PO'?'purchase_order:'+ (write?'update':'read'):document.documentKind==='TO'?'stock_relocation:'+(write?'confirm':'read'):document.documentKind==='OTHER'?(write?'goods_receipt_other:create':'goods_receipt_other:read'):'goods_receipt_inspection:'+(write?'update':'read');
  if(write&&document.documentKind==='OTHER'&&document.workflowStatus==='POSTED'){
    requirePermission(user,'goods_receipt_other:reverse');
    return {document,permission:'goods_receipt_other:reverse'};
  }
  if(write&&document.documentKind==='CUSTODY_RECEIPT'&&hasPermission(user,'purchase_custody:decide')) return {document,permission:'purchase_custody:decide'};
  if(write&&document.documentKind==='PO'&&!hasPermission(user,permission))requirePermission(user,'purchase_order:approve_exception');else requirePermission(user,permission);
  return {document,permission:write&&document.documentKind==='PO'&&!hasPermission(user,permission)?'purchase_order:approve_exception':permission};
}
const resourceType=attachment=>attachment.mediaType==='application/pdf'?'raw':'image';
const format=attachment=>attachment.mediaType==='application/pdf'?'pdf':attachment.mediaType==='image/png'?'png':'jpg';
export async function uploadEvidence(user,id,file,lineId){
  const {document}=await parent(user,id,true);if(document.documentKind==='OTHER'&&!['DRAFT','POSTED'].includes(document.workflowStatus))throw validationError('Phiếu nhập khác không nhận chứng cứ ở trạng thái này');if(lineId&&!document.items.id(lineId))throw notFoundError();
  const type=await inspectFile(file),uploadId=newId(),storageKey='sep490/purchase-evidence/'+uploadId+(type.resourceType==='raw'?'.pdf':'');
  const attachment=await new Attachment({_id:uploadId,ownerDocumentType:document.constructor.collection.name,ownerDocumentId:document._id,ownerItemId:lineId,
    purpose:'PURCHASE_EVIDENCE',originalName:file.originalname,mediaType:type.mediaType,sizeBytes:file.buffer.length,storageKey,checksum:createHash('sha256').update(file.buffer).digest('hex'),uploadedBy:user._id,uploadedAt:new Date(),
    accessCategory:document.documentKind==='PO'?'PURCHASE_PRICE':'BUSINESS',status:'TEMPORARY',uploadSessionId:String(uploadId),expiresAt:new Date(Date.now()+86400000)}).save();
  try{const stored=await evidenceStorage.upload(file.buffer,{public_id:storageKey,resource_type:type.resourceType,type:'authenticated',overwrite:false});
    if(stored.public_id!==storageKey||stored.type!=='authenticated')throw new ApiError(502,'Storage chưa xác nhận tệp riêng tư');
    return {attachmentId:String(attachment._id),expiresAt:attachment.expiresAt.toISOString(),mediaType:type.mediaType,sizeBytes:file.buffer.length};
  }catch(error){await Attachment.updateOne({_id:attachment._id,status:'TEMPORARY'},{$set:{expiresAt:new Date()}});throw error;}
}
export async function attachEvidence(user,id,input){
  const {document:parentDoc,permission}=await parent(user,id,true);
  const upload=await Attachment.findOne({_id:input.attachmentId,ownerDocumentId:parentDoc._id,uploadedBy:user._id});
  if(!upload)throw notFoundError();
  if(upload.status==='TEMPORARY'){try{await evidenceStorage.exists(upload.storageKey,resourceType(upload));}catch{throw new ApiError(502,'Không xác minh được tệp trên storage');}}
  return command(user,'ATTACH_PURCHASE_EVIDENCE',permission,id,input,replayPurchase,async(session,actor)=>{
    const {document}=await parent(actor,id,true,session);checkVersion(document,input.expectedVersion);if(document.documentKind==='OTHER'&&!['DRAFT','POSTED'].includes(document.workflowStatus))throw validationError('Phiếu nhập khác không nhận chứng cứ ở trạng thái này');
    const attachment=await Attachment.findOne({_id:input.attachmentId,ownerDocumentId:document._id,uploadedBy:actor._id,status:'TEMPORARY',expiresAt:{$gt:new Date()}}).session(session);
    if(!attachment)throw validationError('Tệp đã gắn, hết hạn hoặc đang dọn');
    if(attachment.ownerItemId&&!document.items.id(attachment.ownerItemId))throw validationError('Dòng gốc không còn tồn tại');
    const write=await Attachment.updateOne({_id:attachment._id,status:'TEMPORARY',expiresAt:{$gt:new Date()}},{$set:{status:'ATTACHED',ownerRevision:document.version+1},$unset:{expiresAt:1,uploadSessionId:1}},{session,runValidators:true});
    if(write.matchedCount!==1)throw validationError('Tệp vừa được xử lý');
    document.evidenceIds.addToSet(attachment._id);
    return {document:await saveVersion(document,input.expectedVersion,session),versionBefore:input.expectedVersion};
  });
}
const priceAccess=user=>['OWNER','ACCOUNTANT'].includes(currentRole(user)?.code);
export async function listEvidence(user,id){
  const {document}=await parent(user,id);return {items:(await Attachment.find({ownerDocumentId:document._id,status:'ATTACHED',...(!priceAccess(user)&&{accessCategory:{$ne:'PURCHASE_PRICE'}})}).select('-storageKey -checksum -uploadSessionId').lean()).map(dto)};
}
export async function downloadEvidence(user,id,evidenceId){
  const {document}=await parent(user,id);const attachment=await Attachment.findOne({_id:evidenceId,ownerDocumentId:document._id,status:'ATTACHED',...(!priceAccess(user)&&{accessCategory:{$ne:'PURCHASE_PRICE'}})});
  if(!attachment)throw notFoundError();const expiresAt=Math.floor(Date.now()/1000)+60;
  return {url:await evidenceStorage.download(attachment.storageKey,format(attachment),resourceType(attachment),expiresAt),expiresAt:new Date(expiresAt*1000).toISOString()};
}
export async function cleanupPurchaseEvidence({now=new Date(),limit=100}={}){
  let removed=0;
  for(let i=0;i<limit;i++){
    const token='cleanup:'+newId();const attachment=await Attachment.findOneAndUpdate({purpose:'PURCHASE_EVIDENCE',expiresAt:{$lte:now},$or:[{status:'TEMPORARY'},{status:'SUPERSEDED',uploadSessionId:/^cleanup:/}]},
      {$set:{status:'SUPERSEDED',uploadSessionId:token,expiresAt:new Date(now.getTime()+300000)}},{returnDocument:'after'});
    if(!attachment)break;const result=await evidenceStorage.destroy(attachment.storageKey,resourceType(attachment));
    if(!['ok','not found'].includes(result.result))throw new ApiError(502,'Không dọn được tệp hết hạn');
    await Attachment.updateOne({_id:attachment._id,status:'SUPERSEDED',uploadSessionId:token},{$unset:{expiresAt:1,uploadSessionId:1}});removed++;
  }
  return {removed};
}

