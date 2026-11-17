import { Schema, embeddedOptions, ref, code, date, text } from "./model-utils.js";
import { warehouse } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createSalesGoodsIssueHeaderSchema() {
  const schema = new Schema(
    { ...warehouse(), issueKind: code(["SALE", "OTHER"], { default: "SALE" }) },
    embeddedOptions,
  );
  schema.add({
    fulfillmentMode: code(['DIRECT'], { required: false }),
    salesOrderId: ref('SalesOrder', false),
    customerId: ref('Customer', false),
    deliveryOrderId: ref("DeliveryOrder", false),
    referenceNo: text(160, { required: false }),
    reasonText: text(500, { required: false }),
    issuedToName: text(160, { required: false }),
    issuedAt: date(false),
    issuedBy: ref("User", false),
  });
  return schema;
}
