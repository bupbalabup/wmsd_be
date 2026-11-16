import 'dotenv/config';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { registerModels } from '../models/registry.js';
import { buildReviewedDemo, decimalValue, hash } from './rebuild/data.js';
import { validateReviewedDemo } from './rebuild/validate.js';
import { documentTypes, formatDocumentNumber, modelDocumentTypes, numberPeriod } from '../shared/utils/document-number.js';

const seedKey = 'wmsd-demo-261116-v1';
const cohortCount = 8;
const dayMs = 86400000;
const sharedCollections = ['warehouses', 'users', 'roles', 'permissions', 'categories', 'uoms'];
const excludedCollections = ['notifications', 'system_events', 'replenishment_locks'];
const markerId = demoId('manifest');
const receiptTypes = { PURCHASE: 'GR', CUSTOMER_RETURN: 'CR_GR', FAILED_DELIVERY: 'FD_GR', TRANSFER: 'MWTR', OTHER: 'OTHER' };
const embeddedTypes = {
  HANDOVER: 'HO', PAYMENT_CONFIRMATION: 'PAY', DELIVERY_CONFIRMATION: 'POD',
  DISPOSITION: 'DEF_PLAN', ST_RESOLUTION: 'ST_PLAN', SUPPLIER_ACK: 'ACK',
};
const namespacedFields = new Set([
  'eventKey', 'requestKey', 'creationKey', 'decisionKey', 'operationKey', 'cutoverKey',
  'evaluationKey', 'dedupKey', 'correlationId', 'referenceNo', 'deliveryReference',
]);

function demoId(key) {
  return new mongoose.Types.ObjectId(hash(seedKey + ':' + key).slice(0, 24));
}

