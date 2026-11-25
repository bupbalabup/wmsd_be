import { z } from 'zod';
import { documentIdentifier } from './document-id.validation.js';
import { objectIdString as oid, decimalStringSchema } from './domain.js';

export const empty = z.object({}).strict();
export const key = z.string().trim().min(1).max(160);
export const ver = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const qty = decimalStringSchema({ positive: true });
export const reason = z.string().trim().min(1).max(2000);
export const evidenceIds = z.array(oid).min(1).max(20).refine(a => new Set(a).size === a.length);
export const optionalEvidenceIds = z.array(oid).max(20).refine(a => new Set(a).size === a.length).optional();

const pager = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().safe());
export const pagination = {
  page: pager.default(1),
  limit: pager.pipe(z.number().max(100)).default(10),
};

export const commandBody = { expectedVersion: ver, operationKey: key };

export const schema = (
  body = empty,
  params = z.object({ id: documentIdentifier }).strict(),
  query = empty,
) => z.object({ body, params, query });
