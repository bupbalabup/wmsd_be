import {
  Schema,
  options,
  text,
  ref,
  refs,
  code,
  integer,
  date,
} from "./model-utils.js";
import {
  objectId,
  opt,
  version,
  quantity,
  warehouse,
} from "./schema-helpers.js";

import { createDocumentSourceSchema } from "./document-source.schema.js";
import { createDocumentItemSchema } from "./document-item.schema.js";
import { createWarehouseTransferRequestHeaderSchema } from "./warehouse-transfer-request-header.schema.js";
import { transferSourceLocationSchema } from './transfer-source-location.schema.js';
import {
  attachDocumentItems,
  addDocumentIndexesAndRules,
} from "./document-helpers.js";

// Collection: warehouse_transfer_requests
export function createWarehouseTransferRequestSchema() {
  const schema = new Schema(
    {
      documentNo: text(160, { unique: true }),
      documentKind: code(["TRANSFER_REQUEST"], { default: "TRANSFER_REQUEST" }),
      workflowStatus: text(40),
      version: integer(1),
      createdBy: ref("User"),
      occurredAt: Date,
      note: text(2000, { required: false }),
      externalReferenceIds: [objectId],
      sources: { type: [createDocumentSourceSchema()], default: undefined },
      header: {
        type: createWarehouseTransferRequestHeaderSchema(),
        required: true,
      },
      updatedBy: ref("User", false),
      evidenceIds: refs("Attachment"),
      cancelledBy: ref("User", false),
      cancelledAt: date(false),
      cancelReason: opt(2000),
    },
    options("warehouse_transfer_requests"),
  );
  const item = createDocumentItemSchema();
  item.add({ note: opt(2000), evidenceIds: refs("Attachment") });
  item.add({ approvedQtyBase: quantity(), lotLabelSnapshot: opt(100) });
  item.add({ sourceLocations: { type: [transferSourceLocationSchema], default: undefined } });
  attachDocumentItems(schema, item);
  addDocumentIndexesAndRules(schema);

  // Versioned saves serialize hydrated documents, including pre-migration fields.
  schema.set("toObject", { transform(_doc, row) { if (row.header) delete row.header.executionStatus; } });
  return schema;
}
