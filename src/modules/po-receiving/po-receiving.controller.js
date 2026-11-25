import { respondWithData } from '../../shared/utils/catchAsync.js';
import * as reads from './purchase-read.service.js';
import * as evidence from './purchase-evidence.service.js';

// Purchase-order receiving reads
export const getReceivingOperation = respondWithData(req =>
  reads.receivingOperation(req.user, req.validated.params.id, req.validated.params.key));
export const getReceivingSummary = respondWithData(req =>
  reads.receivingSummary(req.user, req.validated.params.id));
export const getReceivingTrips = respondWithData(req =>
  reads.receivingTrips(req.user, req.validated.params.id, req.validated.query));

// Queue
export const getReceivingQueue = respondWithData(req =>
  reads.receivingQueue(req.user, req.validated.query));

// Purchase documents & evidence
export const getReceivingHistory = respondWithData(req =>
  reads.receivingHistory(req.user, req.validated.params.id, req.validated.query));
export const listEvidence = respondWithData(req =>
  evidence.listEvidence(req.user, req.validated.params.id));
export const uploadEvidence = respondWithData(req =>
  evidence.uploadEvidence(req.user, req.validated.params.id, req.file, req.validated.body.lineId));
export const attachEvidence = respondWithData(req =>
  evidence.attachEvidence(req.user, req.validated.params.id, req.validated.body));
export const downloadEvidence = respondWithData(req =>
  evidence.downloadEvidence(req.user, req.validated.params.id, req.validated.params.evidenceId));
