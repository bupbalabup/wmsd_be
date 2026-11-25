import { z } from "zod";
import * as m from "../../models/runtime.js";
import { hasPermission, isOwner } from "../../shared/utils/access.js";
import { escapeRegex } from "../../shared/utils/domain.js";

// Global quick search (user decision 23/11/2026). Each group is searched only when the caller holds its read
// permission; documents are limited to the caller's assigned warehouses unless they are the store owner.
// Opening a result still goes through the target screen's own server-side checks.

export const searchQuery = z.object({
  q: z.string().trim().min(2, "Nhập ít nhất 2 ký tự").max(100),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

const DOCUMENT_GROUPS = [
  { key: "purchase_orders", label: "Đơn mua hàng", model: "PurchaseOrder", permission: "purchase_order:read", path: "/purchase-orders" },
  { key: "replenishment_requests", label: "Đề nghị nhập hàng", model: "ReplenishmentRequest", permission: "replenishment_request:read", path: "/replenishments" },
  { key: "sales_orders", label: "Đơn bán", model: "SalesOrder", permission: "sales_order:read", path: "/orders" },
  { key: "goods_receipts", label: "Phiếu nhập kho", model: "GoodsReceipt", permission: "goods_receipt_other:read", path: "/receipts" },
  { key: "sales_goods_issues", label: "Phiếu xuất kho", model: "SalesGoodsIssue", permission: "goods_issue:read", path: "/goods-issues" },
  { key: "warehouse_transfer_requests", label: "Chuyển kho", model: "WarehouseTransferRequest", permission: "stock_transfer:read", path: "/transfers" },
  { key: "stocktakes", label: "Kiểm kê", model: "Stocktake", permission: "stocktake:read", path: "/stocktakes" },
  { key: "customer_returns", label: "Hàng khách trả", model: "CustomerReturn", permission: "customer_return:read", path: "/returns" },
  { key: "supplier_returns", label: "Trả hàng NCC", model: "SupplierReturn", permission: "supplier_return:read", path: "/supplier-returns" },
  { key: "defect_reports", label: "Hàng lỗi", model: "DefectReport", permission: "defect:read", path: "/defective-goods" },
];

// Vietnamese labels are derived on read; documents store only the status code.
const STATUS_LABELS = {
  DRAFT: "Nháp", OPEN: "Đang mở", CREATED: "Đã tạo", SUBMITTED: "Chờ duyệt", PENDING_APPROVAL: "Chờ duyệt",
  APPROVED: "Đã duyệt", ACCEPTED: "Đã chấp nhận", REJECTED: "Đã từ chối", REVISION_REQUIRED: "Cần chỉnh sửa",
  RETURNED: "Trả lại bổ sung", RELEASED: "Đã giao kho", READY: "Sẵn sàng xuất", PARTIAL: "Đang thực hiện",
  PICKED: "Đã soạn", ISSUED: "Đã xuất kho", HANDED_OVER: "Đã bàn giao vận chuyển", DISPATCHED: "Đã xuất trả",
  DELIVERED: "Đã giao", CONFIRMED: "Đã xác nhận", POSTED: "Đã ghi sổ", REVERSED: "Đã đảo",
  PLANNED: "Chờ kích hoạt", COUNTING: "Đang đếm", RECONCILING: "Chờ duyệt chênh lệch", IN_PROGRESS: "Đang thực hiện",
  INSPECTED: "Đã kiểm tra", AGREEMENT_PENDING: "Chờ thỏa thuận NCC", ACKNOWLEDGED: "Đã ghi biên nhận",
  RECORDED: "Đã ghi nhận", SUPERSEDED: "Đã được đính chính", RESOLVED: "Đã xử lý", ON_HOLD: "Tạm dừng",
  COMPLETED: "Hoàn tất", CLOSED: "Đã đóng", CANCELLED: "Đã hủy",
};

const item = (id, title, subtitle, href) => ({ id: String(id), title, subtitle: subtitle || null, href });

export async function quickSearch(user, { q, limit }) {
  const pattern = new RegExp(escapeRegex(q), "i");
  const scope = isOwner(user) ? {} : { "header.warehouseId": { $in: user.warehouseIds ?? [] } };
  const tasks = [];
  const add = (key, label, permission, run) => {
    if (hasPermission(user, permission)) tasks.push(run().then((items) => ({ key, label, items })));
  };

  add("products", "Sản phẩm", "product:read", async () =>
    (await m.Product.find({ $or: [{ sku: pattern }, { name: pattern }, { manufacturerCode: pattern }] }).limit(limit).select("sku name baseUnit").lean())
      .map((p) => item(p._id, `${p.sku} · ${p.name}`, `Đơn vị gốc: ${p.baseUnit}`, `/products/${p._id}`)));
  add("lots", "Lô hàng", "product_lot:read", async () => {
    const lots = await m.ProductBatch.find({ manufacturerLot: pattern }).limit(limit).select("manufacturerLot productId tone calibre").lean();
    const products = await m.Product.find({ _id: { $in: lots.map((l) => l.productId) } }).select("sku").lean();
    return lots.map((l) => item(l._id, `Lô ${l.manufacturerLot}`, [products.find((p) => String(p._id) === String(l.productId))?.sku, l.tone && `tông ${l.tone}`, l.calibre && `cỡ ${l.calibre}`].filter(Boolean).join(" · "), `/lots/${l._id}`));
  });
  add("suppliers", "Nhà cung cấp", "supplier:read", async () =>
    (await m.Supplier.find({ $or: [{ code: pattern }, { name: pattern }, { taxCode: pattern }] }).limit(limit).select("code name").lean())
      .map((s) => item(s._id, s.name, s.code, `/suppliers/${s._id}`)));
  add("warehouses", "Kho", "warehouse_location:read", async () =>
    (await m.Warehouse.find({ $or: [{ code: pattern }, { name: pattern }], ...(isOwner(user) ? {} : { _id: { $in: user.warehouseIds ?? [] } }) }).limit(limit).select("code name").lean())
      .map((w) => item(w._id, w.name, w.code, `/warehouses/${w._id}`)));
  add("users", "Tài khoản", "user:read", async () =>
    (await m.User.find({ $or: [{ username: pattern }, { fullName: pattern }, { email: pattern }] }).limit(limit).select("username fullName").lean())
      .map((u) => item(u._id, u.fullName, u.username, `/accounts/${u._id}`)));
  for (const group of DOCUMENT_GROUPS) {
    add(group.key, group.label, group.permission, async () =>
      (await m[group.model].find({ documentNo: pattern, ...scope }).sort({ createdAt: -1 }).limit(limit).select("documentNo workflowStatus createdAt").lean())
        .map((d) => item(d._id, d.documentNo, STATUS_LABELS[d.workflowStatus] || d.workflowStatus, `${group.path}/${encodeURIComponent(String(d._id))}`)));
  }

  const groups = (await Promise.all(tasks)).filter((g) => g.items.length);
  return { q, groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
}
