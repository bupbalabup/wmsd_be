import { Router } from "express";
import { authenticate } from "../../middlewares/auth.js";
import { catchAsync } from "../../shared/utils/catchAsync.js";
import { formatApiResponse } from "../../shared/utils/ApiResponse.js";
import { validationError } from "../../shared/utils/ApiError.js";
import * as auditLogs from "./audit-log.service.js";
import * as catalogue from "./api-catalogue.service.js";
import * as monitor from "./monitor.service.js";

// Administration: system audit log, API catalogue, server monitoring and error logs (23/11/2026).
// Each service checks its own permission (audit_log:read, api_catalogue:*, system_monitor:read).
const router = Router();
router.use(authenticate);

const parse = (schema, data) => {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    throw validationError(fieldErrors.map((f) => f.message).join(", ") || "Dữ liệu không hợp lệ", fieldErrors.map((f) => ({ ...f, path: `body.${f.path}` })));
  }
  return result.data;
};
const send = (fn) => catchAsync(async (req, res) => formatApiResponse(res, { data: await fn(req) }));
const id = (req) => String(req.params.id);
const objectId = (req) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw validationError("Mã không hợp lệ");
  return req.params.id;
};

router.get("/audit-logs", send((req) => auditLogs.listAuditLogs(req.user, parse(auditLogs.listQuery, req.query))));
router.get("/audit-logs/options", send((req) => auditLogs.auditLogOptions(req.user)));
router.get("/audit-logs/:id", send((req) => auditLogs.getAuditLog(req.user, id(req))));

router.get("/api-endpoints", send((req) => catalogue.listCatalogue(req.app, req.user, parse(catalogue.listQuery, req.query))));
router.post("/api-endpoints/sync", send((req) => catalogue.syncCatalogue(req.app, req.user)));
router.post("/api-endpoints", send((req) => catalogue.createEndpoint(req.user, parse(catalogue.createBody, req.body))));
router.patch("/api-endpoints/:id", send((req) => catalogue.updateEndpoint(req.user, objectId(req), parse(catalogue.updateBody, req.body))));
router.delete("/api-endpoints/:id", send((req) => catalogue.deleteEndpoint(req.user, objectId(req))));

router.get("/monitor", catchAsync(async (req, res) => {
  res.set("Cache-Control", "no-store");
  formatApiResponse(res, { data: await monitor.monitorOverview(req.user) });
}));
router.get("/error-logs", send((req) => monitor.listErrorLogs(req.user, parse(monitor.errorQuery, req.query))));
router.post("/error-logs/:id/resolve", send((req) => monitor.resolveErrorLog(req.user, id(req))));

export default router;
