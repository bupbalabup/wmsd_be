import { Schema, embeddedOptions, ref, refs, code, date, integer, text } from "./model-utils.js";
import { opt, warehouse } from "./schema-helpers.js";
import { createStocktakeHeaderScopeSchema } from "./stocktake-header-scope.schema.js";

export const STOCKTAKE_PLAN_FREQUENCIES = ["MONTHLY", "QUARTERLY", "YEARLY"];

// Embedded schema; no standalone collection.
export function createStocktakePlanHeaderSchema() {
  const schema = new Schema(
    {
      ...warehouse(),
      title: text(200),
      reason: opt(2000),
      scope: createStocktakeHeaderScopeSchema(),
      assignedCounterIds: refs("User"),
      frequency: code(STOCKTAKE_PLAN_FREQUENCIES),
      // Occurrence n is startDate + n * step months, clamped to the month length, so a day-31 anchor never drifts.
      startDate: date(),
      endDate: date(false),
      nextPeriodNo: integer(0, { default: 0 }),
      nextDueAt: date(false),
      // A period can be generated from this many days before it is due; also the "due soon" window.
      reminderDays: integer(0, { default: 7 }),
      lastGeneratedAt: date(false),
      lastStocktakeId: ref("Stocktake", false),
      generatedCount: integer(0, { default: 0 }),
      pausedAt: date(false),
      pausedBy: ref("User", false),
      resumedAt: date(false),
      endedAt: date(false),
      endedBy: ref("User", false),
      endReason: opt(2000),
    },
    embeddedOptions,
  );
  return schema;
}
