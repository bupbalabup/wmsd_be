import { createHash } from 'node:crypto';
import * as m from '../../models/runtime.js';
import { evidenceStorage, inspectFile } from '../po-receiving/purchase-evidence.service.js';
import { requirePermission, requireWarehouseAccess } from '../../shared/utils/access.js';
import { ApiError, notFoundError, validationError } from '../../shared/utils/ApiError.js';
import { newId, same } from '../../shared/utils/document-command.js';

// Found-not-in-book counts (COUNTING) and plan executions (APPROVED/IN_PROGRESS) accept only
// ATTACHED evidence owned by the stocktake and uploaded by the acting counter. Uploading creates
// exactly that record without touching the stocktake, so the client's expectedVersion stays valid.
const UPLOAD_PERMISSION = { COUNTING: 'stocktake:update', APPROVED: 'stock_adjustment:update', IN_PROGRESS: 'stock_adjustment:update' };
const resourceType = mediaType => mediaType === 'application/pdf' ? 'raw' : 'image';
const format = mediaType => mediaType === 'application/pdf' ? 'pdf' : mediaType === 'image/png' ? 'png' : 'jpg';

async function scoped(user, id) {
    requirePermission(user, 'stocktake:read');
    const document = await m.Stocktake.findById(id);
    if (!document)
        throw notFoundError();
    requireWarehouseAccess(user, document.header.warehouseId);
    return document;
}

export async function uploadStocktakeEvidence(user, id, file) {
    const document = await scoped(user, id);
    const permission = UPLOAD_PERMISSION[document.workflowStatus];
    if (!permission)
        throw validationError('Đợt kiểm kê không ở bước cần bằng chứng');
    requirePermission(user, permission);
    if (!document.header.assignedCounterIds.some(counterId => same(counterId, user._id)))
        throw validationError('Bạn không được phân công trong đợt kiểm kê này');
    const type = await inspectFile(file);
    const uploadId = newId();
    const storageKey = `sep490/stocktake-evidence/${uploadId}${type.resourceType === 'raw' ? '.pdf' : ''}`;
    const stored = await evidenceStorage.upload(file.buffer, { public_id: storageKey, resource_type: type.resourceType, type: 'authenticated', overwrite: false });
    try {
        if (stored.public_id !== storageKey || stored.type !== 'authenticated')
            throw new ApiError(502, 'Storage chưa xác nhận tệp riêng tư');
        const attachment = await new m.Attachment({
            _id: uploadId, ownerDocumentType: m.Stocktake.collection.name, ownerDocumentId: document._id, ownerRevision: document.version,
            purpose: 'STOCKTAKE_EVIDENCE', originalName: file.originalname, mediaType: type.mediaType, sizeBytes: file.buffer.length, storageKey,
            checksum: createHash('sha256').update(file.buffer).digest('hex'), uploadedBy: user._id, uploadedAt: new Date(),
            accessCategory: 'BUSINESS', status: 'ATTACHED',
        }).save();
        return { id: String(attachment._id), originalName: attachment.originalName, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes };
    }
    catch (error) {
        // Remove the asset only when the record is known not to exist; an unknown write outcome keeps it.
        if (error instanceof ApiError || error?.name === 'ValidationError')
            await evidenceStorage.destroy(storageKey, type.resourceType).catch(() => {});
        throw error;
    }
}

/** Short-lived download link for evidence owned by the stocktake or one of its plans. */
export async function downloadStocktakeEvidence(user, id, evidenceId) {
    const document = await scoped(user, id);
    const owners = [document._id, ...document.resolutionPlans.map(plan => plan._id)];
    const attachment = await m.Attachment.findOne({ _id: evidenceId, ownerDocumentId: { $in: owners }, status: 'ATTACHED' });
    if (!attachment)
        throw notFoundError();
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    return {
        url: evidenceStorage.download(attachment.storageKey, format(attachment.mediaType), resourceType(attachment.mediaType), expiresAt),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        originalName: attachment.originalName,
        mediaType: attachment.mediaType,
    };
}
