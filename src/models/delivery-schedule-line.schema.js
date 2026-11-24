import { Schema, embeddedOptions, ref, decimal } from "./model-utils.js";
import { id } from "./schema-helpers.js";
import { createDeliveryScheduleAllocationSchema } from "./delivery-schedule-allocation.schema.js";

// Embedded schema; no standalone collection. Quantity of one sales-order line in one delivery.
export function createDeliveryScheduleLineSchema() {
  return new Schema(
    {
      soLineId: id(),
      lotId: ref("Lot"),
      qtyBase: decimal({ positive: true }),
      allocations: { type: [createDeliveryScheduleAllocationSchema()], default: [] },
    },
    { ...embeddedOptions, _id: true },
  );
}
