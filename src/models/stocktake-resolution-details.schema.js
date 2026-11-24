import {
  Schema,
  embeddedOptions,
  ref,
  code,
  decimal,
  date,
  rules,
  exact,
  sameId,
} from "./model-utils.js";
import { quantity, signed, str } from "./schema-helpers.js";

// Why the counted quantity differs from the book (decision 18/11/2026); DAMAGED moves stock to damaged quality.
export const DISCREPANCY_REASONS = ["DAMAGED", "LOST", "MISPLACED", "FOUND", "RECORD_ERROR", "OTHER"];

// Embedded schema; no standalone collection.
export function createStocktakeResolutionDetailsSchema() {
  const resolutionDetails = new Schema(
    {
      countId: ref("CountAttempt"),
      holdId: ref("DefectHold", false),
      actionKind: code(["DELTA", "RECLASS", "RELOCATE"]),
      fromBalanceId: ref("StockBalance", false),
      toBalanceId: ref("StockBalance", false),
      deltaQty: decimal({ signed: true, nonzero: true, required: false }),
      // Optional so plans submitted before reasons existed stay valid; new plans always carry one.
      reasonCode: code(DISCREPANCY_REASONS, { required: false }),
      reasonNote: str(500),
      executedBy: ref("User", false),
      executedAt: date(false),
      executionEvidenceId: ref("Evidence", false),
    },
    embeddedOptions,
  );
  rules(resolutionDetails, function validateResolutionAction() {
    if (this.actionKind === "DELTA") {
      const delta = this.deltaQty == null ? null : exact(this.deltaQty);
      if (!delta?.isFinite() || delta.isZero()) {
        this.invalidate("deltaQty", "DELTA requires a nonzero signed quantity");
      } else if (
        delta.gt(0)
          ? this.fromBalanceId != null || this.toBalanceId == null
          : this.fromBalanceId == null || this.toBalanceId != null
      ) {
        this.invalidate(
          "fromBalanceId",
          "DELTA endpoints must match the delta sign",
        );
      }
    } else if (["RECLASS", "RELOCATE"].includes(this.actionKind)) {
      // Broken tiles may go to a damaged group that only exists once the plan is closed.
      const newDamaged =
        this.actionKind === "RECLASS" &&
        this.reasonCode === "DAMAGED" &&
        !this.toBalanceId;
      if (
        this.deltaQty != null ||
        !this.fromBalanceId ||
        (!this.toBalanceId && !newDamaged) ||
        sameId(this.fromBalanceId, this.toBalanceId)
      ) {
        this.invalidate(
          "toBalanceId",
          "RECLASS/RELOCATE require distinct endpoints and no delta",
        );
      }
    }
    const execution = [
      this.executedBy,
      this.executedAt,
      this.executionEvidenceId,
    ];
    if (
      execution.some((value) => value != null) &&
      !execution.every((value) => value != null)
    ) {
      this.invalidate(
        "executionEvidenceId",
        "Execution requires actor, time and evidence together",
      );
    }
  });
  return resolutionDetails;
}
