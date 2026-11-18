import { Schema, embeddedOptions, text, decimal } from "./model-utils.js";
import { id, str } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createApprovalHistoryItemDecisionsSchema() {
  const schema = new Schema(
    {
      itemId: id(),
      approvedQtyBase: decimal(),
      approvedEnteredQty: decimal({ required: false }),
      outcome: text(40),
      reason: str(2000),
    },
    embeddedOptions,
  );
  return schema;
}