function visit(value, callback) {
  if (!value || typeof value !== 'object' || value._bsontype || value instanceof Date) return;
  if (!Array.isArray(value)) callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function addReceivingCases(template, cohort) {
  const data = { ...template };
  const [warehouse] = template.warehouses;
  const [originalRequest] = template.replenishment_requests;
  const [originalPo] = template.purchase_orders;
  const [originalArrival] = template.goods_arrivals;
  const [originalInspection] = template.goods_inspections;
  const product = template.products.find(row => String(row._id) === String(originalPo.items[0].productId));
  const owner = template.users.find(row => row.username === 'chucuahang');
  const id = key => demoId('scenario:' + key);
  const occurredAt = new Date('2026-11-15T02:00:00.000Z');
  const neededOn = new Date(Date.UTC(2026, 11, 15) + (cohort - 1) * 14 * dayMs);
  const createDocument = (key, documentKind, workflowStatus, createdBy, header, items) => ({
    _id: id(key), documentNo: key, documentKind, workflowStatus, version: 1, createdBy, occurredAt,
    createdAt: occurredAt, updatedAt: occurredAt, header, items,
  });
  const link = (subjectCollection, document, item) => ({
    _id: id('link:' + String(document._id) + (item ? ':line' : ':document')),
    subjectCollection, documentId: document._id, relationCode: 'SOURCE',
    ...(item && { itemId: item._id, linkedQty: item.qtyBase }),
  });
  const caseKind = ['DRAFT_RR', 'SUBMIT_RR', 'APPROVED_RR', 'DRAFT_PO', 'OPEN_PO', 'DRAFT_INS', 'DRAFT_INS', 'OPEN_PO'][cohort - 1];
  const requestState = { DRAFT_RR: 'DRAFT', SUBMIT_RR: 'SUBMITTED' }[caseKind] ?? 'APPROVED';
  const line = {
    ...originalRequest.items[0], _id: id('rr-line'), enteredQty: decimalValue(32), qtyBase: decimalValue(32),
    createdAt: occurredAt, updatedAt: occurredAt,
    details: { triggerType: 'MANUAL_OTHER', reasonNote: 'Bổ sung hàng cho kịch bản kiểm thử mua và nhận.' },
  };
  const request = createDocument('rr-followup', 'REPLENISHMENT', requestState, originalRequest.createdBy, {
    warehouseId: warehouse._id, neededOn, triggerReason: 'Bổ sung hàng dự trữ', creationKey: 'rr-followup',
  }, [line]);
  if (requestState !== 'DRAFT') {
    Object.assign(request.header, { submittedBy: request.createdBy, submittedAt: occurredAt });
    request.submissions = [{
      documentVersion: 1, submittedBy: request.createdBy, submittedAt: occurredAt,
      warehouseId: warehouse._id, warehouseCodeSnapshot: warehouse.code, warehouseNameSnapshot: warehouse.name,
      neededOn, triggerReason: request.header.triggerReason,
      lines: [{
        lineId: line._id, lineNo: 1, productId: product._id, productSkuSnapshot: product.sku,
        productNameSnapshot: product.name, baseUomCodeSnapshot: line.baseUnitSnapshot,
        enteredUomCodeSnapshot: line.enteredUnit, conversionVersion: 1, enteredQty: line.enteredQty,
        conversionSnapshot: line.baseUnitsPerUnit, qtyBase: line.qtyBase, triggerType: line.details.triggerType,
        evaluation: line.details, baseUnitSnapshot: line.baseUnitSnapshot, enteredUnit: line.enteredUnit,
        baseUnitsPerUnit: line.baseUnitsPerUnit, reasonNote: line.details.reasonNote,
      }],
    }];
  }
  if (requestState === 'APPROVED') {
    request.version = 2;
    line.approvedQtyBase = line.qtyBase;
    Object.assign(request.header, { approvedRevision: 1, latestDecisionId: id('rr-approval') });
    data.approval_history = [...template.approval_history, {
      _id: id('rr-approval'), decisionKey: 'rr-followup-approval', subjectType: 'replenishment_requests', subjectId: request._id,
      subjectRevision: 1, decisionScope: 'REPLENISHMENT', decision: 'APPROVE', reason: 'Duyệt bổ sung hàng demo',
      requestedBy: request.createdBy, decidedBy: owner._id, decidedAt: occurredAt, recordedAt: occurredAt,
      reviewedContent: { warehouseId: warehouse._id, productId: product._id, qtyBase: line.qtyBase },
      authoritySnapshot: { roleCode: 'OWNER', permissionCode: 'replenishment_request:approve', warehouseIds: [warehouse._id] },
      itemDecisions: [{ itemId: line._id, approvedQtyBase: line.qtyBase, outcome: 'APPROVE' }],
    }];
  }
  data.replenishment_requests = [...template.replenishment_requests, request];
  const destination = template.warehouse_locations.find(row => row.warehouseId.equals(warehouse._id) && row.locationType === 'STORAGE');
  const { sources, requestItemId, unitPurchasePrice, lineAmount, ...receiptLine } = originalPo.items[0];
  const other = createDocument('other-draft', 'OTHER', 'DRAFT', originalRequest.createdBy, {
    warehouseId: warehouse._id, reason: 'Nhập bổ sung ngoài chuỗi mua để thử trình duyệt phiếu.',
  }, [{
    ...receiptLine, _id: id('other-line'), destinationLocationId: destination._id, qualityCode: 'GOOD',
    enteredQty: decimalValue(2), qtyBase: decimalValue(8), createdAt: occurredAt, updatedAt: occurredAt,
  }]);
  data.goods_receipts = [...template.goods_receipts, other];
  if (['DRAFT_RR', 'SUBMIT_RR', 'APPROVED_RR'].includes(caseKind)) return data;

  const poLine = {
    ...originalPo.items[0], _id: id('po-line'), requestItemId: line._id, sources: [link('replenishment_requests', request, line)],
    enteredQty: decimalValue(8), qtyBase: line.qtyBase, unitPurchasePrice, lineAmount: decimalValue(1120000), createdAt: occurredAt, updatedAt: occurredAt,
  };
  const po = createDocument('po-followup', 'PO', caseKind === 'DRAFT_PO' ? 'DRAFT' : 'OPEN', originalPo.createdBy, {
    warehouseId: warehouse._id, supplierId: originalPo.header.supplierId, supplierSnapshot: originalPo.header.supplierSnapshot,
    expectedOn: neededOn, approvedRequestRevision: 1, orderDate: occurredAt,
    ...(caseKind !== 'DRAFT_PO' && { issuedAt: occurredAt }),
  }, [poLine]);
  Object.assign(po, { replenishmentRequestId: request._id, sources: [link('replenishment_requests', request)], currency: 'VND', totalAmount: poLine.lineAmount });
  data.purchase_orders = [...template.purchase_orders, po];
  if (caseKind !== 'DRAFT_INS') return data;

  const arrivalLine = {
    ...originalArrival.items[0], _id: id('arrival-line'), purchaseOrderItemId: poLine._id,
    enteredQty: decimalValue(cohort === 6 ? 4 : 8), qtyBase: decimalValue(cohort === 6 ? 16 : 32),
    packagingCondition: 'SEALED', createdAt: occurredAt, updatedAt: occurredAt,
  };
  arrivalLine.sources = [{ ...link('purchase_orders', po, poLine), linkedQty: arrivalLine.qtyBase }];
  const arrival = createDocument('arrival-followup', 'ARRIVAL', 'DRAFT', originalArrival.createdBy, {
    warehouseId: warehouse._id, supplierId: po.header.supplierId, purchaseOrderId: po._id,
    arrivedAt: occurredAt, deliveryReference: 'GIAO-THU',
  }, [arrivalLine]);
  arrival.sources = [link('purchase_orders', po)];
  const inspection = createDocument('inspection-followup', 'INSPECTION', 'DRAFT', originalInspection.createdBy, {
    warehouseId: warehouse._id, arrivalId: arrival._id, participants: [originalInspection.createdBy],
  }, [{
    ...originalInspection.items[0], _id: id('inspection-line'), enteredQty: arrivalLine.enteredQty, qtyBase: arrivalLine.qtyBase,
    sources: [link('goods_arrivals', arrival, arrivalLine)], createdAt: occurredAt, updatedAt: occurredAt,
    details: { ...originalInspection.items[0].details, inspectedSourceLineId: arrivalLine._id, inspectedAt: occurredAt },
  }]);
  inspection.sources = [link('goods_arrivals', arrival)];
  data.goods_arrivals = [...template.goods_arrivals, arrival];
  data.goods_inspections = [...template.goods_inspections, inspection];
  return data;
}

async function loadShared(connection, template) {
  const shared = {};
  for (const name of sharedCollections) {
    const filter = name === 'users' ? { isActive: true } : {};
    const projection = name === 'users' ? { passwordHash: 0, email: 0, phone: 0 } : {};
    shared[name] = await connection.db.collection(name).find(filter, { projection }).sort({ _id: 1 }).toArray();
  }
  const ids = new Map();
  const bind = (row, target) => {
    assert(target, 'Thiếu bản ghi đang dùng cho seed: ' + (row.code ?? row.username));
    ids.set(String(row._id), target._id);
  };
  for (const name of ['warehouses', 'categories', 'uoms', 'roles']) {
    for (const row of template[name]) {
      const code = { 'K-GACH-03': 'K-GACH-02', 'Mét vuông': 'M2' }[row.code] ?? row.code;
      const current = shared[name].find(target => target.code === code && target.isActive);
      if (name === 'uoms' && current) {
        assert.equal(Boolean(current.isCarton), row.isCarton, 'Quy cách đơn vị ' + code);
        assert.equal(String(current.areaMm2 ?? null), String(row.areaMm2 ?? null), 'Diện tích đơn vị ' + code);
      }
      bind(row, current);
    }
  }
  for (const row of template.permissions) {
    const current = shared.permissions.find(target => target.code === row.code);
    if (current) ids.set(String(row._id), current._id);
  }
  const selected = new Set();
  const usedUsers = template.users.filter(user => Object.entries(template).some(([name, rows]) => {
    if (sharedCollections.includes(name) || excludedCollections.includes(name)) return false;
    return JSON.stringify(rows).includes(String(user._id));
  }));
  for (const row of usedUsers) {
    const roleId = ids.get(String(row.roleId));
    const requiredWarehouses = row.warehouseIds.map(id => String(ids.get(String(id))));
    const candidates = shared.users.filter(user => String(user.roleId) === String(roleId)
      && requiredWarehouses.every(id => user.warehouseIds?.some(warehouseId => String(warehouseId) === id)));
    const current = candidates.find(user => user.username === row.username && !selected.has(String(user._id)))
      ?? candidates.find(user => !selected.has(String(user._id)));
    bind(row, current);
    selected.add(String(current._id));
  }
  return { shared, ids };
}

function makeCohort(template, models, shared, sharedIds, cohort) {
  const prefix = 'DM' + String(cohort).padStart(2, '0');
  const ids = new Map(sharedIds);
  const sourceNames = new Map();
  const documentRows = new Map();
  const documentNumbers = new Map();
  const locations = new Map(template.warehouse_locations.map(row => [String(row._id), row.warehouseId]));
  const warehouseCodes = new Map(shared.warehouses.map(row => [String(row._id), row.code]));
  const shiftDate = date => new Date(+date - (cohort - 1) * 14 * dayMs);
  const historicalOwners = new Set([
    ...template.attachments.map(row => String(row.ownerDocumentId)),
    ...template.stocktakes.map(row => row.header.closureReferenceId).filter(Boolean).map(String),
  ]);
  const sequences = new Map();
  const thresholdIds = new Set(template.replenishment_requests.flatMap(row => row.items.map(item => String(item.details?.policyId))));
  const supplierCodes = new Set(template.suppliers.map(row => row.code));

  for (const [name, rows] of Object.entries(template)) {
    const Model = models.get(name);
    for (const row of rows) {
      visit(row, doc => {
        if (!doc._id || !doc.documentNo && !doc.invoiceNo) return;
        const type = doc.invoiceNo ? 'INVOICE'
          : embeddedTypes[doc.documentKind] ?? (name === 'goods_receipts' ? receiptTypes[doc.documentKind] : modelDocumentTypes[Model.modelName]);
        assert(documentTypes[type], 'Thiếu loại mã cho ' + doc.documentKind);
        documentRows.set(String(doc._id), { doc, root: row, type });
      });
      if (['products', 'suppliers', 'customers', 'warehouse_locations'].includes(name)) {
        sourceNames.set(row.name, row.name + ' · ' + prefix);
      }
    }
  }

  function warehouseFor(doc, root, seen = new Set()) {
    if (seen.has(doc)) return undefined;
    seen.add(doc);
    const direct = doc.header?.warehouseId ?? doc.header?.sourceWarehouseId ?? doc.header?.requestedWarehouseId
      ?? doc.header?.scopeLocationIds?.map(id => locations.get(String(id))).find(Boolean)
      ?? doc.items?.map(item => locations.get(String(item.locationId ?? item.details?.locationId))).find(Boolean);
    if (direct) return direct;
    if (root !== doc) return warehouseFor(root, root, seen);
    for (const source of [...doc.sources ?? [], ...(doc.items ?? []).flatMap(item => item.sources ?? [])]) {
      const parent = documentRows.get(String(source.documentId));
      const warehouse = parent && warehouseFor(parent.doc, parent.root, seen);
      if (warehouse) return warehouse;
    }
    return undefined;
  }

  for (const [oldId, { doc, root, type }] of documentRows) {
    const [code, label] = documentTypes[type];
    const warehouseId = ['SO', 'PAY', 'INVOICE'].includes(type) ? undefined : warehouseFor(doc, root);
    const unitCode = warehouseCodes.get(String(ids.get(String(warehouseId)))) ?? (['SO', 'PAY', 'INVOICE'].includes(type) ? 'KD' : 'K-GACH-01');
    const unit = ['TR', 'TD', 'ITR', 'MWTR', 'TO', 'DISC'].includes(type) ? unitCode.replace(/^K-GACH-0/, 'KG') : unitCode;
    const period = numberPeriod(shiftDate(doc.occurredAt ?? doc.issuedAt ?? doc.createdAt));
    const scope = [code, unit, period].join('-');
    const seq = (sequences.get(scope) ?? (900000 + cohort * 1000)) + 1;
    sequences.set(scope, seq);
    const number = formatDocumentNumber(code, unit, period, seq);
    documentNumbers.set(oldId, { number, label, unit, period, seq });
    // Archived evidence stores its owner as ObjectId. Keep that identity shape for
    // the associated historical snapshots, and leave their files unpublished.
    if (!historicalOwners.has(oldId) && type !== 'INVOICE') ids.set(oldId, number);
  }

  function mappedId(value) {
    const key = String(value);
    if (!ids.has(key)) ids.set(key, demoId(prefix + ':' + key));
    return ids.get(key);
  }

  function rewrite(value, key) {
    if (value instanceof Date) return shiftDate(value);
    if (value?._bsontype === 'ObjectId') return mappedId(value);
    if (value?._bsontype || value == null) return value;
    if (Array.isArray(value)) {
      const result = value.map(child => rewrite(child, key));
      return key === 'warehouseIds' ? [...new Map(result.map(id => [String(id), id])).values()] : result;
    }
    if (typeof value === 'object') {
      const result = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, rewrite(child, name)]));
      const identity = documentNumbers.get(String(value._id));
      if (identity) {
        if (value.invoiceNo) result.invoiceNo = identity.number;
        else {
          result.documentNo = identity.number;
          if (value === documentRows.get(String(value._id)).root) {
            result.tenLoaiPhieu = identity.label;
            result.maDonVi = identity.unit;
            result.kyDanhSo = identity.period;
            result.soThuTu = identity.seq;
          }
        }
      }
      return result;
    }
    if (typeof value !== 'string') return value;
    if (key === 'goodsIssueNo') {
      const original = template.sales_goods_issues.find(row => row.documentNo === value);
      return documentNumbers.get(String(original?._id))?.number ?? value;
    }
    if (value === 'Mét vuông' && ['baseUnit', 'baseUnitSnapshot', 'enteredUnit', 'saleUnit'].includes(key)) return 'M2';
    if (sourceNames.has(value)) return sourceNames.get(value);
    if (namespacedFields.has(key)) return prefix + ':' + value;
    if (['sku', 'productSkuSnapshot', 'manufacturerLot'].includes(key) || (key === 'code' && supplierCodes.has(value))) return prefix + '-' + value;
    return value;
  }

  const data = {};
  for (const [name, rows] of Object.entries(template)) {
    if (sharedCollections.includes(name) || excludedCollections.includes(name)) continue;
    data[name] = rows.map(original => {
      const row = rewrite(original);
      if (['warehouse_locations', 'customers', 'suppliers'].includes(name)) row.code = prefix + '-' + original.code;
      if (name === 'products') {
        const byWarehouse = new Map();
        row.stockThresholds?.forEach((threshold, index) => {
          const warehouse = String(threshold.warehouseId);
          if (!byWarehouse.has(warehouse) || thresholdIds.has(String(original.stockThresholds[index]._id))) {
            byWarehouse.set(warehouse, threshold);
          }
        });
        row.stockThresholds = [...byWarehouse.values()];
      }
      if (name === 'attachments') {
        row.status = 'SUPERSEDED';
        row.originalName = prefix + '-' + row.originalName;
        row.storageKey = 'demo-fixtures/' + row._id + '.png';
      }
      if (name === 'return_source_locks') row.sourceKey = row.sourceKind + ':' + row.sourceItemId;
      if (row.documentKind) row.note = '[' + prefix + '] Dữ liệu tổng hợp để demo và kiểm thử.';
      return row;
    });
  }
  return data;
}

