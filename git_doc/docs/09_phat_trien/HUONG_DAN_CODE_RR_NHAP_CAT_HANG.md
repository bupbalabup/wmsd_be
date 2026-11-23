# Hướng dẫn đọc code: từ Yêu cầu bổ sung (RR) đến Nhập hàng và Cất hàng

> RR duyệt theo đơn vị gốc. PO đối chiếu lượng duyệt theo đơn vị gốc và chỉ áp dụng ngoại lệ vượt trần cho thùng. Sau khi ghi nhập, kho đưa hàng lên kệ qua Chuyển vị trí BF03. Tên hàm trong hướng dẫn dùng để tra code trong `be/src`. Phần 2 đi theo luồng chính; [Phần 2B](#phần-2b--luồng-phụ-và-luồng-liên-quan) liệt kê toàn bộ API và các luồng phụ (hủy, sửa, chốt thiếu, sửa kết quả kiểm, đảo phiếu, giữ hộ, bằng chứng, đối soát, module liên quan).

## 1. Thông tin quy trình nghiệp vụ

- **Tên quy trình:** Bổ sung hàng qua mua hàng — RR → PO → Hàng đến & Kiểm nhận → Phiếu nhập mua (ghi tồn). Kho dùng Chuyển vị trí để đưa hàng lên kệ.
- **Bối cảnh:** Kho (hoặc Sales) thấy thiếu hàng, lập **Yêu cầu bổ sung** (RR, mã `YCBS-...`). Owner duyệt số lượng. Kế toán lập **Đơn mua hàng** (PO, `ĐMH-...`) gửi nhà cung cấp. Khi xe hàng đến, thủ kho ghi **Hàng đến kho** (`HĐK-...`) và **Phiếu kiểm nhận** (`PKN-...`), đếm theo lô, chấm chất lượng. Hàng đạt được lập **Phiếu nhập mua** (`PNM-...`), ghi tồn vào **bãi tiếp nhận** (vị trí `RECEIVING`). Sau đó thủ kho lập **Lệnh chuyển vị trí** (`LCV-...`, `TransferOrder` loại `RELOCATE`) và chuyển hàng từ bãi tiếp nhận lên **kệ lưu trữ** (vị trí `STORAGE`).
- **Mục tiêu kỹ thuật:** mỗi bước là một lệnh (command) chạy trong **một MongoDB transaction**, có chống gửi trùng (idempotency), khóa lạc quan theo `version`, ghi `audit_logs`, và mọi thay đổi tồn kho đi qua **sổ cái** `stock_transactions.movements`.

### Mã chứng từ

Mã phiếu chính là `_id` của document (kiểu chuỗi), sinh bởi `nextDocumentFields()` theo mẫu `<tiền tố>-<mã kho>-<YYMMDD>-<6 số>`, ví dụ `YCBS-K01-261116-000001`. Bảng tiền tố `documentTypes` nằm ở [document-number.js:5](../../../src/shared/utils/document-number.js). Riêng `LCV` (và các phiếu điều chuyển) dùng mã kho rút gọn qua `compactUnit`, ví dụ kho `K-GACH-01` thành `KG1`.

| Loại | Tiền tố | Model | Collection |
|---|---|---|---|
| RR | `YCBS` | `ReplenishmentRequest` | `replenishment_requests` |
| PO | `ĐMH` | `PurchaseOrder` | `purchase_orders` |
| ARR | `HĐK` | `GoodsArrival` | `goods_arrivals` |
| INS | `PKN` | `GoodsInspection` | `goods_inspections` |
| GR | `PNM` | `PurchaseReceipt` (discriminator `PURCHASE`) | `goods_receipts` |
| CRCV | `PNGH` | `CustodyReceipt` (nhánh giữ hộ) | `custody_receipts` |
| TO | `LCV` | `TransferOrder` (`header.taskKind = 'RELOCATE'`) | `transfer_orders` |

### API theo thứ tự quy trình

Tất cả có tiền tố `/api` ([app.js](../../../src/app.js), [routes.js](../../../src/routes.js)).

| Bước | Method & path | Hàm service | File |
|---|---|---|---|
| 1 | `POST /replenishments` | `createReplenishment` | [replenishment.commands.js:379](../../../src/modules/replenishments/replenishment.commands.js) |
| 1b | `PUT /replenishments/:id` | `updateReplenishment` | [replenishment.commands.js:406](../../../src/modules/replenishments/replenishment.commands.js) |
| 2 | `POST /replenishments/:id/submit` | `submitReplenishment` | [replenishment.commands.js:438](../../../src/modules/replenishments/replenishment.commands.js) |
| 3 | `POST /replenishments/:id/review` | `reviewReplenishment` | [replenishment.commands.js:463](../../../src/modules/replenishments/replenishment.commands.js) |
| 4 | `POST /purchase-orders` | `createPurchaseOrder` | [purchase-order.commands.js:142](../../../src/modules/purchase-orders/purchase-order.commands.js) |
| 5 | `POST /purchase-orders/:id/confirm` | `confirmPurchaseOrder` | [purchase-order.commands.js:230](../../../src/modules/purchase-orders/purchase-order.commands.js) |
| 6 | `POST /purchase-orders/:id/inspections` | `createInspection` | [po-receiving.service.js:162](../../../src/modules/po-receiving/po-receiving.service.js) |
| 6b | `PUT /goods-inspections/:id` | `updateInspection` | [po-receiving.service.js:203](../../../src/modules/po-receiving/po-receiving.service.js) |
| 7 | `POST /goods-inspections/:id/confirm` | `confirmInspection` | [po-receiving.service.js:241](../../../src/modules/po-receiving/po-receiving.service.js) |
| 8 | `POST /goods-receipts/purchase/:id/post` | `postReceipt` | [po-receiving.service.js:380](../../../src/modules/po-receiving/po-receiving.service.js) |
| 9a | `GET /goods-receipts/purchase/:id` | `getDocument` → `enriched` | [purchase-read.service.js:68](../../../src/modules/po-receiving/purchase-read.service.js) |
| 9b | `GET /location-movements/options?warehouseId=…` | `locationMovementOptions` | [location-movement.service.js:104](../../../src/modules/location-movements/location-movement.service.js) |
| 9 | `POST /location-movements` | `createLocationMovement` | [location-movement.service.js:72](../../../src/modules/location-movements/location-movement.service.js) |
| 9c | `PATCH /location-movements/:id` · `POST /location-movements/:id/cancel` | `editLocationMovement` · `cancelLocationMovement` | [location-movement.service.js:119](../../../src/modules/location-movements/location-movement.service.js) |
| 10 | `POST /location-movements/:id/confirm` | `confirmLocationMovement` | [location-movement.service.js:139](../../../src/modules/location-movements/location-movement.service.js) |

Route của bước 6–8 khai báo trong [po-receiving.routes.js](../../../src/modules/po-receiving/po-receiving.routes.js); `/goods-receipts/purchase` được gắn qua [goods-receipt.routes.js:50](../../../src/modules/goods-receipts/goods-receipt.routes.js). Route bước 9–10 nằm ở [location-movement.routes.js](../../../src/modules/location-movements/location-movement.routes.js), mỗi route có `checkPermission` riêng (`stock_relocation:read/create/confirm`).

> **Đã gỡ (17/11/2026):** `GET /goods-receipts/purchase/:id/putaway-context`, `POST /goods-receipts/purchase/:id/putaway-tasks`, toàn bộ `/api/putaway-tasks` và hàng đợi `stage=AWAITING_PUTAWAY` của `/purchase-receiving/queue`. File `purchase-putaway.service.js` (gồm `createPutaway`, `confirmPutaway`, `placementQuantities`, `linePortionIds`) không còn. Quyết định ghi tại [change_logs.md](../../change_logs.md) mục "17/11/2026 - Chuyển hàng nhập mua bằng BF03".

---

# Phần 1 — Bức tranh tổng quan & bản đồ MongoDB Models

## 1.1. Luồng đi từ đầu đến cuối (End-to-End Flow)

1. **Lập RR (nháp hoặc gửi luôn).** Nhân viên kho/Sales chọn kho, ngày cần hàng, lý do và từng dòng sản phẩm + đơn vị + số lượng. Server quy đổi số lượng sang **đơn vị gốc** (`qtyBase`), tự đánh giá tồn khả dụng, RR đang mở, PO đang về và tồn ở kho khác. Nếu có cảnh báo, người lập phải xác nhận "vẫn cần" kèm giải trình. RR được lưu `DRAFT` (hoặc `SUBMITTED` nếu `action = 'SUBMIT'`), `version = 1`.
2. **Sửa RR** (chỉ người lập, chỉ khi `DRAFT`/`REVISION_REQUIRED`, chưa có PO). Mỗi lần sửa tăng `version`.
3. **Gửi duyệt RR.** Server đánh giá lại từng dòng theo dữ liệu mới nhất, rồi chụp **ảnh bất biến** (`submissions[]`) gồm kho, sản phẩm, đơn vị, hệ số quy đổi, số lượng. Trạng thái → `SUBMITTED`.
4. **Owner duyệt RR.** Người duyệt phải khác người lập. Với `APPROVE`, xét mọi dòng và gửi lượng gốc `approvedQtyBase` cho từng dòng. Giảm lượng cần lý do riêng trên dòng. Dòng thùng chỉ duyệt lượng tương ứng số thùng nguyên. Quyết định được ghi vào `approval_history`. RR chuyển sang `APPROVED`, `REJECTED` hoặc `REVISION_REQUIRED`.
5. **Lập PO từ RR đã duyệt.** Mỗi dòng PO trỏ về một dòng RR và quyết định duyệt còn hiệu lực. Kế toán có thể đổi đơn vị bằng `uomCode`. Chỉ đơn vị thùng được vượt lượng duyệt với số thùng nguyên nhỏ nhất đủ phủ lượng duyệt. Chỉ mục duy nhất giữ một PO còn hiệu lực cho mỗi RR. PO lưu `DRAFT`.
6. **Phát hành PO.** Kiểm lại RR vẫn `APPROVED` cùng revision, sản phẩm/NCC/kho còn hoạt động. PO → `OPEN`.
7. **Hàng đến – lập phiếu kiểm nhận.** Thủ kho ghi thời điểm đến, người giao, rồi từng dòng: dòng PO, **lô thực nhận**, số đếm (theo thùng nguyên hoặc đơn vị gốc), chất lượng (`GOOD/DAMAGED/PENDING/BLOCKED`), quyết định sở hữu (`ACCEPT/CUSTODY/REJECT`), tình trạng bao bì. Server tạo cùng lúc `GoodsArrival` + `GoodsInspection` ở `DRAFT`. Chưa có tồn kho.
8. **Xác nhận kiểm nhận.** Server kiểm tổng lượng `ACCEPT` không vượt phần PO còn được nhận; bắt buộc chọn **vị trí RECEIVING** cho mỗi dòng `ACCEPT`. Sinh **Phiếu nhập mua `DRAFT`** cho phần `ACCEPT`, sinh **Phiếu giữ hộ** cho phần `CUSTODY`. Kiểm nhận → `CONFIRMED`, Hàng đến → `RECORDED`.
9. **Ghi tồn phiếu nhập mua.** Server khóa kho và các vị trí, đối chiếu lại nguồn kiểm nhận, tìm/tạo `stock_holding_points` + `inventory_balances` (chủ hàng `STORE`, chất lượng `GOOD`), cộng tồn, tách **kiện** (`packagingPortions`: thùng nguyên `SEALED` / hàng lẻ `LOOSE`/`OPEN`), ghi `stock_transactions` (`PURCHASE_RECEIPT`), kiểm sức chứa. Phiếu → `POSTED`. PO → `PARTIAL` hoặc `COMPLETED`.
10. **Lập lệnh chuyển vị trí (BF03).** Chi tiết phiếu nhập đã ghi trả `receivingBalanceId` cho từng dòng và `capabilities.relocate`. Nút **Chuyển vị trí** mở form BF03 với kho và số dư ở bãi tiếp nhận. Thủ kho chọn số dư nguồn (kèm `sourceBalanceVersion`), vị trí đích, đơn vị và **số nguyên** thùng/viên, ghi lý do. Chế độ "Thùng nguyên + viên rời" tách một hàng trên form thành tối đa hai dòng `packagingState: 'SEALED'` và `'LOOSE'` cùng nguồn, đích. Số dư đang bị kiểm kê mù không hiện cho người không phải Owner. Server tạo `TransferOrder` `taskKind: 'RELOCATE'` ở `OPEN`. Chưa di chuyển tồn; lượng trên lệnh mở được tính là "đang chờ" nên lệnh khác không lấy chồng được. Người lập có thể sửa hoặc hủy lệnh.
11. **Xác nhận thực chuyển.** Chỉ **người lập lệnh** được xác nhận. Có thể xác nhận một phần (`PARTIAL`) rồi xác nhận tiếp. Server kiểm số dư nguồn chưa bị ai đổi, khóa kho/vị trí, chuyển tồn bằng `moveStock`, ghi `StockTransaction` `operation: 'RELOCATE'`, kiểm sức chứa. Đủ mọi dòng ⇒ `CONFIRMED`. Hàng ở ô `STORAGE` có `isPickable` được tính vào tồn khả dụng.
12. **Mọi bước** trả về một "biên nhận" `{ id, version, workflowStatus, operationId, resultRefs, replayed }`. Gửi lại cùng `operationKey`/`creationKey` và cùng payload sẽ nhận lại đúng biên nhận cũ (`replayed: true`) thay vì làm lại.

### Sơ đồ trạng thái

```text
RR : DRAFT ─submit─► SUBMITTED ─review─► APPROVED │ REJECTED │ REVISION_REQUIRED ─(sửa, submit)─► SUBMITTED   (cancel khi chưa có PO ─► CANCELLED)
PO : DRAFT ─confirm─► OPEN ─post GR một phần─► PARTIAL ─post GR đủ─► COMPLETED   (close-remainder ─► CLOSED; cancel khi chưa có chứng từ nhận ─► CANCELLED)
ARR: DRAFT ─confirm INS─► RECORDED   (hủy INS nháp ─► CANCELLED)
INS: DRAFT ─confirm─► CONFIRMED      (hủy nháp ─► CANCELLED)
GR : DRAFT ─post─► POSTED            (hủy nháp ─► CANCELLED)
TO : OPEN ─confirm thiếu─► PARTIAL ─confirm đủ─► CONFIRMED   (cancel khi OPEN/PARTIAL ─► CANCELLED; sửa chỉ khi OPEN)
```

### Chuỗi liên kết chứng từ (`sources[]`)

```text
RR.items[i] ◄─requestItemId── PO.items[j] ◄─purchaseOrderItemId── ARR.items[k]
                                                                    ▲ inspectedSourceLineId
                                         INS.items[k] ──inspectionResultId──► GR.items[m]
                                                                                │ movement.toBalanceId
                                                                                ▼ (= receivingBalanceId)
                                                      TO(RELOCATE).items[n].details.sourceBalanceId
```

Lệnh chuyển vị trí **không** có `sources[]` trỏ về phiếu nhập; nó chỉ trỏ tới **số dư** (`sourceBalanceId`). Số dư ở bãi tiếp nhận có thể chứa hàng của nhiều phiếu nhập cùng lô, nên sau bước 8 không còn liên kết dòng-với-dòng từ phiếu nhập tới lệnh chuyển.

Mỗi document còn có mảng `sources[]` (`{ documentId, subjectCollection, itemId, linkedQty, relationCode }`) ghi nguồn gốc theo cả header và dòng.

## 1.2. Các MongoDB Models tham gia

| Tên Model (collection) | Hành động | Mục đích nghiệp vụ trong quy trình |
|---|---|---|
| `User` (`users`) | Find + Populate `roleId.permissionIds` | Nạp lại vai trò, quyền và kho được gán **ở mỗi lệnh**, không tin token cũ. |
| `Warehouse` (`warehouses`) | Find / exists / `findOneAndUpdate($inc stockOperationVersion)` | Kho phải `isActive`; `code` dùng để cấp mã phiếu; `stockOperationVersion` tăng ở mọi lệnh ghi tồn để tuần tự hóa theo kho. |
| `Product` (`products`) | Find / exists | Sản phẩm phải `isActive`; `baseUnit`, `wholeBaseUnits` (chỉ nhận số nguyên đơn vị gốc), `stockThresholds` (định mức theo kho). |
| `Uom` (`uoms`) | Find / exists | Đơn vị nhập; `isCarton` (là đơn vị thùng), `areaMm2` (đơn vị diện tích như m²). |
| `Conversion` (`conversions`) | Find (sort `validFrom`) / Aggregate | Hệ số quy đổi `basePerUnit` theo sản phẩm, đơn vị, (tùy chọn) lô. |
| `ProductBatch` (`product_batches`) | Find / Update (`updatedAt`) | Lô phải `VERIFIED`; `piecesPerCarton` và kích thước thùng; khóa định danh lô khi đưa vào chứng từ. |
| `ReplenishmentRequest` (`replenishment_requests`) | Create / Find / Update | Chứng từ RR, dòng hàng, ảnh gửi duyệt, lượng duyệt. |
| `ApprovalHistory` (`approval_history`) | Create / Find | Quyết định duyệt RR bất biến. PO đọc `itemDecisions[].approvedQtyBase` để giới hạn lượng. |
| `SalesOrder`, `WarehouseIssueRequest`, `Stocktake`, `StocktakeSnapshot` | Find / exists | Chỉ khi dòng RR có nguồn `SALES_SHORTAGE` hoặc `STOCKTAKE_LOW_STOCK`. |
| `PurchaseOrder` (`purchase_orders`) | Create / Find / Update / exists | Đơn mua; trạng thái theo lượng đã nhập. |
| `Supplier` (`suppliers`) | Find / exists | NCC phải `ACTIVE`; chụp `supplierSnapshot`. |
| `GoodsArrival` (`goods_arrivals`) | Create / Update / Find | Hồ sơ hàng đến: thời điểm, người giao, dòng thực nhận theo lô. |
| `GoodsInspection` (`goods_inspections`) | Create / Update / Find | Kết quả kiểm: chất lượng, quyết định sở hữu, bao bì, bãi tiếp nhận. |
| `PurchaseReceipt` (`goods_receipts`, `documentKind: 'PURCHASE'`) | Create / Update / Find | Phiếu nhập mua – chứng từ duy nhất làm tăng tồn sở hữu của cửa hàng. |
| `CustodyReceipt` (`custody_receipts`) | Create | Nhánh hàng `CUSTODY` (giữ hộ NCC), không cộng vào tồn của cửa hàng. |
| `WarehouseLocation` (`warehouse_locations`) | Find / `findOneAndUpdate($inc operationVersion)` | Kiểm vị trí đúng kho, đúng loại (`RECEIVING`, `STORAGE`…); tăng `operationVersion` để khóa vị trí trong transaction. |
| `StocktakeLocationLock` (`stocktake_location_locks`) | exists / Find | Vị trí đang kiểm kê thì không được ghi tồn, không tính tồn khả dụng. |
| `Stocktake` (`stocktakes`) — đọc | Find | `blindCountScope` tìm phiên `COUNTING` để ẩn số dư bị khóa khỏi form BF03 với người không phải Owner. |
| `StockHoldingPoint` (`stock_holding_points`) | Find / Create | "Điểm giữ hàng" 1-1 với vị trí (`type: 'LOCATION'`). |
| `InventoryBalance` (`inventory_balances`) | Find / Create / `updateOne` theo `version` | Số dư tồn theo khóa (điểm giữ hàng × lô × chất lượng × chủ hàng) và các kiện. Bước 9 chọn nguồn theo `_id` và `version` của số dư. |
| `StockReservation` (`stock_reservations`) | Find (Update/Create khi chuyển giữ hàng) | Tính phần tồn đã giữ cho đơn bán. |
| `DefectReport` (`defect_reports`) | Find | Tính phần tồn đang bị chặn (`holds`). |
| `TransferOrder` (`transfer_orders`) | Create / Find / Update | Lệnh chuyển vị trí (`taskKind: 'RELOCATE'`). Lệnh `OPEN/PARTIAL` chiếm tồn "đang chờ". |
| `User` (`users`) — đọc | Find | Tên người thực hiện trong chi tiết lệnh chuyển (`performedByName`). |
| `Uom`, `Conversion` — đọc | Find | Danh sách đơn vị và quy đổi cho form BF03 (`locationMovementOptions`). |
| `StockTransaction` (`stock_transactions`, nhúng `movements[]`) | Create / Find | Sổ cái tồn kho append-only; mỗi movement ghi trước/sau của từng balance. |
| `OperationRecord` (`operation_records`) | Create / Find | Biên nhận idempotency của mỗi lệnh. |
| `AuditLog` (`audit_logs`) | Create | Nhật ký ai làm gì, version trước/sau. |
| `SystemEvent` (`system_events`) | Create | Outbox sự kiện `BUSINESS_NOTIFICATION` để gửi thông báo sau. |

### Schema then chốt (rút gọn)

```js
// --- MONGOOSE SCHEMAS (trích) ---
// Dòng hàng dùng chung: src/models/document-item.schema.js
{ lineNo, lineKind, productId: ref('Product'), lotId: ref('Lot'),
  enteredUnit, baseUnitSnapshot, baseUnitsPerUnit /*Decimal, scale 12*/,
  packagingSnapshot, enteredQty, qtyBase /*Decimal*/, productNameSnapshot,
  sources: [DocumentSource] }
// rule: enteredQty × baseUnitsPerUnit == qtyBase (hoặc làm tròn lên số nguyên khi đơn vị diện tích)

// RR: src/models/replenishment-request.model.js
{ _id: 'YCBS-...', documentNo, workflowStatus, version, createdBy,
  header: { warehouseId, neededOn, triggerReason, creationKey, submittedBy, submittedAt,
            approvedRevision, latestDecisionId: ref('ApprovalHistory') },
  items: [ DocumentItem + { approvedQtyBase, details: ReplenishmentDetails } ],
  submissions: [ { documentVersion, warehouseCodeSnapshot, lines: [...] } ] }

// PO: src/models/purchase-order.model.js
{ header: { warehouseId, supplierId, expectedOn, approvedRequestRevision, issuedAt, supplierSnapshot },
  items: [ DocumentItem + { unitPurchasePrice, lineAmount, requestItemId, cancelledRemainderQtyBase } ],
  replenishmentRequestId /*unique partial*/, totalAmount, currency }

// INS dòng: lineKind 'INSPECTION', details = src/models/inspection-details.schema.js
{ inspectedSourceLineId, qualityCode, ownershipDecision: 'ACCEPT'|'CUSTODY'|'REJECT',
  receivingLocationId, inspectedBy, inspectedAt, packagingCondition }

// GR dòng: src/models/goods-receipt.model.js
{ purchaseOrderItemId, arrivalItemId, inspectionId, inspectionResultId, destinationLocationId, custodyBalanceId }

// Tồn: src/models/inventory-balance.model.js — unique(holdingPointId, batchId, qualityStatus, ownerType, ownerId)
{ holdingPointId, batchId, qualityStatus, ownerType: 'STORE'|'SUPPLIER'|'CUSTOMER', ownerId,
  quantityBase, version, packagingPortions: [ { packagingState: 'SEALED'|'OPEN'|'LOOSE',
  sealedPackCount, quantityBase, packagingSnapshot, measuredVolumeMm3,
  volumeUpperBoundMm3 /*cận trên thể tích khi thùng bị mở lúc xuất*/ } ] }

// Sổ cái: src/models/stock-transaction.model.js — unique(sourceId, operation, eventKey), unique(requestKey)
{ sourceType, sourceId, operation, eventKey, requestKey, requestHash, performedBy,
  movements: [ { sourceLineId, fromBalanceId, toBalanceId, quantityBase,
                 fromBefore, fromAfter, toBefore, toAfter, packagingPortionIds } ] }

// Lệnh chuyển vị trí: src/models/transfer-order.model.js — header.taskKind 'RELOCATE', header.reason, stockTransactionId
// dòng: lineKind 'WAREHOUSE_TASK', details = src/models/warehouse-task-details.schema.js
{ fromLocationId, toLocationId, qualityCode, sourceBalanceId, sourceBalanceVersion,
  packagingState /*'SEALED'|'LOOSE', tùy chọn, không mặc định; lệnh cũ không có*/ }
// (service còn ghi thêm ownerType, ownerId vào details)
```

Ghi chú: `ref()` của Mongoose chỉ là khai báo, **MongoDB không kiểm khóa ngoại**. Toàn bộ kiểm tra "dòng này thuộc phiếu kia" nằm trong service.

---

# Phần 2 — Giải phẫu chi tiết từng hàm (theo thứ tự thực thi)

## 2.0. Hạ tầng chung mà mọi lệnh đi qua

Mọi lệnh ghi (tạo RR, duyệt, lập PO, kiểm nhận, ghi tồn, cất hàng) đều có cùng khung: **route → `validate(zod)` → `command()` → `transaction()` → `work(session, actor)`**. Đọc kỹ phần này một lần, các phần sau chỉ nói phần `work` riêng.

### Hàm: `validate(schema)` (middleware) và các schema Zod

- **Vai trò nghiệp vụ:** chặn payload sai hình dạng trước khi chạm DB. Mọi schema đều `.strict()` nên trường lạ bị từ chối. Số lượng truyền dưới dạng **chuỗi thập phân** (`decimalStringSchema`) để không mất độ chính xác.
- **Ví dụ dòng kiểm nhận** — [po-receiving.routes.js:27](../../../src/modules/po-receiving/po-receiving.routes.js):

```js
const line = z.object({ id: oid.optional(), poLineId: oid, lotId: oid, enteredQty: qty,
  enteredUnit: z.string().trim().min(1).max(60).optional(),
  qualityCode: z.enum(['GOOD','DAMAGED','PENDING','BLOCKED']),
  ownershipDecision: z.enum(['ACCEPT','CUSTODY','REJECT']),
  packagingCondition: z.enum(PACKAGING_CONDITIONS), handlingNote: optionalText(2000),
  receivingLocationId: oid.optional() }).strict();
```

  `arrivedAt` còn bị chặn không được ở tương lai (`iso` dòng 26). Kết quả hợp lệ nằm ở `req.validated`.

### Hàm: `command(user, code, permission, targetId, input, authorizeReplay, work)`

[document-command.js:64](../../../src/shared/utils/document-command.js)

- **Vai trò nghiệp vụ:** "người gác cổng" của mọi lệnh: kiểm quyền, chống làm hai lần, ghi biên nhận + audit + sự kiện, tất cả trong cùng transaction với dữ liệu nghiệp vụ.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò & dữ liệu |
|---|---|---|
| `user` | User (từ JWT) | Người gọi; chỉ dùng `_id`, sẽ nạp lại từ DB. |
| `code` | string | Mã lệnh, vd `CREATE_REPLENISHMENT`, `POST_PURCHASE_RECEIPT`. |
| `permission` | string | Quyền bắt buộc, vd `goods_receipt_inspection:post`. |
| `targetId` | string \| null | Mã chứng từ đích (null khi tạo mới). |
| `input` | object | Body đã validate; phải có `operationKey` hoặc `creationKey`. |
| `authorizeReplay` | function | Hàm đọc lại chứng từ để kiểm phạm vi khi trả biên nhận cũ. |
| `work` | `(session, actor, operationId) => {document, ...}` | Phần nghiệp vụ riêng. |
| `requestKey` | string | Khóa client gửi (`operationKey`/`creationKey`). |
| `requestHash` | sha256 | Băm `{code, targetId, input}` — phát hiện "cùng khóa nhưng khác nội dung". |
| `operationKey` | sha256 | Băm `{actor, code, requestKey}` — khóa unique trong `operation_records`. |
| `actor` | User đã populate | Người dùng **hiện tại** trong DB, kèm vai trò và quyền. |
| `prior` | OperationRecord \| null | Biên nhận cũ nếu lệnh đã chạy rồi. |
| Giá trị trả về | `receipt(operation, replayed)` | `{ id, version, workflowStatus, operationId, decisionId?, resultRefs, replayed }`. |

- **Tương tác DB:** `User.findById().populate({ path: 'roleId', populate: { path: 'permissionIds' } })`; `OperationRecord.findOne/save`; `AuditLog.save` (qua `appendAudit`); `SystemEvent.save`. Tất cả dùng chung `session`.
- **Logic từng bước:**

  1. Bắt buộc có khóa thao tác, tính hai mã băm:

  ```js
  const requestKey = input.operationKey ?? input.creationKey ?? input.idempotencyKey;
  if (typeof requestKey !== "string" || !requestKey.trim())
    throw operationConflict("Thiếu mã thao tác");
  const requestHash = hash({ code, targetId: targetId ? String(targetId) : null, input });
  const operationKey = hash({ actor: String(user._id), code, requestKey });
  ```

  *Tại sao:* mạng chập chờn khiến client bấm lại. Cùng người + cùng lệnh + cùng khóa ⇒ cùng `operationKey`. Nếu payload khác (`requestHash` khác) thì đó là lỗi của client, trả 409 thay vì âm thầm làm khác đi.

  2. Trong transaction: nạp lại người dùng, kiểm quyền, tìm biên nhận cũ:

  ```js
  const actor = await User.findById(user._id)
    .populate({ path: "roleId", populate: { path: "permissionIds" } })
    .session(session);
  requirePermission(actor, permission);
  const prior = await OperationRecord.findOne({ operationKey }).session(session);
  if (prior) return replay(prior, actor, session);
  ```

  *Tại sao:* quyền có thể bị thu hồi sau khi đăng nhập; kiểm theo DB tại thời điểm thực thi. Khi replay vẫn gọi `authorizeReplay` để đảm bảo người đó còn được xem chứng từ.

  3. Chạy `work`, rồi ghi biên nhận, audit, sự kiện (dòng 108–158). `subjectType` lấy từ `document.constructor.collection.name`, `resultCode` = `workflowStatus` mới.

  4. Bắt lỗi trùng khóa / commit không rõ kết quả:

  ```js
  if (error.code === 11000 || error.hasErrorLabel?.("UnknownTransactionCommitResult")) {
    ...
    const prior = await OperationRecord.findOne({ operationKey });
    if (prior) return replay(prior, actor);
  }
  throw error;
  ```

  *Tại sao:* hai request song song cùng khóa ⇒ một cái thắng, cái kia đụng unique index `operationKey`; lúc này đọc biên nhận của cái thắng và trả về như replay.

### Hàm: `transaction(work)`

[persistence.js:11](../../../src/shared/utils/persistence.js)

- **Vai trò:** mở MongoDB session, chạy `work` trong `withTransaction` với `readConcern: snapshot`, `writeConcern: majority` ([persistence.js:7](../../../src/shared/utils/persistence.js)).
- **Biến:** `session` (ClientSession, mang thêm `session.documentNumbers` là Map số phiếu đã cấp trong lần chạy), `attempt` (số lần thử lại do trùng mã phiếu, tối đa 20), `runs` (đếm số lần driver tự chạy lại callback).
- **Logic:**

  ```js
  return await session.withTransaction(() => {
    if (runs++) observePlanning("transaction_retry", { reason: "snapshot_conflict" });
    session.documentNumbers = new Map();
    return transactionContext.run(session, () => work(session));
  }, transactionOptions);
  ...
  if (error.code === 11000 && attempt < 20 && isDocumentId(error.keyValue?._id ?? error.keyValue?.documentNo)) { ... continue; }
  ```

  *Tại sao:* mã phiếu là `_id`. Hai giao dịch song song có thể cấp cùng số `...000007`; giao dịch thua bị lỗi 11000 trên `_id` ⇒ chạy lại toàn bộ giao dịch và cấp số mới. `withTransaction` tự chạy lại khi gặp `TransientTransactionError` (xung đột ghi), nên `work` phải **không có tác dụng phụ ngoài DB**.

### Hàm: `nextDocumentFields(Model, type, warehouseId, session)`

[document-number.js:29](../../../src/shared/utils/document-number.js)

- **Vai trò:** cấp mã phiếu tăng dần theo (loại, kho, ngày) mà **không có collection đếm**.
- **Biến:** `config` (`['YCBS','Yêu cầu bổ sung']`), `unit` (= `warehouse.code`), `period` (`YYMMDD` giờ Việt Nam), `patterns` (regex mã hiện tại và mã lịch sử có khoảng trắng), `codes` (mọi `_id` khớp tiền tố trong collection + trong `operation_records.subjectId`), `last`, `sequence`. Trả về `{ _id, documentNo, tenLoaiPhieu, maDonVi, kyDanhSo, soThuTu }`.
- **Logic chính:**

  ```js
  if(!session?.inTransaction())throw validationError('Cấp mã phiếu phải nằm trong giao dịch');
  ...
  const query=path?{$or:[{[path+'._id']:numberFilter},{[path+'.documentNo']:numberFilter}]}:{_id:numberFilter};
  const rows=await Model.collection.find(query,{session,projection}).toArray();
  ...
  const history=await operations.find({subjectId:numberFilter},{session,projection:{subjectId:1}}).toArray();
  ...
  const sequence=Math.max(last,session.documentNumbers.get(scope)??0)+1;
  ```

  *Tại sao:* đọc cả `operation_records` để một phiếu đã bị xóa không bị cấp lại số (biên nhận vẫn giữ mã cũ). `session.documentNumbers` giúp một giao dịch cấp nhiều phiếu cùng loại (vd hai phiếu) không trùng số nhau. Với chứng từ **nhúng** (`embeddedPath`, vd phương án xử lý) hàm quét cả `_id` lẫn `documentNo` của phần tử nhúng; chứng từ gốc trong luồng này (RR, PO, HĐK, PKN, PNM, LCV) vẫn chỉ quét `_id`.

- `newBusinessDocument(Model, user, header, items, status)` ([document-number.js:73](../../../src/shared/utils/document-number.js)) gói lại: lấy `warehouseId` từ header, gọi `nextDocumentFields`, tạo `new Model({ ..., workflowStatus: status, version: 1, createdBy, occurredAt, header, items })`. `newDocument()` trong [purchase-core.js:8](../../../src/modules/po-receiving/purchase-core.js) là bí danh cho các chứng từ mua hàng.

### Hàm: `checkVersion(document, expectedVersion)` và `saveVersion(document, previousVersion, session)`

[document-command.js:20](../../../src/shared/utils/document-command.js), [document-command.js:35](../../../src/shared/utils/document-command.js)

- **Vai trò:** khóa lạc quan. Client gửi `expectedVersion` (version lúc mở màn hình). Nếu người khác đã sửa, trả 409 "Chứng từ đã thay đổi, hãy tải lại".
- **Logic `saveVersion`:**

  ```js
  document.version = previousVersion + 1;
  await document.validate();
  const plain = document.toObject();
  delete plain._id;
  const updated = await document.constructor.findOneAndUpdate(
    { _id: document._id, version: previousVersion },
    { $set: plain },
    { session, returnDocument: "after" },
  );
  if (!updated) throw versionConflict("Chứng từ đã thay đổi", previousVersion);
  ```

  *Tại sao:* điều kiện `version: previousVersion` trong filter là chốt chặn cuối cùng ở tầng DB. `validate()` chạy trước để các rule lồng (vd `qtyBase = enteredQty × hệ số`) được kiểm. Ghi đè **toàn bộ** document bằng `$set: plain`.
- Lưu ý: nhiều chỗ gọi `saveVersion(po, po.version, session)` **chỉ để tăng version** của chứng từ cha (PO, GR) — đây là kỹ thuật "chạm" để hai giao dịch song song trên cùng PO xung đột ghi và một trong hai phải chạy lại.

### Hàm: `requirePermission`, `requireWarehouseAccess`, `scopedDocument`

[access.js:14](../../../src/shared/utils/access.js), [access.js:34](../../../src/shared/utils/access.js), [document-command.js:27](../../../src/shared/utils/document-command.js)

- `requirePermission(user, perm)`: user phải `isActive`, có vai trò, và vai trò chứa quyền.
- `requireWarehouseAccess(user, warehouseId)`: Owner qua hết; vai trò khác phải có kho trong `user.warehouseIds`.
- `scopedDocument(Model, id, user, session)`: `findById` + kiểm kho của `header.warehouseId`; không thấy ⇒ 404.

### Hàm: `appendAudit({...})`

[audit.js:15](../../../src/shared/utils/audit.js) — tạo `AuditLog` với `eventKey` ngẫu nhiên, `action` = mã lệnh, `versionBefore/After`, `operationId`, `transactionId` (id sổ cái nếu lệnh có ghi tồn), `warehouseIds`, `reason`.

---

## 2.1. Bước 1 — Lập RR: `createReplenishment(user, input)`

[replenishment.commands.js:379](../../../src/modules/replenishments/replenishment.commands.js). Route `POST /api/replenishments` có `checkPermission("replenishment_request:create")` + `validate(createReplenishmentSchema)` ([replenishment.validation.js](../../../src/modules/replenishments/replenishment.validation.js)). Controller trả **201** cho lần đầu, **200** khi replay ([replenishment.controller.js:48](../../../src/modules/replenishments/replenishment.controller.js)).

- **Vai trò nghiệp vụ:** tạo phiếu RR mới (nháp hoặc gửi luôn).
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò & dữ liệu |
|---|---|---|
| `input.action` | `'SAVE_DRAFT' \| 'SUBMIT'` | Lưu nháp hay gửi duyệt ngay. |
| `input.creationKey` | string ≤160 | Khóa chống tạo trùng; lưu vào `header.creationKey`. |
| `input.warehouseId` | ObjectId string | Kho cần bổ sung. |
| `input.neededOn` | `'YYYY-MM-DD'` | Ngày cần hàng (giờ VN). |
| `input.triggerReason` | string ≤200 | Lý do chung của phiếu. |
| `input.note` | string \| null | Ghi chú. |
| `input.lines[]` | 1–100 dòng | `{ productId, enteredUnit, lotId?, enteredQty, reasonNote?, source?, independentNeedConfirmed?, independentNeedReason? }`. |
| `document` | `ReplenishmentRequest` | Phiếu mới, `workflowStatus: 'DRAFT'`, `version: 1`. |
| Trả về | `{ document }` | `command()` biến thành biên nhận. |

- **Tương tác DB:** `Warehouse` (cấp mã + kiểm), `Product`, `ProductBatch`, `Uom`, `Conversion`, các collection đánh giá tồn; `ReplenishmentRequest.save({ session })`. Có transaction (qua `command`).
- **Logic:**

  ```js
  const document = new ReplenishmentRequest({
    ...await nextDocumentFields(ReplenishmentRequest,'RR',input.warehouseId,session),
    workflowStatus: "DRAFT",
    version: 1,
    createdBy: actor._id,
    note: input.note,
    header: { ...(await header(input, actor, session)), creationKey: input.creationKey },
    items: await items(input, actor, session),
  });
  if (input.action === "SUBMIT") await submission(document, actor, session);
  await document.save({ session });
  ```

  *Tại sao:* mã RR chứa mã kho, nên kho không được đổi sau khi lưu (xem `header()`). Khi `SUBMIT` ngay, vẫn qua đúng hàm `submission()` như luồng gửi riêng, nên ảnh gửi duyệt luôn có. `authorizeReplay` là `replay = readRequest`, dùng lại kiểm phạm vi.

### Hàm: `header(input, user, session, saved)`

[replenishment.commands.js:57](../../../src/modules/replenishments/replenishment.commands.js)

- **Vai trò:** kiểm và chuẩn hóa phần đầu phiếu.
- **Biến:** `saved` (header đã lưu khi sửa; undefined khi tạo), `unchanged` (ngày cần hàng không đổi), `warehouse`. Trả về `{ warehouseId, neededOn: Date(…T00:00:00+07:00), triggerReason }`.
- **Logic:**

  ```js
  requireWarehouseAccess(user, input.warehouseId);
  if (saved && !same(saved.warehouseId, input.warehouseId))
    throw validationError("Không đổi kho sau khi đã cấp mã yêu cầu; hủy và lập yêu cầu mới");
  const unchanged = saved?.neededOn && saigonDateOnly(saved.neededOn) === input.neededOn;
  if (!unchanged && input.neededOn < saigonDateOnly())
    throw validationError("Ngày cần hàng không được trước hôm nay");
  ```

  *Tại sao:* một RR nháp từ tuần trước vẫn sửa được dù ngày cần hàng đã qua, miễn là không đổi ngày đó; đổi sang ngày mới thì không được chọn ngày quá khứ.

### Hàm: `items(input, actor, session, previous = [], requestId)`

[replenishment.commands.js:105](../../../src/modules/replenishments/replenishment.commands.js)

- **Vai trò:** biến các dòng client gửi thành dòng RR chuẩn (quy đổi, ảnh sản phẩm, đánh giá tồn, liên kết nguồn).
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `previous` | mảng dòng đã lưu | Khi sửa: để giữ `_id` và ảnh quy đổi cũ. |
| `previousById` | `Map<id, item>` | Tra dòng cũ theo id. |
| `seen` | `Set` | Chặn một id xuất hiện hai lần. |
| `staged[]` | `{ value, reasonNote }` | Dòng đã quy đổi (`value` từ `makeItem`) + lý do dòng. |
| `evaluated[]` | kết quả `evaluateLines` | Tồn khả dụng, RR đang mở, PO đang về, cảnh báo… |
| Trả về | mảng item | `{ ...value, sources, details }` sẵn để gán vào `document.items`. |

- **Logic:**

  1. Dòng có `id` phải thuộc phiếu và không trùng; dòng có nguồn chứng từ (SO/kiểm kê) không được đổi nguồn:

  ```js
  if (lineId && (!old || seen.has(lineId)))
    throw validationError("Dòng hàng không thuộc yêu cầu hoặc bị trùng");
  ...
  if (oldSource?.documentId && ( ... ))
    throw validationError("Không đổi nguồn của dòng đã lưu; xóa dòng và chọn nguồn hợp lệ");
  ```

  2. Đơn vị thùng (`Uom.isCarton`) phải nhập số nguyên, nếu không lỗi "Số thùng phải là số nguyên". Sau đó quy đổi dòng bằng `makeItem(line, index + 1, session, { previous: old, lineKind: "REPLENISHMENT" })`. Lý do dòng: bỏ trống ⇒ giữ lý do cũ; `null` ⇒ xóa.

  3. Đánh giá cả danh sách, rồi bắt buộc giải trình nếu có cảnh báo:

  ```js
  const evaluated = await evaluateLines(actor, { ...input, requestId }, session, {
    permission: requestId ? "replenishment_request:update" : "replenishment_request:create",
    items: staged.map(({ value }) => value),
    strictSourceVersion: input.action === "SUBMIT",
  });
  checkWarnings(input.lines, evaluated);
  ```

  4. Dòng có nguồn chứng từ được ghi thêm `sources[]` với `relationCode` `REPLENISHES_DEMAND` (thiếu hàng bán) hoặc `STOCKTAKE_REPLENISHMENT`; `details` lấy từ `evaluatedDetails()`.

### Hàm: `makeItem(input, lineNo, session, options)`

[document-items.js:8](../../../src/shared/utils/document-items.js) — dùng chung cho RR và cho dòng hàng đến/kiểm nhận.

- **Vai trò:** từ (sản phẩm, lô, đơn vị, số lượng nhập) tính ra dòng chứng từ có `qtyBase` chính xác và ảnh lịch sử.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input` | `{ productId, lotId?, enteredUnit, enteredQty }` | Dữ liệu người dùng. |
| `options.previous` | dòng cũ | Nếu cùng sản phẩm/đơn vị/lô ⇒ dùng lại hệ số cũ (`reuseSnapshot`). |
| `options.includeLotLabel` | bool | Ghi thêm `lotLabelSnapshot` (số lô NSX) — dùng ở kiểm nhận. |
| `options.allowInactiveUom` | bool | Cho phép đơn vị thùng đã ngừng (kiểm nhận). |
| `product` | `Product` | Phải `isActive`. |
| `batch` | `ProductBatch` | Lô phải `VERIFIED` và thuộc sản phẩm. |
| `factor` | Decimal | Hệ số quy đổi `basePerUnit`. |
| `packagingSnapshot` | object | Quy cách thùng của lô: `{ packageUnit: 'Thùng', baseUnitsPerPackage, outerLength/Width/HeightMm }`. |
| `quantity` | Decimal | `qtyBase`. |
| Trả về | item | `{ _id, lineNo, lineKind, productId, lotId, enteredUnit, baseUnitSnapshot, baseUnitsPerUnit, enteredQty, qtyBase, productNameSnapshot, packagingSnapshot, lotLabelSnapshot? }` |

- **Tương tác DB:** `Product.findOne`, `ProductBatch.findOne`, `lockLotIdentity` (update `updatedAt` của lô), `Conversion` (qua `resolveConversion`), `Uom.findOne`.
- **Logic:**

  ```js
  if (input.lotId) {
    batch = await ProductBatch.findOne({ _id: input.lotId, productId: product._id, identificationStatus: 'VERIFIED' }).session(session);
    if (!batch) throw validationError('Lô chưa xác minh hoặc không thuộc sản phẩm');
    await lockLotIdentity(batch._id, session);
    packagingSnapshot = { packageUnit: 'Thùng', baseUnitsPerPackage: String(batch.piecesPerCarton), ... };
  }
  ...
  const quantity = toBaseQuantity(input.enteredQty, factor, product, enteredUom);
  if (!quantity.gt(0) || quantity.decimalPlaces() > 6 || quantity.gte('100000000000000') ||
      (product.wholeBaseUnits && !quantity.isInteger()))
    throw validationError('Số lượng phải quy đổi chính xác sang đơn vị gốc');
  ```

  *Tại sao:* chứng từ lưu **hệ số tại thời điểm lập** (`baseUnitsPerUnit`), nên đổi bảng quy đổi sau này không làm sai phiếu cũ. `lockLotIdentity` ([lotIdentity.js:3](../../../src/shared/utils/lotIdentity.js)) ghi `updatedAt` của lô theo điều kiện `updatedAt` cũ: nếu cùng lúc có người sửa/xóa lô, một trong hai giao dịch xung đột. Sản phẩm `wholeBaseUnits` (vd gạch tính theo viên) không được có số lẻ.

### Hàm: `resolveConversion(product, batch, enteredUnit, session, opts)` và `toBaseQuantity(enteredQty, factor, product, uom)`

[conversions.js:8](../../../src/shared/utils/conversions.js), [conversions.js:41](../../../src/shared/utils/conversions.js)

- **Thứ tự tìm hệ số:** đơn vị = đơn vị gốc ⇒ `1`; nếu có lô ⇒ quy đổi riêng của lô (mới nhất có `validFrom ≤ now`); nếu không có và (không có lô hoặc đơn vị không phải thùng) ⇒ quy đổi chung của sản phẩm (`productBatchId: null`); không có ⇒ lỗi "Thiếu quy đổi…".

  ```js
  let conversion = batch && await Conversion.findOne({ ...scope, productBatchId: batch._id }).sort({ validFrom: -1 }).session(session);
  if (!conversion && (!batch || !uom.isCarton)) {
    conversion = await Conversion.findOne({ ...scope, productBatchId: null }).sort({ validFrom: -1 }).session(session);
  }
  ```

  *Tại sao:* số viên/thùng khác nhau theo lô, nên đơn vị **thùng** bắt buộc phải có quy đổi theo lô; đơn vị diện tích (m²) thì dùng chung theo sản phẩm.
- `toBaseQuantity` nhân hệ số. Với đơn vị diện tích khác đơn vị gốc của sản phẩm nguyên viên, hàm làm tròn tích đến 6 chữ số rồi lấy `ceil`. `normalizedEnteredQty` chia lượng gốc cho hệ số, làm tròn 6 chữ số và kiểm tra quy đổi lại. `makeItem` lưu lượng diện tích đã chuẩn hóa. Ví dụ 10 m² gạch 600×600 được lưu thành 10,08 m² và 28 viên.

### Hàm: `evaluateLines(user, input, session, options)`

[replenishment.evaluation.js:285](../../../src/modules/replenishments/replenishment.evaluation.js). Cũng được gọi trực tiếp qua `POST /replenishments/evaluate` để màn hình xem trước.

- **Vai trò nghiệp vụ:** "trợ lý" giúp người lập/duyệt thấy có thật sự cần mua không. Nó **không chặn** mà sinh cảnh báo; việc chặn do `checkWarnings` làm.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `options.items` | dòng đã quy đổi | Có ⇒ dùng `qtyBase` sẵn; không có ⇒ tự tính qua `previewQuantity`. |
| `options.strictSourceVersion` | bool | Khi gửi duyệt: nguồn (SO/kiểm kê) phải đúng version người lập đã xem. |
| `own` | RR \| undefined | Phiếu đang sửa (để loại khỏi phép tính "RR đang mở"). |
| `available` | Decimal | Tồn **khả dụng** tại kho (`availableStock`). |
| `threshold` / `minimum` | object / Decimal | Định mức tối thiểu của sản phẩm tại kho (`product.stockThresholds`). |
| `requested` | Decimal | Lượng yêu cầu (đơn vị gốc). |
| `stockLimit` | Decimal | Mốc so sánh: `minimum` nếu > 0, ngược lại chính `requested`. |
| `pending` | `{ pendingRequestQtyBase, relatedRequests }` | Lượng đang được RR khác đề nghị. |
| `incoming` | mảng PO | PO `OPEN/PARTIAL` còn chưa về. |
| `other` | object | Tồn khả dụng ở kho khác (`otherWarehouseOptions`). |
| `warnings` | `('OPEN_REQUEST'\|'INCOMING_PO'\|'STOCK_SUFFICIENT')[]` | Danh sách cảnh báo. |
| Trả về | mảng | Mỗi dòng: `{ lineNo, productId, source, availableQtyBase, minimumQtyBase, targetQtyBase, pendingRequestQtyBase, relatedRequests, incomingQtyBase, incomingPurchaseOrders, otherWarehouse..., warnings, warningRequired, evaluatedAt }`. |

- **Logic cảnh báo:**

  ```js
  const stockLimit = minimum?.gt(0) ? minimum : requested;
  const pending = await openRequests(user, product._id, warehouseId, requestId, session);
  const incoming = await incomingPurchaseOrders(product._id, warehouseId, requestId, session);
  const other = await otherWarehouseOptions(user, product._id, warehouseId, line.lotId, session);
  const warnings = [];
  if (number(pending.pendingRequestQtyBase).gt(0)) warnings.push("OPEN_REQUEST");
  if (incoming.length) warnings.push("INCOMING_PO");
  if (stockLimit != null && available.gte(stockLimit)) warnings.push("STOCK_SUFFICIENT");
  ```

  *Tại sao:* ba rủi ro mua thừa: đã có người xin rồi, đã có hàng đang về, hoặc kho còn đủ (trên định mức, hoặc nếu không có định mức thì đủ cho chính lượng xin). Định mức `0` nghĩa là "không có sàn", nếu so `tồn ≥ 0` thì kho rỗng cũng bị cảnh báo — nên mới dùng `requested` thay thế.

#### Các hàm phụ của `evaluateLines`

- **`resolveSource(line, warehouseId, user, session)`** ([evaluation.js:49](../../../src/modules/replenishments/replenishment.evaluation.js)): `MANUAL_OTHER` (mặc định khi không gửi `source`) và `STOCK_THRESHOLD` trả nguyên; `SALES_SHORTAGE` đọc `WarehouseIssueRequest` → `SalesOrder`, kiểm còn hiệu lực, cùng sản phẩm, gắn `version` hiện tại; `STOCKTAKE_LOW_STOCK` đọc `Stocktake` phải `COMPLETED/CLOSED` cùng kho, sản phẩm phải nằm trong phạm vi kiểm kê (dòng kiểm kê hoặc `StocktakeSnapshot`).
- **`availableStock(productId, warehouseId, lotId, session)`** ([evaluation.js:216](../../../src/modules/replenishments/replenishment.evaluation.js)) — định nghĩa "tồn khả dụng":

  ```js
  const locations = await m.WarehouseLocation.find({ warehouseId, isActive: true, locationType: "STORAGE", isPickable: true })...
  const locks = await m.StocktakeLocationLock.find({ locationId: { $in: locationIds }, status: "LOCKED" })...
  ...
  const balances = await m.InventoryBalance.find({ holdingPointId: {...}, batchId: {...}, qualityStatus: "GOOD", ownerType: "STORE" })
  for (const balance of balances) available = available.plus(positive(await freeQuantity(balance, session)));
  ```

  Chỉ tính hàng **đã lên kệ lưu trữ lấy được**, không khóa kiểm kê, chất lượng `GOOD`, thuộc cửa hàng. Hàng còn ở bãi tiếp nhận **chưa** được tính. `freeQuantity` ([stock.js:58](../../../src/shared/utils/stock.js)) = `quantityBase − giữ cho đơn bán − lệnh chuyển đang chờ chưa có giữ hàng (unreservedPendingTaskQuantity) − hàng bị chặn do lỗi`.
- **`openRequests(...)`** ([evaluation.js:149](../../../src/modules/replenishments/replenishment.evaluation.js)): tìm RR `DRAFT/SUBMITTED/APPROVED` cùng kho, cùng sản phẩm (trừ phiếu đang sửa). `pendingRequestQuantity()` (dòng 15) lấy `approvedQtyBase` nếu đã duyệt, ngược lại `qtyBase`; nếu RR đã có PO `OPEN/PARTIAL` thì trừ phần đã lên PO; PO kết thúc ⇒ 0. Chỉ Owner/Kế toán hoặc chính người lập mới thấy chi tiết từng RR (`relatedRequests`).
- **`incomingPurchaseOrders(...)`** ([evaluation.js:181](../../../src/modules/replenishments/replenishment.evaluation.js)): PO `OPEN/PARTIAL` cùng kho, còn lại = `qtyBase − cancelledRemainderQtyBase − đã nhập (GR POSTED)`.
- **`otherWarehouseOptions(...)`** ([evaluation.js:243](../../../src/modules/replenishments/replenishment.evaluation.js)): chạy `availableStock` cho từng kho khác; kho người dùng không được vào chỉ cộng vào `restrictedOtherWarehouseQtyBase`, không lộ chi tiết.

### Hàm: `checkWarnings(lines, evaluated)` và `evaluatedDetails(line, evaluation)`

[replenishment.commands.js:91](../../../src/modules/replenishments/replenishment.commands.js), [replenishment.commands.js:76](../../../src/modules/replenishments/replenishment.commands.js)

```js
if (evaluated[index].warningRequired &&
    (line.independentNeedConfirmed !== true || !line.independentNeedReason?.trim()))
  invalidLines.push({ lineNo: evaluated[index].lineNo, message: "Cần xác nhận nhu cầu và giải trình cảnh báo" });
...
if (invalidLines.length) throw reviewRequired(evaluated, undefined, invalidLines);
```

*Tại sao:* có cảnh báo vẫn lưu được, nhưng người lập phải chủ động tick "nhu cầu độc lập" và viết lý do. Lỗi trả về **409 `ERR-RR-409-004`** kèm `latestEvaluations` để FE hiển thị ngay số liệu mới nhất.

`evaluatedDetails` ghi vào `item.details` các **ảnh số liệu** lúc đánh giá: `availableQtySnapshot`, `pendingRequestCoverageQtySnapshot`, `incomingCoverageQtySnapshot`, `minimumQtySnapshot`, `targetQtySnapshot`, `evaluatedAt`, `triggerType`, `source`, `reasonNote`, `independentNeed*`. Người duyệt xem lại được bối cảnh khi người lập quyết định.

### Hàm: `submission(document, user, session)`

[replenishment.commands.js:233](../../../src/modules/replenishments/replenishment.commands.js)

- **Vai trò:** chụp ảnh bất biến của phiếu tại version được gửi duyệt.
- **Biến:** `warehouse` (lấy `code`, `name`), `snapshots[]` (mỗi dòng: `lineId, lineNo, productId, productSkuSnapshot, productNameSnapshot, baseUomCodeSnapshot, enteredUomCodeSnapshot, enteredQty, conversionSnapshot, qtyBase, evaluation, triggerType, reasonNote`), `now`.
- **Logic:**

  ```js
  const product = await Product.findById(item.productId).session(session);
  if (!product?.isActive) throw validationError("Sản phẩm đã ngừng sử dụng");
  ...
  document.submissions.push({ documentVersion: document.version, submittedBy: user._id, submittedAt: now,
    warehouseId: warehouse._id, warehouseCodeSnapshot: warehouse.code, ..., lines: snapshots });
  document.workflowStatus = "SUBMITTED";
  ```

  *Tại sao:* sau khi gửi, tên sản phẩm/quy đổi có thể đổi; người duyệt và kiểm toán cần biết **chính xác** người lập đã gửi gì. Schema `submissions` là `appendOnly`.

---

## 2.2. Bước 1b — Sửa RR: `updateReplenishment(user, id, input)`

[replenishment.commands.js:406](../../../src/modules/replenishments/replenishment.commands.js)

- **Vai trò:** người lập chỉnh nháp hoặc chỉnh theo yêu cầu "cần sửa".
- **Biến:** `input.expectedVersion`, `input.operationKey`, các trường như khi tạo; `lines[].id` để giữ dòng cũ (dòng bị bỏ khỏi danh sách sẽ biến mất khỏi `items`).
- **Logic:**

  ```js
  const document = await readRequest(id, actor, session);
  checkVersion(document, input.expectedVersion);
  if (!same(document.createdBy, actor._id)) throw forbiddenError("Chỉ người lập được sửa");
  if (!["DRAFT", "REVISION_REQUIRED"].includes(document.workflowStatus)) throw validationError("Yêu cầu không còn được sửa");
  if (await PurchaseOrder.exists({ replenishmentRequestId: id }).session(session)) throw validationError("Yêu cầu đã có đơn mua");
  document.items = await items(input, actor, session, document.items, id);
  document.header.set(await header(input, actor, session, document.header));
  ```

  `readRequest` ([dòng 41](../../../src/modules/replenishments/replenishment.commands.js)) = `scopedDocument` + chặn Sales/Warehouse đọc RR của người khác (trả 404 để không lộ tồn tại).

## 2.3. Bước 2 — Gửi duyệt: `submitReplenishment(user, id, input)`

[replenishment.commands.js:438](../../../src/modules/replenishments/replenishment.commands.js)

- **Vai trò:** chuyển RR đã lưu sang `SUBMITTED`.
- **Biến:** `input.evaluations[]` (tùy chọn, `{ lineId, independentNeedConfirmed, independentNeedReason }` — giải trình bổ sung lúc gửi).
- **Logic:**

  ```js
  const document = await readRequest(id, actor, session);
  checkVersion(document, input.expectedVersion);
  if (!same(document.createdBy, actor._id)) throw forbiddenError("Chỉ người lập được gửi");
  if (!["DRAFT", "REVISION_REQUIRED"].includes(document.workflowStatus)) throw validationError("Yêu cầu không thể gửi ở trạng thái hiện tại");
  await assessSavedRequest(document, actor, session, input.evaluations);
  document.version = input.expectedVersion + 1;
  await submission(document, actor, session);
  return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion };
  ```

  `version` được tăng **trước** `submission()` để `submissions[].documentVersion` trùng với version sẽ được lưu (`saveVersion` đặt lại cùng giá trị).

### Hàm: `assessSavedRequest(document, actor, session, evaluations)` và `savedAssessmentInput(document, overrides)`

[replenishment.commands.js:202](../../../src/modules/replenishments/replenishment.commands.js), [dòng 165](../../../src/modules/replenishments/replenishment.commands.js)

- Dựng lại input từ dòng đã lưu (kèm giải trình mới trong `evaluations`), chạy lại `evaluateLines` với `strictSourceVersion: true`, rồi `checkWarnings`. Ghi đè `item.details` bằng số liệu mới.
- *Tại sao:* giữa lúc lưu nháp và lúc gửi có thể đã có PO khác về hoặc tồn thay đổi; người lập phải giải trình theo số liệu **lúc gửi**. Dòng có nguồn cũ dạng "legacy" (có `triggerType` khác `MANUAL_OTHER` nhưng không có `source`) bị chặn với thông điệp "Nguồn RR cũ cần được chuẩn hóa".

## 2.4. Bước 3 — Duyệt: `reviewReplenishment(user, id, input)`

[replenishment.commands.js:463](../../../src/modules/replenishments/replenishment.commands.js). Quyền `replenishment_request:approve`.

- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.decision` | `'APPROVE'\|'REJECT'\|'REVISE'` | Quyết định. |
| `input.reason` | string | Căn cứ chung, **bắt buộc**. |
| `input.lines[]` | `{ lineId, approvedQtyBase, reason? }` với `APPROVE` | Lượng duyệt từng dòng theo đơn vị gốc, dưới dạng chuỗi thập phân. [replenishment.validation.js](../../../src/modules/replenishments/replenishment.validation.js) |
| `seen` | `Set` | Kiểm không trùng dòng và đủ dòng. |
| `products` | `Product[]` | Để kiểm `wholeBaseUnits`. |
| `uoms` | `Uom[]` | Nhận diện dòng thùng và diện tích để kiểm lượng duyệt. |
| `approve` | bool | `input.decision === "APPROVE"`. |
| `quantity` | Decimal | Lượng duyệt đơn vị gốc, ghi vào `item.approvedQtyBase`. |
| `positive` | bool | Có ít nhất một dòng > 0. |
| `itemDecisions[]` | `{ itemId, approvedQtyBase, outcome, reason }` | Ghi vào `approval_history`. |
| `approval` | `ApprovalHistory` | Bản ghi quyết định. |

