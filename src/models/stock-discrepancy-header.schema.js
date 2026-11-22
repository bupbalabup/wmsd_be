import { Schema, embeddedOptions, ref, date, code } from "./model-utils.js";

import { createSourceReferenceSchema } from "./source-reference.schema.js";

// Embedded schema; no standalone collection.
export function createStockDiscrepancyHeaderSchema() {
  const schema = new Schema({}, embeddedOptions);
  schema.add({
    sourceRef: createSourceReferenceSchema(),
    warehouseId: ref("Warehouse", false),
    reportedBy: ref("User", false),
    reportedAt: date(false),
    // Set when the owner closes the case: goods arrived later or are written off as transit loss.
    resolutionMode: code(["RECEIVED", "WRITE_OFF"], { required: false }),
    liableParty: code(["SOURCE_WAREHOUSE", "CARRIER", "DESTINATION_WAREHOUSE", "UNKNOWN"], { required: false }),
  });
  return schema;
}
