import * as m from '../../models/runtime.js';

export async function createInAppNotification({
  recipientId,
  type,
  eventKey,
  dedupKey,
  sourceType,
  sourceId,
  sourceVersion = 1,
  warehouseIds = [],
  title,
  message,
  session = null,
}) {
  if (!recipientId) return null;
  const payload = {
    recipientId,
    type,
    eventKey: String(eventKey).slice(0, 160),
    dedupKey: String(dedupKey).slice(0, 400),
    sourceType,
    sourceId,
    sourceVersion: Math.max(1, Number(sourceVersion) || 1),
    warehouseIds,
    title: String(title).slice(0, 200),
    message: String(message).slice(0, 2000),
    occurredAt: new Date(),
    emailDelivery: { status: 'SKIPPED', attempts: 0 },
  };
  try {
    return await new m.Notification(payload).save(session ? { session } : {});
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}