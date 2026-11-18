import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import { detailParams, outboundQuery } from '../sales-orders/sales.validation.js';
import { createDeliveryOrderBody, confirmDeliveryBody } from './delivery-order.validation.js';
import * as service from './delivery-order.service.js';

const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'Dữ liệu hoặc bộ lọc không hợp lệ');
  return result.data;
};

export const deliveryScheduleRouter = Router();
deliveryScheduleRouter.use(authenticate);
deliveryScheduleRouter.get('/', checkPermission('delivery_schedule:read'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await service.listDeliverySchedules(req.user, parse(outboundQuery, req.query)) });
}));

export const deliveryOrderRouter = Router();
deliveryOrderRouter.use(authenticate);
deliveryOrderRouter.post('/', checkPermission('delivery_order:create'), catchAsync(async (req, res) => {
  const data = await service.createDeliveryOrder(req.user, parse(createDeliveryOrderBody, req.body));
  formatApiResponse(res, { statusCode: data.replayed ? 200 : 201, data });
}));
deliveryOrderRouter.get('/', checkPermission('delivery_order:read'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await service.listDeliveryOrders(req.user, parse(outboundQuery, req.query)) });
}));
deliveryOrderRouter.get('/:id', checkPermission('delivery_order:read'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await service.getDeliveryOrder(req.user, parse(detailParams, req.params).id) });
}));
deliveryOrderRouter.post('/:id/confirm-issue', checkPermission('delivery_order:confirm_issue'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await service.confirmIssue(req.user, parse(detailParams, req.params).id, parse(confirmDeliveryBody, req.body)) });
}));
deliveryOrderRouter.post('/:id/confirm-handover', checkPermission('delivery_order:confirm_handover'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await service.confirmHandover(req.user, parse(detailParams, req.params).id, parse(confirmDeliveryBody, req.body)) });
}));
