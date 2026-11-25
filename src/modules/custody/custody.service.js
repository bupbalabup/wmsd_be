import {
  CustodyRelease,
  PurchaseReceipt,
  GoodsInspection,
  GoodsArrival,
  ApprovalHistory,
  Product,
} from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { command, checkVersion, saveVersion, same, hash } from '../../shared/utils/document-command.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { copyItem, sourceLink } from '../../shared/utils/document-copy.js';
import {
  beginStock,
  sourceContext,
  guardLocations,
  locationAt,
  balanceAt,
  receiveStock,
  verifyCapacity,
} from '../../shared/utils/stock.js';
import { findPurchase, newDocument, evidenceFor, replayPurchase, activePo } from '../../shared/utils/purchase-core.js';
import { intakePortions, checkPackagingLines } from '../../shared/utils/intake-packaging.js';
import { purchaseOrderQuantities } from '../purchase-orders/purchase-order.service.js';
import { custody, origin, allocations, transferCustodyStock } from './custody-stock.js';

async function consumed(d, item, session) {
  let total = exact('0');
  for (const Model of [PurchaseReceipt, CustodyRelease]) {
    const docs = await Model.find({
      workflowStatus: { $nin: ['CANCELLED', 'REVERSED'] },
      'items.sources.documentId': d._id,
    }).session(session);
    for (const doc of docs) {
      for (const row of doc.items) {
        if (row.sources.some(s => same(s.documentId, d._id) && same(s.itemId, item._id))) {
          total = total.plus(String(row.qtyBase));
        }
      }
    }
  }
  return total;
}

async function available(d, item, quantity, session) {
  const product = await Product.findById(item.productId).session(session);
  if (!product || (product.wholeBaseUnits && !exact(quantity).isInteger())) {
    throw validationError('Lượng giữ hộ phải đúng đơn vị gốc của sản phẩm');
  }
  const used = await consumed(d, item, session);
  if (!exact(quantity).gt(0) || used.plus(quantity).gt(String(item.qtyBase))) {
    throw validationError('Vượt lượng giữ hộ chưa cam kết');
  }
}

export function postCustodyReceipt(user, id, input) {
  return command(
    user,
    'POST_PURCHASE_CUSTODY',
    'goods_receipt_inspection:post',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const receipt = await findPurchase(id, actor, session, { kind: 'CUSTODY_RECEIPT' });
      checkVersion(receipt, input.expectedVersion);
      if (
        receipt.workflowStatus !== 'DRAFT' ||
        receipt.header.ownerType !== 'SUPPLIER' ||
        !receipt.items.length
      ) {
        throw validationError('Phiếu giữ hộ không còn nháp');
      }
      if (
        input.destinations.length !== receipt.items.length ||
        new Set(input.destinations.map(r => r.lineId)).size !== receipt.items.length
      ) {
        throw validationError('Chọn vị trí cho mỗi dòng giữ hộ');
      }
      checkPackagingLines(receipt, input.packaging);
      const locations = input.destinations.map(r => r.locationId);
      await guardLocations(locations, session);
      const posting = beginStock(receipt, actor, 'CUSTODY_RECEIPT', input);
      for (const item of receipt.items) {
        const ref = item.sources.find(r => r.subjectCollection === 'goods_inspections');
        const inspection = ref && await GoodsInspection.findOne({
          _id: ref.documentId,
          workflowStatus: 'CONFIRMED',
          'header.warehouseId': receipt.header.warehouseId,
        }).session(session);
        const inspectedOrigin = inspection?.items.id(ref.itemId);
        const arrival = inspection && await GoodsArrival.findById(inspection.header.arrivalId).session(session);
        if (
          !inspectedOrigin ||
          inspectedOrigin.details.ownershipDecision !== 'CUSTODY' ||
          !same(arrival?.header.supplierId, receipt.header.ownerId) ||
          !same(item.lotId, inspectedOrigin.lotId) ||
          !same(item.productId, inspectedOrigin.productId) ||
          !exact(item.qtyBase).eq(String(inspectedOrigin.qtyBase))
        ) {
          throw validationError('Nguồn giữ hộ không hợp lệ');
        }
        const dest = input.destinations.find(r => same(r.lineId, item._id));
        if (!dest) throw validationError('Thiếu vị trí giữ hộ');
        await locationAt(dest.locationId, receipt.header.warehouseId, ['CUSTODY', 'QUARANTINE'], session);
        const target = await balanceAt(
          { type: 'LOCATION', locationId: dest.locationId },
          { batchId: item.lotId, ownerType: 'SUPPLIER', ownerId: receipt.header.ownerId },
          inspectedOrigin.details.qualityCode,
          session,
        );
        const portions = await intakePortions(
          item,
          inspectedOrigin.details.packagingCondition,
          input.packaging?.find(r => same(r.lineId, item._id))?.portions,
          session,
        );
        await receiveStock(target, item, portions, posting, actor, session, inspectedOrigin.details.packagingCondition);
      }
      await verifyCapacity(locations, session);
      await posting.save({ session });
      receipt.workflowStatus = 'POSTED';
      receipt.stockTransactionId = posting._id;
      receipt.postedBy = actor._id;
      receipt.postedAt = new Date();
      receipt.header.receivedAt = new Date();
      receipt.header.receivedBy = actor._id;
      // Optional until the business meaning of "người bàn giao" is confirmed.
      receipt.header.handedOverBy = input.handedOverBy || undefined;
      return {
        document: await saveVersion(receipt, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        stockTransactionId: posting._id,
      };
    },
  );
}

