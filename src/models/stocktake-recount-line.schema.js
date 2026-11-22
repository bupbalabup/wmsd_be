import { Schema, embeddedOptions, ref, integer, date } from "./model-utils.js";
import { str } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
// A line the Owner sent back for recounting. The line is satisfied once a count with attemptNo greater
// than afterAttemptNo exists; the earlier attempts stay as history.
export function createStocktakeRecountLineSchema() {
  const schema = new Schema(
    {
      snapshotId: ref("StocktakeSnapshot"),
      afterAttemptNo: integer(1),
      requestedBy: ref("User"),
      requestedAt: date(),
      note: str(1000),
    },
    embeddedOptions,
  );
  return schema;
}