- **Tương tác DB:** `Product.find`, `Uom.find`, `ApprovalHistory.save`, `saveVersion(RR)`.
- **Logic:**

  1. Tách bạch người lập và người duyệt, chỉ duyệt phiếu `SUBMITTED`:

  ```js
  if (same(document.createdBy, actor._id)) throw forbiddenError("Người duyệt phải khác người lập");
  if (document.workflowStatus !== "SUBMITTED") throw validationError("Chỉ duyệt yêu cầu đã gửi");
  ```

  Schema `approval_history` cũng có rule chặn `requestedBy == decidedBy` (trừ một luồng trả hàng đặc thù).

  2. Mỗi dòng `APPROVE` phải gửi `approvedQtyBase`. BE kiểm lượng duyệt từ 0 đến `qtyBase` và kiểm số nguyên nếu sản phẩm có `wholeBaseUnits`.

  3. BE dùng hệ số trên dòng RR để kiểm đơn vị thùng hoặc diện tích. Với thùng, lượng duyệt phải chia hết cho hệ số. Với diện tích làm tròn đến viên, lượng quy đổi ngược phải cho lại đúng lượng gốc.

  4. Mỗi dòng duyệt giảm cần lý do riêng. `APPROVE` cần ít nhất một dòng được duyệt dương. BE ghi `approvedQtyBase` vào dòng RR và `itemDecisions`. Với `REJECT` hoặc `REVISE`, lượng trên các dòng là 0.

  5. Lưu quyết định bất biến và cập nhật RR:

  ```js
  const approval = await new ApprovalHistory({
    decisionKey: hash({ id, version: document.version, key: input.operationKey }),
    subjectType: "replenishment_requests", subjectId: document._id, subjectRevision: document.version,
    decisionScope: "REPLENISHMENT", reviewedContent: document.toObject(), decision: input.decision, ...
  }).save({ session });
  document.header.latestDecisionId = approval._id;
  if (input.decision === "APPROVE") document.header.approvedRevision = document.version;
  ```

  *Tại sao:* PO sau này kiểm `latestDecisionId` và `approvedRevision` để biết quyết định còn hiệu lực. `reviewedContent` là toàn bộ phiếu tại thời điểm duyệt. Biên nhận trả thêm `decisionId`.

