import * as m from '../../models/runtime.js';
import { canAccessWarehouse, hasPermission } from '../../shared/utils/access.js';
import { getIssue } from '../goods-issues/goods-issue.service.js';
import { getPurchaseOrder } from '../purchase-orders/purchase-order.service.js';
import { readRequest } from '../replenishments/replenishment.commands.js';
import { getTransfer } from '../transfers/transfer.service.js';
import { getStocktake } from '../stocktake-closure/stocktake-closure.service.js';
import { getDocument } from '../po-receiving/purchase-read.service.js';

const scoped = (permission, Model) => async (user, id) => {
  if (!hasPermission(user, permission)) return false;
  const doc = await Model.findById(id).select('header.warehouseId').lean();
  return Boolean(doc?.header?.warehouseId && canAccessWarehouse(user, doc.header.warehouseId));
};

export const sources = {
  sales_goods_issues: ['/goods-issues', getIssue],
  replenishment_requests: ['/replenishments', async (user, id) =>
    hasPermission(user, 'replenishment_request:read') && readRequest(id, user)],
  purchase_orders: ['/purchase-orders', getPurchaseOrder],
  custody_receipts: ['/custody-receipts', (user, id) => getDocument(user, id, 'CUSTODY_RECEIPT')],
  goods_receipts: ['/receipts', scoped('goods_receipt_other:read', m.GoodsReceipt)],
  warehouse_transfer_requests: ['/transfers', getTransfer],
  stocktakes: ['/stocktakes', getStocktake],
  customer_returns: ['/returns', scoped('customer_return:read', m.CustomerReturn)],
  supplier_returns: ['/supplier-returns', scoped('supplier_return:read', m.SupplierReturn)],
  defect_reports: ['/defective-goods', scoped('defect:read', m.DefectReport)],
  // Low-stock alerts (23/11/2026): readable by anyone who may read inventory; warehouse scope is checked on the item.
  // Shortage alerts on customer purchase requests (26/11/2026) for Owner and Accountant.
  sales_orders: ['/orders', async (user, id) => hasPermission(user, 'sales_order:read') && Boolean(await m.SalesOrder.exists({ _id: id }))],
  products: ['/products', async (user, id) => hasPermission(user, 'inventory:read') && Boolean(await m.Product.exists({ _id: id }))],
};

export async function canReadSource(user, item) {
  const source = sources[item.sourceType];
  if (!source || (item.warehouseIds?.length &&
      !item.warehouseIds.some(id => canAccessWarehouse(user, id)))) return false;
  try {
    return Boolean(await source[1](user, String(item.sourceId)));
  } catch (error) {
    if ([403, 404].includes(error.statusCode)) return false;
    throw error;
  }
}
