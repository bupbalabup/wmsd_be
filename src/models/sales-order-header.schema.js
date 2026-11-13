import { Schema, embeddedOptions, text, ref, date } from "./model-utils.js";
import { opt } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createSalesOrderHeaderSchema() {
  const schema = new Schema(
    {
      externalReferenceId: ref("ExternalReference", false),
      customerId: ref("Party"),
      neededOn: date(false),
      deliveryAddressSnapshot: text(500),
    },
    embeddedOptions,
  );
  schema.add({ recipientName: opt(160), recipientPhone: opt(30) });
  return schema;
}
