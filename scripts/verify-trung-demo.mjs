import mongoose from 'mongoose';
import { readFile, writeFile } from 'node:fs/promises';
import * as m from '../src/models/runtime.js';
import { exact } from '../src/models/model-utils.js';
const uri='mongodb://127.0.0.1:27017/wmsd_demo_trung_20261112?replicaSet=rs0';
const manifest=JSON.parse(await readFile('.local/trung-demo/manifest.json','utf8'));
const report={database:manifest.database,schemas:0,ledgerErrors:[],http:[]};
await mongoose.connect(uri,{autoCreate:false,autoIndex:false});
try {
  for(const [,Model] of m.models)for(const doc of await Model.find()){await doc.validate();report.schemas++;}
  const balances=await m.InventoryBalance.find(),transactions=await m.StockTransaction.find();
  for(const balance of balances){
    let quantity=exact('0');
    for(const transaction of transactions)for(const movement of transaction.movements){
      if(String(movement.toBalanceId)===balance.id)quantity=quantity.plus(String(movement.quantityBase));
      if(String(movement.fromBalanceId)===balance.id)quantity=quantity.minus(String(movement.quantityBase));
    }
    if(!quantity.eq(String(balance.quantityBase)))report.ledgerErrors.push({id:balance.id,balance:String(balance.quantityBase),ledger:quantity.toFixed()});
  }
  report.balances=balances.length;report.stockTransactions=transactions.length;
  if(report.ledgerErrors.length)throw new Error('Local stock ledger mismatch');
  const base='http://127.0.0.1:3334/api';
  const health=await fetch(base+'/health');
  if(health.headers.get('x-wmsd-demo-database')!==manifest.database)throw new Error('Frontend proxy does not identify the expected local database');
  for(const [role,password,resources] of [
    ['warehouse','Kho@12345678',['defects','customer-returns','failed-deliveries','supplier-returns']],
    ['sales','Sales@123',['customer-returns']],['owner','Owner@123',['defects','customer-returns']],
    ['accountant','KeToan@123',['supplier-returns','external-references']],
  ]){
    const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:role+'@ceratile.vn',password})});
    if(!login.ok)throw new Error(`${role} login failed`);
    const body=await login.json(),headers={Authorization:'Bearer '+body.data.accessToken};
    for(const resource of resources){
      const response=await fetch(base+'/'+resource,{headers}),body=await response.json();
      if(!response.ok||!body.data.length)throw new Error(`${role}/${resource} has no usable list`);
      report.http.push({role,path:resource,status:response.status,records:body.meta?.total??body.data.length});
    }
    if(role==='warehouse'){
      const url=base+'/defects/'+encodeURIComponent(manifest.records['defect-approved'].id);
      const response=await fetch(url,{headers}),body=await response.json();
      if(!response.ok||!body.data.evidence?.length)throw new Error('Prepared detail/evidence missing');
      const evidence=await fetch(base+'/return-workflows/'+encodeURIComponent(body.data._id)+'/evidence/'+body.data.evidence[0]._id,{headers});
      const stored=await evidence.json();
      if(!evidence.ok||!stored.data.url)throw new Error('Evidence URL unavailable');
      const download=await fetch(stored.data.url);
      if(!download.ok)throw new Error('Synthetic stored evidence cannot be downloaded');
      report.http.push({role,path:'synthetic evidence download',status:download.status});
      const trace=await fetch(base+'/lots/'+manifest.setup.lotId+'/trace/records?section=movements&page=1&limit=10',{headers});
      if(!trace.ok)throw new Error('Lot trace failed');
      report.http.push({role,path:'lot trace movements',status:trace.status});
      const sources=await fetch(base+'/return-workflows/lookup?kind=sources&purpose=failed-deliveries&warehouseId='+manifest.setup.warehouseId+'&search='+encodeURIComponent(manifest.records['fd-create-source-source'].code)+'&page=1&limit=10',{headers});
      const candidates=await sources.json();
      if(!sources.ok||!candidates.data.some(row=>exact(row.availableQty??'0').gte('4')))throw new Error('Fresh failed-delivery source unavailable');
      report.http.push({role,path:'new FD source lookup',status:sources.status});
    }
  }
  report.verifiedAt=new Date().toISOString();
  await writeFile('.local/trung-demo/verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await mongoose.disconnect();}
