import test from 'node:test';
import assert from 'node:assert/strict';
import { listQuery, detailParams } from '../src/modules/transfers/transfer-read.validation.js';
import { requirementBody,taskConfirmBody,commandBody } from '../src/modules/transfers/transfer-write.validation.js';

test('putaway destinations allow empty input for service-level all-damaged validation', () => {
  assert.equal(requirementBody.safeParse({idempotencyKey:'damaged-only',expectedVersion:1,destinations:[]}).success,true);
});

test('only task confirmation accepts complete bounded destination selections',()=>{
  const input={idempotencyKey:'putaway',expectedVersion:1};
  const target={receiptLineId:'a'.repeat(24),locationId:'b'.repeat(24)};
  assert.equal(requirementBody.safeParse(input).success,true);
  assert.equal(taskConfirmBody.safeParse({...input,destinations:[target]}).success,true);
  for(const destinations of [[],[target,target],[{...target,receiptLineId:'bad'}],[{...target,qtyBase:'4'}]])assert.equal(taskConfirmBody.safeParse({...input,destinations}).success,false);
  assert.equal(commandBody.safeParse({...input,destinations:[target]}).success,false);
});

test('transfer filters are bounded and reject operators, unknown fields and invalid dates', () => {
  assert.deepEqual(listQuery.parse({}), { page: 1, limit: 20, sortBy:'createdAt',sortOrder:'desc' });
  assert.equal(listQuery.parse({ page: '2', limit: '10' }).page, 2);
  for (const input of [{ page: '0' }, { limit: '101' }, { status: { $ne: 'DRAFT' } }, { sort: '$where' },
    { sourceWarehouseId: 'bad-id' }, { from: 'yesterday' },
    { from: '2026-10-29T12:00:00Z', to: '2026-10-28T12:00:00Z' }]) {
    assert.equal(listQuery.safeParse(input).success, false);
  }
  assert.equal(detailParams.safeParse({ id: 'invalid' }).success, false);
});
