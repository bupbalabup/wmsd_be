import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { command, checkVersion, saveVersion, same } from '../../shared/utils/document-command.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { sourceContext, beginStock, receiveStock, splitPortions, retainPortions, remainingReservation, verifyCapacity, heldQuantity } from '../../shared/utils/stock.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import { scoped } from './stocktake-commands.service.js';

// Simplified reconciliation (user decision 22 Nov 2026 following lecturer feedback). After the counter
// reconciles (RECONCILING) the Owner either sends lines back for recounting or approves differences
// ("Clear Difference", UC-93). There is no resolution plan, no execution record and no closing reason.
const FINAL_PLAN = ['REJECTED', 'CANCELLED', 'CLOSED'];
// Sessions created before 22 Nov 2026 may still sit in the retired plan states; recount lets the Owner pull them back.
const RECOUNTABLE = ['RECONCILING', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS'];

const countKey = row => String(row.snapshotId);
function latestCounts(counts) {
    const latest = new Map();
    for (const count of counts) {
        if (!count.snapshotId)
            continue;
        const current = latest.get(countKey(count));
        if (!current || count.attemptNo > current.attemptNo)
            latest.set(countKey(count), count);
    }
    return latest;
}

export function recountStocktake(user, id, input) {
    return command(user, 'RECOUNT_STOCKTAKE_LINES', 'stocktake:create', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor) => {
        const document = await scoped(actor, id, session);
        checkVersion(document, input.expectedVersion);
        if (!RECOUNTABLE.includes(document.workflowStatus))
            throw validationError('Chỉ yêu cầu đếm lại khi đợt đã đối chiếu và chưa hoàn tất');
        const header = document.header;
        const scope = { stocktakeId: document._id, scopeVersion: header.scopeVersion };
        const snapshotIds = [...new Set(input.snapshotIds.map(String))];
        const snapshots = await m.StocktakeSnapshot.find({ ...scope, _id: { $in: snapshotIds } }).select('_id').session(session);
        if (snapshots.length !== snapshotIds.length)
            throw validationError('Dòng đếm lại không thuộc đợt hoặc phiên bản phạm vi hiện tại');
        if (snapshotIds.some(snapshotId => header.settledLines.some(row => same(row.snapshotId, snapshotId))))
            throw validationError('Dòng đã được duyệt xử lý chênh lệch; không thể đếm lại');
        const latest = latestCounts(await m.StocktakeCount.find(scope).session(session));
        const now = new Date();
        header.recountLines = snapshotIds.map(snapshotId => ({
            snapshotId,
            afterAttemptNo: latest.get(snapshotId)?.attemptNo ?? 0,
            requestedBy: actor._id,
            requestedAt: now,
            ...(input.note && { note: input.note }),
        }));
        // Resolution plans of a retired session stay as history; nothing was posted by approval or execution records.
        for (const plan of document.resolutionPlans)
            if (!FINAL_PLAN.includes(plan.workflowStatus)) {
                plan.workflowStatus = 'CANCELLED';
                plan.cancelledBy = actor._id;
                plan.cancelledAt = now;
                plan.cancelReason = `Đếm lại: ${input.note ?? 'Owner yêu cầu đếm lại'}`;
            }
        header.selectedCounts = [];
        header.lastReconciledAt = null;
        header.lastReconciledBy = null;
        document.workflowStatus = 'COUNTING';
        return {
            document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion,
            auditChanges: [{ field: 'recountSnapshotIds', after: snapshotIds }], resultRefs: [], reason: input.note ?? 'Yêu cầu đếm lại',
        };
    });
}

