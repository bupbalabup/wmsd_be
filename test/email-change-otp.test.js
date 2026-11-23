import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import * as models from '../src/models/runtime.js';
import authRouter from '../src/modules/auth/auth.routes.js';
import userRouter from '../src/modules/users/user.routes.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { resetEmailChangeState } from '../src/shared/utils/emailChange.js';

// Mocked-model tests for email change by OTP (self-service and administrator). No database or SMTP is used:
// MAIL_TRANSPORT=console makes sendMail log the message, which the test captures to read the code.
process.env.MAIL_TRANSPORT = 'console';
const { User, Warehouse, AuditLog } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026';
const adminId = 'a'.repeat(24);
const userId = 'c'.repeat(24);

const role = (code, permissions) => ({ code, isActive: true, permissionIds: permissions.map((p) => ({ code: p, isActive: true })) });
const query = (value) => ({
  select: () => query(value), populate: () => query(value), sort: () => query(value), lean: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

let db;
let mails;
let audits;
function setup({ adminPermissions = ['user:read', 'user:update'], takenEmails = [] } = {}) {
  db = {
    [adminId]: { _id: adminId, username: 'admin', fullName: 'Admin', email: 'admin@example.test', isActive: true, version: 1, warehouseIds: [], roleId: role('ADMIN', adminPermissions) },
    [userId]: { _id: userId, username: 'sales01', fullName: 'Nguyen Van A', email: 'old@example.test', isActive: true, version: 2, warehouseIds: [], roleId: role('SALES', ['sales_order:read']), createdAt: new Date(), updatedAt: new Date() },
  };
  mock.method(User, 'findById', (id) => query(db[String(id)] ? { ...db[String(id)] } : null));
  mock.method(User, 'exists', async (filter) => (takenEmails.some((e) => filter.email.test(e)) ? { _id: 'x' } : null));
  mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    const doc = db[String(filter._id)];
    const emailOk = typeof filter.email === 'object' ? !doc.email : doc.email === filter.email;
    if (!doc || !emailOk) return null;
    Object.assign(doc, update.$set);
    return doc;
  });
  mock.method(Warehouse, 'find', () => query([]));
  audits = [];
  mock.method(AuditLog.prototype, 'save', async function save() { audits.push({ action: this.action, actorId: String(this.actorId), changes: this.changes.map((c) => ({ field: c.field, before: c.before, after: c.after })) }); return this; });
  mails = [];
  mock.method(console, 'info', (line) => {
    const match = /^\[mail:console\] to=(\S+) subject=([^\n]*)\n([\s\S]*)$/.exec(String(line));
    if (match) mails.push({ to: match[1], subject: match[2], code: /Mã xác thực: (\d{6})/.exec(match[3])?.[1] });
  });
}

async function server(t) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use(errorHandler);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  t.after(() => new Promise((resolve) => { srv.close(resolve); srv.closeAllConnections(); }));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  return (as, path, body, rawToken) => fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${rawToken ?? jwt.sign({ userId: as }, JWT_SECRET, { expiresIn: '5m' })}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

beforeEach(() => resetEmailChangeState());
afterEach(() => mock.restoreAll());

test('self-service: OTP goes to the new address, a wrong code is counted, the right code changes the email once', async (t) => {
  setup();
  const call = await server(t);
  const issued = await call(userId, '/auth/me/email/otp', { newEmail: 'New@Example.test' });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.data.maskedEmail, 'ne*@example.test');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'new@example.test');
  assert.match(mails[0].code, /^\d{6}$/);
  const { challengeToken } = issued.body.data;
  const wrong = String((Number(mails[0].code) + 1) % 1_000_000).padStart(6, '0');

  const bad = await call(userId, '/auth/me/email', { challengeToken, otp: wrong });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Còn 4 lần thử/);
  assert.equal(db[userId].email, 'old@example.test');

  const ok = await call(userId, '/auth/me/email', { challengeToken, otp: mails[0].code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.email, 'new@example.test');
  assert.equal(db[userId].version, 3);
  assert.deepEqual(audits, [{ action: 'CHANGE_EMAIL', actorId: userId, changes: [{ field: 'email', before: 'old@example.test', after: 'new@example.test' }] }]);
  assert.equal(mails.at(-1).to, 'old@example.test', 'the previous address is notified');

  const replay = await call(userId, '/auth/me/email', { challengeToken, otp: mails[0].code });
  assert.equal(replay.status, 400);
  assert.equal(db[userId].email, 'new@example.test');
});

