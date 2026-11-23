import os from "node:os";
import mongoose from "mongoose";
import { z } from "zod";
import { AppSetting, ErrorLog, Notification, SystemEvent, User } from "../../models/runtime.js";
import { notFoundError } from "../../shared/utils/ApiError.js";
import { requirePermission } from "../../shared/utils/access.js";
import { appendAudit } from "../../shared/utils/audit.js";
import { escapeRegex } from "../../shared/utils/domain.js";
import { notificationEmailEnabled } from "../notifications/email.js";

// Server monitoring for administrators (user decision 23/11/2026). Request metrics are kept in memory per
// process/instance (they reset on restart and are not merged across Cloudflare instances); error logs are in DB.

const startedAt = new Date();
const WINDOW = 500;
const metrics = { total: 0, errors5xx: 0, errors4xx: 0, recent: [] };

/** Express middleware: counts requests and keeps the last 500 durations. */
export function requestMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.total += 1;
    if (res.statusCode >= 500) metrics.errors5xx += 1;
    else if (res.statusCode >= 400) metrics.errors4xx += 1;
    metrics.recent.push({ ms, status: res.statusCode, at: Date.now() });
    if (metrics.recent.length > WINDOW) metrics.recent.shift();
  });
  next();
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const DB_STATES = ["Đã ngắt kết nối", "Đã kết nối", "Đang kết nối", "Đang ngắt kết nối"];

async function database() {
  const state = mongoose.connection.readyState;
  if (state !== 1) return { state, stateLabel: DB_STATES[state] ?? String(state), pingMs: null };
  const started = Date.now();
  await mongoose.connection.db.admin().command({ ping: 1 });
  const pingMs = Date.now() - started;
  const stats = await mongoose.connection.db.stats().catch(() => null);
  return {
    state, stateLabel: DB_STATES[state], pingMs, name: mongoose.connection.name,
    collections: stats?.collections ?? null, dataSizeMb: stats ? mb(stats.dataSize) : null, storageSizeMb: stats ? mb(stats.storageSize) : null,
  };
}

export async function monitorOverview(user) {
  requirePermission(user, "system_monitor:read");
  const since = new Date(Date.now() - 86_400_000);
  const last5m = metrics.recent.filter((r) => r.at >= Date.now() - 5 * 60_000);
  const memory = process.memoryUsage();
  const [db, openErrors, errors24h, emailCounts, eventCounts, lastScan] = await Promise.all([
    database(),
    ErrorLog.countDocuments({ resolvedAt: null }),
    ErrorLog.countDocuments({ lastSeenAt: { $gte: since } }),
    Notification.aggregate([{ $match: { "emailDelivery.status": { $in: ["PENDING", "FAILED", "SENT"] } } }, { $group: { _id: "$emailDelivery.status", n: { $sum: 1 } } }]),
    SystemEvent.aggregate([{ $match: { status: { $in: ["PENDING", "PROCESSING", "FAILED"] } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    AppSetting.findOne({ key: "LOW_STOCK_LAST_SCAN" }).lean(),
  ]);
  const durations = metrics.recent.map((r) => r.ms);
  return {
    checkedAt: new Date(),
    server: {
      status: db.state === 1 ? "OK" : "DEGRADED",
      startedAt, uptimeSeconds: Math.round(process.uptime()),
      node: process.version, platform: `${process.platform} ${process.arch}`, hostname: os.hostname?.() ?? null,
      memory: { rssMb: mb(memory.rss), heapUsedMb: mb(memory.heapUsed), heapTotalMb: mb(memory.heapTotal) },
      loadAverage: os.loadavg?.().map((v) => Math.round(v * 100) / 100) ?? null,
      environment: process.env.NODE_ENV ?? "development",
    },
    requests: {
      total: metrics.total, errors5xx: metrics.errors5xx, errors4xx: metrics.errors4xx,
      last5Minutes: last5m.length, last5MinutesErrors: last5m.filter((r) => r.status >= 500).length,
      p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95), sample: durations.length,
    },
    database: db,
    errors: { open: openErrors, last24h: errors24h },
    background: {
      emailEnabled: notificationEmailEnabled(),
      emails: Object.fromEntries(emailCounts.map((c) => [c._id, c.n])),
      events: Object.fromEntries(eventCounts.map((c) => [c._id, c.n])),
      lowStockLastScan: lastScan?.value?.at ?? null,
    },
  };
}

export const errorQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["open", "resolved", "all"]).default("open"),
  source: z.enum(["HTTP", "WORKER", "PROCESS"]).optional(),
  search: z.string().trim().max(200).optional(),
});

export async function listErrorLogs(user, query) {
  requirePermission(user, "system_monitor:read");
  const filter = {};
  if (query.status === "open") filter.resolvedAt = null;
  if (query.status === "resolved") filter.resolvedAt = { $ne: null };
  if (query.source) filter.source = query.source;
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [{ message: pattern }, { path: pattern }, { errorName: pattern }];
  }
  const [rows, total] = await Promise.all([
    ErrorLog.find(filter).sort({ lastSeenAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    ErrorLog.countDocuments(filter),
  ]);
  const users = await User.find({ _id: { $in: rows.flatMap((r) => [r.lastUserId, r.resolvedBy]).filter(Boolean) } }).select("fullName").lean();
  const nameOf = (id) => users.find((u) => String(u._id) === String(id))?.fullName ?? null;
  return {
    total, page: query.page, limit: query.limit,
    items: rows.map((row) => ({
      id: String(row._id), level: row.level, source: row.source, statusCode: row.statusCode ?? null,
      method: row.method ?? null, path: row.path ?? null, message: row.message, errorName: row.errorName ?? null,
      stack: row.stack ?? null, count: row.count, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt,
      lastUser: nameOf(row.lastUserId), resolvedAt: row.resolvedAt ?? null, resolvedBy: nameOf(row.resolvedBy),
    })),
  };
}

export async function resolveErrorLog(user, id) {
  requirePermission(user, "system_monitor:read");
  if (!/^[a-f\d]{24}$/i.test(id)) throw notFoundError("Không tìm thấy lỗi");
  const row = await ErrorLog.findOneAndUpdate({ _id: id }, { $set: { resolvedAt: new Date(), resolvedBy: user._id } }, { new: true }).lean();
  if (!row) throw notFoundError("Không tìm thấy lỗi");
  await appendAudit({ actorId: user._id, action: "RESOLVE_ERROR_LOG", entityType: "error_logs", entityId: row._id, details: { reason: row.message.slice(0, 200) } }).catch(() => undefined);
  return { id: String(row._id), resolvedAt: row.resolvedAt };
}
