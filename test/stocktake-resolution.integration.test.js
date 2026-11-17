import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import * as st from '../src/modules/stocktake-closure/stocktake-commands.service.js';
import { newId } from '../src/shared/utils/document-command.js';

// UC-100, UC-101, UC-121: resolution-plan list/detail and blind count sheet against real Mongo
// (first live run of the `$unwind` + `$facet` pipeline) on an isolated local replica set
// (never shared/remote data).
// Run: RUN_STOCKTAKE_RESOLUTION_TESTS=1 node --test --test-concurrency=1 test/stocktake-resolution.integration.test.js
const enabled = process.env.RUN_STOCKTAKE_RESOLUTION_TESTS === '1';
const run = (name, fn) => test(name, { skip: !enabled }, fn);
const key = () => String(newId());
let app, server, owner, worker, staff2, outsider, nobody, whA, whB, tile, tileLot1, tileLot2, tileLot3, fluid, fluidLot;
// Fixture sessions, all in the isolated database.
let s1, s2, s3, s4;

const reload = user => m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
const version = async id => (await m.Stocktake.findById(id)).version;
const stocktakeJson = async id => JSON.stringify(await m.Stocktake.findById(id).lean());
const portions = (qty, by, whole) => [whole
    ? { packagingState: 'SEALED', sealedPackCount: Number(qty) / 4, quantityBase: qty, packagingSnapshot: { packageUnit: 'BOX', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, createdBy: by._id }
    : { packagingState: 'LOOSE', quantityBase: qty, measuredVolumeMm3: '1000', createdBy: by._id }];

async function location(wh, code) {
    const loc = await m.WarehouseLocation.create({ warehouseId: wh._id, code: code + key().slice(-6), locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
    const point = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: loc._id });
    return { loc, point };
}
async function bookedLocation(wh, lot, qty, by, whole = true) {
    const { loc, point } = await location(wh, 'BK');
    const balance = await addBalance(point, lot, qty, by, 'GOOD', whole);
    return { loc, point, balance };
}
const addBalance = (point, lot, qty, by, qualityStatus = 'GOOD', whole = true) => m.InventoryBalance.create({ holdingPointId: point._id, batchId: lot._id, qualityStatus, ownerType: 'STORE', quantityBase: qty, version: 1, packagingPortions: portions(qty, by, whole) });
const evidence = (ownerDocumentId, uploader) => m.Attachment.create({ ownerDocumentType: 'stocktakes', ownerDocumentId, purpose: 'EXECUTION', originalName: 'proof.png', mediaType: 'image/png', sizeBytes: 12, storageKey: 'local-test', checksum: 'b'.repeat(64), uploadedBy: uploader._id, uploadedAt: new Date(), accessCategory: 'BUSINESS', status: 'ATTACHED' });
async function planSession(wh, locations, counters, reason = 'Resolution read test') {
    const receipt = await st.createStocktake(owner, { idempotencyKey: key(), warehouseId: String(wh._id), reason, assignedCounterIds: counters.map(c => String(c._id)), scope: { locationIds: locations.map(l => String(l._id)) } });
    return receipt.id;
}
const activate = async (id, user) => st.activateStocktake(user, id, { idempotencyKey: key(), expectedVersion: await version(id) });
const count = async (id, user, input) => st.recordCount(user, id, { idempotencyKey: key(), expectedVersion: await version(id), ...input });
const reconcile = async (id, user) => st.reconcileStocktake(user, id, { idempotencyKey: key(), expectedVersion: await version(id) });

// Plans, activates, counts the book location (and confirms an optional empty one) and reconciles.
async function reconciled({ wh, counter, lot, book, counted, whole = true, empty = false }) {
    const booked = await bookedLocation(wh, lot, book, counter, whole);
    const emptyLoc = empty ? await location(wh, 'EM') : null;
    const id = await planSession(wh, [booked.loc, ...(emptyLoc ? [emptyLoc.loc] : [])], [counter]);
    await activate(id, counter);
    const snapshot = await m.StocktakeSnapshot.findOne({ stocktakeId: id });
    await count(id, counter, { targetType: 'STOCK', snapshotId: String(snapshot._id), countedQtyBase: counted });
    if (emptyLoc) await count(id, counter, { targetType: 'EMPTY_LOCATION', locationId: String(emptyLoc.loc._id), countedQtyBase: '0' });
    await reconcile(id, counter);
    const countRow = await m.StocktakeCount.findOne({ stocktakeId: id, snapshotId: snapshot._id });
    return { id, booked, emptyLoc, snapshot, countRow };
}
// DELTA plan that covers the whole difference of the single book snapshot.
async function submitPlan(session, proposer, difference, reason) {
    const doc = await m.Stocktake.findById(session.id);
    const selected = { snapshotId: String(session.snapshot._id), countId: String(session.countRow._id) };
    await st.submitResolutionPlan(proposer, session.id, {
        idempotencyKey: key(), expectedVersion: doc.version, scopeVersion: doc.header.scopeVersion, selectedCounts: [selected],
        items: [{ ...selected, actionKind: 'DELTA', qtyBase: difference.replace('-', ''), deltaQty: difference }], reason,
    });
    return (await m.Stocktake.findById(session.id)).resolutionPlans.at(-1);
}
const review = async (id, plan, decision, reviewer = owner) => st.reviewResolutionPlan(reviewer, id, plan._id, { idempotencyKey: key(), expectedVersion: await version(id), expectedPlanVersion: plan.header.planVersion, decision, reason: decision + ' by test' });

test.before(async () => {
    if (!enabled)
        return;
    process.env.JWT_SECRET = 'isolated-stocktake-resolution-secret';
    app = (await import('../src/app.js')).default;
    await mongoose.connect('mongodb://127.0.0.1:27018/stocktake_resolution_test_' + key() + '?replicaSet=hieudt-test', { serverSelectionTimeoutMS: 5000 });
    for (const Model of m.models.values()) {
        await Model.createCollection();
        await Model.createIndexes();
    }
    const permissions = await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p => ({ code: p.code, name: p.code, description: p.description })));
    whA = await m.Warehouse.create({ code: 'RA', name: 'Resolution A', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    whB = await m.Warehouse.create({ code: 'RB', name: 'Resolution B', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    const roleFor = (code, codes) => m.Role.create({ code, name: code, permissionIds: permissions.filter(p => codes.includes(p.code)).map(p => p._id) });
    const roles = { OWNER: await roleFor('OWNER', ROLE_PERMISSIONS.OWNER), WAREHOUSE: await roleFor('WAREHOUSE', ROLE_PERMISSIONS.WAREHOUSE), NONE: await roleFor('NONE', []) };
    const mk = (username, role, warehouseIds) => m.User.create({ username, fullName: username + ' full', passwordHash: 'unused', roleId: roles[role]._id, warehouseIds }).then(reload);
    owner = await mk('owner', 'OWNER', [whA._id, whB._id]);
    worker = await mk('worker', 'WAREHOUSE', [whA._id]);
    staff2 = await mk('staff2', 'WAREHOUSE', [whA._id]);
    outsider = await mk('outsider', 'WAREHOUSE', [whB._id]);
    nobody = await mk('nobody', 'NONE', [whA._id]);
    await m.Uom.create({ code: 'PIECE', name: 'Viên' });
    await m.Uom.create({ code: 'BOX', name: 'Thùng' });
    await m.Uom.create({ code: 'LITRE', name: 'Lít' });
    const category = await m.Category.create({ code: 'TILE', name: 'Tile' });
    tile = await m.Product.create({ sku: 'RS', name: 'Tile', manufacturerCode: 'RS', categoryId: category._id, color: 'White', baseUnit: 'PIECE', wholeBaseUnits: true, lengthMm: '600', widthMm: '600', heightMm: '10' });
    const lot = (product, manufacturerLot) => m.ProductBatch.create({ productId: product._id, manufacturerLot, identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });
    tileLot1 = await lot(tile, 'B1');
    tileLot2 = await lot(tile, 'B2');
    tileLot3 = await lot(tile, 'B3');
    fluid = await m.Product.create({ sku: 'RF', name: 'Fluid', manufacturerCode: 'RF', categoryId: category._id, color: 'Clear', baseUnit: 'LITRE', wholeBaseUnits: false, lengthMm: '600', widthMm: '600', heightMm: '10' });
    fluidLot = await lot(fluid, 'F1');

    // s1 (A): tile lot 1 + an empty location. Plan v1 is rejected, plan v2 stays pending.
    s1 = await reconciled({ wh: whA, counter: worker, lot: tileLot1, book: '12', counted: '6', empty: true });
    s1.plan1 = await submitPlan(s1, worker, '-6', 'Six missing');
    await review(s1.id, s1.plan1, 'REJECT');
    s1.plan2 = await submitPlan(s1, worker, '-6', 'Six missing, recounted');
    // s2 (A): fractional quantities on another lot; plan approved, then partly executed with evidence (the first execution record makes it EXECUTED).
    s2 = await reconciled({ wh: whA, counter: worker, lot: fluidLot, book: '12.5', counted: '10.25', whole: false });
    s2.plan = await submitPlan(s2, worker, '-2.25', 'Fractional shortage');
    await review(s2.id, s2.plan, 'APPROVE');
    s2.proof = await evidence(s2.id, worker);
    await st.recordExecution(worker, s2.id, s2.plan._id, { idempotencyKey: key(), expectedVersion: await version(s2.id), expectedPlanVersion: 1, itemId: String(s2.plan.items[0]._id), quantityBase: '1.5', evidenceIds: [String(s2.proof._id)], note: 'First part' });
    // s3 (B): another warehouse, pending plan on the same lot as s1.
    s3 = await reconciled({ wh: whB, counter: outsider, lot: tileLot1, book: '8', counted: '4' });
    s3.plan = await submitPlan(s3, outsider, '-4', 'Four missing in B');
    // s4 (A): activated and counting, never proposed anything: it must never be listed as a plan.
    const booked = await bookedLocation(whA, tileLot2, '8', worker);
    s4 = { id: await planSession(whA, [booked.loc], [worker]), booked };
    await activate(s4.id, worker);

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
});
test.after(async () => {
    if (!enabled)
        return;
    if (server)
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (mongoose.connection.readyState) {
        assert.match(mongoose.connection.name, /^stocktake_resolution_test_[a-f0-9]+$/);
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    }
});

async function call(path, user) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { headers: { authorization: 'Bearer ' + jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET) } });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
}
const planIds = response => {
    if (!Array.isArray(response.body.data?.items))
        throw new Error('unexpected body ' + response.text.slice(0, 400));
    return response.body.data.items.map(row => row.id).sort();
};
const sorted = (...list) => list.map(String).sort();
const q = params => '/stocktakes/resolution-plans?' + new URLSearchParams({ limit: '50', ...params });
const allPlans = [() => s1.plan1._id, () => s1.plan2._id, () => s2.plan._id, () => s3.plan._id];

