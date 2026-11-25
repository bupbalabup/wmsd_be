import { respondWithData } from '../../shared/utils/catchAsync.js';
import { cancelDraft } from '../../shared/utils/purchase-core.js';
import * as reads from '../po-receiving/purchase-read.service.js';
import * as service from './goods-inspection.service.js';
import * as correction from './goods-inspection.correction.js';

export const listInspections = respondWithData(req =>
  reads.listDocuments(req.user, 'INSPECTION', req.validated.query));
export const getInspection = respondWithData(req =>
  reads.getDocument(req.user, req.validated.params.id, 'INSPECTION'));
export const getReceivingHistory = respondWithData(req =>
  reads.receivingHistory(req.user, req.validated.params.id, req.validated.query));
export const updateInspection = respondWithData(req =>
  service.updateInspection(req.user, req.validated.params.id, req.validated.body));
export const confirmInspection = respondWithData(req =>
  service.confirmInspection(req.user, req.validated.params.id, req.validated.body));
export const cancelInspection = respondWithData(req =>
  cancelDraft(req.user, req.validated.params.id, 'INSPECTION', req.validated.body));
export const getCorrectionPreflight = respondWithData(req =>
  correction.correctionPreflight(req.user, req.validated.params.id));
export const replaceInspection = respondWithData(req =>
  correction.replaceInspection(req.user, req.validated.params.id, req.validated.body));
export const getInspectionContext = respondWithData(req =>
  service.inspectionContext(req.user, req.validated.params.id));
export const createInspection = respondWithData(req =>
  service.createInspection(req.user, req.validated.params.id, req.validated.body));
