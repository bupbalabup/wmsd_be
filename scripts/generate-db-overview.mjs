import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { modelNames, registerModels } from '../src/models/index.js';
import { embeddedTables } from '../src/models/consolidation.js';
import { renderFullRelationships } from './render-full-db-relationships.mjs';

const output = new URL('../git_doc/docs/03_thiet_ke/DB_Current_2026-11-12_58/', import.meta.url);
const diagramFile = new URL('WMSD_DB_Design_Overview.drawio', output);
const relationFile = new URL('WMSD_Overview_Relationships.md', output);
const modelDir = new URL('../src/models/', import.meta.url);

const layout = [
  'permissions roles users app_settings api_endpoints error_logs notifications system_events attachments',
  'approval_history audit_logs operation_records stock_reversals stock_reservations stock_holding_points warehouse_locations',
  'stocktake_location_locks stocktake_snapshots opening_stocks stock_transactions inventory_balances supply_allocations warehouses',
  'stocktake_counts stocktakes stocktake_plans categories product_batches products conversions uoms',
  'stock_adjustments defect_reports stock_scrap_records stock_quality_changes external_references customers sales_orders warehouse_issue_requests delivery_orders delivery_schedules',
  'custody_receipts supplier_return_issues supplier_returns suppliers sales_invoices return_quantity_claims customer_returns sales_goods_issues return_source_locks',
  'custody_releases replenishment_requests purchase_orders goods_arrivals goods_inspections goods_receipts failed_deliveries',
  'warehouse_transfer_requests transfer_dispatches stock_discrepancies internal_transfer_requirements transfer_orders',
].map(row => row.split(' '));

// One tab per business group, after the overview tab. A name ending in * is a key-only card for a
// collection shown in full on another tab; - leaves a grid cell empty.
const groups = [
  ['he-thong', 'Phân quyền và quản trị hệ thống', [
    'permissions roles users notifications', 'warehouses* app_settings api_endpoints attachments error_logs', 'system_events']],
  ['phe-duyet', 'Phê duyệt và nhật ký', [
    'approval_history operation_records stock_transactions*', 'replenishment_requests* audit_logs']],
  ['danh-muc', 'Danh mục hàng hóa', [
    'categories products product_batches inventory_balances*', 'warehouses* uoms conversions']],
  ['ton-kho', 'Kho và tồn kho', [
    'users* warehouses warehouse_locations stock_holding_points', 'products* supply_allocations product_batches* inventory_balances operation_records*',
    'opening_stocks stock_reservations stock_reversals stock_transactions audit_logs*']],
  ['kiem-ke', 'Kiểm kê và điều chỉnh', [
    'stocktake_plans stocktakes stocktake_snapshots', 'stock_adjustments stocktake_location_locks stocktake_counts']],
  ['hang-loi', 'Xử lý hàng lỗi', ['stock_scrap_records defect_reports stock_quality_changes']],
  ['mua-hang', 'Mua hàng và nhập kho', [
    'approval_history* replenishment_requests purchase_orders goods_arrivals goods_inspections',
    'suppliers supplier_returns* - goods_receipts custody_receipts',
    'customer_returns* custody_releases transfer_dispatches* internal_transfer_requirements*']],
  ['ban-hang', 'Bán hàng và xuất kho', [
    'warehouse_issue_requests sales_orders customers delivery_schedules', 'delivery_orders sales_goods_issues sales_invoices',
    'customer_returns* return_source_locks* failed_deliveries return_quantity_claims*']],
  ['tra-hang', 'Trả hàng', [
    'external_references sales_goods_issues* return_source_locks', 'goods_receipts* customer_returns return_quantity_claims failed_deliveries*',
    'suppliers* supplier_returns supplier_return_issues custody_releases*']],
  ['dieu-chuyen', 'Điều chuyển kho', [
    'warehouse_transfer_requests transfer_dispatches stock_discrepancies', 'goods_receipts* internal_transfer_requirements transfer_orders']],
].map(([id, name, rows]) => ({ id, name, rows: rows.map(row => row.split(' ')) }));