run('list: Owner sees every warehouse, Staff only assigned ones, and total agrees with items from the $facet', async () => {
    const all = await call(q({}), owner);
    assert.equal(all.status, 200, all.text);
    assert.deepEqual(planIds(all), sorted(...allPlans.map(get => get())));
    assert.equal(all.body.data.total, 4);
    assert.equal(all.body.data.items.length, all.body.data.total);
    assert.equal(all.body.data.page, 1);
    // No plan from the counting-only session s4; no leaked document body.
    assert.ok(!all.body.data.items.some(row => row.stocktakeId === s4.id));
    // Row shape and sort by proposedAt descending.
    const times = all.body.data.items.map(row => Date.parse(row.proposedAt));
    assert.ok(times.every(time => !Number.isNaN(time)));
    assert.deepEqual([...times].sort((a, b) => b - a), times);
    const row = all.body.data.items.find(item => item.id === String(s1.plan1._id));
    assert.equal(row.documentNo, s1.plan1.documentNo);
    assert.equal(row.planVersion, 1);
    assert.equal(row.workflowStatus, 'REJECTED');
    assert.equal(row.reason, 'Six missing');
    assert.equal(row.lineCount, 1);
    assert.equal(row.stocktakeId, s1.id);
    assert.equal(row.stocktakeNo, s1.id);
    assert.equal(row.stocktakeStatus, 'PENDING_APPROVAL');
    assert.equal(row.warehouseId, String(whA._id));
    assert.equal(row.proposedBy, String(worker._id));
    assert.equal(row.scopeVersion, 1);
    assert.deepEqual(all.body.data.lookups.warehouses.map(w => w.code).sort(), ['RA', 'RB']);
    assert.ok(all.body.data.lookups.users.every(u => u.fullName.endsWith(' full')));
    assert.deepEqual(all.body.data.lookups.users.map(u => u.id).sort(), sorted(worker._id, outsider._id));

    // Staff of A: only A; Staff of B: only B.
    const staffView = await call(q({}), worker);
    assert.deepEqual(planIds(staffView), sorted(s1.plan1._id, s1.plan2._id, s2.plan._id));
    assert.equal(staffView.body.data.total, 3);
    assert.deepEqual(staffView.body.data.lookups.warehouses.map(w => w.code), ['RA']);
    assert.deepEqual(planIds(await call(q({}), staff2)), sorted(s1.plan1._id, s1.plan2._id, s2.plan._id));
    const foreign = await call(q({}), outsider);
    assert.deepEqual(planIds(foreign), sorted(s3.plan._id));
    assert.equal(foreign.body.data.total, 1);
    // Permission and foreign warehouse filter.
    assert.equal((await call(q({}), nobody)).status, 403);
    assert.equal((await call(q({ warehouseId: String(whB._id) }), worker)).status, 403);
    assert.equal((await call(q({ warehouseId: String(whA._id) }), outsider)).status, 403);
    assert.deepEqual(planIds(await call(q({ warehouseId: String(whA._id) }), worker)), sorted(s1.plan1._id, s1.plan2._id, s2.plan._id));
    assert.deepEqual(planIds(await call(q({ warehouseId: String(whB._id) }), owner)), sorted(s3.plan._id));
    assert.deepEqual(planIds(await call(q({ warehouseId: String(whA._id) }), owner)), sorted(s1.plan1._id, s1.plan2._id, s2.plan._id));
});

