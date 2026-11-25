import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as models from '../src/models/runtime.js';
import authRouter from '../src/modules/auth/auth.routes.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';

// Mocked-model tests for the self-service "Thông tin tài khoản" API. No database connection is opened.
const { User, Warehouse, AuditLog } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026';
const userId = 'c'.repeat(24);
const warehouseId = 'd'.repeat(24);
const PASSWORD = `Aa1${randomBytes(8).toString('hex')}`;
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

const role = { code: 'SALES', isActive: true, permissionIds: [{ code: 'user:read', isActive: true }] };
const account = (overrides = {}) => ({
  _id: userId, username: 'sales01', fullName: 'Nguyen Van A', phone: '0901234567', email: 'a@example.com',
  passwordHash, isActive: true, version: 3, warehouseIds: [warehouseId], roleId: role,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), ...overrides,
});

const query = (value) => ({
  select: () => query(value),
  populate: () => query(value),
  lean: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

function stub(doc) {
  let current = doc;
  mock.method(User, 'findById', () => query(current));
  mock.method(Warehouse, 'find', () => query([{ _id: warehouseId, code: 'KHO-HN', name: 'Kho Hà Nội', isActive: true }]));
  const updates = [];
  mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    updates.push({ filter, update });
    const versionOk = filter.version === undefined
      || (typeof filter.version === 'object' ? filter.version.$in.includes(current.version ?? null) : filter.version === current.version);
    const hashOk = filter.passwordHash === undefined || filter.passwordHash === current.passwordHash;
    if (!versionOk || !hashOk || !current.isActive) return null;
    current = { ...current, ...update.$set };
    for (const key of Object.keys(update.$unset || {})) delete current[key];
    return current;
  });
  const audits = [];
  mock.method(AuditLog.prototype, 'save', async function save() { audits.push({ action: this.action, subjectId: String(this.subjectId) }); return this; });
  return { updates, audits, current: () => current };
}

async function api(t) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '5m' });
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  return async (path, method = 'GET', body, auth = true) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...(auth && { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
}

afterEach(() => mock.restoreAll());

test('GET /me returns account details with role name, warehouses and version, never the password hash', async (t) => {
  stub(account());
  const call = await api(t);
  const { status, body } = await call('/me');
  assert.equal(status, 200);
  assert.equal(body.data.email, 'a@example.com');
  assert.equal(body.data.roleName, 'Nhân viên bán hàng');
  assert.equal(body.data.version, 3);
  assert.deepEqual(body.data.warehouses, [{ id: warehouseId, code: 'KHO-HN', name: 'Kho Hà Nội', isActive: true }]);
  assert.equal(body.data.passwordHash, undefined);
});

test('PATCH /me updates only own contact fields, bumps version and audits', async (t) => {
  const state = stub(account());
  const call = await api(t);
  const { status } = await call('/me', 'PATCH', { fullName: '  Tran Thi B ', phone: '', version: 3 });
  assert.equal(status, 200);
  assert.equal(state.updates.length, 1);
  assert.equal(String(state.updates[0].filter._id), userId);
  assert.deepEqual(state.updates[0].update.$set, { fullName: 'Tran Thi B', version: 4 });
  assert.deepEqual(state.updates[0].update.$unset, { phone: 1 });
  assert.deepEqual(state.audits.map((a) => a.action), ['UPDATE_PROFILE']);
});

test('PATCH /me rejects admin-managed fields and stale versions', async (t) => {
  const state = stub(account());
  const call = await api(t);
  for (const field of [{ email: 'x@example.com' }, { roleCode: 'ADMIN' }, { warehouseIds: [] }, { isActive: true }]) {
    const { status } = await call('/me', 'PATCH', { ...field, version: 3 });
    assert.equal(status, 400, JSON.stringify(field));
  }
  const stale = await call('/me', 'PATCH', { fullName: 'Tran Thi B', version: 2 });
  assert.equal(stale.status, 409);
  assert.equal(state.updates.length, 0);
  assert.equal((await call('/me', 'PATCH', { fullName: 'X Y', version: 3 }, false)).status, 401);
});

test('PATCH /me accepts version 1 for legacy records without a version field', async (t) => {
  const state = stub(account({ version: undefined }));
  const call = await api(t);
  const { status, body } = await call('/me', 'PATCH', { fullName: 'Le Van C', version: 1 });
  assert.equal(status, 200);
  assert.equal(body.data.version, 2);
  assert.deepEqual(state.updates[0].filter.version, { $in: [1, null] });
});

test('POST /me/password requires the current password and a strong, different new password', async (t) => {
  const state = stub(account());
  const call = await api(t);
  assert.equal((await call('/me/password', 'POST', { currentPassword: 'wrong', newPassword: 'NewPass123' })).status, 400);
  assert.equal((await call('/me/password', 'POST', { currentPassword: PASSWORD, newPassword: 'short1A' })).status, 400);
  assert.equal((await call('/me/password', 'POST', { currentPassword: PASSWORD, newPassword: 'alllowercase1' })).status, 400);
  assert.equal((await call('/me/password', 'POST', { currentPassword: PASSWORD, newPassword: PASSWORD })).status, 400);
  assert.equal((await call('/me/password', 'POST', { currentPassword: PASSWORD, newPassword: 'NewPass123', userId: 'x' })).status, 400);
  assert.equal(state.updates.length, 0);

  const ok = await call('/me/password', 'POST', { currentPassword: PASSWORD, newPassword: 'NewPass123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data, undefined);
  assert.equal(state.updates[0].filter.passwordHash, passwordHash);
  assert.ok(await bcrypt.compare('NewPass123', state.current().passwordHash));
  assert.deepEqual(state.audits.map((a) => a.action), ['CHANGE_PASSWORD']);
});
