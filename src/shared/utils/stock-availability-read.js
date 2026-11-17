import { StockReservation, TransferOrder, StockTransaction, DefectReport } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { remainingReservation, heldOnBalance } from './stock.js';

// Read-side selection aid only. Stock commands still recheck in their transaction.
export async function freeQuantities(balances) {
  if (!balances.length) return new Map();
  const ids=balances.map(row=>row._id);
  const [reservations,tasks,reports]=await Promise.all([
    StockReservation.find({balanceId:{$in:ids}}).select('balanceId reservedQty consumedQty releasedQty movedQty executionRef').lean(),
    TransferOrder.find({workflowStatus:{$in:['OPEN','DRAFT','PARTIAL']},'items.details.sourceBalanceId':{$in:ids}})
      .select('items._id items.qtyBase items.details.sourceBalanceId').lean(),
    DefectReport.find({holds:{$elemMatch:{status:'ACTIVE','allocations.balanceId':{$in:ids}}}}).select('holds').lean(),
  ]);
  const transactions=tasks.length?await StockTransaction.find({sourceType:'transfer_orders',sourceId:{$in:tasks.map(row=>row._id)}})
    .select('sourceId movements.sourceLineId movements.fromBalanceId movements.quantityBase').lean():[];
  const actual=new Map(),pending=new Map(),taskIds=new Map(),reserved=new Map(),covered=new Map(),holds=new Map();
  const add=(map,key,value)=>map.set(key,(map.get(key)??exact('0')).plus(value));
  const key=(task,line,balance)=>JSON.stringify([String(task),String(line),String(balance)]);
  for(const transaction of transactions)for(const movement of transaction.movements)
    add(actual,key(transaction.sourceId,movement.sourceLineId,movement.fromBalanceId),String(movement.quantityBase));
  for(const task of tasks)for(const item of task.items){
    const balance=String(item.details?.sourceBalanceId);
    add(pending,balance,exact(item.qtyBase).minus(actual.get(key(task._id,item._id,balance))??'0'));
    if(!taskIds.has(balance))taskIds.set(balance,new Set());taskIds.get(balance).add(String(task._id));
  }
  for(const reservation of reservations){
    const balance=String(reservation.balanceId),amount=remainingReservation(reservation);add(reserved,balance,amount);
    if(reservation.executionRef?.documentType==='transfer_orders'&&taskIds.get(balance)?.has(String(reservation.executionRef.documentId)))add(covered,balance,amount);
  }
  for(const report of reports){
    const affected=new Set(report.holds.filter(hold=>hold.status==='ACTIVE').flatMap(hold=>hold.allocations.map(row=>String(row.balanceId))));
    for(const balance of affected){if(!holds.has(balance))holds.set(balance,[]);holds.get(balance).push(report);}
  }
  return new Map(balances.map(balance=>{
    const id=String(balance._id),uncovered=(pending.get(id)??exact('0')).minus(covered.get(id)??'0');
    return [id,exact(balance.quantityBase).minus(reserved.get(id)??'0').minus(uncovered.gt(0)?uncovered:'0').minus(heldOnBalance(holds.get(id)??[],id))];
  }));
}
