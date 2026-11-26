import { nextDocumentFields, pairedDocumentFields } from '../../shared/utils/document-number.js';
import jwt from 'jsonwebtoken';
import { SalesOrder, ExternalReference, Attachment, DeliverySchedule, Warehouse, Product, Uom } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { cloudinary } from '../../config/cloudinary.js';
import { requirePermission } from '../../shared/utils/access.js';
import { validationError, forbiddenError } from '../../shared/utils/ApiError.js';
import { command, newId } from '../../shared/utils/document-command.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { orderSource } from './sales-read.service.js';
import { vnDay, vnMidnight } from '../../shared/utils/vn-date.js';
import { toBaseQuantity } from '../../shared/utils/conversions.js';
import { allocateAndReserve } from './sales-schedule.service.js';
import { createHash } from 'node:crypto';
const secret=()=>process.env.JWT_SECRET||'wmsd_default_super_secret_jwt_key_2026';
export async function uploadSourceEvidence(user,file){
  requirePermission(user,'sales_order:create');if(!file)throw validationError('Thiếu ảnh đơn nguồn');
  const bytes=file.buffer,png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!png&&!jpeg&&!webp)throw validationError('Chỉ nhận PNG, JPEG hoặc WebP');
  const stored=await new Promise((resolve,reject)=>cloudinary.uploader.upload_stream({folder:'sep490/sales-source',resource_type:'image',type:'authenticated',timeout:20000},(error,result)=>error?reject(error):resolve(result)).end(bytes));
  const receipt=jwt.sign({actorId:String(user._id),storageKey:stored.public_id,checksum:createHash('sha256').update(bytes).digest('hex'),mediaType:png?'image/png':jpeg?'image/jpeg':'image/webp',sizeBytes:bytes.length,originalName:file.originalname},secret(),{algorithm:'HS256',audience:'sales-source-evidence',expiresIn:'24h'});
  return {receipt};
}
export function createSalesOrder(user,input){
  return command(user,'CREATE_SALES_ORDER','sales_order:create',null,input,(id,actor,session)=>orderSource(actor,id,session,{ replay: true }),async(session,actor)=>{
    let evidence;
    if(input.evidenceReceipt){
      try{evidence=jwt.verify(input.evidenceReceipt,secret(),{algorithms:['HS256'],audience:'sales-source-evidence'});}catch{throw validationError('Bằng chứng không hợp lệ hoặc hết hạn');}
      if(evidence.actorId!==String(actor._id))throw forbiddenError('Bằng chứng không thuộc người tạo');
    }
    const numbers=await nextDocumentFields(SalesOrder, 'SO', null, session);
    // Without a source document the request is its own reference (typed from the customer's slip).
    const reference=new ExternalReference({...(input.source??{sourceSystem:'PAPER',referenceNo:numbers.documentNo}),referenceKind:'SALES_ORDER',correlationId:'so:'+newId(),items:[]});
    const order=new SalesOrder({...numbers,workflowStatus:'OPEN',version:1,createdBy:actor._id,
      externalReferenceIds:[reference._id],header:{externalReferenceId:reference._id,customerName:input.customerName,customerPhone:input.customerPhone,neededOn:input.neededOn??new Date().toISOString(),deliveryAddressSnapshot:input.deliveryAddress},
      items:[],currencyCode:input.currencyCode,orderAmount:'0'});
    const rows=new Map();
    const productLots=new Set();
    let amount=exact('0');
    for(const [index,rawLine]of input.lines.entries()){
      const baseUnit=rawLine.enteredUnit?undefined:(await Product.findById(rawLine.productId).select('baseUnit').session(session).lean())?.baseUnit;
      const line={...rawLine,sourceLineKey:rawLine.sourceLineKey??String(index+1),enteredUnit:rawLine.enteredUnit??baseUnit};
      const item=await makeItem({...line,enteredQty:line.quantity},index+1,session,{lineKind:'SALES_ORDER'});
      const pair=`${item.productId}:${item.lotId}`;
      if(productLots.has(pair))throw validationError(item.lotId?'Hai dòng không được trùng sản phẩm và lô':'Mỗi sản phẩm chỉ nhập một dòng');
      productLots.add(pair);
      const product=await Product.findById(item.productId).select('wholeBaseUnits').session(session).lean();
      const uom=await Uom.findOne({code:item.enteredUnit}).session(session).lean();
      const externalLine={_id:newId(),lineKey:line.sourceLineKey,productId:item.productId,eligibleQty:item.qtyBase};reference.items.push(externalLine);
      const lineAmount=exact(line.unitSellingPrice).mul(item.enteredQty);amount=amount.plus(lineAmount);
      order.items.push({...item,unitSellingPrice:line.unitSellingPrice,lineAmount:lineAmount.toFixed(),priceRevision:1,
        details:{externalReferenceId:reference._id,externalLineId:externalLine._id}});
      rows.set(line.sourceLineKey,{soLine:order.items[index],product,uom});
    }
    order.orderAmount=amount.toFixed();
    // Delivery plan and stock reservation only when the caller supplies deliveries; otherwise Warehouse issues directly from the request.
    let schedule;
    if (input.deliveries?.length) {
    const warehouses = new Map((await Warehouse.find({ _id: { $in: input.deliveries.map(d => d.warehouseId) }, isActive: true }).session(session).lean()).map(w => [String(w._id), w]));
    const today = vnDay();
    const planned = input.deliveries.map((d, index) => ({ ...d, day: vnDay(d.plannedOn), index })).sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
    const totals = new Map();
    const { _id: scheduleId, documentNo } = pairedDocumentFields('DS', numbers);
    const deliveries = planned.map((d, i) => {
      if (d.day < today) throw validationError(`Lần giao ${i + 1}: ngày giao không được sớm hơn hôm nay`);
      const warehouse = warehouses.get(String(d.warehouseId));
      if (!warehouse) throw validationError(`Lần giao ${i + 1}: kho không hoạt động`);
      if (new Set(d.lines.map(l => l.lineKey)).size !== d.lines.length) throw validationError(`Lần giao ${i + 1}: dòng bị lặp`);
      const lines = d.lines.map(l => {
        const row = rows.get(l.lineKey);
        if (!row) throw validationError(`Lần giao ${i + 1}: dòng ${l.lineKey} không có trong SO`);
        const qtyBase = toBaseQuantity(l.quantity, String(row.soLine.baseUnitsPerUnit), row.product, row.uom);
        if (!qtyBase.gt(0) || qtyBase.decimalPlaces() > 6 || (row.product.wholeBaseUnits && !qtyBase.isInteger())) throw validationError(`Lần giao ${i + 1}: số lượng không quy đổi chính xác sang đơn vị gốc`);
        totals.set(l.lineKey, (totals.get(l.lineKey) ?? exact('0')).plus(qtyBase));
        return { _id: newId(), soLineId: row.soLine._id, lotId: row.soLine.lotId, qtyBase: qtyBase.toFixed(), allocations: [], soLine: row.soLine };
      });
      return { _id: newId(), seq: i + 1, plannedOn: vnMidnight(d.day), warehouseId: d.warehouseId, status: 'PLANNED', lines, warehouse };
    });
    for (const [key, { soLine }] of rows)
      if (!(totals.get(key) ?? exact('0')).eq(String(soLine.qtyBase))) throw validationError(`Dòng ${key}: tổng các lần giao ${(totals.get(key) ?? exact('0')).toFixed()} khác số lượng SO ${soLine.qtyBase} (đơn vị gốc)`);
    for (const delivery of deliveries)
      for (const line of delivery.lines) await allocateAndReserve({ order, scheduleId, delivery, line, soLine: line.soLine, warehouse: delivery.warehouse, actor, session });
    schedule = new DeliverySchedule({ _id: scheduleId, documentNo, version: 1, createdBy: actor._id, salesOrderId: order._id,
      deliveries: deliveries.map(({ warehouse, lines, ...d }) => ({ ...d, lines: lines.map(({ soLine, ...l }) => l) })) });
    }
    // Recording a source does not invent D07/D08 verification or its approver.
    await reference.save({session});
    if(evidence){
      const attachment=await new Attachment({ownerDocumentType:'sales_orders',ownerDocumentId:order._id,ownerRevision:1,purpose:'SOURCE_ORDER',
        originalName:evidence.originalName,mediaType:evidence.mediaType,sizeBytes:evidence.sizeBytes,storageKey:evidence.storageKey,checksum:evidence.checksum,
        uploadedBy:actor._id,uploadedAt:new Date(evidence.iat*1000),accessCategory:'SALES_PRICE',status:'ATTACHED'}).save({session});
      order.evidenceIds=[attachment._id];
    }
    await order.save({session});
    if(!schedule)return {document:order,resultRefs:[]};
    await schedule.save({session});
    return {document:order,resultRefs:[{documentType:'delivery_schedules',documentId:schedule._id}]};
  });
}
