import * as m from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { checkBinCapacity } from '../../models/capacity.js';
import { dto } from '../../shared/utils/persistence.js';
import { command, scopedDocument, same, checkVersion, saveVersion, newId } from '../../shared/utils/document-command.js';
import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { requirePermission, requireWarehouseAccess, isOwner } from '../../shared/utils/access.js';
import { validationError, forbiddenError } from '../../shared/utils/ApiError.js';
import { guardWarehouses, guardLocations, beginStock, balanceAt, receiveStock, verifyCapacity } from '../../shared/utils/stock.js';
import { appendAudit } from '../../shared/utils/audit.js';
import { syncAreaConversions, syncLotConversions } from '../../shared/utils/conversions.js';

const replay = (id, user, session) => { allowed(user, 'opening_stock:read'); return scopedDocument(m.OpeningStock, id, user, session); };
function portionFor(item) {
  return { packagingState: item.packagingState, quantityBase: String(item.qtyBase), packagingSnapshot: item.packagingSnapshot,
    ...(item.packagingState === 'SEALED' ? { sealedPackCount: exact(item.qtyBase).div(String(item.packagingSnapshot.baseUnitsPerPackage)).toNumber() } : { measuredVolumeMm3: item.measuredVolumeMm3 }) };
}
function allowed(user, permission) {
  requirePermission(user, permission);
  if (!isOwner(user)) throw forbiddenError();
}
export async function options(user) {
  allowed(user, 'opening_stock:read');
  const posted = await m.OpeningStock.find({ workflowStatus: 'POSTED' }).select('header.warehouseId').lean();
  return {
    warehouses: (await m.Warehouse.find({ isActive: true }).select('_id code name').lean()).map(row => ({ ...dto(row), initialized: posted.some(document => same(document.header.warehouseId, row._id)) })),
    categories: (await m.Category.find({ isActive: { $ne: false } }).select('_id code name').lean()).map(dto),
    units: (await m.Uom.find({ isActive: { $ne: false } }).select('_id code name').lean()).map(dto),
  };
}
export async function list(user) {
  allowed(user, 'opening_stock:read');
  const rows = await m.OpeningStock.find(isOwner(user) ? {} : { 'header.warehouseId': { $in: user.warehouseIds || [] } }).sort({ createdAt: -1 }).lean();
  return { items: rows.map(dto), total: rows.length };
}
export async function get(user, id) {
  allowed(user, 'opening_stock:read');
  const document = dto(await replay(id, user));
  const [products, batches, locations, warehouse] = await Promise.all([
    m.Product.find({ _id: { $in: document.items.map(i => i.productId) } }).select('_id sku').lean(),
    m.ProductBatch.find({ _id: { $in: document.items.map(i => i.lotId) } }).select('_id manufacturerLot').lean(),
    m.WarehouseLocation.find({ warehouseId: document.header.warehouseId }).select('_id code name').lean(),
    m.Warehouse.findById(document.header.warehouseId).select('code name').lean(),
  ]);
  return { ...document, header: { ...document.header, warehouseName: warehouse?.name }, items: document.items.map(item => ({ ...item,
    sku: products.find(p => same(p._id, item.productId))?.sku,
    manufacturerLot: batches.find(b => same(b._id, item.lotId))?.manufacturerLot,
    locationCode: locations.find(l => same(l._id, item.locationId))?.code,
  })) };
}

