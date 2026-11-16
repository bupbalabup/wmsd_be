import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import * as models from '../src/models/runtime.js';
import { resolutionListQuery, buildResolutionScope, buildResolutionPlanFilter } from '../src/modules/stocktake-closure/stocktake-resolution.query.js';
import { listResolutionPlans } from '../src/modules/stocktake-closure/stocktake-resolution.service.js';

const A = 'a'.repeat(24), B = 'b'.repeat(24), LOC = 'c'.repeat(24), LOT = 'd'.repeat(24), SNAP = 'e'.repeat(24), BAL = 'f'.repeat(24), COUNT = '1'.repeat(24), USER = '2'.repeat(24), PLAN = '3'.repeat(24);
const ST = 'KK - T - 261115 - 000001';
const user = (code = 'WAREHOUSE', warehouseIds = [A], permissions = ['stock_adjustment:read']) => ({
  isActive: true, warehouseIds, roleId: { code, isActive: true, permissionIds: permissions.map(code => ({ code })) },
});
const parse = q => resolutionListQuery.safeParse(q);
const query = (overrides = {}) => resolutionListQuery.parse(overrides);
const rows = value => ({ select: () => ({ lean: async () => value }) });
const id = value => new mongoose.Types.ObjectId(value);

function setup({ items = [], total = items.length, snapshots = [{ _id: SNAP, sourceBalanceId: BAL }], counts = [{ _id: COUNT }], stocktakeIds = [ST] } = {}) {
  const calls = {};
  mock.method(models.Stocktake, 'aggregate', async pipeline => { calls.pipeline = pipeline; return [{ items, total: total ? [{ value: total }] : [] }]; });
  mock.method(models.Stocktake, 'distinct', async (field, filter) => { calls.distinct = { field, filter }; return stocktakeIds; });
  mock.method(models.StocktakeSnapshot, 'find', filter => { calls.snapshotFilter = filter; return rows(snapshots); });
  mock.method(models.StocktakeCount, 'find', filter => { calls.countFilter = filter; return rows(counts); });
  mock.method(models.Warehouse, 'find', filter => { calls.warehouseFilter = filter; return rows([{ _id: A, code: 'WH-T', name: 'Test warehouse' }]); });
  mock.method(models.User, 'find', filter => { calls.userFilter = filter; return rows([{ _id: USER, username: 'staff', fullName: 'Staff One' }]); });
  // Reads must never write: any of these fails the test.
  for (const model of [models.Stocktake, models.StocktakeSnapshot, models.StocktakeCount, models.ApprovalHistory, models.StockAdjustment])
    for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'bulkWrite'])
      mock.method(model, method, () => assert.fail(`${model.modelName}.${method} must not be called by a read`));
  return calls;
}
afterEach(() => mock.restoreAll());

test('resolution list scope: owner is unrestricted, staff limited to assigned warehouses', () => {
  assert.deepEqual(buildResolutionScope(user('OWNER'), query()), { 'resolutionPlans.0': { $exists: true } });
  const scope = buildResolutionScope(user('WAREHOUSE', [A]), query());
  assert.deepEqual(scope['header.warehouseId'], { $in: [id(A)] });
});

test('resolution list refuses a warehouse filter outside staff access and accepts owner or assigned', () => {
  assert.throws(() => buildResolutionScope(user('WAREHOUSE', [A]), query({ warehouseId: B })), error => error.statusCode === 403);
  assert.deepEqual(buildResolutionScope(user('WAREHOUSE', [A]), query({ warehouseId: A }))['header.warehouseId'], id(A));
  assert.deepEqual(buildResolutionScope(user('OWNER'), query({ warehouseId: B }))['header.warehouseId'], id(B));
});

test('resolution list combines status, stocktake, location, lot and literal text', () => {
  const q = query({ status: 'PENDING_APPROVAL', stocktakeId: ST, locationId: LOC, lotId: LOT, q: 'PA[1].*' });
  const scope = buildResolutionScope(user('OWNER'), q);
  assert.equal(scope._id, ST);
  assert.deepEqual(scope['header.scopeLocationIds'], id(LOC));
  assert.equal(scope['resolutionPlans.workflowStatus'], 'PENDING_APPROVAL');
  const filter = buildResolutionPlanFilter(q, { countIds: [COUNT], balanceIds: [BAL] });
  assert.equal(filter['resolutionPlans.workflowStatus'], 'PENDING_APPROVAL');
  assert.equal(filter.$or[0]['resolutionPlans.documentNo'].$regex, 'PA\\[1\\]\\.\\*');
  assert.equal(filter.$or[1].documentNo.$options, 'i');
  // Lot and location must hold on the same plan line.
  const line = filter['resolutionPlans.items'].$elemMatch;
  assert.deepEqual(line.lotId, id(LOT));
  assert.deepEqual(line.$or, [
    { 'details.countId': { $in: [id(COUNT)] } },
    { 'details.fromBalanceId': { $in: [id(BAL)] } },
    { 'details.toBalanceId': { $in: [id(BAL)] } },
  ]);
  assert.equal('resolutionPlans.items' in buildResolutionPlanFilter(query(), null), false);
});

