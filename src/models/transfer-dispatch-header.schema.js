import { Schema, embeddedOptions, ref, date } from "./model-utils.js";
import { revision } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createTransferDispatchHeaderSchema() {
  const schema = new Schema(
    {
      requestId: ref("BusinessDocument"),
      dispatchedBy: ref("User"),
      dispatchedAt: date(),
    },
    embeddedOptions,
  );
  schema.add({
    approvedRevision: revision(),
    sourceWarehouseId: ref("Warehouse", false),
    destinationWarehouseId: ref("Warehouse", false),
    // True when one request line is supplied from more than one lot; the dispatcher must acknowledge it.
    mixedLots: { type: Boolean, default: false },
    mixedLotAcceptedBy: ref("User", false),
    // Set when the picker confirmed less than the planned quantity.
    shortPickReason: { type: String, maxlength: 500 },
  });
  return schema;
}
