import { z } from 'zod';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectIdString, decimalStringSchema } from '../../shared/utils/domain.js';
import { empty } from '../../shared/utils/command-validation.js';

const text = max => z.string().trim().min(1).max(max);
const optional = max => z.string().trim().max(max).optional();
const quantity = decimalStringSchema({ positive: true, scale: 6 });
export const openingRow = z.object({
  sku: text(60), manufacturerCode: text(100), color: text(160),
  name: optional(200), categoryCode: optional(60), baseUnit: optional(60),
  lengthMm: optional(30), widthMm: optional(30), heightMm: optional(30),
  manufacturerLot: text(100), tone: optional(20), calibre: optional(20), piecesPerCarton: optional(20),
  cartonLengthMm: optional(30), cartonWidthMm: optional(30), cartonHeightMm: optional(30),
  enteredQty: quantity,
}).strict();
export const previewBody = z.object({
  warehouseId: objectIdString, openingAt: z.iso.datetime({ offset: true }),
  cutoverKey: text(160), sourceDescription: text(2000),
  confirmEmpty: z.boolean().default(false), rows: z.array(openingRow).max(1000),
}).strict().refine(v => v.rows.length > 0 || v.confirmEmpty, { message: 'Xác nhận kho trống hoặc nhập ít nhất một dòng hàng.' });
export const createBody = previewBody.safeExtend({ idempotencyKey: text(64) });
export const actionBody = z.object({ idempotencyKey: text(64), expectedVersion: z.number().int().min(1), reason: text(2000) }).strict();
export const getOpeningStockSchema = z.object({
  params: z.object({ id: documentIdentifier }).strict(),
  query: empty,
  body: empty,
});
export const openingIdParamsSchema = z.object({
  params: z.object({ id: documentIdentifier }).strict(),
  query: empty,
});