run('list: status, stocktakeId, lotId, locationId and q filters match real documents and combine', async () => {
    const ids = (...plans) => sorted(...plans.map(plan => plan._id));
    // status filters per plan version, not per stocktake: s1 has one REJECTED and one PENDING_APPROVAL plan.
    assert.deepEqual(planIds(await call(q({ status: 'REJECTED' }), owner)), ids(s1.plan1));
    assert.deepEqual(planIds(await call(q({ status: 'PENDING_APPROVAL' }), owner)), ids(s1.plan2, s3.plan));
    assert.deepEqual(planIds(await call(q({ status: 'APPROVED' }), owner)), [], 'recording the first execution moves a plan from APPROVED to EXECUTED');
    assert.deepEqual(planIds(await call(q({ status: 'EXECUTED' }), owner)), ids(s2.plan));
    assert.deepEqual(planIds(await call(q({ status: 'PENDING_APPROVAL' }), worker)), ids(s1.plan2));

    assert.deepEqual(planIds(await call(q({ stocktakeId: s1.id }), owner)), ids(s1.plan1, s1.plan2));
    assert.deepEqual(planIds(await call(q({ stocktakeId: s2.id }), owner)), ids(s2.plan));
    assert.deepEqual(planIds(await call(q({ stocktakeId: s3.id }), worker)), [], 'foreign stocktake is invisible to Staff of A');
    assert.deepEqual(planIds(await call(q({ stocktakeId: s4.id }), owner)), [], 'a stocktake without plans lists nothing');
    assert.deepEqual(planIds(await call(q({ stocktakeId: s1.id, status: 'REJECTED' }), owner)), ids(s1.plan1));

    assert.deepEqual(planIds(await call(q({ lotId: String(tileLot1._id) }), owner)), ids(s1.plan1, s1.plan2, s3.plan));
    assert.deepEqual(planIds(await call(q({ lotId: String(tileLot1._id) }), worker)), ids(s1.plan1, s1.plan2));
    assert.deepEqual(planIds(await call(q({ lotId: String(fluidLot._id) }), owner)), ids(s2.plan));
    assert.deepEqual(planIds(await call(q({ lotId: String(tileLot3._id) }), owner)), []);

    assert.deepEqual(planIds(await call(q({ locationId: String(s1.booked.loc._id) }), owner)), ids(s1.plan1, s1.plan2));
    assert.deepEqual(planIds(await call(q({ locationId: String(s2.booked.loc._id) }), owner)), ids(s2.plan));
    assert.deepEqual(planIds(await call(q({ locationId: String(s3.booked.loc._id) }), owner)), ids(s3.plan));
    assert.deepEqual(planIds(await call(q({ locationId: String(s3.booked.loc._id) }), worker)), [], 'foreign location is invisible to Staff of A');
    // The confirmed-empty location is in scope but no plan line touches it.
    assert.deepEqual(planIds(await call(q({ locationId: String(s1.emptyLoc.loc._id) }), owner)), []);
    assert.deepEqual(planIds(await call(q({ locationId: String(newId()) }), owner)), []);
    assert.deepEqual(planIds(await call(q({ locationId: String(s4.booked.loc._id) }), owner)), []);

    // Lot and location must hold on the same line, and every filter narrows.
    assert.deepEqual(planIds(await call(q({ locationId: String(s1.booked.loc._id), lotId: String(tileLot1._id) }), owner)), ids(s1.plan1, s1.plan2));
    assert.deepEqual(planIds(await call(q({ locationId: String(s1.booked.loc._id), lotId: String(fluidLot._id) }), owner)), []);
    assert.deepEqual(planIds(await call(q({ locationId: String(s1.booked.loc._id), lotId: String(tileLot1._id), status: 'PENDING_APPROVAL' }), owner)), ids(s1.plan2));
    assert.deepEqual(planIds(await call(q({ lotId: String(tileLot1._id), status: 'PENDING_APPROVAL', warehouseId: String(whB._id) }), owner)), ids(s3.plan));

    // Text search is literal and case-insensitive over plan and stocktake numbers.
    // Business prefixes can overlap: a stocktake number can also be a literal substring of another plan number.
    const sameNumber = number => [s1.plan1, s1.plan2, s2.plan, s3.plan].filter(plan => plan.documentNo === number);
    assert.deepEqual(planIds(await call(q({ q: s1.plan2.documentNo.toLowerCase() }), owner)), ids(...sameNumber(s1.plan2.documentNo)));
    assert.deepEqual(planIds(await call(q({ q: s3.plan.documentNo }), owner)), ids(s3.plan));
    assert.deepEqual(planIds(await call(q({ q: s2.id.toLowerCase() }), owner)), ids(s1.plan2, s2.plan));
    assert.deepEqual(planIds(await call(q({ q: s3.id.slice(0, 5) }), owner)), ids(s3.plan), 'prefix with the warehouse code selects only that warehouse');
    assert.deepEqual(planIds(await call(q({ q: s1.id.slice(0, 5) }), owner)), ids(s1.plan1, s1.plan2, s2.plan));
    assert.deepEqual(planIds(await call(q({ q: 'KK-' }), owner)), sorted(...allPlans.map(get => get())), 'every number contains KK-');
    for (const text of ['.*', '.', '^', '$', '(', '[a-z]+', '\\d', '|KK'])
        assert.deepEqual(planIds(await call(q({ q: text }), owner)), [], 'regex-literal text must not act as a pattern: ' + text);
    assert.deepEqual(planIds(await call(q({ q: ' ' + s1.plan2.documentNo + ' ' }), owner)), ids(...sameNumber(s1.plan2.documentNo)), 'q is trimmed');
    assert.deepEqual(planIds(await call(q({ q: 'KK-', status: 'EXECUTED' }), owner)), ids(s2.plan));
});

