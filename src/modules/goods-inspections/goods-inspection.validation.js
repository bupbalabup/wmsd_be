import { z } from 'zod';
import { objectIdString as oid } from '../../shared/utils/domain.js';
import {
  empty,
  key,
  ver,
  qty,
  reason,
  commandBody,
  schema,
} from '../../shared/utils/command-validation.js';
import {
  optionalText,
  documentListQuery,
  reversalBody,
  getDocumentSchema,
  receivingHistorySchema,
} from '../../shared/utils/purchase-validation.js';
import { PACKAGING_CONDITIONS } from '../../models/constants.js';

export { getDocumentSchema, receivingHistorySchema };

const iso = z.string().datetime({ offset: true }).refine(
  v => Date.parse(v) <= Date.now(),
  'Thời điểm đến không được ở tương lai',
);

const line = z.object({
  id: oid.optional(),
  poLineId: oid,
  lotId: oid,
  enteredQty: qty,
  enteredUnit: z.string().trim().min(1).max(60).optional(),
  qualityCode: z.enum(['GOOD', 'DAMAGED', 'PENDING', 'BLOCKED']),
  ownershipDecision: z.enum(['ACCEPT', 'CUSTODY', 'REJECT']),
  packagingCondition: z.enum(PACKAGING_CONDITIONS),
  handlingNote: optionalText(2000),
  receivingLocationId: oid.optional(),
}).strict();

const form = {
  expectedPoVersion: ver,
  arrivedAt: iso,
  deliveryReference: optionalText(100),
  deliveredBy: optionalText(160),
  lines: z.array(line).min(1).max(100),
};

export const listInspectionsSchema = schema(empty, empty, documentListQuery(['DRAFT', 'CONFIRMED', 'CANCELLED']));
export const updateInspectionSchema = schema(z.object({ ...form, ...commandBody }).strict());
export const confirmInspectionSchema = schema(z.object({
  ...commandBody,
  expectedPoVersion: ver,
  destinations: z.array(z.object({ inspectionItemId: oid, locationId: oid }).strict()).max(100),
}).strict());
export const cancelInspectionSchema = schema(z.object({ ...commandBody, reason }).strict());
export const correctionPreflightSchema = schema();
export const replaceInspectionSchema = schema(z.object({ ...form, ...reversalBody }).strict());
export const inspectionContextSchema = schema();
export const createInspectionSchema = schema(z.object({ ...form, creationKey: key }).strict());
