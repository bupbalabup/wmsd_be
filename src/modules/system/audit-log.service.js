import { z } from "zod";
import mongoose from "mongoose";
import { AuditLog, User } from "../../models/runtime.js";
import { notFoundError } from "../../shared/utils/ApiError.js";
import { requirePermission } from "../../shared/utils/access.js";
import { escapeRegex } from "../../shared/utils/domain.js";

// System audit log screen (user decision 23/11/2026): read-only search over every audit event.

export const ACTION_LABELS = {
  LOGIN: "Đăng nhập", RESET_PASSWORD: "Đặt lại mật khẩu", CHANGE_PASSWORD: "Đổi mật khẩu", CHANGE_EMAIL: "Đổi email",
  UPDATE_PROFILE: "Cập nhật hồ sơ", LOCK_USER: "Khoá tài khoản", UNLOCK_USER: "Mở khoá tài khoản",
  UPDATE_SALES_POLICY: "Cập nhật chính sách bán hàng", UPDATE_SYSTEM_SETTINGS: "Cập nhật cấu hình hệ thống", SYNC_API_CATALOGUE: "Đồng bộ danh mục API",
  CREATE_API_ENDPOINT: "Thêm API", UPDATE_API_ENDPOINT: "Sửa API", DELETE_API_ENDPOINT: "Xoá API",
  RESOLVE_ERROR_LOG: "Đánh dấu lỗi đã xử lý", CREATE_ROLE: "Tạo vai trò", UPDATE_ROLE_PERMISSIONS: "Cập nhật quyền vai trò",
};
export const SUBJECT_LABELS = {
  users: "Tài khoản", roles: "Vai trò", app_settings: "Cài đặt", api_endpoints: "Danh mục API", error_logs: "Nhật ký lỗi",
  purchase_orders: "Đơn mua hàng", replenishment_requests: "Đề nghị nhập hàng", goods_receipts: "Phiếu nhập kho",
  sales_orders: "Đơn bán", sales_goods_issues: "Phiếu xuất kho", warehouse_transfer_requests: "Chuyển kho",
  stocktakes: "Kiểm kê", customer_returns: "Hàng khách trả", supplier_returns: "Trả hàng NCC", defect_reports: "Hàng lỗi",
  products: "Sản phẩm", suppliers: "Nhà cung cấp", product_batches: "Lô hàng", warehouses: "Kho",
};

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  actorId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  action: z.string().trim().max(100).optional(),
  subjectType: z.string().trim().max(80).optional(),
  result: z.enum(["SUCCESS", "REJECTED", "FAILED"]).optional(),
  search: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const actorMap = async (ids) => {
  const users = await User.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(String))] } }).select("username fullName").lean();
  return new Map(users.map((u) => [String(u._id), u]));
};

const dto = (event, actors) => {
  const actor = actors.get(String(event.actorId));
  return {
    id: String(event._id),
    occurredAt: event.occurredAt,
    action: event.action,
    actionLabel: ACTION_LABELS[event.action] ?? event.action,
    result: event.result,
    actorType: event.actorType,
    actor: actor ? { id: String(actor._id), username: actor.username, fullName: actor.fullName } : null,
    subjectType: event.subjectType,
    subjectLabel: SUBJECT_LABELS[event.subjectType] ?? event.subjectType,
    subjectId: String(event.subjectId),
    reason: event.reason ?? null,
    changeCount: event.changes?.length ?? 0,
    versionBefore: event.versionBefore ?? null,
    versionAfter: event.versionAfter ?? null,
  };
};

export async function listAuditLogs(user, query) {
  requirePermission(user, "audit_log:read");
  const filter = {};
  if (query.actorId) filter.actorId = new mongoose.Types.ObjectId(query.actorId);
  if (query.action) filter.action = query.action;
  if (query.subjectType) filter.subjectType = query.subjectType;
  if (query.result) filter.result = query.result;
  if (query.from || query.to) filter.occurredAt = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [{ reason: pattern }, { action: pattern }, { subjectType: pattern }, { subjectId: query.search }];
  }
  const [events, total] = await Promise.all([
    AuditLog.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).select("-changes.before -changes.after").lean(),
    AuditLog.countDocuments(filter),
  ]);
  const actors = await actorMap(events.map((e) => e.actorId));
  return { items: events.map((e) => dto(e, actors)), total, page: query.page, limit: query.limit };
}

export async function auditLogOptions(user) {
  requirePermission(user, "audit_log:read");
  const [actions, subjectTypes, actorIds] = await Promise.all([
    AuditLog.distinct("action"), AuditLog.distinct("subjectType"), AuditLog.distinct("actorId"),
  ]);
  const actors = await actorMap(actorIds);
  return {
    actions: actions.sort().map((code) => ({ value: code, label: ACTION_LABELS[code] ?? code })),
    subjectTypes: subjectTypes.sort().map((code) => ({ value: code, label: SUBJECT_LABELS[code] ?? code })),
    actors: [...actors.values()].map((u) => ({ value: String(u._id), label: `${u.fullName} (${u.username})` })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export async function getAuditLog(user, id) {
  requirePermission(user, "audit_log:read");
  if (!/^[a-f\d]{24}$/i.test(id)) throw notFoundError("Không tìm thấy bản ghi nhật ký");
  const event = await AuditLog.findById(id).lean();
  if (!event) throw notFoundError("Không tìm thấy bản ghi nhật ký");
  const actors = await actorMap([event.actorId]);
  return { ...dto(event, actors), changes: (event.changes ?? []).map((c) => ({ field: c.field, before: c.before ?? null, after: c.after ?? null })) };
}
