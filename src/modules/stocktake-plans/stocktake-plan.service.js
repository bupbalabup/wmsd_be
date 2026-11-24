import * as m from '../../models/runtime.js';
import { command, checkVersion, saveVersion } from '../../shared/utils/document-command.js';
import { dto } from '../../shared/utils/persistence.js';
import { isOwner, requirePermission, requireWarehouseAccess } from '../../shared/utils/access.js';
import { ApiError, ERROR_CODES, validationError, notFoundError } from '../../shared/utils/ApiError.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { escapeRegex } from '../../shared/utils/movement-list.js';
import { validateCounters, validateScope, dedupe, createStocktakeSlip } from '../stocktake-closure/stocktake-commands.service.js';
import { occurrence, firstPeriodAfter, dueState, canGenerate, reminderWindowMs } from './stocktake-plan.schedule.js';

// Recurring stocktake plans (user decision 22 Nov 2026 following lecturer feedback). A plan posts no stock and
// locks nothing; it only generates normal Stocktake slips (PLANNED) with the same validation as POST /stocktakes.
// Permissions: stocktake:create (Owner) for every write, stocktake:read for reads; no new permission code.
const WRITE = 'stocktake:create';
const stateError = message => new ApiError(409, message, { code: ERROR_CODES.STOCKTAKE_PLAN_STATE });

async function scopedPlan(user, id, session) {
    const plan = await m.StocktakePlan.findById(id).session(session);
    if (!plan)
        throw notFoundError();
    requireWarehouseAccess(user, plan.header.warehouseId);
    return plan;
}

// Locations among `locationIds` holding a balance row in the scope's product/batch filter: the same rows activation
// snapshots (quantity zero included), so an area pulls in only bins with something to count.
async function stockedLocationIds(session, locationIds, scope) {
    if (!locationIds.length)
        return [];
    let batchIds = (scope.batchIds ?? []).map(String);
    if (scope.productIds?.length) {
        const productBatches = await m.ProductBatch.find({ productId: { $in: scope.productIds } }).select('_id').session(session).lean();
        const allowed = new Set(productBatches.map(row => String(row._id)));
        batchIds = batchIds.length ? batchIds.filter(id => allowed.has(id)) : [...allowed];
        if (!batchIds.length)
            return [];
    }
    const points = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locationIds } }).select('_id locationId').session(session).lean();
    const held = new Set((await m.InventoryBalance.distinct('holdingPointId', {
        holdingPointId: { $in: points.map(point => point._id) }, ...(batchIds.length && { batchId: { $in: batchIds } }),
    }).session(session)).map(String));
    return dedupe(points.filter(point => held.has(String(point._id))).map(point => point.locationId));
}

// Explicit locations plus the active locations of the warehouse in the chosen area codes, resolved when used.
// With `stockedOnly` (slip generation, user decision 23 Nov 2026) an area contributes only locations that hold stock in
// the plan's product/batch filter; explicitly named locations are always kept, even when empty.
async function resolveLocationIds(session, warehouseId, scope, { stockedOnly = false } = {}) {
    const explicit = scope.locationIds ?? [];
    const byArea = scope.areaCodes?.length
        ? await m.WarehouseLocation.find({ warehouseId, isActive: true, areaCode: { $in: scope.areaCodes } }).select('_id').session(session).lean()
        : [];
    const areaIds = byArea.map(row => row._id);
    return dedupe([...explicit, ...(stockedOnly ? await stockedLocationIds(session, areaIds, scope) : areaIds)]);
}

async function checkedScope(session, warehouseId, scope) {
    const locationIds = await resolveLocationIds(session, warehouseId, scope);
    if (!locationIds.length)
        throw validationError('Phạm vi kế hoạch phải có ít nhất một vị trí hoạt động (chọn vị trí hoặc khu vực có vị trí)');
    await validateScope(session, warehouseId, { locationIds, batchIds: scope.batchIds, productIds: scope.productIds });
    return { locationIds: dedupe(scope.locationIds ?? []), areaCodes: [...new Set(scope.areaCodes ?? [])], batchIds: dedupe(scope.batchIds ?? []), productIds: dedupe(scope.productIds ?? []) };
}

