import { StockReservation, TransferOrder, StockTransaction, DefectReport } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { remainingReservation, heldOnBalance } from './stock.js';

// Read-side selection aid only. Stock commands still recheck in their transaction.
export async function stockQuantities(balances, session) {
  if (!balances.length) return new Map();
  const ids=balances.map(row=>row._id);
  const reads=[
    ()=>StockReservation.find({balanceId:{$in:ids}}).select('balanceId reservedQty consumedQty releasedQty movedQty executionRef').session(session).lean(),
    ()=>TransferOrder.find({workflowStatus:{$in:['OPEN','DRAFT','PARTIAL']},'items.details.sourceBalanceId':{$in:ids}})
      .select('items._id items.qtyBase items.details.sourceBalanceId').session(session).lean(),
    ()=>DefectReport.find({holds:{$elemMatch:{status:'ACTIVE','allocations.balanceId':{$in:ids}}}})
      .select('holds._id holds.status holds.allocations.balanceId holds.allocations.quantityBase holds.events.kind holds.events.quantityBase').session(session).lean(),
  ];
  // A MongoDB transaction does not support parallel operations on one session.
  const [reservations,tasks,reports]=session?[await reads[0](),await reads[1](),await reads[2]()]:await Promise.all(reads.map(read=>read()));
  const transactions=tasks.length?await StockTransaction.find({sourceType:'transfer_orders',sourceId:{$in:tasks.map(row=>row._id)}})
    .select('sourceId movements.sourceLineId movements.fromBalanceId movements.quantityBase').session(session).lean():[];
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
    const reservedQty=reserved.get(id)??exact('0'),pendingQty=uncovered.gt(0)?uncovered:exact('0'),heldQty=heldOnBalance(holds.get(id)??[],id);
    return [id,{reserved:reservedQty,pending:pendingQty,held:heldQty,free:exact(balance.quantityBase).minus(reservedQty).minus(pendingQty).minus(heldQty)}];
  }));
}

export async function freeQuantities(balances) {
  return new Map([...await stockQuantities(balances)].map(([id,quantities])=>[id,quantities.free]));
}
