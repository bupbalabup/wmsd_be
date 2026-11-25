import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectIdString as oid, decimalStringSchema } from '../../shared/utils/domain.js';
import {
  empty,
  key,
  ver,
  qty,
  reason,
  evidenceIds,
  optionalEvidenceIds,
  pagination,
  commandBody,
  schema,
} from '../../shared/utils/command-validation.js';
import { PACKAGING_CONDITIONS } from '../../models/constants.js';

const optionalText = max => z.string().trim().min(1).max(max).optional();
const searchText = optionalText(100);
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

const paged = fields => z.object({ ...pagination, ...fields })
  .strict()
  .refine(q => Number.isSafeInteger((q.page - 1) * q.limit));

const documentListQuery = status => paged({
  purchaseOrderId: documentIdentifier.optional(),
  warehouseId: oid.optional(),
  status: z.enum(status).optional(),
});

const reversalBody = { ...commandBody, reason, evidenceIds: optionalEvidenceIds };

const portion = z.object({
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

const packaging = z.array(
  z.object({ lineId: oid, portions: z.array(portion).min(1).max(100) }).strict(),
).max(100).optional();

const custodyLines = shape => z.array(z.object(shape).strict())
  .min(1)
  .max(100)
  .refine(rows => new Set(rows.map(r => r.custodyItemId)).size === rows.length, 'Trùng dòng giữ hộ');

// Shared / inspection schemas
export const getDocumentSchema = schema();
export const receivingHistorySchema = schema(empty, undefined, paged({}));
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

// Purchase receipt schemas
export const listPurchaseReceiptsSchema = schema(empty, empty, documentListQuery(['DRAFT', 'POSTED', 'REVERSED', 'CANCELLED']));
export const cancelPurchaseReceiptSchema = schema(z.object({ ...commandBody, expectedPoVersion: ver, reason }).strict());
export const changeReceiptDestinationsSchema = schema(z.object({
  ...commandBody,
  reason,
  lines: z.array(z.object({ lineId: oid, receivingLocationId: oid }).strict()).min(1).max(100),
}).strict());
export const reversalPreflightSchema = schema();
export const reversePurchaseReceiptSchema = schema(z.object({ ...reversalBody, expectedPoVersion: ver }).strict());
export const postPurchaseReceiptSchema = schema(z.object({ ...commandBody, expectedPoVersion: ver, packaging }).strict());

// Purchase-order receiving schemas
export const receivingOperationSchema = schema(empty, z.object({ id: documentIdentifier, key }).strict());
export const receivingSummarySchema = schema();
export const receivingTripsSchema = schema(empty, undefined, paged({ status: z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED']).optional() }));
export const inspectionContextSchema = schema();
export const createInspectionSchema = schema(z.object({ ...form, creationKey: key }).strict());

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

// Reversal schemas
export const getReversalSchema = schema();

// Custody receipt & release schemas
export const listCustodyReceiptsSchema = schema(empty, empty, documentListQuery(['DRAFT', 'POSTED', 'CLOSED', 'CANCELLED', 'REVERSED']));
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