export function createStocktakePlan(user, input) {
    return command(user, 'CREATE_STOCKTAKE_PLAN', WRITE, null, input, (id, actor, session) => scopedPlan(actor, id, session), async (session, actor) => {
        const warehouse = await m.Warehouse.findOne({ _id: input.warehouseId, isActive: true }).session(session);
        if (!warehouse)
            throw validationError('Kho không hoạt động hoặc không tồn tại');
        requireWarehouseAccess(actor, warehouse._id);
        await validateCounters(session, warehouse._id, input.assignedCounterIds);
        const scope = await checkedScope(session, warehouse._id, input.scope);
        const startDate = new Date(input.startDate), endDate = input.endDate ? new Date(input.endDate) : null;
        if (endDate && endDate < startDate)
            throw validationError('Ngày kết thúc phải sau ngày bắt đầu');
        const plan = await new m.StocktakePlan({
            ...await nextDocumentFields(m.StocktakePlan, 'ST_SCHEDULE', warehouse._id, session),
            workflowStatus: 'ACTIVE', version: 1, createdBy: actor._id, occurredAt: new Date(),
            ...(input.note != null && { note: input.note }),
            header: {
                warehouseId: warehouse._id, title: input.title, ...(input.reason != null && { reason: input.reason }), scope,
                assignedCounterIds: dedupe(input.assignedCounterIds), frequency: input.frequency, startDate, ...(endDate && { endDate }),
                nextPeriodNo: 0, nextDueAt: occurrence(startDate, input.frequency, 0), reminderDays: input.reminderDays ?? 7, generatedCount: 0,
            },
        }).save({ session });
        return { document: plan, reason: input.title };
    });
}

// Frequency and start date are fixed once a plan exists (period numbers identify generated slips); create a new plan to change cadence.
export function updateStocktakePlan(user, id, input) {
    return command(user, 'UPDATE_STOCKTAKE_PLAN', WRITE, id, input, (pid, actor, session) => scopedPlan(actor, pid, session), async (session, actor) => {
        const plan = await scopedPlan(actor, id, session);
        checkVersion(plan, input.expectedVersion);
        if (plan.workflowStatus === 'ENDED')
            throw stateError('Kế hoạch đã kết thúc; không thể sửa');
        const header = plan.header;
        if (input.title != null)
            header.title = input.title;
        if (input.reason != null)
            header.reason = input.reason;
        if (input.note != null)
            plan.note = input.note;
        if (input.reminderDays != null)
            header.reminderDays = input.reminderDays;
        if (input.assignedCounterIds) {
            await validateCounters(session, header.warehouseId, input.assignedCounterIds);
            header.assignedCounterIds = dedupe(input.assignedCounterIds);
        }
        if (input.scope)
            header.scope = await checkedScope(session, header.warehouseId, input.scope);
        if (input.endDate !== undefined) {
            if (input.endDate !== null && header.nextDueAt && new Date(input.endDate) < header.nextDueAt)
                throw validationError('Ngày kết thúc phải sau kỳ kiểm kê kế tiếp; hãy kết thúc kế hoạch nếu không cần thêm kỳ');
            header.endDate = input.endDate === null ? undefined : new Date(input.endDate);
        }
        plan.updatedBy = actor._id;
        return { document: await saveVersion(plan, input.expectedVersion, session), versionBefore: input.expectedVersion, reason: input.title ?? input.reason ?? 'Cập nhật kế hoạch kiểm kê' };
    });
}

function transition(code, from, to, apply) {
    return (user, id, input) => command(user, code, WRITE, id, input, (pid, actor, session) => scopedPlan(actor, pid, session), async (session, actor) => {
        const plan = await scopedPlan(actor, id, session);
        checkVersion(plan, input.expectedVersion);
        if (!from.includes(plan.workflowStatus))
            throw stateError(`Kế hoạch đang ở trạng thái ${plan.workflowStatus}; không thể thực hiện thao tác này`);
        plan.workflowStatus = to;
        plan.updatedBy = actor._id;
        apply(plan, actor, input, new Date());
        return { document: await saveVersion(plan, input.expectedVersion, session), versionBefore: input.expectedVersion, reason: input.reason ?? code };
    });
}
export const pauseStocktakePlan = transition('PAUSE_STOCKTAKE_PLAN', ['ACTIVE'], 'PAUSED', (plan, actor, input, now) => { plan.header.pausedAt = now; plan.header.pausedBy = actor._id; });
// Resuming keeps an overdue period visible as OVERDUE; periods are not skipped silently.
export const resumeStocktakePlan = transition('RESUME_STOCKTAKE_PLAN', ['PAUSED'], 'ACTIVE', (plan, actor, input, now) => { plan.header.resumedAt = now; });
export const endStocktakePlan = transition('END_STOCKTAKE_PLAN', ['ACTIVE', 'PAUSED'], 'ENDED', (plan, actor, input, now) => { plan.header.endedAt = now; plan.header.endedBy = actor._id; if (input.reason) plan.header.endReason = input.reason; });

