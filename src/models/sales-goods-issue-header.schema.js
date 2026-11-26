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
    customerName: text(160, { required: false }),
    customerPhone: text(30, { required: false }),
    deliveryOrderId: ref("DeliveryOrder", false),
    referenceNo: text(160, { required: false }),
    reasonText: text(500, { required: false }),
    issuedToName: text(160, { required: false }),
    issuedAt: date(false),
    issuedBy: ref("User", false),
    // 26/11/2026: a direct sales issue is locked once completed after the driver handover.
    completedAt: date(false),
    completedBy: ref("User", false),
  });
  return schema;
}