run('list: pagination splits one consistent set; total never depends on page size', async () => {
    const reference = await call(q({ limit: '100' }), owner);
    const order = reference.body.data.items.map(row => row.id);
    assert.equal(order.length, 4);
    const seen = [];
    for (let page = 1; page <= 4; page += 1) {
        const response = await call(q({ limit: '1', page: String(page) }), owner);
        assert.equal(response.status, 200, response.text);
        assert.equal(response.body.data.items.length, 1);
        assert.equal(response.body.data.total, 4);
        assert.equal(response.body.data.page, page);
        assert.equal(response.body.data.limit, 1);
        seen.push(response.body.data.items[0].id);
    }
    assert.deepEqual(seen, order, 'pages concatenate to the full sorted list');
    const sizeThree = await call(q({ limit: '3', page: '2' }), owner);
    assert.deepEqual(sizeThree.body.data.items.map(row => row.id), order.slice(3));
    assert.equal(sizeThree.body.data.total, 4);
    const beyond = await call(q({ limit: '1', page: '9' }), owner);
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.body.data.items, []);
    assert.equal(beyond.body.data.total, 4, 'total survives a page past the end');
    assert.deepEqual(beyond.body.data.lookups, { warehouses: [], users: [] });
    // A filtered set paginates on its own total.
    const filtered = await call(q({ stocktakeId: s1.id, limit: '1', page: '2' }), owner);
    assert.equal(filtered.body.data.total, 2);
    assert.equal(filtered.body.data.items.length, 1);
    // No match returns an empty page with a zero total.
    const none = await call(q({ status: 'CLOSED' }), owner);
    assert.deepEqual([none.status, none.body.data.items, none.body.data.total], [200, [], 0]);
    // Default page size (no limit) still returns all four.
    const defaults = await call('/stocktakes/resolution-plans', owner);
    assert.equal(defaults.body.data.limit, 20);
    assert.equal(defaults.body.data.items.length, 4);
});

