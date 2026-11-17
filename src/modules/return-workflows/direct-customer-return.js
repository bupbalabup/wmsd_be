import * as s from './native.shared.js';
const { m, exact, same, sum, validationError } = s;

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
    receipt.items.push(s.copy(item, row.qtyBase, receipt.items.length + 1, { inspectionId: inspection._id, sources: [s.source(doc, item, 'ACCEPTED_RETURN', row.qtyBase)] }));
    await s.postIn(receipt, receipt.items.at(-1), actor, session, posting, row);
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
