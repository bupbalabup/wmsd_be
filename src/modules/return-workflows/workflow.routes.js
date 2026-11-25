import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import multer from 'multer';
import * as v from './native.validation.js';
import { resources, validationError } from './native.shared.js';
import * as controller from './workflow.controller.js';

const uploadSingleImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');
const router=Router();
const multipart=(req,_res,next)=>{try{if(typeof req.body.payload==='string')req.body=JSON.parse(req.body.payload);next();}catch{next(validationError('Biá»ƒu máº«u khÃ´ng há»£p lá»‡'));}};
router.get('/return-workflows/options',authenticate,validate(v.optionsSchema),controller.options);
router.get('/return-workflows/lookup',authenticate,validate(v.lookupSchema),controller.lookupRecords);
router.get('/return-workflows/:id/context',authenticate,checkPermission('external_reference:create'),validate(v.idSchema),controller.context);
for(const [resource,[,permission]] of Object.entries(resources)){
 router.get(`/${resource}`,authenticate,checkPermission(permission),validate(v.listSchema),controller.list(resource));
 router.get(`/${resource}/:id`,authenticate,checkPermission(permission),validate(v.idSchema),controller.detail(resource));
}
for(const [resource,permission,schema,handler,file] of [
 ['defects','defect:create',v.defectCreateSchema,controller.createDefect,true],
 ['customer-returns','customer_return:create',v.customerCreateSchema,controller.createCustomerReturn,false],
 ['failed-deliveries','failed_delivery:inspect',v.failedCreateSchema,controller.createFailedDelivery,true],
 ['supplier-returns','supplier_return:create',v.supplierCreateSchema,controller.createSupplierReturn,false],
])router.post(`/${resource}`,authenticate,checkPermission(permission),...(file?[uploadSingleImage,multipart]:[]),validate(schema),handler);
for(const [path,permission,schema,handler] of [
 ['defects/:id/proposals','defect:create',v.proposalSchema,controller.submitDefectProposal],
 ['defects/:id/decision','defect:approve',v.decisionSchema,controller.decideDefect],['defects/:id/execute','defect:execute',v.executeSchema,controller.executeDefect],
 ['customer-returns/:id/inspect','customer_return:inspect',v.inspectionSchema,controller.inspectCustomerReturn],
 ['customer-returns/:id/reassess','customer_return:inspect',v.reassessSchema,controller.reassessCustomerReturn],
 ['customer-returns/:id/decision','customer_return:accept',v.decisionSchema,controller.decideCustomerReturn],
 ['customer-returns/:id/exception-decision','customer_return:approve_exception',v.decisionSchema,controller.decideCustomerReturnException],
 ['customer-returns/:id/receipt','customer_return:post',v.receiptSchema,controller.receiveCustomerReturn],
 ['customer-returns/:id/handback','customer_return:post',v.dispatchSchema,controller.handBackCustomerReturn],
 ['failed-deliveries/:id/inspect','failed_delivery:inspect',v.failedInspectionSchema,controller.inspectFailedDelivery],['failed-deliveries/:id/receipt','failed_delivery:post',v.receiptSchema,controller.receiveFailedDelivery],
 ['supplier-returns/:id/agreement','supplier_return:record_agreement',v.agreementSchema,controller.supplierAgreement],['supplier-returns/:id/dispatch','supplier_return:dispatch',v.dispatchSchema,controller.dispatchSupplierReturn],
 ['supplier-returns/:id/acknowledgement','supplier_return:record_agreement',v.ackSchema,controller.acknowledgeSupplierReturn],['supplier-returns/:id/close','supplier_return:close',v.closeSchema,controller.closeSupplierReturn],
])router.post(`/${path}`,authenticate,checkPermission(permission),validate(schema),handler);
router.post('/return-workflows/:id/evidence',authenticate,validate(v.idSchema),uploadSingleImage,controller.uploadEvidence);
router.get('/return-workflows/:id/evidence/:evidenceId',authenticate,validate(v.idSchema),controller.downloadEvidence);
router.get('/lots/:id/trace',authenticate,validate(v.idSchema),controller.traceLot);
router.get('/lots/:id/trace/records',authenticate,validate(v.traceRecordsSchema),controller.lotRecords);
router.get('/lots/:id/trace/evidence/:evidenceId',authenticate,validate(v.idSchema),controller.lotEvidence);
router.get('/external-references',authenticate,checkPermission('external_reference:read'),validate(v.listSchema),controller.listExternalReferences);
router.post('/external-references/historical',authenticate,checkPermission('external_reference:create'),uploadSingleImage,multipart,validate(v.historicalSchema),controller.createHistoricalSource);
router.post('/external-references',authenticate,checkPermission('external_reference:create'),(req,_res,next)=>{req.params.id=req.body.documentId;next();},validate(v.externalSchema),controller.recordExternalReference);
export default router;
