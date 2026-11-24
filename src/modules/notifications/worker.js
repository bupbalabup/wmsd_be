import { randomUUID } from 'node:crypto';
import { Notification, OperationRecord, SystemEvent, User } from '../../models/runtime.js';
import { canAccessWarehouse, hasPermission } from '../../shared/utils/access.js';
import { same } from '../../shared/utils/document-command.js';
import { rules, resolveSource } from './rules.js';
import { canReadSource } from './sources.js';
import { initialEmailDelivery } from './email.js';

async function deliver(event) {
  const op = await OperationRecord.findById(event.payload.operationId).lean();
  if (!op) throw new Error('Notification operation is missing');
  const source = await resolveSource(event, op);
  if (!source) return;
  const notices = await rules[event.eventType]({ ...source, op });
  for (const notice of notices) {
    const warehouseId = notice.warehouseId ?? source.doc.header?.warehouseId;
    const users = User.find({ isActive: true, ...(notice.userId && { _id: notice.userId }) })
      .populate({ path: 'roleId', populate: { path: 'permissionIds' } }).cursor();
    for await (const user of users) {
      if ((!notice.includeActor && same(user._id, op.actorId)) || !hasPermission(user, 'notification:read') ||
          (notice.permission && !hasPermission(user, notice.permission)) ||
          (warehouseId && !canAccessWarehouse(user, warehouseId))) continue;
      const item = {
        sourceType: source.sourceType, sourceId: source.sourceId, sourceVersion: source.sourceVersion,
        warehouseIds: warehouseId ? [warehouseId] : [],
      };
      if (!await canReadSource(user, item)) continue;
      const dedupKey = event.eventKey + ':' + user._id;
      try {
        await Notification.updateOne({ dedupKey }, { $setOnInsert: {
          ...item, dedupKey, recipientId: user._id, eventKey: event.eventKey, type: event.eventType,
          title: notice.title, message: source.doc.documentNo || notice.title, occurredAt: event.occurredAt,
          emailDelivery: initialEmailDelivery(user), createdAt: new Date(), updatedAt: new Date(),
        } }, { upsert: true, timestamps: false, runValidators: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
  }
}

export async function processNotificationEvent(cutoff) {
  const now = new Date();
  const leaseToken = randomUUID();
  const event = await SystemEvent.findOneAndUpdate({
    handlerCode: 'BUSINESS_NOTIFICATION', eventType: { $in: Object.keys(rules) },
    occurredAt: { $gte: cutoff }, 'payload.demo': { $ne: true },
    $or: [
      { status: 'PENDING', nextAttemptAt: null },
      { status: 'PENDING', nextAttemptAt: { $lte: now } },
      { status: 'PROCESSING', leaseUntil: { $lte: now } },
    ],
  }, { $set: { status: 'PROCESSING', leaseToken, leaseUntil: new Date(+now + 120_000) },
    $inc: { attempts: 1 } }, { sort: { occurredAt: 1 }, returnDocument: 'after' });
  if (!event) return false;
  const claimed = { _id: event._id, leaseToken };
  const release = { leaseToken: 1, leaseUntil: 1, nextAttemptAt: 1 };
  try {
    await deliver(event);
    await SystemEvent.updateOne(claimed, { $set: { status: 'COMPLETED', completedAt: new Date() }, $unset: release });
  } catch (error) {
    console.error('Notification delivery failed', String(event._id), error);
    await SystemEvent.updateOne(claimed, event.attempts >= 5
      ? { $set: { status: 'FAILED', lastErrorCode: 'DELIVERY_FAILED' }, $unset: release }
      : { $set: { status: 'PENDING', nextAttemptAt: new Date(Date.now() + 5000 * 2 ** event.attempts) },
          $unset: { leaseToken: 1, leaseUntil: 1 } });
  }
  return true;
}

export function startNotificationWorker(cutoff) {
  async function run() {
    try {
      for (let i = 0; i < 25; i++) {
        if (!await processNotificationEvent(cutoff)) break;
      }
    } catch (error) {
      console.error('Notification worker could not process events', error);
    } finally {
      setTimeout(run, 2000).unref();
    }
  }
  void run();
}
