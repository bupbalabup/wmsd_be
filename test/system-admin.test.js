import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import * as models from '../src/models/runtime.js';
import { createApp } from '../src/app.js';
import { discoverRoutes } from '../src/shared/utils/routeRegistry.js';
import { normalizePath, errorFingerprint } from '../src/shared/utils/errorLog.js';
import { initialEmailDelivery, notificationEmailEnabled, processNotificationEmails } from '../src/modules/notifications/email.js';

// Mocked-model tests for the 23/11/2026 administration features. No database or SMTP connection is opened.
const { User, AppSetting, AuditLog, ApiEndpoint, Product, Notification } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026';
const ownerId = 'a'.repeat(24);
const adminId = 'b'.repeat(24);
const salesId = 'c'.repeat(24);

const role = (code, permissions) => ({ code, isActive: true, permissionIds: permissions.map((p) => ({ code: p, isActive: true })) });
const users = {
  [ownerId]: { _id: ownerId, username: 'owner', fullName: 'Chủ', isActive: true, warehouseIds: [], roleId: role('OWNER', ['dashboard:read', 'sales_policy:read', 'sales_policy:update', 'audit_log:read', 'product:read', 'inventory:read']) },
  [adminId]: { _id: adminId, username: 'admin', fullName: 'Quản trị', isActive: true, warehouseIds: [], roleId: role('ADMIN', ['user:read', 'api_catalogue:read', 'api_catalogue:update', 'system_monitor:read', 'audit_log:read']) },
  [salesId]: { _id: salesId, username: 'sales', fullName: 'Bán hàng', isActive: true, warehouseIds: [], roleId: role('SALES', ['product:read']) },
};
const query = (value) => ({
  select: () => query(value), populate: () => query(value), sort: () => query(value), limit: () => query(value), skip: () => query(value),
  lean: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

function stubAuth() {
  mock.method(User, 'findById', (id) => query(users[String(id)] ?? null));
  mock.method(User, 'find', () => query([]));
  mock.method(AuditLog.prototype, 'save', async function save() { return this; });
}

async function api(t) {
  const app = createApp({ logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return (as, path, method = 'GET', body) => fetch(base + path, {
    method, headers: { authorization: `Bearer ${jwt.sign({ userId: as }, JWT_SECRET, { expiresIn: '5m' })}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

afterEach(() => mock.restoreAll());

test('route discovery rebuilds full URLs through nested and pathless mounts', () => {
  const app = express();
  app.use(express.json());
  const inner = express.Router();
  inner.get('/:id', () => {});
  inner.post('/', () => {});
  const outer = express.Router();
  outer.use('/things', inner);
  outer.use(express.Router().get('/flat', () => {}));
  app.use('/api', outer);
  const urls = discoverRoutes(app).map((r) => `${r.method} ${r.url}`);
  assert.deepEqual(urls, ['GET /api/flat', 'POST /api/things', 'GET /api/things/:id']);
  const all = discoverRoutes(createApp({ logRequests: false }));
  for (const expected of ['GET /api/dashboard/owner', 'PUT /api/settings/sales-policy', 'GET /api/system/audit-logs', 'POST /api/system/api-endpoints/sync', 'GET /api/search', 'POST /api/auth/login']) {
    assert.ok(all.some((r) => `${r.method} ${r.url}` === expected), expected);
  }
});

test('error fingerprints ignore ids and numbers so one bug is one row', () => {
  assert.equal(normalizePath('/api/users/aaaaaaaaaaaaaaaaaaaaaaaa/status?x=1'), '/api/users/:id/status');
  assert.equal(normalizePath('/api/goods-issues/PX-KHO1-261123-0001'), '/api/goods-issues/:id');
  const a = errorFingerprint({ source: 'HTTP', method: 'GET', path: '/api/lots/aaaaaaaaaaaaaaaaaaaaaaaa', errorName: 'TypeError', message: 'Cannot read 12 of undefined' });
  const b = errorFingerprint({ source: 'HTTP', method: 'GET', path: '/api/lots/bbbbbbbbbbbbbbbbbbbbbbbb', errorName: 'TypeError', message: 'Cannot read 99 of undefined' });
  assert.equal(a, b);
});

test('sales policy: defaults, validation, optimistic version and audit', async (t) => {
  stubAuth();
  let row = null;
  mock.method(AppSetting, 'findOne', () => query(row));
  mock.method(AppSetting, 'create', async (doc) => { row = { _id: 'd'.repeat(24), ...doc, updatedAt: new Date() }; return row; });
  mock.method(AppSetting, 'findOneAndUpdate', async (filter, update) => {
    if (!row || filter.version !== row.version) return null;
    row = { ...row, ...update.$set, version: row.version + 1 };
    return row;
  });
  const audits = [];
  mock.method(AuditLog.prototype, 'save', async function save() { audits.push({ action: this.action, changes: this.changes.map((c) => c.field) }); return this; });
  mock.method(AuditLog, 'find', () => query([]));
  const call = await api(t);

  const initial = await call(ownerId, '/settings/sales-policy');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.version, 0);
  assert.equal(initial.body.data.policy.agingInventoryThresholdDays, 180);

  const body = { ...initial.body.data.policy, agingInventoryThresholdDays: 90, version: 0 };
  assert.equal((await call(ownerId, '/settings/sales-policy', 'PUT', { ...body, suggestedLossRate: 40 })).status, 400);
  assert.equal((await call(ownerId, '/settings/sales-policy', 'PUT', { ...body, extra: 1 })).status, 400);
  assert.equal((await call(salesId, '/settings/sales-policy', 'PUT', body)).status, 403);

  const saved = await call(ownerId, '/settings/sales-policy', 'PUT', body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.policy.agingInventoryThresholdDays, 90);
  assert.equal(saved.body.data.version, 1);
  assert.deepEqual(audits, [{ action: 'UPDATE_SALES_POLICY', changes: ['agingInventoryThresholdDays'] }]);

  const stale = await call(ownerId, '/settings/sales-policy', 'PUT', { ...body, returnDaysWindow: 10, version: 0 });
  assert.equal(stale.status, 409);
});

test('API catalogue: admin only; SYSTEM URLs are read-only; only MANUAL rows can be deleted', async (t) => {
  stubAuth();
  const rows = {
    sys: { _id: 'e'.repeat(24), method: 'GET', url: '/api/lots', name: 'GET /api/lots', source: 'SYSTEM', isPresent: true, isActive: true },
    man: { _id: 'f'.repeat(24), method: 'GET', url: '/api/custom', name: 'Custom', source: 'MANUAL', isPresent: true, isActive: true },
  };
  const doc = (row) => ({ ...row, toObject() { return { ...this }; }, save: async function save() { return this; }, deleteOne: async () => ({}) });
  mock.method(ApiEndpoint, 'findById', async (id) => (Object.values(rows).find((r) => r._id === String(id)) ? doc(Object.values(rows).find((r) => r._id === String(id))) : null));
  mock.method(ApiEndpoint, 'create', async (input) => ({ _id: '1'.repeat(24), ...input }));
  mock.method(ApiEndpoint, 'exists', async () => null);
  const call = await api(t);

  assert.equal((await call(ownerId, '/system/api-endpoints')).status, 403);
  assert.equal((await call(adminId, '/system/api-endpoints', 'POST', { url: 'no-slash', name: 'X Y' })).status, 400);
  const created = await call(adminId, '/system/api-endpoints', 'POST', { method: 'POST', url: '/api/reports/custom', name: 'Báo cáo tuỳ chỉnh', description: 'Mô tả' });
  assert.equal(created.status, 200);
  assert.equal(created.body.data.source, 'MANUAL');
  assert.equal(created.body.data.module, 'reports');

  assert.equal((await call(adminId, `/system/api-endpoints/${rows.sys._id}`, 'PATCH', { url: '/api/other' })).status, 400);
  const renamed = await call(adminId, `/system/api-endpoints/${rows.sys._id}`, 'PATCH', { name: 'Danh sách lô', description: 'Xem lô hàng' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.name, 'Danh sách lô');
  assert.equal((await call(adminId, `/system/api-endpoints/${rows.sys._id}`, 'DELETE')).status, 400);
  assert.equal((await call(adminId, `/system/api-endpoints/${rows.man._id}`, 'DELETE')).status, 200);
});

test('admin screens are permission-guarded', async (t) => {
  stubAuth();
  const call = await api(t);
  assert.equal((await call(salesId, '/system/audit-logs')).status, 403);
  assert.equal((await call(ownerId, '/system/monitor')).status, 403);
  assert.equal((await call(ownerId, '/system/error-logs')).status, 403);
  assert.equal((await call(adminId, '/dashboard/owner')).status, 403);
  assert.equal((await call(salesId, '/stock-alerts/scan', 'POST')).status, 403);
});

test('quick search only searches groups the caller may read', async (t) => {
  stubAuth();
  const searched = [];
  mock.method(Product, 'find', (filter) => { searched.push('products'); assert.ok(filter.$or); return query([{ _id: '2'.repeat(24), sku: 'GACH-01', name: 'Gạch 60x60', baseUnit: 'm2' }]); });
  const call = await api(t);
  assert.equal((await call(salesId, '/search?q=a')).status, 400);
  const res = await call(salesId, '/search?q=gach');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.groups.map((g) => g.key), ['products']);
  assert.equal(res.body.data.groups[0].items[0].href, `/products/${'2'.repeat(24)}`);
  assert.deepEqual(searched, ['products']);
});

test('quick search labels document status from the status code, falling back to the code', async (t) => {
  stubAuth();
  users[salesId].roleId.permissionIds.push({ code: 'replenishment_request:read', isActive: true });
  t.after(() => users[salesId].roleId.permissionIds.pop());
  mock.method(Product, 'find', () => query([]));
  mock.method(models.ReplenishmentRequest, 'find', () => query([
    { _id: 'YCBS-KHO1-261125-000001', documentNo: 'YCBS-KHO1-261125-000001', workflowStatus: 'SUBMITTED' },
    { _id: 'YCBS-KHO1-261125-000002', documentNo: 'YCBS-KHO1-261125-000002', workflowStatus: 'UNKNOWN_STATUS' },
  ]));
  const res = await (await api(t))(salesId, '/search?q=YCBS');
  const group = res.body.data.groups.find((g) => g.key === 'replenishment_requests');
  assert.deepEqual(group.items.map((i) => i.subtitle), ['Chờ duyệt', 'UNKNOWN_STATUS']);
});

test('notification emails: enabled only with mail config; pending copies are sent once and marked SENT', async () => {
  const saved = { MAIL_TRANSPORT: process.env.MAIL_TRANSPORT, SMTP_HOST: process.env.SMTP_HOST, NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL };
  try {
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_TRANSPORT;
    assert.equal(notificationEmailEnabled(), false);
    assert.equal(initialEmailDelivery({ email: 'a@example.test' }).status, 'SKIPPED');
    process.env.MAIL_TRANSPORT = 'console';
    assert.equal(initialEmailDelivery({ email: 'a@example.test' }).status, 'PENDING');
    assert.equal(initialEmailDelivery({}).status, 'SKIPPED');
    process.env.NOTIFICATION_EMAIL = 'off';
    assert.equal(notificationEmailEnabled(), false);
    delete process.env.NOTIFICATION_EMAIL;

    const pending = [{ _id: '3'.repeat(24), recipientId: salesId, title: 'Tồn dưới ngưỡng: GACH-01 tại KHO1', message: 'Khả dụng 2 m2', sourceType: 'products', sourceId: '2'.repeat(24), emailDelivery: { status: 'PENDING', attempts: 1 } }];
    const updates = [];
    mock.method(Notification, 'findOneAndUpdate', () => query(pending.shift() ?? null));
    mock.method(Notification, 'updateOne', async (filter, update) => { updates.push(update.$set); return {}; });
    mock.method(User, 'findById', () => query({ fullName: 'Bán hàng', email: 'sales@example.test', isActive: true }));
    const mails = [];
    mock.method(console, 'info', (line) => mails.push(String(line)));
    assert.equal(await processNotificationEmails(5), 1);
    assert.equal(mails.length, 1);
    assert.match(mails[0], /to=sales@example\.test subject=\[Tân Thương\] Tồn dưới ngưỡng/);
    assert.equal(updates[0]['emailDelivery.status'], 'SENT');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