// "Tạo phiếu kiểm kê từ kế hoạch". One slip per period: the plan version arbitrates retries and concurrent clicks,
// the period is checked for an existing slip, and a unique partial index on stocktakes backs it up.
export function generateStocktakeFromPlan(user, id, input) {
    return command(user, 'GENERATE_STOCKTAKE_FROM_PLAN', WRITE, id, input, (pid, actor, session) => scopedPlan(actor, pid, session), async (session, actor) => {
        const plan = await scopedPlan(actor, id, session);
        checkVersion(plan, input.expectedVersion);
        if (plan.workflowStatus !== 'ACTIVE')
            throw stateError('Chỉ tạo phiếu từ kế hoạch đang áp dụng');
        const header = plan.header, now = new Date(), regenerating = input.periodNo != null;
        const periodNo = regenerating ? input.periodNo : header.nextPeriodNo, dueAt = regenerating ? occurrence(header.startDate, header.frequency, periodNo) : header.nextDueAt;
        const periodFilter = { 'header.planId': plan._id, 'header.planPeriodNo': periodNo };
        if (regenerating) {
            // Only an already generated period whose slips are all CANCELLED can be generated again.
            if (periodNo >= header.nextPeriodNo || !await m.Stocktake.exists(periodFilter).session(session))
                throw stateError('Kỳ này chưa có phiếu nào để tạo lại');
        }
        else if (!canGenerate(header, plan.workflowStatus, now))
            throw new ApiError(409, 'Chưa đến kỳ kiểm kê kế tiếp', { code: ERROR_CODES.STOCKTAKE_PLAN_NOT_DUE, details: { nextDueAt: dueAt.toISOString(), reminderDays: header.reminderDays } });
        // A CANCELLED slip frees its period (the unique index ignores it too); any other slip keeps the period taken.
        if (await m.Stocktake.exists({ ...periodFilter, workflowStatus: { $ne: 'CANCELLED' } }).session(session))
            throw new ApiError(409, 'Kỳ kiểm kê này đã có phiếu', { code: ERROR_CODES.STOCKTAKE_PLAN_PERIOD_EXISTS });
        const locationIds = await resolveLocationIds(session, header.warehouseId, header.scope, { stockedOnly: true });
        if (!locationIds.length)
            throw validationError('Khu vực của kế hoạch không có vị trí nào có tồn của hàng cần kiểm');
        const slip = await createStocktakeSlip(session, actor, {
            warehouseId: header.warehouseId, reason: header.reason ?? `${header.title} - kỳ ${periodNo + 1}`, plannedAt: dueAt.toISOString(),
            assignedCounterIds: header.assignedCounterIds.map(String), note: plan.note,
            scope: { locationIds, batchIds: header.scope.batchIds.map(String), productIds: header.scope.productIds.map(String), areaCodes: header.scope.areaCodes },
        }, { planId: plan._id, periodNo, dueAt });
        header.lastGeneratedAt = now;
        header.lastStocktakeId = slip._id;
        header.generatedCount += 1;
        if (regenerating) {
            // The schedule already moved past this period; regenerating changes neither nextPeriodNo nor nextDueAt.
            plan.updatedBy = actor._id;
            return {
                document: await saveVersion(plan, input.expectedVersion, session), versionBefore: input.expectedVersion,
                resultRefs: [{ documentType: 'stocktakes', documentId: slip._id }], reason: `Tạo lại phiếu kiểm kê kỳ ${periodNo + 1}`,
            };
        }
        // Missed periods are skipped: the next due date is the first one after now (never earlier than the following period).
        const nextPeriodNo = firstPeriodAfter(header.startDate, header.frequency, periodNo + 1, now), nextDueAt = occurrence(header.startDate, header.frequency, nextPeriodNo);
        if (header.endDate && nextDueAt > header.endDate) {
            plan.workflowStatus = 'ENDED';
            header.endedAt = now;
            header.endReason = 'END_DATE_REACHED';
            header.nextDueAt = undefined;
            header.nextPeriodNo = nextPeriodNo;
        }
        else {
            header.nextPeriodNo = nextPeriodNo;
            header.nextDueAt = nextDueAt;
        }
        plan.updatedBy = actor._id;
        return {
            document: await saveVersion(plan, input.expectedVersion, session), versionBefore: input.expectedVersion,
            resultRefs: [{ documentType: 'stocktakes', documentId: slip._id }], reason: `Tạo phiếu kiểm kê kỳ ${periodNo + 1}`,
        };
    });
}

