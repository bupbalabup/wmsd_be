import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import * as models from '../src/models/runtime.js';
import authRouter from '../src/modules/auth/auth.routes.js';
import { ApiError } from '../src/shared/utils/ApiError.js';
import { passwordMail } from '../src/shared/utils/mailer.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { resetOtpState } from '../src/shared/utils/otpChallenge.js';

// Mocked-model tests for "Quên mật khẩu" with the OTP option. No database or SMTP is used:
// MAIL_TRANSPORT=console makes sendMail log the message, which the test captures to read the code.
process.env.MAIL_TRANSPORT = 'console';
const { User, AuditLog } = models;
const userId = 'c'.repeat(24);
const OLD_PASSWORD = 'OldPass123';

let db;
let mails;
let audits;
function setup({ active = true, duplicates = false, email = 'a@example.test', username = 'sales01' } = {}) {
  db = { _id: userId, username, fullName: 'Nguyen Van A', email, roleId: { code: 'SALES', isActive: true, permissionIds: [] }, passwordHash: bcrypt.hashSync(OLD_PASSWORD, 4), isActive: active };
  const doc = () => ({ ...db });
  const listQuery = (value) => ({ select: () => listQuery(value), populate: () => listQuery(value), limit: async () => value });
  mock.method(User, 'find', (filter) => listQuery((filter.email?.test(db.email) || filter.username?.test(db.username)) ? (duplicates ? [doc(), doc()] : [doc()]) : []));
  mock.method(User, 'findOne', (filter) => ({ select: () => ({ populate: async () => filter.username === db.username ? doc() : null }) }));
  mock.method(User, 'updateOne', async (filter, update) => {
    if (String(filter._id) !== userId || (filter.passwordHash && filter.passwordHash !== db.passwordHash)
      || (filter.email && filter.email !== db.email) || (filter.isActive && !db.isActive)) return { modifiedCount: 0 };
    Object.assign(db, update.$set);
    return { modifiedCount: 1 };
  });
  const one = (value) => ({ select: () => one(value), then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
  mock.method(User, 'findById', (id) => one(String(id) === userId ? doc() : null));
  mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    if (String(filter._id) !== userId || filter.passwordHash !== db.passwordHash || !db.isActive) return null;
    Object.assign(db, update.$set);
    return doc();
  });
  audits = [];
  mock.method(AuditLog.prototype, 'save', async function save() { audits.push(this.action); return this; });
  mails = [];
  mock.method(console, 'info', (line) => {
    const match = /^\[mail:console\] to=(\S+) subject=([^\n]*)\n([\s\S]*)$/.exec(String(line));
    if (match) mails.push({ to: match[1], subject: match[2], text: match[3], code: /Mã xác thực: (\d{6})/.exec(match[3])?.[1] });
  });
}

async function server(t) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => srv.once('listening', resolve));
  t.after(() => new Promise((resolve) => { srv.close(resolve); srv.closeAllConnections(); }));
  const base = `http://127.0.0.1:${srv.address().port}/api/auth`;
  return (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}

