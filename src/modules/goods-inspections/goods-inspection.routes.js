import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import { validate } from '../../middlewares/validate.js';
import * as controller from './goods-inspection.controller.js';
import * as validation from './goods-inspection.validation.js';

export const inspectionRouter = Router();
inspectionRouter.use(authenticate);
inspectionRouter.get('/:id/history', checkPermission('goods_receipt_inspection:read'), validate(validation.receivingHistorySchema), controller.getReceivingHistory);
inspectionRouter.post('/:id/cancel', checkPermission('goods_receipt_inspection:update'), validate(validation.cancelInspectionSchema), controller.cancelInspection);
inspectionRouter.get('/:id/correction-preflight', checkPermission('goods_receipt_inspection:update'), validate(validation.correctionPreflightSchema), controller.getCorrectionPreflight);
inspectionRouter.post('/:id/corrections', checkPermission('goods_receipt_inspection:update'), validate(validation.replaceInspectionSchema), controller.replaceInspection);
inspectionRouter.get('/', checkPermission('goods_receipt_inspection:read'), validate(validation.listInspectionsSchema), controller.listInspections);
inspectionRouter.get('/:id', checkPermission('goods_receipt_inspection:read'), validate(validation.getDocumentSchema), controller.getInspection);
inspectionRouter.put('/:id', checkPermission('goods_receipt_inspection:update'), validate(validation.updateInspectionSchema), controller.updateInspection);
inspectionRouter.post('/:id/confirm', checkPermission('goods_receipt_inspection:update'), validate(validation.confirmInspectionSchema), controller.confirmInspection);

export const purchaseOrderInspectionRouter = Router();
purchaseOrderInspectionRouter.use(authenticate);
purchaseOrderInspectionRouter.get('/:id/inspection-context', checkPermission('goods_receipt_inspection:read'), validate(validation.inspectionContextSchema), controller.getInspectionContext);
purchaseOrderInspectionRouter.post('/:id/inspections', checkPermission('goods_receipt_inspection:create'), validate(validation.createInspectionSchema), controller.createInspection);
