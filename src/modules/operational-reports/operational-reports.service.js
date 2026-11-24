import * as m from '../../models/runtime.js';
import { exact, ExactDecimal } from '../../models/model-utils.js';
import { requirePermission, requireWarehouseAccess, isOwner } from '../../shared/utils/access.js';
import { transaction, dto } from '../../shared/utils/persistence.js';
import { same } from '../../shared/utils/document-command.js';
import { remainingReservation, heldOnBalance } from '../../shared/utils/stock.js';
import { validationError, forbiddenError } from '../../shared/utils/ApiError.js';
import { currentRole } from '../../shared/utils/userRole.js';
import { effectiveQuantities } from '../sales-orders/sales-read.service.js';
// Owner-confirmed mapping (15 Nov 2026); any other role holding report:read gets no group.
const ALL_GROUPS = ['inventory', 'purchases', 'receipts', 'issues', 'sales', 'transfers', 'defects', 'returns', 'supplierReturns', 'stocktakes', 'adjustments'];
const ROLE_GROUPS = { OWNER: ALL_GROUPS, ACCOUNTANT: ['purchases', 'receipts'], WAREHOUSE: ['inventory', 'transfers', 'stocktakes', 'adjustments'] };
export const reportGroups = user => ALL_GROUPS.filter(g => (ROLE_GROUPS[currentRole(user)?.code] || []).includes(g));
const add = (map, key, qty) => map.set(key, (map.get(key) || exact('0')).plus(String(qty)));
export async function reportOptions(user) { requirePermission(user, 'report:read'); return { groups: reportGroups(user), warehouses: (await m.Warehouse.find(isOwner(user) ? {} : { _id: { $in: user.warehouseIds || [] } }).select('_id code name').lean()).map(dto) }; }
export async function operationalReport(user, query) {
    requirePermission(user, 'report:read');
    if (!reportGroups(user).includes(query.group))
        throw forbiddenError();
    if (query.warehouseId)
        requireWarehouseAccess(user, query.warehouseId);
    return transaction(async (session) => {
        const warehouses = await m.Warehouse.find(query.warehouseId ? { _id: query.warehouseId } : isOwner(user) ? {} : { _id: { $in: user.warehouseIds || [] } }).session(session).lean();
        const ids = warehouses.map(w => w._id);
        const dateFilter = { ...(query.from && { $gte: new Date(query.from) }), ...(query.to && { $lte: new Date(query.to) }) };
        const scope = { 'header.warehouseId': { $in: ids }, ...((query.from || query.to) && { createdAt: dateFilter }) };
        if (query.group === 'inventory') {
            const reportLocations = await m.WarehouseLocation.find({ warehouseId: { $in: ids } }).session(session).lean();
            const dispatches = await m.TransferDispatch.find({ 'header.sourceWarehouseId': { $in: ids } }).session(session).lean();
            const points = await m.StockHoldingPoint.find({ $or: [{ locationId: { $in: reportLocations.map(l => l._id) } }, { dispatchLineId: { $in: dispatches.flatMap(d => d.items.map(i => i._id)) } }] }).session(session).lean();
            const balances = await m.InventoryBalance.find({ holdingPointId: { $in: points.map(p => p._id) } }).session(session).lean();
            const batches = await m.ProductBatch.find({ _id: { $in: balances.map(b => b.batchId) } }).session(session).lean();
            const products = await m.Product.find({ _id: { $in: batches.map(b => b.productId) } }).session(session).lean();
            const locations = reportLocations;
            const reservations = await m.StockReservation.find({ balanceId: { $in: balances.map(b => b._id) } }).session(session).lean();
            const locks = await m.StocktakeLocationLock.find({ locationId: { $in: locations.map(l => l._id) }, status: 'LOCKED' }).session(session).lean();
            const balanceIds = balances.map(b => b._id);
            const holds = await m.DefectReport.find({ holds: { $elemMatch: { status: 'ACTIVE', 'allocations.balanceId': { $in: balanceIds } } } }).session(session).lean();
            const tasks = await m.TransferOrder.find({ workflowStatus: { $in: ['OPEN', 'DRAFT', 'PARTIAL'] }, 'items.details.sourceBalanceId': { $in: balanceIds } }).session(session).lean();
            const transactions = await m.StockTransaction.find({ sourceType: 'transfer_orders', sourceId: { $in: tasks.map(t => t._id) } }).session(session).lean();
            const pending = new Map(), covered = new Map(), moved = new Map(), holdsByBalance = new Map();
            const taskBalances = new Map();
            for (const report of holds) {
                const allocated = new Set(report.holds.filter(h => h.status === 'ACTIVE').flatMap(h => h.allocations.map(a => String(a.balanceId))));
                for (const id of allocated) {
                    if (!holdsByBalance.has(id)) holdsByBalance.set(id, []);
                    holdsByBalance.get(id).push(report);
                }
            }
            // Nested maps preserve the task/line/balance identity used by stock helpers.
            for (const tx of transactions) {
                const taskId = String(tx.sourceId);
                if (!moved.has(taskId)) moved.set(taskId, new Map());
                const lines = moved.get(taskId);
                for (const movement of tx.movements) {
                    const lineId = String(movement.sourceLineId);
                    if (!lines.has(lineId)) lines.set(lineId, new Map());
                    add(lines.get(lineId), String(movement.fromBalanceId), movement.quantityBase);
                }
            }
            for (const task of tasks) {
                const taskId = String(task._id), sources = new Set();
                taskBalances.set(taskId, sources);
                for (const item of task.items) {
                    const id = String(item.details?.sourceBalanceId);
                    sources.add(id);
                    const actual = moved.get(taskId)?.get(String(item._id))?.get(id) || exact('0');
                    add(pending, id, exact(item.qtyBase).minus(actual));
                }
            }
            const reserved = new Map();
            for (const r of reservations) {
                const id = String(r.balanceId), remaining = remainingReservation(r);
                add(reserved, id, remaining);
                if (r.executionRef?.documentType === 'transfer_orders' && taskBalances.get(String(r.executionRef.documentId))?.has(id))
                    add(covered, id, remaining);
            }
            const index = rows => new Map(rows.map(row => [String(row._id), row]));
            const pointById = index(points), batchById = index(batches), productById = index(products), locationById = index(locations), warehouseById = index(warehouses);
            const frozenLocations = new Set(locks.map(l => String(l.locationId)));
            const dispatchByLine = new Map(dispatches.flatMap(d => d.items.map(i => [String(i._id), d])));
            const rows = [];
            for (const b of balances) {
                const id = String(b._id), point = pointById.get(String(b.holdingPointId)), batch = batchById.get(String(b.batchId)), product = productById.get(String(batch?.productId)), location = locationById.get(String(point?.locationId));
                const qty = exact(b.quantityBase), held = heldOnBalance(holdsByBalance.get(id) || [], b._id), booked = reserved.get(id) || exact('0'), unreserved = ExactDecimal.max('0', (pending.get(id) || exact('0')).minus(covered.get(id) || '0')), transit = point?.type === 'IN_TRANSIT';
                const frozen = frozenLocations.has(String(location?._id));
                // Reservation-backed tasks are counted only once.
                const available = !transit && !frozen && b.ownerType === 'STORE' && b.qualityStatus === 'GOOD' && batch?.identificationStatus === 'VERIFIED' && product?.isActive && location?.isActive && location?.isPickable ? ExactDecimal.max('0', qty.minus(booked).minus(held).minus(unreserved)) : exact('0');
                rows.push({ id: String(b._id), warehouseId: String(location?.warehouseId || dispatchByLine.get(String(point?.dispatchLineId))?.header.sourceWarehouseId || ''), warehouse: warehouseById.get(String(location?.warehouseId))?.name || '', location: location?.code || 'Đang chuyển', product: product?.name || '', sku: product?.sku || '', batch: batch?.manufacturerLot || '', unit: product?.baseUnit || '', quality: b.qualityStatus, owner: b.ownerType, physicalQtyBase: transit ? '0' : qty.toFixed(), transitQtyBase: transit ? qty.toFixed() : '0', ownedQtyBase: b.ownerType === 'STORE' ? qty.toFixed() : '0', custodyQtyBase: b.ownerType === 'STORE' ? '0' : qty.toFixed(), reservedQtyBase: booked.toFixed(), heldQtyBase: held.toFixed(), availableQtyBase: available.toFixed(), frozen });
            }
            return { group: query.group, capturedAt: new Date().toISOString(), basis: 'CURRENT_TRANSACTION_SNAPSHOT', rows };
        }
        const models = { purchases: m.PurchaseOrder, transfers: m.WarehouseTransferRequest, defects: m.DefectReport, returns: m.CustomerReturn, supplierReturns: m.SupplierReturn, stocktakes: m.Stocktake, adjustments: m.StockAdjustment };
        if (query.group === 'sales') {
            const requests = await m.WarehouseIssueRequest.find({ 'header.requestedWarehouseId': { $in: ids } }).session(session).lean();
            const orders = await m.SalesOrder.find({ _id: { $in: requests.map(r => r.header.salesOrderId) }, ...((query.from || query.to) && { createdAt: dateFilter }) }).session(session).lean();
            const scopedIssues=await m.SalesGoodsIssue.find({'header.warehouseId':{$in:ids},'items.salesOrderItemId':{$in:orders.flatMap(o=>o.items.map(i=>i._id))}}).session(session).lean();
            return { group: query.group, capturedAt: new Date().toISOString(), rows: orders.map(o => ({ id: String(o._id), documentNo: o.documentNo, status: o.workflowStatus, createdAt: o.createdAt, deliveredPendingPayment: o.workflowStatus === 'DELIVERED', items: o.items.filter(i => requests.some(r => same(r.header.salesOrderId, o._id) && r.items.some(x => same(x.details.salesOrderLineId, i._id)))).map(i => {
                const issuedLines=scopedIssues.flatMap(d=>d.items).filter(x=>same(x.salesOrderItemId,i._id));
                const received=(o.deliveryConfirmations||[]).filter(c=>c.workflowStatus==='CONFIRMED').flatMap(c=>c.items).filter(c=>issuedLines.some(x=>same(x._id,c.details.salesIssueLineId))).reduce((n,c)=>n.plus(String(c.qtyBase)),exact('0'));
                return { product: i.productNameSnapshot, qtyBase: String(i.qtyBase), unit: i.baseUnitSnapshot,customerReceivedQtyBase:received.toFixed() };
            }) })) };
        }
        if (query.group === 'receipts')
            models.receipts = m.GoodsReceipt;
        if (query.group === 'issues')
            models.issues = m.DeliveryOrder;
        const Model = models[query.group];
        if (!Model)
            throw validationError('Nhóm báo cáo không hợp lệ');
        const filter = query.group === 'transfers' ? { $or: [{ 'header.sourceWarehouseId': { $in: ids } }, { 'header.destinationWarehouseId': { $in: ids } }], ...((query.from || query.to) && { createdAt: dateFilter }) } : scope;
        const documents = await Model.find(filter).session(session).lean();
        const receipts = query.group === 'purchases' ? await m.PurchaseReceipt.find({ 'header.purchaseOrderId': { $in: documents.map(d => d._id) }, workflowStatus: 'POSTED' }).session(session).lean() : [];
        const issues=query.group==='issues'?await m.SalesGoodsIssue.find({'header.deliveryOrderId':{$in:documents.map(d=>d._id)},workflowStatus:'POSTED'}).session(session).lean():[];
        const failed=query.group==='issues'?await m.FailedDeliveryReceipt.find({'items.details.salesIssueLineId':{$in:issues.flatMap(d=>d.items.map(i=>i._id))},workflowStatus:'POSTED'}).session(session).lean():[];
        const postedReceipts = await effectiveQuantities(receipts, session);
        const postedIssues=await effectiveQuantities(issues,session),postedReturns=await effectiveQuantities(failed,session);
        return { group: query.group, capturedAt: new Date().toISOString(), rows: documents.map(d => ({ id: String(d._id), documentNo: d.documentNo, kind: d.documentKind, status: d.workflowStatus, warehouseId: String(d.header?.warehouseId || d.header?.sourceWarehouseId || ''), createdAt: d.createdAt, items: d.items.map(i => {
            const result={product:i.productNameSnapshot,qtyBase:String(i.qtyBase),unit:i.baseUnitSnapshot};
            if(query.group==='purchases'){
                const received=receipts.flatMap(r=>r.items).filter(x=>same(x.purchaseOrderItemId,i._id)).reduce((n,x)=>n.plus(postedReceipts.get(String(x._id)) || '0'),exact('0'));
                Object.assign(result,{receivedQtyBase:received.toFixed(),outstandingQtyBase:d.workflowStatus==='CANCELLED'?'0':ExactDecimal.max(0,exact(i.qtyBase).minus(received).minus(String(i.cancelledRemainderQtyBase??'0'))).toFixed()});
            }
            if(query.group==='issues'){
                const lines=issues.flatMap(d=>d.items).filter(x=>same(x.details.outboundDeliveryLineId,i._id));
                const issued=lines.reduce((n,x)=>n.plus(postedIssues.get(String(x._id))||'0'),exact('0'));
                const returned=failed.flatMap(r=>r.items).filter(x=>lines.some(l=>same(l._id,x.details.salesIssueLineId))).reduce((n,x)=>n.plus(postedReturns.get(String(x._id))||'0'),exact('0'));
                Object.assign(result,{grossIssuedQtyBase:issued.toFixed(),returnedQtyBase:returned.toFixed(),outstandingQtyBase:d.workflowStatus==='CANCELLED'?'0':ExactDecimal.max(0,exact(i.qtyBase).minus(issued)).toFixed()});
            }
            return result;
        }) })) };
    });
}
