// Isolated synthetic rehearsal data only. Never accepts a remote URI or resets data.
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import * as m from '../src/models/runtime.js';
import * as service from '../src/modules/return-workflows/native.service.js';
import * as reads from '../src/modules/return-workflows/native.read.js';
import * as shared from '../src/modules/return-workflows/native.shared.js';
import { transaction } from '../src/shared/utils/persistence.js';
import { nextDocumentFields, newBusinessDocument } from '../src/shared/utils/document-number.js';
import { SEED_ACCOUNTS } from '../src/seeds/data/accounts.data.js';
import { ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';

export const DEMO_URI = 'mongodb://127.0.0.1:27017/wmsd_demo_trung_20261112?replicaSet=rs0';
const root = resolve('.local/trung-demo');
const sid = value => String(value?._id ?? value);
const note = label => `DEMO Trung | ${label} | Synthetic tutor rehearsal only`;
const input = label => ({ idempotencyKey: `trung-20261112-${label}`, note: note(label) });
const manifestPath = resolve(root, 'manifest.json');
let manifest = { database: 'wmsd_demo_trung_20261112', records: {} };
async function save() { await writeFile(manifestPath, JSON.stringify(manifest, null, 2)); }
async function record(label, Model, id, next, role, path) {
  const doc = await Model.findById(id);
  manifest.records[label] = { id: sid(id), code: doc.documentNo ?? doc.referenceNo, status: doc.workflowStatus ?? doc.status, next, role, url: `http://127.0.0.1:3334/${path}/${encodeURIComponent(sid(id))}` };
  await save();
  console.log(label, manifest.records[label].code, manifest.records[label].status);
  return doc;
}

await mkdir(root, { recursive: true });
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mongoose.connect(DEMO_URI, { autoCreate: false, autoIndex: false });
try {
  if (mongoose.connection.name !== manifest.database) throw new Error('Unexpected database');
  if (!await m.PurchaseReceipt.exists()) throw new Error('Load the reviewed baseline into the isolated DB first');
  const warehouses = await m.Warehouse.find();
  const users = {};
  for (const account of SEED_ACCOUNTS) {
    const role = await m.Role.findOne({ code: account.roleCode });
    const permissions = await m.Permission.find({ code: { $in: ROLE_PERMISSIONS[account.roleCode] } });
    if (permissions.length !== ROLE_PERMISSIONS[account.roleCode].length) throw new Error('Missing catalogue permissions');
    role.permissionIds = permissions.map(p => p._id);
    await role.save();
    const isReceiver = account.username.startsWith('warehouse2');
    let user = await m.User.findOne({ username: account.username });
    if (!user) user = new m.User({ username: account.username, fullName: account.fullName, roleId: role._id });
    user.passwordHash = await bcrypt.hash(account.password, 10);
    user.isActive = true;
    user.warehouseIds = account.roleCode === 'ADMIN' ? [] : warehouses.map(w => w._id);
    await user.save();
    users[isReceiver ? 'RECEIVER' : account.roleCode] = await m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
  }
  const receipt = await m.PurchaseReceipt.findOne();
  const warehouse = await m.Warehouse.findById(receipt.header.warehouseId);
  const batch = await m.ProductBatch.findById(receipt.items[0].lotId);
  const product = await m.Product.findById(batch.productId);
  const quantity = String(batch.piecesPerCarton);
  const customer = await m.Customer.findOne();
  const supplier = await m.Supplier.findOne();
  const locations = {};
  for (const [name, locationType] of [['STOCK', 'STORAGE'], ['RECEIVE', 'RECEIVING'], ['CUSTODY', 'CUSTODY'], ['QUARANTINE', 'QUARANTINE']]) {
    locations[name] = await m.WarehouseLocation.findOneAndUpdate({ warehouseId: warehouse._id, code: `TRUNG-${name}` }, { $setOnInsert: { locationType, isActive: true, isPickable: locationType === 'STORAGE', usableLengthMm: 5000, usableWidthMm: 5000 } }, { upsert: true, returnDocument: 'after', runValidators: true });
  }
  const point = await m.StockHoldingPoint.findOneAndUpdate({ type: 'LOCATION', locationId: locations.STOCK._id }, { $setOnInsert: { type: 'LOCATION', locationId: locations.STOCK._id } }, { upsert: true, returnDocument: 'after' });
  let balance = await m.InventoryBalance.findOne({ holdingPointId: point._id, batchId: batch._id, ownerType: 'STORE', qualityStatus: 'GOOD' });
  if (!balance) {
    await transaction(async session => {
      balance = await new m.InventoryBalance({ holdingPointId: point._id, batchId: batch._id, ownerType: 'STORE', ownerId: null, qualityStatus: 'GOOD', quantityBase: '0', version: 0, packagingPortions: [] }).save({ session });
      const qty = String(batch.piecesPerCarton * 100);
      const item = { lineNo: 1, lineKind: 'STANDARD', productId: product._id, lotId: batch._id, enteredUnit: product.baseUnit, baseUnitSnapshot: product.baseUnit, baseUnitsPerUnit: '1', enteredQty: qty, qtyBase: qty, productNameSnapshot: product.name, locationId: locations.STOCK._id, ownerType: 'STORE', qualityStatus: 'GOOD' };
      const opening = await newBusinessDocument(m.OpeningStock, users.WAREHOUSE, { warehouseId: warehouse._id, cutoverKey: 'trung-demo-opening', openingAt: new Date(), coveredLocationIds: [locations.STOCK._id], sourceDescription: note('opening'), preparedBy: users.WAREHOUSE._id, preparedAt: new Date(), verifiedBy: users.OWNER._id, verifiedAt: new Date(), verifiedVersion: 1 }, [item], 'DRAFT', note('opening'));
      const posting = shared.beginStock(opening, users.WAREHOUSE, 'OPENING', input('opening'));
      await shared.receiveStock(balance, opening.items[0], undefined, posting, users.WAREHOUSE, session);
      await shared.savePosted(opening, posting, users.WAREHOUSE, session);
    });
  }
  let stored;
  const storedPath = resolve(root, 'evidence-storage.json');
  try { stored = JSON.parse(await readFile(storedPath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const png = new PNG({ width: 160, height: 120 });
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      const border = x % 40 < 2 || y % 40 < 2;
      png.data.set(border ? [220, 40, 40, 255] : [230, 220, 200, 255], offset);
    }
    const buffer = PNG.sync.write(png);
    await writeFile(resolve(root, 'SYNTHETIC-DEMO-tiles.png'), buffer);
    stored = await reads.storeFile({ buffer, originalname: 'SYNTHETIC-DEMO-tiles.png' });
    await writeFile(storedPath, JSON.stringify(stored));
  }
  async function evidence(doc, actor = users.WAREHOUSE) {
    if (doc.evidenceIds.length) return doc.evidenceIds.map(sid);
    await transaction(async session => { await reads.attachStored(doc, stored, actor, session); await doc.save({ session }); });
    return doc.evidenceIds.map(sid);
  }
  manifest.setup = { warehouse: warehouse.code, warehouseId: warehouse.id, product: product.name, lot: batch.lotCode ?? batch.manufacturerLot, lotId: batch.id, cartonQuantity: quantity, balanceId: balance.id, locations: Object.fromEntries(Object.entries(locations).map(([key, value]) => [key, { id: value.id, code: value.code }])) };
  await save();
  for (const stage of ['hold', 'proposal', 'approved', 'completed']) {
    const label = `defect-${stage}`;
    const result = await service.createDefect(users.WAREHOUSE, { ...input(label), warehouseId: warehouse.id, balanceId: balance.id, quantity, sourceKind: 'MANUAL', reason: note(label), ...(stage !== 'hold' && { disposition: { outcome: 'SCRAP', quantity, reason: note(label) } }) }, stored);
    let doc = await m.DefectReport.findById(result.id);
    if (['approved', 'completed'].includes(stage) && doc.resolutionPlans.at(-1).workflowStatus === 'SUBMITTED') await service.decideDefect(users.OWNER, doc.id, { ...input(`${label}-approve`), expectedVersion: doc.version, decision: 'APPROVE', reason: note(label) });
    doc = await m.DefectReport.findById(result.id);
    if (stage === 'completed' && doc.workflowStatus !== 'CLOSED') await service.executeDefect(users.WAREHOUSE, doc.id, { ...input(`${label}-execute`), expectedVersion: doc.version, evidenceIds: await evidence(doc), lines: [{ lineId: sid(doc.resolutionPlans.at(-1).items[0]), qtyBase: quantity }] });
    await record(label, m.DefectReport, result.id, { hold: 'Submit proposal as Warehouse', proposal: 'Approve as Owner', approved: 'Execute as Warehouse', completed: 'Review completed scrap and ledger' }[stage], stage === 'proposal' ? 'OWNER' : 'WAREHOUSE', 'defective-goods');
  }
  const history = await reads.createHistoricalSource(users.ACCOUNTANT, { ...input('historical'), sourceSystem: 'TRUNG-DEMO', referenceNo: 'TRUNG-HISTORY-001', referenceDate: '2026-11-12T08:00:00.000Z', correlationId: 'trung-demo-history-001', customerId: customer.id, warehouseId: warehouse.id, lines: [{ productId: product.id, lotId: batch.id, qtyBase: String(batch.piecesPerCarton * 30), enteredUnit: product.baseUnit, baseUnitsPerUnit: '1', returnedQty: '0' }] }, stored);
  const historical = await m.ExternalReference.findById(history.id);
  manifest.historicalSource = { id: historical.id, reference: historical.referenceNo, itemId: sid(historical.items[0]), customerId: customer.id };
  for (const stage of ['open', 'inspected', 'exception', 'accepted', 'rejected', 'completed']) {
    const label = `cr-${stage}`;
    const result = await service.createCustomerReturn(users.SALES, { idempotencyKey: input(label).idempotencyKey, warehouseId: warehouse.id, customerId: customer.id, lines: [{ historicalExternalLineId: sid(historical.items[0]), qtyBase: quantity, reason: note(label) }] });
    let doc = await m.CustomerReturn.findById(result.id);
    if (stage !== 'open' && doc.workflowStatus === 'OPEN') await service.inspectCustomerReturn(users.WAREHOUSE, doc.id, { ...input(`${label}-inspect`), expectedVersion: doc.version, evidenceIds: await evidence(doc), custodyLocationId: locations.CUSTODY.id, lines: [{ returnLineId: sid(doc.items[0]), qtyReceived: quantity, packagingCondition: 'SEALED', installationStatus: stage === 'rejected' ? 'INSTALLED' : 'UNUSED', damageCause: stage === 'exception' ? 'SUPPLIER' : 'NONE', deadlineStatus: 'WITHIN', deadlineReference: 'Synthetic demo terms: verified within the agreed window', assessmentReason: note(label) }] });
    doc = await m.CustomerReturn.findById(result.id);
    if (['accepted', 'rejected', 'completed'].includes(stage) && doc.workflowStatus === 'INSPECTED') await service.decideCustomerReturn(users.SALES, doc.id, { ...input(`${label}-decide`), expectedVersion: doc.version, decision: stage === 'rejected' ? 'REJECT' : 'APPROVE', reason: note(label) });
    doc = await m.CustomerReturn.findById(result.id);
    if (stage === 'completed' && doc.workflowStatus === 'ACCEPTED') await service.receiveCustomerReturn(users.WAREHOUSE, doc.id, { ...input(`${label}-receive`), expectedVersion: doc.version, evidenceIds: await evidence(doc), lines: [{ lineId: sid(doc.items[0]), qtyBase: quantity, locationId: locations.RECEIVE.id, qualityCode: 'GOOD' }] });
    await record(label, m.CustomerReturn, result.id, { open: 'Inspect into TRUNG-CUSTODY', inspected: 'Sales ordinary acceptance', exception: 'Owner eligible-exception decision', accepted: 'Warehouse receipt into TRUNG-RECEIVE', rejected: 'Warehouse physical handback', completed: 'Review receipt, custody and source claim' }[stage], stage === 'inspected' ? 'SALES' : stage === 'exception' ? 'OWNER' : 'WAREHOUSE', 'returns');
  }
  // Each failed delivery gets an independent, genuinely posted synthetic issue.
  const originalIssue = await m.SalesGoodsIssue.findOne();
  const originalDelivery = await m.DeliveryOrder.findOne({ 'items._id': originalIssue.items[0].details.outboundDeliveryLineId });
  const originalRequest = await m.WarehouseIssueRequest.findById(originalDelivery.header.issueRequestId);
  const originalOrder = await m.SalesOrder.findById(originalRequest.header.salesOrderId);
  async function issueChain(label,sourceQty=quantity) {
    if (manifest.records[`${label}-source`]) return m.SalesGoodsIssue.findById(manifest.records[`${label}-source`].id);
    let issue;
    await transaction(async session => {
      async function clone(original, type, actor) {
        const data = original.toObject();
        Object.assign(data, await nextDocumentFields(original.constructor, type, type === 'SO' ? null : warehouse._id, session));
        data.version = 1; data.createdBy = actor._id; data.note = note(label); data.occurredAt = new Date();
        data.items = data.items.slice(0, 1).map(item => ({ ...item, _id: shared.newId(), qtyBase: sourceQty, enteredQty: sourceQty, enteredUnit: product.baseUnit, baseUnitsPerUnit: '1', sources: [], ...(item.unitSellingPrice && {lineAmount:shared.exact(sourceQty).mul(String(item.unitSellingPrice)).toFixed()}) }));
        data.evidenceIds = []; data.externalReferenceIds = []; data.sources = [];
        delete data.stockTransactionId; delete data.postedAt; delete data.postedBy; delete data.createdAt; delete data.updatedAt;
        return new original.constructor(data);
      }
      const external = new m.ExternalReference({ sourceSystem: 'TRUNG-DEMO', referenceKind: 'SALES_ORDER', referenceNo: `${label}-ORDER`, referenceDate: new Date(), correlationId: `${label}-order-source`, status: 'VERIFIED', verifiedBy: users.ACCOUNTANT._id, verifiedAt: new Date(), warehouseId: warehouse._id, customerId: customer._id, note: note(label), items: [] });
      await external.save({ session });
      const order = await clone(originalOrder, 'SO', users.SALES);
      order.header.externalReferenceId = external._id; order.header.customerId = customer._id;
      order.workflowStatus = 'OPEN'; order.deliveryConfirmations = []; order.paymentConfirmations = []; order.cancellations = [];order.orderAmount=order.items[0].lineAmount;
      await order.save({ session });
      const request = await clone(originalRequest, 'WIR', users.SALES);
      request.header.salesOrderId = order._id; request.header.requestedWarehouseId = warehouse._id; request.items[0].details.salesOrderLineId = order.items[0]._id; request.workflowStatus = 'OPEN'; await request.save({ session });
      const delivery = await clone(originalDelivery, 'OD', users.SALES);
      delivery.header.issueRequestId = request._id; delivery.items[0].details.issueRequestLineId = request.items[0]._id; delivery.workflowStatus = 'OPEN'; await delivery.save({ session });
      issue = await clone(originalIssue, 'GI', users.WAREHOUSE);
      issue.header.warehouseId = warehouse._id; issue.header.issuedBy = users.WAREHOUSE._id; issue.header.issuedAt = new Date(); issue.items[0].details.outboundDeliveryLineId = delivery.items[0]._id; issue.items[0].salesOrderItemId = order.items[0]._id;
      const posting = shared.beginStock(issue, users.WAREHOUSE, 'PGI', input(`${label}-source`));
      await shared.takeStock(balance._id, sourceQty, issue.items[0]._id, posting, users.WAREHOUSE, session);
      await shared.savePosted(issue, posting, users.WAREHOUSE, session);
    });
    manifest.records[`${label}-source`] = { id: issue.id, code: issue.documentNo, status: issue.workflowStatus, next: 'Undelivered source for FD', role: 'WAREHOUSE' };
    await save();
    return issue;
  }
  for (const stage of ['open', 'inspected', 'completed']) {
    const label = `fd-${stage}`, issue = await issueChain(label);
    const result = await service.createFailedDelivery(users.WAREHOUSE, { ...input(label), warehouseId: warehouse.id, lines: [{ salesIssueLineId: sid(issue.items[0]), qtyBase: quantity }] }, stored);
    let doc = await m.FailedDelivery.findById(result.id);
    if (stage !== 'open' && doc.workflowStatus === 'OPEN') await service.inspectFailedDelivery(users.WAREHOUSE, doc.id, { ...input(`${label}-inspect`), expectedVersion: doc.version, evidenceIds: await evidence(doc), lines: [{ lineId: sid(doc.items[0]), qtyBase: quantity, qualityCode: 'GOOD', packagingCondition: 'SEALED' }] });
    doc = await m.FailedDelivery.findById(result.id);
    if (stage === 'completed' && doc.workflowStatus === 'INSPECTED') await service.receiveFailedDelivery(users.WAREHOUSE, doc.id, { ...input(`${label}-receive`), expectedVersion: doc.version, evidenceIds: await evidence(doc), lines: [{ lineId: sid(doc.items[0]), qtyBase: quantity, locationId: locations.RECEIVE.id, qualityCode: 'GOOD' }] });
    await record(label, m.FailedDelivery, result.id, stage === 'open' ? 'Inspect returned goods' : stage === 'inspected' ? 'Receive and reopen original demand' : 'Review receipt and demand reopening', 'WAREHOUSE', 'failed-deliveries');
  }
  await issueChain('fd-create-source',String(batch.piecesPerCarton*10));
  for (const stage of ['pending', 'ready', 'dispatched', 'acknowledged', 'completed']) {
    const label = `sr-${stage}`;
    const result = await service.createSupplierReturn(users.WAREHOUSE, { ...input(label), warehouseId: warehouse.id, supplierId: supplier.id, lines: [{ originLineId: sid(receipt.items[0]), balanceId: balance.id, qtyBase: quantity }] });
    let doc = await m.SupplierReturn.findById(result.id);
    if (stage !== 'pending' && doc.workflowStatus === 'AGREEMENT_PENDING') await service.supplierAgreement(users.ACCOUNTANT, doc.id, { ...input(`${label}-agreement`), expectedVersion: doc.version, evidenceIds: await evidence(doc, users.ACCOUNTANT), reference: `TRUNG-DEMO-${stage}`, lines: [{ lineId: sid(doc.items[0]), qtyBase: quantity }] });
    doc = await m.SupplierReturn.findById(result.id);
    if (['dispatched', 'acknowledged', 'completed'].includes(stage) && doc.workflowStatus === 'READY') await service.dispatchSupplierReturn(users.WAREHOUSE, doc.id, { ...input(`${label}-dispatch`), expectedVersion: doc.version, evidenceIds: await evidence(doc), recipientName: 'Synthetic demo carrier', lines: [{ lineId: sid(doc.items[0]), qtyBase: quantity }] });
    doc = await m.SupplierReturn.findById(result.id);
    if (['acknowledged', 'completed'].includes(stage) && doc.workflowStatus === 'DISPATCHED') {
      const issue = await m.SupplierReturnIssue.findOne({ 'header.supplierReturnId': doc._id });
      await service.acknowledgeSupplierReturn(users.ACCOUNTANT, doc.id, { ...input(`${label}-ack`), expectedVersion: doc.version, evidenceIds: await evidence(doc, users.ACCOUNTANT), lines: [{ lineId: sid(issue.items[0]), qtyBase: quantity, outcome: 'ACCEPTED' }] });
    }
    doc = await m.SupplierReturn.findById(result.id);
    if (stage === 'completed' && doc.workflowStatus === 'ACKNOWLEDGED') await service.closeSupplierReturn(users.ACCOUNTANT, doc.id, { ...input(`${label}-close`), expectedVersion: doc.version });
    await record(label, m.SupplierReturn, result.id, { pending: 'Accountant verifies agreement', ready: 'Warehouse dispatches', dispatched: 'Accountant records supplier ACK', acknowledged: 'Accountant reconciles and closes', completed: 'Review closure; add external credit-note reference if needed' }[stage], stage === 'ready' ? 'WAREHOUSE' : 'ACCOUNTANT', 'supplier-returns');
  }
  if (!manifest.externalReference) {
    const doc = await m.SupplierReturn.findById(manifest.records['sr-completed'].id);
    await reads.recordExternalReference(users.ACCOUNTANT, { ...input('credit-note'), documentId: doc.id, expectedVersion: doc.version, sourceSystem: 'TRUNG-DEMO', referenceKind: 'CREDIT_NOTE', referenceNo: 'TRUNG-CREDIT-001', referenceDate: '2026-11-12T08:00:00.000Z', correlationId: 'trung-demo-credit-001', evidenceId: (await evidence(doc, users.ACCOUNTANT))[0], status: 'RECORDED', lines: [{ lineId: sid(doc.items[0]), qtyBase: quantity }] });
    const reference = await m.ExternalReference.findOne({ correlationId: 'trung-demo-credit-001' });
    manifest.externalReference = { id: reference.id, reference: reference.referenceNo, kind: reference.referenceKind };
  }
  manifest.preparedAt = new Date().toISOString();
  await save();
  console.log('Prepared isolated demo:', manifestPath);
} finally { await mongoose.disconnect(); }
