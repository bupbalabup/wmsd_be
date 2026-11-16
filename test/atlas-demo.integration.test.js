import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { registerModels } from '../src/models/registry.js';
import { runAtlasDemo } from '../src/seeds/atlas-demo.seed.js';
import { buildReviewedDemo } from '../src/seeds/rebuild/data.js';

test('Atlas demo previews, rejects collisions and adds data once on a replica set', {
  skip: process.env.RUN_NATIVE_API_TESTS !== '1',
  timeout: 120_000,
}, async t => {
  const database = 'wmsd_atlas_seed_test_' + new mongoose.Types.ObjectId();
  const isolated = process.env.RUN_HIEUDT_TESTS === '1';
  const port = isolated ? 27018 : 27017;
  const replicaSet = isolated ? 'hieudt-test' : 'rs0';
  const connection = mongoose.createConnection();
  t.after(async () => {
    try {
      if (connection.db) await connection.dropDatabase();
    } finally {
      await connection.close();
    }
  });
  await connection.openUri(`mongodb://127.0.0.1:${port}/${database}?replicaSet=${replicaSet}`, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000,
  });
  const models = registerModels(connection);
  const template = await buildReviewedDemo();
  for (const [name, model] of models) {
    await model.createCollection();
    const indexes = model.schema.indexes().filter(([, options]) => options.unique)
      .map(([key, options]) => ({ key, ...options }));
    if (indexes.length) await connection.db.collection(name).createIndexes(indexes);
  }
  const warehouse2 = template.warehouses.find(row => row.code === 'K-GACH-02');
  const warehouse3 = template.warehouses.find(row => row.code === 'K-GACH-03');
  const shared = {
    warehouses: template.warehouses.filter(row => row !== warehouse3),
    users: template.users.map(row => ({
      ...row,
      warehouseIds: [...new Set(row.warehouseIds.map(id => String(id.equals(warehouse3._id) ? warehouse2._id : id)))]
        .map(id => new mongoose.Types.ObjectId(id)),
    })),
    roles: template.roles,
    permissions: template.permissions,
    categories: template.categories,
    uoms: template.uoms.map(row => row.code === 'Mét vuông' ? { ...row, code: 'M2' } : row),
  };
  for (const [name, rows] of Object.entries(shared)) {
    await connection.db.collection(name).insertMany(rows);
  }
  const products = connection.db.collection('products');
  const operations = connection.db.collection('operation_records');
  const existing = { ...template.products[0], sku: 'EXISTING-TILE' };
  await products.insertOne(existing);

  const preview = await runAtlasDemo(connection);
  assert.equal(preview.status, 'PREVIEW');
  assert.ok(preview.checks.length > 0);
  assert.match(preview.examples.products, /^DM01-/);
  assert.equal(await products.countDocuments(), 1);
  assert.equal(await operations.countDocuments(), 0);

  // The deployed product index compares SKU case-insensitively.
  const sample = template.products.find(row => 'DM01-' + row.sku === preview.examples.products);
  const sku = preview.examples.products.toLowerCase();
  await products.updateOne({ _id: existing._id }, {
    $set: { sku, manufacturerCode: sample.manufacturerCode, color: sample.color },
  });
  await assert.rejects(runAtlasDemo(connection, { apply: true }), /đã có dữ liệu dùng khóa seed ở products/);
  assert.equal(await products.countDocuments(), 1);
  assert.equal(await operations.countDocuments(), 0);
  await products.replaceOne({ _id: existing._id }, existing);

  const applied = await runAtlasDemo(connection, { apply: true });
  assert.deepEqual(applied, { ...preview, status: 'SEEDED_AND_VERIFIED' });
  assert.equal(await products.countDocuments(), preview.counts.products + 1);
  assert.deepEqual(await products.findOne({ _id: existing._id }), existing);
  const marker = await operations.findOne({ operationKey: preview.seed });
  assert.equal(marker.operationCode, 'DEMO_SEED');
  const requests = connection.db.collection('replenishment_requests');
  assert.ok(await requests.findOne({ _id: marker.subjectId }));
  for (const [name, rows] of Object.entries(shared)) {
    assert.equal(await connection.db.collection(name).countDocuments(), rows.length);
  }

  assert.deepEqual(await runAtlasDemo(connection, { apply: true }), {
    database, seed: preview.seed, status: 'ALREADY_SEEDED',
  });
  assert.equal(await products.countDocuments(), preview.counts.products + 1);
  assert.equal(await operations.countDocuments({ operationKey: preview.seed }), 1);
});