export function reinspectCustody(user, id, input) {
  return command(user, 'REINSPECT_PURCHASE_CUSTODY', 'goods_receipt_inspection:update', id, input, replayPurchase, async (session, actor) => {
    const d = await custody(id, actor, session, input.expectedVersion);
    await evidenceFor(actor, d, input.evidenceIds, session, true);
    const inspected = await newDocument(GoodsInspection, 'INS', actor, {
      warehouseId: d.header.warehouseId,
      participants: [actor._id],
      confirmedBy: actor._id,
      confirmedAt: new Date(),
    }, [], 'CONFIRMED');
    for (const [i, line] of input.lines.entries()) {
      const item = d.items.id(line.custodyItemId);
      if (!item) throw validationError('Sai dòng giữ hộ');
      await available(d, item, line.qtyBase, session);
      const o = await origin(d, item, session);
      inspected.header.arrivalId = o.arrival._id;
      inspected.items.push(copyItem(item, line.qtyBase, {
        lineNo: i + 1,
        lineKind: 'INSPECTION',
        sources: [sourceLink(d, item, line.qtyBase, 'REINSPECTION')],
        details: {
          inspectedSourceLineId: o.arrived._id,
          qualityCode: line.qualityCode,
          ownershipDecision: 'CUSTODY',
          inspectedBy: actor._id,
          inspectedAt: new Date(),
          packagingCondition: o.row.details.packagingCondition,
        },
      }));
    }
    inspected.sources = [sourceLink(d)];
    inspected.evidenceIds = input.evidenceIds;
    await inspected.save({ session });
    await saveVersion(d, d.version, session);
    return { document: inspected, reason: input.reason };
  });
}