function setMailEnvironment(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

const otherCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeEach(() => resetOtpState());
afterEach(() => mock.restoreAll());

test('known and unknown emails get the same answer; only a real active account receives a code', async (t) => {
  setup();
  const call = await server(t);
  const known = await call('/forgot-password/otp', { email: 'A@Example.test' });
  const unknown = await call('/forgot-password/otp', { email: 'nobody@example.test' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.body.message, unknown.body.message);
  assert.deepEqual(Object.keys(known.body.data).sort(), Object.keys(unknown.body.data).sort());
  assert.equal(typeof unknown.body.data.challengeToken, 'string');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'a@example.test');
  // A guessed code for the unknown address can never work.
  const guess = await call('/forgot-password/reset', { challengeToken: unknown.body.data.challengeToken, otp: '123456', newPassword: 'NewPass123' });
  assert.equal(guess.status, 400);
});

test('locked or ambiguous accounts receive no code', async (t) => {
  setup({ active: false });
  let call = await server(t);
  assert.equal((await call('/forgot-password/otp', { email: 'a@example.test' })).status, 200);
  mock.restoreAll();
  resetOtpState();
  setup({ duplicates: true });
  call = await server(t);
  assert.equal((await call('/forgot-password/otp', { email: 'a@example.test' })).status, 200);
  assert.equal(mails.length, 0);
});

test('a wrong code is counted; the right code sets the chosen password once and notifies the account', async (t) => {
  setup();
  const call = await server(t);
  const { challengeToken } = (await call('/forgot-password/otp', { email: 'a@example.test' })).body.data;
  const code = mails[0].code;

  const wrong = await call('/forgot-password/reset', { challengeToken, otp: otherCode(code), newPassword: 'NewPass123' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /Còn 4 lần thử/);

  const weak = await call('/forgot-password/reset', { challengeToken, otp: code, newPassword: 'weakpass' });
  assert.equal(weak.status, 400);
  assert.ok(await bcrypt.compare(OLD_PASSWORD, db.passwordHash));

  const ok = await call('/forgot-password/reset', { challengeToken, otp: code, newPassword: 'NewPass123' });
  assert.equal(ok.status, 200);
  assert.ok(await bcrypt.compare('NewPass123', db.passwordHash));
  assert.deepEqual(audits, ['RESET_PASSWORD']);
  assert.equal(mails.at(-1).to, 'a@example.test');
  assert.match(mails.at(-1).subject, /đã được đặt lại/);

  const replay = await call('/forgot-password/reset', { challengeToken, otp: code, newPassword: 'Another123' });
  assert.equal(replay.status, 400);
  assert.ok(await bcrypt.compare('NewPass123', db.passwordHash));
});

test('a code becomes void once the password changed another way, and resends wait 60 s for any address', async (t) => {
  setup();
  const call = await server(t);
  const { challengeToken } = (await call('/forgot-password/otp', { email: 'a@example.test' })).body.data;
  db.passwordHash = bcrypt.hashSync('ChangedElsewhere1', 4);
  const res = await call('/forgot-password/reset', { challengeToken, otp: mails[0].code, newPassword: 'NewPass123' });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /không còn hiệu lực/);
  assert.equal((await call('/forgot-password/otp', { email: 'a@example.test' })).status, 429);
  assert.equal((await call('/forgot-password/otp', { email: 'nobody@example.test' })).status, 200);
  assert.equal((await call('/forgot-password/otp', { email: 'nobody@example.test' })).status, 429);
});

test('an email-change challenge is not accepted as a password-reset challenge', async (t) => {
  setup();
  const call = await server(t);
  const { createChallenge } = await import('../src/shared/utils/otpChallenge.js');
  const { challengeToken, code } = createChallenge('email-change', { tgt: userId, email: 'a@example.test' });
  const res = await call('/forgot-password/reset', { challengeToken, otp: code, newPassword: 'NewPass123' });
  assert.equal(res.status, 400);
  assert.ok(await bcrypt.compare(OLD_PASSWORD, db.passwordHash));
});

test('the emailed password signs in by username or email and invalidates the old password', async (t) => {
  setup({ email: 'random@example.test', username: 'SalesMixed' });
  setMailEnvironment(t, { NODE_ENV: 'production', APP_URL: 'http://localhost:5173/' });
  const call = await server(t);
  assert.equal((await call('/forgot-password', { email: 'random@example.test' })).status, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /https:\/\/wmsd\.tanthuong\.workers\.dev\/login/);
  assert.doesNotMatch(mails[0].text, /localhost/);
  const password = /Mật khẩu: (\S+)/.exec(mails[0].text)?.[1];
  assert.ok(password && await bcrypt.compare(password, db.passwordHash));
  for (const username of ['salesmixed', 'RANDOM@Example.test']) {
    const login = await call('/login', { username, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.username, 'SalesMixed');
  }
  assert.equal((await call('/login', { username: 'salesmixed', password: OLD_PASSWORD })).status, 401);
});

test('random-password mail failure restores only the password written by that request', async (t) => {
  setup({ email: 'mail-error@example.test' });
  const call = await server(t);
  let interveningChange = false;
  const otherHash = bcrypt.hashSync('NewerChange123', 4);
  mock.method(console, 'info', () => {
    if (interveningChange) db.passwordHash = otherHash;
    throw new ApiError(502, 'Mail transport failed');
  });
  assert.equal((await call('/forgot-password', { email: 'mail-error@example.test' })).status, 502);
  assert.ok(await bcrypt.compare(OLD_PASSWORD, db.passwordHash));
  interveningChange = true;
  assert.equal((await call('/forgot-password', { email: 'mail-error@example.test' })).status, 502);
  assert.equal(db.passwordHash, otherHash);
});

test('password email uses configured HTTPS link in production and allows localhost in development', (t) => {
  setMailEnvironment(t, { NODE_ENV: 'production', APP_URL: 'https://frontend.example.test/' });
  const args = { fullName: 'Test User', username: 'user', password: 'FixturePassword1', reason: 'created' };
  assert.match(passwordMail(args).text, /https:\/\/frontend\.example\.test\/login/);
  process.env.NODE_ENV = 'development';
  process.env.APP_URL = 'http://localhost:5173/';
  assert.match(passwordMail(args).text, /http:\/\/localhost:5173\/login/);
});

test('sign-in does not choose between duplicate legacy email addresses', async (t) => {
  setup({ duplicates: true });
  const call = await server(t);
  const result = await call('/login', { username: 'A@Example.test', password: OLD_PASSWORD });
  assert.equal(result.status, 401);
  assert.equal(result.body.data, undefined);
});
