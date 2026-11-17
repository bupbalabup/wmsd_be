import { Schema, options, text, code, integer } from "./model-utils.js";
import {
  optionalText,
  active,
  uniqueCode,
  dimension,
  dimensionsTogether,
} from "./schema-helpers.js";

// Collection: warehouses
export function createWarehouseSchema() {
  const warehouses = new Schema(
    {
      code: uniqueCode(),
      name: text(160),
      address: optionalText(500),
      description: optionalText(500),
      lengthMm: dimension(),
      widthMm: dimension(),
      clearHeightMm: dimension(),
      isActive: active(),
      stockOperationVersion: integer(0, { default: 0 }),
      layout3d: { type: Schema.Types.Mixed, default: undefined },
      layout3dApplied: { type: Schema.Types.Mixed, default: undefined },
      layout3dAppliedAt: { type: Date, default: undefined },
    },
    options("warehouses"),
  );
  dimensionsTogether(warehouses, ["lengthMm", "widthMm", "clearHeightMm"]);
  return warehouses;
}
