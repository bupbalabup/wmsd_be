import * as m from "../../models/runtime.js";
import { requirePermission, isOwner, canAccessWarehouse } from "../../shared/utils/access.js";
import { evaluateThresholds } from "../stock-alerts/stock-alert.service.js";
import { ACTION_LABELS, SUBJECT_LABELS } from "../system/audit-log.service.js";
import { currentSystemSettings } from "../settings/system-settings.service.js";

// Fixed since the editable sales policy was removed (25/11/2026, scope LI-10). Same value as its former default.
export const AGING_INVENTORY_THRESHOLD_DAYS = 180;

// Owner dashboard from live data (user decision 23/11/2026; replaces the browser mock). WMSD is a warehouse
// system: no revenue, profit, receivables or payables are shown. Quantities in different base units are never
// summed; monthly activity counts posted stock transactions instead.

const APPROVAL_QUEUES = [
  { key: "replenishments", label: "Đề nghị nhập hàng chờ duyệt", model: "ReplenishmentRequest", filter: { workflowStatus: "SUBMITTED" }, path: "/replenishments" },
  { key: "transfers", label: "Yêu cầu chuyển kho chờ duyệt", model: "WarehouseTransferRequest", filter: { workflowStatus: "PENDING_APPROVAL" }, path: "/transfers" },
  { key: "transferDifferences", label: "Chênh lệch chuyển kho chờ quyết định", model: "StockDiscrepancy", filter: { workflowStatus: "OPEN" }, path: "/transfers", listOnly: true },
  { key: "stocktakes", label: "Phiếu kiểm kê chờ xử lý chênh lệch", model: "Stocktake", filter: { workflowStatus: "RECONCILING" }, path: "/stocktakes" },
  { key: "defects", label: "Phương án xử lý hàng lỗi chờ duyệt", model: "DefectReport", filter: { "resolutionPlans.workflowStatus": "SUBMITTED" }, path: "/defective-goods" },
];

const scopeFilter = (user) => (isOwner(user) ? {} : { "header.warehouseId": { $in: user.warehouseIds ?? [] } });
const label = (doc) => doc.documentNo || doc.soChungTu || String(doc._id);

async function approvals(user, itemsPerQueue) {
  return Promise.all(APPROVAL_QUEUES.map(async (queue) => {
    const Model = m[queue.model];
    const filter = { ...queue.filter, ...scopeFilter(user) };
    const [count, rows] = await Promise.all([
      Model.countDocuments(filter),
      Model.find(filter).sort({ updatedAt: -1 }).limit(itemsPerQueue).select("documentNo header.warehouseId updatedAt createdAt").lean(),
    ]);
    return {
      key: queue.key, label: queue.label, count, href: queue.path,
      items: rows.map((row) => ({
        id: String(row._id), documentNo: label(row), updatedAt: row.updatedAt ?? row.createdAt,
        href: queue.listOnly ? queue.path : `${queue.path}/${encodeURIComponent(String(row._id))}`,
      })),
    };
  }));
}

async function qualityHolds(user) {
  // Non-GOOD store-owned stock that still has quantity (quarantine, damaged, ...), counted per balance line.
  const rows = await m.InventoryBalance.aggregate([
    { $match: { qualityStatus: { $ne: "GOOD" }, ownerType: "STORE", quantityBase: { $gt: 0 } } },
    { $lookup: { from: "stock_holding_points", localField: "holdingPointId", foreignField: "_id", as: "point" } },
    { $unwind: "$point" },
    // Holding points reference a location; the location carries the warehouse (in-transit points have none).
    { $lookup: { from: "warehouse_locations", localField: "point.locationId", foreignField: "_id", as: "location" } },
    { $addFields: { warehouseId: { $first: "$location.warehouseId" } } },
    { $group: { _id: { quality: "$qualityStatus", warehouseId: "$warehouseId" }, lines: { $sum: 1 } } },
  ]);
  return rows.filter((row) => !row._id.warehouseId || canAccessWarehouse(user, row._id.warehouseId))
    .reduce((acc, row) => ({ ...acc, [row._id.quality]: (acc[row._id.quality] ?? 0) + row.lines }), {});
}

async function agingLots(user, days, limit) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await m.InventoryBalance.aggregate([
    { $match: { qualityStatus: "GOOD", ownerType: "STORE", quantityBase: { $gt: 0 } } },
    { $lookup: { from: "stock_holding_points", localField: "holdingPointId", foreignField: "_id", as: "point" } },
    { $unwind: "$point" },
    // Holding points reference a location; the location carries the warehouse (in-transit points have none).
    { $lookup: { from: "warehouse_locations", localField: "point.locationId", foreignField: "_id", as: "location" } },
    { $addFields: { warehouseId: { $first: "$location.warehouseId" } } },
    { $group: { _id: "$batchId", warehouseIds: { $addToSet: "$warehouseId" } } },
    { $lookup: { from: "product_batches", localField: "_id", foreignField: "_id", as: "batch" } },
    { $unwind: "$batch" },
    // The lot's first appearance in the system is used as its age.
    { $match: { "batch.createdAt": { $lte: cutoff } } },
    { $lookup: { from: "products", localField: "batch.productId", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $sort: { "batch.createdAt": 1 } },
    { $project: { lot: "$batch.manufacturerLot", since: "$batch.createdAt", sku: "$product.sku", productName: "$product.name", warehouseIds: 1 } },
  ]);
  const visible = rows.filter((row) => row.warehouseIds.some((id) => !id || canAccessWarehouse(user, id)));
  return { count: visible.length, items: visible.slice(0, limit).map((row) => ({ id: String(row._id), lot: row.lot, sku: row.sku, productName: row.productName, since: row.since, href: `/lots/${row._id}` })) };
}

