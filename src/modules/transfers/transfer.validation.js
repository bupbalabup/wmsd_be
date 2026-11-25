import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { movementListFields, validDateRange } from '../../shared/utils/movement-list.js';
import { z } from 'zod';
import { exact } from '../../models/model-utils.js';

const oid = z.string().regex(/^[a-f\d]{24}$/i).transform((v) => v.toLowerCase());
const qty = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/).refine((v) => exact(v).gt(0)).transform((v) => exact(v).toFixed());
const key = z.string().trim().min(1).max(48).regex(/^[\w.-]+$/);
const version = z.number().int().min(1);
const reason = z.string().trim().min(1).max(2000);
const unique = (field) => (rows) => new Set(rows.map((r) => r[field])).size === rows.length;
const requestLine = z.object({
  productId: oid, enteredUnit: z.string().trim().min(1).max(60), lotId: oid.optional(), enteredQty: qty,
  sourceLocations: z.array(z.object({ sourceBalanceId: oid, qtyBase: qty }).strict())
    .max(100).refine(unique('sourceBalanceId')).optional(),
}).strict().refine((line) => !line.sourceLocations?.length || !!line.lotId, { message: 'Chọn lô trước khi phân bổ vị trí nguồn' });
export const createRequestBody = z.object({ idempotencyKey: key, sourceWarehouseId: oid, destinationWarehouseId: oid,
  reason, neededOn: z.iso.datetime({ offset: true }).optional(),
  lines: z.array(requestLine).min(1).max(100).refine(unique('productId')),
}).strict().refine((v) => v.sourceWarehouseId !== v.destinationWarehouseId);
const approvedQty = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/).transform((v) => exact(v).toFixed());
// `reason` stays required for REJECT/REVISE; for APPROVE it may be omitted. `lines` optionally lowers the approved quantity per request line (0 drops the line).
export const reviewBody = z.object({ idempotencyKey: key, expectedVersion: version, decision: z.enum(['APPROVE', 'REJECT', 'REVISE']), reason: reason.optional(),
  lines: z.array(z.object({ lineId: oid, approvedQtyBase: approvedQty }).strict()).max(100).refine(unique('lineId')).optional(),
}).strict().refine((v) => v.decision === 'APPROVE' || !!v.reason, { message: 'Nhập lý do', path: ['reason'] })
  .refine((v) => v.decision === 'APPROVE' || !v.lines, { message: 'Chỉ chỉnh lượng khi duyệt', path: ['lines'] });
export const dispatchBody = z.object({ idempotencyKey: key, expectedVersion: version,
  // Required when a request line without a fixed lot would be supplied from several lots (tone/size may differ).
  acceptMixedLots: z.boolean().optional(),
  lines: z.array(z.object({ requestLineId: oid, sourceBalanceId: oid, stagingLocationId: oid, qtyBase: qty }).strict()).min(1).max(100),
}).strict();
export const requirementBody = z.object({ idempotencyKey: key, expectedVersion: version,
  // PICK only: the warehouse staff member who will pick and hand over (defaults to the creator).
  assigneeId: oid.optional(),
  // Omit destinations to open/reuse a waiting PUTAWAY task for a historical receipt.
  destinations: z.array(z.object({ receiptLineId: oid, locationId: oid }).strict()).max(100).refine(unique('receiptLineId')).optional(),
}).strict();
export const commandBody = z.object({ idempotencyKey: key, expectedVersion: version, recipientName:z.string().trim().min(1).max(160).optional(), vehiclePlate:z.string().trim().min(1).max(20).optional() }).strict();
export const taskConfirmBody=commandBody.extend({
  driverName:z.string().trim().min(1).max(160).optional(),driverPhone:z.string().trim().min(1).max(30).optional(),note:z.string().trim().min(1).max(500).optional(),
  // PICK only: quantity really picked per task line when it is lower than planned; needs shortReason.
  pickedLines:z.array(z.object({taskLineId:oid,pickedQtyBase:z.string().regex(/^\d{1,14}(\.\d{1,6})?$/)}).strict()).max(100).refine(unique('taskLineId')).optional(),
  shortReason:z.string().trim().min(1).max(500).optional(),destinations:z.array(z.object({receiptLineId:oid,locationId:oid}).strict()).min(1).max(100).refine(unique('receiptLineId')).optional()});
