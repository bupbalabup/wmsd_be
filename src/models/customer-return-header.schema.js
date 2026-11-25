import { Schema, embeddedOptions, ref, date, code } from "./model-utils.js";
import { warehouse, financialStatus, opt } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createCustomerReturnHeaderSchema() {
  const schema = new Schema(
    {
      ...warehouse(),
      customerId: ref("Party", false),
      customerName: opt(160),
      customerPhone: opt(30),
      salesOrderReference: opt(100),
      intakeMode: code(['DIRECT'], { required: false }),
      financialFollowupStatus: financialStatus(),
    },
    embeddedOptions,
  );
  schema.add({ openedBy: ref("User", false), openedAt: date(false) });
  return schema;
}