run('list: invalid query keys and values are rejected with 400 before any data is read', async () => {
    const bad = [
        { unknown: '1' }, { status: 'pending_approval' }, { status: 'DONE' }, { lotId: 'abc' }, { locationId: 'zz' + '0'.repeat(22) },
        { warehouseId: '123' }, { stocktakeId: 'not-an-id' }, { limit: '0' }, { limit: '101' }, { page: '0' }, { page: 'x' },
        { q: '' }, { q: '   ' }, { q: 'x'.repeat(81) },
    ];
    for (const params of bad) {
        const response = await call(q(params), owner);
        assert.equal(response.status, 400, JSON.stringify(params) + ' -> ' + response.text.slice(0, 200));
    }
    // Validation runs before the permission check on the service, but authorization still blocks nobody.
    assert.equal((await call(q({ unknown: '1' }), nobody)).status, 400);
    assert.equal((await call('/stocktakes/resolution-plans?status=APPROVED&status=REJECTED', owner)).status, 400);
});

run('detail: exact decimal before/after, decisions, versions, evidence and scope checks; nothing is written', async () => {
    const snapshotOfDatabase = async () => JSON.stringify([
        await m.Stocktake.find().sort({ _id: 1 }).lean(), await m.StocktakeCount.find().sort({ _id: 1 }).lean(), await m.StocktakeSnapshot.find().sort({ _id: 1 }).lean(),
        await m.InventoryBalance.find().sort({ _id: 1 }).lean(), await m.StocktakeLocationLock.find().sort({ _id: 1 }).lean(),
    ]);
    const before = await snapshotOfDatabase(), versionBefore = await version(s1.id);

    const rejected = await call('/stocktakes/resolution-plans/' + s1.plan1._id, owner);
    assert.equal(rejected.status, 200, rejected.text);
    const data = rejected.body.data;
    assert.equal(data.plan.id, String(s1.plan1._id));
    assert.equal(data.plan.documentNo, s1.plan1.documentNo);
    assert.equal(data.plan.workflowStatus, 'REJECTED');
    assert.equal(data.plan.planVersion, 1);
    assert.equal(data.plan.previousPlanId, null);
    assert.equal(data.plan.proposedBy, String(worker._id));
    assert.equal(data.plan.reason, 'Six missing');
    assert.equal(data.plan.items.length, 1);
    const line = data.plan.items[0];
    assert.equal(line.lotId, String(tileLot1._id));
    assert.equal(line.qtyBase, '6');
    assert.equal(line.executedQtyBase, '0');
    assert.equal(line.details.actionKind, 'DELTA');
    assert.equal(line.details.deltaQty, '-6');
    assert.equal(line.details.countId, String(s1.countRow._id));
    assert.equal(line.details.fromBalanceId, String(s1.booked.balance._id));
    assert.equal(line.details.toBalanceId, null);
    assert.equal(line.snapshotId, String(s1.snapshot._id));
    assert.equal(line.fromSnapshotId, String(s1.snapshot._id));
    assert.equal(line.toSnapshotId, null);
    assert.deepEqual(line.variance, { locationId: String(s1.booked.loc._id), qualityStatus: 'GOOD', baseUnit: 'PIECE', bookQtyBase: '12', countedQtyBase: '6', differenceBase: '-6' });
    // Decision history: rejection on v1 only; v2 links back and shows no decision yet.
    assert.equal(data.plan.reviewDecisions.length, 1);
    assert.equal(data.plan.reviewDecisions[0].decision, 'REJECT');
    assert.equal(data.plan.reviewDecisions[0].reviewedBy, String(owner._id));
    assert.equal(data.plan.reviewDecisions[0].reason, 'REJECT by test');
    assert.deepEqual(data.plan.executionRecords, []);
    assert.deepEqual(data.versions, [
        { id: String(s1.plan1._id), documentNo: s1.plan1.documentNo, planVersion: 1, workflowStatus: 'REJECTED' },
        { id: String(s1.plan2._id), documentNo: s1.plan2.documentNo, planVersion: 2, workflowStatus: 'PENDING_APPROVAL' },
    ]);
    assert.equal(data.stocktake.id, s1.id);
    assert.equal(data.stocktake.version, versionBefore);
    assert.equal(data.stocktake.header.warehouseId, String(whA._id));
    assert.equal(data.stocktake.header.scopeLocationIds.length, 2);
    assert.deepEqual(data.snapshots.map(row => [row.id, row.bookQtyBase, row.origin]), [[String(s1.snapshot._id), '12', 'BOOK']]);
    assert.deepEqual(data.counts.map(row => [row.id, row.countedQtyBase, row.attemptNo]), [[String(s1.countRow._id), '6', 1]]);
    assert.deepEqual(data.lookups.warehouses.map(row => row.code), ['RA']);
    assert.deepEqual(data.lookups.locations.map(row => row.id), [String(s1.booked.loc._id)]);
    assert.deepEqual(data.lookups.batches.map(row => row.manufacturerLot), ['B1']);
    assert.deepEqual(data.lookups.products.map(row => row.sku), ['RS']);
    assert.deepEqual(data.lookups.users.map(row => row.username).sort(), ['owner', 'worker']);

    const resubmitted = (await call('/stocktakes/resolution-plans/' + s1.plan2._id, worker)).body.data;
    assert.equal(resubmitted.plan.planVersion, 2);
    assert.equal(resubmitted.plan.previousPlanId, String(s1.plan1._id));
    assert.equal(resubmitted.plan.workflowStatus, 'PENDING_APPROVAL');
    assert.deepEqual(resubmitted.plan.reviewDecisions, []);
    assert.deepEqual(resubmitted.versions.map(row => row.id), [String(s1.plan1._id), String(s1.plan2._id)]);
    assert.equal(resubmitted.plan.items[0].variance.differenceBase, '-6');

    // Fractional quantities stay exact decimal strings, and execution is summed exactly.
    const fractional = (await call('/stocktakes/resolution-plans/' + s2.plan._id, owner)).body.data;
    assert.equal(fractional.plan.workflowStatus, 'EXECUTED');
    assert.deepEqual(fractional.plan.items[0].variance, { locationId: String(s2.booked.loc._id), qualityStatus: 'GOOD', baseUnit: 'LITRE', bookQtyBase: '12.5', countedQtyBase: '10.25', differenceBase: '-2.25' });
    assert.equal(fractional.plan.items[0].qtyBase, '2.25');
    assert.equal(fractional.plan.items[0].executedQtyBase, '1.5');
    assert.equal(fractional.plan.reviewDecisions[0].decision, 'APPROVE');
    assert.equal(fractional.plan.executionRecords.length, 1);
    assert.equal(fractional.plan.executionRecords[0].quantityBase, '1.5');
    assert.equal(fractional.plan.executionRecords[0].performedBy, String(worker._id));
    assert.deepEqual(fractional.plan.executionRecords[0].evidence, [{ id: String(s2.proof._id), available: true, status: 'ATTACHED', originalName: 'proof.png', mediaType: 'image/png' }]);

    // Scope and lookup failures.
    assert.equal((await call('/stocktakes/resolution-plans/' + newId(), owner)).status, 404);
    assert.equal((await call('/stocktakes/resolution-plans/not-an-id', owner)).status, 400);
    assert.equal((await call('/stocktakes/resolution-plans/' + s3.plan._id, worker)).status, 403, 'plan of warehouse B for Staff of A');
    assert.equal((await call('/stocktakes/resolution-plans/' + s1.plan1._id, outsider)).status, 403, 'plan of warehouse A for Staff of B');
    assert.equal((await call('/stocktakes/resolution-plans/' + s3.plan._id, outsider)).status, 200);
    assert.equal((await call('/stocktakes/resolution-plans/' + s3.plan._id, owner)).status, 200);
    assert.equal((await call('/stocktakes/resolution-plans/' + s1.plan1._id, nobody)).status, 403);

    // Evidence that can no longer be resolved keeps its identity and is marked unavailable.
    await m.Attachment.deleteOne({ _id: s2.proof._id });
    const missing = (await call('/stocktakes/resolution-plans/' + s2.plan._id, owner)).body.data;
    assert.deepEqual(missing.plan.executionRecords[0].evidence, [{ id: String(s2.proof._id), available: false }]);
    await m.Attachment.create({ ...s2.proof.toObject() });

    // Reads wrote nothing: the whole stocktake/count/snapshot/balance/lock state is byte-identical and the version is unchanged.
    assert.equal(await version(s1.id), versionBefore);
    assert.equal(await snapshotOfDatabase(), before);
});

