import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import * as controller from './po-receiving.controller.js';
import * as validation from './po-receiving.validation.js';

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1 },
}).single('file');

const uploadEvidenceFile = (req, res, next) =>
  multipart(req, res, e =>
    next(e ? new ApiError(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'Một tệp JPEG/PNG/PDF tối đa 5 MB') : undefined));

export const inspectionRouter = Router();
inspectionRouter.use(authenticate);
inspectionRouter.get('/:id/history', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingHistorySchema), controller.getReceivingHistory);
inspectionRouter.post('/:id/cancel', checkPermission('goods_receipt_inspection:update'), validate(validation.cancelInspectionSchema), controller.cancelInspection);
inspectionRouter.get('/:id/correction-preflight', checkPermission('goods_receipt_inspection:update'), validate(validation.correctionPreflightSchema), controller.getCorrectionPreflight);
inspectionRouter.post('/:id/corrections', checkPermission('goods_receipt_inspection:update'), validate(validation.replaceInspectionSchema), controller.replaceInspection);
inspectionRouter.get('/', checkPermission('goods_receipt_inspection:read'), validate(validation.listInspectionsSchema), controller.listInspections);
inspectionRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getDocumentSchema), controller.getInspection);
inspectionRouter.put('/:id', checkPermission('goods_receipt_inspection:update'), validate(validation.updateInspectionSchema), controller.updateInspection);
inspectionRouter.post('/:id/confirm', checkPermission('goods_receipt_inspection:update'), validate(validation.confirmInspectionSchema), controller.confirmInspection);

export const receiptRouter = Router();
receiptRouter.use(authenticate);
receiptRouter.post('/:id/cancel', checkPermission('goods_receipt_inspection:update'), validate(validation.cancelPurchaseReceiptSchema), controller.cancelPurchaseReceipt);
receiptRouter.patch('/:id/destinations', checkPermission('goods_receipt_inspection:update'), validate(validation.changeReceiptDestinationsSchema), controller.changeReceiptDestinations);
receiptRouter.get(
  '/:id/reversal-preflight',
  checkPermission('goods_receipt_inspection:reverse'),
  checkPermission('goods_receipt_inspection:post'),
  validate(validation.reversalPreflightSchema),
  controller.getPurchaseReversalPreflight,
);
receiptRouter.post(
  '/:id/reverse',
  checkPermission('goods_receipt_inspection:reverse'),
  checkPermission('goods_receipt_inspection:post'),
  validate(validation.reversePurchaseReceiptSchema),
  controller.reversePurchaseReceipt,
);
receiptRouter.get('/', checkPermission('goods_receipt_inspection:read'), validate(validation.listPurchaseReceiptsSchema), controller.listPurchaseReceipts);
receiptRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getDocumentSchema), controller.getPurchaseReceipt);
receiptRouter.post('/:id/post', checkPermission('goods_receipt_inspection:post'), validate(validation.postPurchaseReceiptSchema), controller.postPurchaseReceipt);

export const purchaseReceivingRouter = Router();
purchaseReceivingRouter.use(authenticate);
purchaseReceivingRouter.get('/:id/receiving-operations/:key', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingOperationSchema), controller.getReceivingOperation);
purchaseReceivingRouter.get('/:id/receiving-summary', checkPermission('purchase_order:read'), validate(validation.receivingSummarySchema), controller.getReceivingSummary);
purchaseReceivingRouter.get('/:id/receiving-trips', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingTripsSchema), controller.getReceivingTrips);
purchaseReceivingRouter.get('/:id/inspection-context', checkPermission('goods_receipt_inspection:read'), validate(validation.inspectionContextSchema), controller.getInspectionContext);
purchaseReceivingRouter.post('/:id/inspections', checkPermission('goods_receipt_inspection:create'), validate(validation.createInspectionSchema), controller.createInspection);

export const queueRouter = Router();
queueRouter.use(authenticate);
queueRouter.get('/', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingQueueSchema), controller.getReceivingQueue);

export const purchaseDocumentRouter = Router();
purchaseDocumentRouter.use(authenticate);
purchaseDocumentRouter.get('/:id/history', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingHistorySchema), controller.getReceivingHistory);
// Evidence permissions depend on the resolved parent documentKind/workflowStatus in purchase-evidence.service.js.
purchaseDocumentRouter.get('/:id/evidence', validate(validation.listEvidenceSchema), controller.listEvidence);
purchaseDocumentRouter.post('/:id/evidence/uploads', uploadEvidenceFile, validate(validation.uploadEvidenceSchema), controller.uploadEvidence);
purchaseDocumentRouter.post('/:id/evidence/attach', validate(validation.attachEvidenceSchema), controller.attachEvidence);
purchaseDocumentRouter.get('/:id/evidence/:evidenceId/download', validate(validation.downloadEvidenceSchema), controller.downloadEvidence);

export const reversalRouter = Router();
reversalRouter.use(authenticate);
reversalRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getReversalSchema), controller.getReversal);

export const custodyRouter = Router();
custodyRouter.use(authenticate);
custodyRouter.get('/', checkPermission('goods_receipt_inspection:read'), validate(validation.listCustodyReceiptsSchema), controller.listCustodyReceipts);
custodyRouter.post('/:id/cancel', checkPermission('goods_receipt_inspection:update'), validate(validation.cancelCustodyReceiptSchema), controller.cancelCustodyReceipt);
custodyRouter.get(
  '/:id/reversal-preflight',
  checkPermission('goods_receipt_inspection:reverse'),
  checkPermission('goods_receipt_inspection:post'),
  validate(validation.reversalPreflightSchema),
  controller.getCustodyReversalPreflight,
);
custodyRouter.post(
  '/:id/reverse',
  checkPermission('goods_receipt_inspection:reverse'),
  checkPermission('goods_receipt_inspection:post'),
  validate(validation.reverseCustodyReceiptSchema),
  controller.reverseCustodyReceipt,
);
custodyRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getDocumentSchema), controller.getCustodyReceipt);
custodyRouter.post('/:id/post', checkPermission('goods_receipt_inspection:post'), validate(validation.postCustodyReceiptSchema), controller.postCustodyReceipt);
custodyRouter.post('/:id/reinspections', checkPermission('goods_receipt_inspection:update'), validate(validation.reinspectCustodySchema), controller.reinspectCustody);
custodyRouter.post('/:id/resolution-decisions', checkPermission('purchase_custody:decide'), validate(validation.decideCustodySchema), controller.decideCustody);
custodyRouter.post('/:id/purchase-receipts', checkPermission('purchase_custody:execute'), validate(validation.createCustodyPurchaseReceiptSchema), controller.createCustodyPurchaseReceipt);
custodyRouter.post('/:id/releases', checkPermission('purchase_custody:execute'), validate(validation.createCustodyReleaseSchema), controller.createCustodyRelease);

export const custodyReleaseRouter = Router();
custodyReleaseRouter.use(authenticate);
custodyReleaseRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getDocumentSchema), controller.getCustodyRelease);
custodyReleaseRouter.post('/:id/post', checkPermission('purchase_custody:execute'), validate(validation.postCustodyReleaseSchema), controller.postCustodyRelease);
