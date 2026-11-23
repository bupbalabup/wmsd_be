import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { command, checkVersion, saveVersion, same, newId } from '../../shared/utils/document-command.js';
import { requirePermission, requireWarehouseAccess, hasPermission } from '../../shared/utils/access.js';
import { validationError, notFoundError } from '../../shared/utils/ApiError.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { dto } from '../../shared/utils/persistence.js';
import { remainingReservation, pendingTaskQuantity, heldQuantity } from '../../shared/utils/stock.js';

// Counting and reconciliation occur while frozen. A new count invalidates the selected
// set; UC-93 close checks the latest count and exact approval content.
// Stock found but absent from the book gets a DISCOVERED snapshot (book 0) backed by a
// zero-quantity balance, so plan/review/close treat it like any other snapshot.
export async function stocktakeOptions(user) {
    requirePermission(user, 'stocktake:create');
    const warehouses = await m.Warehouse.find({ isActive: true }).select('_id code name').lean();
    const locations = await m.WarehouseLocation.find({ warehouseId: { $in: warehouses.map(w => w._id) }, isActive: true }).select('_id warehouseId code name areaCode locationType').lean();
    // Locations already frozen by another session cannot be activated again; the planner sees them up front.
    const [locked, products] = await Promise.all([
        m.StocktakeLocationLock.find({ locationId: { $in: locations.map(l => l._id) }, status: 'LOCKED' }).select('locationId').lean(),
        // Optional product filter of the scope (cycle count of selected tiles).
        m.Product.find({ isActive: true }).select('_id sku name').sort({ sku: 1 }).lean(),
    ]);
    const users = await m.User.find({ isActive: true, warehouseIds: { $in: warehouses.map(w => w._id) } }).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
    return { warehouses: warehouses.map(dto), locations: locations.map(dto), lockedLocationIds: locked.map(l => String(l.locationId)), products: products.map(p => ({ id: String(p._id), sku: p.sku, name: p.name })), stockedProductIdsByLocation: await stockedProductIdsByLocation(locations.map(l => l._id)), counters: users.filter(u => hasPermission(u, 'stocktake:update')).map(u => ({ id: String(u._id), fullName: u.fullName, warehouseIds: u.warehouseIds.map(String) })) };
}
// Products that already have a balance row at each location (the same rows activation would snapshot),
// so the planner can offer only products that exist in the chosen locations.
async function stockedProductIdsByLocation(locationIds) {
    const points = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locationIds } }).select('_id locationId').lean();
    const pointLocation = new Map(points.map(point => [String(point._id), String(point.locationId)]));
    const balances = await m.InventoryBalance.find({ holdingPointId: { $in: points.map(point => point._id) } }).select('holdingPointId batchId').lean();
    const batches = await m.ProductBatch.find({ _id: { $in: [...new Set(balances.map(balance => String(balance.batchId)))] } }).select('_id productId').lean();
    const batchProduct = new Map(batches.map(batch => [String(batch._id), String(batch.productId)]));
    const byLocation = {};
    for (const balance of balances) {
        const locationId = pointLocation.get(String(balance.holdingPointId)), productId = batchProduct.get(String(balance.batchId));
        if (locationId && productId)
            (byLocation[locationId] ??= new Set()).add(productId);
    }
    return Object.fromEntries(Object.entries(byLocation).map(([locationId, ids]) => [locationId, [...ids]]));
}
export async function scoped(user, id, session) { const document = await m.Stocktake.findById(id).session(session); if (!document)
    throw notFoundError(); requireWarehouseAccess(user, document.header.warehouseId); return document; }
