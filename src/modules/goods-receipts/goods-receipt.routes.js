import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import { receiptRouter as purchaseRouter } from '../po-receiving/po-receiving.routes.js';
import { RECEIPT_KINDS } from './goods-receipt.service.js';
import * as controller from './goods-receipt.controller.js';
import * as validation from './goods-receipt.validation.js';

const router = Router();
router.use(authenticate);

for (const { path, permission } of RECEIPT_KINDS) {
  if (path === 'purchase') {
    router.use('/purchase', purchaseRouter);
    continue;
  }

  const scoped = Router();
  if (path === 'other') {
    scoped.post('/', checkPermission('goods_receipt_other:create'), validate(validation.createOtherReceiptSchema), controller.createOther);
    scoped.put('/:id', checkPermission('goods_receipt_other:create'), validate(validation.updateOtherReceiptSchema), controller.updateOther);
    scoped.post('/:id/submit', checkPermission('goods_receipt_other:create'), validate(validation.submitOtherReceiptSchema), controller.submitOther);
    scoped.post('/:id/approve', checkPermission('goods_receipt_other:approve'), validate(validation.approveOtherReceiptSchema), controller.approveOther);
    scoped.post('/:id/post', checkPermission('goods_receipt_other:post'), validate(validation.postOtherReceiptSchema), controller.postOther);
    scoped.post('/:id/reverse', checkPermission('goods_receipt_other:reverse'), validate(validation.reverseOtherReceiptSchema), controller.reverseOther);
    scoped.post('/:id/cancel', checkPermission('goods_receipt_other:create'), validate(validation.cancelOtherReceiptSchema), controller.cancelOther);
    scoped.get(
      '/:id/reversal-preflight',
      checkPermission('goods_receipt_other:read'),
      checkPermission('goods_receipt_other:reverse'),
      validate(validation.otherReversalPreflightSchema),
      controller.getOtherReversalPreflight,
    );
  }

  scoped.get(
    '/',
    checkPermission(permission),
    validate(validation.listKindReceiptsSchema),
    path === 'transfer' ? controller.listTransfer : controller.listByKind(path),
  );
  scoped.get(
    '/:id',
    checkPermission(permission),
    validate(validation.getKindReceiptSchema),
    controller.getByKind(path),
  );
  router.use(`/${path}`, scoped);
}

// Unified read routes enforce per-kind permissions dynamically in goods-receipt.service.js.
router.get('/', validate(validation.listUnifiedReceiptsSchema), controller.listUnified);
router.get('/:id', validate(validation.getUnifiedReceiptSchema), controller.getUnified);

export default router;