export async function buildAtlasDemo(connection) {
  const models = registerModels(connection);
  const template = await buildReviewedDemo();
  const [arrival] = template.goods_arrivals;
  const [inspection] = template.goods_inspections;
  const [purchase] = template.purchase_orders;
  const [request] = template.replenishment_requests;
  request.items[0].approvedQtyBase = request.items[0].qtyBase;
  request.header.approvedRevision = purchase.header.approvedRequestRevision;
  arrival.header.purchaseOrderId = purchase._id;
  arrival.items[0].purchaseOrderItemId = purchase.items[0]._id;
  inspection.header = { ...inspection.header, arrivalId: arrival._id, warehouseId: arrival.header.warehouseId };
  inspection.workflowStatus = 'CONFIRMED';
  const receipt = template.goods_receipts.find(row => row.documentKind === 'PURCHASE');
  Object.assign(receipt.items[0], {
    purchaseOrderItemId: purchase.items[0]._id, arrivalItemId: arrival.items[0]._id,
    inspectionId: inspection._id, inspectionResultId: inspection.items[0]._id,
  });
  const { shared, ids } = await loadShared(connection, template);
  const inserted = Object.fromEntries([...models.keys()].map(name => [name, []]));
  for (let cohort = 1; cohort <= cohortCount; cohort++) {
    const data = makeCohort(addReceivingCases(template, cohort), models, shared, ids, cohort);
    for (const [name, rows] of Object.entries(data)) inserted[name].push(...rows);
  }
  const first = inserted.replenishment_requests[0];
  inserted.operation_records.push({
    _id: markerId, actorType: 'SYSTEM', operationCode: 'DEMO_SEED', operationKey: seedKey,
    requestKey: seedKey, requestHash: hash(seedKey), subjectType: 'replenishment_requests', subjectId: first._id,
    versionBefore: 0, versionAfter: 1, resultCode: 'SUCCESS', completedAt: first.occurredAt, createdAt: first.occurredAt,
  });
  const users = shared.users.map(row => ({ ...row, passwordHash: template.users[0].passwordHash }));
  const validation = await validateReviewedDemo({ ...inserted, ...shared, users }, models);
  const groups = [];
  for (const [name, rows] of Object.entries(inserted)) {
    if (!rows.length) continue;
    const model = models.get(name);
    const documents = [];
    for (const row of rows) {
      const document = new model(row);
      await document.validate();
      documents.push(document.toObject());
    }
    groups.push({ model, name, documents });
  }
  return { groups, validation };
}