export function assigned(document, actor) {
    if (!document.header.assignedCounterIds.some(id => same(id, actor._id)))
        throw validationError('Bạn không được phân công trong đợt kiểm kê này');
}
export const dedupe = ids => [...new Set(ids.map(id => String(id)))];
async function loadCounter(session, warehouseId, counterId) {
    const counter = await m.User.findById(counterId).populate({ path: 'roleId', populate: { path: 'permissionIds' } }).session(session);
    if (!counter || !counter.isActive)
        throw validationError('Người đếm không tồn tại hoặc đã ngừng hoạt động');
    if (!(counter.warehouseIds || []).some(id => same(id, warehouseId)))
        throw validationError('Người đếm không thuộc kho của đợt');
    if (!hasPermission(counter, 'stocktake:update'))
        throw validationError('Người đếm thiếu quyền ghi kết quả kiểm kê');
    return counter;
}
export async function validateCounters(session, warehouseId, counterIds) {
    for (const counterId of dedupe(counterIds))
        await loadCounter(session, warehouseId, counterId);
}
export async function validateScope(session, warehouseId, scope) {
    const locations = await m.WarehouseLocation.find({ _id: { $in: scope.locationIds }, warehouseId, isActive: true }).session(session);
    if (new Set(locations.map(row => String(row._id))).size !== new Set(scope.locationIds.map(String)).size)
        throw validationError('Vị trí không thuộc kho hoặc đã ngừng hoạt động');
    if (scope.batchIds?.length) {
        const batches = await m.ProductBatch.find({ _id: { $in: scope.batchIds } }).select('_id').session(session);
        if (new Set(batches.map(row => String(row._id))).size !== new Set(scope.batchIds.map(String)).size)
            throw validationError('Lô trong bộ lọc không tồn tại');
    }
    if (scope.productIds?.length) {
        const products = await m.Product.find({ _id: { $in: scope.productIds } }).select('_id').session(session);
        if (new Set(products.map(row => String(row._id))).size !== new Set(scope.productIds.map(String)).size)
            throw validationError('Sản phẩm trong bộ lọc không tồn tại');
    }
}
export const scopeRows = scope => ({
    locationIds: dedupe(scope.locationIds),
    batchIds: scope.batchIds ? dedupe(scope.batchIds) : [],
    productIds: scope.productIds ? dedupe(scope.productIds) : [],
    areaCodes: scope.areaCodes ? [...new Set(scope.areaCodes)] : [],
});
const scopeChanged = (next, current) => next.locationIds.join('|') !== current.locationIds.map(String).join('|')
    || next.batchIds.join('|') !== (current.batchIds || []).map(String).join('|')
    || next.productIds.join('|') !== (current.productIds || []).map(String).join('|');

// Shared by POST /stocktakes (ad-hoc slip) and POST /stocktake-plans/:id/generate. Both run the same
// warehouse, counter and scope validation inside the caller's transaction; `plan` only stamps the header.
export async function createStocktakeSlip(session, actor, input, plan) {
    const warehouse = await m.Warehouse.findOne({ _id: input.warehouseId, isActive: true }).session(session);
    if (!warehouse)
        throw validationError('Kho không hoạt động hoặc không tồn tại');
    requireWarehouseAccess(actor, warehouse._id);
    await validateCounters(session, warehouse._id, input.assignedCounterIds);
    await validateScope(session, warehouse._id, input.scope);
    const scope = scopeRows(input.scope);
    if (!scope.locationIds.length)
        throw validationError('Phạm vi phải có ít nhất một vị trí');
    const fields = await nextDocumentFields(m.Stocktake, 'ST', warehouse._id, session);
    return new m.Stocktake({
        ...fields,
        workflowStatus: 'PLANNED',
        version: 1,
        createdBy: actor._id,
        occurredAt: new Date(),
        ...(input.note != null && { note: input.note }),
        header: {
            warehouseId: warehouse._id,
            reason: input.reason,
            ...(input.plannedAt && { plannedAt: input.plannedAt }),
            ...(input.cutoffAt && { cutoffAt: input.cutoffAt }),
            mode: 'FROZEN',
            scopeVersion: 1,
            scope,
            scopeLocationIds: scope.locationIds,
            assignedCounterIds: dedupe(input.assignedCounterIds),
            ...(plan && { planId: plan.planId, planPeriodNo: plan.periodNo, planPeriodDueAt: plan.dueAt }),
        },
    }).save({ session });
}

export function createStocktake(user, input) {
    return command(user, 'CREATE_STOCKTAKE', 'stocktake:create', null, input, (id, actor, session) => scoped(actor, id, session), async (session, actor) => {
        const document = await createStocktakeSlip(session, actor, input);
        return { document, reason: input.reason };
    });
}

