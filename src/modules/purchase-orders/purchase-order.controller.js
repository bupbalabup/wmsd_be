import { respondWithData } from "../../shared/utils/catchAsync.js";
import * as service from "./purchase-order.service.js";
import * as commands from "./purchase-order.commands.js";

export const list = respondWithData((req) =>
  service.listPurchaseOrders(req.user, req.validated.query),
);
export const supplierOptions = respondWithData((req) =>
  service.listPurchaseOrderSupplierOptions(req.user, req.validated.query),
);
export const get = respondWithData((req) =>
  service.getPurchaseOrder(req.user, req.validated.params.id),
);
export const create = respondWithData((req) =>
  commands.createPurchaseOrder(req.user, req.validated.body),
);
export const update = respondWithData((req) =>
  commands.updatePurchaseOrder(req.user, req.validated.params.id, req.validated.body),
);
export const confirm = respondWithData((req) =>
  commands.confirmPurchaseOrder(req.user, req.validated.params.id, req.validated.body),
);
export const rescheduleExpectedOn = respondWithData((req) =>
  commands.rescheduleExpectedOn(req.user, req.validated.params.id, req.validated.body),
);
export const closeRemainder = respondWithData((req) =>
  commands.closeRemainder(req.user, req.validated.params.id, req.validated.body),
);
export const reopen = respondWithData((req) =>
  commands.reopenPurchaseOrder(req.user, req.validated.params.id, req.validated.body),
);
export const cancel = respondWithData((req) =>
  commands.cancelPurchaseOrder(req.user, req.validated.params.id, req.validated.body),
);