---

## 2.5. Bước 4 — Lập PO: `createPurchaseOrder(user, input)`

[purchase-order.commands.js:142](../../../src/modules/purchase-orders/purchase-order.commands.js). Route `POST /api/purchase-orders` (không có `checkPermission` ở route; quyền `purchase_order:create` được kiểm trong `command()`).

- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.warehouseId`, `input.supplierId` | ObjectId | Kho nhận, NCC. |
| `input.currency` | `'VND'` | Tiền tệ cố định. |
| `input.expectedOn` | ISO datetime? | Ngày dự kiến giao (không được trước hôm nay). |
| `input.lines[]` | `{ id?, rrLineId, approvalId, enteredQty, uomCode?, unitPurchasePrice, note? }` | Mỗi dòng trỏ một dòng RR và quyết định duyệt. `uomCode` là đơn vị đặt mua (bỏ trống ⇒ giữ đơn vị đã lưu, hoặc đơn vị của RR). `unitPurchasePrice` là giá **theo đơn vị đặt**. Schema: [purchase-order.commands.routes.js:13](../../../src/modules/purchase-orders/purchase-order.commands.routes.js). |
| `prepared` | `{ request, supplier, items, total }` | Kết quả `draftItems`. |
| `po` | `PurchaseOrder` | Đơn mới `DRAFT`. |

- **Logic:**

  ```js
  checkExpectedOn(input.expectedOn);
  const prepared = await draftItems(actor, input, session);
  const request = prepared.request;
  if (await PurchaseOrder.exists({ replenishmentRequestId: request._id }).session(session))
    throw validationError("Yêu cầu bổ sung đã có đơn mua");
  await ReplenishmentRequest.updateOne({ _id: request._id }, { $set: { updatedAt } }, { session, timestamps: false });
  const po = await newDocument(PurchaseOrder, "PO", actor, { warehouseId, supplierId, expectedOn,
    approvedRequestRevision: prepared.request.header.approvedRevision, supplierSnapshot: {...} }, prepared.items);
  po.replenishmentRequestId = prepared.request._id;
  po.totalAmount = prepared.total;
  ```

  *Tại sao:* ghi `updatedAt` của RR trong cùng giao dịch là "chạm" có chủ đích: nếu cùng lúc có người hủy RR (lệnh hủy cũng kiểm "đã có PO chưa"), hai giao dịch cùng ghi một document ⇒ một cái phải chạy lại và sẽ thấy trạng thái mới. Unique partial index trên `replenishmentRequestId` là chốt cuối ở DB; kiểm `exists` trước để trả 400 dễ hiểu thay vì lỗi 11000.

### Hàm: `draftItems(actor, input, session, previous = [])`

[purchase-order.commands.js:37](../../../src/modules/purchase-orders/purchase-order.commands.js)

- **Biến:** `source` là dòng RR, `decision` là quyết định trên dòng. `uomCode` chỉ đơn vị đặt, `factor` là hệ số quy đổi, `amount` là lượng đặt theo đơn vị gốc và `enteredQty` là lượng lưu theo đơn vị đặt.
- **Logic:**

  1. Mỗi dòng phải thuộc **cùng một RR đã duyệt và cùng kho**:

  ```js
  const rr = await ReplenishmentRequest.findOne({ "items._id": line.rrLineId, workflowStatus: "APPROVED" }).session(session);
  if (!rr || !same(rr.header.warehouseId, input.warehouseId) || (request && !same(request._id, rr._id)))
    throw validationError("Một PO phải thuộc một RR đã duyệt và cùng kho");
  ```

  2. Quyết định duyệt phải là quyết định **mới nhất** và đúng revision:

  ```js
  const approval = await ApprovalHistory.findOne({ _id: line.approvalId, subjectType: "replenishment_requests",
    subjectId: rr._id, subjectRevision: rr.header.approvedRevision, decision: "APPROVE" }).session(session);
  if (!approval || !same(rr.header.latestDecisionId, approval._id))
    throw validationError("Quyết định duyệt nguồn không còn hiệu lực");
  ```

  3. Một dòng RR chỉ có một dòng PO; dòng đã lưu không được đổi dòng RR nguồn:

  ```js
  if (seen.has(String(source._id))) throw validationError("Gộp lượng của cùng dòng RR");
  ...
  const old = line.id ? previous.find((row) => same(row._id, line.id)) : null;
  if (line.id && (!old || !same(old.requestItemId, source._id))) throw validationError("Không đổi nguồn của dòng đã lưu");
  ```

  *Tại sao:* "One PO line per RR line: lots are split later, at inspection and receipt" — PO chưa biết lô, lô chỉ biết khi hàng đến.

  4. Chọn đơn vị đặt và hệ số ([purchase-order.commands.js:93](../../../src/modules/purchase-orders/purchase-order.commands.js)):

  ```js
  const uomCode = line.uomCode ?? old?.enteredUnit ?? source.enteredUnit;
  ...
  if (isWholeUnit(product, enteredUom) && !exact(line.enteredQty).isInteger())
    throw validationError(enteredUom.isCarton ? "Số thùng phải là số nguyên" : "Số lượng theo đơn vị gốc phải là số nguyên");
  const changedUnit = uomCode !== source.enteredUnit;
  const factor = changedUnit
    ? (await resolveConversion(product, null, uomCode, session)).toFixed()
    : String(source.baseUnitsPerUnit);
  const amount = toBaseQuantity(line.enteredQty, factor, product, enteredUom);
  ...
  copyItem(source, amount.toFixed(), { ..., ...(changedUnit && { lotId: undefined, packagingSnapshot: undefined }) })
  ```

  BE kiểm số thùng và số theo đơn vị gốc có `wholeBaseUnits` là số nguyên. Khi sửa và bỏ `uomCode`, PO giữ đơn vị đã lưu. Khi giữ đơn vị của RR, PO dùng lại hệ số và lô của dòng RR. Khi chọn đơn vị mới, PO lấy quy đổi cấp sản phẩm và bỏ lô.

  5. BE gọi `withinApproved(amount, line.enteredQty, factor, decision.approvedQtyBase, enteredUom.isCarton)` để kiểm trần.

  6. `normalizedEnteredQty` xác định lượng diện tích sẽ lưu. BE tính `lineAmount = round(unitPurchasePrice × enteredQty, 6)`. Dòng PO lưu hệ số và liên kết dòng RR. Kho ghi lô và quy cách thực nhận khi kiểm nhận.

### Hàm: `withinApproved(qtyBase, enteredQty, factor, approvedBase, isPackage)`

[conversions.js:60](../../../src/shared/utils/conversions.js) — dùng ở `draftItems`, `confirmPurchaseOrder` và đối soát `reconcilePurchasing`.

```js
export function withinApproved(qtyBase, enteredQty, factor, approvedBase, isPackage) {
  if (exact(qtyBase).lte(approvedBase.toString())) return true;
  if (!isPackage) return false;
  const quantity = exact(enteredQty);
  return quantity.isInteger() && quantity.minus(1).mul(factor.toString()).lt(approvedBase.toString());
}
```

| Tên biến | Vai trò |
|---|---|
| `qtyBase` | Lượng PO đơn vị gốc. |
| `enteredQty` | Lượng PO theo đơn vị đặt (vd 8 thùng). |
| `factor` | Hệ số của đơn vị đặt (vd 4 viên/thùng). |
| `approvedBase` | Lượng Owner duyệt, đơn vị gốc. |
| `isPackage` | Dấu `isCarton` từ danh mục của đơn vị đặt. |
| Trả về | `true` nếu trong trần. Nếu vượt, chỉ trả `true` khi số thùng là số nguyên và bớt một thùng thì thiếu. |

*Ví dụ:* duyệt 30 viên, NCC bán thùng 4 viên. 8 thùng = 32 viên > 30, nhưng 7 thùng = 28 < 30 ⇒ hợp lệ. 9 thùng = 36 viên bị chặn vì 8 thùng đã đủ.

### Hàm: `copyItem(source, quantity, overrides)` và `sourceLink(document, item, quantity, relationCode)`

[document-copy.js:9](../../../src/shared/utils/document-copy.js), [document-copy.js:5](../../../src/shared/utils/document-copy.js)

- `copyItem`: sao dòng nguồn sang chứng từ mới với `_id` mới, giữ `productId, lotId, enteredUnit, baseUnitSnapshot, baseUnitsPerUnit, productNameSnapshot, packagingSnapshot`; `enteredQty = quantity ÷ hệ số` (nếu không chia hết 6 chữ số thập phân thì chỉ chấp nhận khi dòng nguồn vốn đã làm tròn diện tích). Được dùng ở PO, kiểm nhận, phiếu nhập và giữ hộ. Lệnh chuyển vị trí không sao dòng mà dựng dòng mới bằng `makeItem` từ số dư.
- `sourceLink`: tạo `{ documentId, subjectCollection, itemId?, linkedQty?, relationCode }` để lần ngược chuỗi chứng từ.

## 2.6. Bước 5 — Phát hành PO: `confirmPurchaseOrder(user, id, input)`

[purchase-order.commands.js:230](../../../src/modules/purchase-orders/purchase-order.commands.js)

- **Vai trò:** khóa nội dung PO và mở cho kho nhận hàng (`OPEN`).
- **Logic kiểm lại toàn bộ nguồn:**

  ```js
  if (rr?.workflowStatus !== "APPROVED" || rr.header.approvedRevision !== po.header.approvedRequestRevision)
    throw validationError("Nguồn RR đã đổi");
  ...
  if (!source || !decision || seen.has(sourceId) || !same(source.productId, item.productId) ||
      !withinApproved(item.qtyBase, item.enteredQty, item.baseUnitsPerUnit, decision.approvedQtyBase, cartonUnits.has(item.enteredUnit)))
    throw validationError("Nguồn duyệt PO không còn hợp lệ");
  seen.add(sourceId);
  ...
  po.workflowStatus = "OPEN";
  po.header.issuedAt = new Date();
  ```

  *Tại sao:* PO nháp có thể nằm vài ngày; trong thời gian đó sản phẩm/NCC/kho có thể ngừng hoạt động hoặc RR bị xử lý lại. Phát hành là điểm cam kết với NCC nên phải kiểm lại. Trước đây hàm cộng dồn các dòng PO cùng dòng RR; nay hai dòng PO trỏ cùng một dòng RR bị **chặn hẳn** (`seen`), và giới hạn lượng dùng cùng quy tắc làm tròn gói `withinApproved` với hệ số lưu trên dòng PO.

### Hàm hỗ trợ: `purchaseOrderQuantities(po, session)`

[purchase-order.service.js:10](../../../src/modules/purchase-orders/purchase-order.service.js) — được dùng ở bước 7, 8 và khi đóng PO.

```js
const receipts=await PurchaseReceipt.find({'header.purchaseOrderId':po._id,workflowStatus:{$in:['POSTED','DRAFT']}}).session(session).lean();
...
const cancelled=exact(item.cancelledRemainderQtyBase??'0'),outstanding=exact(item.qtyBase).minus(received).minus(cancelled);
return {lineId, orderedQtyBase, receivedQtyBase, cancelledQtyBase, outstandingQtyBase,
  openDraftCommitmentQtyBase: draft, acceptanceHeadroomQtyBase: outstanding.minus(draft), quantityState:'KNOWN'};
