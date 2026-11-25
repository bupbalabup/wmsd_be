import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import checkPermission from '../../middlewares/permission.js';
import * as controller from './transfer.controller.js';

const router = Router();
const readPermission = checkPermission('stock_transfer:read');
router.use(authenticate);

router.post('/', controller.createRequest);
router.put('/:id', controller.updateRequest);
router.post('/:id/review', controller.reviewRequest);
router.post('/:id/outbound-deliveries', controller.createDispatch);
router.post('/documents/:id/internal-requirements', controller.createRequirement);
router.post('/tasks/:id/confirm', controller.confirmTask);
router.post('/dispatches/:id/cancel', controller.cancelDraftDispatch);
router.post('/dispatches/:id/receipts', controller.receiveTransfer);
router.post('/dispatches/:id/differences', controller.proposeDifference);
router.post('/differences/:id/review', controller.reviewDifference);
router.post('/:id/close', controller.closeRequest);
router.post('/:id/close-partial', controller.closePartialRequest);
router.post('/:id/cancel', controller.cancelRequest);

router.get('/', readPermission, controller.listTransfers);
router.get('/options', readPermission, controller.transferOptions);
router.get('/pick-assignees', readPermission, controller.pickAssignees);
router.get('/dispatches', readPermission, controller.listDispatches);
router.get('/dispatches/:id', readPermission, controller.getDispatch);
router.get('/tasks/:id', readPermission, controller.getPutawayTask);
router.get('/:id', readPermission, controller.getTransfer);

export default router;
