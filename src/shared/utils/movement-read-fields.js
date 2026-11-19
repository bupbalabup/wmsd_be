// Explicit read contracts; never reuse these projections on posting commands.
export const optionFields = {
  location: '_id warehouseId code name locationType isActive isAllocatable',
  point: '_id locationId type',
  balance: '_id version holdingPointId batchId quantityBase qualityStatus ownerType packagingPortions.packagingState',
  batch: '_id productId manufacturerLot piecesPerCarton identificationStatus',
  product: '_id name sku baseUnit isActive',
  conversion: '_id productId productBatchId uomId basePerUnit',
};
const itemFields = [
  '_id','lineNo','productId','productNameSnapshot','lotId','lotLabelSnapshot','enteredUnit','enteredQty',
  'baseUnitsPerUnit','baseUnitSnapshot','qtyBase','approvedQtyBase','packagingSnapshot.baseUnitsPerPackage',
  'details.requestLineId','details.dispatchLineId','details.sourceBalanceId','details.sourceBalanceVersion',
  'details.fromLocationId','details.toLocationId','details.stagingLocationId','details.receivingLocationId',
  'details.destinationBalanceId','details.qualityCode',
  'details.packagingState',
].map(field=>'items.'+field).join(' ');
export const movementDetailFields = [
  '_id documentNo documentKind workflowStatus version createdBy createdAt cancelReason',
  'header.warehouseId header.reason header.taskKind header.requestId header.dispatchId header.dispatchedBy',
  'header.sourceWarehouseId header.destinationWarehouseId',itemFields,
].join(' ');
export const relocationLedgerFields = '_id occurredAt operation performedBy movements.sourceLineId movements.quantityBase';
export const requirementFields = '_id workflowStatus header.sourceDocumentId header.taskKind';
export const executionFields = '_id documentNo workflowStatus version header.warehouseId header.taskKind';
export const differenceFields = '_id documentNo workflowStatus version note header.sourceRef.documentId items.qtyBase items.details.sourceLineId';
export const approvalFields = '_id subjectRevision decisionScope decision reason requestedBy decidedBy decidedAt itemDecisions evidenceIds';
export const movementSummaryProjection = {
  _id:1,documentNo:1,workflowStatus:1,createdAt:1,
  'header.warehouseId':1,'header.sourceWarehouseId':1,'header.destinationWarehouseId':1,
};
// The Excel flattener also consumes these scalar columns; tables never load them.
export const movementFullProjection = Object.fromEntries(
  (movementDetailFields+' occurredAt postedAt updatedAt note items.note').split(/\s+/).map(field=>[field,1]),
);
