# BF04 — Inter-warehouse transfer

Base path: `/api/warehouse-transfers`.  All endpoints use authenticated users,
the existing `{ success, message, data }` envelope, decimal-string quantities,
optimistic `expectedVersion`, and a client-retained `idempotencyKey` (48 chars
maximum).  Re-submit exactly the same key and body after a timeout.

The caller's live permission grants and warehouse assignments are authoritative;
the UI must not infer access from a fixed role name.  The `GET /options` endpoint
is selection data only: each write command repeats its data, stock, capacity and
scope checks inside its transaction.

## Outbound packaging — 17/11/2026

The user permits opening cartons and fractional-carton issue quantities. Source PICK and dispatch to transit opt into exact packaging splits, preserving OPEN remainders and conservative volumeUpperBoundMm3 rather than inventing measurements. Existing source caps, whole-base quantities, reservations, freeze and capacity checks remain mandatory. Receipt and ordinary BF03 moves keep their prior rules. The common Goods Issue form embeds native dispatch creation; see [Goods Issue](../GOODS_ISSUES.md).

## Read DTO names — 11/11/2026

Scoped list/detail responses add sourceWarehouse and destinationWarehouse objects containing id,code,name (null if a reference no longer exists). FE renders explicit warehouse source/destination code and name for BF04, retaining the header IDs separately for actions. Lookups happen only after the request scope check; Sales redaction of operational documents remains unchanged. These fields are response-only current catalogue labels; no migration or shared-DB write is required.

## Read and selection APIs

