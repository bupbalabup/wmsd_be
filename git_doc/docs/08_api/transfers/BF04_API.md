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

### Request creation stock preview — 17 November 2026

Source: user requested source-warehouse stock in pieces/cartons/pallets at step 2. The paired FE reuses the existing authorized stock options payload; no extra endpoint or query is added. Selecting a product shows on-hand and available quantities for STORE/GOOD stock in STORAGE locations, with the same eligibility as source dispatch allocation. Selecting a lot narrows both totals. Loading a different warehouse hides the previous warehouse's data; loading/error states never display stale stock as a current result.

The preview converts each batch separately, preferring its current batch conversion over a product conversion, then sums the results. Cartons may fall back to the batch's piecesPerCarton only when the product's base unit is pieces. Carton UOM uses isCarton, not a hardcoded BOX code; pallet uses the configured PALLET code/name. Missing factors show “Chưa cấu hình”; one unconvertible stocked batch prevents a misleading partial total. Zero stock and missing configuration are distinct. Values use exact rational arithmetic, Vietnamese number formatting and at most three fractional digits; truncated results have ≈. Negative free quantities display zero. Carton/pallet totals are equivalent quantities, not a count of sealed cartons or physical pallets. No stock, approval, request validation or conversion persistence changes.

### Automatic putaway and completion — 17 November 2026

The FE request form captures only source/destination warehouses, product/lot and
the requested quantity in a configured unit. Per user decision on 17 November,
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

The creator with stock_transfer:update can edit quantities and configured units directly in existing table rows while PENDING_APPROVAL/REVISION_REQUIRED. The frontend preserves input on validation/failure, marks invalid quantities, prevents saving zero/negative/invalid or over-six-decimal quantities, and keeps unavailable historical units visible rather than replacing them silently. Unit choices use selected-batch overrides ahead of product defaults. Update sends the unchanged warehouse IDs, original expectedVersion, edited enteredQty/enteredUnit and existing retry/idempotency behavior to PUT /:id. Backend creator/state/scope/conversion/source-document checks remain authoritative and unchanged. No stock is posted by editing.

General information uses two columns on desktop: source/destination above reason/creation date; mobile stacks the fields. Editing controls remain inside the table's horizontal scroll region. No shared component API, model, permission grant or database change.

Create TR:

```json
{
  "idempotencyKey": "tr-001",
  "sourceWarehouseId": "<sourceWarehouseId>",
  "destinationWarehouseId": "<destinationWarehouseId>",
  "reason": "Replenish destination stock",
  "lines": [{ "productId": "<productId>", "enteredUnit": "PIECE", "enteredQty": "20" }]
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
