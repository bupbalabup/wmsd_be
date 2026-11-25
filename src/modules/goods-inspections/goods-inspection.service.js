import {
  PurchaseOrder,
  GoodsArrival,
  GoodsInspection,
  PurchaseReceipt,
  CustodyReceipt,
  WarehouseLocation,
  ProductBatch,
  Product,
  Uom,
} from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { requirePermission } from '../../shared/utils/access.js';
import { validationError } from '../../shared/utils/ApiError.js';
import {
  command,
  checkVersion,
  saveVersion,
  same,
  newId,
} from '../../shared/utils/document-command.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import { findPurchase, replayPurchase, newDocument, activePo } from '../../shared/utils/purchase-core.js';
import { purchaseOrderQuantities } from '../purchase-orders/purchase-order.service.js';
import { locationAt } from '../../shared/utils/stock.js';
import { enrichLineItems, makeItem } from '../../shared/utils/document-items.js';
import { redactPrices } from '../sales-orders/sales-read.service.js';
import { dto } from '../../shared/utils/persistence.js';

export async function inspectionSource(user, id, session) {
  const inspection = await findPurchase(id, user, session, { kind: 'INSPECTION' });
  const arrival = await GoodsArrival.findById(inspection.header.arrivalId).session(session);
  if (!arrival) throw validationError('Thiếu hồ sơ hàng đến');
  return { inspection, arrival };
}

export async function prepare(po, input, actor, session, arrival, inspection) {
  const arrivalItems = [];
  const inspectionItems = [];
  const seen = new Set();
  for (const [i, row] of input.lines.entries()) {
    if (row.qualityCode !== 'GOOD' && row.ownershipDecision !== 'CUSTODY') {
      throw validationError('Hàng chưa đạt phải tạm giữ chờ trả nhà cung cấp');
    }
    const source = po.items.id(row.poLineId);
    if (!source) throw validationError('Dòng không thuộc PO');
    if (!row.lotId) throw validationError('Kiểm nhận cần lô thực nhận');
    const prior = row.id ? inspection.items.id(row.id) : null;
    if (row.id && (!prior || seen.has(row.id))) {
      throw validationError('Dòng kiểm không tồn tại hoặc bị trùng');
    }
    if (row.id) seen.add(row.id);
    const oldArrival = prior && arrival.items.id(prior.details.inspectedSourceLineId);
    if (oldArrival && !same(oldArrival.purchaseOrderItemId, source._id)) {
      throw validationError('Không đổi nguồn của dòng đã lưu');
    }
    if (row.receivingLocationId) {
      if (row.ownershipDecision !== 'ACCEPT') {
        throw validationError('Chỉ chọn bãi tiếp nhận cho hàng được nhận mua');
      }
      await locationAt(row.receivingLocationId, po.header.warehouseId, ['RECEIVING'], session);
    }
    // Staff count what they physically handle: whole cartons or base units (never the PO unit, e.g. m2).
    const product = await Product.findById(source.productId).session(session);
    const enteredUnit = row.enteredUnit ?? product?.baseUnit;
    const carton = enteredUnit !== product?.baseUnit;
    if (!product || (carton && !(await Uom.exists({ code: enteredUnit, isCarton: true }).session(session)))) {
      throw validationError('Kiểm hàng đếm theo thùng hoặc đơn vị gốc');
    }
    if (carton && !exact(row.enteredQty).isInteger()) {
      throw validationError('Số thùng phải là số nguyên; phần lẻ nhập ở dòng riêng theo đơn vị gốc');
    }
    const item = await makeItem(
      { productId: source.productId, lotId: row.lotId, enteredUnit, enteredQty: row.enteredQty },
      i + 1,
      session,
      { previous: oldArrival, includeLotLabel: true, allowInactiveUom: true },
    );
    if (row.packagingCondition === 'SEALED' && !exact(item.qtyBase).mod(String(item.packagingSnapshot.baseUnitsPerPackage)).isZero()) {
      throw validationError('Dòng nguyên thùng phải đủ số viên theo quy cách lô; phần lẻ ghi dòng riêng là hàng lẻ');
    }
    const lot = await ProductBatch.findById(row.lotId).select('manufacturedOn').session(session);
    if (lot?.manufacturedOn && lot.manufacturedOn > new Date(input.arrivedAt)) {
      throw validationError('Thời điểm nhận không được trước ngày sản xuất của lô');
    }
    const arrived = {
      ...item,
      productNameSnapshot: source.productNameSnapshot,
      purchaseOrderItemId: source._id,
      packagingCondition: row.packagingCondition,
      sources: [sourceLink(po, source, item.qtyBase)],
    };
    arrivalItems.push(arrived);
    inspectionItems.push(
      copyItem(arrived, item.qtyBase, {
        _id: prior?._id ?? newId(),
        lineNo: i + 1,
        lineKind: 'INSPECTION',
        note: row.handlingNote,
        sources: [sourceLink(arrival, arrived, item.qtyBase)],
        details: {
          inspectedSourceLineId: arrived._id,
          receivingLocationId: row.receivingLocationId,
          qualityCode: row.qualityCode,
          ownershipDecision: row.ownershipDecision,
          inspectedBy: actor._id,
          inspectedAt: new Date(),
          packagingCondition: row.packagingCondition,
        },
      }),
    );
  }
  arrival.items = arrivalItems;
  inspection.items = inspectionItems;
}

