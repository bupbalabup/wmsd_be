import { z } from "zod";
import { AppSetting, AuditLog, User } from "../../models/runtime.js";
import { exact } from "../../models/model-utils.js";
import { ApiError, ERROR_CODES } from "../../shared/utils/ApiError.js";
import { requirePermission } from "../../shared/utils/access.js";
import { appendAudit, changedFields } from "../../shared/utils/audit.js";

// Numbers the Administrator configures instead of fixed values in code (user decision 25/11/2026): the default
// low-stock threshold, the "near threshold" warning level and the number of rows on the owner dashboard.
// Stored in app_settings, versioned and audited. The defaults keep the behaviour from before this change.

export const SYSTEM_SETTINGS_KEY = "SYSTEM_SETTINGS";
export const DEFAULT_SYSTEM_SETTINGS = Object.freeze({
  // Minimum available quantity (in each product's base unit) for product×warehouse pairs that have stock but no
  // threshold of their own. "0" turns the default off.
  defaultMinimumQty: "0",
  // Warn "near threshold" when available < minimum × (100 + percent) / 100. 0 turns the level off.
  nearThresholdPercent: 0,
  dashboardLowStockRows: 10,
  dashboardAgingLotRows: 10,
  dashboardApprovalItems: 5,
  dashboardRecentDecisions: 10,
});
const FIELDS = Object.keys(DEFAULT_SYSTEM_SETTINGS);
export const SYSTEM_SETTING_LABELS = Object.freeze({
  defaultMinimumQty: "Ngưỡng tồn tối thiểu mặc định",
  nearThresholdPercent: "Mức cảnh báo sắp hết (%)",
  dashboardLowStockRows: "Số mặt hàng dưới ngưỡng trên bảng điều hành",
  dashboardAgingLotRows: "Số lô tồn lâu trên bảng điều hành",
  dashboardApprovalItems: "Số chứng từ mỗi hàng đợi duyệt",
  dashboardRecentDecisions: "Số quyết định gần đây",
});

const rows = (label) => z.number({ error: `${label} phải là số` }).int(`${label} phải là số nguyên`)
  .min(1, `${label} tối thiểu 1`).max(50, `${label} tối đa 50`);

export const systemSettingsBody = z.strictObject({
  defaultMinimumQty: z.string().trim()
    .regex(/^\d{1,9}(\.\d{1,3})?$/, "Ngưỡng tồn mặc định là số không âm, tối đa 3 chữ số thập phân"),
  nearThresholdPercent: z.number().int("Mức sắp hết phải là số nguyên").min(0, "Mức sắp hết không được âm").max(200, "Mức sắp hết tối đa 200%"),
  dashboardLowStockRows: rows("Số mặt hàng dưới ngưỡng"),
  dashboardAgingLotRows: rows("Số lô tồn lâu"),
  dashboardApprovalItems: z.number().int("Số chứng từ phải là số nguyên").min(1, "Số chứng từ tối thiểu 1").max(20, "Số chứng từ tối đa 20"),
  dashboardRecentDecisions: rows("Số quyết định gần đây"),
  // 0 when the settings have never been saved.
  version: z.number().int().min(0),
});

/** Saved settings merged over the defaults (keys added later fall back to their defaults). */
export async function currentSystemSettings() {
  const row = await AppSetting.findOne({ key: SYSTEM_SETTINGS_KEY }).lean();
  const settings = { ...DEFAULT_SYSTEM_SETTINGS, ...(row?.value ?? {}) };
  return { row, settings: { ...settings, defaultMinimumQty: exact(String(settings.defaultMinimumQty)).toFixed() } };
}

const conflict = () => new ApiError(409, "Cấu hình vừa được người khác cập nhật. Vui lòng tải lại trang.", { code: ERROR_CODES.VERSION_CONFLICT });

export async function getSystemSettings(user) {
  requirePermission(user, "system_setting:read");
  const { row, settings } = await currentSystemSettings();
  const history = row
    ? await AuditLog.find({ subjectType: "app_settings", subjectId: row._id }).sort({ occurredAt: -1 }).limit(50).lean()
    : [];
  const actors = await User.find({ _id: { $in: [row?.updatedBy, ...history.map((e) => e.actorId)].filter(Boolean) } }).select("fullName").lean();
  const nameOf = (id) => actors.find((a) => String(a._id) === String(id))?.fullName ?? "Không rõ";
  return {
    settings,
    defaults: DEFAULT_SYSTEM_SETTINGS,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ? nameOf(row.updatedBy) : null,
    changeLog: history.flatMap((event) => (event.changes ?? []).map((change, index) => ({
      id: `${event._id}:${index}`,
      changedAt: event.occurredAt,
      changedBy: nameOf(event.actorId),
      field: SYSTEM_SETTING_LABELS[change.field] ?? change.field,
      oldValue: change.before,
      newValue: change.after,
    }))),
  };
}

export async function updateSystemSettings(user, { version, ...input }) {
  requirePermission(user, "system_setting:update");
  const { row, settings: before } = await currentSystemSettings();
  if ((row?.version ?? 0) !== version) throw conflict();
  const after = Object.fromEntries(FIELDS.map((field) => [field, input[field]]));
  after.defaultMinimumQty = exact(after.defaultMinimumQty).toFixed();
  const changes = changedFields(before, after, FIELDS);
  if (!changes.length) return getSystemSettings(user);
  let saved;
  if (!row) {
    saved = await AppSetting.create({ key: SYSTEM_SETTINGS_KEY, value: after, version: 1, updatedBy: user._id }).catch((error) => {
      if (error.code === 11000) throw conflict();
      throw error;
    });
  } else {
    saved = await AppSetting.findOneAndUpdate(
      { _id: row._id, version },
      { $set: { value: after, updatedBy: user._id }, $inc: { version: 1 } },
      { new: true },
    );
    if (!saved) throw conflict();
  }
  await appendAudit({
    actorId: user._id, action: "UPDATE_SYSTEM_SETTINGS", entityType: "app_settings", entityId: saved._id,
    changes, versionBefore: version, versionAfter: saved.version, details: { reason: "Cập nhật cấu hình hệ thống" },
  });
  return getSystemSettings(user);
}
