import { nextDocumentFields } from '../../shared/utils/document-number.js';
import { OtherGoodsReceipt, ApprovalHistory } from "../../models/runtime.js";
import { currentRole } from "../../shared/utils/userRole.js";
import {
  requireWarehouseAccess,
  requirePermission,
} from "../../shared/utils/access.js";
import {
  forbiddenError,
  notFoundError,
  validationError,
} from "../../shared/utils/ApiError.js";
import {
  command,
  checkVersion,
  saveVersion,
  newId,
  hash,
  same,
} from "../../shared/utils/document-command.js";
import { makeItem } from "../../shared/utils/document-items.js";
import {
  beginStock,
  guardLocations,
  locationAt,
  balanceAt,
  receiveStock,
  verifyCapacity,
} from "../../shared/utils/stock.js";
import { transferCustodyStock } from "../custody/custody-stock.js";
import { eligible } from "../stock-reversals/stock-reversal.service.js";
import { evidenceFor } from "../../shared/utils/purchase-core.js";

const staff = (actor) => {
  if (currentRole(actor)?.code !== "WAREHOUSE") throw forbiddenError();
};
const owner = (actor) => {
  if (currentRole(actor)?.code !== "OWNER") throw forbiddenError();
};
async function scoped(id, actor, session) {
  const doc = await OtherGoodsReceipt.findById(id).session(session);
  if (!doc) throw notFoundError();
  requireWarehouseAccess(actor, doc.header.warehouseId);
  return doc;
}
const replay = (id, actor, session) => scoped(id, actor, session);

async function buildLines(receipt, lines, session) {
  const items = [];
  const existing = [...receipt.items];
  for (const [index, line] of lines.entries()) {
    await locationAt(line.destinationLocationId, receipt.header.warehouseId,
      line.qualityCode === 'GOOD' ? ['RECEIVING', 'STORAGE'] : ['QUARANTINE'], session);
    const previousIndex = existing.findIndex(row => same(row.productId, line.productId) && same(row.lotId, line.lotId));
    const previous = previousIndex < 0 ? undefined : existing.splice(previousIndex, 1)[0];
    const item = await makeItem(line, index + 1, session, { previous });
    items.push({
      ...item, _id: previous?._id ?? newId(), lineNo: index + 1, lineKind: 'STANDARD',
      destinationLocationId: line.destinationLocationId, qualityCode: line.qualityCode,
      ...(previous && { note: previous.note, evidenceIds: previous.evidenceIds }),
    });
  }
  return items;
}

export function createOtherReceipt(user, input) {
  return command(
    user,
    "CREATE_OTHER_RECEIPT",
    "goods_receipt_other:create",
    null,
    input,
    replay,
    async (session, actor) => {
      staff(actor);
      requireWarehouseAccess(actor, input.warehouseId);
      if (!input.lines?.length) throw validationError("Phiếu phải có dòng hàng");
      const receipt = new OtherGoodsReceipt({
        ...await nextDocumentFields(OtherGoodsReceipt,'OTHER',input.warehouseId,session),
        workflowStatus: "DRAFT",
        version: 1,
        createdBy: actor._id,
        occurredAt: new Date(),
        note: input.note,
        header: {
          warehouseId: input.warehouseId,
          reason: input.reason,
        },
        items: [],
      });
      receipt.items = await buildLines(receipt, input.lines, session);
      await receipt.save({ session });
      return { document: receipt };
    },
  );
}

export function updateOtherReceipt(user, id, input) {
  return command(user, 'UPDATE_OTHER_RECEIPT', 'goods_receipt_other:create', id, input, replay, async (session, actor) => {
    staff(actor);
    const doc = await scoped(id, actor, session);
    checkVersion(doc, input.expectedVersion);
    if (doc.workflowStatus !== 'DRAFT') throw validationError('Phiếu không còn nháp');
    doc.header.reason = input.reason;
    if (input.note !== undefined) doc.note = input.note;
    doc.items = await buildLines(doc, input.lines, session);
    doc.updatedBy = actor._id;
    return { document: await saveVersion(doc, input.expectedVersion, session), versionBefore: input.expectedVersion };
  });
}