// Approve/Clear Difference. The balance moves from the frozen book to the counted quantity through the same
// receive/shrink stock primitives the old close used, in one transaction with the ledger, balances and the
// StockAdjustment history record. Each line is settled once (header.settledLines), so a retry or a second click
// cannot post it again.
export function approveStocktakeDifferences(user, id, input) {
    return command(user, 'CLOSE_STOCKTAKE', 'stock_adjustment:post', id, input, (sid, actor, session) => scoped(actor, sid, session), async (session, actor, operationId) => {
        const document = await scoped(actor, id, session);
        checkVersion(document, input.expectedVersion);
        if (document.workflowStatus !== 'RECONCILING')
            throw validationError('Đợt chưa đối chiếu hoặc đang đếm lại; chưa thể duyệt chênh lệch');
        const header = document.header;
        const scope = { stocktakeId: document._id, scopeVersion: header.scopeVersion };
        const locks = await m.StocktakeLocationLock.find({ ...scope, status: 'LOCKED' }).session(session);
        const locations = header.scopeLocationIds;
        if (!locations.length || locks.length !== locations.length || locations.some(locationId => !locks.some(lock => same(lock.locationId, locationId))))
            throw validationError('Phạm vi khóa không đầy đủ');
        // Serialize against every physical-stock writer before checking frozen balances.
        for (const locationId of locations) {
            const location = await m.WarehouseLocation.findOneAndUpdate({ _id: locationId, warehouseId: header.warehouseId, isActive: true }, { $inc: { operationVersion: 1 } }, { session });
            if (!location)
                throw validationError('Vị trí không hoạt động hoặc sai kho');
        }
        const snapshots = await m.StocktakeSnapshot.find(scope).session(session);
        const counts = await m.StocktakeCount.find(scope).session(session);
        if (!header.lastReconciledAt || header.selectedCounts?.length !== snapshots.length)
            throw validationError('Kết quả đếm chưa được đối chiếu hoặc đã thay đổi');
        const settledIds = new Set(header.settledLines.map(countKey));
        const unsettled = snapshots.filter(snapshot => !settledIds.has(String(snapshot._id)));
        const latest = latestCounts(counts);
        // The reconciled selection must still be the newest attempt of every line.
        const countOf = new Map();
        for (const snapshot of snapshots) {
            const chosen = header.selectedCounts.find(row => same(row.snapshotId, snapshot._id));
            const count = chosen && counts.find(row => same(row._id, chosen.countId) && same(row.snapshotId, snapshot._id));
            if (!count || latest.get(String(snapshot._id))?._id.toString() !== count._id.toString())
                throw validationError('Thiếu kết quả hoặc có lần đếm mới cần đối chiếu lại');
            countOf.set(String(snapshot._id), count);
        }
        const diffOf = snapshot => exact(String(countOf.get(String(snapshot._id)).countedQtyBase)).minus(String(snapshot.bookQtyBase));

        const annotations = new Map();
        for (const line of input.lines ?? []) {
            if (annotations.has(line.snapshotId))
                throw validationError('Dòng được chọn trùng lặp');
            annotations.set(line.snapshotId, line);
        }
        if (!input.all && !annotations.size)
            throw validationError('Chọn ít nhất một dòng chênh lệch hoặc chọn tất cả');
        const requested = input.all ? unsettled.map(snapshot => String(snapshot._id)) : [...annotations.keys()];
        for (const snapshotId of [...annotations.keys()])
            if (!snapshots.some(snapshot => same(snapshot._id, snapshotId)))
                throw validationError('Dòng không thuộc đợt hoặc phiên bản phạm vi hiện tại');
        for (const snapshotId of requested)
            if (settledIds.has(snapshotId))
                throw validationError('Dòng đã được duyệt trước đó');
        const selectedIds = new Set(requested);
        // When no unselected line still differs, the remaining matching lines are closed with the last approval.
        if (!unsettled.some(snapshot => !selectedIds.has(String(snapshot._id)) && !diffOf(snapshot).isZero()))
            for (const snapshot of unsettled)
                selectedIds.add(String(snapshot._id));
        const selected = unsettled.filter(snapshot => selectedIds.has(String(snapshot._id)));
        // A slip whose scope holds only confirmed-empty locations has no snapshot line: "all" goes straight to completion,
        // which re-verifies every empty location below.
        if (!selected.length && !(input.all && !snapshots.length))
            throw validationError('Không có dòng nào để duyệt');
        for (const entry of input.packaging ?? [])
            if (!selected.some(snapshot => same(snapshot._id, entry.lineId)))
                throw validationError('Quy cách nhập thuộc dòng không nằm trong các dòng được duyệt');
        // Separation of duties: the approver cannot clear differences of lines they counted themselves.
        if (selected.some(snapshot => same(countOf.get(String(snapshot._id)).countedBy, actor._id)))
            throw validationError('Người đếm không được tự duyệt chênh lệch của chính mình');

        const contexts = new Map();
        for (const snapshot of selected) {
            if (!snapshot.sourceBalanceId)
                throw validationError('Dòng phát hiện cần được đối chiếu với nhóm tồn trước khi duyệt');
            const ctx = await sourceContext(snapshot.sourceBalanceId, session);
            if (!same(ctx.location?._id, snapshot.locationId) || !same(ctx.batch._id, snapshot.batchId) || ctx.balance.ownerType !== snapshot.ownerType || String(ctx.balance.ownerId ?? '') !== String(snapshot.ownerId ?? '') || ctx.balance.qualityStatus !== snapshot.qualityStatus || !exact(ctx.balance.quantityBase).eq(String(snapshot.bookQtyBase)) || (snapshot.sourceBalanceVersion != null && ctx.balance.version !== snapshot.sourceBalanceVersion))
                throw validationError('Số dư không còn khớp mốc kiểm kê');
            if ((await heldQuantity(ctx.balance._id, session)).gt(0))
                throw validationError('Còn phần hàng bị chặn chưa xử lý; giữ khóa kiểm kê');
            contexts.set(String(snapshot._id), ctx);
        }

        const now = new Date();
        const settled = [];
        let posting, adjustment;
        for (const snapshot of selected) {
            const count = countOf.get(String(snapshot._id)), delta = diffOf(snapshot), ctx = contexts.get(String(snapshot._id));
            const note = annotations.get(String(snapshot._id));
            const row = {
                snapshotId: snapshot._id, countId: count._id, outcome: delta.isZero() ? 'MATCHED' : 'POSTED', deltaQtyBase: delta.toFixed(),
                baseUnitSnapshot: snapshot.baseUnitSnapshot, ...(note?.reasonCode && { reasonCode: note.reasonCode }), ...(note?.reasonNote && { reasonNote: note.reasonNote }),
                settledBy: actor._id, settledAt: now,
            };
            settled.push(row);
            if (delta.isZero())
                continue;
            if (ctx.product.wholeBaseUnits && !delta.isInteger())
                throw validationError('Lượng điều chỉnh phải nguyên theo đơn vị gốc');
            if (note?.reasonCode === 'OTHER' && !note.reasonNote)
                throw validationError('Lý do "Khác" cần ghi chú cụ thể');
            posting ??= beginStock(document, actor, 'STOCKTAKE_CLOSE', input);
            adjustment ??= new m.StockAdjustment({ ...await nextDocumentFields(m.StockAdjustment, 'ADJ', header.warehouseId, session), workflowStatus: 'POSTED', version: 1, createdBy: actor._id, postedBy: actor._id, postedAt: now, stockTransactionId: posting._id, header: { stocktakeId: document._id, warehouseId: header.warehouseId }, items: [] });
            row.adjustmentId = adjustment._id;
            const quantity = delta.abs().toFixed(), unit = snapshot.baseUnitSnapshot || ctx.product.baseUnit;
            // The synthetic source carries the product and the base unit; the counted line keeps lot, quality and owner through the balance.
            const item = copyItem({ lineNo: adjustment.items.length + 1, productId: ctx.product._id, lotId: ctx.batch._id, enteredUnit: unit, baseUnitSnapshot: unit, baseUnitsPerUnit: '1', qtyBase: quantity, productNameSnapshot: ctx.product.name }, quantity, {
                lineKind: 'ADJUSTMENT', details: { countId: count._id, deltaQty: delta.toFixed() }, snapshotIds: [snapshot._id], countIds: [count._id],
                stockBalanceId: ctx.balance._id, quantityDeltaBase: delta.toFixed(), reason: note?.reasonCode ? [note.reasonCode, note.reasonNote].filter(Boolean).join(': ') : 'Duyệt chênh lệch kiểm kê', sources: [sourceLink(document)],
            });
            const balance = await m.InventoryBalance.findById(ctx.balance._id).session(session), before = exact(balance.quantityBase);
            if (delta.gt(0)) {
                const portions = input.packaging?.find(entry => same(entry.lineId, snapshot._id))?.portions;
                await receiveStock(balance, item, portions, posting, actor, session);
            }
            else {
                // A counted shortfall that is not whole cartons proves a carton was opened (decision 18/11/2026):
                // open one carton like goods issues do; loose/open portions are consumed first.
                const { kept } = splitPortions(balance.packagingPortions, delta.abs(), actor._id, { allowOpening: true });
                // Update the existing portions in place: reassigning plain objects would rewrite immutable createdAt.
                retainPortions(balance, kept);
                balance.quantityBase = before.plus(delta).toFixed();
                await saveVersion(balance, balance.version, session);
                posting.movements.push({ transactionId: posting._id, lineNo: posting.movements.length + 1, sourceLineId: item._id, fromBalanceId: balance._id, quantityBase: quantity, fromBefore: before.toFixed(), fromAfter: balance.quantityBase });
            }
            item.beforeQty = before.toFixed();
            item.afterQty = before.plus(delta).toFixed();
            adjustment.items.push(item);
        }
        if (posting) {
            await verifyCapacity(selected.map(snapshot => contexts.get(String(snapshot._id)).location._id), session);
            if (posting.movements.length)
                await posting.save({ session });
            await adjustment.save({ session });
        }
        for (const snapshot of selected) {
            const balance = await m.InventoryBalance.findById(snapshot.sourceBalanceId).session(session);
            const reserved = await m.StockReservation.find({ balanceId: balance._id }).session(session);
            if (reserved.reduce((total, reservation) => total.plus(remainingReservation(reservation)), exact('0')).gt(String(balance.quantityBase)))
                throw validationError('Tồn sau chốt thấp hơn lượng đã giữ');
        }
        header.settledLines.push(...settled);
        const complete = header.settledLines.length === snapshots.length;
        const closureId = posting?.movements.length ? posting._id : operationId;
        if (complete) {
            for (const locationId of locations)
                if (!snapshots.some(snapshot => same(snapshot.locationId, locationId)) && !counts.some(count => same(count.locationId, locationId) && count.targetType === 'EMPTY_LOCATION' && exact(count.countedQtyBase).isZero()))
                    throw validationError('Ô trống chưa được xác nhận đã kiểm');
            document.tenLoaiPhieu = 'Đợt kiểm kê';
            document.workflowStatus = 'COMPLETED';
            header.completedAt = now;
            header.closedBy = actor._id;
            header.closureReferenceId = closureId;
            for (const lock of locks) {
                lock.status = 'RELEASED';
                lock.releasedBy = actor._id;
                lock.releasedAt = now;
                lock.closureReferenceId = closureId;
                await saveVersion(lock, lock.version, session);
            }
        }
        return {
            document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion,
            stockTransactionId: posting?.movements.length ? posting._id : undefined, reason: 'Duyệt chênh lệch kiểm kê',
            auditChanges: [{ field: 'settledSnapshotIds', after: settled.map(row => String(row.snapshotId)) }],
            resultRefs: adjustment ? [{ documentType: 'stock_adjustments', documentId: adjustment._id }] : [],
        };
    });
}
