import crypto from "node:crypto";
import mongoose from "mongoose";
import { ErrorLog } from "../../models/runtime.js";

// Persists unexpected server errors for the administrator's monitoring screen (user decision 23/11/2026).
// Identical errors are grouped by fingerprint. Never stores request bodies, query strings, cookies or tokens.
// Recording must never break the request or worker that failed, so every failure here is swallowed.

const OBJECT_ID_SEGMENT = /\/(?:[a-f\d]{24}|\d{2,})(?=\/|$)/gi;
// Document identities such as PX-KHO1-261123-0001 (upper case, ends with a sequence number).
const DOCUMENT_ID_SEGMENT = /\/[A-Z]{1,6}(?:-[A-Z0-9]+)*-\d{3,}(?=\/|$)/g;
const clip = (value, max) => (value == null ? undefined : String(value).slice(0, max));

/** Route template without ids, e.g. /api/users/<id>/status, so one bug is one row. */
export function normalizePath(path = "") {
  return String(path).split("?")[0].replace(OBJECT_ID_SEGMENT, "/:id").replace(DOCUMENT_ID_SEGMENT, "/:id").slice(0, 300);
}

const normalizeMessage = (message = "") => String(message).replace(/[a-f\d]{24}/gi, "<id>").replace(/\d+/g, "#").slice(0, 300);

export function errorFingerprint({ source, method, path, errorName, message }) {
  return crypto.createHash("sha256").update([source, method ?? "", normalizePath(path), errorName ?? "", normalizeMessage(message)].join("|")).digest("hex");
}

export async function recordError({ source = "HTTP", level = "ERROR", error, statusCode, method, path, userId }) {
  try {
    if (mongoose.connection.readyState !== 1) return;
    const message = clip(error?.message || String(error ?? "Unknown error"), 1000) || "Unknown error";
    const errorName = clip(error?.name, 120);
    const normalizedPath = path ? normalizePath(path) : undefined;
    const fingerprint = errorFingerprint({ source, method, path: normalizedPath, errorName, message });
    const now = new Date();
    await ErrorLog.updateOne(
      { fingerprint },
      {
        $setOnInsert: { fingerprint, source, level, method: clip(method, 10), path: normalizedPath, errorName, firstSeenAt: now },
        $set: { message, statusCode, stack: clip(error?.stack, 8000), lastSeenAt: now, ...(userId && { lastUserId: userId }) },
        // A resolved error that happens again is reopened.
        $unset: { resolvedAt: 1, resolvedBy: 1 },
        $inc: { count: 1 },
      },
      { upsert: true, runValidators: false },
    );
  } catch (logError) {
    console.error("[error-log] could not record error", logError?.message);
  }
}
