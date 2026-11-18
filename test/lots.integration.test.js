import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as m from '../src/models/runtime.js';
import { buildReviewedDemo } from '../src/seeds/rebuild/data.js';
import app from '../src/app.js';

const enabled = process.env.RUN_LOT_TESTS === '1';
const key = () => String(new mongoose.Types.ObjectId());

test('lot API: tone/calibre, evidence, list joins and identity lock', { skip: !enabled, timeout: 120_000 }, async t => {
  const database = 'wmsd_lots_test_' + key();
  await mongoose.connect(`mongodb://127.0.0.1:27017/${database}?replicaSet=rs0`, { serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    if (mongoose.connection.name !== database) throw Error('Unsafe test database');
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  });
  const data = await buildReviewedDemo();
  for (const [name, Model] of m.models) {
    await Model.createCollection();
    if (data[name]?.length) await Model.collection.insertMany(data[name]);
    await Model.createIndexes();
  }
  const owner = await m.User.findOne({ roleId: (await m.Role.findOne({ code: 'OWNER' }))._id });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const api = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
      authorization: 'Bearer ' + jwt.sign({ userId: String(owner._id) }, process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026') },
      ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const product = await m.Product.findOne({ isActive: true });
  const spec = { piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' };

  const created = await api('POST', '/lots', { productId: String(product._id), manufacturerLot: 'T-' + key(), identificationStatus: 'VERIFIED',
    tone: 'B08', calibre: 'C2', verificationReference: 'Tem nhãn 123', notes: 'Ghi chú', ...spec });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lot = created.body.data;
  assert.deepEqual([lot.tone, lot.calibre, lot.verificationReference, lot.notes], ['B08', 'C2', 'Tem nhãn 123', 'Ghi chú']);
  assert.equal(String(lot.verifiedBy), String(owner._id));
  assert.ok(lot.verifiedAt);

  // Optional at the API: a lot without tone/calibre stays valid; over-long values do not.
  assert.equal((await api('POST', '/lots', { productId: String(product._id), manufacturerLot: 'N-' + key(), identificationStatus: 'UNKNOWN', ...spec })).status, 201);
  assert.equal((await api('POST', '/lots', { productId: String(product._id), manufacturerLot: 'L-' + key(), identificationStatus: 'UNKNOWN', tone: 'x'.repeat(21), ...spec })).status, 400);

  const listed = await api('GET', '/lots?tone=b0&calibre=c2&limit=100');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const row = listed.body.data.items.find(item => item.id === lot.id);
  assert.ok(row, 'filtered list contains the new lot');
  assert.deepEqual(row.product, { id: String(product._id), sku: product.sku, name: product.name });
  assert.equal(row.hasScopedStock, false);
  assert.equal(listed.body.data.items.some(item => item.tone !== 'B08'), false);

  const detail = (await api('GET', `/lots/${lot.id}`)).body.data;
  assert.equal(detail.identityLocked, false);
  assert.deepEqual(detail.stock, []);
  assert.equal(detail.verifiedBy.id, String(owner._id));

  // No stock/documents yet: identity may change; notes always may.
  let updated = await api('PUT', `/lots/${lot.id}`, { tone: 'A1', notes: 'Đã sửa', expectedUpdatedAt: detail.updatedAt });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.tone, 'A1');

  // A lot that already holds stock is locked for tone/calibre but not for notes.
  const balance = await m.InventoryBalance.findOne({ quantityBase: { $gt: 0 }, ownerType: 'STORE' });
  const stocked = (await api('GET', `/lots/${balance.batchId}`)).body.data;
  assert.equal(stocked.identityLocked, true);
  assert.ok(stocked.stock.length > 0 && stocked.stock.every(s => s.warehouse?.code && s.quantityBase));
  const locked = await api('PUT', `/lots/${balance.batchId}`, { tone: 'ZZ9', expectedUpdatedAt: stocked.updatedAt });
  assert.equal(locked.status, 400, JSON.stringify(locked.body));
  const keepTone = await api('PUT', `/lots/${balance.batchId}`, { tone: stocked.tone ?? null, notes: 'Ghi chú mới', expectedUpdatedAt: stocked.updatedAt });
  assert.equal(keepTone.status, 200, JSON.stringify(keepTone.body));
  const flagged = (await api('GET', `/lots?productId=${stocked.productId}&limit=100`)).body.data.items.find(item => item.id === String(balance.batchId));
  assert.equal(flagged.hasScopedStock, true);
});