// Each row identifies the collection storing the path and the collection it references.
// Diagram edges point from the target of the reference to the collection storing it.
const primaryRefs = [
  ['roles', 'permissionIds', 'permissions', '0..n', '0..n'],
  ['users', 'roleId', 'roles', '1', '0..n'],
  ['users', 'warehouseIds', 'warehouses', '0..n', '0..n'],
  ['notifications', 'recipientId', 'users', '1', '0..n'],
  ['app_settings', 'updatedBy', 'users', '0..1', '0..n'],
  ['api_endpoints', 'updatedBy', 'users', '0..1', '0..n'],
  ['error_logs', 'lastUserId', 'users', '0..1', '0..n'],
  ['error_logs', 'resolvedBy', 'users', '0..1', '0..n'],
  ['attachments', 'uploadedBy', 'users', '1', '0..n'],
  ['operation_records', 'stockTransactionId', 'stock_transactions', '0..1', '0..n'],
  ['operation_records', 'decisionId', 'approval_history', '0..1', '0..n'],
  ['audit_logs', 'decisionId', 'approval_history', '0..1', '0..n'],
  ['audit_logs', 'operationId', 'operation_records', '0..1', '0..n'],
  ['audit_logs', 'transactionId', 'stock_transactions', '0..1', '0..n'],
  ['replenishment_requests', 'header.latestDecisionId', 'approval_history', '0..1', '0..n'],
  ['products', 'categoryId', 'categories', '1', '0..n'],
  ['products', 'stockThresholds[].warehouseId', 'warehouses', '0..n', '0..n'],
  ['product_batches', 'productId', 'products', '1', '0..n'],
  ['conversions', 'productId', 'products', '1', '0..n'],
  ['conversions', 'productBatchId', 'product_batches', '0..1', '0..n'],
  ['conversions', 'uomId', 'uoms', '1', '0..n'],
  ['warehouse_locations', 'warehouseId', 'warehouses', '1', '0..n'],
  ['stock_holding_points', 'locationId', 'warehouse_locations', '0..1', '0..1'],
  ['inventory_balances', 'holdingPointId', 'stock_holding_points', '1', '0..n'],
  ['inventory_balances', 'batchId', 'product_batches', '1', '0..n'],
  ['stock_transactions', 'movements[].fromBalanceId', 'inventory_balances', '0..n', '0..n'],
  ['stock_transactions', 'movements[].toBalanceId', 'inventory_balances', '0..n', '0..n'],
  ['stock_reservations', 'balanceId', 'inventory_balances', '1', '0..n'],
  ['stock_reservations', 'sourceAllocationId', 'supply_allocations', '0..1', '0..n'],
  ['supply_allocations', 'destinationWarehouseId', 'warehouses', '1', '0..n'],
  ['stocktakes', 'header.planId', 'stocktake_plans', '0..1', '0..n'],
  ['stocktake_snapshots', 'stocktakeId', 'stocktakes', '1', '0..n'],
  ['stocktake_counts', 'snapshotId', 'stocktake_snapshots', '0..1', '0..n'],
  ['stocktake_counts', 'stocktakeId', 'stocktakes', '1', '0..n'],
  ['stocktake_location_locks', 'stocktakeId', 'stocktakes', '1', '0..n'],
  ['stock_adjustments', 'header.stocktakeId', 'stocktakes', '0..1', '0..n'],
  ['stock_reversals', 'header.originalTransactionId', 'stock_transactions', '0..1', '0..n'],
  ['purchase_orders', 'header.supplierId', 'suppliers', '1', '0..n'],
  ['goods_arrivals', 'header.purchaseOrderId', 'purchase_orders', '0..1', '0..n'],
  ['goods_inspections', 'header.arrivalId', 'goods_arrivals', '0..1', '0..n'],
  ['goods_receipts', '{PURCHASE}.header.purchaseOrderId', 'purchase_orders', '0..1', '0..n'],
  ['transfer_orders', 'header.requirementId', 'internal_transfer_requirements', '0..1', '0..1'],
  ['sales_goods_issues', 'header.salesOrderId', 'sales_orders', '0..1', '0..n'],
  ['failed_deliveries', 'header.goodsIssueId', 'sales_goods_issues', '0..1', '0..n'],
  ['sales_invoices', 'salesOrderId', 'sales_orders', '1', '0..n'],
  ['sales_invoices', 'items[].goodsIssueId', 'sales_goods_issues', '0..n', '0..n'],
  ['supplier_returns', 'header.supplierId', 'suppliers', '1', '0..n'],
  ['supplier_return_issues', 'header.supplierReturnId', 'supplier_returns', '0..1', '0..n'],
  ['goods_receipts', '{CUSTOMER_RETURN}.header.returnId', 'customer_returns', '0..1', '0..n'],
  ['sales_orders', 'header.customerId', 'customers', '0..1', '0..n'],
  ['sales_invoices', 'customerId', 'customers', '1', '0..n'],
  ['sales_goods_issues', 'header.deliveryOrderId', 'delivery_orders', '0..1', '0..n'],
  ['delivery_schedules', 'salesOrderId', 'sales_orders', '1', '0..1'],
  ['delivery_schedules', 'deliveries[].doId', 'delivery_orders', '0..n', '0..n'],
  ['opening_stocks', 'header.warehouseId', 'warehouses', '0..1', '0..n'],
  ['custody_releases', 'acknowledgements[].header.supplierReturnId', 'supplier_returns', '0..n', '0..n'],
];

