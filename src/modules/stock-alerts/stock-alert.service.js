import * as m from "../../models/runtime.js";
import { exact } from "../../models/model-utils.js";
import { canAccessWarehouse, hasPermission, requirePermission } from "../../shared/utils/access.js";
import { availableStock } from "../replenishments/replenishment.evaluation.js";
import { initialEmailDelivery } from "../notifications/email.js";
import { currentSystemSettings } from "../settings/system-settings.service.js";

// Low-stock alerts (user decision 23/11/2026). A product is "below threshold" in a warehouse when its available
// GOOD, store-owned, unreserved stock in pickable storage locations (the same rule as replenishment evaluation)
// is lower than the product's minimumQty for that warehouse. Quantities are in the product's base unit.
// Since 25/11/2026 the Administrator may set (system settings) a default minimum for product×warehouse pairs that
// hold stock but have no threshold of their own, and a "near threshold" level (status NEAR, shown but not notified).

const LOW_STOCK = "LOW_STOCK";
const conditionKey = (productId, warehouseId) => `${LOW_STOCK}:${productId}:${warehouseId}`;

/** Product×warehouse pairs that have (or had) store-owned stock in a storage location of the warehouse. */
async function stockedPairs() {
  const balances = await m.InventoryBalance.find({ ownerType: "STORE" }).select("holdingPointId batchId").lean();
  const [points, batches] = await Promise.all([
    m.StockHoldingPoint.find({ _id: { $in: [...new Set(balances.map((b) => String(b.holdingPointId)))] }, type: "LOCATION" }).select("locationId").lean(),
    m.ProductBatch.find({ _id: { $in: [...new Set(balances.map((b) => String(b.batchId)))] } }).select("productId").lean(),
  ]);
  const locations = await m.WarehouseLocation.find({ _id: { $in: points.map((p) => p.locationId) } }).select("warehouseId").lean();
  const warehouseOfLocation = new Map(locations.map((l) => [String(l._id), String(l.warehouseId)]));
  const warehouseOfPoint = new Map(points.map((p) => [String(p._id), warehouseOfLocation.get(String(p.locationId))]));
  const productOfBatch = new Map(batches.map((b) => [String(b._id), String(b.productId)]));
  const pairs = new Set();
  for (const balance of balances) {
    const warehouseId = warehouseOfPoint.get(String(balance.holdingPointId));
    const productId = productOfBatch.get(String(balance.batchId));
    if (warehouseId && productId) pairs.add(`${productId}:${warehouseId}`);
  }
  return pairs;
}

/**
 * Every product×warehouse threshold with its current availability: the product's own thresholds, plus the default
 * minimum from system settings for stocked pairs without one (`source` PRODUCT or DEFAULT).
 */
export async function evaluateThresholds({ warehouseFilter = () => true, settings } = {}) {
  const config = settings ?? (await currentSystemSettings()).settings;
  const defaultMinimum = exact(String(config.defaultMinimumQty ?? "0"));
  const nearFactor = exact(String(100 + Number(config.nearThresholdPercent ?? 0))).div(exact("100"));
  const products = await m.Product.find(defaultMinimum.gt(exact("0")) ? { isActive: { $ne: false } } : { isActive: { $ne: false }, "stockThresholds.0": { $exists: true } })
    .select("sku name baseUnit stockThresholds").lean();
  const warehouses = await m.Warehouse.find({}).select("code name isActive").lean();
  const warehouseById = new Map(warehouses.map((w) => [String(w._id), w]));
  const usable = (warehouseId) => { const w = warehouseById.get(String(warehouseId)); return w && w.isActive !== false && warehouseFilter(warehouseId) ? w : null; };
  const pairs = products.flatMap((product) => (product.stockThresholds ?? [])
    .map((threshold) => ({ product, minimumQty: threshold.minimumQty, targetQty: threshold.targetQty, warehouseId: threshold.warehouseId, source: "PRODUCT" })));
  if (defaultMinimum.gt(exact("0"))) {
    const own = new Set(pairs.map((pair) => `${pair.product._id}:${pair.warehouseId}`));
    const productById = new Map(products.map((product) => [String(product._id), product]));
    for (const key of await stockedPairs()) {
      const [productId, warehouseId] = key.split(":");
      const product = productById.get(productId);
      if (product && !own.has(key)) pairs.push({ product, minimumQty: defaultMinimum.toFixed(), targetQty: null, warehouseId, source: "DEFAULT" });
    }
  }
  const visible = pairs.map((pair) => ({ ...pair, warehouse: usable(pair.warehouseId) })).filter((pair) => pair.warehouse);
  // Thresholds are independent reads, so they are evaluated concurrently (sequential evaluation made the owner
  // dashboard take ~8 s on the deployed database, 25/11/2026).
  const rows = await Promise.all(visible.map(async ({ product, minimumQty, targetQty, warehouseId, warehouse, source }) => {
      const minimum = exact(String(minimumQty));
      const target = exact(String(targetQty ?? minimumQty));
      const available = await availableStock(product._id, warehouseId);
      const below = available.lt(minimum);
      const near = !below && minimum.gt(exact("0")) && available.lt(minimum.times(nearFactor));
      return {
        product: { id: String(product._id), sku: product.sku, name: product.name, baseUnit: product.baseUnit },
        warehouse: { id: String(warehouse._id), code: warehouse.code, name: warehouse.name },
        minimumQty: minimum.toFixed(),
        targetQty: target.toFixed(),
        availableQty: available.toFixed(),
        // Quantity needed to get back to the target level.
        shortageQty: below ? target.minus(available).toFixed() : "0",
        status: below ? "BELOW" : near ? "NEAR" : "OK",
        source,
      };
  }));
  const rank = { BELOW: 0, NEAR: 1, OK: 2 };
  return rows.sort((a, b) => (a.status === b.status ? a.product.sku.localeCompare(b.product.sku) : rank[a.status] - rank[b.status]));
}

/** GET /stock-alerts: thresholds the caller can see (inventory:read + warehouse scope). */
export async function listStockAlerts(user, { status } = {}) {
  requirePermission(user, "inventory:read");
  const rows = await evaluateThresholds({ warehouseFilter: (id) => canAccessWarehouse(user, id) });
  const items = status ? rows.filter((row) => row.status === status) : rows;
  return { items, summary: { total: rows.length, below: rows.filter((row) => row.status === "BELOW").length, near: rows.filter((row) => row.status === "NEAR").length } };
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
    // Only BELOW is notified; NEAR is a warning shown on screens.
    if (row.status !== "BELOW") {
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