export function updateStocktake(user, id, input) {
    return command(user, 'UPDATE_STOCKTAKE', 'stocktake:create', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor) => {
        const document = await scoped(actor, id, session);
        checkVersion(document, input.expectedVersion);
        if (document.workflowStatus !== 'PLANNED')
            throw validationError('Đợt đã kích hoạt hoặc hoàn tất; không thể sửa kế hoạch');
        const header = document.header;
        if (input.assignedCounterIds) {
            await validateCounters(session, header.warehouseId, input.assignedCounterIds);
            header.assignedCounterIds = dedupe(input.assignedCounterIds);
        }
        if (input.reason != null)
            header.reason = input.reason;
        if (input.plannedAt != null)
            header.plannedAt = input.plannedAt;
        if (input.cutoffAt != null)
            header.cutoffAt = input.cutoffAt;
        if (input.note != null)
            document.note = input.note;
        if (input.scope) {
            await validateScope(session, header.warehouseId, input.scope);
            const next = scopeRows(input.scope);
            if (scopeChanged(next, header.scope))
                header.scopeVersion += 1;
            header.scope = next;
            header.scopeLocationIds = next.locationIds;
        }
        return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion, reason: input.reason };
    });
}

export function activateStocktake(user, id, input) {
    return command(user, 'ACTIVATE_STOCKTAKE', 'stocktake:update', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor) => {
        const document = await scoped(actor, id, session);
        checkVersion(document, input.expectedVersion);
        if (document.workflowStatus !== 'PLANNED')
            throw validationError('Đợt không ở trạng thái kế hoạch');
        assigned(document, actor);
        const header = document.header;
        const locations = header.scopeLocationIds;
        if (!locations.length || !header.assignedCounterIds.length)
            throw validationError('Phạm vi hoặc người đếm chưa được phân công');
        if (await m.StocktakeLocationLock.exists({ locationId: { $in: locations }, status: 'LOCKED' }).session(session))
            throw validationError('Có vị trí đang bị khóa bởi đợt kiểm kê khác');
        // Serialize against every physical-stock writer: bump each scoped location
        // before reading balances so frozen snapshots share the guardLocations boundary.
        for (const locationId of locations) {
            const location = await m.WarehouseLocation.findOneAndUpdate({ _id: locationId, warehouseId: header.warehouseId, isActive: true }, { $inc: { operationVersion: 1 } }, { session });
            if (!location)
                throw validationError('Vị trí không hoạt động hoặc sai kho');
        }
        const cutoffAt = new Date();
        const points = await m.StockHoldingPoint.find({ type: 'LOCATION', locationId: { $in: locations } }).session(session);
        const pointLocation = new Map(points.map(point => [String(point._id), point.locationId]));
        const batchFilter = {};
        if (header.scope.batchIds.length)
            batchFilter.batchId = { $in: header.scope.batchIds };
        if (header.scope.productIds.length) {
            const productBatches = await m.ProductBatch.find({ productId: { $in: header.scope.productIds } }).select('_id').session(session);
            const allowed = new Set(productBatches.map(row => String(row._id)));
            const ids = header.scope.batchIds.length ? header.scope.batchIds.map(String).filter(id => allowed.has(id)) : [...allowed];
            batchFilter.batchId = { $in: ids.length ? ids : [newId()] };
        }
        const balances = await m.InventoryBalance.find({ holdingPointId: { $in: points.map(point => point._id) }, ...batchFilter }).session(session);
        for (const balance of balances) {
            const reservations = await m.StockReservation.find({ balanceId: balance._id }).session(session);
            if (reservations.some(row => remainingReservation(row).gt(0))
                || (await pendingTaskQuantity(balance._id, session)).gt(0)
                || (await heldQuantity(balance._id, session)).gt(0))
                throw validationError('Còn lượng giữ hoặc công việc chưa xử lý trong phạm vi');
        }
        const products = new Map();
        for (const balance of balances) {
            let product = products.get(String(balance.batchId));
            if (!product) {
                const batch = await m.ProductBatch.findById(balance.batchId).session(session);
                product = batch && await m.Product.findById(batch.productId).session(session);
                if (!product)
                    throw validationError('Mốc kiểm kê thiếu sản phẩm');
                products.set(String(balance.batchId), product);
            }
            await new m.StocktakeSnapshot({
                stocktakeId: document._id,
                scopeVersion: header.scopeVersion,
                cutoffAt,
                capturedAt: new Date(),
                sourceBalanceId: balance._id,
                sourceBalanceVersion: balance.version,
                locationId: pointLocation.get(String(balance.holdingPointId)),
                batchId: balance.batchId,
                ownerType: balance.ownerType,
                ownerId: balance.ownerId ?? null,
                qualityStatus: balance.qualityStatus,
                bookQtyBase: String(balance.quantityBase),
                baseUnitSnapshot: product.baseUnit,
                origin: 'BOOK',
            }).save({ session });
        }
        // The unique partial index on {locationId} with status LOCKED arbitrates
        // concurrent activations; a loser fails and its transaction rolls back.
        for (const locationId of locations)
            await new m.StocktakeLocationLock({
                stocktakeId: document._id,
                locationId,
                scopeVersion: header.scopeVersion,
                lockedAt: new Date(),
                lockedBy: actor._id,
                status: 'LOCKED',
                version: 1,
            }).save({ session });
        header.activatedBy = actor._id;
        header.activatedAt = new Date();
        header.cutoffAt = cutoffAt;
        document.workflowStatus = 'COUNTING';
        return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion, reason: 'Kích hoạt phạm vi kiểm kê' };
    });
}