function present(plan, now = new Date()) {
    const value = dto(plan), state = dueState(plan.header, plan.workflowStatus, now);
    const due = plan.header.nextDueAt ? new Date(plan.header.nextDueAt) : null;
    return {
        ...value,
        isDue: state === 'OVERDUE', dueSoon: state === 'DUE_SOON', dueState: state, canGenerate: state !== 'NOT_DUE',
        daysUntilDue: due ? Math.ceil((due.getTime() - now.getTime()) / 86_400_000) : null,
    };
}

export async function listStocktakePlans(user, query) {
    requirePermission(user, 'stocktake:read');
    const now = new Date(), filter = isOwner(user) ? {} : { 'header.warehouseId': { $in: user.warehouseIds || [] } };
    if (query.warehouseId) {
        requireWarehouseAccess(user, query.warehouseId);
        filter['header.warehouseId'] = query.warehouseId;
    }
    if (query.status)
        filter.workflowStatus = query.status;
    if (query.q)
        filter.$or = [{ documentNo: { $regex: escapeRegex(query.q), $options: 'i' } }, { 'header.title': { $regex: escapeRegex(query.q), $options: 'i' } }];
    if (query.dueState === 'OVERDUE')
        Object.assign(filter, { workflowStatus: 'ACTIVE', 'header.nextDueAt': { $lte: now } });
    if (query.dueState === 'DUE_SOON')
        Object.assign(filter, { workflowStatus: 'ACTIVE', 'header.nextDueAt': { $gt: now }, $expr: { $lte: ['$header.nextDueAt', { $add: [now, { $multiply: ['$header.reminderDays', reminderWindowMs(1)] }] }] } });
    const [rows, total] = await Promise.all([
        m.StocktakePlan.find(filter).sort({ 'header.nextDueAt': 1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
        m.StocktakePlan.countDocuments(filter),
    ]);
    const warehouses = await m.Warehouse.find({ _id: { $in: [...new Set(rows.map(row => String(row.header.warehouseId)))] } }).select('_id code name').lean();
    return { items: rows.map(row => present(row, now)), total, page: query.page, limit: query.limit, lookups: { warehouses: warehouses.map(row => ({ id: String(row._id), code: row.code, name: row.name })) } };
}

export async function getStocktakePlan(user, id) {
    requirePermission(user, 'stocktake:read');
    const plan = await m.StocktakePlan.findById(id);
    if (!plan)
        throw notFoundError();
    requireWarehouseAccess(user, plan.header.warehouseId);
    const [slips, warehouses, locations, counters] = await Promise.all([
        m.Stocktake.find({ 'header.planId': plan._id }).sort({ 'header.planPeriodNo': -1 }).select('documentNo workflowStatus version header.planPeriodNo header.planPeriodDueAt header.plannedAt header.completedAt').lean(),
        m.Warehouse.find({ _id: plan.header.warehouseId }).select('_id code name').lean(),
        m.WarehouseLocation.find({ warehouseId: plan.header.warehouseId, isActive: true, $or: [{ _id: { $in: plan.header.scope.locationIds } }, { areaCode: { $in: plan.header.scope.areaCodes } }] }).select('_id code name areaCode').lean(),
        m.User.find({ _id: { $in: plan.header.assignedCounterIds } }).select('_id username fullName').lean(),
    ]);
    // Earlier periods whose slips are all CANCELLED can be generated again (POST /:id/generate with periodNo).
    const byPeriod = new Map();
    for (const row of slips)
        byPeriod.set(row.header.planPeriodNo, (byPeriod.get(row.header.planPeriodNo) ?? true) && row.workflowStatus === 'CANCELLED');
    return {
        ...present(plan),
        regenerablePeriodNos: [...byPeriod].filter(([periodNo, cancelled]) => cancelled && periodNo < plan.header.nextPeriodNo).map(([periodNo]) => periodNo).sort((a, b) => a - b),
        slips: slips.map(row => ({ id: String(row._id), documentNo: row.documentNo, workflowStatus: row.workflowStatus, version: row.version, periodNo: row.header.planPeriodNo, dueAt: row.header.planPeriodDueAt?.toISOString() ?? null, plannedAt: row.header.plannedAt?.toISOString() ?? null, completedAt: row.header.completedAt?.toISOString() ?? null })),
        lookups: {
            warehouses: warehouses.map(row => ({ id: String(row._id), code: row.code, name: row.name })),
            locations: locations.map(row => ({ id: String(row._id), code: row.code, name: row.name, areaCode: row.areaCode ?? null })),
            counters: counters.map(row => ({ id: String(row._id), username: row.username, fullName: row.fullName })),
        },
    };
}
