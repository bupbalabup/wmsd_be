import { requirePermission, requireWarehouseAccess, isOwner, hasPermission } from '../../shared/utils/access.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { notFoundError } from '../../shared/utils/ApiError.js';
import { dto } from '../../shared/utils/persistence.js';
import {
  GoodsReceipt,
  Warehouse,
  Supplier,
  TransferDispatch,
  StockTransaction,
  InventoryBalance,
  StockHoldingPoint,
  PurchaseReceipt,
  CustomerReturnReceipt,
  FailedDeliveryReceipt,
  TransferReceipt,
  OtherGoodsReceipt,
  CustomerReturn,
  WarehouseTransferRequest,
  SalesGoodsIssue,
  SalesOrder,
} from '../../models/runtime.js';
import { databaseId } from '../../models/document-identity.js';
import { exact } from '../../models/model-utils.js';
import { escapeRegex } from '../../shared/utils/movement-list.js';
import { enrichLineItems } from '../../shared/utils/document-items.js';
import { getDocument } from '../po-receiving/purchase-read.service.js';
import { purchaseOrderRef } from '../../shared/utils/purchase-core.js';
import { transferDispatchScope } from '../transfers/transfer.service.js';

const definitions = [
  ['purchase', 'PURCHASE', PurchaseReceipt, 'goods_receipt_inspection:read'],
  ['customer-return', 'CUSTOMER_RETURN', CustomerReturnReceipt, 'customer_return:read'],
  ['failed-delivery', 'FAILED_DELIVERY', FailedDeliveryReceipt, 'failed_delivery:read'],
  ['transfer', 'TRANSFER', TransferReceipt, 'stock_transfer:read'],
  ['other', 'OTHER', OtherGoodsReceipt, 'goods_receipt_other:read'],
];

export const RECEIPT_KINDS = definitions.map(([path, kind, , permission]) => ({ path, kind, permission }));
const definitionByPath = new Map(definitions.map(entry => [entry[0], entry]));

const salesReceiptFields = 'documentNo documentKind workflowStatus version createdAt';
const salesTransferReceipt = ({ _id, documentNo, documentKind, workflowStatus, version, createdAt }, transferRequestId) =>
  dto({ _id, documentNo, documentKind, workflowStatus, version, createdAt, header: transferRequestId ? { transferRequestId } : {} });
const salesTransferFilter = async user => ({
  'header.dispatchId': { $in: await TransferDispatch.find(await transferDispatchScope(user)).distinct('_id') },
});

const response = (receipt, user) => {
  const value = dto(receipt);
  if (receipt.documentKind === 'OTHER') {
    const warehouse = currentRole(user)?.code === 'WAREHOUSE';
    const owner = currentRole(user)?.code === 'OWNER';
    value.capabilities = {
      edit: warehouse && hasPermission(user, 'goods_receipt_other:create') && receipt.workflowStatus === 'DRAFT',
      submit: warehouse && hasPermission(user, 'goods_receipt_other:create') && receipt.workflowStatus === 'DRAFT',
      cancel: warehouse && hasPermission(user, 'goods_receipt_other:create') && receipt.workflowStatus === 'DRAFT',
      approve: owner && hasPermission(user, 'goods_receipt_other:approve') && receipt.workflowStatus === 'PENDING_APPROVAL',
      post: warehouse && hasPermission(user, 'goods_receipt_other:post') && receipt.workflowStatus === 'APPROVED' && receipt.approvedVersion === receipt.version,
      reverse: warehouse && hasPermission(user, 'goods_receipt_other:reverse') && receipt.workflowStatus === 'POSTED',
    };
  }
  return value;
};

async function scopedDetail(user, receipt) {
  requireWarehouseAccess(user, receipt.header.warehouseId);
  if (receipt.documentKind === 'TRANSFER' && currentRole(user)?.code === 'SALES') {
    if (!receipt.header.dispatchId) throw notFoundError();
    const dispatch = await TransferDispatch.findOne({ _id: receipt.header.dispatchId, ...await transferDispatchScope(user) })
      .select('header.requestId').lean();
    if (!dispatch) throw notFoundError();
    return salesTransferReceipt(receipt, String(dispatch.header.requestId));
  }
  if (receipt.documentKind === 'CUSTOMER_RETURN' && currentRole(user)?.code === 'SALES'
    && !await CustomerReturn.exists({ _id: receipt.header.returnId, createdBy: user._id })) throw notFoundError();
  if (receipt.documentKind === 'FAILED_DELIVERY' && receipt.header.goodsIssueId && currentRole(user)?.code === 'SALES') {
    const issue = await SalesGoodsIssue.findById(receipt.header.goodsIssueId);
    if (!issue || !await SalesOrder.exists({ _id: issue.header.salesOrderId, createdBy: user._id })) throw notFoundError();
  }
  const value = response(receipt, user);
  const warehouse = await Warehouse.findById(receipt.header.warehouseId).select('name').lean();
  value.header.warehouseName = warehouse?.name;
  if (receipt.documentKind === 'TRANSFER') {
    const dispatch = await TransferDispatch.findById(receipt.header.dispatchId).select('header.requestId').lean();
    if (dispatch) value.header.transferRequestId = String(dispatch.header.requestId);
  }
  if (['CUSTOMER_RETURN', 'FAILED_DELIVERY'].includes(receipt.documentKind) && receipt.stockTransactionId) {
    const posting = await StockTransaction.findById(receipt.stockTransactionId).select('movements').lean();
    const moves = posting?.movements.filter(row => row.toBalanceId) ?? [];
    const balances = await InventoryBalance.find({ _id: { $in: moves.map(row => row.toBalanceId) } }).select('holdingPointId qualityStatus').lean();
    const points = await StockHoldingPoint.find({ _id: { $in: balances.map(row => row.holdingPointId) } }).select('locationId').lean();
    for (const item of value.items) {
      const movement = moves.find(row => String(row.sourceLineId) === item._id);
      const balance = balances.find(row => movement && String(row._id) === String(movement.toBalanceId));
      const point = points.find(row => balance && String(row._id) === String(balance.holdingPointId));
      if (point?.locationId) item.destinationLocationId = String(point.locationId);
      if (balance) item.qualityCode = balance.qualityStatus;
    }
  }
  await enrichLineItems(value.items);
  return value;
}

