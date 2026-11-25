import { respondWithData } from "../../shared/utils/catchAsync.js";
import { cancelDraft } from "../../shared/utils/purchase-core.js";
import * as reads from "../po-receiving/purchase-read.service.js";
import * as reversal from "../stock-reversals/stock-reversal.service.js";
import * as service from "./purchase-receipt.service.js";

export const listPurchaseReceipts = respondWithData((req) =>
  reads.listDocuments(req.user, "GR_PURCHASE", req.validated.query),
);
export const getPurchaseReceipt = respondWithData((req) =>
  reads.getDocument(req.user, req.validated.params.id, "GR_PURCHASE"),
);
export const postPurchaseReceipt = respondWithData((req) =>
  service.postReceipt(req.user, req.validated.params.id, req.validated.body),
);
export const cancelPurchaseReceipt = respondWithData((req) =>
  cancelDraft(
    req.user,
    req.validated.params.id,
    "GR_PURCHASE",
    req.validated.body,
  ),
);
export const changeReceiptDestinations = respondWithData((req) =>
  service.changeDestinations(
    req.user,
    req.validated.params.id,
    req.validated.body,
  ),
);
export const getPurchaseReversalPreflight = respondWithData((req) =>
  reversal.reversalPreflight(req.user, req.validated.params.id),
);
export const reversePurchaseReceipt = respondWithData((req) =>
  reversal.reverseReceipt(
    req.user,
    req.validated.params.id,
    req.validated.body,
  ),
);