```

| Trường | Ý nghĩa nghiệp vụ |
|---|---|
| `receivedQtyBase` | Tổng lượng trên các phiếu nhập **đã ghi tồn**. |
| `openDraftCommitmentQtyBase` | Tổng lượng trên các phiếu nhập **nháp** (đã kiểm nhận nhưng chưa ghi tồn). |
| `outstandingQtyBase` | Còn phải giao = đặt − đã nhập − đã chốt thiếu. Quyết định PO `PARTIAL`/`COMPLETED`. |
| `acceptanceHeadroomQtyBase` | Còn **được phép nhận thêm** = còn phải giao − phiếu nháp. Chặn nhận vượt PO. |

---

## 2.7. Bước 6 — Hàng đến & lập phiếu kiểm nhận: `createInspection(user, id, input)`

[po-receiving.service.js:162](../../../src/modules/po-receiving/po-receiving.service.js). Route `POST /api/purchase-orders/:id/inspections`, quyền `goods_receipt_inspection:create`. `:id` là mã PO.

- **Vai trò nghiệp vụ:** ghi nhận xe hàng đến và kết quả đếm/kiểm từng lô — **chưa tác động tồn kho**.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.expectedPoVersion` | int | Version PO thủ kho đang xem. |
| `input.arrivedAt` | ISO datetime | Thời điểm hàng đến (không ở tương lai). |
| `input.deliveryReference`, `input.deliveredBy` | string? | Số phiếu giao của NCC, tên người giao. |
| `input.creationKey` | string | Khóa chống tạo trùng. |
| `input.lines[]` | xem schema `line` ở 2.0 | Mỗi dòng = một lô thực nhận của một dòng PO. |
| `po` | `PurchaseOrder` | PO `OPEN/PARTIAL` đúng version. |
| `arrival` | `GoodsArrival` | `HĐK-...`, header: `purchaseOrderId, warehouseId, supplierId, arrivedAt, deliveryReference, deliveredBy`. |
| `inspection` | `GoodsInspection` | `PKN-...`, header: `arrivalId, warehouseId, participants: [actor]`. |
| Trả về | `{ document: inspection, resultRefs: [{ documentType: 'goods_arrivals', documentId, revision: 1 }] }` | FE nhận cả mã kiểm nhận và mã hàng đến. |

- **Logic:**

  ```js
  const po = await activePo(actor, id, input.expectedPoVersion, session);
  const arrival = await newDocument(GoodsArrival, "ARR", actor, { purchaseOrderId: po._id, warehouseId: po.header.warehouseId,
    supplierId: po.header.supplierId, arrivedAt: new Date(input.arrivedAt), deliveryReference: input.deliveryReference, deliveredBy: input.deliveredBy });
  arrival.sources = [sourceLink(po)];
  const inspection = await newDocument(GoodsInspection, "INS", actor, { arrivalId: arrival._id, warehouseId: po.header.warehouseId, participants: [actor._id] });
  inspection.sources = [sourceLink(arrival)];
  await prepare(po, input, actor, session, arrival, inspection);
  await arrival.save({ session });
  await inspection.save({ session });
  ```

### Hàm: `activePo(user, id, expectedVersion, session)`

[po-receiving.service.js:44](../../../src/modules/po-receiving/po-receiving.service.js) — `findPurchase(kind 'PO')` + `checkVersion` + PO phải `OPEN` hoặc `PARTIAL`.

### Hàm: `findPurchase(id, user, session, { kind, readOnly })`

[purchase-core.js:18](../../../src/modules/po-receiving/purchase-core.js) — tìm theo `_id` hoặc `documentNo` trong model ứng với `kind` (`PO`, `INSPECTION`, `GR_PURCHASE`, `TO`, …); kiểm kho, riêng Kế toán ở chế độ chỉ đọc thì xem mọi kho.

### Hàm: `prepare(po, input, actor, session, arrival, inspection)`

[po-receiving.service.js:62](../../../src/modules/po-receiving/po-receiving.service.js) — dùng chung cho tạo và sửa kiểm nhận.

- **Vai trò:** dựng cặp dòng song song: `arrival.items[k]` (thực nhận) và `inspection.items[k]` (kết quả kiểm, `lineKind: 'INSPECTION'`).
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `row` | dòng input | Một lô của một dòng PO. |
| `source` | dòng PO | `po.items.id(row.poLineId)`. |
| `prior` | dòng kiểm cũ | Khi sửa, giữ `_id` dòng kiểm. |
| `oldArrival` | dòng hàng đến cũ | Giữ hệ số cũ, chặn đổi dòng PO. |
| `product`, `enteredUnit`, `carton` | | Đơn vị đếm: mặc định đơn vị gốc; nếu khác thì **phải là đơn vị thùng** (`Uom.isCarton`). |
| `item` | kết quả `makeItem` | Dòng đã quy đổi theo **quy đổi của lô**. |
| `arrived` | dòng `GoodsArrival` | `item` + `purchaseOrderItemId`, `packagingCondition`, `sources → PO`. |
| `arrivalItems[]`, `inspectionItems[]` | mảng | Gán đè vào `arrival.items`, `inspection.items`. |

- **Logic từng bước:**

  1. Hàng không đạt chỉ được **tạm giữ** (`CUSTODY`), không được nhận sở hữu:

  ```js
  if (row.qualityCode !== 'GOOD' && row.ownershipDecision !== 'CUSTODY')
    throw validationError('Hàng chưa đạt phải tạm giữ chờ trả nhà cung cấp');
  ...
  if (!row.lotId) throw validationError("Kiểm nhận cần lô thực nhận");
  ```

  2. Bãi tiếp nhận (nếu chọn sớm) chỉ cho dòng `ACCEPT` và phải là vị trí `RECEIVING` cùng kho:

  ```js
  if (row.receivingLocationId) {
    if (row.ownershipDecision !== 'ACCEPT') throw validationError('Chỉ chọn bãi tiếp nhận cho hàng được nhận mua');
    await locationAt(row.receivingLocationId, po.header.warehouseId, ['RECEIVING'], session);
  }
  ```

  3. Thủ kho đếm theo thứ họ cầm được — thùng nguyên hoặc đơn vị gốc, **không** đếm theo m²:

  ```js
  const enteredUnit = row.enteredUnit ?? product?.baseUnit;
  const carton = enteredUnit !== product?.baseUnit;
  if (!product || (carton && !(await Uom.exists({ code: enteredUnit, isCarton: true }).session(session))))
    throw validationError("Kiểm hàng đếm theo thùng hoặc đơn vị gốc");
  if (carton && !exact(row.enteredQty).isInteger())
    throw validationError("Số thùng phải là số nguyên; phần lẻ nhập ở dòng riêng theo đơn vị gốc");
  ```

  4. Quy đổi bằng `makeItem(..., { previous: oldArrival, includeLotLabel: true, allowInactiveUom: true })`; dòng khai "nguyên thùng" (`SEALED`) phải chia hết số viên/thùng của lô; thời điểm đến không trước ngày sản xuất của lô.

  ```js
  if (row.packagingCondition === "SEALED" && !exact(item.qtyBase).mod(String(item.packagingSnapshot.baseUnitsPerPackage)).isZero())
    throw validationError("Dòng nguyên thùng phải đủ số viên theo quy cách lô; phần lẻ ghi dòng riêng là hàng lẻ");
  ```

  5. Dòng kiểm sao từ dòng hàng đến, thêm `details`:

  ```js
  details: { inspectedSourceLineId: arrived._id, receivingLocationId: row.receivingLocationId,
    qualityCode: row.qualityCode, ownershipDecision: row.ownershipDecision,
    inspectedBy: actor._id, inspectedAt: new Date(), packagingCondition: row.packagingCondition },
  ```

  *Lưu ý:* ở bước này **chưa kiểm** tổng lượng có vượt PO không — một phiếu nháp không giữ chỗ. Kiểm vượt nằm ở bước xác nhận.

### Hàm: `locationAt(id, warehouseId, kinds, session)`

[stock.js:27](../../../src/shared/utils/stock.js) — `WarehouseLocation.findOne({ _id, warehouseId, isActive: true })` và `locationType` phải nằm trong `kinds`; sai ⇒ "Vị trí không thuộc kho hoặc sai loại".

## 2.8. Bước 6b — Sửa kiểm nhận: `updateInspection(user, id, input)`

[po-receiving.service.js:203](../../../src/modules/po-receiving/po-receiving.service.js)

- `inspectionSource()` ([dòng 52](../../../src/modules/po-receiving/po-receiving.service.js)) đọc kiểm nhận + hàng đến. Cả hai phải `DRAFT`. PO phải còn mở, đúng `expectedPoVersion`. Gọi lại `prepare()` (thay toàn bộ dòng), cập nhật header hàng đến, `saveVersion` cả hai.

## 2.9. Bước 7 — Xác nhận kiểm nhận: `confirmInspection(user, id, input)`

[po-receiving.service.js:241](../../../src/modules/po-receiving/po-receiving.service.js). Route `POST /api/goods-inspections/:id/confirm`, quyền `goods_receipt_inspection:update`.

- **Vai trò nghiệp vụ:** chốt kết quả kiểm; tách hàng được nhận mua và hàng giữ hộ thành hai chứng từ riêng.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.destinations[]` | `{ inspectionItemId, locationId }` | Vị trí RECEIVING cho **mỗi** dòng `ACCEPT`. |
| `input.expectedPoVersion` | int | Khóa PO. |
| `quantities` | kết quả `purchaseOrderQuantities` | Hạn mức nhận của từng dòng PO. |
| `free` | `Map<poLineId, Decimal>` | Bắt đầu = `acceptanceHeadroomQtyBase`, trừ dần theo từng dòng `ACCEPT`. |
| `accepted` | dòng kiểm | `ownershipDecision === 'ACCEPT'`. |
| `receipt` | `PurchaseReceipt` \| null | `PNM-...` `DRAFT` nếu có dòng `ACCEPT`. |
| `held` | dòng kiểm | `ownershipDecision === 'CUSTODY'`. |
| `custody` | `CustodyReceipt` | `PNGH-...` với `ownerType: 'SUPPLIER'`. |
| `refs[]` | | `resultRefs` trả về mã phiếu nhập và/hoặc phiếu giữ hộ. |

- **Logic:**

  1. Điều kiện đầu vào:

  ```js
  if (inspection.workflowStatus !== "DRAFT" || !inspection.items.length) throw validationError("Chỉ xác nhận hồ sơ nháp có dòng hàng");
  ...
  if (accepted.some((row) => row.details.qualityCode !== "GOOD")) throw validationError("Chỉ GOOD được nhận sở hữu");
  if (inspection.items.some(row => row.details.qualityCode !== 'GOOD' && row.details.ownershipDecision !== 'CUSTODY'))
    throw validationError('Hàng chưa đạt phải tạm giữ chờ trả nhà cung cấp');
  ...
  if (accepted.some((row) => row.details.qualityCode !== "GOOD")) throw validationError("Chỉ GOOD được nhận sở hữu");
  if (destinations.length !== accepted.length || new Set(destinations.map((row) => row.inspectionItemId)).size !== accepted.length)
    throw validationError("Chọn vị trí nhập cho từng phần nhận sở hữu");
  ```

  Mỗi vị trí trong `destinations` được kiểm bằng `locationAt(..., ['RECEIVING'])` (đúng kho, đang hoạt động) và ghi lại vào `item.details.receivingLocationId` của dòng kiểm.

  2. Chống nhận vượt PO — trừ dần hạn mức theo dòng PO:

  ```js
  const left = free.get(String(poItem._id)).minus(String(item.qtyBase));
  if (left.lt(0)) throw validationError("Tổng nhận vượt phần PO còn được nhận");
  free.set(String(poItem._id), left);
  ```

  *Tại sao:* một dòng PO có thể về thành nhiều lô ⇒ nhiều dòng kiểm cùng trỏ một dòng PO; hạn mức đã trừ phiếu nháp khác (`acceptanceHeadroomQtyBase`) nên hai xe hàng kiểm song song không vượt được.

  3. Tạo dòng phiếu nhập, giữ đủ liên kết ngược:

  ```js
  receipt.items.push(copyItem(item, item.qtyBase, {
    lineNo: i + 1, lineKind: "STANDARD", purchaseOrderItemId: poItem._id, arrivalItemId: source._id,
    inspectionId: inspection._id, inspectionResultId: item._id, destinationLocationId: destination.locationId,
    sources: [sourceLink(inspection, item, item.qtyBase)],
  }));
  ```

  4. Hàng giữ hộ thành chứng từ riêng, **không** cộng vào tồn của cửa hàng:

  ```js
  const custody = await newDocument(CustodyReceipt, "CRCV", actor, { warehouseId: po.header.warehouseId, ownerType: "SUPPLIER", ownerId: po.header.supplierId });
  ```

  5. Chốt trạng thái và "chạm" PO:

  ```js
  inspection.workflowStatus = "CONFIRMED";
  arrival.workflowStatus = "RECORDED";
  await saveVersion(arrival, arrival.version, session);
  await saveVersion(po, po.version, session);
  ```

  *Tại sao:* tăng version PO để mọi thao tác song song khác trên cùng PO (xác nhận kiểm khác, đóng PO) phải tải lại — hạn mức nhận vừa thay đổi.

- Dòng `REJECT` (hàng `GOOD` bị từ chối tại cửa) **không** đi vào phiếu nhập hay giữ hộ; chỉ còn lại trên phiếu kiểm như bằng chứng.

- Trước khi ghi tồn, có thể đổi bãi tiếp nhận bằng `PATCH /goods-receipts/purchase/:id/destinations` → `changeDestinations()` ([po-receiving.service.js:515](../../../src/modules/po-receiving/po-receiving.service.js)), chỉ khi phiếu nhập còn `DRAFT`.

---

## 2.10. Bước 8 — Ghi tồn phiếu nhập mua: `postReceipt(user, id, input)`

[po-receiving.service.js:380](../../../src/modules/po-receiving/po-receiving.service.js). Route `POST /api/goods-receipts/purchase/:id/post`, quyền `goods_receipt_inspection:post`.

- **Vai trò nghiệp vụ:** thời điểm **hàng chính thức thành tồn kho của cửa hàng** (tại bãi tiếp nhận).
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.expectedVersion` / `expectedPoVersion` | int | Khóa phiếu nhập và PO. |
| `input.packaging[]` | `{ lineId, portions: [{ packagingState, sealedPackCount?, quantityBase, measuredVolumeMm3?, packagingSnapshot? }] }` | Khai kiện thủ công (tùy chọn). Không khai ⇒ hệ thống tự tách theo quy cách lô. |
| `receipt` | `PurchaseReceipt` | Phiếu `DRAFT`. |
| `quantities` | | Kiểm không phiếu nháp nào làm PO âm hạn mức. |
| `locations` | ObjectId[] | Các vị trí đích, để khóa và kiểm sức chứa. |
| `posting` | `StockTransaction` | Bút toán sổ cái `operation: 'PURCHASE_RECEIPT'`. |
| `inspection`, `source` | | Dòng kiểm gốc của từng dòng phiếu nhập. |
| `target` | `InventoryBalance` | Balance tại (vị trí đích, lô, `GOOD`, `STORE`). |
| `portions` | mảng kiện | Từ `intakePortions`. |
| `remaining` | | Lượng PO còn lại sau khi ghi, quyết định trạng thái PO. |
| Trả về | `{ document, versionBefore, stockTransactionId }` | `stockTransactionId` vào `operation_records` và `audit_logs`. |