async function monthlyActivity() {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() - 11);
  const rows = await m.StockTransaction.aggregate([
    { $match: { occurredAt: { $gte: start } } },
    { $project: {
      month: { $dateToString: { format: "%Y-%m", date: "$occurredAt", timezone: "Asia/Ho_Chi_Minh" } },
      hasIn: { $anyElementTrue: [{ $map: { input: { $ifNull: ["$movements", []] }, as: "mv", in: { $and: [{ $not: ["$$mv.fromBalanceId"] }, { $ne: ["$$mv.toBalanceId", null] }] } } }] },
      hasOut: { $anyElementTrue: [{ $map: { input: { $ifNull: ["$movements", []] }, as: "mv", in: { $and: [{ $ne: ["$$mv.fromBalanceId", null] }, { $not: ["$$mv.toBalanceId"] }] } } }] },
    } },
    { $group: { _id: "$month", inbound: { $sum: { $cond: ["$hasIn", 1, 0] } }, outbound: { $sum: { $cond: ["$hasOut", 1, 0] } }, total: { $sum: 1 } } },
  ]);
  const byMonth = new Map(rows.map((row) => [row._id, row]));
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(start);
    date.setUTCMonth(start.getUTCMonth() + index);
    const key = date.toISOString().slice(0, 7);
    const row = byMonth.get(key);
    return { month: key, inbound: row?.inbound ?? 0, outbound: row?.outbound ?? 0, internal: row ? row.total - row.inbound - row.outbound : 0 };
  });
}

async function recentDecisions(limit) {
  const decisionActions = /APPROVE|REJECT|DECIDE|REVIEW|RESOLVE|POST|CLOSE|LOCK_USER|UNLOCK_USER/;
  const events = await m.AuditLog.find({ action: { $regex: decisionActions } }).sort({ occurredAt: -1 }).limit(limit).lean();
  const actors = await m.User.find({ _id: { $in: events.map((e) => e.actorId).filter(Boolean) } }).select("fullName").lean();
  return events.map((event) => ({
    id: String(event._id), action: event.action, actionLabel: ACTION_LABELS[event.action] ?? event.action,
    subjectType: event.subjectType, subjectLabel: SUBJECT_LABELS[event.subjectType] ?? event.subjectType, subjectId: String(event.subjectId),
    actor: actors.find((a) => String(a._id) === String(event.actorId))?.fullName ?? "Hệ thống",
    occurredAt: event.occurredAt, reason: event.reason ?? null,
  }));
}

export async function ownerDashboard(user) {
  requirePermission(user, "dashboard:read");
  // Row counts come from the Administrator's system settings (25/11/2026); defaults are the former fixed numbers.
  const { settings } = await currentSystemSettings();
  const [queues, thresholds, holds, aging, activity, decisions, productCount, warehouseCount] = await Promise.all([
    approvals(user, settings.dashboardApprovalItems),
    evaluateThresholds({ warehouseFilter: (id) => canAccessWarehouse(user, id), settings }),
    qualityHolds(user),
    agingLots(user, AGING_INVENTORY_THRESHOLD_DAYS, settings.dashboardAgingLotRows),
    monthlyActivity(),
    recentDecisions(settings.dashboardRecentDecisions),
    m.Product.countDocuments({ isActive: { $ne: false } }),
    m.Warehouse.countDocuments({ isActive: { $ne: false } }),
  ]);
  const lowStock = thresholds.filter((row) => row.status === "BELOW");
  return {
    generatedAt: new Date(),
    kpis: {
      pendingApprovals: queues.reduce((n, q) => n + q.count, 0),
      lowStockItems: lowStock.length,
      nearThresholdItems: thresholds.filter((row) => row.status === "NEAR").length,
      thresholdsConfigured: thresholds.length,
      qualityHoldLines: Object.values(holds).reduce((n, v) => n + v, 0),
      agingLots: aging.count,
      activeProducts: productCount,
      activeWarehouses: warehouseCount,
    },
    approvals: queues,
    warnings: {
      lowStock: lowStock.slice(0, settings.dashboardLowStockRows),
      qualityHolds: holds,
      agingLots: aging,
      agingThresholdDays: AGING_INVENTORY_THRESHOLD_DAYS,
    },
    monthlyActivity: activity,
    recentDecisions: decisions,
  };
}
