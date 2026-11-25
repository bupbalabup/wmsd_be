import { z } from 'zod';
import { documentIdentifier } from './document-id.validation.js';
import { objectIdString as oid, decimalStringSchema } from './domain.js';
import {
  empty,
  qty,
  reason,
  optionalEvidenceIds,
  pagination,
  commandBody,
  schema,
} from './command-validation.js';

export const optionalText = max => z.string().trim().min(1).max(max).optional();

export const paged = fields => z.object({ ...pagination, ...fields })
  .strict()
  .refine(q => Number.isSafeInteger((q.page - 1) * q.limit));

export const documentListQuery = status => paged({
  purchaseOrderId: documentIdentifier.optional(),
  warehouseId: oid.optional(),
  status: z.enum(status).optional(),
});

export const reversalBody = { ...commandBody, reason, evidenceIds: optionalEvidenceIds };

export const portion = z.object({
  packagingState: z.enum(['SEALED', 'OPEN', 'LOOSE']),
  sealedPackCount: z.number().int().nonnegative().optional(),
  quantityBase: qty,
  measuredVolumeMm3: qty.optional(),
  extraOccupiedVolumeMm3: decimalStringSchema().optional(),
  packagingSnapshot: z.object({
    packageUnit: z.string().min(1).max(60),
    baseUnitsPerPackage: qty,
    outerLengthMm: decimalStringSchema({ positive: true, scale: 3 }),
    outerWidthMm: decimalStringSchema({ positive: true, scale: 3 }),
    outerHeightMm: decimalStringSchema({ positive: true, scale: 3 }),
  }).strict().optional(),
}).strict();

export const packaging = z.array(
  z.object({ lineId: oid, portions: z.array(portion).min(1).max(100) }).strict(),
).max(100).optional();

export const getDocumentSchema = schema();
export const receivingHistorySchema = schema(empty, undefined, paged({}));
export const reversalPreflightSchema = schema();