// These links require a business rule or discriminator to identify the target.
// The relationship table records the scope of each index or service rule.
const purchase = 'src/modules/goods-inspections/goods-inspection.service.js';
const transfer = 'src/modules/transfers/transfer-write.service.js';
const returns = 'src/modules/return-workflows/native.service.js';
const directSales = 'src/modules/goods-issues/direct-sales.service.js';
const logical = [
  ['products', 'baseUnit', 'uoms', 'src/modules/products/product.service.js', 'Uom.code', '1', '0..n'],
  ['purchase_orders', 'replenishmentRequestId', 'replenishment_requests', 'src/modules/purchase-orders/purchase-order.commands.js', 'Tối đa một PO đang hiệu lực cho mỗi RR có liên kết. Khi hủy PO, lịch sử còn ở sources[].', '0..1', '0..1'],
  ['purchase_orders', 'sources[].documentId', 'replenishment_requests', 'src/modules/purchase-orders/purchase-order.commands.js', 'Lịch sử RR liên kết, gồm PO đã hủy.'],
  ['goods_receipts', '{PURCHASE}.sources[].documentId', 'purchase_orders', purchase, 'subjectCollection = purchase_orders, bên cạnh liên kết qua header.purchaseOrderId.'],
  ['goods_receipts', '{PURCHASE}.sources[].documentId', 'goods_inspections', purchase, 'subjectCollection = goods_inspections, trong luồng nhập mua hiện hành.', '1', '0..n'],
  ['goods_receipts', '{PURCHASE}.items[].sources[].itemId', 'goods_inspections', purchase, 'Đích là dòng items[] của phiếu kiểm nhận cùng documentId.'],
  ['custody_receipts', 'sources[].documentId', 'goods_inspections', purchase, 'subjectCollection = goods_inspections, trong luồng nhập hàng giữ hộ từ kiểm nhận.', '1', '0..n'],
  ['transfer_dispatches', 'header.requestId', 'warehouse_transfer_requests', transfer, 'Phiếu xuất từng đợt của yêu cầu điều chuyển.', '1', '0..n'],
  ['goods_receipts', '{TRANSFER}.header.dispatchId', 'transfer_dispatches', transfer, 'Chứng từ nguồn cũng được lưu qua sources[].', '1', '0..n'],
  ['goods_receipts', '{TRANSFER}.sources[].documentId', 'transfer_dispatches', transfer, 'subjectCollection = transfer_dispatches.'],
  ['goods_receipts', '{TRANSFER}.items[].sources[].itemId', 'transfer_dispatches', transfer, 'Đích là dòng items[] trong phiếu xuất đã xác định bằng documentId.'],
  ['internal_transfer_requirements', 'header.sourceDocumentId', 'transfer_dispatches', transfer, 'sourceType = transfer_dispatches', '1', '0..1'],
  ['internal_transfer_requirements', 'header.sourceDocumentId', 'goods_receipts', transfer, 'sourceType = goods_receipts, phiếu TRANSFER', '1', '0..1'],
  ['stock_discrepancies', 'header.sourceRef.documentId', 'transfer_dispatches', 'src/modules/transfers/transfer-differences.js', 'Báo thiếu hàng đang chuyển.', '1', '0..n'],
  ['customer_returns', 'items[].sources[].documentId', 'sales_goods_issues', returns, 'RETURN_SOURCE, dòng xuất đã có căn cứ nhận hàng.', '0..1', '0..n'],
  ['customer_returns', 'items[].sources[].documentId', 'external_references', returns, 'RETURN_SOURCE, chứng từ ngoài đã xác minh.', '0..1', '0..n'],
  ['return_quantity_claims', 'requestLineId', 'customer_returns', returns, 'claimKind = CR. ID dòng items[] của phiếu khách trả.', '1', '0..n'],
  ['return_quantity_claims', 'requestLineId', 'failed_deliveries', returns, 'claimKind = FD. ID dòng items[] của hồ sơ giao thất bại.', '1', '0..n'],
  ['return_quantity_claims', 'sourceLineId', 'sales_goods_issues', returns, 'sourceKind = GOODS_ISSUE hoặc DELIVERY_CONFIRMATION. ID được lưu vẫn là dòng phiếu xuất.'],
  ['return_quantity_claims', 'sourceLineId', 'external_references', returns, 'sourceKind = EXTERNAL. ID dòng chứng từ lịch sử đã xác minh.'],
  ['return_source_locks', 'sourceDocumentId', 'sales_goods_issues', directSales, 'sourceKind = sales_goods_issues. Khóa theo sourceItemId của dòng phiếu xuất.', '1', '0..n'],
  ['return_source_locks', 'sourceDocumentId', 'sales_orders', directSales, 'sourceKind = sales_orders. Khóa dòng đơn bán khi lập hoặc ghi xuất.'],
  ['return_source_locks', 'sourceDocumentId', 'external_references', returns, 'sourceKind = external_references. Khóa dòng chứng từ ngoài khi kiểm lượng khách trả.'],
  ['return_source_locks', 'sourceDocumentId', 'goods_receipts', returns, 'sourceKind = goods_receipts. Khóa dòng phiếu nhập mua khi đề nghị trả NCC.'],
  ['return_source_locks', 'sourceDocumentId', 'custody_receipts', returns, 'sourceKind = custody_receipts. Khóa dòng nhập giữ hộ NCC khi đề nghị trả.'],
  ['approval_history', 'subjectId', 'replenishment_requests', 'src/modules/replenishments/replenishment.commands.js', 'subjectType = replenishment_requests. RR lưu chiều ngược ở header.latestDecisionId.'],
  ['approval_history', 'subjectId', 'goods_receipts', 'src/modules/goods-receipts/other-receipt.service.js', 'subjectType = goods_receipts. Phiếu OTHER lưu chiều ngược ở approvalDecisionId.'],
  ['approval_history', 'subjectId', 'customer_returns', returns, 'subjectType = customer_returns. Quyết định nhận hàng hoặc xử lý ngoại lệ.'],
  ['audit_logs', 'subjectId', 'app_settings', 'src/modules/settings/sales-policy.service.js', 'subjectType = app_settings, thao tác đổi chính sách bán hàng.'],
  ['audit_logs', 'subjectId', 'api_endpoints', 'src/modules/system/api-catalogue.service.js', 'subjectType = api_endpoints, thao tác thêm, sửa hoặc xóa API theo ID.'],
  ['audit_logs', 'subjectId', 'error_logs', 'src/modules/system/monitor.service.js', 'subjectType = error_logs, thao tác đánh dấu đã xử lý.'],
  ['stock_scrap_records', 'header.planId', 'defect_reports', returns, 'Đích là resolutionPlans[] của báo lỗi. sources[].documentId lưu ID báo lỗi.', '1', '0..n'],
  ['stock_quality_changes', 'header.planId', 'defect_reports', returns, 'Đích là resolutionPlans[] của báo lỗi. sources[].documentId lưu ID báo lỗi.', '1', '0..n'],
  ['stock_holding_points', 'dispatchLineId', 'transfer_dispatches', 'src/models/stock-holding-point.model.js', 'type = IN_TRANSIT. ID dòng items[] của phiếu xuất, duy nhất theo index riêng.'],
  ['warehouse_issue_requests', 'header.salesOrderId', 'sales_orders', 'src/modules/goods-issues/goods-issue.service.js', 'Tương thích nhánh xuất qua yêu cầu xuất.', '1', '0..n'],
  ['delivery_orders', 'header.issueRequestId', 'warehouse_issue_requests', 'src/modules/goods-issues/goods-issue.service.js', 'Tương thích nhánh xuất qua lệnh giao.', '1', '0..n'],
  ['transfer_orders', 'sources[].documentId', 'sales_goods_issues', 'src/modules/goods-issues/goods-issue.service.js', 'Service của nhánh xuất có lấy hàng tra trực tiếp TransferOrder bằng nguồn sales_goods_issues.'],
  ['stocktakes', 'header.scopeLocationIds', 'warehouse_locations', 'src/modules/stocktake-closure/stocktake-count-sheet.service.js', 'Phần tử khai báo alias Location. Service tra WarehouseLocation theo ID và kho của phiếu.'],
  ['inventory_balances', 'ownerId', 'suppliers', 'src/models/inventory-balance.model.js', 'ownerType = SUPPLIER. STORE dùng null.'],
  ['inventory_balances', 'ownerId', 'customers', 'src/models/inventory-balance.model.js', 'ownerType = CUSTOMER. STORE dùng null.'],
];

