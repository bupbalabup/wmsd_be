import {
  Schema,
  embeddedOptions,
  ref,
  refs,
  code,
  date,
  integer,
} from "./model-utils.js";
import { id, opt, revision, warehouse } from "./schema-helpers.js";

import { createStocktakeHeaderScopeSchema } from "./stocktake-header-scope.schema.js";
import { createStocktakeResolutionPlanSelectedCountsSchema } from "./stocktake-resolution-plan-selected-counts.schema.js";
import { createStocktakeSettledLineSchema } from "./stocktake-settled-line.schema.js";
import { createStocktakeRecountLineSchema } from "./stocktake-recount-line.schema.js";
import { createStocktakeCountReasonSchema } from "./stocktake-count-reason.schema.js";

// Embedded schema; no standalone collection.
export function createStocktakeHeaderSchema() {
  const schema = new Schema(
    {
      ...warehouse(),
      cutoffAt: date(false),
      completedAt: date(false),
      mode: code(["FROZEN"], { default: "FROZEN" }),
      scopeLocationIds: refs("Location"),
    },
    embeddedOptions,
  );
  schema.add({
    reason: opt(2000),
    plannedAt: date(false),
    scopeVersion: revision(),
    scope: createStocktakeHeaderScopeSchema(),
    assignedCounterIds: refs("User"),
    selectedCounts: [createStocktakeResolutionPlanSelectedCountsSchema()],
    lastReconciledBy: ref("User", false),
    lastReconciledAt: date(false),
    activatedBy: ref("User", false),
    activatedAt: date(false),
    closedBy: ref("User", false),
    closureReferenceId: id(false),
    // Slip generated from a StocktakePlan (22 Nov 2026); absent for ad-hoc slips.
    planId: ref("StocktakePlan", false),
    planPeriodNo: integer(0, { required: false }),
    planPeriodDueAt: date(false),
    // Simplified reconciliation (22 Nov 2026): lines already settled, and lines sent back for recount.
    settledLines: { type: [createStocktakeSettledLineSchema()], default: [] },
    recountLines: { type: [createStocktakeRecountLineSchema()], default: [] },
    // Counter-chosen reason per differing line (23 Nov 2026), tied to the newest count attempt of that line.
    countReasons: { type: [createStocktakeCountReasonSchema()], default: [] },
  });
  return schema;
}
