import { Schema, embeddedOptions, ref } from "./model-utils.js";

// Embedded schema; no standalone collection.
export function createFailedDeliveryReceiptDetailsSchema() {
  const schema = new Schema(
    {
      failedDeliveryLineId: ref("DocumentLine", false),
      salesIssueLineId: ref("DocumentLine"),
      inspectionLineId: ref("DocumentLine", false),
      claimId: ref("ReturnSourceClaim", false),
    },
    embeddedOptions,
  );
  return schema;
}
