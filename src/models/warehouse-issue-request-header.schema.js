import { Schema, embeddedOptions, text, ref, date } from "./model-utils.js";
import { revision, opt } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createWarehouseIssueRequestHeaderSchema() {
  const schema = new Schema(
    {
      salesOrderId: ref("BusinessDocument"),
      requestedWarehouseId: ref("Warehouse"),
      neededOn: date(),
      deliveryAddressSnapshot: opt(500),
    },
    embeddedOptions,
  );
  schema.add({
    salesOrderVersion: revision(),
    requestedBy: ref("User", false),
    requestedAt: date(false),
  });
  return schema;
}
