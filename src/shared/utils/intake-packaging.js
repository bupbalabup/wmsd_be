import { ProductBatch } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { assertBatchPackaging } from '../../models/capacity.js';
import { validationError } from './ApiError.js';

export async function intakePortions(item, condition, portions, session) {
  if (!portions?.length && condition !== 'SEALED') return undefined;
  const batch = await ProductBatch.findById(item.lotId).session(session);
  if (!batch) throw validationError('Thiếu lô nhập');
  const perCarton = exact(batch.piecesPerCarton ?? 0);
  if (!portions?.length) {
    if (perCarton.gt(0) && !exact(item.qtyBase).mod(perCarton).isZero()) {
      throw validationError('Dòng nguyên thùng phải đủ số viên theo quy cách lô; phần lẻ ghi dòng riêng là hàng lẻ');
    }
    return undefined;
  }
  let opened = false;
  for (const portion of portions) {
    if (portion.packagingState !== 'SEALED') {
      opened = true;
      continue;
    }
    if (portion.measuredVolumeMm3 != null || exact(portion.extraOccupiedVolumeMm3 ?? '0').gt(0)) {
      throw validationError('Thùng nguyên tính thể tích theo kích thước lô, không khai thể tích');
    }
    try {
      assertBatchPackaging(batch, portion.packagingSnapshot);
    } catch {
      throw validationError('Quy cách thùng khác quy cách lô');
    }
    if (!portion.sealedPackCount || !exact(portion.quantityBase).eq(perCarton.mul(portion.sealedPackCount))) {
      throw validationError('Số viên thùng nguyên khác quy cách lô');
    }
  }
  if (condition === 'SEALED' && opened) throw validationError('Dòng kiểm nguyên thùng chỉ khai thùng nguyên');
  if (condition && condition !== 'SEALED' && !opened) throw validationError('Dòng kiểm không nguyên thùng phải có phần hàng mở/lẻ');
  return portions;
}

export function checkPackagingLines(document, packaging = []) {
  const ids = packaging.map(row => String(row.lineId));
  if (new Set(ids).size !== ids.length || ids.some(lineId => !document.items.id(lineId))) {
    throw validationError('Quy cách có dòng trùng hoặc không thuộc phiếu');
  }
}
