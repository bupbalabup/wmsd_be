import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import {
  empty,
  schema,
  pagination,
  ver,
  key,
  qty,
  reason,
  optionalEvidenceIds,
} from '../../shared/utils/command-validation.js';
import { GOODS_RECEIPT_KINDS } from '../../models/goods-receipt.model.js';
import { validDateRange } from '../../shared/utils/movement-list.js';

const hexId = z.string().regex(/^[a-f\d]{24}$/i);

const query = z.object({
  ...pagination,
  warehouseId: hexId.optional(),
  status: z.string().max(40).optional(),
}).strict();

const unifiedQuery = query.extend({
  kind: z.enum(GOODS_RECEIPT_KINDS).optional(),
  purchaseOrderId: documentIdentifier.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).refine(validDateRange);

const otherCommand = { expectedVersion: ver, operationKey: key };
const otherLine = z.object({
  productId: hexId,
  lotId: hexId,
  enteredUnit: z.string().min(1).max(60),
  enteredQty: qty,
  destinationLocationId: hexId,
  qualityCode: z.enum(['GOOD', 'DAMAGED', 'PENDING', 'BLOCKED']),
}).strict();

const otherPackaging = z.array(
  z.object({
    lineId: hexId,
    portions: z.array(
      z.object({
        packagingState: z.enum(['SEALED', 'OPEN', 'LOOSE']),
        quantityBase: qty,
        sealedPackCount: z.number().int().nonnegative().optional(),
        measuredVolumeMm3: qty.optional(),
        extraOccupiedVolumeMm3: qty.optional(),
        packagingSnapshot: z.object({
          packageUnit: z.string().min(1).max(60),
          baseUnitsPerPackage: qty,
          outerLengthMm: qty,
          outerWidthMm: qty,
          outerHeightMm: qty,
        }).strict().optional(),
      }).strict(),
    ).min(1).max(100),
  }).strict(),
).max(100).optional();

export const listKindReceiptsSchema = schema(empty, empty, query);
export const getKindReceiptSchema = schema();
export const listUnifiedReceiptsSchema = schema(empty, empty, unifiedQuery);
export const getUnifiedReceiptSchema = schema();

export const createOtherReceiptSchema = schema(
  z.object({
    operationKey: key,
    warehouseId: hexId,
    reason,
    note: z.string().max(2000).optional(),
    lines: z.array(otherLine).min(1).max(100),
  }).strict(),
  empty,
);

export const updateOtherReceiptSchema = schema(
  z.object({
    ...otherCommand,
    reason,
    note: z.string().max(2000).optional(),
    lines: z.array(otherLine).min(1).max(100),
  }).strict(),
);

export const submitOtherReceiptSchema = schema(z.object(otherCommand).strict());
export const approveOtherReceiptSchema = schema(
  z.object({ ...otherCommand, decision: z.enum(['APPROVE', 'REJECT']), reason }).strict(),
);
export const postOtherReceiptSchema = schema(
  z.object({ ...otherCommand, packaging: otherPackaging }).strict(),
);
export const reverseOtherReceiptSchema = schema(
  z.object({ ...otherCommand, reason, evidenceIds: optionalEvidenceIds }).strict(),
);
export const cancelOtherReceiptSchema = schema(
  z.object({ ...otherCommand, reason }).strict(),
);
export const otherReversalPreflightSchema = schema();
