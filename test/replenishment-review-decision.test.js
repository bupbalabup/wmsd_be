import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReplenishmentSchema } from '../src/modules/replenishments/replenishment.validation.js';

// 22/11/2026: Owner review of RR only approves or rejects; REVISE was removed.
const decisionIssue = (decision) => reviewReplenishmentSchema
  .safeParse({ params: {}, query: {}, body: { decision } })
  .error?.issues.some((issue) => issue.path.join('.') === 'body.decision');

test('RR review accepts APPROVE/REJECT and refuses REVISE', () => {
  assert.equal(decisionIssue('APPROVE'), false);
  assert.equal(decisionIssue('REJECT'), false);
  assert.equal(decisionIssue('REVISE'), true);
});