Read payload optimization (17/11/2026): request and dispatch lists accept optional `view=summary|full`, default `full`. FE tables and receipt-source dropdown request summary; Excel retains full line quantities/units/snapshots. Summary omits lines/version/creator, so actions fetch the detail endpoint. Detail, options and related workflow records use explicit projections preserving operational references, versions, quantities, carton factors and scope. See [field contract and rollout limits](../TRANSFER_PERFORMANCE.md#field-projections--17-november-2026). This changes read DTOs only, with no database migration.

| Endpoint | Permission | Result |
| --- | --- | --- |
| `GET /` | `stock_transfer:read` | Scoped TR list; filters include source/destination warehouse, status and date. |
| `GET /dispatches` | `stock_transfer:read` | Tra phiếu xuất theo kho nguồn, kho đích, số phiếu và trạng thái. Với `receivable=true`, cần `stock_transfer:receive`. Kết quả chỉ gồm phiếu xuất đã ghi, yêu cầu đã duyệt, còn hàng đang chuyển và người nhận khác người xuất. |
| `GET /dispatches/:id` | `stock_transfer:read` | Chi tiết phiếu xuất với `receivableLines` nếu người dùng đủ điều kiện nhận. |
| `GET /tasks/:id` | `stock_transfer:read` + `stock_transfer:receive` | Scoped PUTAWAY TO detail, source receipt GOOD lines and selected destination labels; requires destination warehouse access. GET never writes. |
| `GET /:id` | `stock_transfer:read` | TR, dispatches, receipts, ITRs, generated TOs and approvals within scope. |
| `GET /options?warehouseId=` | `stock_transfer:read` | Accessible warehouses; with `warehouseId`, its locations, holding points, positive balances, verified batches, active products, active units and current product/batch conversions. |

The active warehouse catalogue supports choosing a destination outside the source
user's assignments. `sourceWarehouseIds` lists warehouses the caller may operate.
Only those warehouses expose locations and balances. Sales read scope remains
restricted to its linked demand documents. Sales options return warehouse catalogue only, with empty operational source IDs, locations, balances, products, units and conversions. `conversions` is a selection aid keyed by `productId`, optional `productBatchId`, and `uom`; the write command resolves the conversion again inside its transaction.

`GET /api/goods-receipts/transfer/:id` and the unified receipt detail use destination warehouse scope. Sales also needs the linked-demand scope above and receives status metadata and the linked request reference only. Both receipt lists apply that scope before pagination. See [GoodsReceipt API](../GOODS_RECEIPTS.md#receiving-corrections--20-november-2026).

Bộ lọc `status` của danh sách yêu cầu và phiếu xuất nhận một hoặc nhiều trạng thái phân tách bằng dấu phẩy. Trong **Đơn phiếu**, nút **Xem** của phiếu nhận mở đúng `/receipts/:receiptId?kind=TRANSFER`; phiếu nháp đủ quyền hiển thị form kiểm nhận với phiếu xuất điền sẵn. Form gọi `POST /dispatches/:id/receipts` và mở phiếu nhập theo `data.id`. Các dòng hư hỏng cần vị trí cách ly và lý do.

## Main flow

### Source locations on transfer requests — 22 November 2026

The create and edit pages reuse `GET /options?warehouseId=` to show the active source storage bins holding the selected product and verified lot. After choosing a lot, the user can select several bins and enter one quantity per bin in the product's base unit. Each entry is immediately compared with `availableQtyBase`, and the sum is compared with the requested quantity converted to the base unit. Options include `products[].wholeBaseUnits` and `units[].areaMm2` for this comparison. The original request unit and conversion snapshot stay on the parent line.

On `POST /` and `PUT /:id`, a planned line includes `lotId` and `sourceLocations: [{ sourceBalanceId, qtyBase }]`. Quantities are positive decimal strings, with at most six fractional digits, and must be whole when the product uses whole base units. The service checks that each balance belongs to a different active source bin for the same product and lot, contains good store-owned stock, is outside active stocktake locks, and has enough available stock. The allocation total may be lower than the requested base quantity. The UI shows the unallocated remainder as information and permits saving. The request stores each verified location ID and code with the balance ID and quantity. Submitting a request records a plan without reserving or posting stock.

`GET /:id` exposes the saved allocations on `items[].sourceLocations` in authorized operational detail and keeps them out of Sales and list projections. The request detail and linked Goods Issue form show the bin codes and quantities. The Goods Issue form fills planned quantities first, then draws the unallocated remainder from live eligible stock for the same lot. Across every non-cancelled dispatch, the quantity taken beyond the plan cannot exceed the approved quantity minus the planned total. Cancelling a draft restores its allowance. Dispatch checks live availability and reserves stock as before. Dispatch lines based on a planned request line use base units so a bin quantity can split the original request unit exactly.

The API accepts requests without a source-location plan. Omission when updating an existing planned line for the same product and lot retains and revalidates its plan. Send an empty array to clear the plan. The UI still allows an unspecified lot. Historical documents require no backfill, migration, or index build.

### Request creation stock preview — 17 November 2026

Source: user requested source-warehouse stock in pieces/cartons/pallets at step 2. The paired FE reuses the existing authorized stock options payload; no extra endpoint or query is added. Selecting a product shows on-hand and available quantities for STORE/GOOD stock in STORAGE locations, with the same eligibility as source dispatch allocation. Selecting a lot narrows both totals. Loading a different warehouse hides the previous warehouse's data; loading/error states never display stale stock as a current result.

The preview converts each batch separately, preferring its current batch conversion over a product conversion, then sums the results. Cartons may fall back to the batch's piecesPerCarton only when the product's base unit is pieces. Carton UOM uses isCarton, not a hardcoded BOX code; pallet uses the configured PALLET code/name. Missing factors show “Chưa cấu hình”; one unconvertible stocked batch prevents a misleading partial total. Zero stock and missing configuration are distinct. Values use exact rational arithmetic, Vietnamese number formatting and at most three fractional digits; truncated results have ≈. Negative free quantities display zero. Carton/pallet totals are equivalent quantities, not a count of sealed cartons or physical pallets. No stock, approval, request validation or conversion persistence changes.

### Automatic putaway and completion — 17 November 2026

The FE request form captures the source and destination warehouses, requested
quantities, and source-bin allocations when the user selects a lot. Per user decision on 17 November,
outbound documents are created exclusively in **Tạo phiếu xuất kho** at
`/goods-issues/create`, reason TRANSFER, against an approved request. The request
detail contains its linked dispatches and receipts, with a navigation button to
`/goods-issues/create?reason=TRANSFER&transferId=<encoded-request-id>` when another
outbound batch is needed. It has no inline quantity entry or creation command and
does not load source stock options. The separate page preselects the request,
allows choosing another approved source, and returns to the request after creation.

The existing stock_transfer:dispatch grant opens this shared create route for
TRANSFER only; goods_issue:create continues to authorize ordinary issue reasons.
No permission grant is added. URL parameters never bypass request approval,
warehouse scope or existing API permissions. Source selection/reason/quantities
are frozen while a transfer creation result is pending or uncertain; retry keeps
the original body and idempotency key. Transfer creation skips the unrelated
Goods Issue options query and loads its authorized source stock only here.

Create the PICK TO and confirm it to move stock to staging/transit. Receiving at
the destination automatically creates an OPEN ITR and PUTAWAY TO for GOOD lines
in the same transaction. The task initially has no item destinations; the source
receipt retains the exact product/lot/quantity/stock links. Destination staff open
`/transfer-tasks/:id`, select a STORAGE location for every GOOD receipt line, and
confirm the TO once. Planning and stock posting happen atomically on confirmation.
An all-DAMAGED receipt needs no PUTAWAY; its quarantine/defect records remain. Since 20 November 2026, each generated damage report also creates an ACTIVE hold for its own report item, destination balance and received quantity in the same receipt transaction. The quantity is blocked until its evidenced disposition resolves that hold; progress and proposal commands use the existing hold workflow. This corrects newly created reports and does not backfill historical reports.

Per user decision on 17 November, the request page groups dispatches/receipts under
**Đơn phiếu**, picking/putaway under **Nhiệm vụ**, and discrepancy handling under
**Báo cáo**. It has no inline putaway destination form or full-completion button.
Receipt inspection remains in `/receipts`. Report creation requires
`stock_transfer:update` and an actual account assignment to the destination
warehouse, including idempotent replay; global Owner visibility alone does not
grant report creation. Existing independent Owner review permissions remain.

The request automatically becomes COMPLETED after a receipt, PUTAWAY confirmation
or final discrepancy resolution when exact dispatched and effective received
quantities equal every approved line, transit is zero, all linked ITRs/TOs are
complete, and no unresolved difference or unfinished dispatch remains. Parent
request writes serialize those checks with concurrent receipt/task/report commands.
If quantity is short, the request stays APPROVED for another dispatch or explicit
**Dừng chuyển tiếp** with a mandatory reason after the delivered part is settled.
Native TransferDispatch records and parent/line references are unchanged; no
second Goods Issue is created.

| Step | API | Permission | Result |
| --- | --- | --- | --- |
| 1 | `POST /` | `stock_transfer:create` | Create `PENDING_APPROVAL` Transfer Request (TR). |
| 2 | `POST /:id/review` | `stock_transfer:approve` | A different user approves, rejects or returns the TR (REVISE). |
| 3 | `POST /:id/outbound-deliveries` | `stock_transfer:dispatch` | Create one DRAFT Transfer Dispatch from approved lines. More than one dispatch may fulfil a TR, never beyond approved quantity. |
| 4 | `POST /documents/:dispatchId/internal-requirements` | `stock_transfer:dispatch` | Create one ITR and one PICK Transfer Order (TO) for that dispatch. |
| 5 | `POST /tasks/:pickToId/confirm` | `stock_transfer:dispatch` | Creator confirms PICK; source → staging → transit posts atomically, and dispatch becomes `POSTED`. |
| 6 | `POST /dispatches/:dispatchId/receipts` | `stock_transfer:receive` | A different destination user receives into RECEIVING/QUARANTINE; GOOD lines automatically produce one waiting ITR/PUTAWAY TO. |
| 7 | `GET /tasks/:putawayToId` | `stock_transfer:read` + `stock_transfer:receive` | Open the separate destination-selection page. |
| 8 | `POST /tasks/:putawayToId/confirm` | `stock_transfer:receive` | Select all GOOD receipt-line destinations, confirm receiving → storage, and automatically complete the parent when ready. |
| 9 | `POST /:id/close-partial` | `stock_transfer:receive` | Explicitly stop remaining short quantities with a reason after actual deliveries are settled. The legacy full-close API remains guarded for compatibility; the paired FE no longer calls it. |

An ITR is one-to-one with its source dispatch or receipt, and a TO is one-to-one
with the ITR.  The indexes and command locking enforce those relationships even
when two clients submit concurrently.

## Request bodies

### Review and edit presentation — 17 November 2026

Source: user requested units beside waiting-approval quantities, editable product quantities/units, and the creation date below destination aligned with the reason. FE request quantity displays enteredQty with enteredUnit; approved/dispatched/received/transit/difference quantities display base quantities with the historical baseUnitSnapshot (presented as baseUnit). The paired read projection already includes that snapshot, so this requires no additional query. Older records without a resolvable base unit are labeled “đơn vị gốc”; they are never mislabeled with a carton unit merely because a carton was entered.

The creator with stock_transfer:update can edit quantities and configured units while PENDING_APPROVAL/REVISION_REQUIRED. Rows with source allocations use the row editor to revise both the request quantity and the quantities at each bin. The frontend preserves input on validation or request failure, marks invalid quantities, and keeps unavailable historical units visible. Unit choices use selected-batch overrides ahead of product defaults. PUT /:id carries the warehouse IDs, original expectedVersion, edited enteredQty/enteredUnit, and any source allocations. Retries keep the original idempotency key and body. Editing records the request revision without posting stock.

General information uses two columns on desktop: source/destination above reason/creation date; mobile stacks the fields. Editing controls remain inside the table's horizontal scroll region. No shared component API, model, permission grant or database change.

Create TR:

```json
{
  "idempotencyKey": "tr-001",
  "sourceWarehouseId": "<sourceWarehouseId>",
  "destinationWarehouseId": "<destinationWarehouseId>",
  "reason": "Replenish destination stock",
  "lines": [{
    "productId": "<productId>", "lotId": "<lotId>", "enteredUnit": "PIECE", "enteredQty": "160",
    "sourceLocations": [{ "sourceBalanceId": "<balanceId>", "qtyBase": "40" }]
  }]
}
```

Review: `{"idempotencyKey":"review-001","expectedVersion":1,"decision":"APPROVE","reason":"Approved"}`.
The approver must not be the TR creator.

Create dispatch:

```json
{
  "idempotencyKey": "dispatch-001",
  "expectedVersion": 2,
  "lines": [{
    "requestLineId": "<TR line id>",
    "sourceBalanceId": "<good STORE balance id>",
    "stagingLocationId": "<source STAGING location id>",
    "qtyBase": "20"
  }]
}
```

Create PICK requirement: `{"idempotencyKey":"pick-itr-001","expectedVersion":1}`.
Confirm PICK additionally requires `recipientName` (and may include `vehiclePlate`).

Receive dispatch:

```json
{
  "idempotencyKey": "receipt-001",
  "expectedVersion": 2,
  "lines": [
    { "dispatchLineId": "<dispatch line id>", "locationId": "<RECEIVING id>", "qtyBase": "18", "qualityCode": "GOOD" },
    { "dispatchLineId": "<dispatch line id>", "locationId": "<QUARANTINE id>", "qtyBase": "2", "qualityCode": "DAMAGED", "damageReason": "Broken in transit" }
  ]
}
```

Confirm an automatically created PUTAWAY TO with
`{idempotencyKey,expectedVersion,destinations:[{receiptLineId,locationId}]}`.
Exactly one destination STORAGE location in the same warehouse is required for
every GOOD receipt line; duplicate, missing/foreign lines and destinations on PICK
are rejected. Existing planned tasks can still confirm without destinations, or
select updated destinations through the separate page. Versions, quantities,
packaging, freeze and capacity checks are revalidated on confirmation.

For historical posted GOOD receipts without a task, **Mở cất hàng** opens
`/transfer-putaway/:receiptId?version=...&requestId=...`. It explicitly calls
`POST /documents/:receiptId/internal-requirements` with `{idempotencyKey,expectedVersion}`
to create/reuse the waiting ITR/TO, then opens the separate TO page. It never
backfills from a GET or on opening the task list. The old explicit-destinations
requirement command remains supported for sources without an existing ITR.
No duplicate ITR/TO is created. All-DAMAGED receipts reject empty putaway work.

Task detail returns `{id,documentNo,status,version,warehouseId,warehouseLabel,requestId,
requestStatus,receiptId,receiptNo,lines:[{receiptLineId,productName,lotLabel,
fromLocationLabel,qtyBase,baseUnit,toLocationId,toLocationLabel}]}`. Unplanned
destinations and unavailable labels are null; source-only users cannot read this
destination task. Explicit projections load only consumed source fields and current
warehouse/location labels. The page shows the receiving location and lot beside
each quantity; location selectors have unique row labels for keyboard operation.
Historical missing lot snapshots use the referenced batch's current manufacturer
lot label without changing the stored snapshot; unavailable references stay null.

## Guarantees and checks

Commands reject inactive warehouses/products, unverified lots, non-STORE/GOOD
outbound balances, wrong location kinds, self-approval, same dispatcher/receiver,
stale versions, over-dispatch, shortage, remaining transit, duplicate source
requirements, and changed idempotency bodies.  A successful command writes stock
ledger changes, document statuses, audit and outbox records atomically.  Failed
commands roll back completely.

The isolated native test (`RUN_NATIVE_API_TESTS=1 node --test
test/native-api.integration.test.js`) covers automatic task creation, destination
scope, invalid destinations with rollback, idempotent confirmation, automatic full
completion, all-damaged receipt/variance resolution and explicit partial closure.

## Danh sách chuyển kho — 12/11/2026

Theo yêu cầu UX của người dùng: GET `/api/warehouse-transfers` hỗ trợ thêm `q` (mã đơn literal, không phân biệt hoa thường), `sortBy=createdAt|documentNo|workflowStatus|warehouse|destinationWarehouse`, `sortOrder=asc|desc`. Giữ bộ lọc sourceWarehouseId, destinationWarehouseId, status, from/to ISO có múi giờ (bao gồm hai đầu), page/limit (tối đa 100). Sắp xếp warehouse/destinationWarehouse theo tên kho nguồn/đích, đồng hạng theo _id. Chỉ nhận khóa sort trong allowlist, khoảng ngày đảo bị từ chối.

Response data giữ items/total/page/limit; thêm summary={total,incomplete,completed,cancelled}, warehouses=[{id,code,name}], capturedAt. Summary và các kho lấy từ toàn bộ đơn được phép xem trước bộ lọc; total là số đơn phù hợp bộ lọc. completed=COMPLETED; cancelled=CANCELLED hoặc REJECTED; incomplete là các trạng thái còn lại (bao gồm PENDING_APPROVAL, APPROVED). Scope role/warehouse/record hiện hành được áp trước mọi nhánh thống kê/lọc. Không thay lệnh ghi, quyền hoặc tồn. FE mở danh sách trước, ẩn form tạo sau nút Tạo đơn, đánh STT xuyên trang và dùng createdAt thật từ DTO. Ngày lọc FE lấy trọn ngày giờ Việt Nam.

### UX trang riêng — 12/11/2026

Theo yêu cầu người dùng, FE chuyển tạo đơn sang `/transfers/create`; lưu thành công mở `/transfers/:id`. Danh sách không nhúng form. Trang tạo chia thông tin kho, hàng hóa và lý do, giữ payload/key khi retry chưa rõ kết quả; trang chi tiết có header/trạng thái, metadata và bảng dòng yêu cầu. Hiện hành 17/11: trang chi tiết duyệt yêu cầu và mở Đơn phiếu/Nhiệm vụ/Báo cáo; xuất tại form phiếu xuất, nhận tại /receipts, cất trên trang TO riêng và hoàn tất đủ lượng tự động như Main flow ở trên. Cập nhật 12/11: sửa/gửi lại TR ở /transfers/:id/edit qua PUT với expectedVersion; xem hợp đồng phạm vi mới bên dưới.

## Phạm vi hoàn thiện 12/11/2026

[Hợp đồng 20 UC hiện hành](../HIEUDT_WAREHOUSE_SCOPE.md) mô tả update/resubmit, reservation từ draft dispatch, hủy draft, bảng tiến độ, UC56 và nhận hỗn hợp/từng phần. Bổ sung PUT /:id (stock_transfer:update), POST /dispatches/:id/cancel (dispatch, key/version/reason), POST /dispatches/:id/differences (update, key/version/reason/lines[{dispatchLineId,qtyBase}]), POST /differences/:id/review (approve_variance, key/version/decision/reason/receiptId khi APPROVE), POST /:id/close-partial (receive, key/version/reason) để dừng các đợt còn thiếu sau khi hàng đã nhận/cất đủ phần đã chuyển. Không có lệnh sửa số lượng đã POSTED.

## Read performance — 17 November 2026

See [BF03/BF04 performance contract](../TRANSFER_PERFORMANCE.md) for compact catalogues, batched availability, parallel authorized reads, destination mode=locations and verification limits. Write transaction checks remain unchanged.

## Transit loss and discrepancy resolution — 22 November 2026 (batch 1)

**Problem.** A discrepancy blocked completion of the request until it was "resolved", but no resolution path existed for goods lost in transit, so the request could stay open forever.

**Endpoint.** `POST /warehouse-transfers/:id/discrepancies/:discrepancyId/review` (permission `stock_transfer:review_difference`). Body:

| Field | Meaning |
|---|---|
| `idempotencyKey`, `expectedVersion` | As for every command |
| `decision` | `APPROVE`, `REJECT` or `REVISE` |
| `resolution` | `WRITE_OFF` (goods lost: reduce the in-transit stock) or `RECEIVED` (goods found: settle against a receipt); required with `APPROVE` |
| `liableParty` | `SOURCE_WAREHOUSE`, `CARRIER`, `DESTINATION_WAREHOUSE` or `UNKNOWN`; required with `WRITE_OFF` |
| `receiptId` | Required with `RECEIVED` |
| `reason` | Required with `REJECT` or `REVISE` |

**Behavior.**
- Only a discrepancy in `OPEN` can be reviewed. Statuses are now `OPEN`, `RESOLVED`, `REJECTED`, `RETURNED`; only `OPEN` blocks completion and close-partial. `REJECT`/`REVISE` no longer leave the transfer blocked.
- `WRITE_OFF` reduces the IN_TRANSIT balance, posts a `TRANSFER_LOSS` stock transaction, marks the item `WRITTEN_OFF` and stores `resolutionMode` and `liableParty` on the header.
- Written-off quantity counts as accounted for in `completionBlocker`, so a request with received + written-off = dispatched completes automatically; a request with no receipt at all can complete when a write-off exists.
- A proposal's "committed" quantity counts only `OPEN` discrepancies.

**Read DTO.** `lineProgress[].writtenOffQtyBase` is new and `lineProgress[].unresolved` counts only `OPEN` discrepancies. The detail response also carries `approvals[]` and `differences[]` (header `reportedAt`, `resolutionMode`, `liableParty`; items with product, lot, base unit and `details.resolutionStatus`; `resolutionEvents`).

**Data.** `stock_discrepancy_headers.header` gains optional `resolutionMode` and `liableParty`. No migration; old documents load unchanged.

**UI (Transfer detail).** The order and task dialogs show the status alert; the review reason is shown when the request is `REVISION_REQUIRED` or `REJECTED`, also on the edit page; the owner sees "N discrepancy records waiting for your decision"; receipt quality columns and a "written off" column are always shown; the discrepancy dialog lets the owner choose write-off (with liable party), settle with a receipt, reject, or ask for revision.

## Lot mixing protection on dispatch — 22 November 2026 (batch 2)

**Problem.** A request line without a fixed lot could be filled silently from several lots; tiles from different lots can differ in tone and size.

**Endpoint.** `POST /warehouse-transfers/:id/outbound-deliveries` accepts the new optional body field `acceptMixedLots` (boolean).

**Behavior.** After the lines are built, the server counts distinct lots per request line across this dispatch and all non-cancelled dispatches of the request. If a request line has no `lotId` and more than one lot, the call fails with a validation error naming the products unless `acceptMixedLots` is `true`. When accepted, the dispatch header stores `mixedLots: true` and `mixedLotAcceptedBy`. Lines with a fixed lot are unaffected.

**Data and read fields.** `transfer_dispatches.header` gains `mixedLots` (Boolean, default false) and `mixedLotAcceptedBy` (User ref). Both appear in the movement detail header fields. Transfer options `batches[]` also return `manufacturedOn`.

**UI (Transfer Goods Issue).** The allocator now prefers one lot that can cover the whole quantity (oldest lot first by manufacture date, else lot code); the user can choose a lot per line and a staging cell; a "Planned picking" table shows product, lot, bin and quantity; when several lots would be used an alert asks for explicit confirmation before sending `acceptMixedLots: true`.

## Per-line approval and stock check at review — 22 November 2026 (batch 3)

**Endpoint.** `POST /warehouse-transfers/:id/review` body gains optional `lines: [{ lineId, approvedQtyBase }]`.

**Behavior.**
- `lines` is allowed only with `decision: APPROVE`. A listed line is approved at `approvedQtyBase` (0 ≤ value ≤ requested quantity; 0 drops the line); unlisted lines keep the requested quantity. At least one line must stay above 0. Approval history stores each line's approved quantity (`outcome` `REJECT` for 0).
- `reason` is now optional for `APPROVE` (history stores "Duyệt" or "Duyệt, điều chỉnh số lượng một số dòng" when omitted) and still required for `REJECT` and `REVISE`.
- On `APPROVE` the server checks, inside the command transaction, that the approved quantity of every line does not exceed the free stock at the source warehouse (GOOD, store-owned, STORAGE bins, minus reservations, pending tasks and holds; only the fixed lot when the line has one). It fails with the product, lot and available quantity otherwise. **This is a check, not a reservation:** stock is still reserved when the dispatch is created.
- If the approved quantity is lower than the planned `sourceLocations`, bin quantities are trimmed in order so dispatch keeps working; emptied bins are removed.
- Completion compares against `approvedQtyBase`, so a line approved at 0 does not block completion.

**Read DTO.** `GET /warehouse-transfers/:id` returns, while the request is `PENDING_APPROVAL`, `APPROVED` or `REVISION_REQUIRED`, `stockCheck[]` per request line: `sourceFreeQtyBase`, `sourceLots[] { lotId, lotLabel, freeQtyBase }` and `destinationQtyBase` (GOOD store-owned stock in the destination's STORAGE bins). `header.neededOn` is now part of the detail read fields.

**UI.** The "Duyệt yêu cầu" card shows the needed-by date, a table with requested quantity, free source stock (red when short, per-lot breakdown when no lot is fixed), destination stock and an editable approved quantity. "Duyệt" no longer needs a note and is disabled while a quantity is invalid or exceeds free stock.

**Not changed.** Reserving stock at approval time is deliberately left out: reservations are bound to the dispatch lifecycle (consume, release, move), so holding stock earlier needs its own release path on cancel, revise and close.

## Execution: short pick, assignee, handover details, split receipt — 22 November 2026 (batch 4)

**Pick task assignee.** `POST /warehouse-transfers/documents/:id/internal-requirements` accepts optional `assigneeId` for a PICK task. The user must be active, assigned to the source warehouse and hold `stock_transfer:dispatch`; the task stores it in `header.assignedTo` (default: the creator). `POST /warehouse-transfers/tasks/:id/confirm` for a PICK task now accepts the dispatch creator **or** the assignee (previously the creator only). The task read DTO returns `header.assignedTo` and its `items`.

**Handover details.** The confirm body gains optional `driverName` (≤160), `driverPhone` (≤30) and `note` (≤500) next to `recipientName` and `vehiclePlate`. They are stored on the handover header (`transfer_dispatches.handovers[].header`) and returned in the dispatch detail read fields.

**Short pick.** The PICK confirm body gains `pickedLines: [{ taskLineId, pickedQtyBase }]` and `shortReason` (required with `pickedLines`; both rejected for PUTAWAY).
- A line picked below its planned quantity releases the unpicked part of its reservation (`releasedQty`) and shrinks the task, requirement and dispatch line to the picked quantity; picked 0 removes the line from all three. At least one line must remain.
- The dispatch header stores `shortPickReason`. The posted dispatch, handover and draft receipt carry only the picked quantities.
- The request stays `APPROVED` with dispatched < approved, so another dispatch can supply the rest or the owner can close it partially.

**Split receipt.** No contract change: `POST /warehouse-transfers/dispatches/:id/receipts` already accepts several lines with the same `dispatchLineId`. The receiving form now uses this to record GOOD and DAMAGED quantities of one dispatch line in one receipt.

**Data.** `handover-header` gains optional `driverName`, `driverPhone`, `note`; `transfer_dispatches.header` gains `shortPickReason`. Additive, no migration.

**UI.**
- Transfer Goods Issue: creating the draft dispatch also creates the pick task in the same step (the transfer page keeps the "Tạo nhiệm vụ lấy hàng" button if that second call fails).
- Transfer detail, pick task: lines with "Theo lệnh" and "Lấy thực tế", a mandatory reason when short, and the handover fields recipient, plate, driver, phone and note.
- Receiving form (transfer): one row per dispatch line with good quantity and location, plus optional damaged quantity, quarantine location and reason; good + damaged may not exceed the remaining quantity.
- Transfer detail header: a "Nhận hàng" button opens the receiving form for the dispatch that still has goods in transit.
- The assignee field has an API only; there is no picker in the UI yet.

## Pick assignee picker, destination-initiated requests, stop-forward — 22 November 2026 (batch 5)

**Pick assignee (completes batch 4).**
- `GET /warehouse-transfers/pick-assignees?warehouseId=` (permission `stock_transfer:dispatch`, access to that warehouse) returns `[{ id, fullName }]`: active users of the warehouse with role `WAREHOUSE` and `stock_transfer:dispatch`.
- When `assigneeId` is omitted on a PICK requirement: a warehouse-role creator keeps the task; for any other creator (for example the owner) the task goes to the warehouse keeper of the source warehouse **if there is exactly one**, else to the creator.
- UI: both the Transfer Goods Issue form and the transfer page show "Người lấy hàng & bàn giao" with the default "thủ kho của kho nguồn".

**Destination-initiated requests.**
- `POST /warehouse-transfers`, `PUT /warehouse-transfers/:id` and `POST /warehouse-transfers/:id/cancel` accept a user who can access the source **or** the destination warehouse (previously the source only). Approval, dispatch, receipt and completion are unchanged.
- `GET /warehouse-transfers/options?warehouseId=` no longer requires warehouse access for users holding `stock_transfer:create`, so a destination can see source stock when asking for goods. Other users still need access to the warehouse.
- UI: the request form has "Chiều yêu cầu": "Chuyển hàng từ kho của tôi đi" or "Xin hàng về kho của tôi" (destination limited to the user's warehouses, source to any other).

**Stop forwarding.** `POST /warehouse-transfers/:id/close-partial` is allowed for the receiving warehouse (`stock_transfer:receive`), the shipping warehouse (`stock_transfer:dispatch`) or the owner; before it required the receiving warehouse. All existing preconditions are unchanged (nothing in transit, no open discrepancy, receipts or a write-off present, a real shortfall).

**UI.** The transfer page shows "Bước tiếp theo" with who performs it (approver, picker at the source, receiver at the destination, owner for discrepancies); every quantity is shown in base units with the pack unit in brackets (for example `120 Viên (10 Thùng)`); the stop button also appears for the shipping warehouse.

**Cleanup.** The unused mock transfer screens (`features/transfers/list`, `features/transfers/detail`) and `transfersStore.ts` were removed; `features/transfers/types.ts` stays because the dashboard and `mockStore` use it.

Yêu cầu chuyển kho dùng `workflowStatus` và tiến độ thực xuất/nhận theo từng dòng. Đợt 1 bỏ `header.executionStatus`. Phân bổ `items[].sourceLocations[]` vẫn cho phép tổng nhỏ hơn lượng yêu cầu.