// Finds or creates the DISCOVERED snapshot for stock physically found in a frozen location
// without a book balance. Only COUNTING sessions reach here (checked by recordCount).
async function discoverSnapshot(session, document, actor, input) {
    const header = document.header, found = input.discovered;
    const ownerId = found.ownerType === 'STORE' ? null : found.ownerId;
    if (found.ownerType !== 'STORE' && !ownerId)
        throw validationError('Hàng của nhà cung cấp/khách hàng cần mã chủ hàng');
    if (!header.scopeLocationIds.some(row => same(row, found.locationId)))
        throw validationError('Vị trí không thuộc phạm vi đợt');
    const location = await m.WarehouseLocation.findOne({ _id: found.locationId, warehouseId: header.warehouseId, isActive: true }).session(session);
    if (!location)
        throw validationError('Vị trí không thuộc phạm vi đợt');
    const key = { stocktakeId: document._id, locationId: found.locationId, batchId: found.batchId, qualityStatus: found.qualityStatus, ownerType: found.ownerType, ownerId };
    const existing = await m.StocktakeSnapshot.findOne(key).session(session);
    if (existing && existing.origin !== 'DISCOVERED')
        throw validationError('Hàng đã có trong sổ; hãy đếm theo mốc tồn');
    if (existing && input.correctsEmptyCountId)
        throw validationError('Nhóm hàng đã có mốc; hãy đếm theo mốc tồn');
    if (existing) return existing;
    if (!exact(input.countedQtyBase).gt(0))
        throw validationError('Hàng phát hiện ngoài sổ phải có số lượng lớn hơn 0');
    if (!input.evidenceIds?.length)
        throw validationError('Hàng phát hiện ngoài sổ cần bằng chứng');
    const evidenceCount = await m.Attachment.countDocuments({ _id: { $in: input.evidenceIds }, status: 'ATTACHED', ownerDocumentType: 'stocktakes', ownerDocumentId: document._id, uploadedBy: actor._id }).session(session);
    if (evidenceCount !== input.evidenceIds.length)
        throw validationError('Bằng chứng không thuộc đợt kiểm kê hoặc không phải do bạn tải');
    const scope = { stocktakeId: document._id, scopeVersion: header.scopeVersion, locationId: location._id };
    const emptyCount = await m.StocktakeCount.findOne({ ...scope, targetType: 'EMPTY_LOCATION' }).sort({ attemptNo: -1 }).session(session);
    if (input.correctsEmptyCountId && (!same(emptyCount?._id, input.correctsEmptyCountId) || !exact(emptyCount.countedQtyBase).isZero()))
        throw validationError('Chỉ sửa được lần xác nhận trống mới nhất của vị trí');
    if (emptyCount) {
        if (input.correctsEmptyCountId) {
            if (await m.StocktakeCount.exists({ ...scope, correctsEmptyCountId: emptyCount._id }).session(session))
                throw validationError('Lần xác nhận trống này đã được sửa');
            if (!(await m.StocktakeLocationLock.exists({ ...scope, status: 'LOCKED' }).session(session)))
                throw validationError('Vị trí không còn khóa kiểm kê của đợt');
        } else if (!(await m.StocktakeCount.exists({ ...scope, correctsEmptyCountId: emptyCount._id }).session(session))) {
            throw validationError('Vị trí đã xác nhận trống; hãy dùng thao tác sửa xác nhận trống');
        }
    } else if (input.correctsEmptyCountId) {
        throw validationError('Không có lần xác nhận trống để sửa');
    }
    const batch = await m.ProductBatch.findById(found.batchId).session(session);
    const product = batch && await m.Product.findById(batch.productId).session(session);
    if (!product || !product.isActive || batch.identificationStatus !== 'VERIFIED')
        throw validationError('Lô hoặc sản phẩm không hợp lệ để ghi nhận hàng phát hiện');
    if (header.scope.batchIds.length && !header.scope.batchIds.some(row => same(row, batch._id)))
        throw validationError('Lô nằm ngoài bộ lọc của đợt');
    if (header.scope.productIds.length && !header.scope.productIds.some(row => same(row, product._id)))
        throw validationError('Sản phẩm nằm ngoài bộ lọc của đợt');
    if (product.wholeBaseUnits && !exact(input.countedQtyBase).isInteger())
        throw validationError('Sản phẩm nguyên thùng/viên phải đếm nguyên theo đơn vị gốc');
    // Serialize with physical-stock writers like activation does, then make sure no
    // positive balance exists for this identity (it would belong in the book snapshot).
    await m.WarehouseLocation.updateOne({ _id: location._id }, { $inc: { operationVersion: 1 } }, { session });
    const pointFields = { type: 'LOCATION', locationId: location._id };
    const point = await m.StockHoldingPoint.findOne(pointFields).session(session) ?? await new m.StockHoldingPoint(pointFields).save({ session });
    const identity = { holdingPointId: point._id, batchId: batch._id, qualityStatus: found.qualityStatus, ownerType: found.ownerType, ownerId };
    let balance = await m.InventoryBalance.findOne(identity).session(session);
    if (balance && exact(balance.quantityBase).gt(0))
        throw validationError('Nhóm tồn đã có số dư; không thể ghi nhận như hàng ngoài sổ');
    balance ??= await new m.InventoryBalance({ ...identity, quantityBase: '0', version: 0, packagingPortions: [] }).save({ session });
    return await new m.StocktakeSnapshot({
        ...key,
        scopeVersion: header.scopeVersion,
        cutoffAt: header.cutoffAt,
        capturedAt: new Date(),
        sourceBalanceId: balance._id,
        sourceBalanceVersion: balance.version,
        bookQtyBase: '0',
        baseUnitSnapshot: product.baseUnit,
        origin: 'DISCOVERED',
        discoveredAt: new Date(),
        discoveredBy: actor._id,
        evidenceIds: input.evidenceIds,
    }).save({ session });
}

