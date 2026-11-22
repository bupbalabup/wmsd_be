import { Schema, decimal, embeddedOptions, ref, text } from './model-utils.js';

export const transferSourceLocationSchema = new Schema({
  sourceBalanceId: ref('InventoryBalance'),
  locationId: ref('WarehouseLocation'),
  locationCode: text(50),
  qtyBase: decimal({ positive: true }),
}, embeddedOptions);
