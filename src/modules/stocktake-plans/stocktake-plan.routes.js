import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { documentIdentifier } from '../../shared/utils/document-id.validation.js';
import { objectId } from '../sales-orders/sales.validation.js';
import { operation } from '../sales-orders/sales-execution.validation.js';
import * as service from './stocktake-plan.service.js';

function parse(schema, value) {
    const result = schema.safeParse(value);
    if (!result.success)
        throw validationError('Dữ liệu kế hoạch kiểm kê không hợp lệ');
    return result.data;
}
const text = z.string().trim().min(1).max(2000);
const datetime = z.iso.datetime({ offset: true });
const scope = z.object({
    locationIds: z.array(objectId).max(5000).optional(), areaCodes: z.array(z.string().trim().min(1).max(50)).max(200).optional(),
    batchIds: z.array(objectId).max(5000).optional(), productIds: z.array(objectId).max(5000).optional(),
}).strict().refine(value => value.locationIds?.length || value.areaCodes?.length, 'Chọn vị trí hoặc khu vực');
const createBody = z.object({
    idempotencyKey: text.max(70), warehouseId: objectId, title: z.string().trim().min(1).max(200), reason: text.optional(),
    frequency: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']), startDate: datetime, endDate: datetime.optional(), reminderDays: z.number().int().min(0).max(90).optional(),
    assignedCounterIds: z.array(objectId).min(1), scope, note: z.string().max(2000).optional(),
}).strict();
const updateBody = operation.extend({
    title: z.string().trim().min(1).max(200).optional(), reason: text.optional(), endDate: datetime.nullable().optional(), reminderDays: z.number().int().min(0).max(90).optional(),
    assignedCounterIds: z.array(objectId).min(1).optional(), scope: scope.optional(), note: z.string().max(2000).optional(),
}).strict();
const transitionBody = operation.extend({ reason: text.optional() }).strict();
// periodNo (optional) regenerates an earlier period whose slips were all cancelled; omitted = the next due period.
const generateBody = operation.extend({ periodNo: z.number().int().min(0).max(100000).optional() }).strict();
const listQuery = z.object({
    q: z.string().trim().min(1).max(80).optional(), warehouseId: objectId.optional(), status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(),
    dueState: z.enum(['OVERDUE', 'DUE_SOON']).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const router = Router();
router.use(authenticate);
const respond = work => catchAsync(async (req, res) => formatApiResponse(res, { data: await work(req) }));
router.get('/', respond(req => service.listStocktakePlans(req.user, parse(listQuery, req.query))));
router.post('/', respond(req => service.createStocktakePlan(req.user, parse(createBody, req.body))));
router.get('/:id', respond(req => service.getStocktakePlan(req.user, parse(documentIdentifier, req.params.id))));
router.post('/:id/update', respond(req => service.updateStocktakePlan(req.user, parse(documentIdentifier, req.params.id), parse(updateBody, req.body))));
router.post('/:id/pause', respond(req => service.pauseStocktakePlan(req.user, parse(documentIdentifier, req.params.id), parse(transitionBody, req.body))));
router.post('/:id/resume', respond(req => service.resumeStocktakePlan(req.user, parse(documentIdentifier, req.params.id), parse(transitionBody, req.body))));
router.post('/:id/end', respond(req => service.endStocktakePlan(req.user, parse(documentIdentifier, req.params.id), parse(transitionBody, req.body))));
router.post('/:id/generate', respond(req => service.generateStocktakeFromPlan(req.user, parse(documentIdentifier, req.params.id), parse(generateBody, req.body))));
export default router;
