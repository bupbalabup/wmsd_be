import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { previewBody, createBody } from '../src/modules/opening-stock/validation.js';
import * as service from '../src/modules/opening-stock/service.js';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import { newId } from '../src/shared/utils/document-command.js';
import { setupOpeningStock } from '../scripts/setup-opening-stock.mjs';
import { transaction } from '../src/shared/utils/persistence.js';
import { guardLocations, balanceAt, receiveStock, beginStock } from '../src/shared/utils/stock.js';

const key = () => String(newId());
const mongoUri = database => `mongodb://127.0.0.1:${process.env.MONGODB_TEST_PORT || 27119}/${database}?replicaSet=${process.env.MONGODB_TEST_REPLICA_SET || 'opening-test'}`;
const row = { sku: 'TEST', manufacturerCode: 'TEST', color: 'White', manufacturerLot: 'B1', locationCode: 'ST', enteredUnit: 'PIECE', enteredQty: '8', qualityStatus: 'GOOD', packagingState: 'SEALED' };
const body = () => ({ warehouseId: key(), openingAt: '2026-11-16T00:00:00Z', cutoverKey: 'FIRST', sourceDescription: 'Verified handover', rows: [row] });
test('opening imports reject invalid decimals, hidden fields, unconfirmed empty files and oversized rows', () => {
  assert.equal(previewBody.safeParse(body()).success, true);
  for (const enteredQty of ['0', '-1', '1e4', 'NaN', '1,000']) assert.equal(previewBody.safeParse({ ...body(), rows: [{ ...row, enteredQty }] }).success, false);
  assert.equal(previewBody.safeParse({ ...body(), rows: [] }).success, false);
  assert.equal(previewBody.safeParse({ ...body(), rows: [], confirmEmpty: true }).success, true);
  assert.equal(previewBody.safeParse({ ...body(), rows: [{ ...row, ownerType: 'STORE' }] }).success, false);
  assert.equal(previewBody.safeParse({ ...body(), rows: Array(1001).fill(row) }).success, false);
  assert.equal(createBody.safeParse({ ...body(), idempotencyKey: key() }).success, true);
});

