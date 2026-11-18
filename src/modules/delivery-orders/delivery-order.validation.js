import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectId } from '../sales-orders/sales.validation.js';

const key = z.string().trim().min(1).max(70);
const version = z.number().int().positive();
export const createDeliveryOrderBody = z.object({ idempotencyKey: key, scheduleId: documentIdentifier, deliveryId: objectId, expectedVersion: version }).strict();
export const confirmDeliveryBody = z.object({ idempotencyKey: key, expectedVersion: version }).strict();