export const receiptBody = z.object({ idempotencyKey: key, expectedVersion: version,
  lines: z.array(z.object({ dispatchLineId: oid, locationId: oid, qtyBase: qty,
    qualityCode: z.enum(['GOOD', 'DAMAGED']), damageReason: z.string().trim().min(1).max(1000).optional(),
  }).strict().refine((v) => v.qualityCode !== 'DAMAGED' || Boolean(v.damageReason))).min(1).max(100),
}).strict();
export const updateRequestBody = createRequestBody.safeExtend({ expectedVersion: version });

export const cancelDispatchBody=z.object({idempotencyKey:key,expectedVersion:version,reason}).strict();
export const partialCloseBody=z.object({idempotencyKey:key,expectedVersion:version,reason}).strict();
export const cancelRequestBody=z.object({idempotencyKey:key,expectedVersion:version,reason}).strict();

const listFields = {
  sourceWarehouseId: oid.optional(),
  destinationWarehouseId: oid.optional(),
  status: z.string().trim().max(180).regex(/^[A-Z_]+(?:,[A-Z_]+)*$/).transform(value => value.split(',')).optional(),
  ...movementListFields,
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const listQuery = z.object(listFields).strict().refine(validDateRange, { message: 'from must be before to' });
export const dispatchListQuery = z.object({ ...listFields, receivable: z.enum(['true', 'false']).optional() })
  .strict().refine(validDateRange, { message: 'from must be before to' });
export const detailParams = z.object({ id: documentIdentifier }).strict();
export const optionsQuery = z.object({ warehouseId: oid.optional(), mode:z.enum(['stock','locations']).default('stock') }).strict();

const differenceLineId=z.string().regex(/^[a-f\d]{24}$/i),differenceKey=z.string().min(1).max(64),differenceQty=z.string().regex(/^\d{1,14}(\.\d{1,6})?$/).refine(v=>exact(v).gt(0));
export const differenceProposalBody=z.object({idempotencyKey:differenceKey,expectedVersion:version,reason,lines:z.array(z.object({dispatchLineId:differenceLineId,qtyBase:differenceQty}).strict()).min(1).max(100).refine(rows=>new Set(rows.map(r=>r.dispatchLineId)).size===rows.length)}).strict();
export const differenceReviewBody=z.object({idempotencyKey:differenceKey,expectedVersion:version,decision:z.enum(['APPROVE','REJECT','REVISE']),reason,
 // RECEIVED: the missing goods arrived on a later receipt. WRITE_OFF: they are lost or destroyed in transit.
 resolution:z.enum(['RECEIVED','WRITE_OFF']).optional(),liableParty:z.enum(['SOURCE_WAREHOUSE','CARRIER','DESTINATION_WAREHOUSE','UNKNOWN']).optional(),receiptId:documentIdentifier.optional()}).strict()
 .refine(v=>v.decision!=='APPROVE'||(v.resolution??(v.receiptId?'RECEIVED':undefined))!==undefined,{message:'Chọn cách xử lý chênh lệch'})
 .refine(v=>v.decision!=='APPROVE'||(v.resolution??'RECEIVED')!=='RECEIVED'||Boolean(v.receiptId),{message:'Chọn phiếu nhận đối chiếu'})
 .refine(v=>v.decision!=='APPROVE'||v.resolution!=='WRITE_OFF'||Boolean(v.liableParty),{message:'Chọn bên chịu trách nhiệm hao hụt'});
