import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectId } from '../sales-orders/sales.validation.js';

const key = z.string().trim().min(1).max(70);
const version = z.number().int().positive();
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/).refine((v) => /[1-9]/.test(v));

export const createDeliveryOrderBody = z.object({ idempotencyKey: key, scheduleId: documentIdentifier, deliveryId: objectId, expectedVersion: version }).strict();
export const confirmDeliveryBody = z.object({ idempotencyKey: key, expectedVersion: version }).strict();
export const lineParams = z.object({ id: documentIdentifier, lineId: objectId }).strict();
export const alternativesQuery = z.object({ shortQty: quantity.optional() }).strict();
export const reportIssueBody = z.object({
  idempotencyKey: key,
  expectedVersion: version,
  lineId: objectId,
  kind: z.enum(['SHORTAGE', 'DAMAGED']),
  shortQty: quantity,
  reason: z.string().trim().min(1).max(2000),
  picks: z.array(z.object({ balanceId: objectId, qty: quantity }).strict()).max(100).default([]),
}).strict().refine(
  v => new Set(v.picks.map(p => p.balanceId)).size === v.picks.length,
  { message: 'Vị trí lấy bù bị lặp' },
);