import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.js";
import { catchAsync } from "../../shared/utils/catchAsync.js";
import { formatApiResponse } from "../../shared/utils/ApiResponse.js";
import { validationError } from "../../shared/utils/ApiError.js";
import { ownerDashboard } from "./dashboard.service.js";
import { getSalesPolicy, updateSalesPolicy, salesPolicyBody } from "../settings/sales-policy.service.js";
import { listStockAlerts, scanLowStock } from "../stock-alerts/stock-alert.service.js";
import { requirePermission } from "../../shared/utils/access.js";
import { quickSearch, searchQuery } from "../search/search.service.js";

// Owner dashboard, sales policy, low-stock alerts and quick search (user decision 23/11/2026).
// Mounted at the API root: authenticate per route so unknown paths still answer 404, not 401.
const router = Router();

const parse = (schema, data) => {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fieldErrors = result.error.issues.map((issue) => ({ path: `body.${issue.path.join(".")}`, message: issue.message }));
    throw validationError(fieldErrors.map((f) => f.message).join(", "), fieldErrors);
  }
  return result.data;
};
const send = (fn) => catchAsync(async (req, res) => formatApiResponse(res, { data: await fn(req) }));

router.get("/dashboard/owner", authenticate, send((req) => ownerDashboard(req.user)));

router.get("/settings/sales-policy", authenticate, send((req) => getSalesPolicy(req.user)));
router.put("/settings/sales-policy", authenticate, send((req) => updateSalesPolicy(req.user, parse(salesPolicyBody, req.body))));

router.get("/stock-alerts", authenticate, send((req) => listStockAlerts(req.user, parse(z.object({ status: z.enum(["BELOW", "OK"]).optional() }), req.query))));
// Manual re-check (for example right after changing thresholds); normally the background job runs every 15 minutes.
router.post("/stock-alerts/scan", authenticate, send(async (req) => {
  requirePermission(req.user, "sales_policy:update");
  return scanLowStock(new Date());
}));

router.get("/search", authenticate, send((req) => quickSearch(req.user, parse(searchQuery, req.query))));

export default router;
