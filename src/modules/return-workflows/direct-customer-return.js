import * as s from './native.shared.js';
import { assertBatchPackaging } from '../../models/capacity.js';
const { m, exact, same, sum, validationError } = s;

const stateFor = condition => condition === 'SEALED' ? 'SEALED' : condition === 'LOOSE' ? 'LOOSE' : 'OPEN';
const inspectedState = portion => portion.packagingState ?? stateFor(portion.packagingCondition);

async function sealedSnapshot(item, inspection, session) {
  const batch = await m.ProductBatch.findOne({ _id: item.lotId, productId: item.productId, identificationStatus: 'VERIFIED' }).session(session);
  if (!Number.isSafeInteger(batch?.piecesPerCarton) || batch.piecesPerCarton < 1
      || ![batch.cartonLengthMm, batch.cartonWidthMm, batch.cartonHeightMm].every(value => {
        const n = exact(value ?? '0');
        return n.isFinite() && n.gt(0);
      })) throw validationError('Thiếu quy cách thùng của lô đã xác minh');
  const snapshot = item.packagingSnapshot ?? inspection?.portions.find(portion => portion.packagingSnapshot)?.packagingSnapshot;
  if (!snapshot) return { packageUnit: 'Thùng', baseUnitsPerPackage: String(batch.piecesPerCarton),
    outerLengthMm: batch.cartonLengthMm, outerWidthMm: batch.cartonWidthMm, outerHeightMm: batch.cartonHeightMm };
  try { assertBatchPackaging(batch, snapshot); }
  catch { throw validationError('Quy cách thùng đã lưu khác lô đã xác minh'); }
  return snapshot;
}

function sealedCount(snapshot, quantity) {
  const factor = exact(snapshot.baseUnitsPerPackage);
  if (!exact(quantity).mod(factor).isZero())
    throw validationError('Hàng nguyên thùng phải nhận theo đủ quy cách đã kiểm');
  return exact(quantity).div(factor).toNumber();
}

export async function directInspectionPortions(item, row, quantity, previous, facts, session) {
  const state = stateFor(row.packagingCondition);
  const compatible = portion => row.packagingCondition === 'UNKNOWN' || inspectedState(portion) === state;
  const prior = previous?.portions;
  const portions = row.portions ?? (prior?.every(compatible) ? prior : [{ packagingState: state, quantityBase: quantity.toFixed() }]);
  if (!sum(portions, 'quantityBase').eq(quantity) || portions.some(portion => !compatible(portion)))
    throw validationError('Quy cách kiểm không khớp lượng và tình trạng bao bì');
  const fractional = portions.find(portion => !exact(portion.quantityBase).isInteger());
  if (fractional) await s.assertWholeQuantity(item.productId, fractional.quantityBase, session);
  const snapshot = portions.some(portion => inspectedState(portion) === 'SEALED') ? await sealedSnapshot(item, previous, session) : undefined;
  return portions.map(portion => {
    const packagingState = inspectedState(portion);
    const result = { ...facts, quantityBase: String(portion.quantityBase), packagingState };
    if (packagingState === 'SEALED') {
      if (portion.measuredVolumeMm3 != null) throw validationError('Thùng nguyên tính thể tích theo kích thước lô');
      sealedCount(snapshot, portion.quantityBase);
      result.packagingSnapshot = snapshot;
    } else if (portion.measuredVolumeMm3 != null) {
      result.measuredVolumeMm3 = String(portion.measuredVolumeMm3);
    }
    return result;
  });
}

export async function directReceiptPortions(item, inspection, quantity, session, { received = '0', supplied } = {}) {
  const portions = [];
  let skip = exact(received), left = exact(quantity);
  for (const portion of inspection.portions) {
    const amount = exact(portion.quantityBase);
    if (skip.gte(amount)) { skip = skip.minus(amount); continue; }
    const available = amount.minus(skip);
    skip = exact('0');
    const taken = available.lt(left) ? available : left;
    if (!taken.gt(0)) break;
    const receivedPortion = { packagingState: inspectedState(portion), quantityBase: taken.toFixed() };
    if (portion.measuredVolumeMm3 != null) {
      // A whole measurement is only an upper bound for a fragment.
      receivedPortion[taken.eq(amount) ? 'measuredVolumeMm3' : 'volumeUpperBoundMm3'] = String(portion.measuredVolumeMm3);
    }
    portions.push(receivedPortion);
    left = left.minus(taken);
  }
  if (!left.isZero()) throw validationError('Vượt lượng bao bì đã kiểm còn lại');
  const measured = portions.some(portion => portion.measuredVolumeMm3 != null || portion.volumeUpperBoundMm3 != null);
  const exactPortions = supplied?.length === portions.length && supplied.every((row, i) =>
    row.packagingState === portions[i].packagingState && exact(row.quantityBase).eq(portions[i].quantityBase));
  const total = (rows, state) => sum(rows.filter(row => row.packagingState === state), 'quantityBase');
  if (supplied && (measured ? !exactPortions : ['SEALED', 'OPEN', 'LOOSE'].some(state => !total(supplied, state).eq(total(portions, state)))))
    throw validationError('Quy cách nhận phải khớp tình trạng bao bì đã kiểm');
  const snapshot = portions.some(portion => portion.packagingState === 'SEALED')
    ? await sealedSnapshot(item, inspection, session) : item.packagingSnapshot;
  return (supplied ?? portions).map((portion, i) => {
    const observed = measured ? portions[i] : undefined;
    const result = { ...portion, packagingSnapshot: snapshot };
    if (observed?.measuredVolumeMm3 != null) {
      if (portion.measuredVolumeMm3 != null && !exact(portion.measuredVolumeMm3).eq(observed.measuredVolumeMm3))
        throw validationError('Thể tích nhận phải khớp số đo của phần đã kiểm');
      result.measuredVolumeMm3 = observed.measuredVolumeMm3;
    } else if (observed?.volumeUpperBoundMm3 != null && result.measuredVolumeMm3 == null) {
      result.volumeUpperBoundMm3 = observed.volumeUpperBoundMm3;
    }
    if (portion.packagingState === 'SEALED') {
      if (portion.measuredVolumeMm3 != null) throw validationError('Thùng nguyên tính thể tích theo kích thước lô');
      const count = sealedCount(snapshot, portion.quantityBase);
      if (portion.sealedPackCount != null && portion.sealedPackCount !== count) throw validationError('Số thùng nhận không khớp quy cách đã kiểm');
      result.sealedPackCount = count;
    }
    return result;
  });
}

