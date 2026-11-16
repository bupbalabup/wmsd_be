import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import * as st from '../src/modules/stocktake-closure/stocktake-commands.service.js';
import { newId } from '../src/shared/utils/document-command.js';

// UC-93 list filters against real Mongo on an isolated local replica set (never shared/remote data).
// Run: RUN_STOCKTAKE_LIST_TESTS=1 node --test test/stocktake-list.integration.test.js
const enabled = process.env.RUN_STOCKTAKE_LIST_TESTS === '1';
const run = (name, fn) => test(name, { skip: !enabled }, fn);
const key = () => String(newId());
let app, owner, worker, outsider, warehouse, otherWarehouse, planned, counting, elsewhere, locPlanned, locCounting;

const reload = user => m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
const version = async id => (await m.Stocktake.findById(id)).version;

async function location(wh, code) {
    const loc = await m.WarehouseLocation.create({ warehouseId: wh._id, code: code + key().slice(-6), locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
    const point = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: loc._id });
    return { loc, point };
}
async function plan(wh, loc, counters) {
    const receipt = await st.createStocktake(owner, { idempotencyKey: key(), warehouseId: String(wh._id), reason: 'List test', assignedCounterIds: counters.map(c => String(c._id)), scope: { locationIds: [String(loc._id)] } });
    return receipt.id;
}

