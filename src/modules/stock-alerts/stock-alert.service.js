import * as m from "../../models/runtime.js";
import { exact } from "../../models/model-utils.js";
import { canAccessWarehouse, hasPermission, requirePermission } from "../../shared/utils/access.js";
import { availableStock } from "../replenishments/replenishment.evaluation.js";
import { initialEmailDelivery } from "../notifications/email.js";

// Low-stock alerts (user decision 23/11/2026). A product is "below threshold" in a warehouse when its available
// GOOD, store-owned, unreserved stock in pickable storage locations (the same rule as replenishment evaluation)
// is lower than the product's minimumQty for that warehouse. Quantities are in the product's base unit.

const LOW_STOCK = "LOW_STOCK";
const conditionKey = (productId, warehouseId) => `${LOW_STOCK}:${productId}:${warehouseId}`;

/** Every configured product×warehouse threshold with its current availability. */
export async function evaluateThresholds({ warehouseFilter = () => true } = {}) {
  const products = await m.Product.find({ isActive: { $ne: false }, "stockThresholds.0": { $exists: true } })
    .select("sku name baseUnit stockThresholds").lean();
  const warehouses = await m.Warehouse.find({}).select("code name isActive").lean();
  const warehouseById = new Map(warehouses.map((w) => [String(w._id), w]));
  const rows = [];
  for (const product of products) {
    for (const threshold of product.stockThresholds) {
      const warehouse = warehouseById.get(String(threshold.warehouseId));
      if (!warehouse || warehouse.isActive === false || !warehouseFilter(threshold.warehouseId)) continue;
      const minimum = exact(String(threshold.minimumQty));
      const target = exact(String(threshold.targetQty ?? threshold.minimumQty));
      const available = await availableStock(product._id, threshold.warehouseId);
      const below = available.lt(minimum);
      rows.push({
        product: { id: String(product._id), sku: product.sku, name: product.name, baseUnit: product.baseUnit },
        warehouse: { id: String(warehouse._id), code: warehouse.code, name: warehouse.name },
        minimumQty: minimum.toFixed(),
        targetQty: target.toFixed(),
        availableQty: available.toFixed(),
        // Quantity needed to get back to the target level.
        shortageQty: below ? target.minus(available).toFixed() : "0",
        status: below ? "BELOW" : "OK",
      });
    }
  }
  return rows.sort((a, b) => (a.status === b.status ? a.product.sku.localeCompare(b.product.sku) : a.status === "BELOW" ? -1 : 1));
}

/** GET /stock-alerts: thresholds the caller can see (inventory:read + warehouse scope). */
export async function listStockAlerts(user, { status } = {}) {
  requirePermission(user, "inventory:read");
  const rows = await evaluateThresholds({ warehouseFilter: (id) => canAccessWarehouse(user, id) });
  const items = status ? rows.filter((row) => row.status === status) : rows;
  return { items, summary: { total: rows.length, below: rows.filter((row) => row.status === "BELOW").length } };
}

/**
 * Background scan: one notification per user per "below" episode. When stock recovers, open notifications of
 * that condition are marked RESOLVED; dropping below again starts a new episode (new notification).
 */
export async function scanLowStock(now = new Date()) {
  const rows = await evaluateThresholds();
  const recipients = await m.User.find({ isActive: true }).populate({ path: "roleId", populate: { path: "permissionIds" } }).lean();
  const eligible = recipients.filter((user) => hasPermission(user, "notification:read") && hasPermission(user, "inventory:read"));
  let created = 0;
  for (const row of rows) {
    const key = conditionKey(row.product.id, row.warehouse.id);
    if (row.status === "OK") {
      await m.Notification.updateMany({ conditionKey: key, conditionState: "BELOW" }, { $set: { conditionState: "RESOLVED", evaluatedAt: now } });
      continue;
    }
    for (const user of eligible) {
      if (!canAccessWarehouse(user, row.warehouse.id)) continue;
      const open = await m.Notification.exists({ recipientId: user._id, conditionKey: key, conditionState: "BELOW" });
      if (open) {
        await m.Notification.updateOne({ _id: open._id }, { $set: { evaluatedAt: now } });
        continue;
      }
      const result = await m.Notification.updateOne(
        { dedupKey: `${key}:${now.getTime()}:${user._id}` },
        { $setOnInsert: {
          recipientId: user._id, type: LOW_STOCK, eventKey: `${key}:${now.getTime()}`,
          sourceType: "products", sourceId: row.product.id, sourceVersion: 1, warehouseIds: [row.warehouse.id],
          title: `Tồn dưới ngưỡng: ${row.product.sku} tại ${row.warehouse.code}`,
          message: `${row.product.name}: khả dụng ${row.availableQty} ${row.product.baseUnit}, tối thiểu ${row.minimumQty} ${row.product.baseUnit}. Cần bổ sung ${row.shortageQty} ${row.product.baseUnit} để đạt mức mục tiêu ${row.targetQty}.`,
          occurredAt: now, conditionKey: key, conditionState: "BELOW", evaluatedAt: now,
          emailDelivery: initialEmailDelivery(user), createdAt: now, updatedAt: now,
        } },
        { upsert: true, timestamps: false, runValidators: true },
      );
      created += result.upsertedCount ?? 0;
    }
  }
  return { evaluated: rows.length, below: rows.filter((row) => row.status === "BELOW").length, created };
}