export function decideCustody(user, id, input) {
  return command(user, 'DECIDE_PURCHASE_CUSTODY', 'purchase_custody:decide', id, input, replayPurchase, async (session, actor) => {
    const d = await custody(id, actor, session, input.expectedVersion);
    await evidenceFor(actor, d, input.evidenceIds, session, true);
    const reviewed = [];
    for (const line of input.lines) {
      const item = d.items.id(line.custodyItemId);
      if (!item) throw validationError('Sai dòng giữ hộ');
      await available(d, item, line.qtyBase, session);
      let inspectionItemId;
      if (input.decision === 'ACCEPT') {
        let check;
        if (line.reinspectionId) {
          const ins = await GoodsInspection.findOne({
            _id: line.reinspectionId,
            workflowStatus: 'CONFIRMED',
            'sources.documentId': d._id,
          }).session(session);
          check = ins?.items.find(r => r.sources.some(s => same(s.documentId, d._id) && same(s.itemId, item._id)));
          inspectionItemId = check?._id;
        } else {
          check = (await origin(d, item, session)).row;
          inspectionItemId = check._id;
        }
        if (!check || check.details.qualityCode !== 'GOOD' || exact(line.qtyBase).gt(String(check.qtyBase))) {
          throw validationError('Nhận sở hữu cần kết quả GOOD đủ lượng');
        }
      }
      reviewed.push({ ...line, inspectionItemId: inspectionItemId ? String(inspectionItemId) : undefined });
    }
    const decision = await new ApprovalHistory({
      decisionKey: hash({ id, key: input.operationKey }),
      subjectType: 'custody_receipts',
      subjectId: d._id,
      subjectRevision: d.version,
      decisionScope: 'PURCHASE_CUSTODY',
      decision: 'APPROVE',
      reason: input.reason,
      requestedBy: d.createdBy,
      decidedBy: actor._id,
      decidedAt: new Date(),
      recordedAt: new Date(),
      reviewedContent: { action: input.decision, lines: reviewed },
      itemDecisions: reviewed.map(r => ({
        itemId: r.custodyItemId,
        approvedQtyBase: r.qtyBase,
        outcome: input.decision,
        reason: input.reason,
      })),
      evidenceIds: input.evidenceIds,
    }).save({ session });
    await saveVersion(d, d.version, session);
    return { document: d, decisionId: decision._id, reason: input.reason };
  });
}

export function createCustodyResolution(user, id, input, action) {
  return command(user, 'CREATE_CUSTODY_' + action, 'purchase_custody:execute', id, input, replayPurchase, async (session, actor) => {
    const d = await custody(id, actor, session, input.expectedVersion);
    const decision = await ApprovalHistory.findOne({
      _id: input.decisionId,
      subjectType: 'custody_receipts',
      subjectId: d._id,
      decisionScope: 'PURCHASE_CUSTODY',
      decision: 'APPROVE',
    }).session(session);
    if (!decision || decision.subjectRevision + 1 !== d.version || decision.reviewedContent.action !== action) {
      throw validationError('Quyết định không đúng nguồn/phiên bản');
    }
    const Model = action === 'ACCEPT' ? PurchaseReceipt : CustodyRelease;
    const doc = await newDocument(
      Model,
      action === 'ACCEPT' ? 'GR' : 'CREL',
      actor,
      action === 'ACCEPT'
        ? { warehouseId: d.header.warehouseId, supplierId: d.header.ownerId }
        : { warehouseId: d.header.warehouseId, ownerType: 'SUPPLIER', ownerId: d.header.ownerId },
    );
    doc.custodyDecisionId = decision._id;
    let po;
    for (const [index, line] of input.lines.entries()) {
      const approved = decision.reviewedContent.lines.find(r => same(r.custodyItemId, line.custodyItemId));
      const item = d.items.id(line.custodyItemId);
      if (!approved || !item || exact(line.qtyBase).gt(approved.qtyBase)) {
        throw validationError('Lượng không thuộc thỏa thuận');
      }
      await available(d, item, line.qtyBase, session);
      const move = await allocations(d, item, session);
      const o = await origin(d, item, session);
      const ctx = await sourceContext(move.toBalanceId, session);
      if (ctx.balance.ownerType !== 'SUPPLIER' || !same(ctx.balance.ownerId, d.header.ownerId) ||
          !same(ctx.location?.warehouseId, d.header.warehouseId)) {
        throw validationError('Sai tồn giữ hộ');
      }
      let overrides = { lineNo: index + 1, sources: [sourceLink(d, item, line.qtyBase, 'CUSTODY_RESOLUTION')] };
      if (action === 'ACCEPT') {
        po = await activePo(actor, o.arrival.header.purchaseOrderId, input.expectedPoVersion, session);
        const q = (await purchaseOrderQuantities(po, session)).find(r => same(r.lineId, o.arrived.purchaseOrderItemId));
        const committed = doc.items
          .filter(r => same(r.purchaseOrderItemId, o.arrived.purchaseOrderItemId))
          .reduce((s, r) => s.plus(String(r.qtyBase)), exact('0'));
        if (!q || exact(line.qtyBase).plus(committed).gt(q.acceptanceHeadroomQtyBase)) {
          throw validationError('PO hết hạn mức');
        }
        await locationAt(line.destinationLocationId, d.header.warehouseId, ['RECEIVING'], session);
        doc.header.purchaseOrderId = po._id;
        doc.header.arrivalId = o.arrival._id;
        overrides = {
          ...overrides,
          purchaseOrderItemId: o.arrived.purchaseOrderItemId,
          arrivalItemId: o.arrived._id,
          inspectionId: approved.reinspectionId || o.inspection._id,
          inspectionResultId: approved.inspectionItemId,
          destinationLocationId: line.destinationLocationId,
          custodyReceiptRef: { documentType: 'custody_receipts', documentId: d._id, itemId: item._id, revision: d.version },
          custodyBalanceId: move.toBalanceId,
        };
      }
      doc.items.push(copyItem(item, line.qtyBase, overrides));
    }
    doc.sources = [sourceLink(d)];
    await doc.save({ session });
    if (po) await saveVersion(po, po.version, session);
    await saveVersion(d, d.version, session);
    return { document: doc };
  });
}

