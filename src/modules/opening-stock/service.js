import * as m from '../../models/runtime.js';
import { exact, ExactDecimal } from '../../models/model-utils.js';
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

async function openingReceiving(user, warehouseId, locations, session, persist) {
  const existing = locations.find(location => location.code === 'TONDAU-NHAN');
  if (existing) {
    if (existing.locationType !== 'RECEIVING' || !existing.isActive) {
      throw validationError('Mã vị trí TONDAU-NHAN đã dùng cho vị trí khác loại hoặc đã ngừng; hãy đổi mã vị trí đó.');
    }
    return existing;
  }
  const warehouse = await m.Warehouse.findById(warehouseId).select('lengthMm widthMm clearHeightMm').session(session);
  if (!warehouse?.lengthMm || !warehouse.widthMm || !warehouse.clearHeightMm) {
    throw validationError('Kho chưa khai báo dài, rộng và chiều cao; cập nhật kho trước khi nhập tồn đầu.');
  }
  const location = new m.WarehouseLocation({
    warehouseId, code: 'TONDAU-NHAN', name: 'Khu tiếp nhận tồn đầu', areaCode: 'TONDAU',
    locationType: 'RECEIVING', isPickable: false, isActive: true, version: 1,
    usableLengthMm: warehouse.lengthMm, usableWidthMm: warehouse.widthMm,
  });
  await location.validate();
  if (persist) {
    try {
      await location.save({ session });
    } catch (error) {
      if (error.code === 11000) throw validationError('Khu tiếp nhận vừa được tạo bởi thao tác khác; hãy thử lại.');
      throw error;
    }
    await appendAudit({ actorId: user._id, action: 'IMPORT_LOCATION', entityType: 'warehouse_locations', entityId: location._id, session });
  }
  locations.push(location);
  return location;
}

// Resolve only explicit catalogue identities. Preview never writes to the database.
async function resolveRows(user, input, session, persist = false) {
  if (new Date(input.openingAt) > new Date()) throw validationError('Mốc tồn đầu không được ở tương lai.');
  const locations = await unusedWarehouse(user, input.warehouseId, session);
  const location = input.rows.length ? await openingReceiving(user, input.warehouseId, locations, session, persist) : undefined;
  const rows = [], errors = [], products = new Map(), batches = new Map();
  let lineNo = 0;
  for (const [index, row] of input.rows.entries()) {
    try {
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
          lengthMm: row.lengthMm, widthMm: row.widthMm, heightMm: row.heightMm, wholeBaseUnits: true, isActive: true });
        await product.validate();
        newProduct = true;
        if (persist) {
          await product.save({ session });
          await syncAreaConversions(product, user, session);
          await appendAudit({ actorId: user._id, action: 'IMPORT_PRODUCT', entityType: 'products', entityId: product._id, session });
        }
      }
      if (!product.isActive) throw validationError('Sản phẩm đã ngừng hoạt động.');
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
      if (!Number.isSafeInteger(batch.piecesPerCarton) || batch.piecesPerCarton < 1) throw validationError('Lô thiếu số lượng hợp lệ mỗi thùng.');
      for (const field of ['piecesPerCarton', 'cartonLengthMm', 'cartonWidthMm', 'cartonHeightMm']) {
        if (row[field] && !exact(String(batch[field])).eq(row[field])) throw validationError('Quy cách lô trong file khác danh mục: ' + field);
      }
      batches.set(batchKey, batch);
      const qty = exact(row.enteredQty);
      if (qty.gte('100000000000000') || qty.decimalPlaces() > 6 || (product.wholeBaseUnits && !qty.isInteger())) throw validationError('Số lượng tồn phải hợp lệ theo đơn vị gốc của sản phẩm.');
      const perCarton = exact(batch.piecesPerCarton);
      const sealed = qty.dividedToIntegerBy(perCarton).mul(perCarton);
      const loose = qty.minus(sealed);
      let measuredVolumeMm3;
      if (loose.gt(0)) {
        const { lengthMm, widthMm, heightMm } = product;
        if ([lengthMm, widthMm, heightMm].some(size => size == null || !exact(size).gt(0))) {
          throw validationError('Sản phẩm thiếu kích thước để tính thể tích hàng lẻ.');
        }
        const volume = loose.mul(exact(lengthMm)).mul(exact(widthMm)).mul(exact(heightMm)).toDecimalPlaces(3, ExactDecimal.ROUND_CEIL);
        // The inventory portion has a smaller integer range than the draft item.
        if (volume.gte('100000000000000')) throw validationError('Thể tích hàng lẻ vượt giới hạn lưu tồn.');
        measuredVolumeMm3 = volume.toFixed();
      }
      for (const field of ['baseUnit', 'lengthMm', 'widthMm', 'heightMm']) {
        if (row[field] && String(product[field]) !== row[field] && (field === 'baseUnit' || product[field] == null || !exact(product[field]).eq(row[field]))) throw validationError('Thông số sản phẩm trong file khác danh mục: ' + field);
      }
      products.set(productKey, product);
      const packagingSnapshot = { packageUnit: 'Thùng', baseUnitsPerPackage: String(batch.piecesPerCarton),
        outerLengthMm: batch.cartonLengthMm, outerWidthMm: batch.cartonWidthMm, outerHeightMm: batch.cartonHeightMm };
      const items = [
        { packagingState: 'SEALED', quantity: sealed },
        { packagingState: 'LOOSE', quantity: loose, measuredVolumeMm3 },
      ].filter(({ quantity }) => quantity.gt(0)).map(({ quantity, ...packaging }) => {
        const qtyBase = quantity.toFixed();
        return { _id: newId(), lineNo: ++lineNo, lineKind: 'STANDARD', productId: product._id, lotId: batch._id,
          productNameSnapshot: product.name, enteredUnit: product.baseUnit, baseUnitSnapshot: product.baseUnit, baseUnitsPerUnit: '1',
          enteredQty: qtyBase, qtyBase, packagingSnapshot, locationId: location._id, ownerType: 'STORE', qualityStatus: 'GOOD', ...packaging };
      });
      rows.push({ rowNumber: index + 2, sku: product.sku, product: product.name, batch: batch.manufacturerLot, location: location.code,
        quantityBase: qty.toFixed(), unit: product.baseUnit, newProduct, newBatch, items });
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
        inventory_balances: rows.flatMap(r => r.items.map(item => ({ holdingPointId: item.locationId, batchId: item.lotId, quantityBase: item.qtyBase, packagingPortions: [portionFor(item)] }))) });
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
  return { rows: result.rows.map(({ items, ...row }) => row), errors: result.errors, valid: !result.errors.length };
}
export function create(user, input) {
  return command(user, 'CREATE_OPENING_STOCK', 'opening_stock:create', null, input, replay, async (session, actor) => {
    allowed(actor, 'opening_stock:create');
    const result = await resolveRows(actor, input, session, true);
    const document = await new m.OpeningStock({ ...await nextDocumentFields(m.OpeningStock, 'OPENING', input.warehouseId, session),
      workflowStatus: 'DRAFT', version: 1, createdBy: actor._id, occurredAt: input.openingAt,
      header: { warehouseId: input.warehouseId, openingImportSource: 'FILE', cutoverKey: input.cutoverKey, openingAt: input.openingAt,
        coveredLocationIds: result.locations.map(l => l._id), sourceDescription: input.sourceDescription, preparedBy: actor._id, preparedAt: new Date() },
      items: result.rows.flatMap(r => r.items) }).save({ session });
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
