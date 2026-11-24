import { Product, ProductBatch, Uom, WarehouseLocation } from '../../models/runtime.js';
import { normalizedEnteredQty, resolveConversion, toBaseQuantity } from './conversions.js';
import { exact } from '../../models/model-utils.js';
import { validationError } from './ApiError.js';
import { newId } from './document-command.js';
import { lockLotIdentity } from './lotIdentity.js';

export async function makeItem(input, lineNo, session, { lineKind = 'STANDARD', previous, includeLotLabel = false, allowInactiveUom = false } = {}) {
  const product = await Product.findOne({ _id: input.productId, isActive: true }).session(session);
  if (!product) throw validationError('Sản phẩm không tồn tại hoặc đã ngừng sử dụng');
  const enteredUnit = input.enteredUnit;
  const reuseSnapshot = previous && String(previous.productId) === String(product._id) &&
    previous.enteredUnit === enteredUnit && String(previous.lotId ?? '') === String(input.lotId ?? '');
  let factor;
  let packagingSnapshot;
  let batch;
  if (input.lotId) {
    batch = await ProductBatch.findOne({ _id: input.lotId, productId: product._id, identificationStatus: 'VERIFIED' }).session(session);
    if (!batch) throw validationError('Lô chưa xác minh hoặc không thuộc sản phẩm');
    await lockLotIdentity(batch._id, session);
    packagingSnapshot = { packageUnit: 'Thùng', baseUnitsPerPackage: String(batch.piecesPerCarton),
      outerLengthMm: batch.cartonLengthMm, outerWidthMm: batch.cartonWidthMm, outerHeightMm: batch.cartonHeightMm };
  }
  if (reuseSnapshot) {
    factor = exact(previous.baseUnitsPerUnit);
    packagingSnapshot = previous.packagingSnapshot;
  } else {
    factor = await resolveConversion(product, batch, enteredUnit, session, { allowInactiveUom });
  }
  const enteredUom = await Uom.findOne({ code: enteredUnit }).session(session);
  const quantity = toBaseQuantity(input.enteredQty, factor, product, enteredUom);
  if (!quantity.gt(0) || quantity.decimalPlaces() > 6 || quantity.gte('100000000000000') || (product.wholeBaseUnits && !quantity.isInteger())) throw validationError('Số lượng phải quy đổi chính xác sang đơn vị gốc');
  return { _id: previous?._id ?? newId(), lineNo, lineKind, productId: product._id, lotId: batch?._id,
    enteredUnit, baseUnitSnapshot: reuseSnapshot ? previous.baseUnitSnapshot : product.baseUnit,
    baseUnitsPerUnit: factor.toFixed(),
    enteredQty: normalizedEnteredQty(quantity, factor, product, enteredUom, input.enteredQty),
    qtyBase: quantity.toFixed(),
    productNameSnapshot: reuseSnapshot ? previous.productNameSnapshot : product.name,
    ...(includeLotLabel && { lotLabelSnapshot: batch?.manufacturerLot }), packagingSnapshot };
}

/**
 * Enrich document line DTOs with product specifications, batch metadata, and receiving location codes/names.
 * Does not persist extra fields on embedded schemas; used only when shaping read responses.
 */
export async function enrichLineItems(items = []) {
  if (!Array.isArray(items) || !items.length) return items;
  const productIds = [...new Set(items.map(item => item?.productId).filter(Boolean).map(String))];
  const lotIds = [...new Set(items.map(item => item?.lotId).filter(Boolean).map(String))];
  const locationIds = [
    ...new Set(
      items
        .map(item => item?.destinationLocationId ?? item?.details?.receivingLocationId)
        .filter(Boolean)
        .map(String),
    ),
  ];

  const [products, lots, locations] = await Promise.all([
    productIds.length
      ? Product.find({ _id: { $in: productIds } })
          .select('sku name manufacturerCode material surface color lengthMm widthMm heightMm description baseUnit')
          .lean()
      : [],
    lotIds.length
      ? ProductBatch.find({ _id: { $in: lotIds } })
          .select('manufacturerLot tone calibre piecesPerCarton')
          .lean()
      : [],
    locationIds.length
      ? WarehouseLocation.find({ _id: { $in: locationIds } })
          .select('code name')
          .lean()
      : [],
  ]);

  const prodMap = new Map(products.map(p => [String(p._id), p]));
  const lotMap = new Map(lots.map(l => [String(l._id), l]));
  const locMap = new Map(locations.map(loc => [String(loc._id), loc]));

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.productId) {
      const prod = prodMap.get(String(item.productId));
      if (prod) {
        item.productSkuSnapshot ??= prod.sku;
        item.productNameSnapshot ??= prod.name;
        item.productSpec ??= {
          sku: prod.sku,
          name: prod.name,
          manufacturerCode: prod.manufacturerCode ?? null,
          material: prod.material ?? null,
          surface: prod.surface ?? null,
          color: prod.color ?? null,
          lengthMm: prod.lengthMm != null ? exact(prod.lengthMm).toFixed() : null,
          widthMm: prod.widthMm != null ? exact(prod.widthMm).toFixed() : null,
          heightMm: prod.heightMm != null ? exact(prod.heightMm).toFixed() : null,
          description: prod.description ?? null,
          baseUnit: prod.baseUnit ?? null,
        };
      }
    }
    if (item.lotId) {
      const lot = lotMap.get(String(item.lotId));
      if (lot) {
        item.lotLabelSnapshot ??= lot.manufacturerLot;
        item.lotSpec ??= {
          manufacturerLot: lot.manufacturerLot,
          tone: lot.tone ?? null,
          calibre: lot.calibre ?? null,
          piecesPerCarton: lot.piecesPerCarton ?? null,
        };
      }
    }
    const locationId = item.destinationLocationId ?? item.details?.receivingLocationId;
    if (locationId) {
      const loc = locMap.get(String(locationId));
      if (loc) {
        item.destinationLocationCode ??= loc.code;
        item.destinationLocationName ??= loc.name ?? null;
      }
    }
  }
  return items;
}
