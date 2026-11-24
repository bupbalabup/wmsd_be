import { Schema, embeddedOptions, ref, decimal } from "./model-utils.js";

// Embedded schema; no standalone collection. One pick location of a schedule line.
export function createDeliveryScheduleAllocationSchema() {
  return new Schema(
    {
      balanceId: ref("InventoryBalance"),
      locationId: ref("Location"),
      qtyBase: decimal({ positive: true }),
      reservationId: ref("Reservation", false),
    },
    { ...embeddedOptions, _id: true },
  );
}
