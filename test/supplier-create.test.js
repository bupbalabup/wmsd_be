import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { Supplier, AuditLog } from '../src/models/runtime.js';
import { createSupplier } from '../src/modules/suppliers/supplier.service.js';
import { create } from '../src/modules/suppliers/supplier.controller.js';
import { createSupplierSchema } from '../src/modules/suppliers/supplier.validation.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';

const user = {
  _id: new mongoose.Types.ObjectId(), isActive: true,
  roleId: { code: 'ACCOUNTANT', permissionIds: [{ code: 'supplier:create' }] },
};
const input = { code: 'SUP-DUPLICATE', name: 'Supplier' };
const duplicate = (metadata) => Object.assign(new Error('E11000 duplicate key error'), { code: 11000, ...metadata });

afterEach(() => mock.restoreAll());

function stubSession() {
  const session = { withTransaction: async work => work(), endSession: mock.fn(async () => {}) };
  mock.method(mongoose, 'startSession', async () => session);
  return session;
}

test('supplier code collisions return HTTP 409 with a field error and no Mongo message', async (t) => {
  const session = stubSession();
  mock.method(Supplier.prototype, 'save', async () => { throw duplicate({ keyPattern: { code: 1 }, keyValue: { code: input.code } }); });
  const audit = mock.method(AuditLog.prototype, 'save', async () => {});
  const app = express();
  app.use(express.json());
  app.post('/api/suppliers', (req, _res, next) => {
    req.user = user;
    req.validated = createSupplierSchema.parse({ params: {}, query: {}, body: req.body });
    next();
  }, create);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/suppliers`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.success, false);
  assert.equal(body.code, 'ERR-CORE-409-002');
  assert.equal(body.message, 'Mã nhà cung cấp đã tồn tại');
  assert.deepEqual(body.fieldErrors, [{ path: 'body.code', message: body.message }]);
  assert.doesNotMatch(JSON.stringify(body), /E11000|duplicate key/);
  assert.equal(audit.mock.callCount(), 0);
  assert.equal(session.endSession.mock.callCount(), 1);
});

test('supplier collisions can identify code from keyValue without keyPattern', async () => {
  stubSession();
  mock.method(Supplier.prototype, 'save', async () => { throw duplicate({ keyValue: { code: input.code } }); });
  await assert.rejects(createSupplier(user, input), error => error.statusCode === 409 && error.code === 'ERR-CORE-409-002');
});

test('supplier creation preserves unrelated database errors', async () => {
  stubSession();
  const save = mock.method(Supplier.prototype, 'save');
  for (const failure of [new Error('Database unavailable'), duplicate({ keyPattern: { _id: 1 } })]) {
    save.mock.mockImplementation(async () => { throw failure; });
    await assert.rejects(createSupplier(user, input), error => error === failure);
  }
});

test('supplier creation still saves an active supplier and its audit in the same session', async () => {
  const session = stubSession();
  const save = mock.method(Supplier.prototype, 'save', async function () { return this; });
  const audit = mock.method(AuditLog.prototype, 'save', async function () { return this; });
  const result = await createSupplier(user, input);
  assert.equal(result.code, input.code);
  assert.equal(result.status, 'ACTIVE');
  assert.deepEqual(save.mock.calls[0].arguments, [{ session }]);
  assert.deepEqual(audit.mock.calls[0].arguments, [{ session }]);
  assert.equal(audit.mock.calls[0].this.action, 'CREATE_SUPPLIER');
  assert.equal(session.endSession.mock.callCount(), 1);
});