export function postCustodyRelease(user, id, input) {
  return command(user, 'POST_PURCHASE_CUSTODY_RELEASE', 'purchase_custody:execute', id, input, replayPurchase, async (session, actor) => {
    const doc = await findPurchase(id, actor, session, { kind: 'CUSTODY_RELEASE' });
    checkVersion(doc, input.expectedVersion);
    if (doc.workflowStatus !== 'DRAFT') throw validationError('Phiếu không còn nháp');
    const decision = await ApprovalHistory.findById(doc.custodyDecisionId).session(session);
    if (!decision || decision.reviewedContent.action !== 'RETURN') throw validationError('Thiếu thỏa thuận trả');
    const posting = beginStock(doc, actor, 'CUSTODY_RELEASE', input);
    const locations = [];
    for (const item of doc.items) {
      const ref = item.sources.find(s => s.subjectCollection === 'custody_receipts');
      const d = await custody(ref.documentId, actor, session);
      const source = d.items.id(ref.itemId);
      const move = await allocations(d, source, session);
      const ctx = await sourceContext(move.toBalanceId, session);
      if (ctx.balance.ownerType !== 'SUPPLIER' || !same(ctx.balance.ownerId, doc.header.ownerId) ||
          !same(ctx.location?.warehouseId, doc.header.warehouseId)) {
        throw validationError('Sai tồn trả');
      }
      locations.push(ctx.location._id);
      await guardLocations([ctx.location._id], session);
      await transferCustodyStock(move.toBalanceId, null, item, posting, actor, session);
      await saveVersion(d, d.version, session);
    }
    await verifyCapacity(locations, session);
    await posting.save({ session });
    doc.header.recipientName = input.recipientName;
    doc.header.releasedBy = actor._id;
    doc.header.releasedAt = new Date();
    doc.workflowStatus = 'POSTED';
    doc.stockTransactionId = posting._id;
    doc.postedBy = actor._id;
    doc.postedAt = new Date();
    return {
      document: await saveVersion(doc, input.expectedVersion, session),
      versionBefore: input.expectedVersion,
      stockTransactionId: posting._id,
    };
  });
}
