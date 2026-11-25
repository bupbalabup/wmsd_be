import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { isLoopbackMongoUri } from '../src/config/local-mongo.js';
import { PERMISSION_CATALOGUE } from '../src/seeds/data/permissions.data.js';

export function openingStockTarget(uri, { allowRemote = false } = {}) {
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('Set MONGODB_URI to the intended MongoDB application database.');
  if (!allowRemote && !isLoopbackMongoUri(uri)) throw new Error('Use --allow-remote to install opening stock on Atlas or another remote database.');
  const database = decodeURIComponent(uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/)?.[1] || '');
  if (!database || ['admin', 'local', 'config'].includes(database)) throw new Error('Name the application database explicitly.');
  return database;
}

export async function setupOpeningStock(uri, { apply = false, allowRemote = false } = {}) {
  const database = openingStockTarget(uri, { allowRemote });
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const db = connection.db;
    const duplicates = await db.collection('opening_stocks').aggregate([
      { $match: { workflowStatus: 'POSTED', 'header.openingImportSource': 'FILE' } }, { $group: { _id: '$header.warehouseId', count: { $sum: 1 } } },
      { $match: { $or: [{ count: { $gt: 1 } }, { _id: null }] } },
    ]).toArray();
    if (duplicates.length) throw new Error('Resolve duplicate or unscoped posted file-import opening documents before setup. No data changed.');
    const permissions = PERMISSION_CATALOGUE.filter(p => p.code.startsWith('opening_stock:'));
    if (!apply) return { applied: false, database, permissionCodes: permissions.map(p => p.code), uniquePostedFileImportWarehouseIndex: true, ownerOnly: true };
    const indexes = await db.collection('permissions').indexes();
    if (!indexes.some(index => index.unique && index.key.code === 1 && Object.keys(index.key).length === 1 && !index.sparse && !index.partialFilterExpression)) throw new Error('Existing permissions.code must have its unique index before setup.');
    const openingIndexes = await db.collection('opening_stocks').indexes();
    const fileImportIndex = openingIndexes.find(index => index.name === 'opening_stock_file_import_once');
    if (fileImportIndex && (!fileImportIndex.unique || Object.keys(fileImportIndex.key).length !== 1 || fileImportIndex.key['header.warehouseId'] !== 1 || Object.keys(fileImportIndex.partialFilterExpression || {}).length !== 2 || fileImportIndex.partialFilterExpression?.workflowStatus !== 'POSTED' || fileImportIndex.partialFilterExpression?.['header.openingImportSource'] !== 'FILE')) throw new Error('The opening-stock file-import index has unexpected options. No data changed.');
    if (!fileImportIndex) await db.collection('opening_stocks').createIndex({ 'header.warehouseId': 1 }, { name: 'opening_stock_file_import_once', unique: true, partialFilterExpression: { workflowStatus: 'POSTED', 'header.openingImportSource': 'FILE' } });
    const previousIndex = openingIndexes.find(index => index.unique && index.key['header.warehouseId'] === 1 && Object.keys(index.key).length === 1 && index.name === 'header.warehouseId_1');
    if (previousIndex && (previousIndex.partialFilterExpression?.workflowStatus !== 'POSTED' || Object.keys(previousIndex.partialFilterExpression).length !== 1)) throw new Error('The previous opening-stock warehouse index has unexpected options. No data changed.');
    if (previousIndex) await db.collection('opening_stocks').dropIndex(previousIndex.name);
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const permission of permissions) {
          const now = new Date();
          await db.collection('permissions').updateOne({ code: permission.code }, { $setOnInsert: { code: permission.code, name: permission.code, isActive: true, createdAt: now }, $set: { description: permission.description, updatedAt: now } }, { upsert: true, session });
          const saved = await db.collection('permissions').findOne({ code: permission.code }, { session });
          await db.collection('roles').updateMany({ code: { $in: permission.roles } }, { $addToSet: { permissionIds: saved._id } }, { session });
          await db.collection('roles').updateMany({ code: { $ne: 'OWNER' } }, { $pull: { permissionIds: saved._id } }, { session });
        }
        await db.collection('warehouses').updateMany({ stockOperationVersion: { $exists: false } }, { $set: { stockOperationVersion: 0 } }, { session });
      });
    } finally { await session.endSession(); }
    return { applied: true, database, permissionCodes: permissions.map(p => p.code) };
  } finally { await connection.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const uri = process.argv.slice(2).find(arg => !arg.startsWith('--')) || process.env.MONGODB_URI;
  setupOpeningStock(uri, { apply: process.argv.includes('--apply'), allowRemote: process.argv.includes('--allow-remote') }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(uri ? error.message.replaceAll(uri, '[MONGODB_URI]') : error.message); process.exitCode = 1; });
}
