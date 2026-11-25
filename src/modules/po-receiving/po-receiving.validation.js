import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectIdString as oid } from '../../shared/utils/domain.js';
import { empty, key, commandBody, schema } from '../../shared/utils/command-validation.js';
import { optionalText, paged, receivingHistorySchema } from '../../shared/utils/purchase-validation.js';

export { receivingHistorySchema };

const searchText = optionalText(100);

// Purchase-order receiving read schemas
export const receivingOperationSchema = schema(empty, z.object({ id: documentIdentifier, key }).strict());
export const receivingSummarySchema = schema();
export const receivingTripsSchema = schema(empty, undefined, paged({ status: z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED']).optional() }));

// Queue schemas
export const receivingQueueSchema = schema(empty, empty, paged({
  q: searchText,
  warehouseId: oid.optional(),
  purchaseOrderId: documentIdentifier.optional(),
  stage: z.enum(['DRAFT_INSPECTION', 'AWAITING_POST', 'CORRECTION']),
}));

// Purchase document & evidence schemas
export const listEvidenceSchema = schema();
export const uploadEvidenceSchema = schema(z.object({ lineId: oid.optional() }).strict());
export const attachEvidenceSchema = schema(z.object({ ...commandBody, attachmentId: oid }).strict());
export const downloadEvidenceSchema = schema(empty, z.object({ id: documentIdentifier, evidenceId: oid }).strict());