function valuesAt(row, path) {
  if (Array.isArray(row)) return row.flatMap(value => valuesAt(value, path));
  if (!path.length) return [row];
  return valuesAt(row?.[path[0]], path.slice(1));
}

function indexKeys(documents, { key, partialFilterExpression, sparse }) {
  const fields = Object.keys(key);
  const keys = new Map();
  for (const document of documents) {
    const applies = Object.entries(partialFilterExpression ?? {}).every(([field, condition]) => {
      const [value] = valuesAt(document, field.split('.'));
      if (typeof condition === 'string') return value === condition;
      assert(condition.$type, 'Bộ lọc unique index chưa được hỗ trợ: ' + field);
      const type = value?._bsontype === 'ObjectId' ? 'objectId' : typeof value;
      return [condition.$type].flat().includes(type);
    });
    if (!applies) continue;
    const values = fields.map(field => valuesAt(document, field.split('.')));
    if (sparse && values.every(list => list.every(value => value === undefined))) continue;
    const tuples = values.reduce((prefixes, list, index) => prefixes.flatMap(prefix =>
      (list.length ? list : [null]).map(value => ({ ...prefix, [fields[index]]: value ?? null }))), [{}]);
    for (const tuple of tuples) {
      const signature = JSON.stringify(mongoose.mongo.BSON.EJSON.serialize(tuple));
      const owner = keys.get(signature);
      assert(!owner || owner === document._id, 'Seed tự trùng khóa ' + fields.join(', '));
      keys.set(signature, document._id);
    }
  }
  return [...keys.keys()].map(signature => mongoose.mongo.BSON.EJSON.deserialize(JSON.parse(signature)));
}

