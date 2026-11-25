import { z } from 'zod';
import { objectIdString as oid } from '../../shared/utils/domain.js';
import {
  empty,
  ver,
  qty,
  reason,
  evidenceIds,
  commandBody,
  schema,
} from '../../shared/utils/command-validation.js';
import {
  documentListQuery,
  reversalBody,
  packaging,
  getDocumentSchema,
  reversalPreflightSchema,
} from '../../shared/utils/purchase-validation.js';

export { getDocumentSchema, reversalPreflightSchema };

const custodyLines = shape => z.array(z.object(shape).strict())
  .min(1)
  .max(100)
  .refine(rows => new Set(rows.map(r => r.custodyItemId)).size === rows.length, 'Trùng dòng giữ hộ');

export const listCustodyReceiptsSchema = schema(
  empty,
  empty,
  documentListQuery(['DRAFT', 'POSTED', 'CLOSED', 'CANCELLED', 'REVERSED']),
);
export const cancelCustodyReceiptSchema = schema(z.object({ ...commandBody, reason }).strict());
export const reverseCustodyReceiptSchema = schema(z.object(reversalBody).strict());
export const postCustodyReceiptSchema = schema(z.object({
  ...commandBody,
  handedOverBy: z.string().trim().max(160).nullish(),
  destinations: z.array(z.object({ lineId: oid, locationId: oid }).strict()).min(1).max(100),
  packaging,
}).strict());
export const reinspectCustodySchema = schema(z.object({
  ...commandBody,
  reason,
  evidenceIds,
  lines: custodyLines({
    custodyItemId: oid,
    qtyBase: qty,
    qualityCode: z.enum(['GOOD', 'DAMAGED', 'PENDING', 'BLOCKED']),
  }),
}).strict());
export const decideCustodySchema = schema(z.object({
  ...commandBody,
  reason,
  evidenceIds,
  decision: z.enum(['ACCEPT', 'RETURN']),
  lines: custodyLines({
    custodyItemId: oid,
    qtyBase: qty,
    reinspectionId: oid.optional(),
  }),
}).strict());
export const createCustodyPurchaseReceiptSchema = schema(z.object({
  ...commandBody,
  decisionId: oid,
  expectedPoVersion: ver,
  lines: custodyLines({
    custodyItemId: oid,
    qtyBase: qty,
    destinationLocationId: oid,
  }),
}).strict());
export const createCustodyReleaseSchema = schema(z.object({
  ...commandBody,
  decisionId: oid,
  lines: custodyLines({
    custodyItemId: oid,
    qtyBase: qty,
  }),
}).strict());
export const postCustodyReleaseSchema = schema(z.object({
  ...commandBody,
  recipientName: reason,
}).strict());
