import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import * as m from '../src/models/runtime.js';
import { PERMISSION_CATALOGUE, ROLE_PERMISSIONS } from '../src/seeds/data/permissions.data.js';
import { createSalesOrder } from '../src/modules/sales-orders/sales-create.service.js';
import { createDeliveryOrder } from '../src/modules/delivery-orders/delivery-order.service.js';
import { updateSalesOrderSchedule } from '../src/modules/sales-orders/sales-schedule.service.js';
import * as issues from '../src/modules/goods-issues/goods-issue.service.js';
import { confirmCustomerReceipt, receiveUndelivered } from '../src/modules/goods-issues/direct-sales.service.js';
import * as sales from '../src/modules/sales-orders/sales-execution.service.js';
import { lookup } from '../src/modules/return-workflows/native.lookup.js';
import { getSalesOrder } from '../src/modules/sales-orders/sales-read.service.js';
import * as returns from '../src/modules/return-workflows/native.service.js';
import { processNotificationEvent } from '../src/modules/notifications/worker.js';
const key = () => new mongoose.Types.ObjectId().toString();
test('direct SO issue, customer receipt, undelivered receipt and return without custody', {skip: process.env.RUN_GOODS_ISSUE_TESTS !== '1'}, async () => {
 await mongoose.connect(`mongodb://127.0.0.1:${process.env.MONGODB_TEST_PORT || 27018}/direct_sales_test_${key()}?replicaSet=${process.env.MONGODB_TEST_REPLICA_SET || 'hieudt-test'}`);
 process.env.JWT_SECRET = 'isolated-goods-issues-secret';
 let server;
 try {
 for (const Model of new Set(Object.values(m).filter(v=>v?.modelName))) { await Model.createCollection(); await Model.createIndexes(); }
    const permissions = await m.Permission.insertMany(PERMISSION_CATALOGUE.map(p => ({ code: p.code, name: p.code })));
    const warehouse = await m.Warehouse.create({ code: 'GI-TEST', name: 'GI test', lengthMm: '10000', widthMm: '10000', clearHeightMm: '3000' });
    const actors = {};
    for (const code of ['OWNER', 'WAREHOUSE', 'SALES', 'ADMIN']) {
      const role = await m.Role.create({ code, name: code, permissionIds: permissions.filter(p => ROLE_PERMISSIONS[code].includes(p.code)).map(p => p._id) });
      const user = await m.User.create({ username: code.toLowerCase(), fullName: code, passwordHash: 'unused', roleId: role._id, warehouseIds: [warehouse._id] });
      actors[code] = await m.User.findById(user._id).populate({ path: 'roleId', populate: { path: 'permissionIds' } });
    }
    const worker = actors.WAREHOUSE, seller = actors.SALES;
    await m.Uom.create({ code: 'PIECE', name: 'Viên' });
    const category = await m.Category.create({ code: 'TILE', name: 'Tile' });
    const product = await m.Product.create({ sku: 'GI-TILE', name: 'Test tile', manufacturerCode: 'TEST', categoryId: category._id, color: 'White', baseUnit: 'PIECE', wholeBaseUnits: true, lengthMm: '600', widthMm: '600', heightMm: '10' });
    const batch = await m.ProductBatch.create({ productId: product._id, manufacturerLot: 'GI-LOT', identificationStatus: 'VERIFIED', piecesPerCarton: 4, cartonLengthMm: '620', cartonWidthMm: '620', cartonHeightMm: '50' });
    const storage = await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: 'ST', locationType: 'STORAGE', isPickable: true, usableLengthMm: '5000', usableWidthMm: '5000' });
    const staging = await m.WarehouseLocation.create({ warehouseId: warehouse._id, code: 'OUT', locationType: 'STAGING', usableLengthMm: '5000', usableWidthMm: '5000' });
    const point = await m.StockHoldingPoint.create({ type: 'LOCATION', locationId: storage._id });
    const balance = await m.InventoryBalance.create({ holdingPointId: point._id, batchId: batch._id, ownerType: 'STORE', qualityStatus: 'GOOD', quantityBase: '16', version: 1,
      packagingPortions: [{ packagingState: 'SEALED', sealedPackCount: 4, quantityBase: '16', packagingSnapshot: { packageUnit: 'BOX', baseUnitsPerPackage: '4', outerLengthMm: '620', outerWidthMm: '620', outerHeightMm: '50' }, createdBy: worker._id }] });
    assert.equal(await m.Customer.countDocuments(), 0);
    const evidenceReceipt = jwt.sign({ actorId: String(seller._id), storageKey: 'sep490/sales-source/test', checksum: 'a'.repeat(64), mediaType: 'image/png', sizeBytes: 12, originalName: 'source.png' }, process.env.JWT_SECRET, { audience: 'sales-source-evidence', expiresIn: '1h' });
    const plannedOn = new Date(Date.now() + 2 * 86400000).toISOString();
    const orderInput = { idempotencyKey: key(), customerName: 'GI customer', customerPhone: '0900000000', neededOn: plannedOn, deliveryAddress: 'Test address', currencyCode: 'VND', evidenceReceipt,
      source: { sourceSystem: 'PAPER', referenceNo: 'GI-TEST-SO' }, lines: [{ sourceLineKey: '1', productId: String(product._id), lotId: String(batch._id), enteredUnit: 'PIECE', quantity: '16', unitSellingPrice: '1000' }],
      deliveries: [{ plannedOn, warehouseId: String(warehouse._id), lines: [{ lineKey: '1', quantity: '16' }] }] };
    const invalid = {...orderInput, idempotencyKey: key(), deliveries: [{ ...orderInput.deliveries[0], lines: [{ lineKey: '1', quantity: '15' }] }]};
    await assert.rejects(createSalesOrder(seller, invalid), /tổng các lần giao/);
    assert.equal(await m.SalesOrder.countDocuments(), 0);
    assert.equal(await m.ExternalReference.countDocuments(), 0);
    assert.equal(await m.StockReservation.countDocuments(), 0);
    const createdOrder = await createSalesOrder(seller, orderInput);
    assert.equal((await createSalesOrder(seller, orderInput)).replayed, true);
    let so = await m.SalesOrder.findById(createdOrder.id);
    assert.equal(so.header.customerName, 'GI customer');
    assert.equal(so.header.customerId, undefined);
    assert.equal(await m.Customer.countDocuments(), 0);
    let schedule = await m.DeliverySchedule.findOne({ salesOrderId: so._id });
    assert.ok(schedule);
    assert.equal(schedule.documentNo.replace(/^LG-/, ''), so.documentNo.replace(/^ĐBH-/, ''));
    const reservation = await m.StockReservation.findById(schedule.deliveries[0].lines[0].allocations[0].reservationId);
    assert.equal(reservation.executionRef.documentId, schedule._id);
    assert.equal(String(reservation.reservedQty), '16');
    const detail = await getSalesOrder(seller, so._id);
    assert.equal(detail.deliverySchedule.documentNo, schedule.documentNo);
    assert.equal(detail.source.referenceNo, 'GI-TEST-SO');
    assert.equal(detail.evidence.length, 1);
    assert.equal((await getSalesOrder(worker, so._id)).deliverySchedule.deliveries.length, 1);
    await assert.rejects(issues.createIssue(worker, { idempotencyKey: key(), expectedVersion: so.version, salesOrderId: String(so._id),
      warehouseId: String(warehouse._id), lines: [{ salesOrderLineId: String(so.items[0]._id), sourceBalanceId: String(balance._id), qtyBase: '8' }] }), /Đơn có lịch giao/);
    const lineId = String(so.items[0]._id);
    await updateSalesOrderSchedule(seller, so._id, {
      idempotencyKey: key(), expectedVersion: so.version, reason: 'Sửa đơn giá',
      lines: [{ lineId, unitSellingPrice: '1200' }],
      deliveries: [{ id: String(schedule.deliveries[0]._id), plannedOn, warehouseId: String(warehouse._id), lines: [{ lineKey: lineId, quantity: '16' }] }],
    });
    so = await m.SalesOrder.findById(so._id);
    schedule = await m.DeliverySchedule.findById(schedule._id);
    assert.equal(String(so.orderAmount), '19200');
    assert.equal(String(schedule.deliveries[0].lines[0].allocations[0].reservationId), String(reservation._id));
    const delivery = await createDeliveryOrder(worker, { idempotencyKey: key(), scheduleId: schedule._id,
      deliveryId: String(schedule.deliveries[0]._id), expectedVersion: schedule.version });
    const deliveryOrder = await m.DeliveryOrder.findById(delivery.id);
    assert.equal(deliveryOrder.header.scheduleId, schedule._id);
    assert.equal(deliveryOrder.header.recipientName, 'GI customer');
    // Turn this isolated test fixture into a historical order for the legacy flow below.
    await m.DeliveryOrder.deleteOne({ _id: deliveryOrder._id });
    await m.StockReservation.deleteOne({ _id: reservation._id });
    await m.DeliverySchedule.deleteOne({ _id: schedule._id });

 const input={idempotencyKey:key(),expectedVersion:so.version,salesOrderId:String(so._id),warehouseId:String(warehouse._id),lines:[{salesOrderLineId:String(so.items[0]._id),sourceBalanceId:String(balance._id),qtyBase:'8'}]};
 await assert.rejects(issues.createIssue(seller,input));
 const made=await issues.createIssue(worker,input);
 assert.equal((await issues.createIssue(worker,input)).replayed,true);
 let issue=await m.SalesGoodsIssue.findById(made.id);
 await issues.postIssue(worker,issue._id,{idempotencyKey:key(),expectedVersion:issue.version,recipientName:'Transporter'});
 assert.equal(await m.TransferOrder.countDocuments(),0);
 assert.equal(await m.DeliveryOrder.countDocuments(),0);
 assert.equal(await m.WarehouseIssueRequest.countDocuments(),0);
 assert.equal(String((await m.InventoryBalance.findById(balance._id)).quantityBase),'8');
 issue=await m.SalesGoodsIssue.findById(issue._id);
 const attach=async doc=>m.Attachment.create({ownerDocumentId:doc._id,ownerDocumentType:doc.constructor.collection.name,purpose:'RETURN_EVIDENCE',uploadedAt:new Date(),originalName:'proof.png',storageKey:'test/proof',checksum:'b'.repeat(64),mediaType:'image/png',sizeBytes:12,status:'ATTACHED',accessCategory:'BUSINESS',uploadedBy:worker._id});
 assert.equal((await issues.getIssue(worker,issue._id)).capabilities.canCreatePicking,false);
 assert.equal((await getSalesOrder(seller,so._id)).goodsIssues.length,1);
 assert.equal((await getSalesOrder(worker,so._id)).goodsIssues.length,1);
 const proof=await attach(issue);
 const confirm={idempotencyKey:key(),expectedVersion:issue.version,recipientName:'Customer',receivedAt:new Date().toISOString(),evidenceIds:[String(proof._id)],lines:[{lineId:String(issue.items[0]._id),qtyBase:'4'}]};
 await assert.rejects(confirmCustomerReceipt(worker,issue._id,confirm));
 await confirmCustomerReceipt(seller,issue._id,confirm);
 issue=await m.SalesGoodsIssue.findById(issue._id);
 assert.ok(issue.customerReceipts[0]._id, 'customer receipt events keep stable identities');
 const back={idempotencyKey:key(),expectedVersion:issue.version,reason:'Customer did not receive',evidenceIds:[String(proof._id)],lines:[{lineId:String(issue.items[0]._id),qtyBase:'4',locationId:String(storage._id),qualityCode:'GOOD'}]};
 await receiveUndelivered(worker,issue._id,back);
 issue=await m.SalesGoodsIssue.findById(issue._id);
 await assert.rejects(confirmCustomerReceipt(seller,issue._id,{...confirm,idempotencyKey:key(),expectedVersion:issue.version}));
 await assert.rejects(receiveUndelivered(worker,issue._id,{...back,idempotencyKey:key(),expectedVersion:issue.version}));
 const sources=await lookup(seller,{kind:'sources',purpose:'customer-returns',warehouseId:String(warehouse._id),page:1,limit:10});
 assert.equal(sources.items.find(r=>r._id===String(issue.items[0]._id)).availableQty,'4');
 const cr=await returns.createCustomerReturn(seller,{idempotencyKey:key(),warehouseId:String(warehouse._id),lines:[{salesIssueLineId:String(issue.items[0]._id),qtyBase:'4',reason:'Not needed'}]});
 let doc=await m.CustomerReturn.findById(cr.id);assert.equal(doc.header.intakeMode,'DIRECT');assert.equal(doc.header.customerName,'GI customer');assert.equal(doc.header.customerPhone,'0900000000');assert.equal(doc.header.customerId,undefined);const claim=await m.ReturnQuantityClaim.findOne({requestLineId:doc.items[0]._id});assert.equal(claim.sourceKind,'GOODS_ISSUE');const ev=await attach(doc);
 await assert.rejects(returns.inspectCustomerReturn(worker,doc._id,{idempotencyKey:key(),expectedVersion:doc.version,evidenceIds:[String(ev._id)],lines:[{returnLineId:String(doc.items[0]._id),qtyReceived:'1.5',packagingCondition:'LOOSE',installationStatus:'UNUSED',damageCause:'NONE',deadlineStatus:'WITHIN',deadlineReference:'Store policy',assessmentReason:'Invalid fractional pieces'}]}));
 await returns.inspectCustomerReturn(worker,doc._id,{idempotencyKey:key(),expectedVersion:doc.version,evidenceIds:[String(ev._id)],lines:[{returnLineId:String(doc.items[0]._id),qtyReceived:'4',packagingCondition:'SEALED',installationStatus:'UNUSED',damageCause:'NONE',deadlineStatus:'WITHIN',deadlineReference:'Store policy',assessmentReason:'Good'}]});
 assert.equal(await m.CustodyReceipt.countDocuments(),0);
 assert.equal(await m.InventoryBalance.countDocuments({ownerType:'CUSTOMER'}),0);
 doc=await m.CustomerReturn.findById(doc._id);
 await returns.decideCustomerReturn(seller,doc._id,{idempotencyKey:key(),expectedVersion:doc.version,decision:'APPROVE',reason:'Eligible',lines:[{lineId:String(doc.items[0]._id),qtyBase:'4'}]});
 doc=await m.CustomerReturn.findById(doc._id);
 await returns.receiveCustomerReturn(worker,doc._id,{idempotencyKey:key(),expectedVersion:doc.version,evidenceIds:[String(ev._id)],lines:[{lineId:String(doc.items[0]._id),qtyBase:'4',locationId:String(storage._id),qualityCode:'GOOD'}]});
 await assert.rejects(returns.inspectCustomerReturn(worker,doc._id,{idempotencyKey:key(),expectedVersion:doc.version+1,evidenceIds:[String(ev._id)],lines:[]},true));
 assert.equal(await m.CustodyReceipt.countDocuments(),0);
 assert.equal(await m.CustomerReturnReceipt.countDocuments({workflowStatus:'POSTED'}),1);
 assert.equal(String((await m.InventoryBalance.findById(balance._id)).quantityBase),'16');
 const currentOrder=await m.SalesOrder.findById(so._id);
 const second=await issues.createIssue(worker,{...input,idempotencyKey:key(),expectedVersion:currentOrder.version});
 let gi=await m.SalesGoodsIssue.findById(second.id);
 await assert.rejects(sales.cancelSalesRemainder(seller,so._id,{idempotencyKey:key(),expectedVersion:currentOrder.version+1,reason:'Too much',lines:[{lineId:String(so.items[0]._id),qtyBase:'8'}]}));
 await issues.postIssue(worker,gi._id,{idempotencyKey:key(),expectedVersion:gi.version,recipientName:'Transporter'});
 gi=await m.SalesGoodsIssue.findById(gi._id);const ep=await attach(gi);
 const race=await Promise.allSettled([confirmCustomerReceipt(seller,gi._id,{...confirm,idempotencyKey:key(),expectedVersion:gi.version,receivedAt:new Date().toISOString(),evidenceIds:[String(ep._id)],lines:[{lineId:String(gi.items[0]._id),qtyBase:'4'}]}),receiveUndelivered(worker,gi._id,{...back,idempotencyKey:key(),expectedVersion:gi.version,evidenceIds:[String(ep._id)],lines:[{lineId:String(gi.items[0]._id),qtyBase:'8',locationId:String(storage._id),qualityCode:'GOOD'}]})]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 const thirdOrder=await m.SalesOrder.findById(so._id);
 const third=await issues.createIssue(worker,{...input,idempotencyKey:key(),expectedVersion:thirdOrder.version,lines:[{...input.lines[0],qtyBase:'4'}]});
 let thirdIssue=await m.SalesGoodsIssue.findById(third.id);
 await issues.postIssue(worker,thirdIssue._id,{idempotencyKey:key(),expectedVersion:thirdIssue.version,recipientName:'Transporter'});
 thirdIssue=await m.SalesGoodsIssue.findById(thirdIssue._id);const thirdProof=await attach(thirdIssue);
 await confirmCustomerReceipt(seller,thirdIssue._id,{...confirm,idempotencyKey:key(),expectedVersion:thirdIssue.version,receivedAt:new Date().toISOString(),evidenceIds:[String(thirdProof._id)],lines:[{lineId:String(thirdIssue.items[0]._id),qtyBase:'4'}]});
 const custodyLocation=await m.WarehouseLocation.create({warehouseId:warehouse._id,code:'LEGACY-CUSTODY',locationType:'CUSTODY',usableLengthMm:'5000',usableWidthMm:'5000'});
 await assert.rejects(returns.createCustomerReturn(seller,{idempotencyKey:key(),warehouseId:String(warehouse._id),lines:[{salesIssueLineId:String(thirdIssue.items[0]._id),qtyBase:'1',reason:'First source'},{salesIssueLineId:String(issue.items[0]._id),qtyBase:'1',reason:'Other source'}]}), /Mỗi phiếu trả chỉ dùng một chứng từ nguồn/);
 for(const legacy of [false,true]) {
   const rejected=await returns.createCustomerReturn(seller,{idempotencyKey:key(),warehouseId:String(warehouse._id),lines:[{salesIssueLineId:String(thirdIssue.items[0]._id),qtyBase:'2',reason:'Review rejected handback'}]});
   let rd=await m.CustomerReturn.findById(rejected.id);
   if(legacy){const oldCustomer=await m.Customer.create({code:'LEGACY',name:'Legacy custody customer',phone:'0900000001'});rd.header.customerId=oldCustomer._id;rd.header.intakeMode=undefined;await rd.save();}
   const rp=await attach(rd),inspection={idempotencyKey:key(),expectedVersion:rd.version,evidenceIds:[String(rp._id)],...(legacy&&{custodyLocationId:String(custodyLocation._id)}),lines:[{returnLineId:String(rd.items[0]._id),qtyReceived:'2',packagingCondition:'LOOSE',installationStatus:'UNUSED',damageCause:'NONE',deadlineStatus:'WITHIN',deadlineReference:'Verified policy',assessmentReason:'Returned goods'}]};
   await returns.inspectCustomerReturn(worker,rd._id,inspection);
   rd=await m.CustomerReturn.findById(rd._id);
   await returns.decideCustomerReturn(seller,rd._id,{idempotencyKey:key(),expectedVersion:rd.version,decision:'REJECT',reason:'Customer withdrew request'});
   rd=await m.CustomerReturn.findById(rd._id);
   const before=await m.StockTransaction.countDocuments();
   const handback={idempotencyKey:key(),expectedVersion:rd.version,evidenceIds:[String(rp._id)],recipientName:'Customer',lines:[{lineId:String(rd.items[0]._id),qtyBase:'2'}]};
   await returns.receiveCustomerReturn(worker,rd._id,handback,true);
   assert.equal(await m.StockTransaction.countDocuments(),before+(legacy?1:0));
   rd=await m.CustomerReturn.findById(rd._id);
   if(!legacy){assert.equal(rd.handbacks.length,1);assert.ok(rd.handbacks[0]._id, 'handback events keep stable identities');}
   await assert.rejects(returns.receiveCustomerReturn(worker,rd._id,{...handback,idempotencyKey:key(),expectedVersion:rd.version},true));
   if(!legacy)await assert.rejects(returns.inspectCustomerReturn(worker,rd._id,{...inspection,idempotencyKey:key(),expectedVersion:rd.version},true));
 }
 thirdIssue=await m.SalesGoodsIssue.findById(thirdIssue._id);
 thirdIssue.header.fulfillmentMode=undefined;thirdIssue.header.salesOrderId=undefined;thirdIssue.header.customerId=undefined;thirdIssue.header.issueKind='SALE';thirdIssue.header.referenceNo='LEGACY-MANUAL-SALE';thirdIssue.customerReceipts=[];thirdIssue.createdBy=worker._id;
 await thirdIssue.save();
 const standaloneSources=await lookup(seller,{kind:'sources',purpose:'customer-returns',warehouseId:String(warehouse._id),documentId:String(thirdIssue._id),page:1,limit:10});
 assert.equal(standaloneSources.items[0]?.availableQty,'4','Sales can use a warehouse-created standalone SALE issue as the return source');
 const standaloneReturn=await returns.createCustomerReturn(seller,{idempotencyKey:key(),warehouseId:String(warehouse._id),customerName:'Goods issue customer',lines:[{salesIssueLineId:String(thirdIssue.items[0]._id),qtyBase:'3',reason:'No Sales Order'}]});
 const standaloneDoc=await m.CustomerReturn.findById(standaloneReturn.id);
 assert.equal(standaloneDoc.header.customerName,'Goods issue customer');assert.equal(standaloneDoc.header.customerId,undefined);
 await assert.rejects(returns.createCustomerReturn(seller,{idempotencyKey:key(),warehouseId:String(warehouse._id),customerName:'Goods issue customer',lines:[{salesIssueLineId:String(thirdIssue.items[0]._id),qtyBase:'2',reason:'Over remaining issue quantity'}]}),/Vượt lượng khách đã nhận còn được trả/);
 const {default:app}=await import('../src/app.js');
 server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
 const http=async(actor,path)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{headers:{authorization:'Bearer '+jwt.sign({userId:String(actor._id)},process.env.JWT_SECRET)}});return {status:response.status,body:await response.json()};};
 assert.equal((await http(worker,'/goods-issues/direct-options')).status,200);
 const manualResponse=await fetch('http://127.0.0.1:'+server.address().port+'/api/goods-issues',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+jwt.sign({userId:String(seller._id)},process.env.JWT_SECRET)},body:JSON.stringify({idempotencyKey:key(),expectedVersion:1,issueKind:'SALE',warehouseId:String(warehouse._id),referenceNo:'MISA-OLD',lines:[{productId:String(product._id),qtyBase:'4'}]})});assert.equal(manualResponse.status,400);
 assert.equal((await http(seller,'/goods-issues/'+encodeURIComponent(issue._id))).status,200);
 const lookupEvidence=await http(seller,'/return-workflows/lookup?kind=evidence&documentId='+encodeURIComponent(issue._id)+'&page=1&limit=10');assert.equal(lookupEvidence.status,200);
 assert.equal((await http(worker,'/goods-issues?salesOrderId='+encodeURIComponent(so._id))).status,200);
 const cutoff = new Date(0);
 assert.equal(await processNotificationEvent(new Date(Date.now() + 60_000)), false);
 while (await processNotificationEvent(cutoff)) {}
 const inbox = await http(seller, '/notifications');
 assert.equal(inbox.status, 200);
 const notices = inbox.body.data.items.filter(item => item.href === '/goods-issues/' + issue._id);
 assert.equal(notices.length, 2);
 const notice = notices[0];
 const countBefore = (await http(seller, '/notifications/unread-count')).body.data.count;
 const markRead = actor => fetch('http://127.0.0.1:' + server.address().port + '/api/notifications/' + notice.id + '/read', {
   method: 'POST', headers: { authorization: 'Bearer ' + jwt.sign({userId:String(actor._id)},process.env.JWT_SECRET) },
 });
 assert.equal((await markRead(worker)).status, 404);
 assert.equal((await markRead(seller)).status, 200);
 assert.equal((await http(seller, '/notifications/unread-count')).body.data.count, countBefore - 1);
 const persisted = await m.Notification.findById(notice.id);
 await m.SystemEvent.updateOne({ eventKey: persisted.eventKey }, { $set: { status: 'PENDING' } });
 assert.equal(await processNotificationEvent(cutoff), true);
 assert.equal(await m.Notification.countDocuments({ dedupKey: persisted.dedupKey }), 1);
 assert.equal(+(await m.Notification.findById(notice.id)).readAt, +persisted.readAt);
 await m.User.updateOne({ _id: seller._id }, { $set: { warehouseIds: [] } });
 assert.equal((await http(seller, '/notifications/unread-count')).body.data.count, 0);
 assert.equal((await markRead(seller)).status, 404);
 } finally { if(server) await new Promise(resolve=>server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
