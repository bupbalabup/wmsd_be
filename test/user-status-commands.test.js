import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as models from '../src/models/runtime.js';
import userRouter from '../src/modules/users/user.routes.js';
import authRouter from '../src/modules/auth/auth.routes.js';
import { toggleUserStatus } from '../src/modules/users/user.service.js';
import { loginUser, refreshToken } from '../src/modules/auth/auth.service.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';

// Mocked-model tests only: no database connection is opened.
const { User, AuditLog } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026';
const actorId = 'a'.repeat(24);
const targetId = 'b'.repeat(24);
const PASSWORD = randomBytes(16).toString('hex');
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

const role = (code, permissions) => ({ code, isActive: true, permissionIds: permissions.map((permission) => ({ code: permission, isActive: true })) });
const actor = (permissions = ['user:read', 'user:update']) => ({ _id: actorId, isActive: true, warehouseIds: [], roleId: role('ADMIN', permissions) });
const target = (overrides = {}) => {
  const doc = {
    _id: targetId, username: 'staff', fullName: 'Nguyen Van A', passwordHash, isActive: true, lockReason: undefined,
    warehouseIds: [], roleId: role('SALES', ['user:read']), createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
  doc.save = mock.fn(async () => doc);
  return doc;
};

// A query that can be awaited directly or chained through select()/populate()/lean().
const query = (value) => ({
  select: () => query(value),
  populate: () => query(value),
  lean: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

function stubUsers(actorDoc, targetDoc) {
  return mock.method(User, 'findById', (id) => {
    if (String(id) === actorId) return query(actorDoc);
    if (String(id) === targetId) return query(targetDoc);
    return query(null);
  });
}

// Captures audit events and proves each one is valid against the AuditLog schema.
function captureAudit() {
  const events = [];
  mock.method(AuditLog.prototype, 'save', async function save() {
    const invalid = await this.validate().then(() => undefined, (error) => error);
    events.push({ action: this.action, actorId: String(this.actorId), actorType: this.actorType, subjectType: this.subjectType,
      subjectId: String(this.subjectId), reason: this.reason, result: this.result, invalid: invalid?.message });
    return this;
  });
  return events;
}

async function listen(t, mount) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  mount(app);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function usersApi(t) {
  const base = await listen(t, (app) => app.use('/api/users', userRouter));
  const token = jwt.sign({ userId: actorId }, JWT_SECRET, { expiresIn: '5m' });
  return (path, method, body) => fetch(`${base}/api/users${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
}

const targetLookups = () => User.findById.mock.calls.filter((call) => String(call.arguments[0]) === targetId).length;

afterEach(() => mock.restoreAll());

test('lock with a reason deactivates the account, stores the trimmed reason and records LOCK_USER', async () => {
  const doc = target();
  stubUsers(actor(), doc);
  const events = captureAudit();
  const result = await toggleUserStatus(targetId, false, actorId, '  Nghi viec  ');
  assert.equal(doc.isActive, false);
  assert.equal(doc.lockReason, 'Nghi viec');
  assert.equal(doc.save.mock.callCount(), 1);
  assert.equal(result.status, 'inactive');
  assert.equal(result.lockReason, 'Nghi viec');
  assert.deepEqual(events, [{
    action: 'LOCK_USER', actorId, actorType: 'USER', subjectType: 'users', subjectId: targetId, reason: 'Nghi viec', result: 'SUCCESS', invalid: undefined,
  }]);
});

test('lock without a usable reason is rejected and the account stays active', async () => {
  for (const reason of [undefined, '', '   ', '\n\t']) {
    const doc = target();
    stubUsers(actor(), doc);
    const events = captureAudit();
    await assert.rejects(toggleUserStatus(targetId, false, actorId, reason), (error) => error.statusCode === 400);
    assert.equal(doc.isActive, true);
    assert.equal(doc.lockReason, undefined);
    assert.equal(doc.save.mock.callCount(), 0);
    assert.equal(events.length, 0);
    mock.restoreAll();
  }
});

test('PATCH /users/:id/status without a reason is a validation error and the account is not read or saved', async (t) => {
  const doc = target();
  stubUsers(actor(), doc);
  const events = captureAudit();
  const call = await usersApi(t);
  for (const body of [{ isActive: false }, { isActive: false, reason: '' }, { isActive: false, reason: '   ' }]) {
    const response = await call(`/${targetId}/status`, 'PATCH', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
  assert.equal(targetLookups(), 0);
  assert.equal(doc.save.mock.callCount(), 0);
  assert.equal(doc.isActive, true);
  assert.equal(events.length, 0);
});

test('PATCH /users/:id/status with a reason locks the account and returns the reason', async (t) => {
  const doc = target();
  stubUsers(actor(), doc);
  const events = captureAudit();
  const call = await usersApi(t);
  const response = await call(`/${targetId}/status`, 'PATCH', { isActive: false, reason: 'Nghi viec' });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.status, 'inactive');
  assert.equal(data.lockReason, 'Nghi viec');
  assert.equal(doc.isActive, false);
  assert.deepEqual(events.map((event) => event.action), ['LOCK_USER']);
});

test('unlock activates the account, clears the lock reason and records UNLOCK_USER', async () => {
  const doc = target({ isActive: false, lockReason: 'Nghi viec' });
  stubUsers(actor(), doc);
  const events = captureAudit();
  const result = await toggleUserStatus(targetId, true, actorId);
  assert.equal(doc.isActive, true);
  assert.equal(doc.lockReason, undefined);
  assert.equal(doc.save.mock.callCount(), 1);
  assert.equal(result.status, 'active');
  assert.equal(result.lockReason, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'UNLOCK_USER');
  assert.equal(events[0].actorId, actorId);
  assert.equal(events[0].subjectId, targetId);
  assert.equal(events[0].invalid, undefined);
});

test('PATCH /users/:id/status unlock needs no reason and clears the stored one', async (t) => {
  const doc = target({ isActive: false, lockReason: 'Nghi viec' });
  stubUsers(actor(), doc);
  captureAudit();
  const call = await usersApi(t);
  const response = await call(`/${targetId}/status`, 'PATCH', { isActive: true });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.status, 'active');
  assert.equal(data.lockReason, undefined);
  assert.equal(doc.lockReason, undefined);
});

test('an administrator cannot deactivate their own account', async () => {
  const doc = target();
  stubUsers(actor(), doc);
  const events = captureAudit();
  await assert.rejects(toggleUserStatus(actorId, false, actorId, 'Nghi viec'), (error) => error.statusCode === 400);
  assert.equal(doc.save.mock.callCount(), 0);
  assert.equal(events.length, 0);
  assert.equal(User.findById.mock.callCount(), 0);
});

test('PATCH own id with isActive false is refused over HTTP and the account stays active', async (t) => {
  const self = actor();
  self.save = mock.fn(async () => self);
  stubUsers(self, target());
  const events = captureAudit();
  const call = await usersApi(t);
  const response = await call(`/${actorId}/status`, 'PATCH', { isActive: false, reason: 'Nghi viec' });
  assert.equal(response.status, 400);
  assert.equal(self.save.mock.callCount(), 0);
  assert.equal(self.isActive, true);
  assert.equal(events.length, 0);
});

test('PATCH status without user:update is forbidden and nothing is read, saved or audited', async (t) => {
  const doc = target();
  stubUsers(actor(['user:read']), doc);
  const events = captureAudit();
  const call = await usersApi(t);
  const response = await call(`/${targetId}/status`, 'PATCH', { isActive: false, reason: 'Nghi viec' });
  assert.equal(response.status, 403);
  assert.equal(targetLookups(), 0);
  assert.equal(doc.save.mock.callCount(), 0);
  assert.equal(events.length, 0);
});

test('status change on an unknown account is 404 and writes no audit event', async () => {
  stubUsers(actor(), target());
  const events = captureAudit();
  await assert.rejects(toggleUserStatus('f'.repeat(24), false, actorId, 'x'), (error) => error.statusCode === 404);
  assert.equal(events.length, 0);
});

// Observed: the audit event is only written when isActive changes (user.service.js line 150), so replacing
// the reason of an already locked account is saved without an audit event. Not a delta scenario; recorded as a finding.
test('re-locking an already locked account with a new reason is audited', { todo: 'observed: no audit event when isActive does not change' }, async () => {
  const doc = target({ isActive: false, lockReason: 'Old reason' });
  stubUsers(actor(), doc);
  const events = captureAudit();
  await toggleUserStatus(targetId, false, actorId, 'New reason');
  assert.equal(doc.lockReason, 'New reason');
  assert.equal(events.length, 1);
});

test('sign-in with correct credentials is refused for an inactive account and issues no session', async () => {
  const doc = target({ isActive: false, lockReason: 'Nghi viec' });
  mock.method(User, 'findOne', () => query(doc));
  await assert.rejects(loginUser('Staff', PASSWORD), (error) => error.statusCode === 401 && /không chính xác/.test(error.message));
});

test('the same credentials sign in when the account is active (control for the refusal above)', async () => {
  mock.method(User, 'findOne', () => query(target()));
  const session = await loginUser('Staff', PASSWORD);
  assert.equal(typeof session.accessToken, 'string');
  assert.equal(typeof session.refreshToken, 'string');
  assert.equal(session.user.username, 'staff');
});

test('POST /auth/login for an inactive account returns 401 with no token, cookie or user', async (t) => {
  mock.method(User, 'findOne', () => query(target({ isActive: false, lockReason: 'Nghi viec' })));
  const base = await listen(t, (app) => app.use('/api/auth', authRouter));
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'staff', password: PASSWORD }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.data, undefined);
  assert.equal(JSON.stringify(body).includes('accessToken'), false);
  assert.equal(response.headers.getSetCookie().length, 0);
});

test('an existing access token of a locked account is rejected and refresh issues no new session', async (t) => {
  const locked = target({ isActive: false, lockReason: 'Nghi viec' });
  mock.method(User, 'findById', () => query(locked));
  const base = await listen(t, (app) => app.use('/api/auth', authRouter));
  const token = jwt.sign({ userId: targetId }, JWT_SECRET, { expiresIn: '5m' });
  const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 401);
  await me.text();
  await assert.rejects(refreshToken(targetId), (error) => error.statusCode === 401);
});
