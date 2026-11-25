import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import * as controller from './custody.controller.js';
import * as validation from './custody.validation.js';

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
