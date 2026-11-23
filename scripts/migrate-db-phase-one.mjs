import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const [mode, database, file, ...extra] = process.argv.slice(2);
if (!['backup', 'apply', 'restore'].includes(mode) || !file || extra.length ||
    !database || ['admin', 'config', 'local'].includes(database) ||
    decodeURIComponent(new URL(process.env.MONGODB_URI).pathname.slice(1)) !== database) {
  throw new Error('Usage: MONGODB_URI must select the named database. Pass backup|apply|restore DATABASE BACKUP_FILE.');
}

const lock = 'replenishment_locks';
const targets = [
  ['sales_orders', 'replenishmentPlanningVersion'],
  ['warehouse_transfer_requests', 'header.executionStatus'],
];
const { MongoClient, BSON } = mongoose.mongo;
const client = new MongoClient(process.env.MONGODB_URI, {
  appName: 'wmsd-db-phase-one', serverSelectionTimeoutMS: 7000,
  readPreference: 'primary', writeConcern: { w: 'majority' },
});
const db = client.db(database);
const json = value => BSON.EJSON.stringify(value, { relaxed: false });
const parse = value => BSON.EJSON.parse(value, { relaxed: false });
const metadata = name => db.listCollections({ name }).next();
const countField = (name, field, session) => db.collection(name).countDocuments({ [field]: { $exists: true } }, { session });
const valueAt = (row, field) => field.split('.').reduce((obj, key) => obj[key], row);

async function readLocks(name) {
  const info = await metadata(name);
  if (!info) return null;
  assert.equal(info.type, 'collection');
  const collection = db.collection(name);
  const indexes = await collection.listIndexes().toArray();
  const rows = await collection.find({}, { promoteValues: false }).sort({ _id: 1 }).toArray();
  return { options: info.options, indexes: indexes.sort((a, b) => a.name.localeCompare(b.name)), rows };
}

async function capture() {
  const fields = [];
  for (const [name, field] of targets) {
    const info = await metadata(name);
    assert.ok(info?.info?.uuid, 'Missing target collection: ' + name);
    const rows = await db.collection(name).find({ [field]: { $exists: true } }, {
      projection: { _id: 1, [field]: 1 }, promoteValues: false,
    }).sort({ _id: 1 }).toArray();
    fields.push({ uuid: info.info.uuid.toString(), rows });
  }
  return { format: 'wmsd-phase-one-v1', database, token: randomUUID(), locks: await readLocks(lock), fields };
}

function equal(actual, expected, message) {
  if (json(actual) !== json(expected)) throw new Error(message);
}

async function changeFields(backup, restore) {
  await client.withSession(session => session.withTransaction(async () => {
    for (const [i, [name, field]] of targets.entries()) {
      const collection = db.collection(name);
      for (const row of backup.fields[i].rows) {
        const value = valueAt(row, field);
        const present = { _id: row._id, [field]: { $exists: true, $eq: value } };
        const absent = { _id: row._id, [field]: { $exists: false } };
        const changed = restore
          ? await collection.updateOne(absent, { $set: { [field]: value } }, { session })
          : await collection.updateOne(present, { $unset: { [field]: '' } }, { session });
        if (!changed.matchedCount && !await collection.findOne(restore ? present : absent, { projection: { _id: 1 }, session })) {
          throw new Error('Document missing or field changed since backup: ' + name + '.' + field);
        }
      }
      if (!restore && await countField(name, field, session)) throw new Error('Found additional values since backup: ' + field);
    }
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }));
}

async function restoreLocks(backup, stage) {
  if (!backup.locks) return;
  const existing = await readLocks(lock);
  if (existing) {
    equal(existing, backup.locks, 'Existing lock collection differs from backup');
    return;
  }
  if (!await metadata(stage)) await db.createCollection(stage, backup.locks.options);
  const collection = db.collection(stage);
  for (const row of backup.locks.rows) {
    if (!await collection.findOne({ _id: row._id }, { projection: { _id: 1 } })) await collection.insertOne(row);
  }
  for (const { key, v, ns, ...options } of backup.locks.indexes) {
    if (options.name !== '_id_') await collection.createIndex(key, options);
  }
  equal(await readLocks(stage), backup.locks, 'Restored documents or indexes differ');
  await collection.rename(lock, { dropTarget: false });
}

try {
  await client.connect();
  if (mode === 'backup') {
    const backup = await capture();
    await writeFile(file, json(backup), { flag: 'wx', mode: 0o600 });
    equal(parse(await readFile(file, 'utf8')), backup, 'Backup read-back failed');
    console.log('Backup verified', database, 'locks:', backup.locks?.rows.length ?? 0, 'field counts:', backup.fields.map(f => f.rows.length));
  } else {
    const backup = parse(await readFile(file, 'utf8'));
    assert.equal(backup.format, 'wmsd-phase-one-v1');
    assert.equal(backup.database, database);
    assert.match(backup.token, /^[a-f0-9-]{36}$/);
    for (const [i, [name]] of targets.entries()) {
      assert.equal((await metadata(name))?.info?.uuid.toString(), backup.fields[i].uuid, 'Backup belongs to another database instance');
    }
    const stage = 'phase1_locks_' + backup.token;
    if (mode === 'apply') {
      const original = await readLocks(lock);
      if (original) {
        equal(original, backup.locks, 'Lock collection changed since backup');
        await db.collection(lock).rename(stage, { dropTarget: false });
      }
      const staged = await readLocks(stage);
      if (staged) equal(staged, backup.locks, 'Quarantined lock collection differs from backup');
      await changeFields(backup, false);
      if (staged) await db.collection(stage).drop();
      if (await metadata(lock) || await metadata(stage)) throw new Error('Lock collection reappeared');
      for (const [name, field] of targets) assert.equal(await countField(name, field), 0, 'Retired field reappeared: ' + field);
    } else {
      await restoreLocks(backup, stage);
      await changeFields(backup, true);
    }
    console.log('Verified', mode, database);
  }
} catch (error) {
  // Driver errors can contain connection details or document values.
  console.error('Migration stopped:', error.name, error.code ?? '', error.name === 'Error' ? error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[URI]') : '');
  process.exitCode = 1;
} finally {
  await client.close();
}