const connection = mongoose.createConnection();
const models = registerModels(connection);
const targetForModel = new Map([...models].flatMap(([collection, model]) =>
  [model.modelName, ...Object.keys(model.discriminators ?? {})].map(name => [name, collection])));
const sourceForCollection = new Map();
for (const name of (await readdir(modelDir)).filter(file => file.endsWith('.model.js'))) {
  const collection = (await readFile(new URL(name, modelDir), 'utf8')).match(/\/\/ Collection: (\w+)/)?.[1];
  if (collection) sourceForCollection.set(collection, `src/models/${name}`);
}

const cards = new Map();
const references = new Map();
const variants = [];
const sourceLink = path => `[${path.split('/').at(-1)}](../../../../${path})`;
const referenceKey = (collection, path, target) => `${collection}|${path}|${target}`;
const variantName = (schema, name) => schema.discriminatorMapping?.value ?? name;

function extract(collection, schema, fields, prefix = '', base = null, sharedVariant = false) {
  schema.eachPath((name, path) => {
    const inherited = base?.path(name);
    if (inherited) {
      assert.equal(path.instance, inherited.instance, `${collection}.${prefix}${name}: variant changes an inherited type`);
      return;
    }
    const fieldPath = prefix + name;
    const fieldType = path.$isSingleNested || path.instance === 'Embedded' ? 'Object' : path.instance;
    fields.set(fieldPath, fieldType);
    const options = path.options;
    const element = path.getEmbeddedSchemaType?.()?.options ?? path.$embeddedSchemaType?.options;
    const raw = Array.isArray(options.type) ? options.type[0] : null;
    const ref = options.ref ?? element?.ref ?? raw?.ref;
    const embedded = options.embeddedTarget ?? element?.embeddedTarget ?? raw?.embeddedTarget;
    const logicalKind = options.logicalReference ?? element?.logicalReference ?? raw?.logicalReference;
    const embeddedModel = embedded && embeddedTables[embedded];
    const target = targetForModel.get(modelNames[ref] ?? ref) ??
      (embeddedModel?.[0] === 'failed_delivery_receipts' ? 'goods_receipts' : embeddedModel?.[0]);
    if (target || ref || logicalKind) {
      const note = sharedVariant ? 'Khai báo theo biến thể dòng dùng chung.' : '';
      const kind = embedded ? 'ID nhúng' : target ? 'Mongoose ref' : 'Đích theo ngữ cảnh';
      const relationTarget = target ?? (ref ? `Model ${ref}` : `Theo chứng từ chứa ${logicalKind === 'item' ? 'dòng' : 'ID'}`);
      references.set(referenceKey(collection, fieldPath, relationTarget), {
        collection, path: fieldPath, target: relationTarget, kind, type: fieldType, required: options.required === true, sharedVariant,
        evidence: sourceLink(sourceForCollection.get(collection)),
        note: [embeddedModel?.[1] && `Đích nhúng: ${embeddedModel[1]}[].`, note].filter(Boolean).join(' '),
      });
    }
    if (path.schema) {
      const next = `${fieldPath}${fieldType === 'Array' ? '[]' : ''}.`;
      extract(collection, path.schema, fields, next, null, sharedVariant);
    }
  });
  for (const [name, variant] of Object.entries(schema.discriminators ?? {})) {
    extract(collection, variant, fields, `${prefix}{${variantName(variant, name)}}.`, schema, sharedVariant || !!prefix);
  }
  for (const name of Object.keys(schema.nested)) {
    if (!base?.nested[name]) fields.set(prefix + name, 'Object');
  }
}

