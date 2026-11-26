import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { z } from 'zod';
import { decimalStringSchema } from '../../shared/utils/domain.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i).transform((value) => value.toLowerCase());
export const detailParams = z.object({ id: documentIdentifier }).strict();
export const evidenceParams = z.object({ id: documentIdentifier, evidenceId: objectId }).strict();
const label = (max) => z.string().trim().min(1).max(max);
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/).refine((v) => /[1-9]/.test(v));
export const createOrderBody = z.object({
  idempotencyKey: label(70), customerName: label(160), customerPhone: z.string().trim().max(30).optional(), neededOn: z.iso.datetime({ offset: true }).optional(), deliveryAddress: label(500),
  // 26/11/2026: the request is a copy of the customer's slip. Source document, evidence photo, lot, unit and delivery plan are optional.
  evidenceReceipt: label(4000).optional(), currencyCode: z.string().regex(/^[A-Z]{3}$/).default('VND'),
  source: z.object({ sourceSystem: z.enum(['MISA', 'PAPER']), referenceNo: label(100),
    referenceDate: z.iso.datetime({ offset: true }).optional(), sourceVersion: label(100).optional() }).strict().optional(),
  lines: z.array(z.object({ sourceLineKey: label(100).optional(), productId: objectId, enteredUnit: label(60).optional(), lotId: objectId.optional(), unitSellingPrice: decimalStringSchema(),
    quantity: z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/).refine((v) => /[1-9]/.test(v)),
     }).strict()).min(1).max(200),
  deliveries: z.array(z.object({ plannedOn: z.iso.datetime({ offset: true }), warehouseId: objectId,
    lines: z.array(z.object({ lineKey: label(100), quantity }).strict()).min(1).max(200) }).strict()).min(1).max(50).optional(),
}).strict().refine((v) => { const keys = v.lines.map((line) => line.sourceLineKey).filter(Boolean); return new Set(keys).size === keys.length; }, { message: 'Duplicate source lines' });
const unitQuantity = quantity;
const deliveryPlan = z.object({ id: objectId.optional(), plannedOn: z.iso.datetime({ offset: true }), warehouseId: objectId,
  lines: z.array(z.object({ lineKey: label(100), quantity: unitQuantity }).strict()).min(1).max(200) }).strict();
// `lines`: change an existing line by lineId (quantity, unit, price), remove it, or add a new one (no lineId).
// `deliveries`: the final wanted state of every delivery that can still be edited.
export const updateOrderBody = z.object({
  idempotencyKey: label(70), expectedVersion: z.number().int().positive(), reason: label(2000),
  header: z.object({ customerName: label(160).optional(), customerPhone: z.string().trim().max(30).optional(), deliveryAddress: label(500).optional(), recipientName: label(160).optional(),
    recipientPhone: label(30).optional(), note: label(2000).optional() }).strict().optional(),
  lines: z.array(z.object({ lineId: objectId.optional(), remove: z.boolean().optional(), clientLineKey: label(100).optional(),
    productId: objectId.optional(), lotId: objectId.optional(), enteredUnit: label(60).optional(), quantity: unitQuantity.optional(),
    unitSellingPrice: decimalStringSchema().optional() }).strict()).max(200).optional(),
  deliveries: z.array(deliveryPlan).max(50),
}).strict();
export const cancelOrderBody = z.object({ idempotencyKey: label(70), expectedVersion: z.number().int().positive(), reason: label(2000) }).strict();
export const outboundQuery = z.object({
  q: label(100).optional(),
  warehouseId: objectId.optional(), salesOrderId: documentIdentifier.optional(), issueRequestId: documentIdentifier.optional(),
  status: z.string().regex(/^[A-Z_]{1,30}$/).optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), { message: 'Invalid date range' });