- **Tương tác DB:** `Warehouse` (khóa `stockOperationVersion`), `WarehouseLocation` (khóa + kiểm), `StocktakeLocationLock`, `GoodsInspection`, `StockHoldingPoint` (find/create), `InventoryBalance` (find/create/update có version), `ProductBatch`, `Product`, `StockTransaction.save`, `saveVersion(GR)`, `saveVersion(PO)`.
- **Logic:**

  1. Kiểm phiếu, PO, hạn mức, kiện:

  ```js
  if (receipt.workflowStatus !== "DRAFT" || !receipt.items.length) throw validationError("Phiếu không còn nháp hoặc không có lượng nhập");
  const po = await activePo(actor, receipt.header.purchaseOrderId, input.expectedPoVersion, session);
  const quantities = await purchaseOrderQuantities(po, session);
  if (quantities.some((row) => exact(row.acceptanceHeadroomQtyBase).lt(0))) throw validationError("Các phiếu nhập vượt hạn mức PO");
  checkPackagingLines(receipt, input.packaging);
  ```

  2. Khóa kho, khóa vị trí và mở bút toán:

  ```js
  const locations = receipt.items.map((row) => row.destinationLocationId);
  await guardLocations(locations, session);
  const posting = beginStock(receipt, actor, "PURCHASE_RECEIPT", input);
  ```

  3. Với từng dòng: đối chiếu lại dòng kiểm gốc (đúng lô, sản phẩm, lượng, `GOOD` + `ACCEPT`), kiểm vị trí, lấy balance, tính kiện, cộng tồn:

  ```js
  if (!source || source.details.qualityCode !== "GOOD" || source.details.ownershipDecision !== "ACCEPT" ||
      !same(source.lotId, item.lotId) || !same(source.productId, item.productId) || !exact(source.qtyBase).eq(String(item.qtyBase)))
    throw validationError("Nguồn nhận sở hữu không hợp lệ");
  ...
  const target = await balanceAt({ type: "LOCATION", locationId: item.destinationLocationId },
    { batchId: item.lotId, ownerType: "STORE", ownerId: null }, source.details.qualityCode, session);
  const portions = await intakePortions(item, source.details.packagingCondition,
    input.packaging?.find((row) => same(row.lineId, item._id))?.portions, session);
  await receiveStock(target, item, portions, posting, actor, session, source.details.packagingCondition);
  ```

  Trước `balanceAt`, vị trí đích của dòng được kiểm lại bằng `locationAt(item.destinationLocationId, ..., ['RECEIVING'])`.

  *Tại sao:* phiếu nhập nháp có thể bị sửa vị trí; phiếu kiểm là nguồn sự thật về lượng và chất lượng, nên đối chiếu lại tại thời điểm ghi tồn. Dòng có `custodyBalanceId` (hàng giữ hộ được chuyển thành mua) đi nhánh `postOwnedCustody` ([purchase-custody.service.js](../../../src/modules/po-receiving/purchase-custody.service.js)) — ngoài phạm vi luồng chuẩn.

  4. Kiểm sức chứa, lưu sổ cái, cập nhật phiếu và PO:

  ```js
  await verifyCapacity(locations, session);
  await posting.save({ session });
  receipt.workflowStatus = "POSTED";
  receipt.stockTransactionId = posting._id;
  receipt.postedBy = actor._id; receipt.postedAt = new Date(); receipt.header.receivedAt = new Date();
  ...
  po.workflowStatus = remaining.every((row) => exact(row.outstandingQtyBase).isZero()) ? "COMPLETED" : "PARTIAL";
  await saveVersion(po, po.version, session);
  ```

### Hàm: `guardLocations(ids, session)` và `guardWarehouses(ids, session)`

[stock.js:18](../../../src/shared/utils/stock.js), [stock.js:12](../../../src/shared/utils/stock.js)

```js
// guardWarehouses: khóa từng kho theo thứ tự id
const warehouse = await Warehouse.findOneAndUpdate({ _id: warehouseId, isActive: true }, { $inc: { stockOperationVersion: 1 } }, { session, returnDocument: 'after', timestamps: false });
if (!warehouse) throw validationError('Kho đã ngừng hoạt động');

// guardLocations: trước tiên khóa kho của các vị trí, rồi khóa từng vị trí
const scoped = await WarehouseLocation.find({ _id: { $in: ids.filter(Boolean) } }).select('warehouseId').session(session);
await guardWarehouses(scoped.map(location => location.warehouseId), session);
for (const locationId of [...new Set(ids.filter(Boolean).map(String))].sort()) {
  const location = await WarehouseLocation.findOneAndUpdate({ _id: locationId, isActive: true }, { $inc: { operationVersion: 1 } }, { session, returnDocument: 'after' });
  if (!location || !await Warehouse.exists({ _id: location.warehouseId, isActive: true }).session(session)) throw validationError('Kho hoặc vị trí đã ngừng hoạt động');
  if (await StocktakeLocationLock.exists({ locationId, status: 'LOCKED' }).session(session)) throw validationError('Vị trí đang khóa kiểm kê');
}
```

*Tại sao:* `$inc operationVersion` biến vị trí thành "khóa": hai giao dịch cùng ghi tồn vào một vị trí sẽ xung đột ghi, một bên chạy lại và thấy tồn mới (quan trọng cho kiểm sức chứa). Sắp xếp id để mọi giao dịch khóa cùng thứ tự. Vị trí đang kiểm kê thì không được động vào. Khóa thêm `Warehouse.stockOperationVersion` làm **mọi lệnh ghi tồn trong cùng một kho chạy tuần tự** với nhau và với lệnh khởi tạo tồn đầu kỳ, kể cả khi chúng chạm các vị trí khác nhau (comment trong code: "Initialization and ordinary stock commands serialize on the same warehouse").

### Hàm: `beginStock(document, user, operation, input)`

[stock.js:84](../../../src/shared/utils/stock.js)

```js
const requestHash = hash({ document: String(document._id), operation, input });
return new StockTransaction({ sourceType: document.constructor.collection.name, sourceId: document._id,
  operation, eventKey: String(document.version), requestKey: hash({ user: String(user._id), document: String(document._id), operation, key: input.operationKey ?? input.idempotencyKey }),
  requestHash, performedBy: user._id, occurredAt: new Date(), recordedAt: new Date(), movements: [] });
```

*Tại sao:* unique `(sourceId, operation, eventKey)` với `eventKey = version` đảm bảo một version của chứng từ chỉ ghi sổ một lần; unique `requestKey` chặn cùng thao tác ghi hai lần.

### Hàm: `balanceAt(pointFields, source, qualityStatus, session)`

[stock.js:42](../../../src/shared/utils/stock.js)

```js
let point = await StockHoldingPoint.findOne(pointFields).session(session);
if (!point) point = await new StockHoldingPoint(pointFields).save({ session });
const fields = { holdingPointId: point._id, batchId: source.batchId, qualityStatus, ownerType: source.ownerType, ownerId: source.ownerId ?? null };
return await InventoryBalance.findOne(fields).session(session) ??
  await new InventoryBalance({ ...fields, quantityBase: '0', version: 0, packagingPortions: [] }).save({ session });
```

*Tại sao:* tồn được lưu theo khóa **(vị trí, lô, chất lượng, chủ hàng)**; balance chỉ được tạo lần đầu khi có hàng vào. Cùng lô vào cùng vị trí từ hai phiếu nhập khác nhau sẽ dồn vào **một** balance. Đây cũng chính là số dư mà Bước 9 (Chuyển vị trí) chọn làm nguồn.

### Hàm: `intakePortions(item, condition, portions, session)`

[po-receiving.service.js:130](../../../src/modules/po-receiving/po-receiving.service.js)

- **Vai trò:** kiểm phần khai kiện thủ công (nếu có) khớp quy cách lô và khớp tình trạng bao bì đã kiểm.
- **Logic:** không khai kiện mà dòng không phải `SEALED` ⇒ trả `undefined` (để `receiveStock` tự tách). Dòng `SEALED` không khai ⇒ lượng phải chia hết `piecesPerCarton`. Có khai:

  ```js
  if (portion.measuredVolumeMm3 != null || exact(portion.extraOccupiedVolumeMm3 ?? "0").gt(0))
    throw validationError("Thùng nguyên tính thể tích theo kích thước lô, không khai thể tích");
  try { assertBatchPackaging(batch, portion.packagingSnapshot); } catch { throw validationError("Quy cách thùng khác quy cách lô"); }
  if (!portion.sealedPackCount || !exact(portion.quantityBase).eq(perCarton.mul(portion.sealedPackCount)))
    throw validationError("Số viên thùng nguyên khác quy cách lô");
  ...
  if (condition === "SEALED" && opened) throw validationError("Dòng kiểm nguyên thùng chỉ khai thùng nguyên");
  if (condition && condition !== "SEALED" && !opened) throw validationError("Dòng kiểm không nguyên thùng phải có phần hàng mở/lẻ");
  ```

### Hàm: `receiveStock(balance, item, portions, posting, user, session, condition)`

[stock.js:228](../../../src/shared/utils/stock.js)

- **Vai trò:** cộng tồn vào balance, gắn kiện, ghi movement.
- **Từ điển biến:** `batch`, `product`, `amount` (= `item.qtyBase`), `packaging` (kiện cuối cùng), `cartonDims`, `hasCartonSize`, `perCarton`, `fullCartons`, `looseQty`, `received` (kiện có `_id` mới, `createdBy`, thể tích ước tính), `before`.
- **Logic:**

  1. Kiểm lô `VERIFIED`, sản phẩm active và khớp, số nguyên nếu `wholeBaseUnits`.
  2. Không có kiện khai tay ⇒ tự tách theo tình trạng bao bì:

  ```js
  if (condition === 'LOOSE' || ['OPENED', 'TORN', 'UNKNOWN'].includes(condition)) {
    packaging = [{ packagingState: condition === 'LOOSE' ? 'LOOSE' : 'OPEN', quantityBase: amount.toFixed(), packagingSnapshot }];
  } else {
    const fullCartons = amount.dividedToIntegerBy(perCarton);
    const looseQty = amount.mod(perCarton);
    if (fullCartons.gt(0)) packaging.push({ packagingState: 'SEALED', sealedPackCount: fullCartons.toNumber(), quantityBase: fullCartons.mul(perCarton).toFixed(), packagingSnapshot });
    if (looseQty.gt(0)) packaging.push({ packagingState: 'LOOSE', quantityBase: looseQty.toFixed(), packagingSnapshot });
  }
  ```

  *Tại sao:* sức chứa ô kệ tính theo **thể tích**; thùng nguyên tính theo kích thước thùng của lô. Kiện `LOOSE`/`OPEN` không khai thể tích được gán `measuredVolumeMm3 = estimateVolume(...)` ([stock.js:217](../../../src/shared/utils/stock.js)): kiện mở theo số thùng làm tròn lên × kích thước thùng, hàng rời theo số viên × kích thước sản phẩm; thiếu kích thước ⇒ lỗi "Thiếu kích thước lô/sản phẩm, cần nhập thể tích thực đo". Nhờ có thể tích này, dòng BF03 `LOOSE` sau đó tách được kiện rời (xem `splitPortions`).

  3. Tổng kiện phải bằng lượng nhập; cộng tồn có khóa version; ghi movement chỉ có đầu `to`:

  ```js
  balance.quantityBase = before.plus(amount).toFixed();
  balance.packagingPortions.push(...received);
  await saveBalance(balance, balance.version, session);
  posting.movements.push({ transactionId: posting._id, lineNo: posting.movements.length + 1,
    packagingPortionIds: received.map(row=>row._id), sourceLineId: item._id, toBalanceId: balance._id,
    quantityBase: amount.toFixed(), toBefore: before.toFixed(), toAfter: balance.quantityBase });
  ```

  `movements[].toBalanceId` của bút toán này là nguồn của `receivingBalanceId` mà chi tiết phiếu nhập trả về cho Bước 9. `packagingPortionIds` vẫn được ghi (cho biết kiện nào sinh ra từ dòng nào), nhưng lệnh chuyển vị trí hiện **không** dùng nó để giới hạn kiện.

### Hàm: `saveBalance(balance, beforeVersion, session)`

[stock.js:147](../../../src/shared/utils/stock.js) — `updateOne({ _id, version: beforeVersion }, { $set: { quantityBase, packagingPortions }, $inc: { version: 1 } })`; không khớp ⇒ 409 "Tồn đã thay đổi".

### Hàm: `verifyCapacity(locationIds, session)`

[stock.js:201](../../../src/shared/utils/stock.js) — nạp mọi điểm giữ hàng, balance, vị trí, kho, lô của các vị trí liên quan rồi gọi `checkBinCapacity` ([capacity.js](../../../src/models/capacity.js)): ô phải có kích thước, kho phải có `clearHeightMm`; mỗi kiện `SEALED` phải đúng quy cách lô và **thùng vừa ô** (`estimateCartonCapacity`); thể tích = thùng nguyên theo kích thước ngoài, kiện mở/lẻ theo `measuredVolumeMm3` hoặc (mới) `volumeUpperBoundMm3`; tổng không vượt dài × rộng × cao. Chạy **sau** khi cộng tồn (vẫn trong transaction) nên vượt sức chứa ⇒ toàn bộ giao dịch rollback.

---

## 2.11. Bước 9a — Mở form từ phiếu nhập: `enriched(user, document)`

[purchase-read.service.js:68](../../../src/modules/po-receiving/purchase-read.service.js). Được gọi từ `GET /api/goods-receipts/purchase/:id` (`getDocument`).

- **Vai trò nghiệp vụ:** cho màn hình phiếu nhập biết hàng của từng dòng đang nằm ở **số dư nào** và người xem có được bấm **Chuyển vị trí** không. Thay cho `putawayContext` / `placementQuantities` cũ.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `posted` | bool | Phiếu ở `POSTED`. |
| `value.reversed` | bool | Phiếu `REVERSED` hoặc bút toán nhập đã có bút toán đảo (`reversedTransactionId`). |
| `posting` | `StockTransaction` (lean) | Bút toán nhập, chỉ lấy `movements.sourceLineId`, `movements.toBalanceId`. |
| `item.receivingBalanceId` | string | Số dư (ở vị trí `RECEIVING`) mà dòng phiếu đã cộng vào. |
| `value.capabilities.relocate` | bool | Hiện nút Chuyển vị trí. |

- **Logic:**

  ```js
  if (kind === 'PURCHASE') {
    value.reversed = document.workflowStatus === 'REVERSED' ||
      Boolean(document.stockTransactionId && await StockTransaction.exists({ reversedTransactionId: document.stockTransactionId }));
    if (posted && !value.reversed && document.stockTransactionId) {
      const posting = await StockTransaction.findById(document.stockTransactionId).select('movements.sourceLineId movements.toBalanceId').lean();
      for (const item of value.items) {
        const movement = posting?.movements.find(move => move.toBalanceId && same(move.sourceLineId, item._id));
        if (movement) item.receivingBalanceId = String(movement.toBalanceId);
      }
    }
  }
  ...
  relocate: kind === 'PURCHASE' && posted && writeWarehouse && !value.reversed && hasPermission(user, 'stock_relocation:create'),
  ```

  *Tại sao:* sau khi gỡ lệnh cất mua, phiếu nhập chỉ cần "chỉ đường" sang BF03. Phiếu đã đảo thì không cho chuyển. Lưu ý `receivingBalanceId` là số dư **dùng chung** theo (vị trí, lô, chất lượng, chủ hàng) nên có thể chứa cả hàng của phiếu khác; FE phải tự kiểm số lượng muốn chuyển.

## 2.12. Bước 9b — Dữ liệu cho form BF03: `locationMovementOptions(user, warehouseId)`

[location-movement.service.js:104](../../../src/modules/location-movements/location-movement.service.js). Route `GET /api/location-movements/options`, quyền `stock_relocation:create`.

- **Vai trò:** trả mọi thứ form cần mà không ghi gì: danh sách kho người dùng được vào, các vị trí đang hoạt động, điểm giữ hàng, **số dư > 0**, lô, sản phẩm, đơn vị và quy đổi.
- **Tương tác DB (chỉ đọc, không session):**

  ```js
  const locations = await WarehouseLocation.find({ warehouseId, isActive: true }).select(optionFields.location).lean();
  const points = await StockHoldingPoint.find({ locationId: { $in: locations.map(row=>row._id) } }).select(optionFields.point).lean();
  const blind = await blindCountScope(user);
  const balances = (await InventoryBalance.find({ holdingPointId: { $in: points.map(row=>row._id) }, quantityBase: { $gt: 0 } })
    .select(optionFields.balance+' packagingPortions.sealedPackCount packagingPortions.quantityBase').lean()).filter(row => !blind.has(row._id));
  ```

  Không có `warehouseId` ⇒ chỉ trả `warehouses`. Có ⇒ `requireWarehouseAccess`. Các trường được chọn lọc (`optionFields`) khai trong [movement-read-fields.js](../../../src/shared/utils/movement-read-fields.js). Số dư trả về có `version` để client gửi lại làm `sourceBalanceVersion`, kèm `packagingPortions.packagingState/sealedPackCount/quantityBase` để form hiện "Thùng nguyên / Trong thùng mở / Hàng rời" và giới hạn riêng phần thùng nguyên, phần rời.

  Từ 22/11/2026, phiếu kiểm kê hiển thị tồn sổ. Lệnh kho vẫn kiểm tra khóa vị trí khi thao tác. Xem [vòng đời kiểm kê](../08_api/STOCKTAKE_LIFECYCLE.md).

## 2.13. Bước 9 — Lập lệnh chuyển vị trí: `createLocationMovement(user, input)`

[location-movement.service.js:72](../../../src/modules/location-movements/location-movement.service.js). Route `POST /api/location-movements`: `checkPermission('stock_relocation:create')` + `validate(createSchema)` ([location-movement.validation.js:11](../../../src/modules/location-movements/location-movement.validation.js)). Controller trả 201 lần đầu, 200 khi replay.

