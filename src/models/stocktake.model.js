import {
  Schema,
  options,
  text,
  ref,
  refs,
  code,
  integer,
  date,
} from "./model-utils.js";
import { objectId, opt, version, embedRecordArray } from "./schema-helpers.js";

import { createDocumentSourceSchema } from "./document-source.schema.js";
import { createDocumentItemSchema } from "./document-item.schema.js";
import { createStocktakeHeaderSchema } from "./stocktake-header.schema.js";
import { createStocktakeResolutionPlanSchema } from "./stocktake-resolution-plan.schema.js";
import {
  attachDocumentItems,
  addDocumentIndexesAndRules,
} from "./document-helpers.js";

// Collection: stocktakes
export function createStocktakeSchema() {
  const schema = new Schema(
    {
      documentNo: text(50, { unique: true }),
      documentKind: code(["STOCKTAKE"], { default: "STOCKTAKE" }),
      workflowStatus: text(40),
      version: integer(1),
      createdBy: ref("User"),
      occurredAt: Date,
      note: text(2000, { required: false }),
      externalReferenceIds: [objectId],
      sources: { type: [createDocumentSourceSchema()], default: undefined },
      header: { type: createStocktakeHeaderSchema(), required: true },
      updatedBy: ref("User", false),
      evidenceIds: refs("Attachment"),
      cancelledBy: ref("User", false),
      cancelledAt: date(false),
      cancelReason: opt(2000),
    },
    options("stocktakes"),
  );
  const item = createDocumentItemSchema();
  item.add({ note: opt(2000), evidenceIds: refs("Attachment") });
  attachDocumentItems(schema, item);
  addDocumentIndexesAndRules(schema);
  // One non-cancelled slip per plan period (22 Nov 2026): the database arbitrates concurrent generations. A CANCELLED
  // slip frees its period so the plan can generate it again (partial filters do not support $ne, hence the allow-list;
  // a new non-cancelled workflow status must be added here). The service also checks this in code.
  schema.index(
    { "header.planId": 1, "header.planPeriodNo": 1 },
    {
      unique: true,
      name: "stocktake_plan_period_once",
      partialFilterExpression: {
        "header.planId": { $exists: true },
        // Every live status, including the retired plan-workflow ones still held by historical in-flight slips;
        // CANCELLED is deliberately absent so a cancelled slip frees its plan period.
        workflowStatus: { $in: ["PLANNED", "COUNTING", "RECONCILING", "PENDING_APPROVAL", "APPROVED", "IN_PROGRESS", "COMPLETED", "CLOSED", "POSTED"] },
      },
    },
  );

  embedRecordArray(
    schema,
    "stocktake_resolution_plans",
    "resolutionPlans",
    createStocktakeResolutionPlanSchema(),
  );
  return schema;
}