test.before(async () => {
    if (!enabled)
        return;
    process.env.JWT_SECRET = 'isolated-stocktake-list-secret';
    app = (await import('../src/app.js')).default;
    await mongoose.connect('mongodb://127.0.0.1:27018/stocktake_list_test_' + key() + '?replicaSet=hieudt-test', { serverSelectionTimeoutMS: 5000 });
    for (const Model of m.models.values()) {
        await Model.createCollection();
        await Model.createIndexes();
    }
    const permissions = await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p => ({ code: p.code, name: p.code, description: p.description })));
    warehouse = await m.Warehouse.create({ code: 'LA', name: 'List A', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    otherWarehouse = await m.Warehouse.create({ code: 'LB', name: 'List B', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    const roleFor = (code, codes) => m.Role.create({ code, name: code, permissionIds: permissions.filter(p => codes.includes(p.code)).map(p => p._id) });
    const roles = { OWNER: await roleFor('OWNER', ROLE_PERMISSIONS.OWNER), WAREHOUSE: await roleFor('WAREHOUSE', ROLE_PERMISSIONS.WAREHOUSE) };
    const mk = (username, role, warehouseIds) => m.User.create({ username, fullName: username, passwordHash: 'unused', roleId: roles[role]._id, warehouseIds }).then(reload);
    owner = await mk('owner', 'OWNER', [warehouse._id, otherWarehouse._id]);
    worker = await mk('worker', 'WAREHOUSE', [warehouse._id]);
    outsider = await mk('outsider', 'WAREHOUSE', [otherWarehouse._id]);

    await m.Uom.create({ code: 'PIECE', name: 'Viên' });
    await m.Uom.create({ code: 'BOX', name: 'Thùng' });
    const category = await m.Category.create({ code: 'TILE', name: 'Tile' });
    const product = await m.Product.create({ sku: 'LS', name: 'Tile', manufacturerCode: 'LS', categoryId: category._id, color: 'White', baseUnit: 'PIECE', wholeBaseUnits: true, lengthMm: '600', widthMm: '600', heightMm: '10' });
    const batch = await m.ProductBatch.create({ productId: product._id, manufacturerLot: 'B1', identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });

    locPlanned = (await location(warehouse, 'PL')).loc;
    const booked = await location(warehouse, 'CN');
    locCounting = booked.loc;
    await m.InventoryBalance.create({ holdingPointId: booked.point._id, batchId: batch._id, qualityStatus: 'GOOD', ownerType: 'STORE', quantityBase: '4', version: 1, packagingPortions: [{ packagingState: 'SEALED', sealedPackCount: 1, quantityBase: '4', packagingSnapshot: { packageUnit: 'BOX', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, createdBy: worker._id }] });
    const far = (await location(otherWarehouse, 'FR')).loc;

    planned = await plan(warehouse, locPlanned, [worker]);
    counting = await plan(warehouse, locCounting, [worker]);
    await st.activateStocktake(worker, counting, { idempotencyKey: key(), expectedVersion: await version(counting) });
    elsewhere = await plan(otherWarehouse, far, [outsider]);
});
test.after(async () => { if (enabled && mongoose.connection.readyState) {
    assert.match(mongoose.connection.name, /^stocktake_list_test_[a-f0-9]+$/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
} });

async function withServer(fn) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const call = async (path, user) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { headers: { authorization: 'Bearer ' + jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET) } });
        return { status: response.status, body: await response.json() };
    };
    try { return await fn(call); } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const ids = response => {
    if (!Array.isArray(response.body.data?.items))
        throw new Error('unexpected body ' + JSON.stringify(response.body).slice(0, 300));
    return response.body.data.items.map(row => String(row.id ?? row._id)).sort();
};
const sorted = (...list) => list.map(String).sort();

run('list endpoint filters by warehouse, status, scope location, cutoff window and document number on real Mongo', async () => {
    await withServer(async call => {
        const doc = await m.Stocktake.findById(counting);
        assert.ok(doc.header.cutoffAt, 'activation sets cutoffAt');
        const cutoff = doc.header.cutoffAt.getTime();
        const iso = ms => encodeURIComponent(new Date(ms).toISOString());

        const all = await call('/stocktakes?limit=50', owner);
        assert.equal(all.status, 200);
        assert.deepEqual(ids(all), sorted(planned, counting, elsewhere));
        assert.equal(all.body.data.total, 3);

        assert.deepEqual(ids(await call('/stocktakes?warehouseId=' + warehouse._id, owner)), sorted(planned, counting));
        assert.deepEqual(ids(await call('/stocktakes?warehouseId=' + otherWarehouse._id, owner)), sorted(elsewhere));
        assert.deepEqual(ids(await call('/stocktakes?status=COUNTING', owner)), sorted(counting));
        assert.deepEqual(ids(await call('/stocktakes?locationId=' + locPlanned._id, owner)), sorted(planned));
        assert.deepEqual(ids(await call('/stocktakes?locationId=' + locCounting._id, owner)), sorted(counting));

        // cutoff window: only the activated stocktake has a cutoff; unactivated plans never match.
        assert.deepEqual(ids(await call('/stocktakes?from=' + iso(cutoff - 60000) + '&to=' + iso(cutoff + 60000), owner)), sorted(counting));
        assert.deepEqual(ids(await call('/stocktakes?from=' + iso(cutoff - 60000), owner)), sorted(counting));
        assert.deepEqual(ids(await call('/stocktakes?to=' + iso(cutoff + 60000), owner)), sorted(counting));
        assert.deepEqual(ids(await call('/stocktakes?from=' + iso(cutoff + 60000), owner)), []);
        assert.deepEqual(ids(await call('/stocktakes?to=' + iso(cutoff - 60000), owner)), []);
        assert.equal((await call('/stocktakes?from=' + iso(cutoff + 60000) + '&to=' + iso(cutoff - 60000), owner)).status, 400);

        // document number is matched literally, case-insensitively, never as a regex.
        const number = doc.documentNo;
        assert.deepEqual(ids(await call('/stocktakes?q=' + encodeURIComponent(number.toLowerCase()), owner)), sorted(counting));
        assert.deepEqual(ids(await call('/stocktakes?q=' + encodeURIComponent('.*'), owner)), []);
        assert.deepEqual(ids(await call('/stocktakes?q=' + encodeURIComponent(number.slice(0, 3)) + '&warehouseId=' + otherWarehouse._id, owner)), sorted(elsewhere));

        // combination narrows further
        assert.deepEqual(ids(await call('/stocktakes?status=COUNTING&warehouseId=' + otherWarehouse._id, owner)), []);
    });
});

run('list endpoint limits Staff to assigned warehouses and rejects foreign warehouse filters', async () => {
    await withServer(async call => {
        assert.deepEqual(ids(await call('/stocktakes?limit=50', worker)), sorted(planned, counting));
        assert.deepEqual(ids(await call('/stocktakes?limit=50', outsider)), sorted(elsewhere));
        assert.equal((await call('/stocktakes?warehouseId=' + otherWarehouse._id, worker)).status, 403);
        assert.equal((await call('/stocktakes?limit=50&unknown=1', owner)).status, 400);
        assert.equal((await call('/stocktakes?status=counting', owner)).status, 400);
    });
});

run('list endpoint paginates the filtered set', async () => {
    await withServer(async call => {
        const first = await call('/stocktakes?limit=1&page=1&warehouseId=' + warehouse._id, owner);
        const second = await call('/stocktakes?limit=1&page=2&warehouseId=' + warehouse._id, owner);
        assert.equal(first.body.data.items.length, 1);
        assert.equal(second.body.data.items.length, 1);
        assert.notEqual(ids(first)[0], ids(second)[0]);
        assert.equal(first.body.data.total, 2);
    });
});
