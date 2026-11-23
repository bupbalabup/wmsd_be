import { z } from "zod";
import { ApiEndpoint } from "../../models/runtime.js";
import { ApiError, ERROR_CODES, notFoundError, validationError } from "../../shared/utils/ApiError.js";
import { requirePermission } from "../../shared/utils/access.js";
import { appendAudit, changedFields } from "../../shared/utils/audit.js";
import { escapeRegex } from "../../shared/utils/domain.js";
import { discoverRoutes } from "../../shared/utils/routeRegistry.js";

// API catalogue (user decision 23/11/2026): SYSTEM rows are discovered from the running Express router;
// an administrator adds MANUAL rows (url, name, description) and edits names/descriptions of any row.

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"];
const url = z.string().trim().min(1, "Nhập URL").max(300, "URL tối đa 300 ký tự").regex(/^\/\S*$/, "URL bắt đầu bằng / và không chứa khoảng trắng");
export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(200).optional(),
  module: z.string().trim().max(80).optional(),
  method: z.enum(METHODS).optional(),
  source: z.enum(["SYSTEM", "MANUAL"]).optional(),
  status: z.enum(["present", "missing", "inactive"]).optional(),
});
export const createBody = z.strictObject({
  method: z.enum(METHODS).default("GET"),
  url,
  name: z.string().trim().min(2, "Tên tối thiểu 2 ký tự").max(160),
  description: z.string().trim().max(2000).optional(),
  module: z.string().trim().max(80).optional(),
});
export const updateBody = z.strictObject({
  name: z.string().trim().min(2, "Tên tối thiểu 2 ký tự").max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  url: url.optional(),
  method: z.enum(METHODS).optional(),
  module: z.string().trim().max(80).optional(),
  isActive: z.boolean().optional(),
});

const dto = (row) => ({
  id: String(row._id), method: row.method, url: row.url, name: row.name, description: row.description ?? "",
  module: row.module ?? "", source: row.source, isPresent: row.isPresent, isActive: row.isActive,
  discoveredAt: row.discoveredAt ?? null, updatedAt: row.updatedAt,
});

const duplicate = (error) => {
  if (error?.code === 11000) throw new ApiError(409, "Đã có API cùng phương thức và URL trong danh mục", { code: ERROR_CODES.DUPLICATE });
  throw error;
};

/** Upserts discovered routes; keeps admin-edited names/descriptions; flags SYSTEM rows that disappeared. */
export async function syncCatalogue(app, user) {
  if (user) requirePermission(user, "api_catalogue:update");
  const routes = discoverRoutes(app);
  const now = new Date();
  let inserted = 0;
  for (const route of routes) {
    const result = await ApiEndpoint.updateOne(
      { method: route.method, url: route.url },
      {
        $setOnInsert: { method: route.method, url: route.url, name: `${route.method} ${route.url}`, module: route.module, source: "SYSTEM", isActive: true },
        $set: { isPresent: true, discoveredAt: now },
      },
      { upsert: true },
    );
    inserted += result.upsertedCount ?? 0;
  }
  const missing = await ApiEndpoint.updateMany(
    { source: "SYSTEM", discoveredAt: { $ne: now } },
    { $set: { isPresent: false } },
  );
  if (user) await appendAudit({ actorId: user._id, action: "SYNC_API_CATALOGUE", entityType: "api_endpoints", entityId: user._id, details: { reason: `Đồng bộ ${routes.length} API, thêm mới ${inserted}, không còn trong mã ${missing.modifiedCount ?? 0}` } }).catch(() => undefined);
  return { discovered: routes.length, inserted, missing: missing.modifiedCount ?? 0 };
}

export async function listCatalogue(app, user, query) {
  requirePermission(user, "api_catalogue:read");
  // First visit fills the catalogue so administrators never see an empty list.
  if (!(await ApiEndpoint.exists({}))) await syncCatalogue(app, null);
  const filter = {};
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [{ url: pattern }, { name: pattern }, { description: pattern }];
  }
  if (query.module) filter.module = query.module;
  if (query.method) filter.method = query.method;
  if (query.source) filter.source = query.source;
  if (query.status === "present") Object.assign(filter, { isPresent: true, isActive: true });
  if (query.status === "missing") filter.isPresent = false;
  if (query.status === "inactive") filter.isActive = false;
  const [rows, total, modules, counts] = await Promise.all([
    ApiEndpoint.find(filter).sort({ url: 1, method: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    ApiEndpoint.countDocuments(filter),
    ApiEndpoint.distinct("module"),
    ApiEndpoint.aggregate([{ $group: { _id: "$source", n: { $sum: 1 } } }]),
  ]);
  return {
    items: rows.map(dto), total, page: query.page, limit: query.limit,
    modules: modules.filter(Boolean).sort(),
    summary: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  };
}

// autoIndex is off in this project, so duplicates are checked explicitly instead of relying on the unique index.
async function assertUnique(method, url, exceptId) {
  if (await ApiEndpoint.exists({ method, url, ...(exceptId && { _id: { $ne: exceptId } }) })) duplicate({ code: 11000 });
}

export async function createEndpoint(user, input) {
  requirePermission(user, "api_catalogue:update");
  await assertUnique(input.method, input.url);
  const row = await ApiEndpoint.create({ ...input, module: input.module || input.url.split("/").filter(Boolean)[1] || "api", source: "MANUAL", isPresent: true, isActive: true, updatedBy: user._id }).catch(duplicate);
  await appendAudit({ actorId: user._id, action: "CREATE_API_ENDPOINT", entityType: "api_endpoints", entityId: row._id, details: { reason: `${row.method} ${row.url}` } }).catch(() => undefined);
  return dto(row);
}

export async function updateEndpoint(user, id, input) {
  requirePermission(user, "api_catalogue:update");
  const row = await ApiEndpoint.findById(id);
  if (!row) throw notFoundError("Không tìm thấy API trong danh mục");
  // URL and method of discovered endpoints come from the code and cannot be renamed here.
  if (row.source === "SYSTEM" && ((input.url && input.url !== row.url) || (input.method && input.method !== row.method))) {
    throw validationError("Không thể sửa URL hoặc phương thức của API do hệ thống phát hiện", [{ path: "body.url", message: "Chỉ API thêm tay mới sửa được URL" }]);
  }
  if (input.url || input.method) await assertUnique(input.method ?? row.method, input.url ?? row.url, row._id);
  const before = row.toObject();
  Object.assign(row, input, { updatedBy: user._id });
  await row.save().catch(duplicate);
  const changes = changedFields(before, row.toObject(), ["method", "url", "name", "description", "module", "isActive"]);
  if (changes.length) await appendAudit({ actorId: user._id, action: "UPDATE_API_ENDPOINT", entityType: "api_endpoints", entityId: row._id, changes }).catch(() => undefined);
  return dto(row);
}

export async function deleteEndpoint(user, id) {
  requirePermission(user, "api_catalogue:update");
  const row = await ApiEndpoint.findById(id);
  if (!row) throw notFoundError("Không tìm thấy API trong danh mục");
  if (row.source !== "MANUAL") throw validationError("Chỉ xoá được API thêm tay; API của hệ thống có thể tắt (ngừng sử dụng)");
  await row.deleteOne();
  await appendAudit({ actorId: user._id, action: "DELETE_API_ENDPOINT", entityType: "api_endpoints", entityId: row._id, details: { reason: `${row.method} ${row.url}` } }).catch(() => undefined);
  return { id: String(row._id) };
}