export function createInspection(user, id, input) {
  return command(
    user,
    'CREATE_GOODS_INSPECTION',
    'goods_receipt_inspection:create',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const po = await activePo(actor, id, input.expectedPoVersion, session);
      // Contend with PO cancellation without changing its public version token.
      const updatedAt = new Date(Math.max(Date.now(), (po.updatedAt?.getTime() ?? 0) + 1));
      const locked = await PurchaseOrder.updateOne(
        { _id: po._id, version: po.version, workflowStatus: { $in: ['OPEN', 'PARTIAL'] } },
        { $set: { updatedAt } },
        { session, timestamps: false },
      );
      if (locked.matchedCount !== 1) throw validationError('PO không còn mở để nhận hàng');
      const arrival = await newDocument(GoodsArrival, 'ARR', actor, {
        purchaseOrderId: po._id,
        warehouseId: po.header.warehouseId,
        supplierId: po.header.supplierId,
        arrivedAt: new Date(input.arrivedAt),
        deliveryReference: input.deliveryReference,
        deliveredBy: input.deliveredBy,
      });
      arrival.sources = [sourceLink(po)];
      const inspection = await newDocument(GoodsInspection, 'INS', actor, {
        arrivalId: arrival._id,
        warehouseId: po.header.warehouseId,
        participants: [actor._id],
      });
      inspection.sources = [sourceLink(arrival)];
      await prepare(po, input, actor, session, arrival, inspection);
      await arrival.save({ session });
      await inspection.save({ session });
      return {
        document: inspection,
        resultRefs: [{ documentType: 'goods_arrivals', documentId: arrival._id, revision: 1 }],
      };
    },
  );
}

export function updateInspection(user, id, input) {
  return command(
    user,
    'UPDATE_GOODS_INSPECTION',
    'goods_receipt_inspection:update',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const { inspection, arrival } = await inspectionSource(actor, id, session);
      checkVersion(inspection, input.expectedVersion);
      if (inspection.workflowStatus !== 'DRAFT' || arrival.workflowStatus !== 'DRAFT') {
        throw validationError('Hồ sơ không còn nháp');
      }
      const po = await activePo(actor, arrival.header.purchaseOrderId, input.expectedPoVersion, session);
      await prepare(po, input, actor, session, arrival, inspection);
      arrival.header.arrivedAt = new Date(input.arrivedAt);
      arrival.header.deliveryReference = input.deliveryReference;
      arrival.header.deliveredBy = input.deliveredBy;
      await saveVersion(arrival, arrival.version, session);
      return {
        document: await saveVersion(inspection, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
      };
    },
  );
}

