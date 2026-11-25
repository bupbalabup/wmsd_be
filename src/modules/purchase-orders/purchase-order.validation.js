import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { z } from "zod";
import {
  calendarDateString,
  decimalStringSchema,
  objectIdString,
} from "../../shared/utils/domain.js";
import {
  commandBody,
  empty,
  key,
  optionalEvidenceIds,
  qty,
  reason,
  schema,
} from "../../shared/utils/command-validation.js";

const positiveInteger = (fallback, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^[1-9]\d*$/, "Phải là số nguyên dương")
    .transform(Number)
    .pipe(z.number().int().min(1).max(max))
    .default(fallback);

export const getPurchaseOrderSchema = z.object({
  params: z.object({ id: documentIdentifier }).strict(),
  body: z.object({}).strict(),
  query: z.object({}).strict(),
});

export const purchaseOrderSupplierOptionsSchema = z.object({
  params: z.object({}).strict(),
  body: z.object({}).strict(),
  query: z.object({ warehouseId: objectIdString.optional() }).strict(),
});

export const listPurchaseOrdersSchema = z.object({
  params: z.object({}).strict(),
  body: z.object({}).strict(),
  query: z
    .object({
      page: positiveInteger(1),
      limit: positiveInteger(10, 100),
      search: z.string().trim().max(100).optional(),
      supplierId: objectIdString.optional(),
      warehouseId: objectIdString.optional(),
      status: z.string().trim().min(1).max(30).optional(),
      createdFrom: calendarDateString.optional(),
      createdTo: calendarDateString.optional(),
      outstanding: z.enum(["YES", "NO", "UNKNOWN"]).optional(),
    })
    .strict()
    .superRefine((query, ctx) => {
      if (
        query.createdFrom &&
        query.createdTo &&
        query.createdFrom > query.createdTo
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["createdTo"],
          message: "Ngày kết thúc phải từ ngày bắt đầu",
        });
      }
      if (!Number.isSafeInteger((query.page - 1) * query.limit)) {
        ctx.addIssue({
          code: "custom",
          path: ["page"],
          message: "Trang vượt giới hạn hỗ trợ",
        });
      }
    }),
});

// Deprecated. Accepted for older clients and unused by PO commands.
const evaluations = z
  .array(
    z
      .object({
        lineId: objectIdString,
        evaluationKey: z.string().min(1).max(200),
      })
      .strict(),
  )
  .max(100)
  .optional();

const form = {
  evaluations,
  warehouseId: objectIdString,
  supplierId: objectIdString,
  currency: z.literal("VND"),
  expectedOn: z.string().datetime({ offset: true }).optional(),
  lines: z
    .array(
      z
        .object({
          id: objectIdString.optional(),
          rrLineId: objectIdString,
          approvalId: objectIdString,
          enteredQty: qty,
          uomCode: z.string().trim().min(1).max(60).optional(),
          unitPurchasePrice: decimalStringSchema(),
          note: z.string().trim().min(1).max(2000).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(100),
};

const action = (fields) => z.object({ ...commandBody, evaluations, ...fields }).strict();
const closeLines = z
  .array(z.object({ poLineId: objectIdString, qtyBase: qty }).strict())
  .min(1)
  .max(100);

export const createPurchaseOrderSchema = schema(
  z.object({ ...form, creationKey: key }).strict(),
  empty,
);
export const updatePurchaseOrderSchema = schema(action(form));
export const confirmPurchaseOrderSchema = schema(action({}));
export const rescheduleExpectedOnSchema = schema(
  action({ expectedOn: z.string().datetime({ offset: true }), reason }),
);
// Evidence is optional for closing the remainder (user decision 16/11/2026).
export const closeRemainderSchema = schema(
  action({ reason, evidenceIds: optionalEvidenceIds, lines: closeLines }),
);
export const reopenPurchaseOrderSchema = schema(action({ reason }));
export const cancelPurchaseOrderSchema = schema(action({ reason }));
