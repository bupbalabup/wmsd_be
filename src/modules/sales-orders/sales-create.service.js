import { nextDocumentFields, pairedDocumentFields } from '../../shared/utils/document-number.js';
import { SalesOrder, DeliverySchedule, Customer, Warehouse, Product } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { command, newId } from '../../shared/utils/document-command.js';
import { makeItem } from '../../shared/utils/document-items.js';
import { vnDay, vnMidnight } from '../../shared/utils/vn-date.js';
import { orderSource } from './sales-read.service.js';
import { allocateAndReserve } from './sales-schedule.service.js';

// One call creates the order, its delivery schedule and the stock holds, or nothing.
export function createSalesOrder(user, input) {
  return command(user, 'CREATE_SALES_ORDER', 'sales_order:create', null, input, (id, actor, session) => orderSource(actor, id, session, { replay: true }), async (session, actor) => {
    if (!await Customer.exists({ _id: input.customerId }).session(session)) throw validationError('Khách hàng không hợp lệ');
    const pairs = input.lines.map(line => `${line.productId}:${line.lotId}`);
    if (new Set(pairs).size !== pairs.length) throw validationError('Hai dòng không được trùng sản phẩm và lô');
    const numbers = await nextDocumentFields(SalesOrder, 'SO', null, session);
    const order = new SalesOrder({ ...numbers, workflowStatus: 'OPEN', version: 1, createdBy: actor._id,
      header: { customerId: input.customerId, deliveryAddressSnapshot: input.deliveryAddress, recipientName: input.recipientName, recipientPhone: input.recipientPhone },
      ...(input.note && { note: input.note }), items: [], currencyCode: input.currencyCode, orderAmount: input.orderAmount });
    const rows = new Map();
    for (const [index, line] of input.lines.entries()) {
      const item = await makeItem({ ...line, enteredQty: line.quantity }, index + 1, session, { lineKind: 'SALES_ORDER' });
      const price = line.unitSellingPrice == null ? {} : { unitSellingPrice: line.unitSellingPrice, lineAmount: exact(line.unitSellingPrice).mul(item.enteredQty).toFixed(), priceRevision: 1 };
      order.items.push({ ...item, ...price, details: {} });
      rows.set(line.clientLineKey, { soLine: order.items[index], whole: (await Product.findById(item.productId).select('wholeBaseUnits').session(session).lean())?.wholeBaseUnits });
    }
    const warehouses = new Map((await Warehouse.find({ _id: { $in: input.deliveries.map(d => d.warehouseId) }, isActive: true }).session(session).lean()).map(w => [String(w._id), w]));
    const today = vnDay();
    const planned = input.deliveries.map((d, index) => ({ ...d, day: vnDay(d.plannedOn), index })).sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
    const totals = new Map();
    const scheduleId = numbers._id;
    const deliveries = planned.map((d, i) => {
      if (d.day < today) throw validationError(`Lần giao ${i + 1}: ngày giao không được sớm hơn hôm nay`);
      const warehouse = warehouses.get(String(d.warehouseId));
      if (!warehouse) throw validationError(`Lần giao ${i + 1}: kho không hoạt động`);
      if (new Set(d.lines.map(l => l.lineKey)).size !== d.lines.length) throw validationError(`Lần giao ${i + 1}: dòng bị lặp`);
      const lines = d.lines.map(l => {
        const row = rows.get(l.lineKey);
        if (!row) throw validationError(`Lần giao ${i + 1}: dòng ${l.lineKey} không có trong SO`);
        const qtyBase = exact(l.quantity).mul(String(row.soLine.baseUnitsPerUnit));
        if (!qtyBase.gt(0) || qtyBase.decimalPlaces() > 6 || (row.whole && !qtyBase.isInteger())) throw validationError(`Lần giao ${i + 1}: số lượng không quy đổi chính xác sang đơn vị gốc`);
        totals.set(l.lineKey, (totals.get(l.lineKey) ?? exact('0')).plus(qtyBase));
        return { _id: newId(), soLineId: row.soLine._id, lotId: row.soLine.lotId, qtyBase: qtyBase.toFixed(), allocations: [], soLine: row.soLine };
      });
      return { _id: newId(), seq: i + 1, plannedOn: vnMidnight(d.day), warehouseId: d.warehouseId, status: 'PLANNED', lines, warehouse };
    });
    for (const [key, { soLine }] of rows)
      if (!(totals.get(key) ?? exact('0')).eq(String(soLine.qtyBase))) throw validationError(`Dòng ${key}: tổng các lần giao ${(totals.get(key) ?? exact('0')).toFixed()} khác số lượng SO ${soLine.qtyBase} (đơn vị gốc)`);
    for (const delivery of deliveries)
      for (const line of delivery.lines) await allocateAndReserve({ order, scheduleId, delivery, line, soLine: line.soLine, warehouse: delivery.warehouse, actor, session });
    const { _id, documentNo } = pairedDocumentFields('DS', numbers);
    const schedule = new DeliverySchedule({ _id, documentNo, version: 1, createdBy: actor._id, salesOrderId: order._id,
      deliveries: deliveries.map(({ warehouse, lines, ...d }) => ({ ...d, lines: lines.map(({ soLine, ...l }) => l) })) });
    await order.save({ session });
    await schedule.save({ session });
    return { document: order, resultRefs: [{ documentType: 'delivery_schedules', documentId: schedule._id }] };
  });
}
