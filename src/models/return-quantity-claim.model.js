import {
  Schema,
  options,
  ref,
  code,
  decimal,
  rules,
  exact,
} from "./model-utils.js";
import { id, version } from "./schema-helpers.js";

import { createPortionEventSchema } from "./portion-event.schema.js";

// Collection: return_quantity_claims
export function createReturnQuantityClaimSchema() {
  const claims = new Schema(
    {
      claimKind: code(["FD", "CR"]),
      requestLineId: id(),
      sourceKind: code(["GOODS_ISSUE", "DELIVERY_CONFIRMATION", "EXTERNAL"]),
      sourceLineId: id(),
      claimedQtyBase: decimal({ positive: true }),
      createdBy: ref("User"),
      operationId: ref("OperationRecord"),
      version: version(),
      events: [createPortionEventSchema()],
    },
    options("return_quantity_claims"),
  );
  rules(claims, function () {
    if (this.claimedQtyBase == null) return;
    let received = exact('0'), released = exact('0'), reacquired = exact('0');
    for (const event of this.events) {
      if (event.kind === 'RECEIVED') received = received.plus(String(event.quantityBase));
      if (event.kind === 'RELEASED') released = released.plus(String(event.quantityBase));
      if (event.kind === 'REACQUIRED') reacquired = reacquired.plus(String(event.quantityBase));
      if (reacquired.gt(released) || received.plus(released).minus(reacquired).gt(String(this.claimedQtyBase))) {
        this.invalidate('events', 'Claim events must stay within the original quantity and released allowance');
        break;
      }
    }
  });
  return claims;
}
