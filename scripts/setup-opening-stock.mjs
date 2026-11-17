import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { requireLoopbackMongoUri } from '../src/config/local-mongo.js';
import { PERMISSION_CATALOGUE } from '../src/seeds/data/permissions.data.js';

export async function setupOpeningStock(uri, { apply = false } = {}) {
  requireLoopbackMongoUri(uri);
  const database = decodeURIComponent(new URL(uri).pathname.slice(1));
  if (!database || ['admin', 'local', 'config'].includes(database)) throw new Error('Name the local application database explicitly.');
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const db = connection.db;
    const duplicates = await db.collection('opening_stocks').aggregate([
      { $match: { workflowStatus: 'POSTED' } }, { $group: { _id: '$header.warehouseId', count: { $sum: 1 } } },
      { $match: { $or: [{ count: { $gt: 1 } }, { _id: null }] } },
    ]).toArray();
    if (duplicates.length) throw new Error('Resolve duplicate or unscoped posted opening documents before setup. No data changed.');
    const permissions = PERMISSION_CATALOGUE.filter(p => p.code.startsWith('opening_stock:'));
    if (!apply) return { applied: false, database, permissionCodes: permissions.map(p => p.code), uniquePostedWarehouseIndex: true, ownerOnly: true };
    const indexes = await db.collection('permissions').indexes();
    if (!indexes.some(index => index.unique && index.key.code === 1 && Object.keys(index.key).length === 1 && !index.sparse && !index.partialFilterExpression)) throw new Error('Existing permissions.code must have its unique index before setup.');
    await db.collection('opening_stocks').createIndex({ 'header.warehouseId': 1 }, { unique: true, partialFilterExpression: { workflowStatus: 'POSTED' } });
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
  setupOpeningStock(process.argv[2], { apply: process.argv.includes('--apply') }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