export function confirmInspection(user, id, input) {
  return command(
    user,
    'CONFIRM_GOODS_INSPECTION',
    'goods_receipt_inspection:update',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const { inspection, arrival } = await inspectionSource(actor, id, session);
      checkVersion(inspection, input.expectedVersion);
      if (inspection.workflowStatus !== 'DRAFT' || !inspection.items.length) {
        throw validationError('Chỉ xác nhận hồ sơ nháp có dòng hàng');
      }
      if (inspection.items.some(row => row.details.qualityCode !== 'GOOD' && row.details.ownershipDecision !== 'CUSTODY')) {
        throw validationError('Hàng chưa đạt phải tạm giữ chờ trả nhà cung cấp');
      }
      const po = await activePo(actor, arrival.header.purchaseOrderId, input.expectedPoVersion, session);
      const quantities = await purchaseOrderQuantities(po, session);
      const free = new Map(quantities.map(row => [row.lineId, exact(row.acceptanceHeadroomQtyBase)]));
      const accepted = inspection.items.filter(row => row.details.ownershipDecision === 'ACCEPT');
      if (accepted.some(row => row.details.qualityCode !== 'GOOD')) {
        throw validationError('Chỉ GOOD được nhận sở hữu');
      }
      const destinations = input.destinations || [];
      if (
        destinations.length !== accepted.length ||
        new Set(destinations.map(row => row.inspectionItemId)).size !== accepted.length
      ) {
        throw validationError('Chọn vị trí nhập cho từng phần nhận sở hữu');
      }
      const receipt = accepted.length
        ? await newDocument(PurchaseReceipt, 'GR', actor, {
          purchaseOrderId: po._id,
          arrivalId: arrival._id,
          warehouseId: po.header.warehouseId,
          supplierId: po.header.supplierId,
        })
        : null;
      for (const [i, item] of accepted.entries()) {
        const source = arrival.items.id(item.details.inspectedSourceLineId);
        const poItem = source && po.items.id(source.purchaseOrderItemId);
        if (!poItem || !same(item.productId, source.productId) || !same(item.lotId, source.lotId)) {
          throw validationError('Nguồn kiểm nhận không hợp lệ');
        }
        const left = free.get(String(poItem._id)).minus(String(item.qtyBase));
        if (left.lt(0)) throw validationError('Tổng nhận vượt phần PO còn được nhận');
        free.set(String(poItem._id), left);
        const destination = destinations.find(row => same(row.inspectionItemId, item._id));
        if (!destination) throw validationError('Thiếu vị trí nhận');
        await locationAt(
          destination.locationId,
          po.header.warehouseId,
          [item.details.qualityCode === 'GOOD' ? 'RECEIVING' : 'QUARANTINE'],
          session,
        );
        item.details.receivingLocationId = destination.locationId;
        receipt.items.push(
          copyItem(item, item.qtyBase, {
            lineNo: i + 1,
            lineKind: 'STANDARD',
            purchaseOrderItemId: poItem._id,
            arrivalItemId: source._id,
            inspectionId: inspection._id,
            inspectionResultId: item._id,
            destinationLocationId: destination.locationId,
            sources: [sourceLink(inspection, item, item.qtyBase)],
          }),
        );
      }
      const refs = [];
      if (receipt) {
        receipt.sources = [sourceLink(po), sourceLink(inspection)];
        await receipt.save({ session });
        refs.push({ documentType: 'goods_receipts', documentId: receipt._id, revision: 1 });
      }
      // Custody is retained as its own document, never added to store-owned stock.
      const held = inspection.items.filter(row => row.details.ownershipDecision === 'CUSTODY');
      if (held.length) {
        const custody = await newDocument(CustodyReceipt, 'CRCV', actor, {
          warehouseId: po.header.warehouseId,
          ownerType: 'SUPPLIER',
          ownerId: po.header.supplierId,
        });
        custody.items = held.map((item, i) =>
          copyItem(item, item.qtyBase, {
            lineNo: i + 1,
            lineKind: 'STANDARD',
            sources: [sourceLink(inspection, item, item.qtyBase)],
          }),
        );
        custody.sources = [sourceLink(inspection)];
        await custody.save({ session });
        refs.push({ documentType: 'custody_receipts', documentId: custody._id, revision: 1 });
      }
      inspection.workflowStatus = 'CONFIRMED';
      inspection.header.confirmedBy = actor._id;
      inspection.header.confirmedAt = new Date();
      arrival.workflowStatus = 'RECORDED';
      arrival.header.recordedAt = new Date();
      await saveVersion(arrival, arrival.version, session);
      await saveVersion(po, po.version, session);
      return {
        document: await saveVersion(inspection, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        resultRefs: refs,
      };
    },
  );
}

export async function inspectionContext(user, id) {
  requirePermission(user, 'goods_receipt_inspection:read');
  const po = await findPurchase(id, user, null, { kind: 'PO', readOnly: true });
  const locations = await WarehouseLocation.find({
    warehouseId: po.header.warehouseId,
    isActive: true,
  }).lean();
  const batches = await ProductBatch.find({
    productId: { $in: po.items.map(row => row.productId) },
    identificationStatus: 'VERIFIED',
  }).lean();
  const products = await Product.find(
    { _id: { $in: po.items.map(row => row.productId) } },
    'sku name manufacturerCode material surface color description baseUnit lengthMm widthMm heightMm',
  ).lean();
  const cartonUnits = await Uom.find({ isCarton: true, isActive: true }, 'code').lean();
  const poDto = redactPrices(dto(po));
  await enrichLineItems(poDto.items);
  return {
    purchaseOrder: poDto,
    quantities: await purchaseOrderQuantities(po),
    locations: locations.map(dto),
    batches: batches.map(dto),
    // Lets the UI convert counted units to base units and m² without hardcoding ratios.
    products: products.map(row => ({
      id: String(row._id),
      sku: row.sku ?? null,
      name: row.name ?? null,
      manufacturerCode: row.manufacturerCode ?? null,
      material: row.material ?? null,
      surface: row.surface ?? null,
      color: row.color ?? null,
      description: row.description ?? null,
      baseUnit: row.baseUnit,
      lengthMm: row.lengthMm == null ? null : exact(row.lengthMm).toFixed(),
      widthMm: row.widthMm == null ? null : exact(row.widthMm).toFixed(),
      heightMm: row.heightMm == null ? null : exact(row.heightMm).toFixed(),
    })),
    cartonUnits: cartonUnits.map(row => row.code),
  };
}