test('self-service: rejects the current email, an email of another account, a resend inside 60 s and a malformed code', async (t) => {
  setup({ takenEmails: ['taken@example.test'] });
  const call = await server(t);
  assert.equal((await call(userId, '/auth/me/email/otp', { newEmail: 'OLD@example.test' })).status, 400);
  assert.equal((await call(userId, '/auth/me/email/otp', { newEmail: 'taken@example.test' })).status, 400);
  assert.equal((await call(userId, '/auth/me/email/otp', { newEmail: 'not-an-email' })).status, 400);
  assert.equal(mails.length, 0);
  const first = await call(userId, '/auth/me/email/otp', { newEmail: 'new@example.test' });
  assert.equal(first.status, 200);
  const again = await call(userId, '/auth/me/email/otp', { newEmail: 'new@example.test' });
  assert.equal(again.status, 429);
  assert.equal(mails.length, 1);
  assert.equal((await call(userId, '/auth/me/email', { challengeToken: first.body.data.challengeToken, otp: '12ab56' })).status, 400);
});

test('five wrong codes lock the challenge even for the right code afterwards', async (t) => {
  setup();
  const call = await server(t);
  const { challengeToken } = (await call(userId, '/auth/me/email/otp', { newEmail: 'new@example.test' })).body.data;
  const wrong = String((Number(mails[0].code) + 7) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i += 1) assert.equal((await call(userId, '/auth/me/email', { challengeToken, otp: wrong })).status, 400);
  const locked = await call(userId, '/auth/me/email', { challengeToken, otp: mails[0].code });
  assert.equal(locked.status, 400);
  assert.match(locked.body.message, /quá số lần/);
  assert.equal(db[userId].email, 'old@example.test');
});

test('a challenge is void once the account email changed in between', async (t) => {
  setup();
  const call = await server(t);
  const { challengeToken } = (await call(userId, '/auth/me/email/otp', { newEmail: 'new@example.test' })).body.data;
  db[userId].email = 'other@example.test';
  const res = await call(userId, '/auth/me/email', { challengeToken, otp: mails[0].code });
  assert.equal(res.status, 409);
  assert.equal(db[userId].email, 'other@example.test');
});

test('admin: OTP to the new address of the managed account; only the issuing admin can confirm it', async (t) => {
  setup();
  const call = await server(t);
  const issued = await call(adminId, `/users/${userId}/email/otp`, { newEmail: 'new@example.test' });
  assert.equal(issued.status, 200);
  assert.equal(mails[0].to, 'new@example.test');
  const { challengeToken } = issued.body.data;

  // The account holder cannot reuse the administrator's challenge on the self-service endpoint.
  assert.equal((await call(userId, '/auth/me/email', { challengeToken, otp: mails[0].code })).status, 400);
  assert.equal(db[userId].email, 'old@example.test');

  const ok = await call(adminId, `/users/${userId}/email`, { challengeToken, otp: mails[0].code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.email, 'new@example.test');
  assert.equal(audits[0].action, 'CHANGE_EMAIL');
  assert.equal(audits[0].actorId, adminId);
});

test('admin email change needs user:update', async (t) => {
  setup({ adminPermissions: ['user:read'] });
  const call = await server(t);
  assert.equal((await call(adminId, `/users/${userId}/email/otp`, { newEmail: 'new@example.test' })).status, 403);
  assert.equal(mails.length, 0);
});

test('a challenge token is never accepted as an access token', async (t) => {
  setup();
  const call = await server(t);
  const { challengeToken } = (await call(userId, '/auth/me/email/otp', { newEmail: 'new@example.test' })).body.data;
  assert.equal((await call(null, '/auth/me', undefined, challengeToken)).status, 401);
});