for (const [collection, model] of models) {
  assert(sourceForCollection.has(collection), `Missing model source for ${collection}`);
  const paths = new Map();
  extract(collection, model.schema, paths);
  const fields = new Map();
  for (const [path, type] of paths) {
    const match = path.match(/^(?:\{([^}]+)\}\.)?([^.]+)$/);
    if (!match) continue;
    const [, variant, field] = match;
    assert(!fields.has(field) || fields.get(field) === type, `${collection}.${field}: variant types differ`);
    fields.set(field, type);
    if (variant) variants.push([collection, field, variant]);
  }
  cards.set(collection, { fields, paths });
}

function selectRelation(relation, parentCount, childCount) {
  const { collection, target } = relation;
  assert(cards.has(collection) && cards.has(target), `Invalid diagram endpoints: ${collection}, ${target}`);
  relation.overview = true;
  relation.cardinality = `${parentCount} ↔ ${childCount}`;
  const edgeId = `${target}_${collection}_${relation.kind === 'Mongoose ref' ? 'ref' : 'source'}`;
  const existing = edges.get(edgeId);
  if (existing) {
    assert.equal(existing.parentCount, parentCount, edgeId);
    assert.equal(existing.childCount, childCount, edgeId);
  } else {
    edges.set(edgeId, { id: edgeId, target, collection, parentCount, childCount });
  }
}

const edges = new Map();
for (const [collection, path, target, from, to] of primaryRefs) {
  const relation = references.get(referenceKey(collection, path, target));
  assert.equal(relation?.kind, 'Mongoose ref', `Review overview ref: ${collection}.${path} → ${target}`);
  const cardinality = relation.type === 'Array' || path.includes('[].') ? '0..n' : relation.required ? '1' : '0..1';
  assert.equal(from, cardinality, `Review schema cardinality: ${collection}.${path}`);
  selectRelation(relation, from, to);
}

for (const [collection, path, target, source, note, from, to] of logical) {
  const paths = cards.get(collection)?.paths;
  const type = paths?.get(path) ?? paths?.get(path.replace(/^\{[^}]+\}\./, ''));
  assert(type && cards.has(target), `Review logical ref: ${collection}.${path} → ${target}`);
  const relation = { collection, path, target, type, kind: 'Tham chiếu nghiệp vụ', evidence: sourceLink(source), note };
  references.set(referenceKey(collection, path, target), relation);
  if (from) selectRelation(relation, from, to);
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fieldFont = 'Courier New';
const headerHeight = 30;
const lineHeight = 16;
const horizontalPadding = 10;
const cardFieldKey = ({ collection, path }) => `${collection}.${path.replace(/^\{[^}]+\}\./, '')}`;
const targetsByField = new Map();
for (const relation of references.values()) {
  const field = cardFieldKey(relation);
  if (!targetsByField.has(field)) targetsByField.set(field, new Set());
  targetsByField.get(field).add(relation.target);
}
const refFields = new Set([...references.values()].filter(relation => cards.has(relation.target))
  .filter(relation => relation.kind === 'Mongoose ref' ||
    (relation.overview && targetsByField.get(cardFieldKey(relation)).size === 1))
  .map(cardFieldKey));

