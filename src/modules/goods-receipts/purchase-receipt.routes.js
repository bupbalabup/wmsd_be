import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import * as controller from './purchase-receipt.controller.js';
import * as validation from './purchase-receipt.validation.js';

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
