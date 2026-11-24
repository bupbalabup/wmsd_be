import { Schema, embeddedOptions, ref, code, integer, date } from "./model-utils.js";
import { createDeliveryScheduleLineSchema } from "./delivery-schedule-line.schema.js";

export const DELIVERY_STATUSES = ["PLANNED", "DO_CREATED", "ON_HOLD", "ISSUED", "HANDED_OVER", "CANCELLED"];

// Embedded schema; no standalone collection. One delivery (lần giao) of a sales order.
export function createDeliveryScheduleDeliverySchema() {
  return new Schema(
    {
      seq: integer(1),
      plannedOn: date(),
      warehouseId: ref("Warehouse"),
      status: code(DELIVERY_STATUSES, { default: "PLANNED" }),
      doId: ref("DeliveryOrder", false),
      lines: { type: [createDeliveryScheduleLineSchema()], default: [] },
    },
    { ...embeddedOptions, _id: true },
  );
}
