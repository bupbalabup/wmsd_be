import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import * as st from '../src/modules/stocktake-closure/stocktake-commands.service.js';
import { getStocktake } from '../src/modules/stocktake-closure/stocktake-closure.service.js';
import { approveStocktakeDifferences, recountStocktake } from '../src/modules/stocktake-closure/stocktake-reconciliation.service.js';
import { newId } from '../src/shared/utils/document-command.js';

// BF-05 stocktake lifecycle on an isolated local replica set (never shared/remote data).
// Run: RUN_STOCKTAKE_LIFECYCLE_TESTS=1 node --test test/stocktake-lifecycle.integration.test.js
const enabled = process.env.RUN_STOCKTAKE_LIFECYCLE_TESTS === '1';
const run = (name, fn) => test(name, { skip: !enabled }, fn);
const key = () => String(newId());
let app, owner, worker, stranger, dual, warehouse, product, batch, batch2;

const reload = user => m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
const version = async id => (await m.Stocktake.findById(id)).version;
const portions = qty => [{ packagingState: 'SEALED', sealedPackCount: Number(qty) / 4, quantityBase: qty, packagingSnapshot: { packageUnit: 'BOX', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, createdBy: worker._id }];
async function location(code) {
    const loc = await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: code + key().slice(-6), locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
    const point = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: loc._id });
    return { loc, point };
}
async function bookedLocation(qty) {
    const { loc, point } = await location('BK');
    const balance = await m.InventoryBalance.create({ holdingPointId: point._id, batchId: batch._id, qualityStatus: 'GOOD', ownerType: 'STORE', quantityBase: qty, version: 1, packagingPortions: portions(qty) });
    return { loc, point, balance };
}
const evidence = (ownerDocumentId, uploader = worker) => m.Attachment.create({ ownerDocumentType: 'stocktakes', ownerDocumentId, purpose: 'EXECUTION', originalName: 'proof.png', mediaType: 'image/png', sizeBytes: 12, storageKey: 'local-test', checksum: 'b'.repeat(64), uploadedBy: uploader._id, uploadedAt: new Date(), accessCategory: 'BUSINESS', status: 'ATTACHED' });
async function plan(locations, counters = [worker], extra = {}) {
    const body = { idempotencyKey: key(), warehouseId: String(warehouse._id), reason: 'Quarterly audit', assignedCounterIds: counters.map(c => String(c._id)), scope: { locationIds: locations.map(l => String(l._id)) }, ...extra };
    const receipt = await st.createStocktake(owner, body);
    return { id: receipt.id, receipt, body };
}
const activate = async (id, user = worker) => st.activateStocktake(user, id, { idempotencyKey: key(), expectedVersion: await version(id) });
async function count(id, input, user = worker) { return st.recordCount(user, id, { idempotencyKey: key(), expectedVersion: await version(id), ...input }); }
// The counter's reason for the newest count of a differing line (required before reconcile since 23 Nov 2026).
async function reason(id, snapshotId, reasonCode, user = worker) {
    const line = (await getStocktake(user, id)).lines.find(row => row.snapshotId === String(snapshotId));
    return st.setCountReason(user, id, { idempotencyKey: key(), expectedVersion: await version(id), snapshotId: String(snapshotId), countId: line.latestCountId, reasonCode });
}
const reconcile = async (id, user = worker) => st.reconcileStocktake(user, id, { idempotencyKey: key(), expectedVersion: await version(id) });
const locked = id => m.StocktakeLocationLock.countDocuments({ stocktakeId: id, status: 'LOCKED' });

