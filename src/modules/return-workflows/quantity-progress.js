import { exact } from '../../models/model-utils.js';

const total = (rows, field = 'qtyBase') => rows.reduce((n, row) => n.plus(String(row[field] ?? '0')), exact('0'));
const matches = (a, b) => String(a) === String(b);
const linked = (rows, id) => rows.filter(row => row.sources?.some(ref => matches(ref.itemId, id)));
const positive = value => value.gt(0) ? value.toFixed() : '0';

// Only posted documents and the current inspection/approval contribute to progress.
export function quantityProgress(resource, doc, related = [], approval) {
  const posted = related.filter(row => row.workflowStatus === 'POSTED');
  return doc.items.map(item => {
    const requested = exact(item.qtyBase);
    if (resource === 'supplier-returns') {
      const dispatches = posted.filter(row => ['GI_SUPPLIER_RETURN', 'CUSTODY_RELEASE'].includes(row.documentKind));
      const dispatched = total(linked(dispatches.flatMap(row => row.items), item._id));
      const acknowledged = total(dispatches.flatMap(row => (row.acknowledgements ?? []).filter(ack => ack.workflowStatus !== 'SUPERSEDED').flatMap(ack => ack.items))
        .filter(row => row.details.outcome === 'ACCEPTED' && dispatches.some(d => linked(d.items, item._id).some(i => matches(i._id, row.details.dispatchLineId)))));
      const agreed = exact(item.details.agreedQty ?? '0');
      return { lineId: String(item._id), requested: requested.toFixed(), agreed: item.details.agreedQty == null ? undefined : agreed.toFixed(), dispatched: dispatched.toFixed(), acknowledged: acknowledged.toFixed(), remaining: positive(agreed.minus(dispatched)) };
    }
    if (resource === 'defects') {
      const holds = doc.holds.filter(hold => matches(hold.defectReportLineId, item._id));
      const remaining = holds.reduce((n, hold) => n.plus(total(hold.allocations, 'quantityBase').minus(total(hold.events, 'quantityBase'))), exact('0'));
      const committed = (doc.resolutionPlans ?? []).filter(plan => ['SUBMITTED', 'APPROVED'].includes(plan.workflowStatus)).flatMap(plan => plan.items)
        .filter(row => matches(row.details.defectLineId, item._id)).reduce((n, row) => n.plus(exact(row.approvedQtyBase ?? row.qtyBase).minus(total(doc.inspections.filter(event => matches(event.itemId, row._id)), 'quantityBase'))), exact('0'));
      return { lineId: String(item._id), requested: requested.toFixed(), processed: positive(requested.minus(remaining)), remaining: positive(remaining), proposable: holds.some(hold => hold.stocktakeId) ? '0' : positive(remaining.minus(committed)) };
    }
    const inspection = doc.inspections?.filter(row => matches(row.returnLineId, item._id)).at(-1);
    const inspected = total(inspection?.portions ?? [], 'quantityBase');
    const acceptedItem = approval?.reviewedContent?.items?.find(row => matches(row._id, item._id));
    const accepted = exact(acceptedItem?.approvedQtyBase ?? '0');
    const received = total(linked(posted.filter(row => row.documentKind === 'CUSTOMER_RETURN').flatMap(row => row.items), item._id));
    const handedBack = total(linked(posted.filter(row => row.documentKind === 'CUSTODY_RELEASE').flatMap(row => row.items), item._id)).plus(total((doc.handbacks || []).filter(row => matches(row.returnLineId, item._id)), 'quantityBase'));
    return { lineId: String(item._id), requested: requested.toFixed(), inspected: inspection ? inspected.toFixed() : undefined, accepted: acceptedItem ? accepted.toFixed() : undefined, received: received.toFixed(), handedBack: handedBack.toFixed(), handbackAvailable: acceptedItem ? positive(inspected.minus(accepted).minus(handedBack)) : '0', remaining: positive(accepted.minus(received)), custodyRemaining: positive(inspected.minus(received).minus(handedBack)) };
  });
}
