import { Schema, options, text, ref } from "./model-utils.js";
import { version } from "./schema-helpers.js";

// Collection: app_settings
// One document per setting key (e.g. SALES_POLICY). `value` is validated by the owning API, not by this schema,
// because each key has its own shape. Changes are versioned and audited (user decision 23/11/2026).
export function createAppSettingSchema() {
  const schema = new Schema(
    {
      key: text(80, { immutable: true, unique: true }),
      value: { type: Schema.Types.Mixed, required: true },
      version: version(),
      updatedBy: ref("User", false),
    },
    options("app_settings"),
  );
  return schema;
}