export function recordCount(user, id, input) {
    return recordCountCommand(user, id, input, 'RECORD_STOCKTAKE_COUNT');
}

export function correctEmptyLocation(user, id, input) {
    const { emptyCountId, ...discovery } = input;
    return recordCountCommand(user, id, {
        ...discovery,
        targetType: 'STOCK',
        correctsEmptyCountId: emptyCountId,
    }, 'CORRECT_EMPTY_LOCATION');
}

// Counter's reason for a line whose newest count differs from the book (user decision 23 Nov 2026). It is tied to
// that attempt: a later count of the line needs a new reason. The Owner only approves or sends the line back.
export function setCountReason(user, id, input) {
    return command(user, 'SET_STOCKTAKE_COUNT_REASON', 'stocktake:update', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor) => {
        const document = await scoped(actor, id, session);
        if (document.workflowStatus !== 'COUNTING')
            throw validationError('Đợt không còn ở bước đếm; không đổi được lý do chênh lệch');
        checkVersion(document, input.expectedVersion);
        assigned(document, actor);
        const header = document.header;
        const snapshot = await m.StocktakeSnapshot.findOne({ _id: input.snapshotId, stocktakeId: document._id, scopeVersion: header.scopeVersion }).session(session);
        if (!snapshot)
            throw validationError('Dòng không thuộc đợt hoặc phiên bản phạm vi hiện tại');
        if (header.settledLines.some(row => same(row.snapshotId, snapshot._id)))
            throw validationError('Dòng đã được duyệt xử lý chênh lệch');
        const latest = await m.StocktakeCount.findOne({ stocktakeId: document._id, scopeVersion: header.scopeVersion, snapshotId: snapshot._id }).sort({ attemptNo: -1 }).session(session);
        if (!latest || !same(latest._id, input.countId))
            throw validationError('Lần đếm không còn là kết quả mới nhất của dòng');
        if (exact(String(latest.countedQtyBase)).eq(String(snapshot.bookQtyBase)))
            throw validationError('Dòng khớp sổ không cần lý do chênh lệch');
        const row = { snapshotId: snapshot._id, countId: latest._id, reasonCode: input.reasonCode, ...(input.reasonNote && { reasonNote: input.reasonNote }), setBy: actor._id, setAt: new Date() };
        header.countReasons = [...header.countReasons.filter(item => !same(item.snapshotId, snapshot._id)), row];
        return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion, resultRefs: [{ documentType: 'stocktakes', documentId: document._id, itemId: latest._id }], reason: 'Chọn lý do chênh lệch' };
    });
}

