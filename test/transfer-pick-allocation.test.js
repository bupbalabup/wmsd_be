import test from 'node:test';
import assert from 'node:assert/strict';
import { exact } from '../src/models/model-utils.js';
import { planPickAllocations } from '../src/modules/transfers/transfer-pick-allocation.js';
import { taskConfirmBody } from '../src/modules/transfers/transfer.validation.js';

const id = (n) => String(n).padStart(24, '0');
const group = (rows) => new Map([[id(1), { planned: exact(String(rows.reduce((sum, row) => sum + Number(row.qty), 0))), rows }]]);
const plan = (rows, allocations) => {
  const map = group(rows);
  return planPickAllocations(map, allocations.map((a) => ({ requestLineId: id(1), ...a })));
};

test('moves quantity between bins without a short pick', () => {
  const { changes, short } = plan([{ balanceId: id(11), qty: '5' }, { balanceId: id(12), qty: '5' }],
    [{ sourceBalanceId: id(11), qtyBase: '4' }, { sourceBalanceId: id(12), qtyBase: '6' }]);
  assert.equal(short, false);
  assert.deepEqual(changes.map((c) => [c.balanceId, c.current.toFixed(), c.next.toFixed()]), [[id(11), '5', '4'], [id(12), '5', '6']]);
});

test('an unlisted bin drops to zero and a new bin is added', () => {
  const { changes } = plan([{ balanceId: id(11), qty: '10' }], [{ sourceBalanceId: id(13), qtyBase: '10' }]);
  assert.deepEqual(changes.map((c) => [c.balanceId, c.current.toFixed(), c.next.toFixed()]), [[id(11), '10', '0'], [id(13), '0', '10']]);
});

test('a lower total is a short pick and a higher total is rejected', () => {
  assert.equal(plan([{ balanceId: id(11), qty: '10' }], [{ sourceBalanceId: id(11), qtyBase: '7' }]).short, true);
  assert.throws(() => plan([{ balanceId: id(11), qty: '10' }], [{ sourceBalanceId: id(11), qtyBase: '6' }, { sourceBalanceId: id(12), qtyBase: '5' }]), /vượt/);
});

test('rejects a duplicate bin and an unknown request line', () => {
  assert.throws(() => plan([{ balanceId: id(11), qty: '10' }], [{ sourceBalanceId: id(11), qtyBase: '5' }, { sourceBalanceId: id(11), qtyBase: '5' }]), /một lần/);
  assert.throws(() => planPickAllocations(group([{ balanceId: id(11), qty: '10' }]), [{ requestLineId: id(9), sourceBalanceId: id(11), qtyBase: '1' }]), /không thuộc TO/);
});

test('confirm body accepts allocations and rejects malformed ones', () => {
  const base = { idempotencyKey: 'k1', expectedVersion: 1, recipientName: 'A' };
  assert.ok(taskConfirmBody.safeParse({ ...base, allocations: [{ requestLineId: id(1), sourceBalanceId: id(2), qtyBase: '4.5' }] }).success);
  assert.equal(taskConfirmBody.safeParse({ ...base, allocations: [{ requestLineId: id(1), sourceBalanceId: id(2), qtyBase: '-1' }] }).success, false);
  assert.equal(taskConfirmBody.safeParse({ ...base, allocations: [{ requestLineId: id(1), sourceBalanceId: id(2), qtyBase: '1', extra: 1 }] }).success, false);
});

test('pick requirement body accepts a typed picker name', async () => {
  const { requirementBody } = await import('../src/modules/transfers/transfer.validation.js');
  const base = { idempotencyKey: 'k1', expectedVersion: 1 };
  assert.equal(requirementBody.parse({ ...base, pickerName: '  Nguyễn Văn An ' }).pickerName, 'Nguyễn Văn An');
  assert.equal(requirementBody.safeParse({ ...base, pickerName: ' ' }).success, false);
  assert.equal(requirementBody.safeParse({ ...base, pickerName: 'x'.repeat(161) }).success, false);
});
