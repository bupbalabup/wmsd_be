import { respondWithData } from '../../shared/utils/catchAsync.js';
import * as service from './goods-receipt.service.js';
import * as other from './other-receipt.service.js';

export const listUnified = respondWithData(req => service.listGoodsReceipts(req.user, req.validated.query));
export const getUnified = respondWithData(req => service.getGoodsReceipt(req.user, req.validated.params.id));

export const listTransfer = respondWithData(req => service.listTransferReceipts(req.user, req.validated.query));
export const listByKind = path => respondWithData(req => service.listReceiptsByKind(req.user, path, req.validated.query));
export const getByKind = path => respondWithData(req => service.getReceiptByKind(req.user, path, req.validated.params.id));

export const createOther = respondWithData(req => other.createOtherReceipt(req.user, req.validated.body));
export const updateOther = respondWithData(req => other.updateOtherReceipt(req.user, req.validated.params.id, req.validated.body));
export const submitOther = respondWithData(req => other.submitOtherReceipt(req.user, req.validated.params.id, req.validated.body));
export const approveOther = respondWithData(req => other.approveOtherReceipt(req.user, req.validated.params.id, req.validated.body));
export const postOther = respondWithData(req => other.postOtherReceipt(req.user, req.validated.params.id, req.validated.body));
export const reverseOther = respondWithData(req => other.reverseOtherReceipt(req.user, req.validated.params.id, req.validated.body));
export const cancelOther = respondWithData(req => other.cancelOtherReceipt(req.user, req.validated.params.id, req.validated.body));
export const getOtherReversalPreflight = respondWithData(req => other.otherReversalPreflight(req.user, req.validated.params.id));
