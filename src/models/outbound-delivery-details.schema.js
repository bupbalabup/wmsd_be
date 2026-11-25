import { Schema, embeddedOptions, ref } from "./model-utils.js";
import { objectId } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createOutboundDeliveryDetailsSchema() {
  const schema = new Schema(
    {
      issueRequestLineId: ref("DocumentLine", false),
      // Schedule-driven flow: one line per pick location of a delivery.
      soLineId: ref("DocumentLine", false),
      locationId: ref("Location", false),
      balanceId: ref("InventoryBalance", false),
      allocationId: { type: objectId },
      reservationId: ref("Reservation", false),
    },
    embeddedOptions,
  );
  return schema;
}
