import { respondWithData } from '../../shared/utils/catchAsync.js';
import { cancelDraft } from '../../shared/utils/purchase-core.js';
import * as reads from '../po-receiving/purchase-read.service.js';
import * as reversal from '../stock-reversals/stock-reversal.service.js';
import * as custody from './custody.service.js';

export const listCustodyReceipts = respondWithData(req =>
  reads.listDocuments(req.user, 'CUSTODY_RECEIPT', req.validated.query));
export const getCustodyReceipt = respondWithData(req =>
  reads.getDocument(req.user, req.validated.params.id, 'CUSTODY_RECEIPT'));
export const cancelCustodyReceipt = respondWithData(req =>
  cancelDraft(req.user, req.validated.params.id, 'CUSTODY_RECEIPT', req.validated.body));
export const getCustodyReversalPreflight = respondWithData(req =>
  reversal.reversalPreflight(req.user, req.validated.params.id, 'CUSTODY_RECEIPT'));
export const reverseCustodyReceipt = respondWithData(req =>
  reversal.reverseReceipt(req.user, req.validated.params.id, req.validated.body, 'CUSTODY_RECEIPT'));
export const postCustodyReceipt = respondWithData(req =>
  custody.postCustodyReceipt(req.user, req.validated.params.id, req.validated.body));
export const reinspectCustody = respondWithData(req =>
  custody.reinspectCustody(req.user, req.validated.params.id, req.validated.body));
export const decideCustody = respondWithData(req =>
  custody.decideCustody(req.user, req.validated.params.id, req.validated.body));
export const createCustodyPurchaseReceipt = respondWithData(req =>
  custody.createCustodyResolution(req.user, req.validated.params.id, req.validated.body, 'ACCEPT'));
export const createCustodyRelease = respondWithData(req =>
  custody.createCustodyResolution(req.user, req.validated.params.id, req.validated.body, 'RETURN'));
export const getCustodyRelease = respondWithData(req =>
  reads.getDocument(req.user, req.validated.params.id, 'CUSTODY_RELEASE'));
export const postCustodyRelease = respondWithData(req =>
  custody.postCustodyRelease(req.user, req.validated.params.id, req.validated.body));
