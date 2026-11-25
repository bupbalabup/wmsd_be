// 25/11/2026: documents no longer store Vietnamese copies of their code parts and status.
// Preview by default; `--apply` writes. Local MongoDB only (remote needs an explicit rollout).
// Approval and operation snapshots keep what they recorded and are not touched.
import mongoose from 'mongoose';
import {LOCAL_DEMO_URI,requireLoopbackMongoUri} from '../src/config/local-mongo.js';

const fields=['tenLoaiPhieu','maDonVi','kyDanhSo','soThuTu','trangThaiTiengViet'];
// '' is the document itself; the other entries are embedded document arrays.
const targets={
  replenishment_requests:[''],purchase_orders:[''],goods_arrivals:[''],goods_inspections:[''],goods_receipts:[''],
  transfer_orders:[''],warehouse_transfer_requests:[''],internal_transfer_requirements:[''],
  transfer_dispatches:['','handovers'],sales_orders:['','paymentConfirmations','deliveryConfirmations'],
  warehouse_issue_requests:[''],delivery_orders:[''],sales_goods_issues:['','handovers'],
  defect_reports:['','resolutionPlans'],stock_scrap_records:[''],stocktakes:['','resolutionPlans'],
  stock_adjustments:[''],failed_deliveries:[''],stock_quality_changes:[''],customer_returns:[''],supplier_returns:[''],
  supplier_return_issues:['','acknowledgements'],stock_discrepancies:[''],custody_receipts:[''],
  custody_releases:['','acknowledgements'],stock_reversals:[''],opening_stocks:[''],stocktake_plans:[''],
};

const uri=process.env.MONGODB_URI||LOCAL_DEMO_URI;
requireLoopbackMongoUri(uri);
const apply=process.argv.includes('--apply');
const client=new mongoose.mongo.MongoClient(uri,{serverSelectionTimeoutMS:10000});
try{
  await client.connect();
  const db=client.db(),rows=[];
  for(const [collection,paths] of Object.entries(targets)) for(const path of paths) {
    const filter={$or:fields.map(field=>({[path?`${path}.${field}`:field]:{$exists:true}}))};
    const found=await db.collection(collection).countDocuments(filter);
    if(!found)continue;
    const unset=Object.fromEntries(fields.map(field=>[path?`${path}.$[].${field}`:field,'']));
    const modified=apply?(await db.collection(collection).updateMany(filter,{$unset:unset})).modifiedCount:0;
    const remaining=apply?await db.collection(collection).countDocuments(filter):found;
    rows.push({target:path?`${collection}.${path}`:collection,found,modified,remaining});
  }
  console.log(JSON.stringify({database:db.databaseName,applied:apply,
    documents:rows.reduce((sum,row)=>sum+row.found,0),remaining:rows.reduce((sum,row)=>sum+row.remaining,0),rows},null,2));
  if(apply&&rows.some(row=>row.remaining))process.exitCode=1;
}finally{await client.close();}