test.before(async () => {
    if (!enabled)
        return;
    process.env.JWT_SECRET = 'isolated-stocktake-lifecycle-secret';
    app = (await import('../src/app.js')).default;
    await mongoose.connect('mongodb://127.0.0.1:27018/stocktake_lc_test_' + key() + '?replicaSet=hieudt-test', { serverSelectionTimeoutMS: 5000 });
    for (const Model of m.models.values()) {
        await Model.createCollection();
        await Model.createIndexes();
    }
    const permissions = await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p => ({ code: p.code, name: p.code, description: p.description })));
    warehouse = await m.Warehouse.create({ code: 'LC', name: 'Lifecycle', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    const roleFor = (code, codes) => m.Role.create({ code, name: code, permissionIds: permissions.filter(p => codes.includes(p.code)).map(p => p._id) });
    const roles = { OWNER: await roleFor('OWNER', ROLE_PERMISSIONS.OWNER), WAREHOUSE: await roleFor('WAREHOUSE', ROLE_PERMISSIONS.WAREHOUSE), DUAL: await roleFor('DUAL', [...ROLE_PERMISSIONS.OWNER, ...ROLE_PERMISSIONS.WAREHOUSE]) };
    const mk = (username, role) => m.User.create({ username, fullName: username, passwordHash: 'unused', roleId: roles[role]._id, warehouseIds: [warehouse._id] }).then(reload);
    owner = await mk('owner', 'OWNER');
    worker = await mk('worker', 'WAREHOUSE');
    stranger = await mk('stranger', 'WAREHOUSE');
    dual = await mk('dual', 'DUAL');
    await m.Uom.create({ code: 'PIECE', name: 'Viên' });
    await m.Uom.create({ code: 'BOX', name: 'Thùng' });
    const category = await m.Category.create({ code: 'TILE', name: 'Tile' });
    product = await m.Product.create({ sku: 'LC', name: 'Tile', manufacturerCode: 'LC', categoryId: category._id, color: 'White', baseUnit: 'PIECE', wholeBaseUnits: true, lengthMm: '600', widthMm: '600', heightMm: '10' });
    batch = await m.ProductBatch.create({ productId: product._id, manufacturerLot: 'B1', identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });
    batch2 = await m.ProductBatch.create({ productId: product._id, manufacturerLot: 'B2', identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });
});
test.after(async () => { if (enabled && mongoose.connection.readyState) {
    assert.match(mongoose.connection.name, /^stocktake_lc_test_[a-f0-9]+$/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
} });

run('Owner plans, assigned Staff freezes; counts stay append-only; full flow with approved differences and found-not-in-book stock posts once', async () => {
    const book = await bookedLocation('12'), empty = await location('EM');
    // Planning is Owner-only, changes no stock and locks nothing.
    await assert.rejects(st.createStocktake(worker, { idempotencyKey: key(), warehouseId: String(warehouse._id), reason: 'x', assignedCounterIds: [String(worker._id)], scope: { locationIds: [String(book.loc._id)] } }), /quyền/i);
    const { id, receipt } = await plan([book.loc._id, empty.loc._id]);
    assert.equal(receipt.workflowStatus, 'PLANNED');
    assert.match(id, /^KK-LC-\d{6}-\d{6}$/);
    assert.equal(await locked(id), 0);
    assert.equal(await m.StocktakeSnapshot.countDocuments({ stocktakeId: id }), 0);
    // Stale version and activation by someone not assigned are rejected without writes.
    await assert.rejects(st.updateStocktake(owner, id, { idempotencyKey: key(), expectedVersion: 99, reason: 'late' }));
    await assert.rejects(activate(id, stranger), /phân công/);
    assert.equal(await locked(id), 0);
    // Activation atomically records book snapshots and locks every scoped location (also the empty one).
    const activated = await activate(id);
    assert.equal(activated.workflowStatus, 'COUNTING');
    assert.equal(await locked(id), 2);
    const snapshot = await m.StocktakeSnapshot.findOne({ stocktakeId: id });
    assert.equal(snapshot.origin, 'BOOK');
    assert.equal(String(snapshot.bookQtyBase), '12');
    await assert.rejects(st.updateStocktake(owner, id, { idempotencyKey: key(), expectedVersion: await version(id), reason: 'frozen' }), /không thể sửa/);
    // Counting: only the assigned Staff, appended, recount needs reason + previous attempt.
    await assert.rejects(count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '7' }, stranger), /phân công/);
    const first = await count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '6' });
    await assert.rejects(count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '7' }), /Đếm lại/);
    const firstCount = await m.StocktakeCount.findOne({ stocktakeId: id, snapshotId: snapshot._id });
    await count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '8', previousCountId: String(firstCount._id), recountReason: 'Counted again' });
    assert.equal(await m.StocktakeCount.countDocuments({ stocktakeId: id, snapshotId: snapshot._id }), 2);
    assert.equal(String((await m.StocktakeCount.findById(firstCount._id)).countedQtyBase), '6');
    assert.equal(String((await m.InventoryBalance.findById(book.balance._id)).quantityBase), '12');
    // Reconcile requires coverage of every snapshot AND every empty scoped location.
    await assert.rejects(reconcile(id), /Vị trí trống/);
    await count(id, { targetType: 'EMPTY_LOCATION', locationId: String(empty.loc._id), countedQtyBase: '0' });
    // Found-not-in-book: needs evidence, a free identity and a scoped location.
    const found = { locationId: String(empty.loc._id), batchId: String(batch2._id), ownerType: 'STORE', qualityStatus: 'DAMAGED' };
    await assert.rejects(count(id, { targetType: 'STOCK', discovered: found, countedQtyBase: '4' }), /bằng chứng|Vị trí đã xác nhận trống/i);
    await assert.rejects(count(id, { targetType: 'STOCK', discovered: { ...found, locationId: String(newId()) }, countedQtyBase: '4', evidenceIds: [String((await evidence(id))._id)] }), /phạm vi/);
    await assert.rejects(count(id, { targetType: 'STOCK', discovered: { ...found, batchId: String(batch._id), qualityStatus: 'GOOD', locationId: String(book.loc._id) }, countedQtyBase: '4', evidenceIds: [String((await evidence(id))._id)] }), /đã có trong sổ/);
    const proof = await evidence(id);
    const foundAtBook = { ...found, locationId: String(book.loc._id) };
    await assert.rejects(count(id, { targetType: 'STOCK', discovered: foundAtBook, countedQtyBase: '4' }), /bằng chứng/i);
    await assert.rejects(count(id, { targetType: 'STOCK', discovered: foundAtBook, countedQtyBase: '4', evidenceIds: [String((await evidence(id, owner))._id)] }), /bằng chứng/i);
    await count(id, { targetType: 'STOCK', discovered: foundAtBook, countedQtyBase: '4', evidenceIds: [String(proof._id)] });
    const discovered = await m.StocktakeSnapshot.findOne({ stocktakeId: id, origin: 'DISCOVERED' });
    assert.equal(String(discovered.bookQtyBase), '0');
    assert.equal(String(discovered.discoveredBy), String(worker._id));
    assert.equal(String((await m.InventoryBalance.findById(discovered.sourceBalanceId)).quantityBase), '0');
    // Blind count was removed (22 Nov 2026): the assigned counter receives both snapshots with their book quantity.
    const counterView = await getStocktake(worker, id);
    assert.equal(counterView.snapshots.length, 2);
    assert.ok(counterView.snapshots.every(row => row.bookQtyBase != null));
    // Reconcile selects the latest counts and reports differences without posting stock.
    await reason(id, snapshot._id, 'LOST');
    await reason(id, discovered._id, 'FOUND');
    const reconciled = await reconcile(id);
    assert.equal(reconciled.workflowStatus, 'RECONCILING');
    const reconciledDoc = await m.Stocktake.findById(id);
    assert.equal(reconciledDoc.header.selectedCounts.length, 2);
    const detail = await getStocktake(owner, id);
    const diffs = detail.header.selectedCounts.map(row => {
        const counted = detail.counts.find(c => String(c.id ?? c._id) === String(row.countId)).countedQtyBase;
        const snap = detail.snapshots.find(s => String(s.id ?? s._id) === String(row.snapshotId));
        return String(Number(counted) - Number(snap.bookQtyBase));
    });
    assert.deepEqual(diffs.sort(), ['-4', '4']);
    assert.equal(await locked(id), 2);
    assert.equal(String((await m.InventoryBalance.findById(book.balance._id)).quantityBase), '12');
    // No counts after reconcile without reopening.
    await assert.rejects(count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '12' }), /không còn ở bước đếm/);
    // Owner recounts the book line; only the Owner may, and the earlier attempt stays as history.
    const bookLine = (await getStocktake(owner, id)).lines.find(row => row.snapshotId === String(snapshot._id));
    await assert.rejects(recountStocktake(worker, id, { idempotencyKey: key(), expectedVersion: await version(id), snapshotIds: [String(snapshot._id)] }), /quyền/i);
    await recountStocktake(owner, id, { idempotencyKey: key(), expectedVersion: await version(id), snapshotIds: [String(snapshot._id)], note: 'Check again' });
    assert.equal((await m.Stocktake.findById(id)).workflowStatus, 'COUNTING');
    assert.equal(await locked(id), 2);
    await count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '8', previousCountId: bookLine.latestCountId, recountReason: 'Owner requested recount' });
    await reason(id, snapshot._id, 'DAMAGED');
    await reconcile(id);
    // Approve both differences: the staff counter cannot; the Owner posts once and the locks release with the last line.
    const approveBody = async () => ({ idempotencyKey: key(), expectedVersion: await version(id), all: true });
    await assert.rejects(approveStocktakeDifferences(worker, id, await approveBody()), /quyền/i);
    assert.equal(String((await m.InventoryBalance.findById(book.balance._id)).quantityBase), '12');
    const body = await approveBody();
    const closed = await approveStocktakeDifferences(owner, id, body);
    assert.equal(closed.workflowStatus, 'COMPLETED');
    assert.equal((await approveStocktakeDifferences(owner, id, body)).replayed, true);
    assert.equal(await locked(id), 0);
    assert.equal(String((await m.InventoryBalance.findById(book.balance._id)).quantityBase), '8');
    assert.equal(String((await m.InventoryBalance.findById(discovered.sourceBalanceId)).quantityBase), '4');
    assert.equal(await m.StockAdjustment.countDocuments({ 'header.stocktakeId': id }), 1);
    assert.equal(await m.StockTransaction.countDocuments({ sourceId: id }), 1);
});

