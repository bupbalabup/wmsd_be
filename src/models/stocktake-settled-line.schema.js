import { Schema, embeddedOptions, ref, code, decimal, date } from "./model-utils.js";
import { documentId, str } from "./schema-helpers.js";
import { DISCREPANCY_REASONS } from "./stocktake-resolution-details.schema.js";

// Embedded schema; no standalone collection.
// One entry per snapshot line the Owner has settled (22 Nov 2026). Snapshots and counts are append-only,
// so this header record is the only place that says a line is closed and which count it was closed on.
export function createStocktakeSettledLineSchema() {
  const schema = new Schema(
    {
      snapshotId: ref("StocktakeSnapshot"),
      countId: ref("StocktakeCount"),
      outcome: code(["MATCHED", "POSTED"]),
      // Signed counted - book difference; zero for MATCHED lines, which post nothing.
      deltaQtyBase: decimal({ signed: true }),
      baseUnitSnapshot: str(60),
      reasonCode: code(DISCREPANCY_REASONS, { required: false }),
      reasonNote: str(500),
      adjustmentId: documentId(false),
      settledBy: ref("User"),
      settledAt: date(),
    },
    embeddedOptions,
  );
  return schema;
}
