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

export const purchaseReceivingRouter = Router();
purchaseReceivingRouter.use(authenticate);
purchaseReceivingRouter.get('/:id/receiving-operations/:key', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingOperationSchema), controller.getReceivingOperation);
purchaseReceivingRouter.get('/:id/receiving-summary', checkPermission('purchase_order:read'), validate(validation.receivingSummarySchema), controller.getReceivingSummary);
purchaseReceivingRouter.get('/:id/receiving-trips', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingTripsSchema), controller.getReceivingTrips);

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