async function unusedWarehouse(user, warehouseId, session, lock = false) {
  requireWarehouseAccess(user, warehouseId);
  if (lock) await guardWarehouses([warehouseId], session);
  const warehouse = await m.Warehouse.findOne({ _id: warehouseId, isActive: true }).session(session);
  if (!warehouse) throw validationError('Kho không tồn tại hoặc đã ngừng hoạt động.');
  const locations = await m.WarehouseLocation.find({ warehouseId }).session(session);
  if (lock) await guardLocations(locations.filter(l => l.isActive).map(l => l._id), session);
  if (await m.OpeningStock.exists({ 'header.warehouseId': warehouseId, workflowStatus: 'POSTED' }).session(session)) throw validationError('Kho đã khởi tạo tồn đầu kỳ. Không được cộng tồn lần nữa.');
  const dispatches = await m.TransferDispatch.find({ 'header.sourceWarehouseId': warehouseId }).select('items._id').session(session);
  const points = await m.StockHoldingPoint.find({ $or: [{ locationId: { $in: locations.map(l => l._id) } }, { dispatchLineId: { $in: dispatches.flatMap(d => d.items.map(i => i._id)) } }] }).select('_id').session(session);
  if (await m.InventoryBalance.exists({ holdingPointId: { $in: points.map(p => p._id) } }).session(session)) throw validationError('Kho đã có dữ liệu tồn. Hãy dùng kiểm kê hoặc chứng từ sửa sai.');
  if (await m.StocktakeLocationLock.exists({ locationId: { $in: locations.map(l => l._id) }, status: 'LOCKED' }).session(session)) throw validationError('Kho đang khóa kiểm kê.');
  return locations;
}

