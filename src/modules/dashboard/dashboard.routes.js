import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.js";
import { catchAsync } from "../../shared/utils/catchAsync.js";
import { formatApiResponse } from "../../shared/utils/ApiResponse.js";
import { validationError } from "../../shared/utils/ApiError.js";
import { ownerDashboard } from "./dashboard.service.js";
import { listStockAlerts, scanLowStock } from "../stock-alerts/stock-alert.service.js";
import { requirePermission } from "../../shared/utils/access.js";
import { getSystemSettings, systemSettingsBody, updateSystemSettings } from "../settings/system-settings.service.js";
import { quickSearch, searchQuery } from "../search/search.service.js";

// Owner dashboard, low-stock alerts and quick search (user decision 23/11/2026). The sales policy API was
// removed on 25/11/2026 (user decision; scope LI-10: users cannot edit sales policy settings).
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

// Administrator-configured numbers (default low-stock minimum, near level, dashboard rows) — 25/11/2026.
router.get("/settings/system", authenticate, send((req) => getSystemSettings(req.user)));
router.put("/settings/system", authenticate, send((req) => updateSystemSettings(req.user, parse(systemSettingsBody, req.body))));

router.get("/stock-alerts", authenticate, send((req) => listStockAlerts(req.user, parse(z.object({ status: z.enum(["BELOW", "NEAR", "OK"]).optional() }), req.query))));
// Manual re-check (for example right after changing a product's thresholds, which needs product:update);
// normally the background job runs every 15 minutes.
router.post("/stock-alerts/scan", authenticate, send(async (req) => {
  requirePermission(req.user, "product:update");
  return scanLowStock(new Date());
}));

router.get("/search", authenticate, send((req) => quickSearch(req.user, parse(searchQuery, req.query))));

export default router;
