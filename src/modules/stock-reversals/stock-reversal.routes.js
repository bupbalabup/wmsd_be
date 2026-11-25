import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import * as controller from './stock-reversal.controller.js';
import * as validation from './stock-reversal.validation.js';

export const reversalRouter = Router();
reversalRouter.use(authenticate);
reversalRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getReversalSchema), controller.getReversal);