async function receiptDetail(user, Model, id, permission) {
  requirePermission(user, permission);
  const query = Model.findById(id);
  if (Model === TransferReceipt && currentRole(user)?.code === 'SALES') {
    query.select(`${salesReceiptFields} header.warehouseId header.dispatchId`).lean();
  }
  const receipt = await query;
  if (!receipt) throw notFoundError();
  return scopedDetail(user, receipt);
}

export async function listTransferReceipts(user, { page, limit, warehouseId, status }) {
  const [, , Model, permission] = definitionByPath.get('transfer');
  requirePermission(user, permission);
  if (warehouseId) requireWarehouseAccess(user, warehouseId);
  const sales = currentRole(user)?.code === 'SALES';
  const filter = { 'header.warehouseId': warehouseId ?? { $in: user.warehouseIds ?? [] }, ...(status && { workflowStatus: status }) };
  if (isOwner(user) && !warehouseId) delete filter['header.warehouseId'];
  if (sales) Object.assign(filter, await salesTransferFilter(user));
  const list = Model.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit);
  const [rows, total] = await Promise.all([
    sales ? list.select(salesReceiptFields).lean() : list,
    Model.countDocuments(filter),
  ]);
  if (sales) return { items: rows.map(row => salesTransferReceipt(row)), total, page, limit };
  const dispatches = await TransferDispatch.find({ _id: { $in: rows.map(row => row.header.dispatchId).filter(Boolean) } }).select('_id header.requestId').lean();
  const requests = await WarehouseTransferRequest.find({ _id: { $in: dispatches.map(row => row.header.requestId).filter(Boolean) } }).select('_id documentNo header').lean();
  const dispatchById = new Map(dispatches.map(row => [String(row._id), row]));
  const requestById = new Map(requests.map(row => [String(row._id), row]));
  const items = rows.map(row => {
    const dispatch = dispatchById.get(String(row.header.dispatchId));
    const request = dispatch && requestById.get(String(dispatch.header.requestId));
    return {
      ...response(row, user),
      transferId: request ? String(request._id) : undefined,
      transferDocumentNo: request?.documentNo,
      dispatchId: String(row.header.dispatchId),
    };
  });
  return { items, total, page, limit };
}

export async function listReceiptsByKind(user, path, { page, limit, warehouseId, status }) {
  const definition = definitionByPath.get(path);
  if (!definition) throw notFoundError();
  const [, , Model, permission] = definition;
  requirePermission(user, permission);
  if (warehouseId) requireWarehouseAccess(user, warehouseId);
  const filter = { 'header.warehouseId': warehouseId ?? { $in: user.warehouseIds ?? [] }, ...(status && { workflowStatus: status }) };
  if (isOwner(user) && !warehouseId) delete filter['header.warehouseId'];
  if (path === 'customer-return' && currentRole(user)?.code === 'SALES') {
    const sources = await CustomerReturn.find({ createdBy: user._id }).select('_id');
    filter['header.returnId'] = { $in: sources.map(row => row._id) };
  }
  if (path === 'failed-delivery' && currentRole(user)?.code === 'SALES') {
    const orders = await SalesOrder.find({ createdBy: user._id }).select('_id').lean();
    const issues = await SalesGoodsIssue.find({ 'header.salesOrderId': { $in: orders.map(row => row._id) } }).select('_id').lean();
    filter.$or = [{ 'header.goodsIssueId': { $exists: false } }, { 'header.goodsIssueId': { $in: issues.map(row => row._id) } }];
  }
  const [rows, total] = await Promise.all([
    Model.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Model.countDocuments(filter),
  ]);
  return { items: rows.map(row => response(row, user)), total, page, limit };
}