- **Vai trò nghiệp vụ:** lập kế hoạch đưa hàng từ bãi tiếp nhận lên kệ (hoặc giữa hai vị trí bất kỳ trong kho). Chưa di chuyển tồn.
- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.idempotencyKey` | string ≤64, `[\w.-]` | Khóa chống tạo trùng (`command()` đọc `idempotencyKey` khi không có `operationKey`/`creationKey`). |
| `input.warehouseId` | ObjectId | Kho của lệnh. |
| `input.reason` | string 1–2000 | Lý do chuyển, lưu ở `header.reason`. |
| `input.lines[]` | 1–100 dòng `{ sourceBalanceId, sourceBalanceVersion, toLocationId, enteredUnit, enteredQty, packagingState? }` | Mỗi dòng: lấy từ số dư nào (đúng version đã xem), đến vị trí nào, bao nhiêu (số **nguyên** thùng hoặc viên). `packagingState` (`SEALED`/`LOOSE`, tùy chọn) chỉ định lấy từ thùng nguyên hay hàng rời. Zod cho mỗi cặp (nguồn, đích) tối đa một dòng mỗi loại; trùng loại, hoặc trộn dòng không có loại với dòng có loại, bị từ chối. |
| `document` | `TransferOrder` | `LCV-...`, `OPEN`, `version: 1`, `header: { warehouseId, taskKind: 'RELOCATE', assignedTo: actor, reason }`. |

- **Logic:**

  ```js
  requireWarehouseAccess(actor, input.warehouseId);
  const document = await new TransferOrder({ ...await nextDocumentFields(TransferOrder, 'TO', input.warehouseId, session), workflowStatus: 'OPEN', version: 1, createdBy: actor._id,
    header: { warehouseId: input.warehouseId, taskKind: 'RELOCATE', assignedTo: actor._id, reason: input.reason },
    items: await relocationItems(actor, input.warehouseId, input, session) }).save({ session });
  ```

  `authorizeReplay` là `task(id, …)` ([dòng 18](../../../src/modules/location-movements/location-movement.service.js)): `scopedDocument` + lệnh phải có `taskKind: 'RELOCATE'`.

### Hàm: `relocationItems(user, warehouseId, input, session, excludeTaskId, previous = [])`

[location-movement.service.js:45](../../../src/modules/location-movements/location-movement.service.js) — dùng chung cho tạo và sửa lệnh.

- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `ctx` | `{ balance, point, batch, product, location }` | Bối cảnh số dư nguồn (`sourceContext`). |
| `old` | dòng lệnh cũ | Khi sửa: dòng cùng (nguồn, đích, `packagingState`) để giữ `_id` và hệ số quy đổi cũ. |
| `inPool` | function | Lọc kiện theo `line.packagingState`; dòng không có loại ⇒ mọi kiện. |
| `item` | kết quả `makeItem` | Dòng `lineKind: 'WAREHOUSE_TASK'`, quy đổi theo **lô** của số dư. |
| `packaging` | `Map<balanceId, kiện còn lại>` | Mô phỏng tách kiện qua nhiều dòng lấy cùng một số dư. |
| `totals` | `Map<balanceId, Decimal>` | Tổng lượng lấy từ mỗi số dư trong request. |
| `pending` | Decimal | Lượng các lệnh khác đang chờ trên số dư (`pendingTaskQuantity`, loại trừ chính lệnh khi sửa). |
| Trả về | mảng dòng | Mỗi dòng có `details: { sourceBalanceId, sourceBalanceVersion, fromLocationId, toLocationId, qualityCode, ownerType, ownerId, packagingState? }`. |

- **Logic từng bước:**

  1. Số dư nguồn phải ở một vị trí của đúng kho, sản phẩm còn hoạt động, lô `VERIFIED`, và **chưa bị ai đổi** kể từ lúc mở form:

  ```js
  const ctx = await sourceContext(line.sourceBalanceId, session);
  if (!ctx.location || !ctx.product.isActive || ctx.batch.identificationStatus !== 'VERIFIED' || !same(ctx.location.warehouseId, warehouseId)) throw validationError('Tồn nguồn không hợp lệ');
  if (ctx.balance.version !== line.sourceBalanceVersion) throw versionConflict('Tồn nguồn đã thay đổi', ctx.balance.version);
  ```

  2. Đích là vị trí đang hoạt động cùng kho thuộc **bất kỳ loại** nào trong năm loại, khác nguồn; lượng phải là số nguyên:

  ```js
  await locationAt(line.toLocationId, warehouseId, ['RECEIVING','STORAGE','STAGING','QUARANTINE','CUSTODY'], session);
  if (same(ctx.location._id, line.toLocationId)) throw validationError('Vị trí nguồn và đích trùng nhau');
  if (typeof line.enteredQty !== 'string' || !/^\d+$/.test(line.enteredQty)) throw validationError('Số thùng hoặc viên phải là số nguyên');
  ```

  3. Quy đổi bằng `makeItem` theo lô của số dư (đơn vị thùng ⇒ quy đổi theo lô), kết quả đơn vị gốc cũng phải nguyên:

  ```js
  const item = await makeItem({ ...line, productId: ctx.product._id, lotId: ctx.batch._id }, index + 1, session, { lineKind: 'WAREHOUSE_TASK', previous: old });
  if (!exact(item.qtyBase).isInteger()) throw validationError('Số thùng hoặc viên phải là số nguyên');
  ```

  4. Tách kiện thử trên các kiện của số dư (không giới hạn theo dòng phiếu nhập) thuộc đúng loại `packagingState` của dòng, rồi kiểm không vượt tồn còn lại sau các lệnh khác:

  ```js
  const portions = packaging.get(String(ctx.balance._id)) ?? ctx.balance.packagingPortions;
  const inPool = portion => !line.packagingState || portion.packagingState === line.packagingState;
  const split = splitPortions(portions.filter(inPool), item.qtyBase, user._id, { allowLooseSplit: line.packagingState === 'LOOSE' });
  const kept = new Map(split.kept.map(portion => [String(portion._id), portion]));
  packaging.set(String(ctx.balance._id), portions.flatMap(portion => inPool(portion) ? kept.has(String(portion._id)) ? [kept.get(String(portion._id))] : [] : [portion]));
  const total = (totals.get(String(ctx.balance._id)) ?? exact('0')).plus(item.qtyBase); totals.set(String(ctx.balance._id), total);
  const pending = await pendingTaskQuantity(ctx.balance._id, session, excludeTaskId);
  if (total.plus(pending).gt(String(ctx.balance.quantityBase))) throw validationError('Tồn nguồn đã được lập lệnh khác');
  ```

  *Tại sao:* `splitPortions` không bật `allowOpening` nên không bao giờ tự mở thùng — lỗi ngay lúc lập lệnh thay vì lúc xác nhận. Dòng `SEALED` chỉ lấy nguyên thùng. Dòng `LOOSE` bật `allowLooseSplit`, được tách một kiện `LOOSE` có thể tích đo hoặc cận trên thể tích đã biết; thiếu thể tích thì vẫn bị chặn. Dòng không có loại (lệnh cũ) giữ cách cũ: chỉ lấy trọn kiện hoặc số thùng nguyên. Map `packaging` giữ các kiện ngoài loại của dòng, nên dòng `SEALED` và dòng `LOOSE` cùng nguồn được mô phỏng nối tiếp đúng.

  5. Ghi ảnh số dư vào dòng, khóa kho + vị trí nguồn/đích:

  ```js
  result.push({ ...item, details: { sourceBalanceId: ctx.balance._id, sourceBalanceVersion: ctx.balance.version,
    fromLocationId: ctx.location._id, toLocationId: line.toLocationId, qualityCode: ctx.balance.qualityStatus,
    ownerType: ctx.balance.ownerType, ownerId: ctx.balance.ownerId, ...(line.packagingState && { packagingState: line.packagingState }) } });
  ...
  await guardLocations(result.flatMap(item => [item.details.fromLocationId, item.details.toLocationId]), session);
  ```

  *Tại sao:* lệnh `OPEN` có `sourceBalanceId` nên `pendingTaskQuantity`/`freeQuantity` tự trừ phần này khỏi tồn tự do; đơn bán hay lệnh khác không lấy chồng được.

### Hàm: `pendingTaskQuantity(balanceId, session, excludeTaskId)`

[stock.js:50](../../../src/shared/utils/stock.js) — tổng `qtyBase − đã thực hiện` của mọi `TransferOrder` `OPEN/DRAFT/PARTIAL` có dòng lấy từ balance này (đã thực hiện = tổng movement của lệnh đó từ balance này).

### Hàm: `splitPortions(portions, quantity, actorId, { allowOpening = false, allowLooseSplit = false })`

[stock.js:93](../../../src/shared/utils/stock.js)

- Chế độ mặc định (`allowOpening: false`, `allowLooseSplit: false`) — dùng ở lập và xác nhận dòng chuyển `SEALED` hoặc dòng không có loại:

  ```js
  if (remaining.gte(available)) { taken.push(portion); remaining = remaining.minus(available); continue; }
  if (portion.packagingState !== 'SEALED' || portion.measuredVolumeMm3 != null || ...)
    throw validationError('Phần hàng mở/lẻ cần được đo và tách quy cách trước khi chuyển một phần');
  const packs = remaining.div(String(portion.packagingSnapshot.baseUnitsPerPackage));
  if (!packs.isInteger()) throw validationError('Không tự mở thùng; chọn lượng nguyên thùng hoặc phần hàng lẻ đã đo');
  ```

  Lấy trọn kiện theo thứ tự; chỉ kiện `SEALED` được chia, và chỉ chia theo số thùng nguyên.

- Chế độ `allowLooseSplit: true` — dòng chuyển `LOOSE`: chỉ áp cho kiện `LOOSE`. Kiện bị tách thành hai mảnh `LOOSE` (phần lấy, phần giữ lại), cả hai mang `volumeUpperBoundMm3` = thể tích đo hoặc cận trên của kiện gốc (cộng `extraOccupiedVolumeMm3`), không chia tỷ lệ. Không có thể tích dương đã biết ⇒ lỗi "Thiếu kích thước hoặc giới hạn thể tích đã biết để mở/tách thùng". Cận trên giữ nguyên nên kiểm sức chứa có thể từ chối ô đích chật.
- Chế độ `allowOpening: true` (chỉ luồng **xuất** dùng): ưu tiên lấy kiện lẻ trước, cho phép **mở thùng**; phần thùng bị mở thành kiện `OPEN` với `volumeUpperBoundMm3` = thể tích thùng (cận trên) để `checkBinCapacity` vẫn tính được sức chứa. Luồng nhập/chuyển vị trí trong tài liệu này không bật chế độ này.

## 2.14. Bước 9c — Sửa / hủy lệnh: `editLocationMovement`, `cancelLocationMovement`

[location-movement.service.js:119](../../../src/modules/location-movements/location-movement.service.js), [location-movement.service.js:129](../../../src/modules/location-movements/location-movement.service.js). Cả hai dùng quyền `stock_relocation:create` và chỉ **người lập** được làm.

- Sửa: lệnh phải `OPEN`; gọi lại `relocationItems(..., excludeTaskId = id, previous = document.items)` để lượng của chính lệnh không bị tính là "chờ"; dòng giữ `_id` cũ khi cùng nguồn, đích và `packagingState`; cập nhật `header.reason`; `saveVersion`.
- Hủy: lệnh `OPEN` hoặc `PARTIAL`; khóa vị trí nguồn; `workflowStatus = 'CANCELLED'`, ghi `cancelReason/By/At`. Phần đã chuyển giữ nguyên; phần chưa chuyển thôi bị tính "chờ".

## 2.15. Bước 10 — Xác nhận thực chuyển: `confirmLocationMovement(user, id, input)`

[location-movement.service.js:139](../../../src/modules/location-movements/location-movement.service.js). Route `POST /api/location-movements/:id/confirm`, quyền `stock_relocation:confirm`.

- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.expectedVersion` | int | Version lệnh. |
| `input.idempotencyKey` | string | Khóa chống xác nhận trùng. |
| `input.lines[]` | `{ lineId, actualQtyBase }` | Lượng **thực chuyển** (đơn vị gốc, số nguyên) từng dòng; có thể ít hơn kế hoạch. |
| `document` | `TransferOrder` | Lệnh `OPEN/PARTIAL`, `taskKind: 'RELOCATE'`. |
| `previous` | `StockTransaction[]` | Các bút toán `RELOCATE` trước đó của lệnh (khi đã xác nhận một phần). |
| `moved(item)` | function → Decimal | Đã chuyển của một dòng. |
| `selected[]` | `{ item, quantity }` | Dòng hợp lệ sẽ chuyển lần này. |
| `before` / `after` | `{ _id, version }[]` | Version các số dư nguồn trước/sau, để cập nhật `sourceBalanceVersion` cho lần xác nhận kế tiếp. |
| `posting` | `StockTransaction` | Bút toán `operation: 'RELOCATE'`, `sourceType: 'transfer_orders'`. |
| `destination` | `InventoryBalance` | Số dư ở vị trí đích (cùng lô, chất lượng, chủ hàng). |
| `complete` | bool | Mọi dòng đã chuyển đủ. |

- **Logic:**

  1. Chỉ người lập được xác nhận; lệnh còn mở; dòng không trùng; lượng > 0 và không vượt phần còn lại:

  ```js
  if (!same(document.createdBy,actor._id)) throw forbiddenError('Chỉ người lập được xác nhận lệnh');
  if (!['OPEN', 'PARTIAL'].includes(document.workflowStatus)) throw validationError('Lệnh không còn mở');
  ...
  if (!item || !/^\d{1,14}$/.test(actual.actualQtyBase) || !exact(actual.actualQtyBase).gt(0) || exact(actual.actualQtyBase).gt(exact(item.qtyBase).minus(moved(item))))
    throw validationError('Lượng thực chuyển phải lớn hơn 0 và không vượt phần còn lại');
  ```

  2. Số dư nguồn phải **đúng version đã chụp** trên dòng và vẫn khớp lô/chất lượng/chủ hàng; đích còn hoạt động trong kho:

  ```js
  if (ctx.balance.version !== item.details.sourceBalanceVersion) throw versionConflict('Tồn đã thay đổi; hủy phần còn lại và lập lại lệnh nếu đã chuyển một phần');
  if (!same(ctx.batch._id, item.lotId) || ctx.balance.qualityStatus !== item.details.qualityCode || ctx.balance.ownerType !== item.details.ownerType || ...) throw validationError('Tồn không khớp lệnh');
  await locationAt(item.details.toLocationId, document.header.warehouseId, null, session);
  ```

  *Tại sao:* lệnh đã giữ chỗ trên số dư; nếu số dư bị thay đổi bởi thao tác khác (nhập thêm, xuất, chuyển khác) thì kiện thực tế có thể khác kế hoạch, nên bắt người dùng lập lại.

  3. Khóa kho/vị trí, chuyển tồn từng dòng:

  ```js
  await guardLocations(locations, session);
  const posting = beginStock(document, actor, 'RELOCATE', input);
  for (const { item, quantity } of selected) {
    const ctx = await sourceContext(item.details.sourceBalanceId, session);
    const destination = await balanceAt({ type: 'LOCATION', locationId: item.details.toLocationId }, ctx.balance, ctx.balance.qualityStatus, session);
    await moveStock(ctx.balance._id, destination._id, quantity, item._id, posting, actor, session, { preserveReservations: true, excludeTaskId: id, packagingState: item.details.packagingState });
  }
  ```

  *Tại sao:* `excludeTaskId: id` loại lượng "chờ" của chính lệnh, nếu không `moveStock` sẽ tưởng tồn đã bị giữ hết. `preserveReservations: true` — hàng đã giữ cho đơn bán thì phần giữ đi theo hàng. Không truyền `portionIds`, nên kiện được lấy từ toàn bộ số dư; `packagingState` của dòng giới hạn kiện theo loại và kiểm lại trên tồn thực. Mỗi loại có `_id` dòng riêng nên lượng kế hoạch/đã chuyển/còn lại của thùng nguyên và hàng rời độc lập; xác nhận một phần có thể chuyển một hoặc cả hai loại.

  4. Kiểm sức chứa, lưu sổ cái, cập nhật version số dư trên dòng và trạng thái lệnh:

  ```js
  await verifyCapacity(locations, session); await posting.save({ session });
  ...
  if (old && old.version === item.details.sourceBalanceVersion) item.details.sourceBalanceVersion = after.find(b => same(b._id, old._id)).version;
  ...
  document.workflowStatus = complete ? 'CONFIRMED' : 'PARTIAL';
  if (complete) { document.header.confirmedBy = actor._id; document.header.confirmedAt = new Date(); }
  document.stockTransactionId = posting._id;
  ```

  *Tại sao:* chính lần xác nhận này làm version số dư nguồn tăng; cập nhật lại `sourceBalanceVersion` để lần xác nhận phần còn lại không tự báo xung đột. `stockTransactionId` trỏ bút toán **gần nhất**; chi tiết lệnh (`getLocationMovement`) đọc mọi bút toán theo `sourceId`.

### Hàm: `moveStock(sourceId, destinationId, quantity, itemId, stockTransaction, user, session, opts)`

[stock.js:153](../../../src/shared/utils/stock.js)

- **Vai trò:** chuyển một lượng giữa hai balance **cùng lô, cùng chủ hàng**, kèm kiện và (tùy chọn) giữ hàng.
- **Từ điển biến:** `source`, `destination` (InventoryBalance), `amount`, `from`, `to` (số dư trước), `reservations`, `reserved`, `pending` (lệnh khác chưa có giữ hàng), `inPool` (lọc kiện theo `portionIds` và `packagingState`; chuyển vị trí không truyền `portionIds`, chỉ truyền `packagingState` của dòng nếu có), `allowOpening` (chỉ luồng xuất bật), `allowLooseSplit` (bật khi `packagingState === 'LOOSE'`), `split`, `kept`, `taken`, `movementId`.
- **Logic:**

  ```js
  if (!source || !destination || !same(source.batchId, destination.batchId) || source.ownerType !== destination.ownerType || ...)
    throw validationError('Không đổi lô hoặc chủ hàng khi chuyển tồn');
  if (!amount.gt(0) || amount.gt(from)) throw validationError('Không đủ tồn nguồn');
  ...
  if (amount.plus(pending).plus(preserveReservations ? '0' : reserved).plus(await heldQuantity(sourceId, session)).gt(from))
    throw validationError('Lượng chuyển thuộc phần hàng đang bị chặn');
  ...
  const inPool = row => (portionIds === undefined || portionIds.some(id => same(id, row._id))) && (!packagingState || row.packagingState === packagingState);
  const split = splitPortions(source.packagingPortions.filter(inPool), amount, user._id, { allowOpening, allowLooseSplit: packagingState === 'LOOSE' });
  ...
  retainPortions(source, kept);
  destination.packagingPortions.push(...taken);
  source.quantityBase = from.minus(amount).toFixed(); destination.quantityBase = to.plus(amount).toFixed();
  ...
  await saveBalance(source, source.version, session);
  await saveBalance(destination, destination.version, session);
  stockTransaction.movements.push({ _id: movementId, ..., sourceLineId: itemId, fromBalanceId: sourceId, toBalanceId: destinationId,
    quantityBase: amount.toFixed(), fromBefore: from.toFixed(), fromAfter: source.quantityBase, toBefore: to.toFixed(), toAfter: destination.quantityBase });
  ```

  Khi `preserveReservations`, phần giữ hàng vượt quá lượng tự do được "dời" sang balance đích: tăng `movedQty` của giữ hàng cũ, tạo `StockReservation` mới ở đích có `previousReservationId`. Schema `stock_movements` có rule `before ± quantity = after`, nên sổ cái luôn tự cân.

  `retainPortions(balance, kept)` ([stock.js:138](../../../src/shared/utils/stock.js)) là phần tách riêng từ `moveStock`: xóa kiện đã lấy khỏi số dư nguồn, cập nhật kiện còn lại tại chỗ (giữ nguyên subdocument để không ghi lại `createdAt`), và nay chép thêm `packagingState`, `measuredVolumeMm3`, `volumeUpperBoundMm3`, `extraOccupiedVolumeMm3` — cần cho trường hợp thùng bị mở ở luồng xuất.

## 2.16. Dữ liệu biến đổi qua toàn quy trình — ví dụ số

Giả sử gạch `G60` có đơn vị gốc là viên và đã khai báo quy đổi cấp sản phẩm 4 viên/thùng. Lô thực nhận `L01` cũng có 4 viên/thùng.

| Bước | Collection | Dữ liệu chính sau bước |
|---|---|---|
| Lập RR | `replenishment_requests` | `items[0] = { enteredUnit: 'Thùng', enteredQty: '10', baseUnitsPerUnit: '4', qtyBase: '40', details.availableQtySnapshot: '12' }`, `DRAFT`, v1 |
| Gửi | `replenishment_requests` | `SUBMITTED`, v2, `submissions[0].documentVersion = 2` |
| Duyệt giảm | `approval_history` + RR | Owner gửi `approvedQtyBase: '32'` và lý do giảm. Lượng 32 viên tương đương 8 thùng nguyên. RR sang `APPROVED`, v3, `approvedRevision = 2`. |
| Lập + phát hành PO | `purchase_orders` | `items[0] = { enteredUnit: 'Thùng', enteredQty: '8', qtyBase: '32', requestItemId: RR.items[0]._id }`, `OPEN`. |
| Kiểm nhận | `goods_arrivals`, `goods_inspections` | Dòng 1: lô `L01`, 7 thùng = 28 viên, `GOOD/ACCEPT/SEALED`; dòng 2: 3 viên, `GOOD/ACCEPT/LOOSE` |
| Xác nhận kiểm | `goods_receipts` | GR `DRAFT` hai dòng (28 + 3), `destinationLocationId = R-01` (RECEIVING). Headroom PO = 32 − 31 = 1 |
| Ghi tồn | `inventory_balances`, `stock_transactions` | Balance (R-01, L01, GOOD, STORE): `quantityBase` 0 → 31, kiện `[SEALED×7=28, LOOSE 3]`; 2 movement `to`. PO `PARTIAL` (còn 1) |
| Mở form | (đọc) | Chi tiết PNM trả `items[*].receivingBalanceId` = id balance (R-01, L01, GOOD, STORE), `capabilities.relocate = true` |
| Lập lệnh chuyển | `transfer_orders` | TO `RELOCATE` `OPEN`, `sourceBalanceVersion` = version balance R-01. Dòng 1 (`packagingState: 'SEALED'`): 28 viên = 7 thùng → ô `A-01-01`; dòng 2 (`packagingState: 'LOOSE'`): 3 viên → ô `A-01-02`. Chưa đổi tồn; 31 viên ở R-01 bị tính "đang chờ" |
| Xác nhận chuyển | `inventory_balances`, `stock_transactions` | Bút toán `RELOCATE` 2 movement: R-01 31 → 0; A-01-01 +28 (kiện SEALED×7); A-01-02 +3 (kiện LOOSE). TO `CONFIRMED` |

Sau bước cuối, 31 viên mới được `availableStock()` của RR tính là "tồn khả dụng" (vì nằm ở `STORAGE`, `isPickable`).

---

# Phần 2B — Luồng phụ và luồng liên quan

Phần 2 chỉ đi theo đường thẳng RR → PO → kiểm nhận → phiếu nhập → chuyển vị trí. Phần này liệt kê **mọi** API còn lại của các module `replenishments`, `purchase-orders`, `po-receiving` và phần mua hàng của `goods-receipts`, rồi các module khác đọc hoặc dùng chứng từ của quy trình. Danh mục route được lấy từ [routes.js](../../../src/routes.js) và các file `*.routes.js` ngày 19/11/2026.

## 2B.1. Bản đồ API đầy đủ

Cột "Mục" trỏ tới phần giải thích. Quyền ghi "trong `command()`" nghĩa là route không có `checkPermission`; quyền được kiểm khi lệnh chạy.

### RR — `/api/replenishments` ([replenishment.routes.js](../../../src/modules/replenishments/replenishment.routes.js))

| Method & path | Hàm | Quyền | Mục |
|---|---|---|---|
| `GET /options?mode=CREATE\|FILTER&requestId?` | `getReplenishmentOptions` | `replenishment_request:create` / `:read` / `:update` (khi có `requestId`) | 2B.2 |
| `GET /options/lots` | `getReplenishmentLotOptions` | `:create` hoặc `:update` | 2B.2 |
| `GET /options/sources?type=` | `getReplenishmentSourceOptions` | `:create`/`:update` + `sales_order:read` hoặc `stocktake:read` | 2B.2 |
| `POST /evaluate` | `evaluateReplenishment` | `:create` hoặc `:read` | 2B.2 |
| `GET /` | `listReplenishments` | `replenishment_request:read` | 2B.2 |
| `GET /:id` | `getReplenishment` | `:read` | 2B.2 |
| `GET /:id/submissions`, `GET /:id/submissions/:version` | `listReplenishmentSubmissions`, `getReplenishmentSubmission` | `:read` | 2B.2 |
| `POST /` | `createReplenishment` | `:create` | 2.1 |
| `PUT /:id` | `updateReplenishment` | `:update` | 2.2 |
| `POST /:id/submit` | `submitReplenishment` | `:update` | 2.3 |
| `POST /:id/review` | `reviewReplenishment` | `:approve` | 2.4 |
| `POST /:id/cancel` | `cancelReplenishment` | trong `command()`: Owner `:approve`, người khác `:update` | 2B.2 |

