import { z } from "zod";
import { AppSetting, AuditLog, User } from "../../models/runtime.js";
import { ApiError, ERROR_CODES } from "../../shared/utils/ApiError.js";
import { requirePermission } from "../../shared/utils/access.js";
import { appendAudit, changedFields } from "../../shared/utils/audit.js";

// Sales policy & warehouse thresholds, stored in app_settings (user decision 23/11/2026; replaces the
// browser-only mock). Only agingInventoryThresholdDays and defaultOddLotThreshold are read by other features
// (owner dashboard warnings); the other fields are recorded settings and are not yet enforced by sales/returns.

export const SALES_POLICY_KEY = "SALES_POLICY";
export const DEFAULT_SALES_POLICY = Object.freeze({
  allowOverStockOrder: false,
  suggestedLossRate: 0,
  defaultOddLotThreshold: 10,
  returnDaysWindow: 30,
  agingInventoryThresholdDays: 180,
});
const FIELDS = Object.keys(DEFAULT_SALES_POLICY);
export const FIELD_LABELS = {
  allowOverStockOrder: "Cho phép đặt hàng vượt tồn",
  suggestedLossRate: "Tỷ lệ hao hụt đề xuất (%)",
  defaultOddLotThreshold: "Ngưỡng lô lẻ mặc định (m²)",
  returnDaysWindow: "Thời hạn nhận trả hàng (ngày)",
  agingInventoryThresholdDays: "Ngưỡng tồn lâu (ngày)",
};

export const salesPolicyBody = z.strictObject({
  allowOverStockOrder: z.boolean(),
  suggestedLossRate: z.number().min(0, "Tỷ lệ hao hụt không được âm").max(15, "Tỷ lệ hao hụt tối đa 15%"),
  defaultOddLotThreshold: z.number().min(0, "Ngưỡng lô lẻ không được âm").max(100000),
  returnDaysWindow: z.number().int().min(0, "Thời hạn trả hàng không được âm").max(365, "Thời hạn trả hàng tối đa 365 ngày"),
  agingInventoryThresholdDays: z.number().int().min(1, "Ngưỡng tồn lâu phải lớn hơn 0 ngày").max(3650),
  // 0 when the policy has never been saved.
  version: z.number().int().min(0),
});

/** Current policy merged over defaults (missing keys fall back to defaults). Used by the dashboard too. */
export async function currentSalesPolicy() {
  const row = await AppSetting.findOne({ key: SALES_POLICY_KEY }).lean();
  return { row, policy: { ...DEFAULT_SALES_POLICY, ...(row?.value ?? {}) } };
}

export async function getSalesPolicy(user) {
  requirePermission(user, "sales_policy:read");
  const { row, policy } = await currentSalesPolicy();
  const history = row
    ? await AuditLog.find({ subjectType: "app_settings", subjectId: row._id }).sort({ occurredAt: -1 }).limit(50).lean()
    : [];
  const actors = await User.find({ _id: { $in: [row?.updatedBy, ...history.map((e) => e.actorId)].filter(Boolean) } }).select("fullName").lean();
  const nameOf = (id) => actors.find((a) => String(a._id) === String(id))?.fullName ?? "Không rõ";
  return {
    policy,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ? nameOf(row.updatedBy) : null,
    changeLog: history.flatMap((event) => (event.changes ?? []).map((change, index) => ({
      id: `${event._id}:${index}`,
      changedAt: event.occurredAt,
      changedBy: nameOf(event.actorId),
      field: FIELD_LABELS[change.field] ?? change.field,
      oldValue: change.before,
      newValue: change.after,
    }))),
  };
}

export async function updateSalesPolicy(user, { version, ...input }) {
  requirePermission(user, "sales_policy:update");
  const { row, policy: before } = await currentSalesPolicy();
  if ((row?.version ?? 0) !== version) {
    throw new ApiError(409, "Chính sách vừa được người khác cập nhật. Vui lòng tải lại trang.", { code: ERROR_CODES.VERSION_CONFLICT });
  }
  const after = Object.fromEntries(FIELDS.map((field) => [field, input[field]]));
  const changes = changedFields(before, after, FIELDS);
  if (!changes.length) return getSalesPolicy(user);
  let saved;
  if (!row) {
    saved = await AppSetting.create({ key: SALES_POLICY_KEY, value: after, version: 1, updatedBy: user._id }).catch((error) => {
      if (error.code === 11000) throw new ApiError(409, "Chính sách vừa được người khác cập nhật. Vui lòng tải lại trang.", { code: ERROR_CODES.VERSION_CONFLICT });
      throw error;
    });
  } else {
    saved = await AppSetting.findOneAndUpdate(
      { _id: row._id, version },
      { $set: { value: after, updatedBy: user._id }, $inc: { version: 1 } },
      { new: true },
    );
    if (!saved) throw new ApiError(409, "Chính sách vừa được người khác cập nhật. Vui lòng tải lại trang.", { code: ERROR_CODES.VERSION_CONFLICT });
  }
  await appendAudit({
    actorId: user._id, action: "UPDATE_SALES_POLICY", entityType: "app_settings", entityId: saved._id,
    changes, versionBefore: version, versionAfter: saved.version, details: { reason: "Cập nhật chính sách bán hàng & ngưỡng kho" },
  });
  return getSalesPolicy(user);
}