export async function getReceiptByKind(user, path, id) {
  const definition = definitionByPath.get(path);
  if (!definition) throw notFoundError();
  return receiptDetail(user, definition[2], id, definition[3]);
}

export async function listGoodsReceipts(user, query) {
  const { page, limit, kind, status, warehouseId, purchaseOrderId, q, from, to } = query;
  const role = currentRole(user)?.code;
  const allowed = definitions.filter(([, , , permission]) => hasPermission(user, permission));
  if (!allowed.length) requirePermission(user, definitions[0][3]);

  // The discriminator base lacks the variant header schema. Cast header IDs
  // explicitly here, as well as the historical PO document identity.
  const visible = allowed.filter(([, value]) => (!kind || value === kind) && (!purchaseOrderId || value === 'PURCHASE'));
  const purchaseOrderRefId = purchaseOrderId && databaseId(await purchaseOrderRef(purchaseOrderId));
  const clauses = [];
  for (const [, value] of visible) {
    const global = isOwner(user) || (value === 'PURCHASE' && role === 'ACCOUNTANT');
    if (warehouseId && !global && !(user.warehouseIds ?? []).some(id => String(id) === warehouseId)) continue;
    const scope = warehouseId ? { 'header.warehouseId': databaseId(warehouseId) }
      : global ? {} : { 'header.warehouseId': { $in: (user.warehouseIds ?? []).map(id => databaseId(String(id))) } };
    if (value === 'CUSTOMER_RETURN' && role === 'SALES') {
      scope['header.returnId'] = { $in: await CustomerReturn.find({ createdBy: user._id }).distinct('_id') };
    }
    if (value === 'FAILED_DELIVERY' && role === 'SALES') {
      const orders = await SalesOrder.find({ createdBy: user._id }).distinct('_id');
      const issues = await SalesGoodsIssue.find({ 'header.salesOrderId': { $in: orders } }).distinct('_id');
      scope.$or = [{ 'header.goodsIssueId': { $exists: false } }, { 'header.goodsIssueId': { $in: issues } }];
    }
    if (value === 'TRANSFER' && role === 'SALES') Object.assign(scope, await salesTransferFilter(user));
    if (purchaseOrderId) scope['header.purchaseOrderId'] = purchaseOrderRefId;
    clauses.push({ documentKind: value, ...scope });
  }
  if (!clauses.length) return { items: [], total: 0, page, limit };

  const filter = {
    $or: clauses,
    ...(status && { workflowStatus: status }),
    ...(q && { documentNo: { $regex: escapeRegex(q), $options: 'i' } }),
    ...((from || to) && { createdAt: { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) } }),
  };
  const [rows, total] = await Promise.all([
    GoodsReceipt.find(filter).setOptions({ strictQuery: false }).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).select('documentKind documentNo workflowStatus createdAt occurredAt header items.qtyBase items.baseUnitSnapshot').lean(),
    GoodsReceipt.countDocuments(filter).setOptions({ strictQuery: false }),
  ]);
  const [warehouses, suppliers] = await Promise.all([
    Warehouse.find({ _id: { $in: rows.map(row => row.header?.warehouseId).filter(Boolean) } }).select('name').lean(),
    Supplier.find({ _id: { $in: rows.map(row => row.header?.supplierId).filter(Boolean) } }).select('name').lean(),
  ]);
  const items = rows.map(({ items: rowItems, header, ...receipt }) => {
    if (receipt.documentKind === 'TRANSFER' && role === 'SALES') return salesTransferReceipt(receipt);
    const totals = new Map();
    for (const row of rowItems ?? []) {
      const unit = row.baseUnitSnapshot || null;
      totals.set(unit, (totals.get(unit) ?? exact('0')).plus(String(row.qtyBase)));
    }
    return dto({
      ...receipt,
      header: {
        ...header,
        warehouseName: warehouses.find(row => String(row._id) === String(header?.warehouseId))?.name,
        supplierName: suppliers.find(row => String(row._id) === String(header?.supplierId))?.name,
      },
      lineCount: rowItems?.length ?? 0,
      totalQtyBase: (rowItems ?? []).reduce((sum, row) => sum.plus(String(row.qtyBase)), exact('0')).toFixed(),
      totalsByBaseUnit: [...totals].map(([unit, quantity]) => ({ unit, quantity: quantity.toFixed() })),
    });
  });
  return { items, total, page, limit };
}

export async function getGoodsReceipt(user, id) {
  const sales = currentRole(user)?.code === 'SALES';
  const lookup = GoodsReceipt.findById(id);
  if (sales) lookup.select('documentKind');
  const receipt = await lookup.lean();
  const definition = definitions.find(([, kind]) => kind === receipt?.documentKind);
  if (!definition) throw notFoundError();
  if (sales && receipt.documentKind !== 'PURCHASE') return receiptDetail(user, definition[2], id, definition[3]);
  requirePermission(user, definition[3]);
  if (receipt.documentKind === 'PURCHASE') return getDocument(user, id, 'GR_PURCHASE');
  return scopedDetail(user, receipt);
}
