import { Schema, embeddedOptions, ref, refs, text, date, decimal } from './model-utils.js';
import { id } from './schema-helpers.js';

// Evidence of customer receipt; it never posts inventory.
export function createCustomerReceiptSchema() {
  return new Schema({
    issueLineId: id(), quantityBase: decimal({ positive: true }),
    recipientName: text(160), receivedAt: date(), recordedBy: ref('User'),
    recordedAt: date(), evidenceIds: refs('Attachment'),
  }, { ...embeddedOptions, _id: true });
}