run('count-sheet: refusals, snapshot rows after live changes, blind body, empty location and no side effects', async () => {
    const sheet = id => '/stocktakes/' + id + '/count-sheet';
    const book = await bookedLocation(whA, tileLot1, '8', worker);
    await addBalance(book.point, tileLot2, '4', worker);
    const empty = await location(whA, 'CE');
    const id = await planSession(whA, [book.loc, empty.loc], [worker], 'Count sheet test');

    // PLANNED: no snapshot yet, so nobody gets a sheet; refusals keep their own order and codes.
    for (const user of [owner, worker])
        assert.equal((await call(sheet(id), user)).status, 400, 'PLANNED session');
    assert.equal((await call(sheet(id), staff2)).status, 403);
    assert.equal(await m.StocktakeSnapshot.countDocuments({ stocktakeId: id }), 0);

    await activate(id, worker);
    // Unassigned staff, foreign warehouse, missing permission, unknown and malformed identities.
    assert.equal((await call(sheet(id), staff2)).status, 403, 'same warehouse but not an assigned counter');
    assert.equal((await call(sheet(id), outsider)).status, 403, 'foreign warehouse');
    assert.equal((await call(sheet(id), nobody)).status, 403, 'no stocktake:export');
    assert.equal((await call(sheet('KK-RA-261115-999999'), owner)).status, 404);
    assert.equal((await call(sheet(String(newId())), owner)).status, 404);
    assert.equal((await call(sheet('bad id'), owner)).status, 400);

    // Live stock changes after cutoff, and a found-not-in-book count adds a DISCOVERED snapshot.
    await m.InventoryBalance.updateOne({ _id: book.balance._id }, { $set: { quantityBase: '3' } });
    await addBalance(book.point, tileLot3, '4', worker);
    const proof = await evidence(id, worker);
    await count(id, worker, { targetType: 'STOCK', discovered: { locationId: String(book.loc._id), batchId: String(tileLot3._id), ownerType: 'STORE', qualityStatus: 'DAMAGED' }, countedQtyBase: '2', evidenceIds: [String(proof._id)] });
    assert.equal(await m.StocktakeSnapshot.countDocuments({ stocktakeId: id, origin: 'DISCOVERED' }), 1);

    const stateOf = async () => JSON.stringify([
        await m.Stocktake.findById(id).lean(), await m.StocktakeCount.find({ stocktakeId: id }).sort({ _id: 1 }).lean(),
        await m.StocktakeLocationLock.find({ stocktakeId: id }).sort({ _id: 1 }).lean(), await m.StocktakeSnapshot.find({ stocktakeId: id }).sort({ _id: 1 }).lean(),
        await m.InventoryBalance.find().sort({ _id: 1 }).lean(),
    ]);
    const before = await stateOf();
    const first = await call(sheet(id), worker);
    const second = await call(sheet(id), owner);
    assert.equal(first.status, 200, first.text);
    assert.equal(second.status, 200, second.text);
    assert.equal(await stateOf(), before, 'status, version, counts, locks, snapshots and balances unchanged');
    assert.equal((await m.Stocktake.findById(id)).workflowStatus, 'COUNTING');
    assert.equal(await m.StocktakeLocationLock.countDocuments({ stocktakeId: id, status: 'LOCKED' }), 2);
    assert.equal(await m.StocktakeCount.countDocuments({ stocktakeId: id }), 1);
    assert.deepEqual(first.body.data, second.body.data, 'same data for Owner and assigned counter, twice');

    // Blind: the book quantity and any variance never appear anywhere in the body.
    for (const text of [first.text, second.text])
        assert.ok(!/bookQty|differenceBase|countedQty|variance/i.test(text), 'blind sheet leaked a quantity field');
    const data = first.body.data;
    assert.equal(data.stocktake.id, id);
    assert.equal(data.stocktake.workflowStatus, 'COUNTING');
    assert.ok(data.stocktake.cutoffAt && data.stocktake.activatedAt);
    assert.deepEqual([data.warehouse.code, data.warehouse.name], ['RA', 'Resolution A']);
    assert.deepEqual(data.counters.map(row => row.username), ['worker']);
    assert.equal(data.locations.length, 2);
    // Rows come from the frozen BOOK snapshots, not from live balances or discovered stock.
    const bookLocation = data.locations.find(row => row.locationId === String(book.loc._id));
    assert.equal(bookLocation.emptyConfirmation, false);
    assert.deepEqual(bookLocation.rows.map(row => row.manufacturerLot), ['B1', 'B2']);
    assert.deepEqual(bookLocation.rows.map(row => row.batchId), [String(tileLot1._id), String(tileLot2._id)]);
    assert.ok(bookLocation.rows.every(row => row.sku === 'RS' && row.productName === 'Tile' && row.qualityStatus === 'GOOD' && row.ownerType === 'STORE' && row.baseUnit === 'PIECE' && row.owner === null));
    assert.ok(!bookLocation.rows.some(row => row.batchId === String(tileLot3._id)), 'live-only and discovered stock is not on the sheet');
    const snapshots = await m.StocktakeSnapshot.find({ stocktakeId: id, origin: 'BOOK' });
    assert.deepEqual(bookLocation.rows.map(row => row.snapshotId).sort(), snapshots.map(row => String(row._id)).sort());
    const emptyLocation = data.locations.find(row => row.locationId === String(empty.loc._id));
    assert.equal(emptyLocation.emptyConfirmation, true);
    assert.deepEqual(emptyLocation.rows, []);
    assert.equal(emptyLocation.code, empty.loc.code);

    // After reconciliation the sheet is still available to the counter.
    const { id: reconciledId } = s1;
    const later = await call(sheet(reconciledId), worker);
    assert.equal(later.status, 200, later.text);
    assert.equal(later.body.data.stocktake.workflowStatus, 'PENDING_APPROVAL');
    assert.equal(later.body.data.locations.find(row => row.locationId === String(s1.emptyLoc.loc._id)).emptyConfirmation, true);
    assert.equal(later.body.data.locations.find(row => row.locationId === String(s1.booked.loc._id)).rows.length, 1);
    assert.ok(!/bookQty/i.test(later.text));
});

// The embedded allocator must scan documentNo as well as ObjectId-backed plan identities.
test('plan document numbers are unique across sequential sessions in one warehouse and day', { skip: !enabled }, async () => {
    const numbers = [s1.plan1, s1.plan2, s2.plan].map(plan => plan.documentNo);
    assert.equal(new Set(numbers).size, numbers.length);
});
