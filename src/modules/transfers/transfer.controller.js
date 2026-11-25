import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import * as validation from './transfer.validation.js';
import * as service from './transfer.service.js';

export const listTransfers = catchAsync(async (req, res) => {
  const parsed = validation.listQuery.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'Bộ lọc điều chuyển không hợp lệ');
  formatApiResponse(res, { data: await service.listTransfers(req.user, parsed.data) });
});

export const transferOptions = catchAsync(async (req,res) => {
  const parsed=validation.optionsQuery.safeParse(req.query);
  if(!parsed.success)throw new ApiError(400,'Bộ lọc lựa chọn điều chuyển không hợp lệ');
  formatApiResponse(res,{data:await service.transferOptions(req.user,parsed.data.warehouseId,parsed.data.mode)});
});

export const pickAssignees = catchAsync(async (req,res) => {
  const parsed=validation.optionsQuery.pick({warehouseId:true}).required().safeParse(req.query);
  if(!parsed.success)throw new ApiError(400,'Chọn kho để lấy danh sách người thực hiện');
  formatApiResponse(res,{data:await service.pickAssignees(req.user,parsed.data.warehouseId)});
});

export const listDispatches = catchAsync(async (req, res) => {
  const parsed = validation.dispatchListQuery.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'Bộ lọc phiếu xuất điều chuyển không hợp lệ');
  formatApiResponse(res, { data: await service.listDispatches(req.user, parsed.data) });
});

export const getDispatch = catchAsync(async (req, res) => {
  const parsed = validation.detailParams.safeParse(req.params);
  if (!parsed.success) throw new ApiError(400, 'Mã phiếu xuất điều chuyển không hợp lệ');
  formatApiResponse(res, { data: await service.getDispatch(req.user, parsed.data.id) });
});

export const getPutawayTask = catchAsync(async(req,res)=>{
  const parsed=validation.detailParams.safeParse(req.params);
  if(!parsed.success)throw new ApiError(400,'Mã nhiệm vụ điều chuyển không hợp lệ');
  formatApiResponse(res,{data:await service.getPutawayTask(req.user,parsed.data.id)});
});

export const getTransfer = catchAsync(async (req, res) => {
  const parsed = validation.detailParams.safeParse(req.params);
  if (!parsed.success) throw new ApiError(400, 'Mã điều chuyển không hợp lệ');
  formatApiResponse(res, { data: await service.getTransfer(req.user, parsed.data.id) });
});

const handle = (schema, action, hasId = true) => catchAsync(async (req, res) => {
  const parsed = schema.safeParse(req.body);
  const parameter = hasId ? validation.detailParams.safeParse(req.params) : null;
  if (!parsed.success || (parameter && !parameter.success)) throw new ApiError(400, 'Dữ liệu chuyển kho không hợp lệ');
  const result = hasId ? await action(req.user, parameter.data.id, parsed.data) : await action(req.user, parsed.data);
  formatApiResponse(res, { data: result });
});

export const createRequest = handle(validation.createRequestBody, service.createRequest, false);
export const updateRequest = handle(validation.updateRequestBody, service.updateRequest);
export const reviewRequest = handle(validation.reviewBody, service.reviewRequest);
export const createDispatch = handle(validation.dispatchBody, service.createDispatch);
export const createRequirement = handle(validation.requirementBody, service.createRequirement);
export const confirmTask = handle(validation.taskConfirmBody, service.confirmTask);
export const cancelDraftDispatch = handle(validation.cancelDispatchBody, service.cancelDraftDispatch);
export const receiveTransfer = handle(validation.receiptBody, service.receiveTransfer);
export const proposeDifference = handle(validation.differenceProposalBody, service.proposeDifference);
export const reviewDifference = handle(validation.differenceReviewBody, service.reviewDifference);
export const closeRequest = handle(validation.commandBody, service.closeRequest);
export const closePartialRequest = handle(validation.partialCloseBody, service.closePartialRequest);
export const cancelRequest = handle(validation.cancelRequestBody, service.cancelRequest);
