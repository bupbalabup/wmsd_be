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
export const createBody = z.union([manualCreateBody, legacyCreateBody]);
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
