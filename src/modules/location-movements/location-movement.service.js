import { databaseId } from '../../models/document-identity.js';
import { escapeRegex } from '../../shared/utils/domain.js';
import mongoose from 'mongoose';
import { movementList } from '../../shared/utils/movement-list.js';
import { optionFields, movementDetailFields, relocationLedgerFields } from '../../shared/utils/movement-read-fields.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { TransferOrder, Warehouse, WarehouseLocation, InventoryBalance, StockHoldingPoint, StockTransaction, ProductBatch, Product, Uom, Conversion, User } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { requirePermission, requireWarehouseAccess, isOwner } from '../../shared/utils/access.js';
import { notFoundError, validationError, forbiddenError, versionConflict } from '../../shared/utils/ApiError.js';
import { dto } from '../../shared/utils/persistence.js';
import { command, scopedDocument, checkVersion, saveVersion, newId, same } from '../../shared/utils/document-command.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { sourceContext, locationAt, guardLocations, pendingTaskQuantity, beginStock, balanceAt, moveStock, verifyCapacity, splitPortions } from '../../shared/utils/stock.js';
import { blindCountScope } from '../../shared/utils/blind-count.js';
export { pendingTaskQuantity } from '../../shared/utils/stock.js';

async function task(id, user, session) {
  const row = await scopedDocument(TransferOrder, id, user, session);
  if (row.header.taskKind !== 'RELOCATE') throw notFoundError();
  return row;
}
const replay = (id,user,session) => task(id,user,session);
// Resolve display names only after document/warehouse scope has been checked.
async function movementDisplay(documents, includeLines = false) {
  if(!documents.length)return [];
  const warehouseIds = documents.map(d=>d.header.warehouseId);
  const items = includeLines ? documents.flatMap(d=>d.items) : [];
  const [warehouses,locations,batches] = await Promise.all([
    Warehouse.find({_id:{$in:warehouseIds}}).select('_id code name').lean(),
    includeLines?WarehouseLocation.find({_id:{$in:items.flatMap(i=>[i.details.fromLocationId,i.details.toLocationId])},warehouseId:{$in:warehouseIds}}).select('_id warehouseId code name').lean():[],
    includeLines?ProductBatch.find({_id:{$in:items.map(i=>i.lotId)}}).select('_id manufacturerLot').lean():[],
  ]);
  const reference = row => row ? {id:String(row._id),code:row.code,name:row.name||null} : null;
  return documents.map(document=>({
    ...document, warehouse:reference(warehouses.find(w=>same(w._id,document.header.warehouseId))),
    ...(includeLines && {items:document.items.map(item=>({
      ...item,
      fromLocation:reference(locations.find(l=>same(l._id,item.details.fromLocationId)&&same(l.warehouseId,document.header.warehouseId))),
      toLocation:reference(locations.find(l=>same(l._id,item.details.toLocationId)&&same(l.warehouseId,document.header.warehouseId))),
      lot:batches.find(b=>same(b._id,item.lotId)) ? {id:String(item.lotId),manufacturerLot:batches.find(b=>same(b._id,item.lotId)).manufacturerLot} : null,
    }))}),
  }));
}
export async function relocationItems(user, warehouseId, input, session, excludeTaskId, previous = []) {
  const result = [], totals = new Map(), packaging = new Map();
  for (const [index, line] of input.lines.entries()) {
    const ctx = await sourceContext(line.sourceBalanceId, session);
    if (!ctx.location || !ctx.product.isActive || ctx.batch.identificationStatus !== 'VERIFIED' || !same(ctx.location.warehouseId, warehouseId)) throw validationError('Tồn nguồn không hợp lệ');
    if (ctx.balance.version !== line.sourceBalanceVersion) throw versionConflict('Tồn nguồn đã thay đổi', ctx.balance.version);
    await locationAt(line.toLocationId, warehouseId, ['RECEIVING','STORAGE','STAGING','QUARANTINE','CUSTODY'], session);
    if (same(ctx.location._id, line.toLocationId)) throw validationError('Vị trí nguồn và đích trùng nhau');
    if (typeof line.enteredQty !== 'string' || !/^\d+$/.test(line.enteredQty)) throw validationError('Số thùng hoặc viên phải là số nguyên');
    const old = previous.find(item => same(item.details.sourceBalanceId, line.sourceBalanceId) && same(item.details.toLocationId, line.toLocationId) && item.details.packagingState === line.packagingState);
    const item = await makeItem({ ...line, productId: ctx.product._id, lotId: ctx.batch._id }, index + 1, session, { lineKind: 'WAREHOUSE_TASK', previous: old });
    if (!exact(item.qtyBase).isInteger()) throw validationError('Số thùng hoặc viên phải là số nguyên');
    const portions = packaging.get(String(ctx.balance._id)) ?? ctx.balance.packagingPortions;
    const inPool = portion => !line.packagingState || portion.packagingState === line.packagingState;
    const split = splitPortions(portions.filter(inPool), item.qtyBase, user._id, { allowLooseSplit: line.packagingState === 'LOOSE' });
    const kept = new Map(split.kept.map(portion => [String(portion._id), portion]));
    packaging.set(String(ctx.balance._id), portions.flatMap(portion => inPool(portion) ? kept.has(String(portion._id)) ? [kept.get(String(portion._id))] : [] : [portion]));
    const total = (totals.get(String(ctx.balance._id)) ?? exact('0')).plus(item.qtyBase); totals.set(String(ctx.balance._id), total);
    const pending = await pendingTaskQuantity(ctx.balance._id, session, excludeTaskId);
    if (total.plus(pending).gt(String(ctx.balance.quantityBase))) throw validationError('Tồn nguồn đã được lập lệnh khác');
    result.push({ ...item, details: { sourceBalanceId: ctx.balance._id, sourceBalanceVersion: ctx.balance.version,
      fromLocationId: ctx.location._id, toLocationId: line.toLocationId, qualityCode: ctx.balance.qualityStatus,
      ownerType: ctx.balance.ownerType, ownerId: ctx.balance.ownerId, ...(line.packagingState && { packagingState: line.packagingState }) } });
  }
  await guardLocations(result.flatMap(item => [item.details.fromLocationId, item.details.toLocationId]), session);
  return result;
}
export function createLocationMovement(user, input) {
  return command(user, 'CREATE_RELOCATION', 'stock_relocation:create', null, input, replay, async (session,actor) => {
    requireWarehouseAccess(actor, input.warehouseId);
    const document = await new TransferOrder({ ...await nextDocumentFields(TransferOrder, 'TO', input.warehouseId, session), workflowStatus: 'OPEN', version: 1, createdBy: actor._id,
      header: { warehouseId: input.warehouseId, taskKind: 'RELOCATE', assignedTo: actor._id, reason: input.reason },
      items: await relocationItems(actor, input.warehouseId, input, session) }).save({ session });
    return { document };
  });
}
export async function getLocationMovement(user, id) {
  requirePermission(user, 'stock_relocation:read');
  const document = await TransferOrder.findById(id).select(movementDetailFields).lean();
  if(!document)throw notFoundError();
  requireWarehouseAccess(user,document.header.warehouseId);
  if(document.header.taskKind!=='RELOCATE')throw notFoundError();
  const [transactions,[display]] = await Promise.all([
    StockTransaction.find({ sourceType: 'transfer_orders', sourceId: id }).select(relocationLedgerFields).sort({ occurredAt: 1, _id: 1 }).lean(),
    movementDisplay([dto(document)],true),
  ]);
  const performers = transactions.length?await User.find({ _id: { $in: transactions.map(t => t.performedBy) } }).select('_id fullName').lean():[];
  return { ...display, transactions: transactions.map(t => ({ ...dto(t), performedByName: performers.find(u => same(u._id, t.performedBy))?.fullName || 'Không còn trong danh mục' })) };
}
export async function listLocationMovements(user, query) {
  requirePermission(user, 'stock_relocation:read');
  const filter = { 'header.taskKind': 'RELOCATE' };
  if (query.warehouseId) requireWarehouseAccess(user, query.warehouseId);
  if (!isOwner(user)) filter['header.warehouseId'] = { $in: user.warehouseIds || [] };
  const castQuery = { ...query, ...(query.warehouseId && { warehouseId: databaseId(query.warehouseId) }) };
  if(query.q){const regex=new RegExp(escapeRegex(query.q),'i');const [products,batches]=await Promise.all([Product.find({$or:[{sku:regex},{name:regex}]}).select('_id').lean(),ProductBatch.find({manufacturerLot:regex}).select('_id').lean()]);castQuery.searchFilter={$or:[{documentNo:regex},{'items.productNameSnapshot':regex},{'items.productId':{$in:products.map(p=>p._id)}},{'items.lotId':{$in:batches.map(b=>b._id)}}]};}
  const result = await movementList(TransferOrder, filter, castQuery, ['header.warehouseId'], 'CONFIRMED');
  return { ...result, items: await movementDisplay(result.items) };
}
export async function locationMovementOptions(user, warehouseId) {
  requirePermission(user, 'stock_relocation:create');
  const warehouses = await Warehouse.find({ isActive: true, ...(isOwner(user) ? {} : { _id: { $in: user.warehouseIds || [] } }) }).select('_id code name isActive').lean();
  if (!warehouseId) return { warehouses: warehouses.map(dto), locations: [], balances: [] };
  requireWarehouseAccess(user, warehouseId);
  const locations = await WarehouseLocation.find({ warehouseId, isActive: true }).select(optionFields.location).lean();
  const points = await StockHoldingPoint.find({ locationId: { $in: locations.map(row=>row._id) } }).select(optionFields.point).lean();
  const blind = await blindCountScope(user);
  const balances = (await InventoryBalance.find({ holdingPointId: { $in: points.map(row=>row._id) }, quantityBase: { $gt: 0 } }).select(optionFields.balance+' packagingPortions.sealedPackCount packagingPortions.quantityBase').lean()).filter(row => !blind.has(row._id));
  const batches = await ProductBatch.find({ _id: { $in: balances.map(row=>row.batchId) } }).select(optionFields.batch).lean();
  const products = await Product.find({ _id: { $in: batches.map(row=>row.productId) } }).select(optionFields.product).lean();
  const [units,conversions] = await Promise.all([Uom.find({isActive:true}).select('_id code name isCarton').lean(),
    Conversion.find({productId:{$in:products.map(p=>p._id)},validFrom:{$lte:new Date()}}).select(optionFields.conversion).sort({validFrom:-1}).lean()]);
  return { units: units.map(dto), conversions: conversions.map(dto), warehouses: warehouses.map(dto), locations: locations.map(dto), holdingPoints: points.map(dto), balances: balances.map(dto), batches: batches.map(dto), products: products.map(dto) };
}
export function editLocationMovement(user,id,input) {
  return command(user,'EDIT_RELOCATION','stock_relocation:create',id,input,replay,async(session,actor)=>{
    const document = await task(id,actor,session); checkVersion(document,input.expectedVersion);
    if (!same(document.createdBy,actor._id)) throw forbiddenError('Chỉ người lập được sửa lệnh');
    if (document.workflowStatus !== 'OPEN') throw validationError('Lệnh không còn mở');
    document.items = await relocationItems(actor,document.header.warehouseId,input,session,id,document.items);
    document.header.reason = input.reason;
    return { document: await saveVersion(document,input.expectedVersion,session), versionBefore: input.expectedVersion };
  });
}
export function cancelLocationMovement(user,id,input) {
  return command(user,'CANCEL_RELOCATION','stock_relocation:create',id,input,replay,async(session,actor)=>{
    const document = await task(id,actor,session); checkVersion(document,input.expectedVersion);
    if (!same(document.createdBy,actor._id)) throw forbiddenError('Chỉ người lập được hủy lệnh');
    if (!['OPEN', 'PARTIAL'].includes(document.workflowStatus)) throw validationError('Lệnh không còn mở');
    await guardLocations(document.items.map(item=>item.details.fromLocationId),session);
    document.workflowStatus='CANCELLED'; document.cancelReason=input.reason; document.cancelledBy=actor._id; document.cancelledAt=new Date();
    return { document:await saveVersion(document,input.expectedVersion,session),versionBefore:input.expectedVersion };
  });
}
export function confirmLocationMovement(user,id,input) {
  return command(user,'CONFIRM_RELOCATION','stock_relocation:confirm',id,input,replay,async(session,actor)=>{
    const document=await task(id,actor,session); checkVersion(document,input.expectedVersion);
    if (!same(document.createdBy,actor._id)) throw forbiddenError('Chỉ người lập được xác nhận lệnh');
    if (!['OPEN', 'PARTIAL'].includes(document.workflowStatus)) throw validationError('Lệnh không còn mở');
    if (!input.lines.length || new Set(input.lines.map(row => String(row.lineId))).size !== input.lines.length) throw validationError('Dòng xác nhận phải khác nhau');
    const previous = await StockTransaction.find({ sourceType: 'transfer_orders', sourceId: id, operation: 'RELOCATE' }).session(session);
    const moved = item => previous.flatMap(t => t.movements).filter(m => same(m.sourceLineId, item._id)).reduce((n, m) => n.plus(String(m.quantityBase)), exact('0'));
    const selected = input.lines.map(actual => {
      const item = document.items.find(i => same(i._id, actual.lineId));
      if (!item || !/^\d{1,14}$/.test(actual.actualQtyBase) || !exact(actual.actualQtyBase).gt(0) || exact(actual.actualQtyBase).gt(exact(item.qtyBase).minus(moved(item)))) throw validationError('Lượng thực chuyển phải lớn hơn 0 và không vượt phần còn lại');
      return { item, quantity: actual.actualQtyBase };
    });
    const before = await InventoryBalance.find({ _id: { $in: document.items.map(i => i.details.sourceBalanceId) } }).select('_id version').session(session);
    for (const { item } of selected) {
      const ctx = await sourceContext(item.details.sourceBalanceId, session);
      if (ctx.balance.version !== item.details.sourceBalanceVersion) throw versionConflict('Tồn đã thay đổi; hủy phần còn lại và lập lại lệnh nếu đã chuyển một phần');
      if (!same(ctx.batch._id, item.lotId) || ctx.balance.qualityStatus !== item.details.qualityCode || ctx.balance.ownerType !== item.details.ownerType || ((ctx.balance.ownerId != null || item.details.ownerId != null) && !same(ctx.balance.ownerId, item.details.ownerId))) throw validationError('Tồn không khớp lệnh');
      await locationAt(item.details.toLocationId, document.header.warehouseId, null, session);
    }
    const locations = selected.flatMap(({ item }) => [item.details.fromLocationId, item.details.toLocationId]);
    await guardLocations(locations, session);
    const posting = beginStock(document, actor, 'RELOCATE', input);
    for (const { item, quantity } of selected) {
      const ctx = await sourceContext(item.details.sourceBalanceId, session);
      const destination = await balanceAt({ type: 'LOCATION', locationId: item.details.toLocationId }, ctx.balance, ctx.balance.qualityStatus, session);
      await moveStock(ctx.balance._id, destination._id, quantity, item._id, posting, actor, session, { preserveReservations: true, excludeTaskId: id, packagingState: item.details.packagingState });
    }
    await verifyCapacity(locations, session); await posting.save({ session });
    const after = await InventoryBalance.find({ _id: { $in: before.map(b => b._id) } }).select('_id version').session(session);
    for (const item of document.items) {
      const old = before.find(b => same(b._id, item.details.sourceBalanceId));
      if (old && old.version === item.details.sourceBalanceVersion) item.details.sourceBalanceVersion = after.find(b => same(b._id, old._id)).version;
    }
    const complete = document.items.every(item => moved(item).plus(posting.movements.filter(m => same(m.sourceLineId, item._id)).reduce((n, m) => n.plus(String(m.quantityBase)), exact('0'))).eq(String(item.qtyBase)));
    document.workflowStatus = complete ? 'CONFIRMED' : 'PARTIAL';
    if (complete) { document.header.confirmedBy = actor._id; document.header.confirmedAt = new Date(); }
    document.stockTransactionId = posting._id;
    return {document:await saveVersion(document,input.expectedVersion,session),versionBefore:input.expectedVersion,stockTransactionId:posting._id};
  });
}

