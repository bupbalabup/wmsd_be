import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { z } from 'zod';
import { decimalStringSchema } from '../../shared/utils/domain.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i).transform((value) => value.toLowerCase());
export const detailParams = z.object({ id: documentIdentifier }).strict();
const label = (max) => z.string().trim().min(1).max(max);
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/).refine((v) => /[1-9]/.test(v));
export const createOrderBody = z.object({
  idempotencyKey: label(70), customerId: objectId, deliveryAddress: label(500),
  recipientName: label(160).optional(), recipientPhone: label(30).optional(), note: label(2000).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).default('VND'), orderAmount: decimalStringSchema({ label: 'Tổng tiền' }),
  lines: z.array(z.object({ clientLineKey: label(100), productId: objectId, lotId: objectId, enteredUnit: label(60),
    quantity, unitSellingPrice: decimalStringSchema().optional() }).strict()).min(1).max(200),
  deliveries: z.array(z.object({ plannedOn: z.iso.datetime({ offset: true }), warehouseId: objectId,
    lines: z.array(z.object({ lineKey: label(100), quantity }).strict()).min(1).max(200) }).strict()).min(1).max(50),
}).strict().refine((v) => new Set(v.lines.map((line) => line.clientLineKey)).size === v.lines.length, { message: 'Duplicate order lines' });
export const outboundQuery = z.object({
  q: label(100).optional(),
  warehouseId: objectId.optional(), salesOrderId: documentIdentifier.optional(), issueRequestId: documentIdentifier.optional(),
  status: z.string().regex(/^[A-Z_]{1,30}$/).optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), { message: 'Invalid date range' });

