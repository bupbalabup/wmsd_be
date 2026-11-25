import warehouseStockRouter from './modules/warehouse-stock/routes.js';
import openingStockRouter from './modules/opening-stock/routes.js';
import { Router } from "express";
import notificationsRouter from './modules/notifications/routes.js';
import stocktakeClosureRouter from './modules/stocktake-closure/stocktake-closure.routes.js';
import stocktakePlanRouter from './modules/stocktake-plans/stocktake-plan.routes.js';
import operationalReportsRouter from './modules/operational-reports/operational-reports.routes.js';
import locationMovementRouter from "./modules/location-movements/location-movement.routes.js";
import transferRouter from "./modules/transfers/transfer.routes.js";
import { salesOrderRouter, outboundDeliveryRouter, pickingRouter } from "./modules/sales-orders/sales-read.routes.js";
import { deliveryScheduleRouter, deliveryOrderRouter } from "./modules/delivery-orders/delivery-order.routes.js";
import healthRouter from "./modules/health/health.routes.js";
import systemRouter from "./modules/system/system.routes.js";
import overviewRouter from "./modules/dashboard/dashboard.routes.js";
import authRouter from "./modules/auth/auth.routes.js";
import usersRouter from "./modules/users/user.routes.js";
import rolesRouter from "./modules/roles/role.routes.js";
import replenishmentsRouter from "./modules/replenishments/replenishment.routes.js";
import productsRouter from "./modules/products/product.routes.js";
import suppliersRouter from "./modules/suppliers/supplier.routes.js";
import lotsRouter from "./modules/lots/lot.routes.js";
import purchaseOrdersRouter from "./modules/purchase-orders/purchase-order.routes.js";
import {
  purchaseReceivingRouter,
  queueRouter, purchaseDocumentRouter,
} from "./modules/po-receiving/po-receiving.routes.js";
import { inspectionRouter, purchaseOrderInspectionRouter } from "./modules/goods-inspections/goods-inspection.routes.js";
import { custodyRouter, custodyReleaseRouter } from "./modules/custody/custody.routes.js";
import { reversalRouter } from "./modules/stock-reversals/stock-reversal.routes.js";

import returnWorkflowsRouter from './modules/return-workflows/workflow.routes.js';
import uomRouter from './modules/uoms/uom.routes.js';
import goodsReceiptRouter from './modules/goods-receipts/goods-receipt.routes.js';
import goodsIssueRouter from './modules/goods-issues/goods-issue.routes.js';

const router = Router();
router.use('/notifications', notificationsRouter);
router.use('/opening-stocks', openingStockRouter);
router.use(warehouseStockRouter);
router.use('/stocktakes',stocktakeClosureRouter);
router.use('/stocktake-plans',stocktakePlanRouter);
router.use('/reports',operationalReportsRouter);
router.use('/uoms',uomRouter);
router.use("/location-movements", locationMovementRouter);
router.use("/warehouse-transfers", transferRouter);
router.use("/sales-orders", salesOrderRouter);
router.use("/outbound-deliveries", outboundDeliveryRouter);
router.use("/picking-tasks", pickingRouter);
router.use("/delivery-schedules", deliveryScheduleRouter);
router.use("/delivery-orders", deliveryOrderRouter);

router.use("/health", healthRouter);
// Administration and owner overview (23/11/2026): /system/*, /dashboard/owner, /stock-alerts, /search.
// /settings/sales-policy was removed on 25/11/2026 (scope LI-10).
router.use("/system", systemRouter);
router.use(overviewRouter);
router.use("/auth", authRouter);
router.use("/users", usersRouter);
router.use("/roles", rolesRouter);
router.use("/replenishments", replenishmentsRouter);
router.use("/products", productsRouter);
router.use("/suppliers", suppliersRouter);
router.use("/lots", lotsRouter);
router.use("/purchase-orders", purchaseOrdersRouter);
router.use("/purchase-orders", purchaseReceivingRouter);
router.use("/purchase-orders", purchaseOrderInspectionRouter);
router.use("/goods-inspections", inspectionRouter);
router.use("/stock-reversals", reversalRouter);
router.use("/custody-receipts", custodyRouter);
router.use("/custody-releases", custodyReleaseRouter);
router.use('/goods-receipts', goodsReceiptRouter);
router.use('/goods-issues', goodsIssueRouter);
router.use('/purchase-receiving/queue', queueRouter);
router.use('/purchase-documents', purchaseDocumentRouter);
router.use(returnWorkflowsRouter);

export default router;
