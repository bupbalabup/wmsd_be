import { Schema, options, text, code, ref, date } from "./model-utils.js";
import { optionalText, active } from "./schema-helpers.js";

// Collection: api_endpoints
// Catalogue of backend API endpoints (user decision 23/11/2026). SYSTEM rows are discovered from the Express
// router; MANUAL rows are added by an administrator. Administrators may edit name, description and URL.
export function createApiEndpointSchema() {
  const schema = new Schema(
    {
      method: code(["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"]),
      url: text(300),
      name: text(160),
      description: optionalText(2000),
      module: optionalText(80),
      source: code(["SYSTEM", "MANUAL"]),
      // False when a SYSTEM endpoint is no longer present in the running router.
      isPresent: { type: Boolean, default: true, required: true },
      isActive: active(),
      discoveredAt: date(false),
      updatedBy: ref("User", false),
    },
    options("api_endpoints"),
  );
  schema.index({ method: 1, url: 1 }, { unique: true });
  return schema;
}
