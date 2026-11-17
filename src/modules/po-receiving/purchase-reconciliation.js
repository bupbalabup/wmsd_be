import { InventoryBalance, StockTransaction, PurchaseOrder, ReplenishmentRequest, PurchaseReceipt } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { withinApproved } from '../../shared/utils/conversions.js';
import { purchaseOrderQuantities } from '../purchase-orders/purchase-order.service.js';
// Read-only diagnostics use the same native records as the application.
export async function reconcilePurchasing(session=null){
  const issues=[],balances=await InventoryBalance.find().session(session),transactions=await StockTransaction.find().session(session);
  const ledger=new Map(balances.map(b=>[String(b._id),exact('0')]));let movements=0;
  for(const transaction of transactions)for(const movement of transaction.movements){movements++;for(const [key,sign]of [['fromBalanceId',-1],['toBalanceId',1]]){if(!movement[key])continue;const id=String(movement[key]);if(!ledger.has(id)){issues.push({code:'MISSING_BALANCE',balanceId:id});continue;}ledger.set(id,ledger.get(id).plus(exact(movement.quantityBase).mul(sign)));}}
  for(const balance of balances){if(!ledger.get(String(balance._id)).eq(String(balance.quantityBase)))issues.push({code:'LEDGER_BALANCE',balanceId:String(balance._id)});if(!balance.packagingPortions.reduce((n,p)=>n.plus(String(p.quantityBase)),exact('0')).eq(String(balance.quantityBase)))issues.push({code:'PACKAGING_BALANCE',balanceId:String(balance._id)});}
  const orders=await PurchaseOrder.find().session(session);
  for(const po of orders){if(po.workflowStatus==='CANCELLED')continue;const request=await ReplenishmentRequest.findById(po.replenishmentRequestId).session(session);
    for (const item of po.items) {
      const id = String(item.requestItemId);
      const source = request?.items.id(id);
      const cap = item.enteredUnit === source?.enteredUnit ? source.approvedEnteredQty : null;
      if (!source || !withinApproved(item.qtyBase, item.enteredQty, item.baseUnitsPerUnit, source.approvedQtyBase ?? '0', cap)) {
        issues.push({ code: 'RR_ALLOWANCE', poId: String(po._id), lineId: id });
      }
    }
    for(const q of await purchaseOrderQuantities(po,session))if(exact(q.outstandingQtyBase).lt(0)||exact(q.acceptanceHeadroomQtyBase).lt(0))issues.push({code:'PO_ALLOWANCE',poId:String(po._id),lineId:q.lineId});
  }
  const receipts = await PurchaseReceipt.countDocuments({ workflowStatus: 'POSTED' }).session(session);
  return {ok:!issues.length,checked:{balances:balances.length,movements,purchaseOrders:orders.length,receipts},issues};
}