### PO — `/api/purchase-orders` ([purchase-order.routes.js](../../../src/modules/purchase-orders/purchase-order.routes.js), [purchase-order.commands.routes.js](../../../src/modules/purchase-orders/purchase-order.commands.routes.js))

| Method & path | Hàm | Quyền | Mục |
|---|---|---|---|
| `GET /` | `listPurchaseOrders` | `purchase_order:read` | 2B.3 |
| `GET /supplier-options` | `listPurchaseOrderSupplierOptions` | `purchase_order:read` | 2B.3 |
| `GET /:id` | `getPurchaseOrder` | `purchase_order:read` | 2B.3 |
| `POST /` | `createPurchaseOrder` | trong `command()`: `purchase_order:create` | 2.5 |
| `PUT /:id` | `updatePurchaseOrder` | trong `command()`: `purchase_order:update` | 2B.3 |
| `POST /:id/confirm` | `confirmPurchaseOrder` | trong `command()`: `:update` | 2.6 |
| `POST /:id/expected-on` | `rescheduleExpectedOn` | trong `command()`: `:update` | 2B.3 |
| `POST /:id/close-remainder` | `closeRemainder` | trong `command()`: `:update` | 2B.3 |
| `POST /:id/cancel` | `cancelPurchaseOrder` | trong `command()`: `:update` | 2B.3 |
| `GET /:id/inspection-context` | `inspectionContext` | `goods_receipt_inspection:read` | 2B.4 |
| `POST /:id/inspections` | `createInspection` | trong `command()`: `goods_receipt_inspection:create` | 2.7 |
| `GET /:id/receiving-summary` | `receivingSummary` | `purchase_order:read` (qua `getPurchaseOrder`) | 2B.4 |
| `GET /:id/receiving-trips` | `receivingTrips` | `goods_receipt_inspection:read` | 2B.4 |
| `GET /:id/receiving-operations/:key` | `receivingOperation` | `goods_receipt_inspection:read` | 2B.4 |

### Kiểm nhận — `/api/goods-inspections` (`inspectionRouter` trong [po-receiving.routes.js](../../../src/modules/po-receiving/po-receiving.routes.js))

Mọi lệnh ghi kiểm quyền trong `command()`; lệnh đọc kiểm trong service.

| Method & path | Hàm | Quyền | Mục |
|---|---|---|---|
| `GET /`, `GET /:id` | `listDocuments('INSPECTION')`, `getDocument` | `goods_receipt_inspection:read` | 2B.4 |
| `GET /:id/history` | `receivingHistory` | `:read` | 2B.4 |
| `PUT /:id` | `updateInspection` | `:update` | 2.8 |
| `POST /:id/confirm` | `confirmInspection` | `:update` | 2.9 |
| `POST /:id/cancel` | `cancelDraft(..., 'INSPECTION')` | `:update` | 2B.4 |
| `GET /:id/correction-preflight` | `correctionPreflight` | `:update` | 2B.5 |
| `POST /:id/corrections` | `replaceInspection` | `:update` | 2B.5 |

### Phiếu nhập mua — `/api/goods-receipts/purchase` (`receiptRouter`, gắn qua [goods-receipt.routes.js](../../../src/modules/goods-receipts/goods-receipt.routes.js))

| Method & path | Hàm | Quyền | Mục |
|---|---|---|---|
| `GET /`, `GET /:id` | `listDocuments('GR_PURCHASE')`, `getDocument` | `goods_receipt_inspection:read` | 2B.4, 2.11 |
| `POST /:id/post` | `postReceipt` | `:post` | 2.10 |
| `POST /:id/cancel` | `cancelDraft(..., 'GR_PURCHASE')` | `:update` | 2B.4 |
| `PATCH /:id/destinations` | `changeDestinations` | `:update` | 2B.4 |
| `GET /:id/reversal-preflight` | `reversalPreflight` | `:reverse` + `:post` | 2B.6 |
| `POST /:id/reverse` | `reverseReceipt` | `:reverse` + `:post` | 2B.6 |

`GET /api/goods-receipts` và `GET /api/goods-receipts/:id` là danh sách chung mọi loại phiếu nhập (mua, khách trả, giao thất bại, điều chuyển, nhập khác); phiếu mua xuất hiện ở đây với `kind=PURCHASE` và lọc được theo `purchaseOrderId`.

### Các router khác của mua hàng

| Method & path | Hàm | Quyền | Mục |
|---|---|---|---|
| `GET /api/purchase-receiving/queue?stage=DRAFT_INSPECTION\|AWAITING_POST\|CORRECTION` | `receivingQueue` | `goods_receipt_inspection:read` | 2B.4 |
| `GET /api/purchase-documents/:id/history` | `receivingHistory` | `goods_receipt_inspection:read` | 2B.4 |
| `GET /api/purchase-documents/:id/evidence` | `listEvidence` | theo loại chứng từ | 2B.7 |
| `POST /api/purchase-documents/:id/evidence/uploads` | `uploadEvidence` | theo loại chứng từ | 2B.7 |
| `POST /api/purchase-documents/:id/evidence/attach` | `attachEvidence` | theo loại chứng từ | 2B.7 |
| `GET /api/purchase-documents/:id/evidence/:evidenceId/download` | `downloadEvidence` | theo loại chứng từ | 2B.7 |
| `GET /api/stock-reversals/:id` | `getReversal` | `goods_receipt_inspection:read` | 2B.6 |
| `GET /api/custody-receipts`, `GET /:id` | `listDocuments('CUSTODY_RECEIPT')`, `getDocument` | `goods_receipt_inspection:read` | 2B.8 |
| `POST /api/custody-receipts/:id/post` | `postCustodyReceipt` | `goods_receipt_inspection:post` | 2B.8 |
| `POST /api/custody-receipts/:id/cancel` | `cancelDraft(..., 'CUSTODY_RECEIPT')` | `goods_receipt_inspection:update` | 2B.4 |
| `GET /api/custody-receipts/:id/reversal-preflight` | `reversalPreflight` | `:reverse` + `:post` | 2B.6 |
| `POST /api/custody-receipts/:id/reverse` | `reverseReceipt` | `:reverse` + `:post` | 2B.6 |
| `POST /api/custody-receipts/:id/reinspections` | `reinspectCustody` | `goods_receipt_inspection:update` | 2B.8 |
| `POST /api/custody-receipts/:id/resolution-decisions` | `decideCustody` | `purchase_custody:decide` | 2B.8 |
| `POST /api/custody-receipts/:id/purchase-receipts` | `createCustodyResolution(..., 'ACCEPT')` | `purchase_custody:execute` | 2B.8 |
| `POST /api/custody-receipts/:id/releases` | `createCustodyResolution(..., 'RETURN')` | `purchase_custody:execute` | 2B.8 |
| `GET /api/custody-releases/:id` | `getDocument('CUSTODY_RELEASE')` | `goods_receipt_inspection:read` | 2B.8 |
| `POST /api/custody-releases/:id/post` | `postCustodyRelease` | `purchase_custody:execute` | 2B.8 |

## 2B.2. Luồng phụ của RR

- **Dữ liệu form** — [replenishment.commands.js:291](../../../src/modules/replenishments/replenishment.commands.js) `getReplenishmentOptions`: kho được vào, sản phẩm đang hoạt động, đơn vị và **quy đổi cấp sản phẩm mới nhất** (aggregate `Conversion` với `productBatchId: null`, `validFrom ≤ now`). Khi có `requestId`, `requireEditableRequest` ([dòng 281](../../../src/modules/replenishments/replenishment.commands.js)) bắt buộc người gọi là người lập và RR còn `DRAFT`/`REVISION_REQUIRED`, chưa có PO. `getReplenishmentLotOptions` ([dòng 351](../../../src/modules/replenishments/replenishment.commands.js)) phân trang các lô `VERIFIED` của sản phẩm.
- **Chứng từ nguồn** — [replenishment.sources.js:121](../../../src/modules/replenishments/replenishment.sources.js) `getReplenishmentSourceOptions`: `type=stocktakes` trả các đợt kiểm kê `COMPLETED/CLOSED` trong kho được vào (sản phẩm lấy từ dòng kiểm kê và `StocktakeSnapshot`); loại khác trả đơn bán chưa `CANCELLED/REJECTED/COMPLETED` (Sales chỉ thấy đơn mình lập). Kết quả mang `version` để client gửi lại trong `source.version`; khi gửi duyệt, `evaluateLines` so version này (`strictSourceVersion`).
- **Xem trước đánh giá** — `evaluateReplenishment` ([dòng 217](../../../src/modules/replenishments/replenishment.commands.js)) chạy `evaluateLines` trong một transaction chỉ đọc, không ghi chứng từ. FE dùng để hiện cảnh báo trước khi lưu.
- **Danh sách / chi tiết** — [replenishment.service.js:55](../../../src/modules/replenishments/replenishment.service.js) `listReplenishments` lọc theo `replenishmentScope` ([replenishment.access.js](../../../src/modules/replenishments/replenishment.access.js)): Owner thấy mọi kho; vai trò khác chỉ kho được gán; Sales và Warehouse chỉ thấy RR mình lập. Bộ lọc `hasPurchaseOrder`/`poCreated`, `approvalDecision` (`NONE` = chưa có quyết định). `getReplenishment` ([dòng 140](../../../src/modules/replenishments/replenishment.service.js)) trả thêm `approvals` (từ `approval_history`), `purchaseOrders` (kể cả PO đã hủy qua `sources[]`), thông tin chứng từ nguồn và `enteredUomAreaMm2` cho đơn vị diện tích. `listReplenishmentSubmissions`/`getReplenishmentSubmission` ([dòng 304](../../../src/modules/replenishments/replenishment.service.js), [dòng 322](../../../src/modules/replenishments/replenishment.service.js)) đọc ảnh `submissions[]` theo version.
- **Hủy / rút RR** — `cancelReplenishment` ([dòng 571](../../../src/modules/replenishments/replenishment.commands.js)): không được hủy khi đã có PO giữ `replenishmentRequestId` ("Yêu cầu đã có PO; xử lý theo luồng PO"). RR `APPROVED` chỉ Owner hủy; RR `DRAFT/SUBMITTED/REVISION_REQUIRED` chỉ người lập rút. Bắt buộc `reason`; RR → `CANCELLED` với `cancelReason/By/At`. Lệnh lập PO "chạm" `updatedAt` của RR nên hủy RR và lập PO song song không cùng commit được (xem 2.5).

## 2B.3. Luồng phụ của PO

- **Sửa PO nháp** — `updatePurchaseOrder` ([purchase-order.commands.js:195](../../../src/modules/purchase-orders/purchase-order.commands.js)): chỉ `DRAFT`; gọi lại `draftItems` với `previous = po.items` (giữ `_id` dòng, giữ đơn vị đã lưu khi bỏ `uomCode`); không được đổi RR nguồn; ngày dự kiến giữ nguyên thì không bị chặn quá khứ (`checkExpectedOn`).
- **Đổi ngày dự kiến giao** — `rescheduleExpectedOn` ([dòng 307](../../../src/modules/purchase-orders/purchase-order.commands.js)): PO `OPEN/PARTIAL`, ngày mới không trước hôm nay, bắt buộc `reason`; `auditChanges` ghi `header.expectedOn` trước/sau.
- **Chốt thiếu phần còn lại** — `closeRemainder` ([dòng 366](../../../src/modules/purchase-orders/purchase-order.commands.js)), một bước do Kế toán làm (quyết định 16/11/2026, bằng chứng tùy chọn). `validateClose` cho mỗi dòng: lượng chốt ≤ `outstandingQtyBase − openDraftCommitmentQtyBase` (không chốt phần đang nằm trên phiếu nhập nháp), số nguyên nếu `wholeBaseUnits`, không trùng dòng. Cộng vào `items[].cancelledRemainderQtyBase`; mọi dòng hết `outstanding` ⇒ PO `CLOSED` + `closedAt`. Không có lệnh hoàn tác.
- **Hủy PO** — `cancelPurchaseOrder` ([dòng 408](../../../src/modules/purchase-orders/purchase-order.commands.js)) với `cancelBlocker` ([purchase-order.service.js:22](../../../src/modules/purchase-orders/purchase-order.service.js)): chỉ PO `DRAFT`/`OPEN`, chưa chốt thiếu dòng nào, chưa có `GoodsArrival` hay `PurchaseReceipt` liên kết. Sau khi lưu `CANCELLED`, lệnh `$unset replenishmentRequestId` để chỉ mục duy nhất giải phóng RR: **RR đó lập được PO mới**; PO cũ vẫn giữ `sources[]` nên chi tiết RR vẫn hiện nó.
- **Đọc** — `getPurchaseOrder` ([purchase-order.service.js:47](../../../src/modules/purchase-orders/purchase-order.service.js)) trả `quantities` (`purchaseOrderQuantities`), `arrivals`, `receipts`, `cancellable`, `hasOpenReceivingWork` (`openReceivingWorkIds`, [dòng 36](../../../src/modules/purchase-orders/purchase-order.service.js): còn kiểm nhận nháp hoặc phiếu nhập nháp) và `draftEdit` (dòng để FE mở form sửa). `history` và `approvals` chỉ trả cho Owner/Kế toán; vai trò khác bị `redactPrices` ẩn giá. Kế toán đọc mọi kho (`findPurchase(..., { readOnly: true })`). `listPurchaseOrders` ([dòng 122](../../../src/modules/purchase-orders/purchase-order.service.js)) tính `quantities` cho từng PO để lọc `outstanding=YES/NO`; `listPurchaseOrderSupplierOptions` ([dòng 107](../../../src/modules/purchase-orders/purchase-order.service.js)) lấy NCC từ `supplierSnapshot` của các PO trong phạm vi.

## 2B.4. Luồng phụ của kiểm nhận và phiếu nhập

- **Dữ liệu form kiểm nhận** — `inspectionContext` ([po-receiving.service.js:556](../../../src/modules/po-receiving/po-receiving.service.js)): PO (đã ẩn giá), `quantities`, mọi vị trí đang hoạt động của kho, lô `VERIFIED` của các sản phẩm, kích thước sản phẩm và danh sách mã đơn vị thùng.
- **Tra lại kết quả theo khóa thao tác** — `receivingOperation` ([dòng 587](../../../src/modules/po-receiving/po-receiving.service.js)): tìm `OperationRecord` của chính người gọi với `requestKey` đó, chỉ trả khi chứng từ đích thuộc PO đang xem. FE dùng sau lỗi mạng để biết lệnh đã commit chưa.
- `cancelDraft(user, id, kind, input)` hủy chứng từ `DRAFT` và ghi `cancelReason/By/At`. Hủy kiểm nhận cũng hủy `GoodsArrival` còn nháp. Hủy phiếu nhập nháp yêu cầu `expectedPoVersion`, tăng version PO và giải phóng phần lượng trong `openDraftCommitmentQtyBase`. Phiếu kiểm vẫn `CONFIRMED`. Hủy giữ hộ NCC chỉ cập nhật phiếu giữ hộ. [Lệnh hủy](../../../src/modules/po-receiving/po-receiving.service.js).
- **Đổi bãi tiếp nhận trước ghi tồn** — `changeDestinations` ([dòng 515](../../../src/modules/po-receiving/po-receiving.service.js)): phiếu nhập `DRAFT`, mỗi dòng một vị trí, vị trí phải `RECEIVING` (hoặc `QUARANTINE` nếu dòng kiểm không `GOOD`) đúng kho.
- **Đọc** — [purchase-read.service.js](../../../src/modules/po-receiving/purchase-read.service.js): `listDocuments` ([dòng 171](../../../src/modules/po-receiving/purchase-read.service.js)) lọc theo kho, trạng thái, mã; lọc theo PO đi qua `GoodsArrival` cho kiểm nhận và giữ hộ. `getDocument` ([dòng 136](../../../src/modules/po-receiving/purchase-read.service.js)) gọi `enriched` (2.11), thêm tên NCC, kho, người ghi tồn và thông tin hàng đến. `receivingSummary` ([dòng 209](../../../src/modules/po-receiving/purchase-read.service.js)) gộp kiểm nhận, phiếu nhập, phiếu giữ hộ của một PO kèm `quantities`, `tripCount`, số nháp đang mở. `receivingTrips` = danh sách kiểm nhận của PO. `receivingQueue` ([dòng 247](../../../src/modules/po-receiving/purchase-read.service.js)): `DRAFT_INSPECTION` (kiểm nhận nháp), `AWAITING_POST` (phiếu nhập nháp), `CORRECTION` (kiểm nhận nháp có `previousInspectionId`). `receivingHistory` ([dòng 256](../../../src/modules/po-receiving/purchase-read.service.js)) đọc `audit_logs` của chứng từ, ẩn giá với vai trò không có quyền tài chính.

## 2B.5. Sửa kết quả kiểm nhận đã xác nhận: `replaceInspection`

[purchase-correction.service.js](../../../src/modules/po-receiving/purchase-correction.service.js). Hai route `GET /api/goods-inspections/:id/correction-preflight` và `POST /api/goods-inspections/:id/corrections` dùng cùng `correctionBlockers` và quyền cập nhật trong kho.

- Áp dụng cho kiểm nhận `CONFIRMED`. Lệnh cần `reason` và chấp nhận `evidenceIds` tùy chọn. Tệp gửi kèm phải gắn vào phiếu kiểm gốc.
- `correctionBlockers` tìm phiếu nhập trực tiếp, phiếu nhập từ giữ hộ (kể cả qua tái kiểm), phiếu giữ hộ, bản kiểm thay thế và chứng từ trả NCC trỏ trực tiếp về phiếu kiểm. Phiếu nhập hoặc giữ hộ chỉ thôi chặn khi `CANCELLED` hoặc `REVERSED`. Preflight trả danh sách đầy đủ ở `blockers`. Lệnh sửa bị chặn trả cùng danh sách ở `fieldErrors`.
- Tạo cặp `GoodsArrival` + `GoodsInspection` mới ở `DRAFT` qua cùng `prepare()` của 2.7. Kiểm nhận mới có `header.previousInspectionId`, `correctionReason`, `sources` `REPLACES`; hàng đến mới có nguồn `CORRECTION`. Bản cũ chỉ tăng version, giữ nguyên làm lịch sử. Bản mới đi tiếp bước 7 → 8 như thường và hiện ở hàng đợi `CORRECTION`.

## 2B.6. Đảo phiếu nhập hoặc giữ hộ đã ghi tồn

`reverseReceipt` dùng chung cho phiếu nhập mua và giữ hộ NCC. Cả hai cần quyền `goods_receipt_inspection:reverse` và `:post` trong kho, `reason`, `expectedVersion` và `operationKey`. Phiếu nhập mua cần thêm `expectedPoVersion`. Bằng chứng tùy chọn. [Service đảo phiếu](../../../src/modules/po-receiving/purchase-correction.service.js).

