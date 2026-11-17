import * as direct from './direct-sales.service.js';
import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import { detailParams } from '../sales-orders/sales.validation.js';
import * as schemas from './goods-issue.validation.js';
import * as service from './goods-issue.service.js';

const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'Thông tin phiếu xuất hoặc bộ lọc không hợp lệ');
  return result.data;
};
const router = Router();
router.use(authenticate);
router.get('/direct-options', checkPermission('goods_issue:create'), catchAsync(async (req, res) => formatApiResponse(res, { data: await direct.options(req.user, parse(schemas.listQuery, req.query)) })));
router.get('/options', checkPermission('goods_issue:create'), catchAsync(async (req, res) => formatApiResponse(res, { data: await service.issueOptions(req.user, parse(schemas.listQuery, req.query)) })));
router.get('/', checkPermission('goods_issue:read'), catchAsync(async (req, res) => formatApiResponse(res, { data: await service.listIssues(req.user, parse(schemas.listQuery, req.query)) })));
router.post('/', checkPermission('goods_issue:create'), catchAsync(async (req, res) => formatApiResponse(res, { statusCode: 201, data: await service.createIssue(req.user, parse(schemas.createBody, req.body)) })));
router.get('/:id', checkPermission('goods_issue:read'), catchAsync(async (req, res) => formatApiResponse(res, { data: await service.getIssue(req.user, parse(detailParams, req.params).id) })));
router.put('/:id', checkPermission('goods_issue:update'), catchAsync(async (req, res) => formatApiResponse(res, { data: await service.updateIssue(req.user, parse(detailParams, req.params).id, parse(schemas.updateBody, req.body)) })));
for (const [path, permission, schema, handler] of [
  ['customer-receipt', 'delivery_confirmation:confirm', schemas.customerReceiptBody, direct.confirmCustomerReceipt],
  ['receive-undelivered', 'failed_delivery:post', schemas.undeliveredBody, direct.receiveUndelivered],
  ['approve', 'goods_issue:approve', schemas.cancelBody.pick({ idempotencyKey: true, expectedVersion: true }).strict(), service.approveIssue],
  ['picking-tasks', 'picking_task:create', schemas.pickingBody, service.createIssuePicking],
  ['cancel', 'goods_issue:update', schemas.cancelBody, service.cancelIssue],
  ['post', 'goods_issue:post', schemas.postBody, service.postIssue],
]) router.post(`/:id/${path}`, checkPermission(permission), catchAsync(async (req, res) => formatApiResponse(res, { data: await handler(req.user, parse(detailParams, req.params).id, parse(schema, req.body)) })));
export default router;
