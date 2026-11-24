import { Schema, options, text, code, integer, ref, date } from "./model-utils.js";
import { optionalText } from "./schema-helpers.js";

// Collection: error_logs
// Server-side errors captured by the error handler and background workers (user decision 23/11/2026).
// Identical errors (same fingerprint) are grouped: `count` and `lastSeenAt` grow instead of new rows.
// Request bodies, cookies and tokens are never stored.
export function createErrorLogSchema() {
  const schema = new Schema(
    {
      fingerprint: text(64, { immutable: true, unique: true }),
      level: code(["ERROR", "WARN"]),
      source: code(["HTTP", "WORKER", "PROCESS"]),
      statusCode: integer(0, { required: false }),
      method: optionalText(10),
      path: optionalText(300),
      message: text(1000),
      errorName: optionalText(120),
      stack: optionalText(8000),
      count: integer(1, { default: 1 }),
      firstSeenAt: date(),
      lastSeenAt: date(),
      lastUserId: ref("User", false),
      resolvedAt: date(false),
      resolvedBy: ref("User", false),
    },
    options("error_logs"),
  );
  schema.index({ lastSeenAt: -1 });
  schema.index({ resolvedAt: 1, lastSeenAt: -1 });
  return schema;
}
