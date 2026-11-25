import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import * as sales from '../src/modules/sales-orders/sales-execution.service.js';
import * as issues from '../src/modules/goods-issues/goods-issue.service.js';
import { remainingReservation } from '../src/shared/utils/stock.js';
import { exact } from '../src/models/model-utils.js';
import { grantGoodsIssueUpdatePermission } from '../src/seeds/goods-issue-permissions.js';
const enabled = process.env.RUN_GOODS_ISSUE_TESTS === '1';
const key = () => new mongoose.Types.ObjectId().toString();

test('UC69–72: source-backed GI create/update/cancel, picking and once-only posting with HTTP scope', { skip: !enabled }, async t => {
  const dbName = 'goods_issue_test_' + key();
  process.env.JWT_SECRET = 'isolated-goods-issues-secret';
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.MONGODB_TEST_PORT || 27018}/${dbName}?replicaSet=${process.env.MONGODB_TEST_REPLICA_SET || 'hieudt-test'}`, { serverSelectionTimeoutMS: 5000 });
  let server;
  try {
    const names = ['Permission', 'Role', 'User', 'Warehouse', 'WarehouseLocation', 'Category', 'Product', 'ProductBatch', 'Customer', 'Uom', 'Conversion', 'SalesOrder', 'WarehouseIssueRequest', 'DeliveryOrder', 'SalesGoodsIssue', 'TransferOrder', 'StockReservation', 'StockHoldingPoint', 'InventoryBalance', 'StockTransaction', 'StocktakeLocationLock', 'DefectReport', 'ExternalReference', 'Attachment', 'OperationRecord', 'AuditLog', 'SystemEvent'];
    for (const name of names) { await m[name].createCollection(); await m[name].createIndexes(); }
    const permissions = await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p => ({ code: p.code, name: p.code })));
    const warehouse = await m.Warehouse.create({ code: 'GI-TEST', name: 'GI test', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    const actors = {};
    for (const code of ['OWNER', 'WAREHOUSE', 'SALES', 'ADMIN']) {
      const role = await m.Role.create({ code, name: code, permissionIds: permissions.filter(p => ROLE_PERMISSIONS[code].includes(p.code)).map(p => p._id) });
      const user = await m.User.create({ username: code.toLowerCase(), fullName: code, passwordHash: 'unused', roleId: role._id, warehouseIds: [warehouse._id] });
      actors[code] = await m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
    }
    const worker = actors.WAREHOUSE, seller = actors.SALES;
    const roleBefore = await m.Role.findById(worker.roleId._id);
    const permission = permissions.find(p => p.code === 'goods_issue:update');
    await m.Role.updateOne({ _id: roleBefore._id }, { $pull: { permissionIds: permission._id } });
    await grantGoodsIssueUpdatePermission();
    assert.deepEqual((await m.Role.findById(roleBefore._id)).permissionIds.map(String).sort(), roleBefore.permissionIds.map(String).sort());
    assert.equal((await grantGoodsIssueUpdatePermission()).modifiedRoles, 0);
    const outsider = await m.User.create({ username: 'other-warehouse', fullName: 'Other warehouse', passwordHash: 'unused', roleId: worker.roleId._id, warehouseIds: [] });
    const outsiderActor = await m.User.findById(outsider._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
    await m.Uom.create({ code: 'PIECE', name: 'Viên' });
    const category = await m.Category.create({ code: 'TILE', name: 'Tile' });
    const product = await m.Product.create({ sku: 'GI-TILE', name: 'Test tile', manufacturerCode: 'TEST', categoryId: category._id, color: 'White', baseUnit: 'PIECE', wholeBaseUnits: true, lengthMm: '600', widthMm: '600', heightMm: '10' });
    const batch = await m.ProductBatch.create({ productId: product._id, manufacturerLot: 'GI-LOT', identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });
    const storage = await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: 'ST', locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
    const staging = await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: 'OUT', locationType: 'STAGING', usableLengthMm: '5000', usableWidthMm: '5000' });
    const point = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: storage._id });
    const balance = await m.InventoryBalance.create({ holdingPointId: point._id, batchId: batch._id, ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: '16', version: 1,
      packagingPortions: [{ packagingState: 'SEALED', sealedPackCount: 4, quantityBase: '16', packagingSnapshot: { packageUnit: 'BOX', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, createdBy: worker._id }] });
    const warehouseOptions = { warehouseId: String(warehouse._id) };
    assert.deepEqual((await issues.issueOptions(worker, warehouseOptions)).availableByProduct, { [String(product._id)]: '16' });
    await assert.rejects(issues.issueOptions(outsiderActor, warehouseOptions), { statusCode: 403 });
    const so = await m.SalesOrder.create({ documentNo: 'ĐBH-KD-LEGACY-' + key(), workflowStatus: 'OPEN', version: 1, createdBy: seller._id,
      header: { externalReferenceId: new mongoose.Types.ObjectId(), neededOn: new Date('2026-12-01T00:00:00Z'), deliveryAddressSnapshot: 'Test address' },
      items: [{ _id: new mongoose.Types.ObjectId(), lineNo: 1, lineKind: 'SALES_ORDER', productId: product._id, lotId: batch._id, enteredUnit: 'PIECE', baseUnitSnapshot: 'PIECE', baseUnitsPerUnit: '1',
        packagingSnapshot: { packageUnit: 'Thùng', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, enteredQty: '16', qtyBase: '16', productNameSnapshot: product.name,
        unitSellingPrice: '1000', lineAmount: '16000', priceRevision: 1, details: { externalReferenceId: new mongoose.Types.ObjectId(), externalLineId: new mongoose.Types.ObjectId() } }], orderAmount: '16000', currencyCode: 'VND' });
    const request = await sales.createIssueRequest(seller, so._id, { idempotencyKey: key(), expectedVersion: so.version, warehouseId: String(warehouse._id), neededOn: '2026-12-01T00:00:00Z', lines: [{ lineId: String(so.items[0]._id), qtyBase: '16' }] });
    const wir = await m.WarehouseIssueRequest.findById(request.id);
    const madeDelivery = await sales.createDelivery(seller, { idempotencyKey: key(), expectedVersion: wir.version, issueRequestId: String(wir._id), warehouseId: String(warehouse._id), plannedOn: '2026-12-01T00:00:00Z', recipientName: 'Customer', recipientPhone: '0900000000', deliveryAddress: 'Test address',
      lines: [{ lineId: String(wir.items[0]._id), sourceBalanceId: String(balance._id), sourceBalanceVersion: balance.version, qtyBase: '16' }] });
    const delivery = await m.DeliveryOrder.findById(madeDelivery.id), root = await m.StockReservation.findOne({ 'executionRef.documentId': delivery._id });
    assert.deepEqual((await issues.issueOptions(worker, warehouseOptions)).availableByProduct, {});
    const input = { idempotencyKey: key(), expectedVersion: delivery.version, deliveryOrderId: String(delivery._id), note: 'First shipment', lines: [{ reservationId: String(root._id), qtyBase: '8' }] };
    const created = await issues.createIssue(worker, input);
    assert.equal((await issues.createIssue(worker, input)).replayed, true);
    let issue = await m.SalesGoodsIssue.findById(created.id);
    assert.equal(await m.TransferOrder.countDocuments(), 0);
    assert.equal(String((await m.InventoryBalance.findById(balance._id)).quantityBase), '16');
    await assert.rejects(issues.updateIssue(outsiderActor, issue._id, { idempotencyKey: key(), expectedVersion: issue.version, lines: [{ lineId: String(issue.items[0]._id), qtyBase: '4' }] }));
    await issues.updateIssue(worker, issue._id, { idempotencyKey: key(), expectedVersion: issue.version, note: 'Changed plan', lines: [{ lineId: String(issue.items[0]._id), qtyBase: '4' }] });
    issue = await m.SalesGoodsIssue.findById(issue._id);
    assert.equal(issue.note, 'Changed plan');
    assert.equal(String(issue.items[0].qtyBase), '4');
    assert.equal(remainingReservation(await m.StockReservation.findById(root._id)).toFixed(), '12');
    const stale = { idempotencyKey: key(), expectedVersion: 1, lines: [{ lineId: String(issue.items[0]._id), qtyBase: '4' }] };
    await assert.rejects(issues.updateIssue(worker, issue._id, stale));
    await issues.cancelIssue(worker, issue._id, { idempotencyKey: key(), expectedVersion: issue.version, reason: 'Replan shipment' });
    assert.equal(remainingReservation(await m.StockReservation.findById(root._id)).toFixed(), '16');
    const latestDelivery = await m.DeliveryOrder.findById(delivery._id);
    const next = await issues.createIssue(worker, { ...input, idempotencyKey: key(), expectedVersion: latestDelivery.version });
    issue = await m.SalesGoodsIssue.findById(next.id);
    await assert.rejects(issues.postIssue(worker, issue._id, { idempotencyKey: key(), expectedVersion: issue.version, recipientName: 'Driver' }));
    const pickReceipt = await issues.createIssuePicking(worker, issue._id, { idempotencyKey: key(), expectedVersion: issue.version, destinations: [{ lineId: String(issue.items[0]._id), locationId: String(staging._id) }] });
    let task = await m.TransferOrder.findById(pickReceipt.id);
    await sales.confirmPicking(worker, task._id, { idempotencyKey: key(), expectedVersion: task.version, lines: [{ lineId: String(task.items[0]._id), qtyBase: '4' }] });
    issue = await m.SalesGoodsIssue.findById(next.id);
    await assert.rejects(issues.cancelIssue(worker, issue._id, { idempotencyKey: key(), expectedVersion: issue.version, reason: 'Already picked' }));
    task = await m.TransferOrder.findById(task._id);
    await sales.confirmPicking(worker, task._id, { idempotencyKey: key(), expectedVersion: task.version, lines: [{ lineId: String(task.items[0]._id), qtyBase: '4' }] });
    issue = await m.SalesGoodsIssue.findById(next.id);
    const detail = await issues.getIssue(worker, issue._id);
    assert.equal(detail.items[0].preparedQtyBase, '8'); assert.equal(detail.items[0].issuedQtyBase, '0');
    assert.deepEqual(detail.items[0].sourceLocations, ['ST']); assert.deepEqual(detail.items[0].stagingLocations, ['OUT']);
    assert.equal(detail.tasks[0].items[0].lotLabel, 'GI-LOT');
    assert.equal(detail.tasks[0].items[0].sourceLocation, 'ST');
    assert.equal(detail.tasks[0].items[0].stagingLocation, 'OUT');
    assert.equal(detail.items[0].salePriceSnapshot, undefined);
    const post = { idempotencyKey: key(), expectedVersion: issue.version, recipientName: 'Driver', vehiclePlate: 'TEST' };
    const lock = await m.StocktakeLocationLock.create({ stocktakeId: new mongoose.Types.ObjectId(), locationId: staging._id, scopeVersion: 1, status: 'LOCKED', lockedBy: worker._id, lockedAt: new Date() });
    await assert.rejects(issues.postIssue(worker, issue._id, post));
    assert.equal(await m.StockTransaction.countDocuments({ operation: 'PGI' }), 0);
    await m.StocktakeLocationLock.deleteOne({ _id: lock._id });
    await issues.postIssue(worker, issue._id, post);
    assert.equal((await issues.postIssue(worker, issue._id, post)).replayed, true);
    assert.equal(await m.StockTransaction.countDocuments({ operation: 'PGI' }), 1);
    assert.equal((await issues.getIssue(worker, issue._id)).items[0].issuedQtyBase, '8');
    assert.equal((await m.InventoryBalance.find()).reduce((n, b) => n.plus(String(b.quantityBase)), exact('0')).toFixed(), '8');
    assert.notEqual((await m.SalesOrder.findById(so._id)).workflowStatus, 'DELIVERED');
    assert.notEqual((await m.SalesOrder.findById(so._id)).workflowStatus, 'COMPLETED');
    assert.equal((await m.SalesGoodsIssue.findById(issue._id)).handovers.length, 1);
    await assert.rejects(issues.postIssue(worker, issue._id, { ...post, idempotencyKey: key(), expectedVersion: issue.version + 1 }));
    await assert.rejects(issues.getIssue(outsiderActor, issue._id));
    assert.equal((await issues.listIssues(outsiderActor, { page: 1, limit: 20 })).total, 0);
    assert.equal((await issues.listIssues(seller, { page: 1, limit: 20, sourceRequest: wir.documentNo, status: 'POSTED', from: '2020-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z' })).total, 1);
    const app = (await import('../src/app.js')).default;
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const api = async (path, actor, method = 'GET', body) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(actor && { authorization: 'Bearer ' + jwt.sign({ userId: String(actor._id) }, process.env.JWT_SECRET) }) }, ...(body && { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await api('/goods-issues')).status, 401);
    assert.equal((await api('/goods-issues', actors.ADMIN)).status, 403);
    assert.equal((await api('/goods-issues?sourceRequest=' + encodeURIComponent(wir.documentNo), worker)).body.data.total, 2);
    assert.equal((await api('/goods-issues/' + encodeURIComponent(issue._id), seller)).status, 200);
    assert.equal((await api('/goods-issues', seller, 'POST', input)).status, 403);
    assert.equal((await api('/goods-issues/' + encodeURIComponent(issue._id), worker, 'PUT', { ...stale, workflowStatus: 'POSTED' })).status, 400);
    assert.equal((await api('/goods-issues?limit=101', worker)).status, 400);
    await m.SalesGoodsIssue.collection.updateOne({ _id: issue._id }, { $unset: { 'header.deliveryOrderId': '' } });
    assert.equal((await issues.getIssue(worker, issue._id)).deliveryOrder.id, String(delivery._id));
    assert.equal((await issues.listIssues(worker, { page: 1, limit: 20 })).total, 2);
    await t.test('canceling an unstarted picking task restores the delivery allowance', async () => {
      const d = await m.DeliveryOrder.findById(delivery._id);
      const draft = await issues.createIssue(worker, { ...input, idempotencyKey: key(), expectedVersion: d.version });
      let pending = await m.SalesGoodsIssue.findById(draft.id);
      const picking = await issues.createIssuePicking(worker, pending._id, { idempotencyKey: key(), expectedVersion: pending.version,
        destinations: [{ lineId: String(pending.items[0]._id), locationId: String(staging._id) }] });
      pending = await m.SalesGoodsIssue.findById(draft.id);
      await issues.cancelIssue(worker, pending._id, { idempotencyKey: key(), expectedVersion: pending.version, reason: 'Not started' });
      assert.equal((await m.TransferOrder.findById(picking.id)).workflowStatus, 'CANCELLED');
      assert.equal(remainingReservation(await m.StockReservation.findById(root._id)).toFixed(), '8');
      assert.equal((await m.InventoryBalance.find()).reduce((n, b) => n.plus(String(b.quantityBase)), exact('0')).toFixed(), '8');
    });
    await t.test('manual MISA reference needs only products; Sales approval changes the same issue status without stock or SO creation', async () => {
      await m.User.updateOne({ _id: seller._id }, { $set: { warehouseIds: [] } });
      const cartonUnit = await m.Uom.create({ code: 'BOX', name: 'Thùng', isCarton: true });
      const cartonConversion = await m.Conversion.create({ productId: product._id, productBatchId: batch._id, uomId: cartonUnit._id, basePerUnit: '4', version: 1, validFrom: new Date('2020-01-01'), verificationReference: 'Synthetic verified carton', createdBy: worker._id });
      const counts = { orders: await m.SalesOrder.countDocuments(), issues: await m.SalesGoodsIssue.countDocuments(), reservations: await m.StockReservation.countDocuments(), transactions: await m.StockTransaction.countDocuments() };
      const body = { idempotencyKey: key(), expectedVersion: 1, warehouseId: String(warehouse._id), issueKind: 'SALE', referenceNo: 'MISA-ORDER-NOT-IN-WMS', note: 'Check order quantities manually', lines: [{ productId: String(product._id), quantity: '1.5', conversionId: String(cartonConversion._id), note: 'Line note' }] };
      await assert.rejects(issues.createIssue(seller, { ...body, idempotencyKey: key(), lines: [{ ...body.lines[0], quantity: '0.1' }] }));
      const made = await issues.createIssue(seller, body);
      assert.equal(made.workflowStatus, 'PENDING_APPROVAL');
      assert.equal((await issues.createIssue(seller, body)).replayed, true);
      assert.equal(await m.SalesOrder.countDocuments(), counts.orders);
      assert.equal(await m.StockReservation.countDocuments(), counts.reservations);
      let gi = await m.SalesGoodsIssue.findById(made.id);
      assert.equal(String(gi.items[0].qtyBase), '6'); assert.equal(String(gi.items[0].enteredQty), '1.5'); assert.equal(gi.items[0].enteredUnit, 'BOX');
      assert.equal(gi.header.deliveryOrderId, undefined); assert.equal(gi.header.referenceNo, body.referenceNo);
      assert.equal(gi.items[0].note, 'Line note');
      const pick = { idempotencyKey: key(), expectedVersion: gi.version, allocations: [{ lineId: String(gi.items[0]._id), sourceBalanceId: String(balance._id), locationId: String(staging._id), qtyBase: '6' }] };
      await assert.rejects(issues.createIssuePicking(worker, gi._id, pick));
      await assert.rejects(issues.approveIssue(seller, gi._id, { idempotencyKey: key(), expectedVersion: gi.version }));
      await assert.rejects(issues.approveIssue(worker, gi._id, { idempotencyKey: key(), expectedVersion: gi.version }));
      await assert.rejects(issues.createIssue(seller, { ...body, idempotencyKey: key(), issueKind: 'OTHER', reasonText: 'Must be denied' }));
      await assert.rejects(issues.createIssue(seller, { ...input, idempotencyKey: key() }));
      const otherSales = await m.User.create({ username: 'other-sales', fullName: 'Other sales', passwordHash: 'unused', roleId: seller.roleId._id });
      const otherActor = await m.User.findById(otherSales._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
      await assert.rejects(issues.getIssue(otherActor, gi._id));
      assert.equal((await issues.listIssues(otherActor, { page: 1, limit: 20, sourceRequest: body.referenceNo })).total, 0);
      assert.equal((await issues.listIssues(seller, { page: 1, limit: 20, sourceRequest: body.referenceNo })).total, 1);
      const approval = { idempotencyKey: key(), expectedVersion: gi.version };
      await issues.approveIssue(actors.OWNER, gi._id, approval);
      assert.equal((await issues.approveIssue(actors.OWNER, gi._id, approval)).replayed, true);
      assert.equal(await m.SalesGoodsIssue.countDocuments(), counts.issues + 1);
      assert.equal(await m.StockReservation.countDocuments(), counts.reservations);
      assert.equal(await m.StockTransaction.countDocuments(), counts.transactions);
      gi = await m.SalesGoodsIssue.findById(gi._id);
      assert.equal(gi.workflowStatus, 'DRAFT'); assert.equal(String(gi.approvedBy), String(actors.OWNER._id));
      await assert.rejects(issues.updateIssue(seller, gi._id, { idempotencyKey: key(), expectedVersion: gi.version, lines: [{ lineId: String(gi.items[0]._id), qtyBase: '8' }] }));
      const extraBin = await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: 'MANUAL', locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
      const extraPoint = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: extraBin._id });
      const extraBalance = await m.InventoryBalance.create({ holdingPointId: extraPoint._id, batchId: batch._id, ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: '8', version: 1,
        packagingPortions: [{ packagingState: 'SEALED', sealedPackCount: 2, quantityBase: '8', packagingSnapshot: { packageUnit: 'BOX', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, createdBy: worker._id }] });
      const work = await issues.createIssuePicking(worker, gi._id, { ...pick, expectedVersion: gi.version, allocations: [{ ...pick.allocations[0], sourceBalanceId: String(extraBalance._id) }] });
      const to = await m.TransferOrder.findById(work.id);
      await sales.confirmPicking(worker, to._id, { idempotencyKey: key(), expectedVersion: to.version, lines: [{ lineId: String(to.items[0]._id), qtyBase: '6' }] });
      gi = await m.SalesGoodsIssue.findById(gi._id);
      await issues.postIssue(worker, gi._id, { idempotencyKey: key(), expectedVersion: gi.version, recipientName: 'External order driver' });
      assert.equal((await issues.getIssue(seller, gi._id)).items[0].issuedQtyBase, '6');
      const left = await m.InventoryBalance.findById(extraBalance._id);
      assert.equal(String(left.quantityBase), '2'); assert.equal(left.packagingPortions.length, 1);
      assert.equal(left.packagingPortions[0].packagingState, 'OPEN'); assert.equal(left.packagingPortions[0].sealedPackCount, undefined);
      assert.equal(left.packagingPortions[0].measuredVolumeMm3, undefined); assert.ok(left.packagingPortions[0].volumeUpperBoundMm3);
      assert.equal(await m.SalesOrder.countDocuments(), counts.orders);
      const other = await issues.createIssue(worker, { ...body, idempotencyKey: key(), issueKind: 'OTHER', reasonText: 'Approved local sample issue', referenceNo: 'MANUAL-REF' });
      assert.equal(other.workflowStatus, 'DRAFT'); assert.match(other.id, /^PXK-/);
      const otherDoc = await m.SalesGoodsIssue.findById(other.id);
      await issues.cancelIssue(worker, other.id, { idempotencyKey: key(), expectedVersion: otherDoc.version, reason: 'Cancel before picking' });
      const concurrent = await Promise.all([1, 2].map(() => issues.createIssue(worker, { ...body, idempotencyKey: key(), issueKind: 'OTHER', reasonText: 'Concurrent other issue' })));
      assert.equal(new Set(concurrent.map(r => r.id)).size, 2);
    });
    await t.test('concurrent drafts cannot consume the same source allowance twice', async () => {
      const d = await m.DeliveryOrder.findById(delivery._id);
      const results = await Promise.allSettled([1, 2].map(() => issues.createIssue(worker, { ...input, idempotencyKey: key(), expectedVersion: d.version, lines: [{ reservationId: String(root._id), qtyBase: '8' }] })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(remainingReservation(await m.StockReservation.findById(root._id)).toFixed(), '0');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState) { assert.equal(mongoose.connection.name, dbName); assert.match(dbName, /^goods_issue_test_[a-f0-9]+$/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
