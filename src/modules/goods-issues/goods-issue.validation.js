import { portions } from '../return-workflows/native.validation.js';
import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectId, outboundQuery } from '../sales-orders/sales.validation.js';
import { operation } from '../sales-orders/sales-execution.validation.js';
import { decimalStringSchema } from '../../shared/utils/domain.js';

const qty = decimalStringSchema({ positive: true });
const note = z.string().trim().max(2000);
const rows = (schema, key) => z.array(schema.strict()).min(1).max(100)
  .refine(lines => new Set(lines.map(line => line[key])).size === lines.length, 'Duplicate source lines');
export const listQuery = outboundQuery.safeExtend({ deliveryOrderId: documentIdentifier.optional(), sourceRequest: z.string().trim().min(1).max(100).optional() });
const legacyCreateBody = operation.extend({ deliveryOrderId: documentIdentifier, note: note.optional(),
  lines: rows(z.object({ reservationId: objectId, qtyBase: qty }), 'reservationId'),
}).strict();
export const manualCreateBody = operation.extend({ expectedVersion: z.literal(1), issueKind: z.enum(['SALE', 'OTHER']), warehouseId: objectId,
  referenceNo: z.string().trim().min(1).max(160), reasonText: z.string().trim().min(1).max(500).optional(), note: note.optional(),
  lines: rows(z.object({ productId: objectId, qtyBase: qty.optional(), quantity: qty.optional(), conversionId: objectId.optional(), note: note.optional() }).refine(v => (!!v.qtyBase !== !!v.quantity) && (!v.conversionId || !!v.quantity), 'Supply a base quantity or entered quantity with its conversion'), 'productId'),
}).strict().refine(v => v.issueKind !== 'OTHER' || !!v.reasonText, 'Specify the other issue reason');
export const directCreateBody = operation.extend({ salesOrderId: documentIdentifier, warehouseId: objectId, note: note.optional(), lines: z.array(z.object({ salesOrderLineId: objectId, sourceBalanceId: objectId, qtyBase: qty }).strict()).min(1).max(100).refine(lines => new Set(lines.map(r => r.salesOrderLineId + ':' + r.sourceBalanceId)).size === lines.length) }).strict();
export const createBody = z.union([directCreateBody, manualCreateBody.refine(v => v.issueKind === 'OTHER', 'Xuất bán phải chọn đơn bán'), legacyCreateBody]);
const evidenceIds = z.array(objectId).min(1).max(20);
export const customerReceiptBody = operation.extend({ recipientName: z.string().trim().min(1).max(160), receivedAt: z.iso.datetime(), evidenceIds, lines: rows(z.object({ lineId: objectId, qtyBase: qty }), 'lineId') }).strict();
export const undeliveredBody = operation.extend({ reason: note.min(1), evidenceIds, lines: rows(z.object({ lineId: objectId, qtyBase: qty, locationId: objectId, qualityCode: z.enum(['GOOD', 'DAMAGED', 'BLOCKED']), portions }), 'lineId') }).strict();
export const updateBody = operation.extend({ note: note.optional(),
  lines: rows(z.object({ lineId: objectId, qtyBase: qty }), 'lineId'),
}).strict();
export const pickingBody = operation.extend({
  destinations: rows(z.object({ lineId: objectId, locationId: objectId }), 'lineId').optional(),
  allocations: z.array(z.object({ lineId: objectId, sourceBalanceId: objectId, locationId: objectId, qtyBase: qty }).strict()).min(1).max(200).optional(),
}).strict().refine(v => !!v.destinations !== !!v.allocations, 'Choose destinations or explicit allocations');
export const cancelBody = operation.extend({ reason: note.min(1) }).strict();
export const postBody = operation.extend({ recipientName: z.string().trim().min(1).max(160),
  vehiclePlate: z.string().trim().min(1).max(20).optional(),
}).strict();
