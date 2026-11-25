import { Router } from "express";
import { authenticate } from "../../middlewares/auth.js";
import checkPermission from "../../middlewares/permission.js";
import { validate } from "../../middlewares/validate.js";
import * as controller from "./purchase-order.controller.js";
import * as validation from "./purchase-order.validation.js";

const router = Router();
router.use(authenticate);

router.get(
  "/",
  checkPermission("purchase_order:read"),
  validate(validation.listPurchaseOrdersSchema),
  controller.list,
);
router.get(
  "/supplier-options",
  checkPermission("purchase_order:read"),
  validate(validation.purchaseOrderSupplierOptionsSchema),
  controller.supplierOptions,
);
router.get(
  "/:id",
  checkPermission("purchase_order:read"),
  validate(validation.getPurchaseOrderSchema),
  controller.get,
);
router.post(
  "/",
  checkPermission("purchase_order:create"),
  validate(validation.createPurchaseOrderSchema),
  controller.create,
);
router.put(
  "/:id",
  checkPermission("purchase_order:update"),
  validate(validation.updatePurchaseOrderSchema),
  controller.update,
);
router.post(
  "/:id/confirm",
  checkPermission("purchase_order:update"),
  validate(validation.confirmPurchaseOrderSchema),
  controller.confirm,
);
router.post(
  "/:id/expected-on",
  checkPermission("purchase_order:update"),
  validate(validation.rescheduleExpectedOnSchema),
  controller.rescheduleExpectedOn,
);
router.post(
  "/:id/close-remainder",
  checkPermission("purchase_order:update"),
  validate(validation.closeRemainderSchema),
  controller.closeRemainder,
);
router.post(
  "/:id/reopen",
  checkPermission("purchase_order:update"),
  validate(validation.reopenPurchaseOrderSchema),
  controller.reopen,
);
router.post(
  "/:id/cancel",
  checkPermission("purchase_order:update"),
  validate(validation.cancelPurchaseOrderSchema),
  controller.cancel,
);

export default router;