run('no-variance approval needs reconciliation, writes no adjustment and releases locks', async () => {
    const book = await bookedLocation('8');
    const { id } = await plan([book.loc._id]);
    await activate(id);
    const snapshot = await m.StocktakeSnapshot.findOne({ stocktakeId: id });
    await count(id, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: '8' });
    const approveBody = async () => ({ idempotencyKey: key(), expectedVersion: await version(id), all: true });
    await assert.rejects(approveStocktakeDifferences(owner, id, await approveBody()), /chưa đối chiếu/);
    await reconcile(id);
    const adjustments = await m.StockAdjustment.countDocuments();
    assert.equal((await approveStocktakeDifferences(owner, id, await approveBody())).workflowStatus, 'COMPLETED');
    assert.equal(await m.StockAdjustment.countDocuments(), adjustments);
    assert.equal(await locked(id), 0);
    assert.equal(String((await m.InventoryBalance.findById(book.balance._id)).quantityBase), '8');
});

run('concurrent activation of overlapping scopes: one wins, the loser leaves no snapshot, lock or state change', async () => {
    const book = await bookedLocation('4');
    const a = await plan([book.loc._id]), b = await plan([book.loc._id]);
    const versions = [await version(a.id), await version(b.id)];
    const outcomes = await Promise.allSettled([a.id, b.id].map((id, i) => st.activateStocktake(worker, id, { idempotencyKey: key(), expectedVersion: versions[i] })));
    assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
    const [winner, loser] = outcomes[0].status === 'fulfilled' ? [a.id, b.id] : [b.id, a.id];
    assert.equal(await locked(winner), 1);
    assert.equal(await locked(loser), 0);
    assert.equal(await m.StocktakeSnapshot.countDocuments({ stocktakeId: loser }), 0);
    assert.equal((await m.Stocktake.findById(loser)).workflowStatus, 'PLANNED');
});

run('HTTP count route enforces strict DTOs for discovered stock', async () => {
    const book = await bookedLocation('4');
    const { id } = await plan([book.loc._id]);
    await activate(id);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const call = async (path, user, body) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET) }, ...(body && { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
    };
    try {
        const base = { idempotencyKey: key(), expectedVersion: await version(id), targetType: 'STOCK', countedQtyBase: '1' };
        const found = { locationId: String(book.loc._id), batchId: String(batch._id), ownerType: 'STORE', qualityStatus: 'DAMAGED' };
        assert.equal((await call('/stocktakes/' + id + '/counts', worker, base)).status, 400);
        assert.equal((await call('/stocktakes/' + id + '/counts', worker, { ...base, snapshotId: String(newId()), discovered: found })).status, 400);
        assert.equal((await call('/stocktakes/' + id + '/counts', worker, { ...base, discovered: { ...found, extra: true } })).status, 400);
        assert.equal((await call('/stocktakes/' + id + '/counts', owner, { ...base, discovered: found })).status, 403);
        assert.equal((await call('/stocktakes/options', owner)).status, 200);
        assert.equal((await call('/stocktakes/options', worker)).status, 403);
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
