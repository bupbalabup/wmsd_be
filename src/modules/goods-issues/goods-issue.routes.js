import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import { detailParams } from '../sales-orders/sales.validation.js';
import * as schemas from './goods-issue.validation.js';
import * as controller from './goods-issue.controller.js';

const validateIssue = fields => (req, _res, next) => {
  const parsed = {};
  for (const [field, schema] of Object.entries(fields)) {
    const result = schema.safeParse(req[field]);
    if (!result.success) return next(new ApiError(400, 'Thông tin phiếu xuất hoặc bộ lọc không hợp lệ'));
    parsed[field] = result.data;
  }
  req.validated = parsed;
  next();
};
const router = Router();
router.use(authenticate);
const listQuery = validateIssue({ query: schemas.listQuery });
router.get('/direct-options', checkPermission('goods_issue:create'), listQuery, controller.directOptions);
router.get('/options', checkPermission('goods_issue:create'), validateIssue({ query: schemas.optionsQuery }), controller.options);
router.get('/', checkPermission('goods_issue:read'), listQuery, controller.list);
router.post('/', checkPermission('goods_issue:create'), validateIssue({ body: schemas.createBody }), controller.create);
router.get('/:id', checkPermission('goods_issue:read'), validateIssue({ params: detailParams }), controller.detail);
router.put('/:id', checkPermission('goods_issue:update'), validateIssue({ params: detailParams, body: schemas.updateBody }), controller.update);
for (const [path, permission, schema, handler] of [
  ['customer-receipt', 'delivery_confirmation:confirm', schemas.customerReceiptBody, controller.confirmCustomerReceipt],
  ['receive-undelivered', 'failed_delivery:post', schemas.undeliveredBody, controller.receiveUndelivered],
  ['approve', 'goods_issue:approve', schemas.cancelBody.pick({ idempotencyKey: true, expectedVersion: true }).strict(), controller.approve],
  ['picking-tasks', 'picking_task:create', schemas.pickingBody, controller.createPicking],
  ['cancel', 'goods_issue:update', schemas.cancelBody, controller.cancel],
  ['post', 'goods_issue:post', schemas.postBody, controller.post],
]) router.post(`/:id/${path}`, checkPermission(permission), validateIssue({ params: detailParams, body: schema }), handler);
export default router;