test('resolution list query validation rejects bad input and unknown keys', () => {
  assert.equal(parse({}).success, true);
  assert.deepEqual(parse({ page: '2', limit: '50', lotId: LOT.toUpperCase(), stocktakeId: ST }).data, { page: 2, limit: 50, lotId: LOT, stocktakeId: ST });
  for (const bad of [
    { warehouseId: 'nope' }, { lotId: 'nope' }, { locationId: 'nope' }, { stocktakeId: 'nope' }, { status: 'pending' }, { status: 'UNKNOWN' },
    { q: '   ' }, { limit: '101' }, { page: '0' }, { sortBy: 'x' }, { $where: '1' }, { from: '2026-11-01T00:00:00Z' },
  ]) assert.equal(parse(bad).success, false, JSON.stringify(bad));
});

test('listing requires stock_adjustment:read before touching any model', async () => {
  const calls = setup();
  await assert.rejects(listResolutionPlans(user('WAREHOUSE', [A], ['stocktake:read']), query()), error => error.statusCode === 403);
  assert.equal(models.Stocktake.aggregate.mock.callCount(), 0);
  assert.equal(calls.pipeline, undefined);
});

test('listing refuses a foreign warehouse before any read', async () => {
  setup();
  await assert.rejects(listResolutionPlans(user('WAREHOUSE', [A]), query({ warehouseId: B })), error => error.statusCode === 403);
  assert.equal(models.Stocktake.aggregate.mock.callCount(), 0);
});

test('listing scopes staff to assigned warehouses and returns serialized rows with labels and paging', async () => {
  const calls = setup({ total: 41, items: [{
    id: id(PLAN), documentNo: 'PAXLKK - T - 261115 - 000001', planVersion: 2, workflowStatus: 'PENDING_APPROVAL', reason: 'Recount mismatch',
    proposedBy: id(USER), proposedAt: new Date('2026-11-15T01:00:00Z'), scopeVersion: 1, lineCount: 3, stocktakeId: ST, stocktakeNo: ST, stocktakeStatus: 'PENDING_APPROVAL', warehouseId: id(A),
  }] });
  const result = await listResolutionPlans(user(), query({ page: '3', limit: '20' }));
  const [match, unwind, planMatch, sort, facet] = calls.pipeline;
  assert.deepEqual(match.$match['header.warehouseId'], { $in: [id(A)] });
  assert.deepEqual(unwind, { $unwind: '$resolutionPlans' });
  assert.deepEqual(planMatch, { $match: {} });
  assert.ok(sort.$sort);
  assert.deepEqual(facet.$facet.items.slice(0, 2), [{ $skip: 40 }, { $limit: 20 }]);
  assert.equal(result.total, 41);
  assert.equal(result.page, 3);
  assert.equal(result.items[0].id, PLAN);
  assert.equal(result.items[0].proposedAt, '2026-11-15T01:00:00.000Z');
  assert.equal(result.items[0].warehouseId, A);
  assert.deepEqual(result.lookups, { warehouses: [{ id: A, code: 'WH-T', name: 'Test warehouse' }], users: [{ id: USER, username: 'staff', fullName: 'Staff One' }] });
  assert.deepEqual(calls.userFilter, { _id: { $in: [USER] } });
});

test('owner listing is unrestricted and an empty result is a normal page', async () => {
  const calls = setup({ items: [], total: 0 });
  const result = await listResolutionPlans(user('OWNER', []), query());
  assert.equal('header.warehouseId' in calls.pipeline[0].$match, false);
  assert.deepEqual(result, { items: [], total: 0, page: 1, limit: 20, lookups: { warehouses: [], users: [] } });
});

test('location filter resolves through snapshots and counts inside the actor scope, then matches plan lines', async () => {
  const calls = setup({ items: [] });
  await listResolutionPlans(user(), query({ locationId: LOC, lotId: LOT }));
  assert.deepEqual(calls.distinct.field, '_id');
  assert.deepEqual(calls.distinct.filter['header.warehouseId'], { $in: [id(A)] });
  assert.deepEqual(calls.snapshotFilter, { stocktakeId: { $in: [ST] }, locationId: LOC });
  assert.deepEqual(calls.countFilter, { stocktakeId: { $in: [ST] }, snapshotId: { $in: [SNAP] } });
  const line = calls.pipeline[2].$match['resolutionPlans.items'].$elemMatch;
  assert.deepEqual(line.lotId, id(LOT));
  assert.equal(line.$or.length, 3);
});

test('location without any snapshot yields an empty page without running the plan query', async () => {
  const calls = setup({ snapshots: [] });
  const result = await listResolutionPlans(user(), query({ locationId: LOC }));
  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
  assert.equal(calls.pipeline, undefined);
  assert.equal(models.StocktakeCount.find.mock.callCount(), 0);
});
