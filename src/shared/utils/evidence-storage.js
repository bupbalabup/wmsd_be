import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { PDFDocument } from 'pdf-lib';
import { cloudinary } from '../../config/cloudinary.js';
import { ApiError, validationError } from './ApiError.js';

export const MAX_BYTES = 5 * 1024 * 1024;
const storageProvider = process.env.EVIDENCE_STORAGE_PROVIDER || 'cloudinary';
if (!['cloudinary', 'local'].includes(storageProvider)) throw new Error('EVIDENCE_STORAGE_PROVIDER must be cloudinary or local');
if (storageProvider === 'local' && process.env.NODE_ENV === 'production') throw new Error('Local evidence storage is disabled in production');
const localStorageRoot = resolve(process.env.EVIDENCE_LOCAL_DIR || '.local/evidence-storage');

function localStoragePath(key) {
  if (typeof key !== 'string' || !/^sep490\/(?:returns|purchase-evidence)\/[A-Za-z0-9_-]+(?:\.pdf)?$/.test(key)) {
    throw validationError('Đường dẫn chứng cứ không hợp lệ');
  }
  const path = resolve(localStorageRoot, ...key.split('/'));
  if (!path.startsWith(`${localStorageRoot}${sep}`)) throw validationError('Đường dẫn chứng cứ không hợp lệ');
  return path;
}

async function uploadLocal(buffer, options) {
  if (options.type !== 'authenticated') throw validationError('Chứng cứ phải được lưu riêng tư');
  const path = localStoragePath(options.public_id);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, buffer, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new ApiError(409, 'Chứng cứ đã tồn tại');
    throw error;
  }
  return { public_id: options.public_id, type: 'authenticated' };
}

async function downloadLocal(key, format, resourceType) {
  const mediaType = resourceType === 'raw' ? 'application/pdf' : format === 'png' ? 'image/png' : 'image/jpeg';
  const bytes = await readFile(localStoragePath(key));
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

export const evidenceStorage = {
  upload: (buffer, options) => storageProvider === 'local'
    ? uploadLocal(buffer, options)
    : new Promise((resolvePromise, reject) =>
      cloudinary.uploader.upload_stream({ ...options, timeout: 20000 }, (e, r) =>
        (e ? reject(new ApiError(502, 'Không lưu được chứng cứ')) : resolvePromise(r))).end(buffer)),
  exists: async (key, resourceType) => {
    if (storageProvider !== 'local') return cloudinary.api.resource(key, { resource_type: resourceType, type: 'authenticated' });
    await stat(localStoragePath(key));
    return { public_id: key, type: 'authenticated' };
  },
  destroy: async (key, resourceType) => {
    if (storageProvider !== 'local') return cloudinary.uploader.destroy(key, { resource_type: resourceType, type: 'authenticated', invalidate: true });
    try {
      await unlink(localStoragePath(key));
      return { result: 'ok' };
    } catch (error) {
      if (error.code === 'ENOENT') return { result: 'not found' };
      throw error;
    }
  },
  download: async (key, format, resourceType, expiresAt) => storageProvider === 'local'
    ? downloadLocal(key, format, resourceType)
    : cloudinary.utils.private_download_url(key, format, {
      resource_type: resourceType,
      type: 'authenticated',
      expires_at: expiresAt,
      attachment: true,
    }),
};

export async function inspectFile(file) {
  if (!file?.buffer?.length) throw validationError('Thiếu tệp chứng cứ');
  const bytes = file.buffer;
  if (bytes.length > MAX_BYTES) throw new ApiError(413, 'Chứng cứ tối đa 5 MB', { code: 'ERR-REC-FILE_SIZE' });
  try {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 10000000) throw new Error('Image too large');
      PNG.sync.read(bytes, { checkCRC: true });
      return { mediaType: 'image/png', resourceType: 'image', format: 'png' };
    }
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
      jpeg.decode(bytes, { maxResolutionInMP: 10, maxMemoryUsageInMB: 64, tolerantDecoding: false });
      return { mediaType: 'image/jpeg', resourceType: 'image', format: 'jpg' };
    }
    if (bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'))) {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
      if (pdf.getPageCount() < 1 || pdf.getPageCount() > 2000) throw new Error('Invalid page count');
      return { mediaType: 'application/pdf', resourceType: 'raw', format: 'pdf' };
    }
  } catch {
    throw validationError('Nội dung JPEG/PNG/PDF không hợp lệ');
  }
  throw validationError('Chỉ nhận nội dung JPEG, PNG hoặc PDF thật');
}