function recordCountCommand(user, id, input, operationCode) {
    return command(user, operationCode, 'stocktake:update', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor) => {
        const document = await scoped(actor, id, session);
        if (document.workflowStatus !== 'COUNTING')
            throw validationError('Đợt không còn ở bước đếm; không nhận thêm kết quả');
        checkVersion(document, input.expectedVersion);
        assigned(document, actor);
        if (operationCode === 'CORRECT_EMPTY_LOCATION' && (!input.correctsEmptyCountId || !input.discovered || !input.correctionReason?.trim()))
            throw validationError('Sửa xác nhận trống cần chọn lần xác nhận, ghi hàng phát hiện và lý do');
        const header = document.header;
        let snapshot = null, locationId;
        if (input.targetType === 'STOCK') {
            snapshot = input.snapshotId
                ? await m.StocktakeSnapshot.findOne({ _id: input.snapshotId, stocktakeId: document._id, scopeVersion: header.scopeVersion }).session(session)
                : await discoverSnapshot(session, document, actor, input);
            if (!snapshot)
                throw validationError('Mốc không thuộc đợt hoặc phiên bản phạm vi hiện tại');
            locationId = snapshot.locationId;
        }
        else {
            const inScope = header.scopeLocationIds.some(row => same(row, input.locationId));
            const location = inScope && await m.WarehouseLocation.findOne({ _id: input.locationId, warehouseId: header.warehouseId, isActive: true }).session(session);
            if (!location)
                throw validationError('Vị trí không thuộc phạm vi đợt');
            locationId = input.locationId;
            if (await m.StocktakeSnapshot.exists({ stocktakeId: document._id, scopeVersion: header.scopeVersion, locationId }).session(session))
                throw validationError('Vị trí đã có mốc tồn; hãy đếm từng mốc');
        }
        const latest = await m.StocktakeCount.findOne({
            stocktakeId: document._id,
            ...(snapshot ? { snapshotId: snapshot._id } : { locationId, targetType: 'EMPTY_LOCATION' }),
        }).sort({ attemptNo: -1 }).session(session);
        const attemptNo = (latest?.attemptNo ?? 0) + 1;
        if (snapshot && header.settledLines.some(row => same(row.snapshotId, snapshot._id)))
            throw validationError('Dòng đã được duyệt xử lý chênh lệch; không thể đếm lại');
        // After "recount" only the lines the Owner sent back accept new attempts; a line first seen now (found stock) is new.
        if (snapshot && latest && header.recountLines.length && !header.recountLines.some(row => same(row.snapshotId, snapshot._id)))
            throw validationError('Đợt đang đếm lại: chỉ nhận kết quả cho các dòng được yêu cầu đếm lại');
        if (attemptNo > 1) {
            if (!input.previousCountId || !input.recountReason)
                throw validationError('Đếm lại cần chọn lần đếm trước và ghi lý do');
            if (!same(latest._id, input.previousCountId))
                throw validationError('Lần đếm trước không còn là kết quả mới nhất');
        }
        const countedQtyBase = input.targetType === 'EMPTY_LOCATION' ? '0' : input.countedQtyBase;
        if (snapshot) {
            const batch = await m.ProductBatch.findById(snapshot.batchId).session(session);
            const product = batch && await m.Product.findById(batch.productId).session(session);
            if (product?.wholeBaseUnits && !exact(countedQtyBase).isInteger())
                throw validationError('Sản phẩm nguyên thùng/viên phải đếm nguyên theo đơn vị gốc');
        }
        const quantityEntries = input.quantityEntries ?? (snapshot && exact(countedQtyBase).gt(0)
            ? [{ enteredQty: countedQtyBase, enteredUnit: snapshot.baseUnitSnapshot, baseUnitsPerUnit: '1', quantityBase: countedQtyBase }]
            : []);
        const sum = quantityEntries.reduce((total, row) => total.plus(row.quantityBase), exact('0'));
        if (!sum.eq(countedQtyBase))
            throw validationError('Các lượng nhập phải cộng đúng kết quả đếm');
        const count = await new m.StocktakeCount({
            stocktakeId: document._id,
            scopeVersion: header.scopeVersion,
            locationId,
            targetType: input.targetType,
            snapshotId: snapshot?._id ?? null,
            attemptNo,
            ...(attemptNo > 1 && { previousCountId: input.previousCountId, recountReason: input.recountReason }),
            quantityEntries,
            countedQtyBase,
            ...(snapshot && { baseUnitSnapshot: snapshot.baseUnitSnapshot }),
            ...(input.correctsEmptyCountId && { correctsEmptyCountId: input.correctsEmptyCountId, correctionReason: input.correctionReason.trim() }),
            ...(input.conditionNote != null && { conditionNote: input.conditionNote }),
            evidenceIds: input.evidenceIds ?? [],
            countedBy: actor._id,
            countedAt: new Date(),
            recordedAt: new Date(),
        }).save({ session });
        header.selectedCounts = [];
        header.lastReconciledAt = null;
        return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion, resultRefs: [{ documentType: 'stocktakes', documentId: document._id, itemId: count._id, revision: attemptNo }], reason: input.correctionReason ?? (attemptNo > 1 ? input.recountReason : 'Ghi kết quả đếm') };
    });
}