export async function receiveDirect(doc, actor, input, session, operationId, approval, handback) {
  if (!approval) throw validationError('Thiếu quyết định chấp nhận hoặc từ chối');
  if (handback && !input.recipientName) throw validationError('Cần tên người nhận lại hàng');
  const old = await m.CustomerReturnReceipt.find({ workflowStatus: 'POSTED', 'header.returnId': doc._id }).session(session);
  const receipt = handback ? null : await s.envelope(m.CustomerReturnReceipt, actor, { warehouseId: doc.header.warehouseId, returnId: doc._id, receivedAt: new Date(), operationId }, [], 'DRAFT', input.note);
  const posting = receipt && s.beginStock(receipt, actor, 'GR_CR', input);
  for (const row of input.lines) {
    const item = doc.items.id(row.lineId);
    if (!item) throw validationError('Dòng không thuộc yêu cầu');
    await s.assertWholeQuantity(item.productId, row.qtyBase, session);
    const inspection = doc.inspections.filter(i => same(i.returnLineId, item._id)).at(-1);
    const accepted = approval.reviewedContent.items.find(i => same(i._id, item._id));
    if (!accepted || !same(accepted.inspection?._id, inspection?._id)) throw validationError('Quyết định đã cũ');
    if (handback) {
      const back = sum((doc.handbacks || []).filter(r => same(r.returnLineId, item._id)), 'quantityBase');
      if (exact(row.qtyBase).plus(back).gt(sum(inspection.portions, 'quantityBase').minus(accepted.approvedQtyBase))) throw validationError('Vượt lượng hàng bị từ chối còn được trả lại');
      doc.handbacks ??= [];
      doc.handbacks.push({ returnLineId: item._id, quantityBase: row.qtyBase, recipientName: input.recipientName, recordedBy: actor._id, recordedAt: new Date(), evidenceIds: input.evidenceIds });
      continue;
    }
    const prior = sum(old.flatMap(r => r.items).filter(i => i.sources.some(src => same(src.itemId, item._id))));
    if (exact(row.qtyBase).plus(prior).gt(accepted.approvedQtyBase)) throw validationError('Vượt lượng được chấp nhận còn lại');
    if (inspection.portions.some(p => p.damageCause !== 'NONE') && row.qualityCode === 'GOOD') throw validationError('Hàng lỗi phải nhập khu lỗi');
    const portions = await directReceiptPortions(item, inspection, row.qtyBase, session, { received: prior, supplied: row.portions });
    receipt.items.push(s.copy(item, row.qtyBase, receipt.items.length + 1, { packagingSnapshot: portions[0].packagingSnapshot, inspectionId: inspection._id, sources: [s.source(doc, item, 'ACCEPTED_RETURN', row.qtyBase)] }));
    await s.postIn(receipt, receipt.items.at(-1), actor, session, posting, { ...row, portions });
    await s.resolveClaim(item._id, row.qtyBase, 'RECEIVED', receipt, actor, session);
  }
  doc.evidenceIds.addToSet(...input.evidenceIds);
  if (handback) return {};
  receipt.evidenceIds = input.evidenceIds;
  await s.savePosted(receipt, posting, actor, session);
  const claims = await m.ReturnQuantityClaim.find({ requestLineId: { $in: doc.items.map(i => i._id) } }).session(session);
  doc.workflowStatus = claims.every(c => s.remainingClaim(c).isZero()) ? 'COMPLETED' : 'PARTIAL';
  return { stockTransactionId: posting._id, resultRefs: [s.ref(receipt)] };
}
