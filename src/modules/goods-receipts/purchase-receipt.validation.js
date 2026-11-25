import { z } from "zod";
import { objectIdString as oid } from "../../shared/utils/domain.js";
import {
  empty,
  ver,
  reason,
  commandBody,
  schema,
} from "../../shared/utils/command-validation.js";
import {
  documentListQuery,
  reversalBody,
  packaging,
  getDocumentSchema,
  reversalPreflightSchema,
} from "../../shared/utils/purchase-validation.js";

export { getDocumentSchema, reversalPreflightSchema };

export const listPurchaseReceiptsSchema = schema(
  empty,
  empty,
  documentListQuery(["DRAFT", "POSTED", "REVERSED", "CANCELLED"]),
);
export const cancelPurchaseReceiptSchema = schema(
  z.object({ ...commandBody, expectedPoVersion: ver, reason }).strict(),
);
export const changeReceiptDestinationsSchema = schema(
  z
    .object({
      ...commandBody,
      reason,
      lines: z
        .array(z.object({ lineId: oid, receivingLocationId: oid }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
);
export const reversePurchaseReceiptSchema = schema(
  z.object({ ...reversalBody, expectedPoVersion: ver }).strict(),
);
export const postPurchaseReceiptSchema = schema(
  z.object({ ...commandBody, expectedPoVersion: ver, packaging }).strict(),
);
