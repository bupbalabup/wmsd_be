import { respondWithData } from '../../shared/utils/catchAsync.js';
import * as service from './po-receiving.service.js';
import * as reads from './purchase-read.service.js';
import * as correction from './purchase-correction.service.js';
import * as custody from './purchase-custody.service.js';
import * as evidence from './purchase-evidence.service.js';

// Inspections
export const listInspections = respondWithData(req => reads.listDocuments(req.user, 'INSPECTION', req.validated.query));
export const getInspection = respondWithData(req => reads.getDocument(req.user, req.validated.params.id, 'INSPECTION'));
export const getReceivingHistory = respondWithData(req => reads.receivingHistory(req.user, req.validated.params.id, req.validated.query));
export const updateInspection = respondWithData(req => service.updateInspection(req.user, req.validated.params.id, req.validated.body));
export const confirmInspection = respondWithData(req => service.confirmInspection(req.user, req.validated.params.id, req.validated.body));
export const cancelInspection = respondWithData(req => service.cancelDraft(req.user, req.validated.params.id, 'INSPECTION', req.validated.body));
export const getCorrectionPreflight = respondWithData(req => correction.correctionPreflight(req.user, req.validated.params.id));
export const replaceInspection = respondWithData(req => correction.replaceInspection(req.user, req.validated.params.id, req.validated.body));

// Purchase receipts
export const listPurchaseReceipts = respondWithData(req => reads.listDocuments(req.user, 'GR_PURCHASE', req.validated.query));
export const getPurchaseReceipt = respondWithData(req => reads.getDocument(req.user, req.validated.params.id, 'GR_PURCHASE'));
export const postPurchaseReceipt = respondWithData(req => service.postReceipt(req.user, req.validated.params.id, req.validated.body));
export const cancelPurchaseReceipt = respondWithData(req => service.cancelDraft(req.user, req.validated.params.id, 'GR_PURCHASE', req.validated.body));
export const changeReceiptDestinations = respondWithData(req => service.changeDestinations(req.user, req.validated.params.id, req.validated.body));
export const getPurchaseReversalPreflight = respondWithData(req => correction.reversalPreflight(req.user, req.validated.params.id));
export const reversePurchaseReceipt = respondWithData(req => correction.reverseReceipt(req.user, req.validated.params.id, req.validated.body));

// Purchase-order receiving
export const getReceivingOperation = respondWithData(req => service.receivingOperation(req.user, req.validated.params.id, req.validated.params.key));
export const getReceivingSummary = respondWithData(req => reads.receivingSummary(req.user, req.validated.params.id));
export const getReceivingTrips = respondWithData(req => reads.receivingTrips(req.user, req.validated.params.id, req.validated.query));
export const getInspectionContext = respondWithData(req => service.inspectionContext(req.user, req.validated.params.id));
export const createInspection = respondWithData(req => service.createInspection(req.user, req.validated.params.id, req.validated.body));

// Queue
export const getReceivingQueue = respondWithData(req => reads.receivingQueue(req.user, req.validated.query));

// Purchase documents & evidence
export const listEvidence = respondWithData(req => evidence.listEvidence(req.user, req.validated.params.id));
export const uploadEvidence = respondWithData(req => evidence.uploadEvidence(req.user, req.validated.params.id, req.file, req.validated.body.lineId));
export const attachEvidence = respondWithData(req => evidence.attachEvidence(req.user, req.validated.params.id, req.validated.body));
export const downloadEvidence = respondWithData(req => evidence.downloadEvidence(req.user, req.validated.params.id, req.validated.params.evidenceId));

// Reversals
export const getReversal = respondWithData(req => correction.getReversal(req.user, req.validated.params.id));

// Custody receipts & releases
export const listCustodyReceipts = respondWithData(req => reads.listDocuments(req.user, 'CUSTODY_RECEIPT', req.validated.query));
export const getCustodyReceipt = respondWithData(req => reads.getDocument(req.user, req.validated.params.id, 'CUSTODY_RECEIPT'));
export const cancelCustodyReceipt = respondWithData(req => service.cancelDraft(req.user, req.validated.params.id, 'CUSTODY_RECEIPT', req.validated.body));
export const getCustodyReversalPreflight = respondWithData(req => correction.reversalPreflight(req.user, req.validated.params.id, 'CUSTODY_RECEIPT'));
export const reverseCustodyReceipt = respondWithData(req => correction.reverseReceipt(req.user, req.validated.params.id, req.validated.body, 'CUSTODY_RECEIPT'));
export const postCustodyReceipt = respondWithData(req => service.postCustodyReceipt(req.user, req.validated.params.id, req.validated.body));
export const reinspectCustody = respondWithData(req => custody.reinspectCustody(req.user, req.validated.params.id, req.validated.body));
export const decideCustody = respondWithData(req => custody.decideCustody(req.user, req.validated.params.id, req.validated.body));
export const createCustodyPurchaseReceipt = respondWithData(req => custody.createCustodyResolution(req.user, req.validated.params.id, req.validated.body, 'ACCEPT'));
export const createCustodyRelease = respondWithData(req => custody.createCustodyResolution(req.user, req.validated.params.id, req.validated.body, 'RETURN'));
export const getCustodyRelease = respondWithData(req => reads.getDocument(req.user, req.validated.params.id, 'CUSTODY_RELEASE'));
export const postCustodyRelease = respondWithData(req => custody.postCustodyRelease(req.user, req.validated.params.id, req.validated.body));
