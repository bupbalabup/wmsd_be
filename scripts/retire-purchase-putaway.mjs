import mongoose from 'mongoose';
import { requireLoopbackMongoUri } from '../src/config/local-mongo.js';
import { Permission, PurchaseReceipt, StockTransaction, TransferOrder } from '../src/models/runtime.js';
import { exact } from '../src/models/model-utils.js';
import { appendAudit, changedFields } from '../src/shared/utils/audit.js';

const cancellationReason = 'Ngừng lệnh cất hàng mua, chuyển sang lệnh chuyển vị trí';
const permissionFilter = { code: /^putaway_task:/, isActive: { $ne: false } };

async function retire(apply, session = null) {
  const candidates = await TransferOrder.find({
    'header.taskKind': 'PUTAWAY',
    'header.requirementId': null,
    'sources.subjectCollection': 'goods_receipts',
    workflowStatus: { $in: ['OPEN', 'PARTIAL'] },
  }).sort({ _id: 1 }).session(session);
  const receiptRefs = task => task.sources.filter(ref => ref.subjectCollection === 'goods_receipts');
  const purchaseReceiptIds = new Set((await PurchaseReceipt.find({
    _id: { $in: candidates.flatMap(task => receiptRefs(task).map(ref => ref.documentId)) },
  }).distinct('_id').session(session)).map(String));
  const tasks = candidates.filter(task => receiptRefs(task).some(ref => purchaseReceiptIds.has(String(ref.documentId))));

  const postings = await StockTransaction.find({ sourceType: 'transfer_orders', sourceId: { $in: tasks.map(task => task._id) } })
    .select('sourceId movements.sourceLineId movements.fromBalanceId movements.quantityBase').lean().session(session);
  const movedByLine = new Map();
  for (const posting of postings) {
    for (const move of posting.movements) {
      const key = `${posting.sourceId}:${move.sourceLineId}:${move.fromBalanceId}`;
      movedByLine.set(key, (movedByLine.get(key) ?? exact('0')).plus(String(move.quantityBase)));
    }
  }
  const permissions = await Permission.distinct('code', permissionFilter).session(session);
  const report = { applied: apply, database: mongoose.connection.name, tasks: [], permissions: permissions.sort() };
  for (const task of tasks) {
    const lines = task.items.map(item => {
      const sourceBalanceId = item.details?.sourceBalanceId ? String(item.details.sourceBalanceId) : null;
      const moved = movedByLine.get(`${task._id}:${item._id}:${sourceBalanceId}`) ?? exact('0');
      return { lineId: String(item._id), sourceBalanceId, releasedQtyBase: sourceBalanceId ? exact(item.qtyBase).minus(moved).toFixed() : '0' };
    });
    report.tasks.push({ id: String(task._id), documentNo: task.documentNo, previousStatus: task.workflowStatus, lines });
    if (!apply) continue;

    const cancellation = { workflowStatus: 'CANCELLED', cancelReason: cancellationReason, cancelledAt: new Date() };
    const result = await TransferOrder.updateOne(
      { _id: task._id, workflowStatus: task.workflowStatus, version: task.version },
      { $set: cancellation, $inc: { version: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1) throw new Error(`Task ${task.documentNo} changed during retirement`);
    await appendAudit({
      documentId: task._id,
      entityType: 'transfer_orders',
      action: 'RETIRE_PURCHASE_PUTAWAY',
      changes: changedFields(task, cancellation, Object.keys(cancellation)),
      details: cancellationReason,
      warehouseIds: [task.header.warehouseId],
      versionBefore: task.version,
      versionAfter: task.version + 1,
      session,
    });
  }
  if (apply) await Permission.updateMany(permissionFilter, { $set: { isActive: false } }, { session });
  return report;
}

try {
  const args = process.argv.slice(2);
  const uris = args.filter(arg => arg.startsWith('--uri='));
  if (uris.length !== 1 || args.some(arg => !arg.startsWith('--uri=') && arg !== '--apply')) {
    throw new Error('Usage: node scripts/retire-purchase-putaway.mjs --uri=mongodb://127.0.0.1:27017/<db> [--apply]');
  }
  const uri = uris[0].slice(6);
  requireLoopbackMongoUri(uri);
  const database = decodeURIComponent(new URL(uri).pathname.slice(1));
  if (!database || ['admin', 'config', 'local'].includes(database.toLowerCase())) {
    throw new Error('Pass the explicit name of the local application database.');
  }
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, directConnection: true, serverSelectionTimeoutMS: 5000 });
  const apply = args.includes('--apply');
  const report = apply
    ? await mongoose.connection.transaction(session => retire(true, session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    })
    : await retire(false);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('[Retire purchase putaway]', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
