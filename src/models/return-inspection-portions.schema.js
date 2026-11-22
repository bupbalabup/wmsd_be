import {
  Schema,
  embeddedOptions,
  text,
  refs,
  code,
  decimal,
} from "./model-utils.js";
import { createPackagingSchema } from "./packaging.schema.js";
import { str } from "./schema-helpers.js";
import { PACKAGING_CONDITIONS } from "./constants.js";

// Embedded schema; no standalone collection.
export function createReturnInspectionPortionsSchema() {
  const schema = new Schema(
    {
      quantityBase: decimal({ positive: true }),
      packagingCondition: code(PACKAGING_CONDITIONS),
      packagingState: code(["SEALED", "OPEN", "LOOSE"], { required: false }),
      installationStatus: code(["UNUSED", "INSTALLED", "UNKNOWN"]),
      damageCause: code(["NONE", "CUSTOMER", "SUPPLIER", "OTHER", "UNKNOWN"]),
      deadlineStatus: code(["WITHIN", "EXCEEDED", "NOT_APPLICABLE", "UNKNOWN"]),
      deadlineReference: str(1000),
      eligibilityStatus: code(["PENDING", "CASE_REVIEW", "INELIGIBLE"]),
      reason: text(2000),
      evidenceIds: refs("Attachment"),
      measuredVolumeMm3: decimal({ positive: true, required: false }),
      packagingSnapshot: createPackagingSchema(),
    },
    embeddedOptions,
  );
  return schema;
}
