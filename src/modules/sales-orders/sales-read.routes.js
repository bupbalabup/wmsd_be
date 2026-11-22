import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import { detailParams, outboundQuery, createOrderBody, updateOrderBody, cancelOrderBody } from './sales.validation.js';
import { createSalesOrder } from './sales-create.service.js';
import { updateSalesOrderSchedule, cancelSalesOrder } from './sales-schedule.service.js';
import * as service from './sales-read.service.js';
import * as execution from './sales-execution.service.js';

const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'ID hoặc bộ lọc không hợp lệ');
  return result.data;
};

export const salesOrderRouter = Router();
salesOrderRouter.use(authenticate);
salesOrderRouter.get('/options', catchAsync(async (req, res) => formatApiResponse(res, { data: await execution.salesOptions(req.user) })));
salesOrderRouter.get('/', checkPermission('sales_order:read'), catchAsync(async (req, res) => formatApiResponse(res, { data: await execution.listSalesOrders(req.user, parse(outboundQuery, req.query)) })));
salesOrderRouter.post('/', checkPermission('sales_order:create'), catchAsync(async (req, res) => {
  const data = await createSalesOrder(req.user, parse(createOrderBody, req.body));
  formatApiResponse(res, { statusCode: data.replayed ? 200 : 201, data });
}));
salesOrderRouter.put('/:id', checkPermission('sales_order:update'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await updateSalesOrderSchedule(req.user, parse(detailParams, req.params).id, parse(updateOrderBody, req.body)) });
}));
salesOrderRouter.post('/:id/cancel', checkPermission('sales_order:cancel'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await cancelSalesOrder(req.user, parse(detailParams, req.params).id, parse(cancelOrderBody, req.body)) });
}));
salesOrderRouter.get('/:id', checkPermission('sales_order:read'), catchAsync(async (req, res) => {
  formatApiResponse(res, { data: await service.getSalesOrder(req.user, parse(detailParams, req.params).id) });
}));