for (const [collection, card] of cards) {
  assert(card.fields.has('_id'), `${collection} has no primary key`);
  card.rows = [...card.fields.entries()].sort(([first], [second]) => (second === '_id') - (first === '_id'))
    .map(([field, type]) => {
      const hasRef = refFields.has(`${collection}.${field}`);
      const marker = field === '_id' ? 'PK' : hasRef ? 'FK' : '';
      return { marker, label: `${field}: ${type}` };
    });
  const maxRow = Math.max(...card.rows.map(row => row.label.length + (row.marker ? 3 : 0)));
  // Both fonts have fixed sizes. Round up to cover platform font substitution.
  card.width = Math.max(136, maxRow * 7 + 2 * horizontalPadding, collection.length * 8 + 2 * horizontalPadding);
  card.height = headerHeight + card.rows.length * lineHeight + 2 * horizontalPadding;
}

assert.deepEqual(layout.flat().sort(), [...models.keys()].sort(), 'Overview layout must cover the current registry exactly');

const columnGap = 112;
const rowGap = 104;

// The overview tabs use the font of the saved draw.io file. The full diagram keeps the default fonts.
const overviewFont = 'Helvetica';

function rectangle(id, value, style, x, y, width, height, parent = '1') {
  const connectable = parent === '1' ? '' : ' connectable="0"';
  return `<mxCell id="${id}" value="${xml(value)}" style="${style}" vertex="1" parent="${parent}"${connectable}><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`;
}

function table(collection, card, font, prefix = '') {
  const { x, y, width, height, rows } = card;
  const id = `${prefix}t_${collection}`;
  const extra = font ? `fontFamily=${font};` : '';
  const heading = `html=1;align=center;verticalAlign=middle;fillColor=#EFF5FA;strokeColor=none;fontFamily=${font ?? 'Arial'};fontSize=13;fontStyle=1;spacing=0;`;
  const textStyle = `text;html=1;align=left;verticalAlign=top;overflow=fill;whiteSpace=nowrap;fontFamily=${font ?? fieldFont};fontSize=11;fontColor=#17263A;spacing=0;`;
  const labels = rows.map(({ marker, label }) => `<div style="height:${lineHeight}px;line-height:${lineHeight}px;white-space:nowrap;">${marker ? `<b style="color:#1F4E79">${marker}</b> ` : ''}${xml(label)}</div>`).join('');
  return [
    rectangle(id, '', `rounded=0;container=1;collapsible=0;recursiveResize=0;fillColor=#FFFFFF;strokeColor=#8091A7;strokeWidth=1.25;${extra}`, x, y, width, height),
    rectangle(`${prefix}h_${collection}`, collection, heading, 1, 1, width - 2, headerHeight - 1, id),
    rectangle(`${prefix}line_${collection}`, '', `fillColor=#8091A7;strokeColor=none;${extra}`, 0, headerHeight, width, 1, id),
    rectangle(`${prefix}fields_${collection}`, labels, textStyle, horizontalPadding, headerHeight + horizontalPadding,
      width - 2 * horizontalPadding, rows.length * lineHeight, id),
  ];
}

