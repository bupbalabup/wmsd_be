import { GoodsInspection } from '../../models/runtime.js';
import { exact } from '../../models/model-utils.js';
import { validationError } from '../../shared/utils/ApiError.js';
import { command, checkVersion, saveVersion, same } from '../../shared/utils/document-command.js';
import { findPurchase, replayPurchase, activePo } from '../../shared/utils/purchase-core.js';
import { intakePortions, checkPackagingLines } from '../../shared/utils/intake-packaging.js';
import { purchaseOrderQuantities } from '../purchase-orders/purchase-order.service.js';
import {
  guardLocations,
  locationAt,
  beginStock,
  balanceAt,
  receiveStock,
  verifyCapacity,
} from '../../shared/utils/stock.js';
import { postOwnedCustody } from '../custody/custody-stock.js';

export function postReceipt(user, id, input) {
  return command(
    user,
    'POST_PURCHASE_RECEIPT',
    'goods_receipt_inspection:post',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const receipt = await findPurchase(id, actor, session, { kind: 'GR_PURCHASE' });
      checkVersion(receipt, input.expectedVersion);
      if (receipt.workflowStatus !== 'DRAFT' || !receipt.items.length) {
        throw validationError('Phiếu không còn nháp hoặc không có lượng nhập');
      }
      const po = await activePo(actor, receipt.header.purchaseOrderId, input.expectedPoVersion, session);
      const quantities = await purchaseOrderQuantities(po, session);
      if (quantities.some(row => exact(row.acceptanceHeadroomQtyBase).lt(0))) {
        throw validationError('Các phiếu nhập vượt hạn mức PO');
      }
      checkPackagingLines(receipt, input.packaging);
      const locations = receipt.items.map(row => row.destinationLocationId);
      await guardLocations(locations, session);
      const posting = beginStock(receipt, actor, 'PURCHASE_RECEIPT', input);
      for (const item of receipt.items) {
        if (item.custodyBalanceId) {
          await postOwnedCustody(receipt, item, po, posting, actor, session);
          continue;
        }
        const inspection = await GoodsInspection.findOne({
          _id: item.inspectionId,
          workflowStatus: 'CONFIRMED',
          'header.arrivalId': receipt.header.arrivalId,
        }).session(session);
        const source = inspection?.items.id(item.inspectionResultId);
        if (
          !source ||
          source.details.qualityCode !== 'GOOD' ||
          source.details.ownershipDecision !== 'ACCEPT' ||
          !same(source.lotId, item.lotId) ||
          !same(source.productId, item.productId) ||
          !exact(source.qtyBase).eq(String(item.qtyBase))
        ) {
          throw validationError('Nguồn nhận sở hữu không hợp lệ');
        }
        await locationAt(
          item.destinationLocationId,
          po.header.warehouseId,
          [source.details.qualityCode === 'GOOD' ? 'RECEIVING' : 'QUARANTINE'],
          session,
        );
        const target = await balanceAt(
          { type: 'LOCATION', locationId: item.destinationLocationId },
          { batchId: item.lotId, ownerType: 'STORE', ownerId: null },
          source.details.qualityCode,
          session,
        );
        const portions = await intakePortions(
          item,
          source.details.packagingCondition,
          input.packaging?.find(row => same(row.lineId, item._id))?.portions,
          session,
        );
        await receiveStock(target, item, portions, posting, actor, session, source.details.packagingCondition);
      }
      await verifyCapacity(locations, session);
      await posting.save({ session });
      receipt.workflowStatus = 'POSTED';
      receipt.stockTransactionId = posting._id;
      receipt.postedBy = actor._id;
      receipt.postedAt = new Date();
      receipt.header.receivedAt = new Date();
      const saved = await saveVersion(receipt, input.expectedVersion, session);
      const remaining = await purchaseOrderQuantities(po, session);
      if (remaining.every(row => exact(row.outstandingQtyBase).isZero())) {
        // Fully settled with a short-closed line: CLOSED, not COMPLETED (user decision 23/11/2026).
        const shortClosed = remaining.some(row => exact(row.cancelledQtyBase).gt(0));
        po.workflowStatus = shortClosed ? 'CLOSED' : 'COMPLETED';
        if (shortClosed) po.header.closedAt = new Date();
      } else {
        po.workflowStatus = 'PARTIAL';
      }
      await saveVersion(po, po.version, session);
      return {
        document: saved,
        versionBefore: input.expectedVersion,
        stockTransactionId: posting._id,
      };
    },
  );
}

export function changeDestinations(user, id, input) {
  return command(
    user,
    'CHANGE_RECEIPT_DESTINATIONS',
    'goods_receipt_inspection:update',
    id,
    input,
    replayPurchase,
    async (session, actor) => {
      const receipt = await findPurchase(id, actor, session, { kind: 'GR_PURCHASE' });
      checkVersion(receipt, input.expectedVersion);
      if (receipt.workflowStatus !== 'DRAFT') {
        throw validationError('Không đổi vị trí sau ghi tồn');
      }
      if (new Set(input.lines.map(row => row.lineId)).size !== input.lines.length) {
        throw validationError('Mỗi dòng chỉ chọn một vị trí');
      }
      for (const row of input.lines) {
        const item = receipt.items.id(row.lineId);
        if (!item) throw validationError('Dòng không thuộc phiếu');
        const inspection = await GoodsInspection.findById(item.inspectionId).session(session);
        const source = inspection?.items.id(item.inspectionResultId);
        if (!source) throw validationError('Thiếu kiểm nhận');
        await locationAt(
          row.receivingLocationId,
          receipt.header.warehouseId,
          [source.details.qualityCode === 'GOOD' ? 'RECEIVING' : 'QUARANTINE'],
          session,
        );
        item.destinationLocationId = row.receivingLocationId;
      }
      return {
        document: await saveVersion(receipt, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        reason: input.reason,
      };
    },
  );
}