export function reconcileStocktake(user, id, input) {
    return command(user, 'RECONCILE_STOCKTAKE', 'stocktake:reconcile', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor) => {
        const document = await scoped(actor, id, session);
        checkVersion(document, input.expectedVersion);
        if (document.workflowStatus !== 'COUNTING')
            throw validationError('Đợt không ở bước đếm/đối chiếu');
        assigned(document, actor);
        const header = document.header;
        const scope = { stocktakeId: document._id, scopeVersion: header.scopeVersion };
        const snapshots = await m.StocktakeSnapshot.find(scope).session(session);
        const counts = await m.StocktakeCount.find(scope).sort({ attemptNo: 1 }).session(session);
        const latest = new Map();
        for (const count of counts) {
            const key = count.snapshotId ? String(count.snapshotId) : `EMPTY:${count.locationId}`;
            const current = latest.get(key);
            if (!current || count.attemptNo > current.attemptNo)
                latest.set(key, count);
        }
        for (const snapshot of snapshots)
            if (!latest.has(String(snapshot._id)))
                throw validationError('Còn mốc chưa có kết quả đếm');
        for (const locationId of header.scopeLocationIds)
            if (!snapshots.some(snapshot => same(snapshot.locationId, locationId))
                && !counts.some(count => same(count.locationId, locationId) && count.targetType === 'EMPTY_LOCATION' && exact(count.countedQtyBase).isZero()))
                throw validationError('Vị trí trống trong phạm vi chưa được xác nhận đã kiểm');
        // Every line sent back by "recount" needs a newer attempt before the session can be reconciled again.
        for (const row of header.recountLines) {
            const newest = latest.get(String(row.snapshotId));
            if (!newest || newest.attemptNo <= row.afterAttemptNo)
                throw validationError('Còn dòng được yêu cầu đếm lại chưa có kết quả mới');
        }
        // Every unsettled differing line needs the counter's reason for its newest attempt (user decision 23 Nov 2026).
        // Settled lines are skipped: they were posted already and setCountReason refuses them.
        const unexplained = snapshots.filter(snapshot => {
            const newest = latest.get(String(snapshot._id));
            return !header.settledLines.some(row => same(row.snapshotId, snapshot._id))
                && !exact(String(newest.countedQtyBase)).eq(String(snapshot.bookQtyBase))
                && !header.countReasons.some(row => same(row.snapshotId, snapshot._id) && same(row.countId, newest._id));
        }).length;
        if (unexplained)
            throw validationError(`Còn ${unexplained} dòng chênh lệch chưa chọn lý do`);
        header.recountLines = [];
        const selectedCounts = snapshots.map(snapshot => ({ snapshotId: snapshot._id, countId: latest.get(String(snapshot._id))._id }));
        // Differences are derived by readers from snapshots, selected counts and book quantities.
        header.selectedCounts = selectedCounts;
        header.lastReconciledBy = actor._id;
        header.lastReconciledAt = new Date();
        document.workflowStatus = 'RECONCILING';
        return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion, resultRefs: [], reason: 'Đối chiếu kiểm kê' };
    });
}

