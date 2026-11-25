import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import * as models from '../src/models/runtime.js';
import { createApp } from '../src/app.js';
import { discoverRoutes } from '../src/shared/utils/routeRegistry.js';
import { normalizePath, errorFingerprint } from '../src/shared/utils/errorLog.js';
import { initialEmailDelivery, notificationEmailEnabled, processNotificationEmails } from '../src/modules/notifications/email.js';
import { evaluateThresholds } from '../src/modules/stock-alerts/stock-alert.service.js';

// Mocked-model tests for the 23/11/2026 administration features. No database or SMTP connection is opened.
const { User, AuditLog, ApiEndpoint, Product, Notification, AppSetting } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026';
const ownerId = 'a'.repeat(24);
const adminId = 'b'.repeat(24);
const salesId = 'c'.repeat(24);

const role = (code, permissions) => ({ code, isActive: true, permissionIds: permissions.map((p) => ({ code: p, isActive: true })) });
const users = {
  [ownerId]: { _id: ownerId, username: 'owner', fullName: 'Chủ', isActive: true, warehouseIds: [], roleId: role('OWNER', ['dashboard:read', 'audit_log:read', 'product:read', 'inventory:read', 'system_setting:read']) },
  [adminId]: { _id: adminId, username: 'admin', fullName: 'Quản trị', isActive: true, warehouseIds: [], roleId: role('ADMIN', ['user:read', 'api_catalogue:read', 'api_catalogue:update', 'system_monitor:read', 'audit_log:read', 'system_setting:read', 'system_setting:update']) },
  [salesId]: { _id: salesId, username: 'sales', fullName: 'Bán hàng', isActive: true, warehouseIds: [], roleId: role('SALES', ['product:read']) },
};
const query = (value) => ({
  select: () => query(value), session: () => query(value), populate: () => query(value), sort: () => query(value), limit: () => query(value), skip: () => query(value),
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
  assert.ok(!all.some((r) => r.url === '/api/settings/sales-policy'), 'sales policy API removed (LI-10)');
  for (const expected of ['GET /api/dashboard/owner', 'GET /api/stock-alerts', 'GET /api/system/audit-logs', 'POST /api/system/api-endpoints/sync', 'GET /api/search', 'POST /api/auth/login', 'GET /api/settings/system', 'PUT /api/settings/system']) {
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

test('sales policy API is removed (scope LI-10, 25/11/2026)', async (t) => {
  stubAuth();
  const call = await api(t);
  assert.equal((await call(ownerId, '/settings/sales-policy')).status, 404);
  assert.equal((await call(ownerId, '/settings/sales-policy', 'PUT', { version: 0 })).status, 404);
});

test('system settings: owner reads, only admin saves; validated, versioned and audited (25/11/2026)', async (t) => {
  stubAuth();
  let stored = null;
  const audits = [];
  mock.method(AppSetting, 'findOne', () => query(stored));
  mock.method(AppSetting, 'create', async (doc) => { stored = { _id: '9'.repeat(24), ...doc }; return stored; });
  mock.method(AppSetting, 'findOneAndUpdate', async (filter, update) => {
    if (!stored || filter.version !== stored.version) return null;
    stored = { ...stored, ...update.$set, version: stored.version + 1 };
    return stored;
  });
  mock.method(AuditLog, 'find', () => query([]));
  mock.method(AuditLog.prototype, 'save', async function save() { audits.push(this.action); return this; });
  const call = await api(t);
  const body = { defaultMinimumQty: '20', nearThresholdPercent: 25, dashboardLowStockRows: 15, dashboardAgingLotRows: 10, dashboardApprovalItems: 5, dashboardRecentDecisions: 10 };

  const read = await call(ownerId, '/settings/system');
  assert.equal(read.status, 200);
  assert.equal(read.body.data.version, 0);
  assert.equal(read.body.data.settings.defaultMinimumQty, '0');
  assert.equal(read.body.data.settings.dashboardLowStockRows, 10);
  assert.equal((await call(salesId, '/settings/system')).status, 403);
  assert.equal((await call(ownerId, '/settings/system', 'PUT', { ...body, version: 0 })).status, 403);
  assert.equal((await call(adminId, '/settings/system', 'PUT', { ...body, dashboardLowStockRows: 0, version: 0 })).status, 400);
  assert.equal((await call(adminId, '/settings/system', 'PUT', { ...body, defaultMinimumQty: '-1', version: 0 })).status, 400);

  const saved = await call(adminId, '/settings/system', 'PUT', { ...body, version: 0 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.version, 1);
  assert.equal(saved.body.data.settings.nearThresholdPercent, 25);
  assert.deepEqual(audits, ['UPDATE_SYSTEM_SETTINGS']);
  assert.equal((await call(adminId, '/settings/system', 'PUT', { ...body, version: 0 })).status, 409);
});

test('low-stock: the default minimum covers stocked pairs without their own threshold', async () => {
  const [P1, P2, W1, H1, L1, B2] = ['1', '2', '3', '4', '5', '6'].map((c) => c.repeat(24));
  mock.method(AppSetting, 'findOne', () => query({ value: { defaultMinimumQty: '3', nearThresholdPercent: 20 } }));
  mock.method(Product, 'find', () => query([
    { _id: P1, sku: 'A', name: 'Gạch A', baseUnit: 'm2', stockThresholds: [{ warehouseId: W1, minimumQty: '5', targetQty: '8' }] },
    { _id: P2, sku: 'B', name: 'Gạch B', baseUnit: 'm2', stockThresholds: [] },
  ]));
  mock.method(models.Warehouse, 'find', () => query([{ _id: W1, code: 'K1', name: 'Kho 1' }]));
  // Pair discovery reads balances/points/batches/locations by id; availability reads them by warehouse (none → 0).
  mock.method(models.InventoryBalance, 'find', (filter) => query(filter.holdingPointId ? [] : [{ holdingPointId: H1, batchId: B2 }]));
  mock.method(models.StockHoldingPoint, 'find', (filter) => query(filter._id ? [{ _id: H1, locationId: L1 }] : []));
  mock.method(models.ProductBatch, 'find', (filter) => query(filter._id?.$in ? [{ _id: B2, productId: P2 }] : []));
  mock.method(models.WarehouseLocation, 'find', (filter) => query(filter._id ? [{ _id: L1, warehouseId: W1 }] : []));
  mock.method(models.StocktakeLocationLock, 'find', () => query([]));
  const rows = await evaluateThresholds();
  assert.deepEqual(rows.map((row) => [row.product.sku, row.source, row.minimumQty, row.targetQty, row.status]), [
    ['A', 'PRODUCT', '5', '8', 'BELOW'],
    ['B', 'DEFAULT', '3', '3', 'BELOW'],
  ]);
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
