import { Schema, embeddedOptions, ref, code, text, decimal, date } from "./model-utils.js";
import { id } from "./schema-helpers.js";

// Embedded schema; no standalone collection.
export function createDeliveryOrderIssueReportSchema() {
  const pick = new Schema(
    {
      balanceId: ref("InventoryBalance"),
      locationId: ref("Location"),
      qtyBase: decimal({ positive: true }),
      reservationId: ref("Reservation", false),
    },
    { ...embeddedOptions, _id: true },
  );
  return new Schema(
    {
      lineId: id(),
      soLineId: id(false),
      lotId: ref("Lot", false),
      locationId: ref("Location", false),
      balanceId: ref("InventoryBalance", false),
      kind: code(["SHORTAGE", "DAMAGED"]),
      shortQtyBase: decimal({ positive: true }),
      reason: text(2000),
      picks: { type: [pick], default: [] },
      shortfallQtyBase: decimal(),
      status: code(["OPEN", "CLOSED"], { default: "OPEN" }),
      reportedBy: ref("User"),
      reportedAt: date(),
      closedBy: ref("User", false),
      closedAt: date(false),
      stockTransactionId: ref("StockTransaction", false),
      adjustmentId: ref("StockAdjustment", false),
    },
    { ...embeddedOptions, _id: true },
  );
}