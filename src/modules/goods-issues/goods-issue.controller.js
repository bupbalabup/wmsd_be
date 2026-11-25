import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { confirmPicking } from '../sales-orders/sales-execution.service.js';
import * as direct from './direct-sales.service.js';
import * as service from './goods-issue.service.js';

const respond = (action, statusCode = 200) => catchAsync(async (req, res) => {
  formatApiResponse(res, { statusCode, data: await action(req.user, req.validated) });
});
const command = action => respond((user, { params, body }) => action(user, params.id, body));

export const directOptions = respond((user, { query }) => direct.options(user, query));
export const options = respond((user, { query }) => service.issueOptions(user, query));
export const list = respond((user, { query }) => service.listIssues(user, query));
export const create = respond((user, { body }) => service.createIssue(user, body), 201);
export const detail = respond((user, { params }) => service.getIssue(user, params.id));
export const update = command(service.updateIssue);
export const confirmCustomerReceipt = command(direct.confirmCustomerReceipt);
export const receiveUndelivered = command(direct.receiveUndelivered);
export const approve = command(service.approveIssue);
export const createPicking = command(service.createIssuePicking);
export const confirmIssuePicking = command(confirmPicking);
export const cancel = command(service.cancelIssue);
export const post = command(service.postIssue);
