import { Schema, embeddedOptions, ref, date } from "./model-utils.js";
import { opt, warehouse, objectId } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createDeliveryOrderHeaderSchema() {
  const schema = new Schema(
    {
      ...warehouse(),
      // Old flow: the issue request. New flow (schedule-driven): salesOrderId/scheduleId/deliveryId.
      issueRequestId: ref("BusinessDocument", false),
      salesOrderId: ref("SalesOrder", false),
      scheduleId: ref("DeliverySchedule", false),
      deliveryId: { type: objectId },
      plannedOn: date(),
    },
    embeddedOptions,
  );
  schema.add({
    recipientName: opt(160),
    recipientPhone: opt(30),
    deliveryAddress: opt(500),
    deliveryInstructions: opt(2000),
    releasedBy: ref("User", false),
    releasedAt: date(false),
    replacesDeliveryOrderId: ref("DeliveryOrder", false),
    issuedBy: ref("User", false),
    issuedAt: date(false),
    handedOverBy: ref("User", false),
    handedOverAt: date(false),
  });
  return schema;
}