// Lays out one tab on a grid and routes its connectors through the gaps between cards.
function renderPage(layout, pageCards, pageEdges, prefix = '') {
  const columnWidths = Array.from({ length: Math.max(...layout.map(row => row.length)) },
    (_, index) => Math.max(...layout.map(row => pageCards.get(row[index])?.width ?? 0)));
  const columnX = [];
  let x = 44;
  for (const width of columnWidths) {
    columnX.push(x);
    x += width + columnGap;
  }
  const rowChannels = [];
  let y = 154;
  for (const [row, names] of layout.entries()) {
    const placed = names.filter(name => pageCards.has(name));
    const rowHeight = Math.max(...placed.map(name => pageCards.get(name).height));
    for (const [column, name] of names.entries()) {
      const card = pageCards.get(name);
      if (card) Object.assign(card, { row, column, x: columnX[column] + Math.floor((columnWidths[column] - card.width) / 2), y });
    }
    rowChannels.push(y + rowHeight);
    y += rowHeight + rowGap;
  }

  const routingTracks = new Map();
  function track(channel, start, end) {
    const slots = routingTracks.get(channel) ?? [];
    routingTracks.set(channel, slots);
    const low = Math.min(start, end) - 4;
    const high = Math.max(start, end) + 4;
    const free = slots.findIndex(intervals => intervals.every(([left, right]) => high < left || low > right));
    const index = free < 0 ? slots.length : free;
    (slots[index] ??= []).push([low, high]);
    assert(index < 11, `Insufficient routing space in ${channel}`);
    if (channel.startsWith('vertical-')) {
      // Start in the middle of the gutter and alternate sides for further tracks.
      return [56, 48, 64, 40, 72, 32, 80, 24, 88, 16, 96][index];
    }
    return 12 + 8 * index;
  }

  const ports = new Map();
  for (const edge of pageEdges) {
    const source = pageCards.get(edge.target);
    const dest = pageCards.get(edge.collection);
    const sameRow = source.row === dest.row;
    edge.sourceSide = sameRow || source.row > dest.row ? 'top' : 'bottom';
    edge.destSide = sameRow || source.row < dest.row ? 'top' : 'bottom';
    if (sameRow && Math.abs(source.column - dest.column) === 1) {
      edge.sourceSide = source.column < dest.column ? 'right' : 'left';
      edge.destSide = source.column < dest.column ? 'left' : 'right';
    }
    for (const [card, side, other, property] of [[source, edge.sourceSide, dest, 'sourcePort'], [dest, edge.destSide, source, 'destPort']]) {
      const key = `${card.row},${card.column},${side}`;
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key).push({ edge, side, other, property });
    }
  }
  for (const entries of ports.values()) {
    entries.sort((a, b) => a.other.column - b.other.column || a.other.row - b.other.row);
    for (const [index, { edge, side, property }] of entries.entries()) {
      const position = Number(((index + 1) / (entries.length + 1)).toFixed(4));
      edge[property] = side === 'left' ? [0, position] : side === 'right' ? [1, position] :
        side === 'top' ? [position, 0] : [position, 1];
    }
  }

  const portAt = (card, [x, y]) => [card.x + x * card.width, card.y + y * card.height];
  const arrow = { '1': 'ERmandOne', '0..1': 'ERzeroToOne', '0..n': 'ERzeroToMany' };

  function edgeCell(edge) {
    const { id, target, collection, sourcePort, destPort, sourceSide, destSide, parentCount, childCount } = edge;
    const source = pageCards.get(target), dest = pageCards.get(collection);
    const [sx, sy] = portAt(source, sourcePort), [dx, dy] = portAt(dest, destPort);
    let bends;
    if (sourceSide === 'left' || sourceSide === 'right') {
      const column = Math.min(source.column, dest.column);
      const middle = columnX[column] + columnWidths[column] + track(`vertical-${column}`, sy, dy);
      bends = [[middle, sy], [middle, dy]];
    } else {
      const sourceRow = source.row - Number(sourceSide === 'top');
      const destRow = dest.row - Number(destSide === 'top');
      const channelY = row => row === -1 ? 88 : rowChannels[row];
      if (sourceRow === destRow) {
        const middle = channelY(sourceRow) + track(`horizontal-${sourceRow}`, sx, dx);
        bends = [[sx, middle], [dx, middle]];
      } else {
        const column = Math.min(Math.floor((source.column + dest.column) / 2), columnWidths.length - 2);
        const lane = columnX[column] + columnWidths[column] + track(`vertical-${column}`, sy, dy);
        const first = channelY(sourceRow) + track(`horizontal-${sourceRow}`, sx, lane);
        const last = channelY(destRow) + track(`horizontal-${destRow}`, lane, dx);
        bends = [[sx, first], [lane, first], [lane, last], [dx, last]];
      }
    }
    const style = 'noEdgeStyle=1;rounded=0;html=1;jumpStyle=arc;jumpSize=7;strokeColor=#62778E;strokeWidth=1.25;' +
      `startArrow=${arrow[parentCount]};endArrow=${arrow[childCount]};startFill=0;endFill=0;` +
      `exitX=${sourcePort[0]};exitY=${sourcePort[1]};entryX=${destPort[0]};entryY=${destPort[1]};exitPerimeter=0;entryPerimeter=0;` +
      `fontFamily=${overviewFont};`;
    const geometry = bends.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join('');
    return `<mxCell id="${prefix}e_${id}" value="" style="${style}" edge="1" parent="1" source="${prefix}t_${target}" target="${prefix}t_${collection}"><mxGeometry relative="1" as="geometry"><Array as="points">${geometry}</Array></mxGeometry></mxCell>`;
  }

  return [
    ...pageEdges.map(edgeCell),
    ...layout.flat().filter(name => pageCards.has(name)).flatMap(name => table(name, pageCards.get(name), overviewFont, prefix)),
  ];
}

const pages = [{ id: 'overview', name: 'Tổng quan thiết kế CSDL',
  cells: renderPage(layout, new Map([...cards].map(([name, card]) => [name, { ...card }])), [...edges.values()].map(edge => ({ ...edge }))) }];
const grouped = groups.flatMap(group => group.rows.flat().filter(name => !name.endsWith('*') && name !== '-'));
assert.deepEqual(grouped.sort(), [...models.keys()].sort(), 'Each collection must belong to exactly one group tab');
for (const { id, name, rows } of groups) {
  const members = new Set(rows.flat().filter(cell => !cell.endsWith('*') && cell !== '-'));
  const pageEdges = [...edges.values()].filter(edge => members.has(edge.target) || members.has(edge.collection)).map(edge => ({ ...edge }));
  const external = new Set(pageEdges.flatMap(edge => [edge.target, edge.collection]).filter(cell => !members.has(cell)));
  const stubs = rows.flat().filter(cell => cell.endsWith('*')).map(cell => cell.slice(0, -1));
  assert.deepEqual(stubs.sort(), [...external].sort(), `${id}: key-only cards must match the tab's external connectors`);
  const pageCards = new Map([...members].map(member => [member, { ...cards.get(member) }]));
  for (const stub of stubs) {
    const { rows: [key] } = cards.get(stub);
    const width = Math.max(136, (key.label.length + 3) * 7 + 2 * horizontalPadding, stub.length * 8 + 2 * horizontalPadding);
    pageCards.set(stub, { rows: [key], width, height: headerHeight + lineHeight + 2 * horizontalPadding });
  }
  const pageLayout = rows.map(row => row.map(cell => cell.replace(/\*$/, '')));
  pages.push({ id, name, cells: renderPage(pageLayout, pageCards, pageEdges, `${id}-`) });
}