async function preflight(connection, groups) {
  // MongoDB evaluates the matching collation, including accents and case.
  for (let start = 0; start < groups.length; start += 8) {
    await Promise.all(groups.slice(start, start + 8).map(async ({ model, name, documents }) => {
      const collection = connection.db.collection(name);
      const indexes = await collection.indexes();
      for (const [key, options] of model.schema.indexes()) {
        if (!options.unique) continue;
        const deployed = indexes.find(index => index.unique && JSON.stringify(index.key) === JSON.stringify(key));
        assert(deployed, 'Thiếu unique index ở ' + name + ' ' + Object.keys(key).join(', '));
      }
      await Promise.all(indexes.filter(index => index.unique || index.name === '_id_').map(async index => {
        const keys = indexKeys(documents, index);
        if (!keys.length) return;
        const fields = Object.keys(index.key);
        const match = fields.length === 1 ? { [fields[0]]: { $in: keys.map(row => row[fields[0]]) } } : { $or: keys };
        const query = index.partialFilterExpression ? { $and: [match, index.partialFilterExpression] } : match;
        const { version, ...collation } = index.collation ?? {};
        const collision = await collection.findOne(query, { projection: { _id: 1 }, ...(index.collation && { collation }) });
        assert(!collision, 'Atlas đã có dữ liệu dùng khóa seed ở ' + name + ' (' + index.name + ')');
      }));
    }));
  }
  const numbers = [];
  for (const { documents } of groups) visit(documents, row => {
    if (row._id && row.documentNo) numbers.push(row.documentNo);
  });
  const reserved = await connection.db.collection('operation_records').findOne({ subjectId: { $in: numbers } }, { projection: { _id: 1 } });
  assert(!reserved, 'Có mã chứng từ đã được giữ trong lịch sử thao tác');
}

