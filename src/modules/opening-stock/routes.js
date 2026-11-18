import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { catchAsync } from '../../shared/utils/catchAsync.js';
import { formatApiResponse } from '../../shared/utils/ApiResponse.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { databaseId } from '../../models/document-identity.js';
import { requirePermission } from '../../shared/utils/access.js';
import { previewBody, createBody, actionBody } from './validation.js';
import * as service from './service.js';
const router = Router();
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) throw validationError(result.error.issues[0].message); return result.data; };
const route = (method, path, fn) => router[method](path, catchAsync(async (req, res) => formatApiResponse(res, { data: await fn(req) })));
router.use(authenticate);
route('get', '/options', req => service.options(req.user));
route('get', '/', req => service.list(req.user));
route('post', '/preview', async req => {
  // Validate permission/scope before returning any row diagnostics.
  requirePermission(req.user, 'opening_stock:create');
  const parsed = previewBody.safeParse(req.body);
  if (!parsed.success && parsed.error.issues.every(issue => issue.path[0] === 'rows' && typeof issue.path[1] === 'number')) {
    await service.options(req.user);
    const labels = { sku: 'SKU', manufacturerCode: 'Hãng', color: 'Màu', name: 'Tên sản phẩm', categoryCode: 'Mã nhóm', baseUnit: 'Đơn vị gốc',
      lengthMm: 'Dài sản phẩm', widthMm: 'Rộng sản phẩm', heightMm: 'Cao sản phẩm', manufacturerLot: 'Mã lô', tone: 'Tone', calibre: 'Calibre',
      piecesPerCarton: 'Số viên/thùng', cartonLengthMm: 'Dài thùng', cartonWidthMm: 'Rộng thùng', cartonHeightMm: 'Cao thùng', enteredQty: 'Số lượng tồn' };
    return { valid: false, rows: [], errors: parsed.error.issues.map(issue => ({ rowNumber: Number(issue.path[1]) + 2,
      message: `Thiếu hoặc sai cột ${labels[issue.path[2]] || issue.path[2] || 'dữ liệu'}: ${issue.message}` })) };
  }
  return service.preview(req.user, parsed.success ? parsed.data : parse(previewBody, req.body));
});
route('post', '/', req => service.create(req.user, parse(createBody, req.body)));
route('get', '/:id', req => service.get(req.user, databaseId(req.params.id)));
for (const action of ['post', 'cancel']) route('post', '/:id/' + action, req => service.act(req.user, databaseId(req.params.id), action, parse(actionBody, req.body)));
export default router;
