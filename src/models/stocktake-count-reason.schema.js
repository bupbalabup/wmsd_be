import { Schema, embeddedOptions, ref, code, date } from "./model-utils.js";
import { str } from "./schema-helpers.js";
import { DISCREPANCY_REASONS } from "./stocktake-resolution-details.schema.js";

// Embedded schema; no standalone collection.
// Why a counted line differs from the book, chosen by the counter (user decision 23 Nov 2026); the Owner only
// approves it or sends the line back for recount. Valid only while `countId` is the newest attempt of the line.
export function createStocktakeCountReasonSchema() {
  const schema = new Schema(
    {
      snapshotId: ref("StocktakeSnapshot"),
      countId: ref("StocktakeCount"),
      reasonCode: code(DISCREPANCY_REASONS),
      reasonNote: str(500),
      setBy: ref("User"),
      setAt: date(),
    },
    embeddedOptions,
  );
  return schema;
}
