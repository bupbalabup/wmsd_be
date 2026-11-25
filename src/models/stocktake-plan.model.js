import { Schema, options, text, ref, code, integer } from "./model-utils.js";
import { createStocktakePlanHeaderSchema } from "./stocktake-plan-header.schema.js";

// Collection: stocktake_plans
// Recurring stocktake plan (22 Nov 2026). It posts no stock and locks nothing; it only generates normal
// Stocktake slips. Document identity follows DOCUMENT_IDENTITIES.md (type ST_SCHEDULE, prefix KHKK).
export function createStocktakePlanSchema() {
  const schema = new Schema(
    {
      documentNo: text(50, { unique: true }),
      documentKind: code(["STOCKTAKE_PLAN"], { default: "STOCKTAKE_PLAN" }),
      workflowStatus: code(["ACTIVE", "PAUSED", "ENDED"]),
      version: integer(1),
      createdBy: ref("User"),
      occurredAt: Date,
      note: text(2000, { required: false }),
      header: { type: createStocktakePlanHeaderSchema(), required: true },
      updatedBy: ref("User", false),
    },
    options("stocktake_plans"),
  );
  schema.index({ workflowStatus: 1, "header.nextDueAt": 1 });
  schema.index({ "header.warehouseId": 1, workflowStatus: 1 });
  return schema;
}
