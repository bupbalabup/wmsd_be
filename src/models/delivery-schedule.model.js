import { Schema, options, text, ref, code, integer } from "./model-utils.js";
import { createDeliveryScheduleDeliverySchema } from "./delivery-schedule-delivery.schema.js";

// Collection: delivery_schedules (one document per sales order, numbered like its order)
export function createDeliveryScheduleSchema() {
  const schema = new Schema(
    {
      documentNo: text(160, { unique: true }),
      documentKind: code(["DELIVERY_SCHEDULE"], { default: "DELIVERY_SCHEDULE" }),
      version: integer(1),
      createdBy: ref("User"),
      updatedBy: ref("User", false),
      salesOrderId: ref("SalesOrder"),
      deliveries: { type: [createDeliveryScheduleDeliverySchema()], default: [] },
    },
    options("delivery_schedules"),
  );
  schema.index({ salesOrderId: 1 }, { unique: true });
  schema.index({ "deliveries.warehouseId": 1, "deliveries.plannedOn": 1, "deliveries.status": 1 });
  return schema;
}