// Owner cancellation (decision 17/11/2026): allowed only before any resolution plan is approved.
// Locks are released, snapshots/counts stay as history and no stock is posted; open plans are cancelled.
const CANCELLABLE = ['PLANNED', 'COUNTING', 'RECONCILING'];
const FINAL_PLAN = ['REJECTED', 'CANCELLED', 'CLOSED'];
export function cancelStocktake(user, id, input) {
    return command(user, 'CANCEL_STOCKTAKE', 'stocktake:create', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor, operationId) => {
        const document = await scoped(actor, id, session);
        checkVersion(document, input.expectedVersion);
        if (!CANCELLABLE.includes(document.workflowStatus))
            throw validationError('Chỉ hủy được đợt chưa có phương án được duyệt');
        // Defensive for legacy data: a pending or approved plan must be decided, not cancelled with the session.
        if (document.resolutionPlans.some(plan => ['PENDING_APPROVAL', 'APPROVED', 'EXECUTED'].includes(plan.workflowStatus)))
            throw validationError('Đợt có phương án đang chờ duyệt hoặc đã duyệt; không thể hủy');
        // Adjustments already posted for approved lines cannot be undone by cancelling the session.
        if (document.header.settledLines?.length)
            throw validationError('Đợt đã duyệt xử lý chênh lệch một phần; hãy duyệt hoặc đếm lại các dòng còn lại thay vì hủy');
        const now = new Date();
        const locks = await m.StocktakeLocationLock.find({ stocktakeId: document._id, status: 'LOCKED' }).session(session);
        for (const lock of locks) {
            lock.status = 'RELEASED';
            lock.releasedBy = actor._id;
            lock.releasedAt = now;
            lock.closureReferenceId = operationId;
            await saveVersion(lock, lock.version, session);
        }
        for (const plan of document.resolutionPlans)
            if (!FINAL_PLAN.includes(plan.workflowStatus)) {
                plan.workflowStatus = 'CANCELLED';
                plan.cancelledBy = actor._id;
                plan.cancelledAt = now;
                plan.cancelReason = input.reason;
            }
        document.workflowStatus = 'CANCELLED';
        document.cancelledBy = actor._id;
        document.cancelledAt = now;
        document.cancelReason = input.reason;
        return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion, reason: input.reason };
    });
}
