import { Schema, embeddedOptions, ref, refs, text, date, decimal } from './model-utils.js';
import { id } from './schema-helpers.js';

// Physical handback of rejected goods; no inventory movement.
export function createReturnHandbackSchema() {
  return new Schema({
    returnLineId: id(), quantityBase: decimal({ positive: true }),
    recipientName: text(160), recordedBy: ref('User'), recordedAt: date(),
    evidenceIds: refs('Attachment'),
  }, { ...embeddedOptions, _id: true });
}