export function submitOtherReceipt(user, id, input) {
  return command(
    user,
    "SUBMIT_OTHER_RECEIPT",
    "goods_receipt_other:create",
    id,
    input,
    replay,
    async (session, actor) => {
      staff(actor);
      const doc = await scoped(id, actor, session);
      checkVersion(doc, input.expectedVersion);
      if (doc.workflowStatus !== "DRAFT")
        throw validationError("Phiếu không còn nháp");
      await evidenceFor(actor, doc, doc.evidenceIds, session, true);
      doc.workflowStatus = "PENDING_APPROVAL";
      return {
        document: await saveVersion(doc, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
      };
    },
  );
}

export function approveOtherReceipt(user, id, input) {
  return command(
    user,
    "APPROVE_OTHER_RECEIPT",
    "goods_receipt_other:approve",
    id,
    input,
    replay,
    async (session, actor) => {
      owner(actor);
      const doc = await scoped(id, actor, session);
      checkVersion(doc, input.expectedVersion);
      if (
        doc.workflowStatus !== "PENDING_APPROVAL" ||
        same(doc.createdBy, actor._id)
      )
        throw validationError("Phiếu không còn chờ duyệt hoặc tự duyệt");
      const decision = await new ApprovalHistory({
        decisionKey: hash({
          id,
          version: doc.version,
          key: input.operationKey,
        }),
        subjectType: "goods_receipts",
        subjectId: doc._id,
        subjectRevision: doc.version,
        decisionScope: "OTHER_RECEIPT",
        reviewedContent: doc.toObject(),
        decision: input.decision,
        reason: input.reason,
        requestedBy: doc.createdBy,
        decidedBy: actor._id,
        decidedAt: new Date(),
        recordedAt: new Date(),
        itemDecisions: doc.items.map((item) => ({
          itemId: item._id,
          approvedQtyBase: item.qtyBase,
          outcome: input.decision,
        })),
        authoritySnapshot: {
          roleCode: "OWNER",
          permissionCode: "goods_receipt_other:approve",
          warehouseIds: actor.warehouseIds,
        },
        evidenceIds: doc.evidenceIds,
      }).save({ session });
      doc.workflowStatus = input.decision === "APPROVE" ? "APPROVED" : "DRAFT";
      if (input.decision === "APPROVE") {
        doc.approvedVersion = doc.version + 1;
        doc.approvalDecisionId = decision._id;
      }
      return {
        document: await saveVersion(doc, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        decisionId: decision._id,
      };
    },
  );
}

export function postOtherReceipt(user, id, input) {
  return command(
    user,
    "POST_OTHER_RECEIPT",
    "goods_receipt_other:post",
    id,
    input,
    replay,
    async (session, actor) => {
      staff(actor);
      const doc = await scoped(id, actor, session);
      checkVersion(doc, input.expectedVersion);
      if (
        doc.workflowStatus !== "APPROVED" ||
        doc.approvedVersion !== doc.version
      )
        throw validationError(
          "Nội dung ghi tồn chưa được duyệt đúng phiên bản",
        );
      await evidenceFor(actor, doc, doc.evidenceIds, session, true);
      const locations = doc.items.map((item) => item.destinationLocationId);
      await guardLocations(locations, session);
      const posting = beginStock(doc, actor, "OTHER_RECEIPT", input);
      for (const item of doc.items) {
        await locationAt(
          item.destinationLocationId,
          doc.header.warehouseId,
          item.qualityCode === "GOOD"
            ? ["RECEIVING", "STORAGE"]
            : ["QUARANTINE"],
          session,
        );
        const target = await balanceAt(
          { type: "LOCATION", locationId: item.destinationLocationId },
          { batchId: item.lotId, ownerType: "STORE", ownerId: null },
          item.qualityCode,
          session,
        );
        const portions = input.packaging?.find((row) =>
          same(row.lineId, item._id),
        )?.portions;
        await receiveStock(target, item, portions, posting, actor, session);
      }
      await verifyCapacity(locations, session);
      await posting.save({ session });
      doc.workflowStatus = "POSTED";
      doc.stockTransactionId = posting._id;
      doc.postedBy = actor._id;
      doc.postedAt = new Date();
      return {
        document: await saveVersion(doc, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        stockTransactionId: posting._id,
      };
    },
  );
}

export function reverseOtherReceipt(user, id, input) {
  return command(
    user,
    "REVERSE_OTHER_RECEIPT",
    "goods_receipt_other:reverse",
    id,
    input,
    replay,
    async (session, actor) => {
      staff(actor);
      const doc = await scoped(id, actor, session);
      checkVersion(doc, input.expectedVersion);
      await evidenceFor(actor, doc, input.evidenceIds, session);
      const { original, locations } = await eligible(doc, actor, session);
      await guardLocations(locations, session);
      const posting = beginStock(doc, actor, "OTHER_REVERSAL", input);
      posting.reversedTransactionId = original._id;
      for (const move of [...original.movements].reverse()) {
        const item = doc.items.id(move.sourceLineId);
        await transferCustodyStock(
          move.toBalanceId,
          null,
          { ...item.toObject(), qtyBase: String(move.quantityBase) },
          posting,
          actor,
          session,
          move.packagingPortionIds,
        );
      }
      await verifyCapacity(locations, session);
      await posting.save({ session });
      doc.workflowStatus = "REVERSED";
      doc.note = [doc.note, `Bỏ ghi: ${input.reason}`]
        .filter(Boolean)
        .join("\n");
      if (input.evidenceIds?.length) doc.evidenceIds.addToSet(...input.evidenceIds);
      return {
        document: await saveVersion(doc, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        stockTransactionId: posting._id,
        reason: input.reason,
      };
    },
  );
}

export function cancelOtherReceipt(user, id, input) {
  return command(
    user,
    "CANCEL_OTHER_RECEIPT",
    "goods_receipt_other:create",
    id,
    input,
    replay,
    async (session, actor) => {
      staff(actor);
      const doc = await scoped(id, actor, session);
      checkVersion(doc, input.expectedVersion);
      if (doc.workflowStatus !== "DRAFT")
        throw validationError("Chỉ hủy phiếu nháp");
      doc.workflowStatus = "CANCELLED";
      doc.cancelledBy = actor._id;
      doc.cancelledAt = new Date();
      doc.cancelReason = input.reason;
      return {
        document: await saveVersion(doc, input.expectedVersion, session),
        versionBefore: input.expectedVersion,
        reason: input.reason,
      };
    },
  );
}

export async function otherReversalPreflight(user, id) {
  requirePermission(user, "goods_receipt_other:read");
  requirePermission(user, "goods_receipt_other:reverse");
  const doc = await scoped(id, user);
  try {
    await eligible(doc, user);
    return { eligible: true, receiptVersion: doc.version };
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) throw error;
    return {
      eligible: false,
      reason: error.message,
      receiptVersion: doc.version,
    };
  }
}