const enabled = process.env.RUN_OPENING_TESTS === '1';
test('Owner alone initializes each warehouse once, with replay and atomic stock posting', { skip: !enabled }, async () => {
  await mongoose.connect(mongoUri('opening_test_' + key()), { serverSelectionTimeoutMS: 5000 });
  try {
    for (const Model of m.models.values()) { await Model.createCollection(); await Model.createIndexes(); }
    const permissions = await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p => ({ code: p.code, name: p.code, description: p.description })));
    const users = [];
    for (const code of ['OWNER', 'WAREHOUSE', 'SALES']) {
      const role = await m.Role.create({ code, name: code, permissionIds: permissions.filter(p => ROLE_PERMISSIONS[code].includes(p.code)).map(p => p._id) });
      const user = await m.User.create({ username: code, fullName: code, passwordHash: 'unused', roleId: role._id });
      users.push(await m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } }));
    }
    const [owner, worker, sales] = users;
    const category = await m.Category.create({ code: 'TILE', name: 'Tile' });
    await m.Uom.create([{ code: 'PIECE', name: 'Viên' }, { code: 'BOX', name: 'Thùng', isCarton: true }]);
    const product = await m.Product.create({ sku: 'TEST', manufacturerCode: 'TEST', color: 'White', name: 'Test tile', categoryId: category._id, baseUnit: 'PIECE', wholeBaseUnits: true, lengthMm: '600', widthMm: '600', heightMm: '10' });
    await m.ProductBatch.create({ productId: product._id, manufacturerLot: 'B1', identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });
    const setup = async (code) => {
      const warehouse = await m.Warehouse.create({ code, name: code, lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
      await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: 'ST', locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
      worker.warehouseIds.push(warehouse._id); await worker.save();
      return { ...body(), warehouseId: String(warehouse._id), confirmEmpty: false };
    };
    const input = await setup('FIRST');
    await assert.rejects(service.preview(sales, input), /quyền/);
    for (const actor of [worker, sales]) {
      await assert.rejects(service.options(actor), /quyền/);
      await assert.rejects(service.list(actor), /quyền/);
      await assert.rejects(service.preview(actor, input), /quyền/);
      await assert.rejects(service.create(actor, { ...input, idempotencyKey: key() }), /quyền/);
    }
    const workerRole = await m.Role.findById(worker.roleId._id);
    workerRole.permissionIds.push(...permissions.filter(p => p.code.startsWith('opening_stock:')).map(p => p._id));
    await workerRole.save();
    const overGrantedWorker = await m.User.findById(worker._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
    await assert.rejects(service.preview(overGrantedWorker, input), /quyền/);
    await assert.rejects(service.create(overGrantedWorker, { ...input, idempotencyKey: key() }), /quyền/);
    const invalid = await service.preview(owner, { ...input, rows: [{ ...row, enteredQty: '1', packagingState: 'LOOSE' }] });
    assert.equal(invalid.valid, false); assert.match(invalid.errors[0].message, /thể tích/);
    assert.equal((await service.preview(owner, input)).valid, true);
    assert.equal(await m.InventoryBalance.countDocuments(), 0);
    assert.equal(await m.OpeningStock.countDocuments(), 0);
    const draftBody = { ...input, idempotencyKey: key() };
    const draft = await service.create(owner, draftBody);
    assert.equal((await service.create(owner, draftBody)).replayed, true);
    assert.match(draft.id, /^TDK-/);
    assert.equal(await m.InventoryBalance.countDocuments(), 0);
    const postBody = { expectedVersion: 1, idempotencyKey: key(), reason: 'Independently verified' };
    await assert.rejects(service.act(worker, draft.id, 'post', postBody), /quyền/);
    await assert.rejects(service.act(overGrantedWorker, draft.id, 'post', postBody), /quyền/);
    await assert.rejects(service.act(overGrantedWorker, draft.id, 'cancel', postBody), /quyền/);
    await assert.rejects(service.get(overGrantedWorker, draft.id), /quyền/);
    const posted = await service.act(owner, draft.id, 'post', postBody);
    assert.equal(posted.workflowStatus, 'POSTED');
    assert.equal(posted.header.openingImportSource, 'FILE');
    assert.equal((await service.act(owner, draft.id, 'post', postBody)).replayed, true);
    assert.equal(String((await m.InventoryBalance.findOne()).quantityBase), '8');
    assert.equal(await m.StockTransaction.countDocuments({ operation: 'OPENING' }), 1);
    await assert.rejects(service.act(owner, draft.id, 'post', { ...postBody, reason: 'Changed payload' }), /thao tác|nội dung|yêu cầu/i);
    await assert.rejects(service.create(owner, { ...draftBody, idempotencyKey: key(), cutoverKey: 'BYPASS' }), /khởi tạo/);

    const second = await setup('NEW');
    const newRow = { ...row, sku: 'NEW', name: 'Imported tile', categoryCode: 'TILE', baseUnit: 'PIECE', lengthMm: '600', widthMm: '600', heightMm: '10', piecesPerCarton: '4', cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' };
    const newInput = { ...second, rows: [newRow], idempotencyKey: key() };
    assert.equal((await service.preview(owner, newInput)).valid, true);
    assert.equal(await m.Product.countDocuments({ sku: 'NEW' }), 0);
    await assert.rejects(service.create(owner, { ...newInput, idempotencyKey: key(), rows: [newRow, { ...newRow, locationCode: 'MISSING' }] }));
    assert.equal(await m.Product.countDocuments({ sku: 'NEW' }), 0);
    const ownDraft = await service.create(owner, newInput);
    assert.equal(await m.Product.countDocuments({ sku: 'NEW' }), 1);
    await service.act(owner, ownDraft.id, 'post', { ...postBody, idempotencyKey: key() });
    await assert.rejects(service.create(owner, { ...newInput, idempotencyKey: key(), cutoverKey: 'NEW-CUTOVER' }), /khởi tạo/);
    await assert.rejects(service.act(owner, ownDraft.id, 'cancel', { ...postBody, idempotencyKey: key() }));
    const cancelledInput = await setup('CANCELLED');
    const cancelledDraft = await service.create(owner, { ...cancelledInput, idempotencyKey: key() });
    await service.act(owner, cancelledDraft.id, 'cancel', { ...postBody, idempotencyKey: key() });
    const replacement = await service.create(owner, { ...cancelledInput, idempotencyKey: key() });
    await service.act(owner, replacement.id, 'post', { ...postBody, idempotencyKey: key() });

    const empty = await setup('EMPTY');
    const emptyBody = { ...empty, rows: [], confirmEmpty: true, idempotencyKey: key() };
    const emptyDraft = await service.create(owner, emptyBody);
    await service.act(owner, emptyDraft.id, 'post', { ...postBody, idempotencyKey: key() });
    assert.equal(await m.StockTransaction.countDocuments({ sourceId: emptyDraft.id }), 0);
    await assert.rejects(service.create(owner, { ...emptyBody, idempotencyKey: key() }), /khởi tạo/);

    const race = await setup('RACE');
    const a = await service.create(owner, { ...race, idempotencyKey: key() });
    const b = await service.create(owner, { ...race, idempotencyKey: key() });
    const results = await Promise.allSettled([a, b].map(d => service.act(owner, d.id, 'post', { ...postBody, idempotencyKey: key() })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await m.OpeningStock.countDocuments({ 'header.warehouseId': race.warehouseId, workflowStatus: 'POSTED' }), 1);

    const frozen = await setup('FROZEN');
    const frozenDraft = await service.create(owner, { ...frozen, idempotencyKey: key() });
    const location = await m.WarehouseLocation.findOne({ warehouseId: frozen.warehouseId });
    await m.StocktakeLocationLock.collection.insertOne({ locationId: location._id, status: 'LOCKED' });
    await assert.rejects(service.act(owner, frozenDraft.id, 'post', { ...postBody, idempotencyKey: key() }), /kiểm kê/);
    assert.equal((await m.OpeningStock.findById(frozenDraft.id)).workflowStatus, 'DRAFT');

    const capacity = await setup('CAPACITY');
    assert.equal((await service.preview(owner, { ...capacity, rows: [{ ...row, enteredQty: '1000000000' }] })).valid, false);
    const capacityDraft = await service.create(owner, { ...capacity, idempotencyKey: key() });
    const capacityLocation = await m.WarehouseLocation.findOne({ warehouseId: capacity.warehouseId });
    await m.WarehouseLocation.updateOne({ _id: capacityLocation._id }, { $set: { usableLengthMm: 100 } });
    await assert.rejects(service.act(owner, capacityDraft.id, 'post', { ...postBody, idempotencyKey: key() }), /fit|capacity|sức chứa/i);
    assert.equal((await m.OpeningStock.findById(capacityDraft.id)).workflowStatus, 'DRAFT');
    assert.equal(await m.StockTransaction.countDocuments({ sourceId: capacityDraft.id }), 0);

    const ordinaryRace = await setup('ORDINARY');
    const raceDraft = await service.create(owner, { ...ordinaryRace, idempotencyKey: key() });
    const raceLocation = await m.WarehouseLocation.findOne({ warehouseId: ordinaryRace.warehouseId });
    const existingBatch = await m.ProductBatch.findOne({ productId: product._id });
    const ordinary = async () => transaction(async session => {
      await guardLocations([raceLocation._id], session);
      const balance = await balanceAt({ type: 'LOCATION', locationId: raceLocation._id }, { batchId: existingBatch._id, ownerType: 'STORE' }, 'GOOD', session);
      const document = await m.OpeningStock.findById(raceDraft.id).session(session);
      const posting = beginStock(document, worker, 'TEST_RECEIPT', { idempotencyKey: key() });
      const item = { ...document.items[0].toObject(), qtyBase: '4' };
      await receiveStock(balance, item, [{ packagingState: 'SEALED', quantityBase: '4', sealedPackCount: 1, packagingSnapshot: item.packagingSnapshot }], posting, worker, session);
      await posting.save({ session });
    });
    const concurrency = await Promise.allSettled([ordinary(), service.act(owner, raceDraft.id, 'post', { ...postBody, idempotencyKey: key() })]);
    assert.equal(concurrency[0].status, 'fulfilled');
    const racePoint = await m.StockHoldingPoint.findOne({ locationId: raceLocation._id });
    const raceBalance = await m.InventoryBalance.findOne({ holdingPointId: racePoint._id });
    assert.equal(String(raceBalance.quantityBase), concurrency[1].status === 'fulfilled' ? '12' : '4');

    const setupUri = mongoUri(mongoose.connection.name);
    const beforePermissions = await m.Permission.countDocuments();
    const beforeSalesGrants = (await m.Role.findById(sales.roleId._id)).permissionIds.map(String).sort();
    assert.equal((await setupOpeningStock(setupUri)).applied, false);
    await m.OpeningStock.collection.createIndex({ 'header.warehouseId': 1 }, { unique: true, partialFilterExpression: { workflowStatus: 'POSTED' } });
    await setupOpeningStock(setupUri, { apply: true });
    await setupOpeningStock(setupUri, { apply: true });
    const openingIndexes = await m.OpeningStock.collection.indexes();
    assert.equal(openingIndexes.some(index => index.name === 'header.warehouseId_1'), false);
    assert.equal(openingIndexes.some(index => index.name === 'opening_stock_file_import_once'), true);
    assert.equal(await m.Permission.countDocuments(), beforePermissions);
    assert.deepEqual((await m.Role.findById(sales.roleId._id)).permissionIds.map(String).sort(), beforeSalesGrants);
    const migratedWorkerRole = await m.Role.findById(workerRole._id);
    assert.equal(migratedWorkerRole.permissionIds.some(id => permissions.some(p => p.code.startsWith('opening_stock:') && String(p._id) === String(id))), false);
    await m.User.updateOne({ _id: owner._id }, { $set: { roleId: workerRole._id } });
    await m.Role.updateOne({ _id: workerRole._id }, { $addToSet: { permissionIds: { $each: permissions.filter(p => p.code.startsWith('opening_stock:')).map(p => p._id) } } });
    await assert.rejects(service.act(owner, draft.id, 'post', postBody), /quyền/);
  } finally {
    assert.match(mongoose.connection.name, /^opening_test_[a-f0-9]+$/);
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