// Resolve only explicit catalogue identities. Preview never writes to the database.
async function resolveRows(user, input, session, persist = false) {
  if (new Date(input.openingAt) > new Date()) throw validationError('Mốc tồn đầu không được ở tương lai.');
  const locations = await unusedWarehouse(user, input.warehouseId, session);
  const rows = [], errors = [], products = new Map(), batches = new Map();
  for (const [index, row] of input.rows.entries()) {
    try {
      const location = locations.find(l => l.code === row.locationCode && l.isActive);
      if (!location) throw validationError('Mã vị trí không thuộc kho đang hoạt động.');
      if (row.qualityStatus === 'DAMAGED' && location.locationType !== 'QUARANTINE') throw validationError('Hàng hỏng phải ở vị trí cách ly.');
      const identity = { sku: row.sku, manufacturerCode: row.manufacturerCode, color: row.color };
      const productKey = JSON.stringify(identity);
      let product = products.get(productKey) || await m.Product.findOne(identity).collation({ locale: 'vi', strength: 2 }).session(session);
      let newProduct = false;
      if (!product) {
        requirePermission(user, 'product:create');
        const category = await m.Category.findOne({ code: row.categoryCode, isActive: { $ne: false } }).session(session);
        const unit = await m.Uom.findOne({ code: row.baseUnit, isActive: { $ne: false } }).session(session);
        if (!category || !unit) throw validationError('Sản phẩm mới cần mã nhóm và đơn vị gốc đang hoạt động.');
        product = new m.Product({ ...identity, name: row.name, categoryId: category._id, baseUnit: unit.code,
          lengthMm: row.lengthMm, widthMm: row.widthMm, heightMm: row.heightMm, wholeBaseUnits: row.wholeBaseUnits !== 'false', isActive: true });
        await product.validate();
        newProduct = true;
        if (persist) {
          await product.save({ session });
          await syncAreaConversions(product, user, session);
          await appendAudit({ actorId: user._id, action: 'IMPORT_PRODUCT', entityType: 'products', entityId: product._id, session });
        }
      }
      if (!product.isActive) throw validationError('Sản phẩm đã ngừng hoạt động.');
      if (row.wholeBaseUnits && product.wholeBaseUnits !== (row.wholeBaseUnits === 'true')) throw validationError('Quy tắc nguyên đơn vị gốc khác danh mục.');
      for (const field of ['baseUnit', 'lengthMm', 'widthMm', 'heightMm']) {
        if (row[field] && String(product[field]) !== row[field] && (field === 'baseUnit' || !exact(product[field]).eq(row[field]))) throw validationError('Thông số sản phẩm trong file khác danh mục: ' + field);
      }
      products.set(productKey, product);
      const batchKey = String(product._id) + ':' + row.manufacturerLot;
      let batch = batches.get(batchKey) || (!newProduct && await m.ProductBatch.findOne({ productId: product._id, manufacturerLot: row.manufacturerLot }).session(session));
      let newBatch = false;
      if (!batch) {
        requirePermission(user, 'product_lot:create');
        batch = new m.ProductBatch({ productId: product._id, manufacturerLot: row.manufacturerLot, identificationStatus: 'VERIFIED',
          piecesPerCarton: Number(row.piecesPerCarton), cartonLengthMm: row.cartonLengthMm, cartonWidthMm: row.cartonWidthMm, cartonHeightMm: row.cartonHeightMm });
        await batch.validate(); newBatch = true;
        if (persist) {
          await batch.save({ session }); await syncLotConversions(batch, product, user, session);
          await appendAudit({ actorId: user._id, action: 'IMPORT_BATCH', entityType: 'product_batches', entityId: batch._id, session });
        }
      }
      if (batch.identificationStatus !== 'VERIFIED') throw validationError('Lô chưa xác minh.');
      for (const field of ['piecesPerCarton', 'cartonLengthMm', 'cartonWidthMm', 'cartonHeightMm']) {
        if (row[field] && !exact(String(batch[field])).eq(row[field])) throw validationError('Quy cách lô trong file khác danh mục: ' + field);
      }
      batches.set(batchKey, batch);
      // Files use base units or complete cartons; never round area into additional stock.
      const unit = await m.Uom.findOne({ code: row.enteredUnit, isActive: { $ne: false } }).session(session);
      if (!unit || (unit.code !== product.baseUnit && !unit.isCarton)) throw validationError('Tồn đầu chỉ nhận đơn vị gốc hoặc đơn vị thùng đã cấu hình.');
      const factor = unit.code === product.baseUnit ? exact('1') : exact(String(batch.piecesPerCarton));
      const qty = exact(row.enteredQty).mul(factor);
      if (qty.gte('100000000000000') || qty.decimalPlaces() > 6 || (product.wholeBaseUnits && !qty.isInteger())) throw validationError('Số lượng phải quy đổi chính xác, không tạo viên phân số.');
      if (row.packagingState === 'SEALED' && !qty.mod(String(batch.piecesPerCarton)).isZero()) throw validationError('Hàng nguyên thùng cần đủ số viên mỗi thùng.');
      if (row.packagingState !== 'SEALED' && (!/^\d{1,14}(\.\d{1,3})?$/.test(row.measuredVolumeMm3 || '') || !exact(row.measuredVolumeMm3).gt(0))) throw validationError('Hàng mở/lẻ cần thể tích thực đo (mm³).');
      rows.push({ rowNumber: index + 2, sku: product.sku, product: product.name, batch: batch.manufacturerLot, location: location.code,
        quantityBase: qty.toFixed(), unit: product.baseUnit, newProduct, newBatch,
        item: { _id: newId(), lineNo: index + 1, lineKind: 'STANDARD', productId: product._id, lotId: batch._id,
          productNameSnapshot: product.name, enteredUnit: unit.code, baseUnitSnapshot: product.baseUnit, baseUnitsPerUnit: factor.toFixed(),
          enteredQty: row.enteredQty, qtyBase: qty.toFixed(), packagingSnapshot: { packageUnit: 'Thùng', baseUnitsPerPackage: String(batch.piecesPerCarton), outerLengthMm: batch.cartonLengthMm, outerWidthMm: batch.cartonWidthMm, outerHeightMm: batch.cartonHeightMm },
          locationId: location._id, ownerType: 'STORE', qualityStatus: row.qualityStatus,
          packagingState: row.packagingState, measuredVolumeMm3: row.measuredVolumeMm3 || undefined } });
    } catch (error) {
      if (persist) throw error;
      if (![400, 403, 409, 422].includes(error.statusCode ?? error.status) && error.name !== 'ValidationError') throw error;
      errors.push({ rowNumber: index + 2, message: error.message });
    }
  }
  if (!errors.length) {
    try {
      const warehouse = await m.Warehouse.findById(input.warehouseId).session(session);
      checkBinCapacity({ warehouses: [warehouse], warehouse_locations: locations, product_batches: [...batches.values()],
        stock_holding_points: locations.map(l => ({ _id: l._id, type: 'LOCATION', locationId: l._id })),
        inventory_balances: rows.map(r => ({ holdingPointId: r.item.locationId, batchId: r.item.lotId, quantityBase: r.item.qtyBase, packagingPortions: [portionFor(r.item)] })) });
    } catch (error) {
      if (persist) throw validationError('Không đủ sức chứa hoặc thiếu quy cách: ' + error.message);
      errors.push({ rowNumber: 0, message: 'Không đủ sức chứa hoặc thiếu quy cách: ' + error.message });
    }
  }
  return { rows, errors, locations };
}
export async function preview(user, input) {
  allowed(user, 'opening_stock:create');
  const result = await resolveRows(user, input);
  return { rows: result.rows.map(({ item, ...row }) => row), errors: result.errors, valid: !result.errors.length };
}
export function create(user, input) {
  return command(user, 'CREATE_OPENING_STOCK', 'opening_stock:create', null, input, replay, async (session, actor) => {
    allowed(actor, 'opening_stock:create');
    const result = await resolveRows(actor, input, session, true);
    const document = await new m.OpeningStock({ ...await nextDocumentFields(m.OpeningStock, 'OPENING', input.warehouseId, session),
      workflowStatus: 'DRAFT', version: 1, createdBy: actor._id, occurredAt: input.openingAt,
      header: { warehouseId: input.warehouseId, cutoverKey: input.cutoverKey, openingAt: input.openingAt,
        coveredLocationIds: result.locations.map(l => l._id), sourceDescription: input.sourceDescription, preparedBy: actor._id, preparedAt: new Date() },
      items: result.rows.map(r => r.item) }).save({ session });
    return { document };
  });
}
export function act(user, id, action, input) {
  const permission = action === 'post' ? 'opening_stock:post' : 'opening_stock:create';
  return command(user, 'OPENING_STOCK_' + action.toUpperCase(), permission, id, input, replay, async (session, actor) => {
    allowed(actor, permission);
    const document = await replay(id, actor, session), before = document.version;
    checkVersion(document, input.expectedVersion);
    if (action === 'cancel') {
      if (document.workflowStatus !== 'DRAFT' || !same(document.createdBy, actor._id)) throw forbiddenError();
      Object.assign(document, { workflowStatus: 'CANCELLED', cancelledBy: actor._id, cancelledAt: new Date(), cancelReason: input.reason });
      return { document: await saveVersion(document, before, session), versionBefore: before, reason: input.reason };
    }
    if (document.workflowStatus !== 'DRAFT') throw validationError('Phiếu đã ghi tồn hoặc đã hủy; không thể ghi tồn lần nữa.');
    const locations = await unusedWarehouse(actor, document.header.warehouseId, session, true);
    if (locations.length !== document.header.coveredLocationIds.length || locations.some(l => !document.header.coveredLocationIds.some(id => same(id, l._id)))) throw validationError('Danh sách vị trí đã thay đổi; hủy nháp và nhập lại.');
    let posting;
    if (document.items.length) {
      posting = beginStock(document, actor, 'OPENING', input);
      posting.occurredAt = document.header.openingAt;
      for (const item of document.items) {
        // Revalidate identities and retain the accepted historical conversion snapshot.
        await makeItem({ productId: item.productId, lotId: item.lotId, enteredUnit: item.enteredUnit, enteredQty: String(item.enteredQty) }, item.lineNo, session, { previous: item });
        if (!locations.some(l => l.isActive && same(l._id, item.locationId))) throw validationError('Vị trí không còn hoạt động.');
        const portion = portionFor(item);
        const balance = await balanceAt({ type: 'LOCATION', locationId: item.locationId }, { batchId: item.lotId, ownerType: 'STORE' }, item.qualityStatus, session);
        await receiveStock(balance, item, [portion], posting, actor, session);
      }
      await verifyCapacity(locations.map(l => l._id), session);
      await posting.save({ session });
    }
    Object.assign(document.header, { verifiedBy: actor._id, verifiedAt: new Date(), verifiedVersion: before, verificationNote: input.reason });
    Object.assign(document, { workflowStatus: 'POSTED', postedBy: actor._id, postedAt: new Date(), stockTransactionId: posting?._id });
    return { document: await saveVersion(document, before, session), versionBefore: before, stockTransactionId: posting?._id, reason: input.reason };
  });
}
