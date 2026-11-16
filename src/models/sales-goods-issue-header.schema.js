import { Schema, embeddedOptions, ref, code, date, text } from "./model-utils.js";
import { warehouse } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createSalesGoodsIssueHeaderSchema() {
  const schema = new Schema(
    { ...warehouse(), issueKind: code(["SALE", "OTHER"], { default: "SALE" }) },
    embeddedOptions,
  );
  schema.add({
    deliveryOrderId: ref("DeliveryOrder", false),
    referenceNo: text(160, { required: false }),
    reasonText: text(500, { required: false }),
    issuedAt: date(false),
    issuedBy: ref("User", false),
  });
  return schema;
}