const diagram = '<mxfile host="drawio" agent="WMSD overview generator">\n' + pages.map(({ id, name, cells }) =>
  `  <diagram id="${id}" name="${xml(name)}">\n    <mxGraphModel dx="2400" dy="1400" grid="1" gridSize="10" page="0" math="0" shadow="0" background="#FFFFFF"><root>\n` +
  '      <mxCell id="0"/>\n      <mxCell id="1" parent="0"/>\n' + cells.map(cell => `      ${cell}`).join('\n') +
  '\n    </root></mxGraphModel>\n  </diagram>\n').join('') + '</mxfile>\n';

const relationHead = [
  '| Collection giữ trường | Trường | Kiểu | Collection đích | Loại | Trên sơ đồ | Số lượng | Nguồn kiểm chứng | Ghi chú |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
const orderedRefs = [...references.values()].sort((a, b) =>
  referenceKey(a.collection, a.path, a.target).localeCompare(referenceKey(b.collection, b.path, b.target), 'en'));
const relationRow = ({ collection, path, type, target, kind, overview, cardinality, evidence, note }) =>
  `| \`${collection}\` | \`${path}\` | ${type} | \`${target}\` | ${kind} | ${overview ? 'Có' : ''} | ${cardinality ?? ''} | ${evidence} | ${note} |`;

const relationDoc = [
  '# Đối chiếu quan hệ trên sơ đồ MongoDB WMSD',
  '',
  `Nguồn là ${models.size} collection đăng ký qua [Mongoose registry](../../../../src/models/registry.js). ` +
    'Sơ đồ thể hiện các liên kết chính. Bảng ghi thêm đường dẫn nhúng, tham chiếu kỹ thuật và nhánh tương thích. ' +
    'Đích theo ngữ cảnh cần được xác định bằng loại đối tượng và logic của service. ' +
    'Những dòng ghi biến thể dùng chung phản ánh cấu hình schema và chưa xác nhận service tạo loại dòng đó cho mọi collection.',
  '',
  'Cột số lượng đọc theo thứ tự **collection đích ↔ collection giữ trường**, giới hạn trong nhánh được ghi. ' +
    'Các đường cùng đích, nguồn lưu và loại liên kết chia sẻ một nét trên sơ đồ.',
  '',
  'Các đường nối ở nhóm trả hàng, phê duyệt, nhật ký và quản trị chọn quan hệ đại diện. ' +
    'Ví dụ, đường từ phiếu xuất đến khóa nguồn ứng với `sourceKind = sales_goods_issues`. ' +
    'Các đích khác của trường dùng chung được liệt kê trong bảng bổ sung.',
  '',
  'Chạy `node scripts/generate-db-overview.mjs` tại BE để sinh sơ đồ và bảng. ' +
    'Thêm `--check` để kiểm hai file khớp kết quả sinh. Xuất PNG từ tab tổng quan bằng draw.io Desktop.',
  '',
  '## Trường cấp đầu khai báo theo loại phiếu nhập',
  '',
  '| Collection | Trường | Loại phiếu |',
  '| --- | --- | --- |',
  ...[...new Set(variants.map(([collection, field]) => `${collection}|${field}`))].map(key => {
    const [collection, field] = key.split('|');
    const kinds = variants.filter(row => row[0] === collection && row[1] === field).map(row => row[2]);
    return `| \`${collection}\` | \`${field}\` | ${kinds.join(', ')} |`;
  }),
  '',
  '## Quan hệ chính trên sơ đồ',
  '',
  ...relationHead,
  ...orderedRefs.filter(row => row.overview).map(relationRow),
  '',
  '## Tham chiếu bổ sung',
  '',
  ...relationHead,
  ...orderedRefs.filter(row => !row.overview).map(relationRow),
  '',
].join('\n');

async function writeOutput(file, content) {
  if (process.argv.includes('--check')) {
    assert((await readFile(file, 'utf8')).replaceAll('\r\n', '\n') === content, `${file.pathname} is out of date`);
  } else {
    await writeFile(file, content);
  }
}

if (process.argv.includes('--full')) {
  const full = renderFullRelationships(layout, cards, orderedRefs, table, xml);
  const fullFile = new URL('WMSD_DB_Design_Full_Relationships.drawio', output);
  await writeOutput(fullFile, full.diagram);
  console.log(`${models.size} collections, ${full.edgeCount} directed collection pairs, ${full.fieldCount} resolved reference rows`);
} else {
  await writeOutput(diagramFile, diagram);
  await writeOutput(relationFile, relationDoc);
  console.log(`${models.size} collections, ${edges.size} overview edges, ${references.size} relationship rows`);
}
await connection.close();
