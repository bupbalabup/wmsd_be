import test from 'node:test';
import assert from 'node:assert/strict';
import { quantityProgress } from '../src/modules/return-workflows/quantity-progress.js';

test('supplier progress counts posted dispatch and only current accepted acknowledgements', () => {
 const doc = {items:[{_id:'source',qtyBase:'10',details:{agreedQty:'8'}}]};
 const issue = {documentKind:'GI_SUPPLIER_RETURN',workflowStatus:'POSTED',items:[{_id:'dispatch',qtyBase:'5',sources:[{itemId:'source'}]}],acknowledgements:[
  {workflowStatus:'SUPERSEDED',items:[{qtyBase:'5',details:{dispatchLineId:'dispatch',outcome:'ACCEPTED'}}]},
  {workflowStatus:'RECORDED',items:[{qtyBase:'3',details:{dispatchLineId:'dispatch',outcome:'ACCEPTED'}},{qtyBase:'2',details:{dispatchLineId:'dispatch',outcome:'REJECTED'}}]},
 ]};
 assert.deepEqual(quantityProgress('supplier-returns',doc,[issue,{...issue,workflowStatus:'DRAFT'}])[0],{lineId:'source',requested:'10',agreed:'8',dispatched:'5',acknowledged:'3',remaining:'3'});
});
test('defect progress separates unresolved stock from quantities committed to plans', () => {
 const doc = {items:[{_id:'line',qtyBase:'10'}],holds:[{defectReportLineId:'line',allocations:[{quantityBase:'10'}],events:[{quantityBase:'4'}]}],resolutionPlans:[{workflowStatus:'APPROVED',items:[{_id:'plan-line',qtyBase:'7',details:{defectLineId:'line'}}]}],inspections:[{itemId:'plan-line',quantityBase:'4'}]};
 assert.deepEqual(quantityProgress('defects',doc)[0],{lineId:'line',requested:'10',processed:'4',remaining:'6',proposable:'3'});
});
test('customer progress uses latest inspection and separates rejected custody from accepted receipts', () => {
 const doc={items:[{_id:'line',qtyBase:'10'}],inspections:[{returnLineId:'line',portions:[{quantityBase:'9'}]},{returnLineId:'line',portions:[{quantityBase:'8'}]}]};
 const related=[{documentKind:'CUSTOMER_RETURN',workflowStatus:'POSTED',items:[{qtyBase:'3',sources:[{itemId:'line'}]}]},{documentKind:'CUSTODY_RELEASE',workflowStatus:'POSTED',items:[{qtyBase:'1',sources:[{itemId:'line'}]}]}];
 const progress=quantityProgress('customer-returns',doc,related,{reviewedContent:{items:[{_id:'line',approvedQtyBase:'5'}]}})[0];
 assert.equal(progress.inspected,'8');assert.equal(progress.remaining,'2');assert.equal(progress.custodyRemaining,'4');assert.equal(progress.handbackAvailable,'2');
});