export async function runAtlasDemo(connection, { apply = false } = {}) {
  const operations = connection.db.collection('operation_records');
  const manifest = () => operations.findOne({ _id: markerId }, { projection: { operationCode: 1, requestHash: 1 } });
  const report = { database: connection.name, seed: seedKey };
  function alreadySeeded(marker) {
    assert(marker.operationCode === 'DEMO_SEED' && marker.requestHash === hash(seedKey), 'Trùng ID đánh dấu seed');
    return { ...report, status: 'ALREADY_SEEDED' };
  }
  const existing = await manifest();
  if (existing) return alreadySeeded(existing);
  const { groups, validation } = await buildAtlasDemo(connection);
  await preflight(connection, groups);
  report.counts = Object.fromEntries(groups.map(({ name, documents }) => [name, documents.length]));
  report.records = Object.values(report.counts).reduce((total, count) => total + count, 0);
  report.checks = validation.checks;
  report.examples = Object.fromEntries(groups.filter(({ documents }) => documents[0].documentNo || documents[0].invoiceNo || documents[0].sku)
    .map(({ name, documents: [row] }) => [name, row.documentNo ?? row.invoiceNo ?? row.sku]));
  if (!apply) return { ...report, status: 'PREVIEW' };

  const hello = await connection.db.admin().command({ hello: 1 });
  assert(hello.setName || hello.msg === 'isdbgrid', 'Cần replica set để ghi toàn bộ seed trong một transaction');
  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      for (const { name, documents } of groups) {
        await connection.db.collection(name).insertMany(documents, { ordered: true, session });
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } catch (error) {
    const marker = error.code === 11000 && await manifest();
    if (marker) return alreadySeeded(marker);
    throw error;
  } finally {
    await session.endSession();
  }

  await Promise.all(groups.map(async ({ name, documents }) => {
    const count = await connection.db.collection(name).countDocuments({ _id: { $in: documents.map(row => row._id) } });
    assert.equal(count, documents.length, 'Thiếu bản ghi khi đọc lại ' + name);
  }));
  return { ...report, status: 'SEEDED_AND_VERIFIED' };
}

async function main() {
  const args = process.argv.slice(2);
  const database = args.find(arg => arg.startsWith('--database='))?.slice('--database='.length);
  const apply = args.includes('--apply');
  assert(database && args.every(arg => arg === '--apply' || arg === '--database=' + database), 'Dùng --database=<tên DB> [--apply]');
  const uri = process.env.MONGODB_URI;
  assert(uri && new URL(uri).pathname === '/' + database, 'MONGODB_URI phải chỉ đúng DB đã truyền');
  const connection = await mongoose.createConnection(uri, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000,
  }).asPromise();
  try {
    console.log(JSON.stringify(await runAtlasDemo(connection, { apply }), null, 2));
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Seed demo thất bại:', error.name, error.code ?? '', error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[URI]'));
    process.exitCode = 1;
  });
}