- `eligible` dùng chung với nhập khác và chạy trong preflight lẫn khi ghi. Hàm đối chiếu `packagingPortionIds` tại số dư gốc và cộng dồn lượng cần đảo để so với `freeQuantity`. Lệnh chuyển còn mở, kiểm kê, phần giữ do báo lỗi và chứng từ phụ thuộc có thể chặn. [Điều kiện và dữ liệu lịch sử](../08_api/GOODS_RECEIPTS.md#hủy-nháp-và-đảo-phiếu).
- `reverseReceipt` tạo `StockReversal` và duyệt ngược các movement gốc. `transferCustodyStock` trừ đúng phần theo lượng của movement. Phiếu nhập từ giữ hộ trả phần đó về số dư NCC gốc. Lệnh đảo giữ hộ trừ tồn NCC ở vị trí giữ hộ. Bút toán ghi `reversedTransactionId`, rồi phiếu nguồn sang `REVERSED`. Đảo nhập mua trả hạn mức PO theo lượng còn đã nhận, hoặc giữ trạng thái `CLOSED` nếu PO đã chốt thiếu. Chi tiết phiếu đảo có tại `GET /api/stock-reversals/:id`.

## 2B.7. Bằng chứng đính kèm

[purchase-evidence.service.js](../../../src/modules/po-receiving/purchase-evidence.service.js), dùng chung cho PO, kiểm nhận, phiếu nhập, giữ hộ, lệnh chuyển và nhập khác (`parent()` chọn quyền theo `documentKind`).

1. `uploadEvidence` ([dòng 50](../../../src/modules/po-receiving/purchase-evidence.service.js)): một tệp JPEG/PNG/PDF ≤ 5 MB; `inspectFile` kiểm nội dung thật (giải mã ảnh, đọc PDF). Tạo `Attachment` `TEMPORARY` hết hạn sau 24 giờ, tải lên Cloudinary kiểu `authenticated`. Bằng chứng của PO có `accessCategory: 'PURCHASE_PRICE'`.
2. `attachEvidence` ([dòng 61](../../../src/modules/po-receiving/purchase-evidence.service.js)): lệnh `ATTACH_PURCHASE_EVIDENCE` trong `command()`, đổi tệp sang `ATTACHED`, thêm vào `document.evidenceIds`, tăng version chứng từ.
3. `listEvidence` / `downloadEvidence` ([dòng 78](../../../src/modules/po-receiving/purchase-evidence.service.js), [dòng 81](../../../src/modules/po-receiving/purchase-evidence.service.js)): ẩn tệp `PURCHASE_PRICE` với vai trò không phải Owner/Kế toán; link tải ký hạn 60 giây.
4. `evidenceFor` chỉ nhận ID tệp đã `ATTACHED` vào đúng chứng từ. Tái kiểm và quyết định giữ hộ cần bằng chứng. Đảo phiếu, sửa kết quả kiểm và chốt thiếu PO nhận bằng chứng tùy chọn. [Kiểm tệp đính kèm](../../../src/modules/po-receiving/purchase-core.js).
5. Dọn tệp hết hạn: `cleanupPurchaseEvidence` ([dòng 86](../../../src/modules/po-receiving/purchase-evidence.service.js)) chạy qua `node scripts/purchase-maintenance.mjs cleanup-evidence [--apply]` ([purchase-maintenance.mjs](../../../scripts/purchase-maintenance.mjs)); không có `--apply` chỉ đếm.

## 2B.8. Nhánh hàng giữ hộ nhà cung cấp

Dòng kiểm `CUSTODY` (bắt buộc với hàng không `GOOD`) sinh `CustodyReceipt` `PNGH-...` `DRAFT` ở bước 7. Hàng này **không** thuộc cửa hàng (`ownerType: 'SUPPLIER'`, `ownerId` = NCC) nên không tính vào tồn khả dụng và không làm PO tiến trạng thái.

1. **Ghi tồn giữ hộ** — `postCustodyReceipt` ([po-receiving.service.js:608](../../../src/modules/po-receiving/po-receiving.service.js)): vị trí mỗi dòng phải loại `CUSTODY` hoặc `QUARANTINE`; đối chiếu lại dòng kiểm gốc (`CUSTODY`, cùng NCC, lô, sản phẩm, lượng); `balanceAt` với chủ hàng NCC và chất lượng của dòng kiểm; `intakePortions` + `receiveStock` như phiếu nhập mua; bút toán `CUSTODY_RECEIPT`. Ghi `receivedBy`, `handedOverBy` (tùy chọn).
2. `reinspectCustody` tạo `GoodsInspection` `CONFIRMED` với nguồn `REINSPECTION` để ghi chất lượng cho phần đem tái kiểm. Tái kiểm cần bằng chứng.
3. `decideCustody` cần `purchase_custody:decide` và ghi `ApprovalHistory` với `decisionScope: 'PURCHASE_CUSTODY'`. Quyết định `ACCEPT` cần đủ lượng `GOOD` từ kiểm nhận gốc hoặc tái kiểm. Quyết định `RETURN` dùng để trả NCC. Lượng mỗi dòng không vượt phần giữ hộ chưa cam kết.
4. `createCustodyResolution` cần `purchase_custody:execute`, phiếu giữ hộ `POSTED` và quyết định khớp phiên bản (`subjectRevision + 1 === version`). `ACCEPT` tạo `PurchaseReceipt DRAFT` theo hạn mức PO và vị trí đích `RECEIVING`. `RETURN` tạo `CustodyRelease DRAFT`.
5. `postOwnedCustody` kiểm lại quyết định, lô, kho, chủ hàng và kết quả `GOOD`. `transferCustodyStock` chuyển phần đóng gói của dòng giữ hộ sang `STORE`/ `GOOD` ở bãi tiếp nhận. Nếu bút toán trước từng tách thùng và đảo, `restoredCustodyPortions` xác định ID phần đã trả lại. `capabilities.post` yêu cầu thêm `purchase_custody:execute`.
6. `postCustodyRelease` cần `recipientName`. `transferCustodyStock(..., target = null)` trừ khỏi số dư giữ hộ và ghi bút toán `CUSTODY_RELEASE`.
7. `cancelDraft` hủy phiếu giữ hộ NCC `DRAFT`. `reverseReceipt` đảo phiếu `POSTED` khi đã xử lý phiếu nhập từ giữ hộ và đáp ứng điều kiện tồn. [Service giữ hộ](../../../src/modules/po-receiving/purchase-custody.service.js), [API và quyền](../08_api/GOODS_RECEIPTS.md#hủy-nháp-và-đảo-phiếu).

## 2B.9. Đối soát mua hàng

`reconcilePurchasing` ([purchase-reconciliation.js:6](../../../src/modules/po-receiving/purchase-reconciliation.js)) chỉ đọc, chạy bằng `node scripts/purchase-maintenance.mjs reconcile` (cần `MONGODB_URI`, thoát mã 1 khi có lỗi) và trong `test/native-api.integration.test.js`. Mã lỗi: `MISSING_BALANCE` (movement trỏ số dư không tồn tại), `LEDGER_BALANCE` (tổng movement ≠ `quantityBase`), `PACKAGING_BALANCE` (tổng kiện ≠ `quantityBase`), `RR_ALLOWANCE` (dòng PO vượt `approvedQtyBase` theo `withinApproved`), `PO_ALLOWANCE` (`outstanding` hoặc headroom âm). Không có API HTTP.

## 2B.10. Luồng thượng nguồn và hạ nguồn

**Đầu vào của RR** (`source.triggerType`):

| Nguồn | Từ đâu | Kiểm ở `resolveSource` |
|---|---|---|
| `MANUAL_OTHER` | Người lập tự nhập | Không kiểm. |
| `STOCK_THRESHOLD` | Định mức tồn của sản phẩm theo kho (`product.stockThresholds`) | Không kiểm chứng từ; định mức dùng trong cảnh báo `STOCK_SUFFICIENT`. |
| `SALES_SHORTAGE` | Đơn bán (`sales_orders`) hoặc yêu cầu xuất kho (`warehouse_issue_requests`) thiếu hàng | Chứng từ còn hiệu lực, cùng sản phẩm, đúng `version` khi gửi duyệt. |
| `STOCKTAKE_LOW_STOCK` | Đợt kiểm kê `COMPLETED/CLOSED` cùng kho | Sản phẩm nằm trong phạm vi kiểm kê. |

Không có lệnh nào tự tạo RR: chỉ `createReplenishment` ghi vào `replenishment_requests`. Hàng nhập về theo RR nguồn `SALES_SHORTAGE` **không** tự giữ cho đơn bán đó; liên kết chỉ nằm ở `sources[]` (`REPLENISHES_DEMAND`).

**Các module khác dùng chứng từ của quy trình:**

| Module | Dùng gì | Ghi chú |
|---|---|---|
| Chuyển vị trí BF03 | Số dư ở bãi tiếp nhận do phiếu nhập tạo | Phần 2.11–2.15. |
| Báo cáo hàng lỗi ([native.service.js:19](../../../src/modules/return-workflows/native.service.js) `createDefect`) | Dòng phiếu nhập mua `POSTED` (`sourceKind: 'RECEIPT'`) | Lập báo cáo lỗi trên hàng đã nhập; giữ hàng làm giảm `freeQuantity`. |
| Trả nhà cung cấp ([native.service.js:193](../../../src/modules/return-workflows/native.service.js) `createSupplierReturn`) | Dòng `PurchaseReceipt` `POSTED` hoặc `CustodyReceipt` NCC `POSTED` | `supplierOrigin` lần ngược GR → kiểm nhận → hàng đến → PO để xác định NCC. Phiếu giữ hộ có `capabilities.createSupplierReturn`. Dòng trả NCC có `sources` trỏ về phiếu nhập và tạo `StockReservation`, nên phiếu trả chưa hủy chặn đảo phiếu nhập, qua đó chặn cả sửa kết quả kiểm. |
| Báo cáo vận hành ([operational-reports.service.js](../../../src/modules/operational-reports/operational-reports.service.js)) | Nhóm `purchases` (PO + phiếu nhập `POSTED`), `receipts` | Owner và Kế toán. |
| Nhà cung cấp ([supplier.service.js](../../../src/modules/suppliers/supplier.service.js)) | Danh sách PO, phiếu nhập mua, trả NCC của một NCC | |
| Tồn kho và lịch sử movement ([warehouse-stock/service.js](../../../src/modules/warehouse-stock/service.js)) | `stock_transactions` `PURCHASE_RECEIPT`, `CUSTODY_RECEIPT`, `REVERSAL` | |
| Đánh giá RR | `incomingPurchaseOrders`, `openRequests` đọc PO và phiếu nhập `POSTED` | Mục 2.1. |

**Thông báo:** mỗi lệnh qua `command()` ghi một `SystemEvent` `handlerCode: 'BUSINESS_NOTIFICATION'` `PENDING`. Trong `src` ngày 19/11/2026 không có worker nào đọc và xử lý bản ghi này (chỉ seed demo ghi `DEMO_SIMULATION`).

**Frontend** (checkout `fe` cạnh `be`, không liên kết vì nằm ngoài repo này): `fe/src/features/replenishments`, `purchase-orders`, `inspections`, `receipts`, `custody`, `location-moves`, `supplier-returns`.

---

# Phần 3 — Các điểm cần lưu ý / Rủi ro tiềm ẩn

Các điểm dưới đây rút ra từ đọc code, **chưa** được kiểm bằng test riêng trong lượt viết tài liệu này.

### 3.1. Giao dịch và đồng thời

1. **Mọi lệnh ghi đều trong một transaction** (`command → transaction`), kể cả cập nhật nhiều collection (chứng từ, tồn, sổ cái, biên nhận, audit). Không phát hiện chỗ nào ghi DB mà quên `session` trong các hàm của luồng này. Ngược lại, các hàm **đọc** như `locationMovementOptions`, `inspectionContext`, `requireEditableRequest` chạy không có session — chỉ phục vụ hiển thị, số liệu có thể cũ ngay sau khi trả về; lệnh ghi luôn kiểm lại.
2. **`withTransaction` có thể chạy lại `work` nhiều lần** khi xung đột ghi. Code trong `work` hiện không có tác dụng phụ ngoài DB, nhưng nếu sau này thêm gửi email/gọi API bên ngoài vào trong `work` thì sẽ bị gửi trùng. Dùng `SystemEvent` (outbox) thay vì gọi trực tiếp.
3. **Vòng `for` trong `command()` không bao giờ lặp lại** ([document-command.js:88](../../../src/shared/utils/document-command.js)): nhánh `catch` hoặc `return` replay hoặc `throw`. Biến `attempt` vô tác dụng; việc thử lại thật sự nằm trong `transaction()`. Không sai, nhưng dễ gây hiểu nhầm khi đọc.
4. **Tạo `StockHoldingPoint`/`InventoryBalance` lần đầu đồng thời**: hai giao dịch cùng ghi tồn lần đầu vào cùng (vị trí, lô) có thể cùng `new ...().save()` ⇒ một bên lỗi 11000 trên unique index của balance. `transaction()` chỉ tự thử lại 11000 khi khóa là **mã phiếu**; `command()` chỉ cứu 11000 khi đã có biên nhận. Trong luồng này, `postReceipt` và `confirmLocationMovement` đều gọi `guardLocations` (nay kèm `guardWarehouses`) **trước** `balanceAt`, nên hai giao dịch cùng kho đã xung đột ghi ở bản ghi kho và được `withTransaction` chạy lại trước khi tới bước tạo balance. Rủi ro chỉ còn ở luồng nào tạo balance mà không khóa kho/vị trí trước. Đổi lại, khóa theo kho làm **mọi lệnh ghi tồn trong cùng kho** (nhập, chuyển, xuất, kiểm kê) chạy tuần tự; kho bận có thể thấy nhiều lượt thử lại hơn.
5. **Khóa lạc quan theo `version` có ở mọi chứng từ và mọi balance**; FE bắt buộc gửi `expectedVersion`, `expectedPoVersion`, `sourceBalanceVersion`. Một thao tác bị 409 phải tải lại dữ liệu; gửi lại cùng `operationKey`/`idempotencyKey` sau khi tải lại sẽ bị coi là **payload khác** (vì `expectedVersion` đổi) ⇒ cần sinh khóa mới.
6. **Lệnh chuyển vị trí dễ bị "kẹt" khi bãi tiếp nhận dùng chung số dư.** `confirmLocationMovement` đòi số dư nguồn còn đúng `sourceBalanceVersion` đã chụp lúc lập lệnh. Số dư ở R-01 là chung cho mọi phiếu nhập cùng lô; chỉ cần một phiếu nhập khác ghi tồn cùng lô vào R-01, hoặc một lệnh chuyển/xuất khác chạm số dư đó, thì mọi lệnh `OPEN` đang lấy từ số dư này đều báo "Tồn đã thay đổi; hủy phần còn lại và lập lại lệnh". Người dùng phải hủy và lập lại.

### 3.2. Toàn vẹn số liệu

7. **Kiểm nhận nháp không giữ hạn mức PO.** Nhiều phiếu kiểm nháp có thể cùng vượt lượng PO; chỉ phiếu xác nhận sau mới bị chặn "Tổng nhận vượt phần PO còn được nhận". Đây là thiết kế có chủ đích (nháp không cam kết), nhưng thủ kho có thể đếm xong mới biết bị vượt.
8. **Dòng `GOOD` + `REJECT`** được chấp nhận ở `prepare()` nhưng ở `confirmInspection()` không đi vào phiếu nhập hay giữ hộ. Nếu hàng bị từ chối nhưng thực tế vẫn nằm trong kho (chờ NCC lấy), nó **không có trong tồn**, không chiếm sức chứa và không ai theo dõi được ngoài phiếu kiểm.
9. **Hàng ở bãi tiếp nhận không được tính "tồn khả dụng"** cho đánh giá RR (`availableStock` chỉ lấy `STORAGE` + `isPickable`). Trong khoảng từ ghi tồn đến khi chuyển lên kệ, hệ thống có thể cảnh báo thiếu hàng dù hàng đã về — nhưng cảnh báo `INCOMING_PO` cũng biến mất khi PO `COMPLETED`. Hệ quả: một RR mới lập trong khoảng này có thể không nhận cảnh báo nào.
10. **Không còn gì theo dõi "hàng nhập chưa lên kệ".** Sau khi gỡ lệnh cất mua, phiếu nhập kết thúc ở `POSTED`; `receivingSummary` bỏ `unplacedReceiptLines/unplacedQtyBase`, hàng đợi bỏ `AWAITING_PUTAWAY`, đối soát bỏ `PLACEMENT_CAP`. Lệnh `RELOCATE` chỉ trỏ tới số dư, không trỏ tới phiếu nhập, nên hệ thống không trả lời được "phiếu PNM-... đã lên kệ bao nhiêu". Hàng có thể nằm ở bãi tiếp nhận vô thời hạn mà không có cảnh báo.
11. **Thùng không vừa ô kệ chỉ bị phát hiện lúc xác nhận.** Lệnh cất mua cũ gọi `estimateCartonCapacity` ngay khi **lập** lệnh. BF03 không kiểm lúc lập; việc kiểm nằm trong `verifyCapacity → checkBinCapacity` khi **xác nhận** (thùng nguyên phải vừa kích thước ô, tổng thể tích không vượt). Thủ kho có thể lập lệnh, mang hàng tới ô rồi mới bị từ chối.
12. **BF03 không ràng buộc loại vị trí hay chất lượng như lệnh cất cũ.** Đích có thể là `RECEIVING`, `STORAGE`, `STAGING`, `QUARANTINE` hoặc `CUSTODY`; nguồn có thể là số dư bất kỳ chất lượng/chủ hàng (kể cả hàng giữ hộ NCC). `moveStock` giữ nguyên lô, chất lượng và chủ hàng, nên tồn không bị đổi bản chất, nhưng hàng `GOOD` của cửa hàng có thể bị đặt vào ô `CUSTODY` mà không có cảnh báo.
13. **Lượng chuyển chỉ nhận số nguyên** (`/^\d+$/` ở `relocationItems`, `/^\d{1,14}$/` ở xác nhận và Zod). Sản phẩm có `wholeBaseUnits = false` (lượng gốc thập phân) không chuyển được phần lẻ thập phân qua BF03.
14. **`submission()` ghi `conversionVersion: document.version`** ([replenishment.commands.js:249](../../../src/modules/replenishments/replenishment.commands.js)) — đây là version của phiếu RR, không phải version của bản ghi `Conversion`. Ai đọc ảnh gửi duyệt nên dựa vào `conversionSnapshot` (= `baseUnitsPerUnit`), không dựa vào `conversionVersion`.
15. Với `REJECT` hoặc `REVISE`, `reviewReplenishment` ghi `approvedQtyBase = '0'` và quyết định tương ứng trên mọi dòng. PO đọc quyết định `APPROVE` của đúng bản RR đã duyệt.
16. `reviewedContent` chụp RR sau khi đã ghi lượng duyệt. Nội dung lúc gửi duyệt nằm ở `submissions[]`.
17. `RR_ALLOWANCE` dùng cùng trần với lệnh lập và phát hành PO. Ngoại lệ vượt trần chỉ áp dụng cho đơn vị có `isCarton`.
18. **Hệ số của dòng PO tùy đơn vị đặt.** Giữ đơn vị của RR ⇒ dùng hệ số lịch sử của RR (`source.baseUnitsPerUnit`). Đổi đơn vị (`uomCode`) ⇒ dùng quy đổi **hiện hành, cấp sản phẩm** (`resolveConversion(product, null, …)`) — không theo lô, vì PO chưa có lô. Nếu thùng thực tế của lô về có số viên khác quy đổi chung, lượng PO theo thùng và lượng đếm thực tế theo lô sẽ lệch; kiểm nhận đếm theo quy đổi **của lô**.

### 3.3. Kiểm tra null/undefined và đầu vào

19. `prepare()` truy cập `item.packagingSnapshot.baseUnitsPerPackage` cho dòng `SEALED`; an toàn vì `lotId` là bắt buộc nên `makeItem` luôn tạo `packagingSnapshot`. Nếu sau này cho phép kiểm không có lô, dòng này sẽ lỗi.
20. `createPurchaseOrder` không có `checkPermission` ở tầng route; quyền chỉ được kiểm trong `command()`. Kết quả tương đương, nhưng request thiếu quyền vẫn chạy hết validate Zod trước khi bị 403. Các route BF03 thì có `checkPermission` ở tầng route.
21. Cấp mã phiếu quét toàn bộ `_id` cùng tiền tố trong ngày bằng regex (`$in: [RegExp]`) mỗi lần tạo phiếu. Với lượng phiếu lớn trong một ngày/kho, chi phí tăng tuyến tính; số trùng được xử lý bằng thử lại tối đa 20 lần.
22. Controller BF03 truyền `req.body` (không phải `req.validated.body`) vào service. Hiện an toàn vì middleware `validate` gán lại `req.body = parsed.body` ([validate.js](../../../src/middlewares/validate.js)); nếu middleware đổi cách làm, service sẽ nhận payload chưa qua Zod.

### 3.4. Tách bạch trách nhiệm

23. RR: người duyệt ≠ người lập (kiểm ở service và rule schema `approval_history`). PO, kiểm nhận, ghi tồn **không** có ràng buộc người khác người: cùng một người có quyền `goods_receipt_inspection:update` và `:post` có thể vừa kiểm vừa ghi tồn. Lệnh chuyển vị trí còn ngược lại: **chỉ người lập** được sửa, hủy và xác nhận (`assignedTo` cũng là người lập), nên người lập vắng mặt thì lệnh đứng yên và giữ tồn "đang chờ" cho tới khi chính họ hủy. Đây là hiện trạng code, không phải quyết định nghiệp vụ được ghi trong tài liệu này.

### 3.5. Luồng phụ

24. **Thông báo chưa được gửi.** `command()` ghi `SystemEvent` `BUSINESS_NOTIFICATION` `PENDING` cho mọi lệnh, nhưng trong `src` không có worker xử lý; các bản ghi này tích lũy.
25. **Hủy phiếu nhập nháp giải phóng hạn mức PO.** Phiếu kiểm vẫn `CONFIRMED`. Để nhận lại phần đó, dùng sửa kết quả kiểm (2B.5).
26. **Đảo phiếu kiểm phần đóng gói theo giao dịch gốc.** Các phiếu cùng số dư có thể đảo độc lập nếu phần hàng còn nguyên và đủ lượng khả dụng. Lệnh chuyển đang mở, lượt đếm kiểm kê và phần giữ do báo lỗi vẫn có thể chặn trên số dư hoặc vị trí chung (2B.6).
27. **Chốt thiếu PO không hoàn tác được**, không cần Owner duyệt và bằng chứng tùy chọn (quyết định 16/11/2026). PO đã chốt thiếu một phần thì không hủy được nữa.
28. **Hủy PO giải phóng RR** (`$unset replenishmentRequestId`): RR `APPROVED` đó lập được PO mới với cùng quyết định duyệt. Lượng của PO đã hủy không còn tính trong `openRequests`/`incomingPurchaseOrders`.
29. **RR nguồn thiếu hàng bán không gắn hàng về cho đơn bán.** Nhập về xong, đơn bán vẫn phải giữ hàng theo luồng bán thông thường.

---

## Phụ lục — Vị trí file

| Khâu | File |
|---|---|
| Khung lệnh, version, biên nhận | [src/shared/utils/document-command.js](../../../src/shared/utils/document-command.js) |
| Transaction, phân trang, serialize | [src/shared/utils/persistence.js](../../../src/shared/utils/persistence.js) |
| Cấp mã phiếu | [src/shared/utils/document-number.js](../../../src/shared/utils/document-number.js) |
| Quy đổi đơn vị | [src/shared/utils/conversions.js](../../../src/shared/utils/conversions.js), [document-items.js](../../../src/shared/utils/document-items.js) |
| Sao dòng, liên kết nguồn | [src/shared/utils/document-copy.js](../../../src/shared/utils/document-copy.js) |
| Tồn kho, kiện, sổ cái | [src/shared/utils/stock.js](../../../src/shared/utils/stock.js) |
| RR | [src/modules/replenishments/](../../../src/modules/replenishments/) |
| PO | [src/modules/purchase-orders/](../../../src/modules/purchase-orders/) |
| Kiểm nhận và ghi nhập | [src/modules/po-receiving/](../../../src/modules/po-receiving/) |
| Sửa kết quả kiểm, đảo phiếu nhập | [purchase-correction.service.js](../../../src/modules/po-receiving/purchase-correction.service.js) |
| Giữ hộ NCC | [purchase-custody.service.js](../../../src/modules/po-receiving/purchase-custody.service.js), `postCustodyReceipt` trong [po-receiving.service.js](../../../src/modules/po-receiving/po-receiving.service.js) |
| Bằng chứng đính kèm | [purchase-evidence.service.js](../../../src/modules/po-receiving/purchase-evidence.service.js) |
| Đọc, hàng đợi, lịch sử nhận hàng | [purchase-read.service.js](../../../src/modules/po-receiving/purchase-read.service.js) |
| Đối soát, dọn bằng chứng | [purchase-reconciliation.js](../../../src/modules/po-receiving/purchase-reconciliation.js), [scripts/purchase-maintenance.mjs](../../../scripts/purchase-maintenance.mjs) |
| Danh sách phiếu nhập chung | [src/modules/goods-receipts/goods-receipt.routes.js](../../../src/modules/goods-receipts/goods-receipt.routes.js) |
| Trả NCC, báo cáo lỗi từ phiếu nhập | [src/modules/return-workflows/native.service.js](../../../src/modules/return-workflows/native.service.js) |
| Chuyển vị trí (lên kệ) | [src/modules/location-movements/](../../../src/modules/location-movements/) · [API BF03](../08_api/location-movements/README.md) |
| Model | [src/models/](../../../src/models/) |
