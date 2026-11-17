import test from 'node:test';
import assert from 'node:assert/strict';
import { createBody, updateBody, postBody, listQuery, pickingBody } from '../src/modules/goods-issues/goods-issue.validation.js';
const id = '507f1f77bcf86cd799439011';
const operation = { idempotencyKey: 'gi-test', expectedVersion: 1 };
test('Goods Issue CRU rejects duplicate sources, arbitrary statuses and client-owned stock fields', () => {
  const create = { ...operation, deliveryOrderId: id, lines: [{ reservationId: id, qtyBase: '8' }] };
  assert.ok(createBody.safeParse(create).success);
  for (const body of [{ ...create, lines: [...create.lines, ...create.lines] }, { ...create, workflowStatus: 'POSTED' }, { ...create, stockTransactionId: id }, { ...create, lines: [{ reservationId: id, qtyBase: 8 }] }]) assert.equal(createBody.safeParse(body).success, false);
  assert.equal(updateBody.safeParse({ ...operation, lines: [{ lineId: id, qtyBase: '0' }] }).success, false);
  assert.equal(updateBody.safeParse({ ...operation, workflowStatus: 'POSTED', lines: [{ lineId: id, qtyBase: '8' }] }).success, false);
  assert.ok(postBody.safeParse({ ...operation, recipientName: 'Transporter' }).success);
  assert.equal(postBody.safeParse({ ...operation, recipientName: ' ' }).success, false);
  assert.equal(pickingBody.safeParse({ ...operation, destinations: [{ lineId: id, locationId: id }, { lineId: id, locationId: id }] }).success, false);
});
test('Goods Issue filters bound pages, source search and issue dates', () => {
  assert.equal(listQuery.parse({ sourceRequest: 'YCX', page: '2' }).page, 2);
  for (const body of [{ status: { $ne: 'POSTED' } }, { sourceRequest: { $regex: '.' } }, { limit: 101 }, { from: '2026-11-17T00:00:00+07:00', to: '2026-11-16T00:00:00+07:00' }, { sort: '$where' }]) assert.equal(listQuery.safeParse(body).success, false);
});
test('manual references require no local order, validate product quantities and never accept approval or stock fields', () => {
  const create = { ...operation, warehouseId: id, issueKind: 'SALE', referenceNo: 'MISA-NOT-IN-WMS', lines: [{ productId: id, qtyBase: '4', note: 'Manual cross-check' }] };
  assert.ok(createBody.safeParse(create).success);
  assert.ok(createBody.safeParse({ ...create, issueKind: 'OTHER', reasonText: 'Sample withdrawal' }).success);
  assert.ok(createBody.safeParse({ ...create, lines: [{ productId: id, quantity: '1.5', conversionId: id }] }).success);
  assert.equal(createBody.safeParse({ ...create, lines: [{ productId: id, qtyBase: '4', conversionId: id }] }).success, false);
  for (const change of [{ referenceNo: ' ' }, { issueKind: 'TRANSFER' }, { workflowStatus: 'DRAFT' }, { approvedBy: id }, { lines: [...create.lines, ...create.lines] }, { expectedVersion: 2 }]) assert.equal(createBody.safeParse({ ...create, ...change }).success, false);
  assert.equal(createBody.safeParse({ ...create, issueKind: 'OTHER' }).success, false);
  assert.ok(pickingBody.safeParse({ ...operation, allocations: [{ lineId: id, sourceBalanceId: id, locationId: id, qtyBase: '4' }] }).success);
});
