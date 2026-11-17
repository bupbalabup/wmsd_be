# Hướng dẫn đọc code: từ Yêu cầu bổ sung (RR) đến Nhập hàng và Cất hàng

> Ngày viết: 16/11/2026. Nguồn: đọc trực tiếp code trong `be/src` tại thời điểm viết. Tài liệu chỉ mô tả code hiện có, không đưa ra quyết định nghiệp vụ mới. Số dòng có thể lệch khi code thay đổi; tên hàm là mốc ổn định hơn.

## 1. Thông tin quy trình nghiệp vụ

- **Tên quy trình:** Bổ sung hàng qua mua hàng — RR → PO → Hàng đến & Kiểm nhận → Phiếu nhập mua (ghi tồn). Kho dùng Chuyển vị trí để đưa hàng lên kệ.
- **Bối cảnh:** Kho (hoặc Sales) thấy thiếu hàng, lập **Yêu cầu bổ sung** (RR, mã `YCBS-...`). Owner duyệt số lượng. Kế toán lập **Đơn mua hàng** (PO, `ĐMH-...`) gửi nhà cung cấp. Khi xe hàng đến, thủ kho ghi **Hàng đến kho** (`HĐK-...`) và **Phiếu kiểm nhận** (`PKN-...`), đếm theo lô, chấm chất lượng. Hàng đạt được lập **Phiếu nhập mua** (`PNM-...`), ghi tồn vào **bãi tiếp nhận** (vị trí `RECEIVING`). Sau đó thủ kho lập **Lệnh chuyển vị trí** (`LCV-...`, `TransferOrder` loại `RELOCATE`) và chuyển hàng từ bãi tiếp nhận lên **kệ lưu trữ** (vị trí `STORAGE`).
- **Mục tiêu kỹ thuật:** mỗi bước là một lệnh (command) chạy trong **một MongoDB transaction**, có chống gửi trùng (idempotency), khóa lạc quan theo `version`, ghi `audit_logs`, và mọi thay đổi tồn kho đi qua **sổ cái** `stock_transactions.movements`.

### Mã chứng từ

Mã phiếu chính là `_id` của document (kiểu chuỗi), sinh bởi `nextDocumentFields()` theo mẫu `<tiền tố>-<mã kho>-<YYMMDD>-<6 số>`, ví dụ `YCBS-K01-261116-000001`. Bảng tiền tố nằm ở [document-number.js:7](../../../src/shared/utils/document-number.js).

| Loại | Tiền tố | Chuyển vị trí | [src/modules/location-movements/](../../../src/modules/location-movements/) |
| Model | Collection |
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
| 1 | `POST /replenishments` | `createReplenishment` | [replenishment.commands.js:375](../../../src/modules/replenishments/replenishment.commands.js) |
| 1b | `PUT /replenishments/:id` | `updateReplenishment` | [replenishment.commands.js:402](../../../src/modules/replenishments/replenishment.commands.js) |
| 2 | `POST /replenishments/:id/submit` | `submitReplenishment` | [replenishment.commands.js:434](../../../src/modules/replenishments/replenishment.commands.js) |
| 3 | `POST /replenishments/:id/review` | `reviewReplenishment` | [replenishment.commands.js:459](../../../src/modules/replenishments/replenishment.commands.js) |
| 4 | `POST /purchase-orders` | `createPurchaseOrder` | [purchase-order.commands.js:130](../../../src/modules/purchase-orders/purchase-order.commands.js) |
| 5 | `POST /purchase-orders/:id/confirm` | `confirmPurchaseOrder` | [purchase-order.commands.js:218](../../../src/modules/purchase-orders/purchase-order.commands.js) |
| 6 | `POST /purchase-orders/:id/inspections` | `createInspection` | [po-receiving.service.js:162](../../../src/modules/po-receiving/po-receiving.service.js) |
| 6b | `PUT /goods-inspections/:id` | `updateInspection` | [po-receiving.service.js:203](../../../src/modules/po-receiving/po-receiving.service.js) |
| 7 | `POST /goods-inspections/:id/confirm` | `confirmInspection` | [po-receiving.service.js:241](../../../src/modules/po-receiving/po-receiving.service.js) |
| 8 | `POST /goods-receipts/purchase/:id/post` | `postReceipt` | [po-receiving.service.js:380](../../../src/modules/po-receiving/po-receiving.service.js) |
| 9a | `GET /location-movements/options?warehouseId=…` | `locationMovementOptions` | [location-movement.service.js](../../../src/modules/location-movements/location-movement.service.js) |
| 9 | `POST /location-movements` | `createLocationMovement` | [location-movement.service.js](../../../src/modules/location-movements/location-movement.service.js) |
| 10 | `POST /location-movements/:id/confirm` | `confirmLocationMovement` | [location-movement.service.js](../../../src/modules/location-movements/location-movement.service.js) |

Route của bước 6–10 khai báo trong [po-receiving.routes.js](../../../src/modules/po-receiving/po-receiving.routes.js); `/goods-receipts/purchase` được gắn qua [goods-receipt.routes.js:50](../../../src/modules/goods-receipts/goods-receipt.routes.js).

---

# Phần 1 — Bức tranh tổng quan & bản đồ MongoDB Models

## 1.1. Luồng đi từ đầu đến cuối (End-to-End Flow)

1. **Lập RR (nháp hoặc gửi luôn).** Nhân viên kho/Sales chọn kho, ngày cần hàng, lý do và từng dòng sản phẩm + đơn vị + số lượng. Server quy đổi số lượng sang **đơn vị gốc** (`qtyBase`), tự đánh giá tồn khả dụng, RR đang mở, PO đang về và tồn ở kho khác. Nếu có cảnh báo, người lập phải xác nhận "vẫn cần" kèm giải trình. RR được lưu `DRAFT` (hoặc `SUBMITTED` nếu `action = 'SUBMIT'`), `version = 1`.
2. **Sửa RR** (chỉ người lập, chỉ khi `DRAFT`/`REVISION_REQUIRED`, chưa có PO). Mỗi lần sửa tăng `version`.
3. **Gửi duyệt RR.** Server đánh giá lại từng dòng theo dữ liệu mới nhất, rồi chụp **ảnh bất biến** (`submissions[]`) gồm kho, sản phẩm, đơn vị, hệ số quy đổi, số lượng. Trạng thái → `SUBMITTED`.
4. **Owner duyệt RR.** Người duyệt phải khác người lập. Với `APPROVE`, phải xét **mọi dòng**; mỗi dòng có `approvedQtyBase ≤ qtyBase`; giảm số lượng thì phải có lý do riêng của dòng. Một bản ghi `approval_history` bất biến được tạo. RR → `APPROVED` / `REJECTED` / `REVISION_REQUIRED`.
5. **Lập PO từ RR đã duyệt.** Mỗi dòng PO trỏ về đúng một dòng RR và quyết định duyệt còn hiệu lực; lượng PO ≤ lượng duyệt. Một RR chỉ có **một PO sống** (unique index). PO lưu `DRAFT`.
6. **Phát hành PO.** Kiểm lại RR vẫn `APPROVED` cùng revision, sản phẩm/NCC/kho còn hoạt động. PO → `OPEN`.
7. **Hàng đến – lập phiếu kiểm nhận.** Thủ kho ghi thời điểm đến, người giao, rồi từng dòng: dòng PO, **lô thực nhận**, số đếm (theo thùng nguyên hoặc đơn vị gốc), chất lượng (`GOOD/DAMAGED/PENDING/BLOCKED`), quyết định sở hữu (`ACCEPT/CUSTODY/REJECT`), tình trạng bao bì. Server tạo cùng lúc `GoodsArrival` + `GoodsInspection` ở `DRAFT`. Chưa có tồn kho.
8. **Xác nhận kiểm nhận.** Server kiểm tổng lượng `ACCEPT` không vượt phần PO còn được nhận; bắt buộc chọn **vị trí RECEIVING** cho mỗi dòng `ACCEPT`. Sinh **Phiếu nhập mua `DRAFT`** cho phần `ACCEPT`, sinh **Phiếu giữ hộ** cho phần `CUSTODY`. Kiểm nhận → `CONFIRMED`, Hàng đến → `RECORDED`.
9. **Ghi tồn phiếu nhập mua.** Server khóa các vị trí, đối chiếu lại nguồn kiểm nhận, tìm/tạo `stock_holding_points` + `inventory_balances` (chủ hàng `STORE`, chất lượng `GOOD`), cộng tồn, tách **kiện** (`packagingPortions`: thùng nguyên `SEALED` / hàng lẻ `LOOSE`/`OPEN`), ghi `stock_transactions` (`PURCHASE_RECEIPT`), kiểm sức chứa. Phiếu → `POSTED`. PO → `PARTIAL` hoặc `COMPLETED`.
10. **Lập lệnh chuyển vị trí.** Từ phiếu nhập đã ghi, chọn **Chuyển vị trí** để mở form BF03. Màn hình điền kho, vị trí nguồn, tồn hiện tại và lý do. Chọn kệ hoặc vị trí đích và kiểm lại lượng. Lệnh `RELOCATE` ở `OPEN` giữ lượng chờ chuyển.
11. **Xác nhận toàn bộ lệnh.** Server chuyển tồn từ nguồn sang đích qua `moveStock`, ghi `StockTransaction` với `operation: 'RELOCATE'`. Lệnh sang `CONFIRMED`. Hàng ở kệ `STORAGE` có `isPickable` có thể được chọn để xuất bán nếu đủ các điều kiện tồn.
12. **Mọi bước** trả về một "biên nhận" `{ id, version, workflowStatus, operationId, resultRefs, replayed }`. Gửi lại cùng `operationKey`/`creationKey` và cùng payload sẽ nhận lại đúng biên nhận cũ (`replayed: true`) thay vì làm lại.

### Sơ đồ trạng thái

```text
RR : DRAFT ─submit─► SUBMITTED ─review─► APPROVED │ REJECTED │ REVISION_REQUIRED ─(sửa, submit)─► SUBMITTED
PO : DRAFT ─confirm─► OPEN ─post GR một phần─► PARTIAL ─post GR đủ─► COMPLETED   (close-remainder ─► CLOSED)
ARR: DRAFT ─confirm INS─► RECORDED
INS: DRAFT ─confirm─► CONFIRMED
GR : DRAFT ─post─► POSTED
TO : OPEN ─confirm toàn bộ─► CONFIRMED   (cancel ─► CANCELLED)
```

### Chuỗi liên kết chứng từ (`sources[]`)

```text
RR.items[i] ◄─requestItemId── PO.items[j] ◄─purchaseOrderItemId── ARR.items[k]
                                                                    ▲ inspectedSourceLineId
                                         INS.items[k] ──inspectionResultId──► GR.items[m]
```

Mỗi document còn có mảng `sources[]` (`{ documentId, subjectCollection, itemId, linkedQty, relationCode }`) ghi nguồn gốc theo cả header và dòng.

## 1.2. Các MongoDB Models tham gia

| Tên Model (collection) | Hành động | Mục đích nghiệp vụ trong quy trình |
|---|---|---|
| `User` (`users`) | Find + Populate `roleId.permissionIds` | Nạp lại vai trò, quyền và kho được gán **ở mỗi lệnh**, không tin token cũ. |
| `Warehouse` (`warehouses`) | Find / exists | Kho phải `isActive`; `code` dùng để cấp mã phiếu; `clearHeightMm` dùng kiểm thùng vừa ô kệ. |
| `Product` (`products`) | Find / exists | Sản phẩm phải `isActive`; `baseUnit`, `wholeBaseUnits` (chỉ nhận số nguyên đơn vị gốc), `stockThresholds` (định mức theo kho). |
| `Uom` (`uoms`) | Find / exists | Đơn vị nhập; `isCarton` (là đơn vị thùng), `areaMm2` (đơn vị diện tích như m²). |
| `Conversion` (`conversions`) | Find (sort `validFrom`) / Aggregate | Hệ số quy đổi `basePerUnit` theo sản phẩm, đơn vị, (tùy chọn) lô. |
| `ProductBatch` (`product_batches`) | Find / Update (`updatedAt`) | Lô phải `VERIFIED`; `piecesPerCarton` và kích thước thùng; khóa định danh lô khi đưa vào chứng từ. |
| `ReplenishmentRequest` (`replenishment_requests`) | Create / Find / Update | Chứng từ RR, dòng hàng, ảnh gửi duyệt, lượng duyệt. |
| `ApprovalHistory` (`approval_history`) | Create / Find | Quyết định duyệt RR bất biến (append-only); PO dựa vào đây để giới hạn lượng. |
| `SalesOrder`, `WarehouseIssueRequest`, `Stocktake`, `StocktakeSnapshot` | Find / exists | Chỉ khi dòng RR có nguồn `SALES_SHORTAGE` hoặc `STOCKTAKE_LOW_STOCK`. |
| `PurchaseOrder` (`purchase_orders`) | Create / Find / Update / exists | Đơn mua; trạng thái theo lượng đã nhập. |
| `Supplier` (`suppliers`) | Find / exists | NCC phải `ACTIVE`; chụp `supplierSnapshot`. |
| `GoodsArrival` (`goods_arrivals`) | Create / Update / Find | Hồ sơ hàng đến: thời điểm, người giao, dòng thực nhận theo lô. |
| `GoodsInspection` (`goods_inspections`) | Create / Update / Find | Kết quả kiểm: chất lượng, quyết định sở hữu, bao bì, bãi tiếp nhận. |
| `PurchaseReceipt` (`goods_receipts`, `documentKind: 'PURCHASE'`) | Create / Update / Find | Phiếu nhập mua – chứng từ duy nhất làm tăng tồn sở hữu của cửa hàng. |
| `CustodyReceipt` (`custody_receipts`) | Create | Nhánh hàng `CUSTODY` (giữ hộ NCC), không cộng vào tồn của cửa hàng. |
| `WarehouseLocation` (`warehouse_locations`) | Find / `findOneAndUpdate($inc operationVersion)` | Kiểm vị trí đúng kho, đúng loại (`RECEIVING`, `STORAGE`…); tăng `operationVersion` để khóa vị trí trong transaction. |
| `StocktakeLocationLock` (`stocktake_location_locks`) | exists / Find | Vị trí đang kiểm kê thì không được ghi tồn, không tính tồn khả dụng. |
| `StockHoldingPoint` (`stock_holding_points`) | Find / Create | "Điểm giữ hàng" 1-1 với vị trí (`type: 'LOCATION'`). |
| `InventoryBalance` (`inventory_balances`) | Find / Create / `updateOne` theo `version` | Số dư tồn theo khóa (điểm giữ hàng × lô × chất lượng × chủ hàng) và các kiện. |
| `StockReservation` (`stock_reservations`) | Find (Update/Create khi chuyển giữ hàng) | Tính phần tồn đã giữ cho đơn bán. |
| `DefectReport` (`defect_reports`) | Find | Tính phần tồn đang bị chặn (`holds`). |
| `TransferOrder` (`transfer_orders`) | Create / Find / Update | Lệnh chuyển vị trí (`taskKind: 'RELOCATE'`). Lệnh mở chiếm tồn "đang chờ". |
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
  sealedPackCount, quantityBase, packagingSnapshot, measuredVolumeMm3 } ] }

// Sổ cái: src/models/stock-transaction.model.js — unique(sourceId, operation, eventKey), unique(requestKey)
{ sourceType, sourceId, operation, eventKey, requestKey, requestHash, performedBy,
  movements: [ { sourceLineId, fromBalanceId, toBalanceId, quantityBase,
                 fromBefore, fromAfter, toBefore, toAfter, packagingPortionIds } ] }

// Lệnh cất dòng: lineKind 'WAREHOUSE_TASK', details = src/models/warehouse-task-details.schema.js
{ fromLocationId, toLocationId, qualityCode, sourceBalanceId, sourceBalanceVersion }
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

  3. Chạy `work`, rồi ghi biên nhận, audit, sự kiện (dòng 100–158). `subjectType` lấy từ `document.constructor.collection.name`, `resultCode` = `workflowStatus` mới.

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

[document-number.js:28](../../../src/shared/utils/document-number.js)

- **Vai trò:** cấp mã phiếu tăng dần theo (loại, kho, ngày) mà **không có collection đếm**.
- **Biến:** `config` (`['YCBS','Yêu cầu bổ sung']`), `unit` (= `warehouse.code`), `period` (`YYMMDD` giờ Việt Nam), `patterns` (regex mã hiện tại và mã lịch sử có khoảng trắng), `codes` (mọi `_id` khớp tiền tố trong collection + trong `operation_records.subjectId`), `last`, `sequence`. Trả về `{ _id, documentNo, tenLoaiPhieu, maDonVi, kyDanhSo, soThuTu }`.
- **Logic chính:**

  ```js
  if(!session?.inTransaction())throw validationError('Cấp mã phiếu phải nằm trong giao dịch');
  ...
  const rows=await Model.collection.find({[field]:numberFilter},{session,projection}).toArray();
  ...
  const history=await operations.find({subjectId:numberFilter},{session,projection:{subjectId:1}}).toArray();
  ...
  const sequence=Math.max(last,session.documentNumbers.get(scope)??0)+1;
  ```

  *Tại sao:* đọc cả `operation_records` để một phiếu đã bị xóa không bị cấp lại số (biên nhận vẫn giữ mã cũ). `session.documentNumbers` giúp một giao dịch cấp nhiều phiếu cùng loại (vd hai phiếu) không trùng số nhau.

- `newBusinessDocument(Model, user, header, items, status)` ([document-number.js:69](../../../src/shared/utils/document-number.js)) gói lại: lấy `warehouseId` từ header, gọi `nextDocumentFields`, tạo `new Model({ ..., workflowStatus: status, version: 1, createdBy, occurredAt, header, items })`. `newDocument()` trong [purchase-core.js:8](../../../src/modules/po-receiving/purchase-core.js) là bí danh cho các chứng từ mua hàng.

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

[replenishment.commands.js:375](../../../src/modules/replenishments/replenishment.commands.js). Route `POST /api/replenishments` có `checkPermission("replenishment_request:create")` + `validate(createReplenishmentSchema)` ([replenishment.validation.js](../../../src/modules/replenishments/replenishment.validation.js)). Controller trả **201** cho lần đầu, **200** khi replay ([replenishment.controller.js:48](../../../src/modules/replenishments/replenishment.controller.js)).

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

[replenishment.commands.js:56](../../../src/modules/replenishments/replenishment.commands.js)

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

[replenishment.commands.js:104](../../../src/modules/replenishments/replenishment.commands.js)

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

  2. Quy đổi dòng bằng `makeItem(line, index + 1, session, { previous: old, lineKind: "REPLENISHMENT" })`. Lý do dòng: bỏ trống ⇒ giữ lý do cũ; `null` ⇒ xóa.

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

[conversions.js:8](../../../src/shared/utils/conversions.js), [conversions.js:38](../../../src/shared/utils/conversions.js)

- **Thứ tự tìm hệ số:** đơn vị = đơn vị gốc ⇒ `1`; nếu có lô ⇒ quy đổi riêng của lô (mới nhất có `validFrom ≤ now`); nếu không có và (không có lô hoặc đơn vị không phải thùng) ⇒ quy đổi chung của sản phẩm (`productBatchId: null`); không có ⇒ lỗi "Thiếu quy đổi…".

  ```js
  let conversion = batch && await Conversion.findOne({ ...scope, productBatchId: batch._id }).sort({ validFrom: -1 }).session(session);
  if (!conversion && (!batch || !uom.isCarton)) {
    conversion = await Conversion.findOne({ ...scope, productBatchId: null }).sort({ validFrom: -1 }).session(session);
  }
  ```

  *Tại sao:* số viên/thùng khác nhau theo lô, nên đơn vị **thùng** bắt buộc phải có quy đổi theo lô; đơn vị diện tích (m²) thì dùng chung theo sản phẩm.
- `toBaseQuantity`: nhân hệ số; nếu đơn vị là diện tích (`uom.areaMm2 != null`) và sản phẩm đếm nguyên ⇒ làm tròn 6 chữ số rồi **làm tròn lên** (`ceil`) — mua 10 m² thì đặt đủ số viên phủ được 10 m².

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

- **`resolveSource(line, warehouseId, user, session)`** ([evaluation.js:49](../../../src/modules/replenishments/replenishment.evaluation.js)): `MANUAL_OTHER` trả nguyên; `SALES_SHORTAGE` đọc `WarehouseIssueRequest` → `SalesOrder`, kiểm còn hiệu lực, cùng sản phẩm, gắn `version` hiện tại; `STOCKTAKE_LOW_STOCK` đọc `Stocktake` phải `COMPLETED/CLOSED` cùng kho, sản phẩm phải nằm trong phạm vi kiểm kê (dòng kiểm kê hoặc `StocktakeSnapshot`).
- **`availableStock(productId, warehouseId, lotId, session)`** ([evaluation.js:216](../../../src/modules/replenishments/replenishment.evaluation.js)) — định nghĩa "tồn khả dụng":

  ```js
  const locations = await m.WarehouseLocation.find({ warehouseId, isActive: true, locationType: "STORAGE", isPickable: true })...
  const locks = await m.StocktakeLocationLock.find({ locationId: { $in: locationIds }, status: "LOCKED" })...
  ...
  const balances = await m.InventoryBalance.find({ holdingPointId: {...}, batchId: {...}, qualityStatus: "GOOD", ownerType: "STORE" })
  for (const balance of balances) available = available.plus(positive(await freeQuantity(balance, session)));
  ```

  Chỉ tính hàng **đã lên kệ lưu trữ lấy được**, không khóa kiểm kê, chất lượng `GOOD`, thuộc cửa hàng. Hàng còn ở bãi tiếp nhận **chưa** được tính. `freeQuantity` ([stock.js:48](../../../src/shared/utils/stock.js)) = `quantityBase − giữ cho đơn bán − lệnh chuyển/cất đang chờ − hàng bị chặn do lỗi`.
- **`openRequests(...)`** ([evaluation.js:149](../../../src/modules/replenishments/replenishment.evaluation.js)): tìm RR `DRAFT/SUBMITTED/APPROVED` cùng kho, cùng sản phẩm (trừ phiếu đang sửa). `pendingRequestQuantity()` (dòng 15) lấy `approvedQtyBase` nếu đã duyệt, ngược lại `qtyBase`; nếu RR đã có PO `OPEN/PARTIAL` thì trừ phần đã lên PO; PO kết thúc ⇒ 0. Chỉ Owner/Kế toán hoặc chính người lập mới thấy chi tiết từng RR (`relatedRequests`).
- **`incomingPurchaseOrders(...)`** ([evaluation.js:181](../../../src/modules/replenishments/replenishment.evaluation.js)): PO `OPEN/PARTIAL` cùng kho, còn lại = `qtyBase − cancelledRemainderQtyBase − đã nhập (GR POSTED)`.
- **`otherWarehouseOptions(...)`** ([evaluation.js:243](../../../src/modules/replenishments/replenishment.evaluation.js)): chạy `availableStock` cho từng kho khác; kho người dùng không được vào chỉ cộng vào `restrictedOtherWarehouseQtyBase`, không lộ chi tiết.

### Hàm: `checkWarnings(lines, evaluated)` và `evaluatedDetails(line, evaluation)`

[replenishment.commands.js:90](../../../src/modules/replenishments/replenishment.commands.js), [replenishment.commands.js:75](../../../src/modules/replenishments/replenishment.commands.js)

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

[replenishment.commands.js:229](../../../src/modules/replenishments/replenishment.commands.js)

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

[replenishment.commands.js:402](../../../src/modules/replenishments/replenishment.commands.js)

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

  `readRequest` ([dòng 40](../../../src/modules/replenishments/replenishment.commands.js)) = `scopedDocument` + chặn Sales/Warehouse đọc RR của người khác (trả 404 để không lộ tồn tại).

## 2.3. Bước 2 — Gửi duyệt: `submitReplenishment(user, id, input)`

[replenishment.commands.js:434](../../../src/modules/replenishments/replenishment.commands.js)

- **Vai trò:** chuyển RR đã lưu sang `SUBMITTED`.
- **Biến:** `input.evaluations[]` (tùy chọn, `{ lineId, independentNeedConfirmed, independentNeedReason }` — giải trình bổ sung lúc gửi).
- **Logic:**

  ```js
  await assessSavedRequest(document, actor, session, input.evaluations);
  document.version = input.expectedVersion + 1;
  await submission(document, actor, session);
  return { document: await saveVersion(document, input.expectedVersion, session), versionBefore: input.expectedVersion };
  ```

  `version` được tăng **trước** `submission()` để `submissions[].documentVersion` trùng với version sẽ được lưu (`saveVersion` đặt lại cùng giá trị).

### Hàm: `assessSavedRequest(document, actor, session, evaluations)` và `savedAssessmentInput(document, overrides)`

[replenishment.commands.js:198](../../../src/modules/replenishments/replenishment.commands.js), [dòng 161](../../../src/modules/replenishments/replenishment.commands.js)

- Dựng lại input từ dòng đã lưu (kèm giải trình mới trong `evaluations`), chạy lại `evaluateLines` với `strictSourceVersion: true`, rồi `checkWarnings`. Ghi đè `item.details` bằng số liệu mới.
- *Tại sao:* giữa lúc lưu nháp và lúc gửi có thể đã có PO khác về hoặc tồn thay đổi; người lập phải giải trình theo số liệu **lúc gửi**. Dòng có nguồn cũ dạng "legacy" (có `triggerType` khác `MANUAL_OTHER` nhưng không có `source`) bị chặn với thông điệp "Nguồn RR cũ cần được chuẩn hóa".

## 2.4. Bước 3 — Duyệt: `reviewReplenishment(user, id, input)`

[replenishment.commands.js:459](../../../src/modules/replenishments/replenishment.commands.js). Quyền `replenishment_request:approve`.

- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.decision` | `'APPROVE'\|'REJECT'\|'REVISE'` | Quyết định. |
| `input.reason` | string | Căn cứ chung, **bắt buộc**. |
| `input.lines[]` | `{ lineId, approvedQtyBase, reason? }` | Lượng duyệt từng dòng (đơn vị gốc). |
| `seen` | `Set` | Kiểm không trùng dòng và đủ dòng. |
| `products` | `Product[]` | Để kiểm `wholeBaseUnits`. |
| `positive` | bool | Có ít nhất một dòng > 0. |
| `itemDecisions[]` | `{ itemId, approvedQtyBase, outcome, reason }` | Ghi vào `approval_history`. |
| `approval` | `ApprovalHistory` | Bản ghi quyết định. |

- **Tương tác DB:** `Product.find`, `ApprovalHistory.save`, `saveVersion(RR)`.
- **Logic:**

  1. Tách bạch người lập và người duyệt, chỉ duyệt phiếu `SUBMITTED`:

  ```js
  if (same(document.createdBy, actor._id)) throw forbiddenError("Người duyệt phải khác người lập");
  if (document.workflowStatus !== "SUBMITTED") throw validationError("Chỉ duyệt yêu cầu đã gửi");
  ```

  Schema `approval_history` cũng có rule chặn `requestedBy == decidedBy` (trừ một luồng trả hàng đặc thù).

  2. Duyệt thì phải xét tất cả dòng; tính lượng từng dòng:

  ```js
  const quantity = input.decision === "APPROVE" ? exact(decision.approvedQtyBase) : exact("0");
  if (!product || (product.wholeBaseUnits && !quantity.isInteger())) throw validationError("Lượng duyệt phải đúng đơn vị gốc của sản phẩm");
  if (quantity.gt(String(item.qtyBase))) throw validationError("Lượng duyệt vượt lượng đề nghị");
  if (input.decision === "APPROVE" && quantity.lt(String(item.qtyBase)) && !decision?.reason?.trim())
    throw validationError("Cần lý do cho dòng duyệt giảm số lượng");
  item.approvedQtyBase = quantity.toFixed();
  ```

  *Tại sao:* Owner được cắt giảm nhưng không được tăng quá lượng xin; cắt giảm phải giải thích ở đúng dòng (quy tắc H01). Dòng duyệt `0` coi như từ chối dòng đó; nhưng duyệt mà **tất cả** bằng 0 thì bị chặn — khi đó phải chọn `REJECT`.

  3. Lưu quyết định bất biến và cập nhật RR:

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

[purchase-order.commands.js:130](../../../src/modules/purchase-orders/purchase-order.commands.js). Route `POST /api/purchase-orders` (không có `checkPermission` ở route; quyền `purchase_order:create` được kiểm trong `command()`).

- **Từ điển biến:**

| Tên biến | Kiểu | Vai trò |
|---|---|---|
| `input.warehouseId`, `input.supplierId` | ObjectId | Kho nhận, NCC. |
| `input.currency` | `'VND'` | Tiền tệ cố định. |
| `input.expectedOn` | ISO datetime? | Ngày dự kiến giao (không được trước hôm nay). |
| `input.lines[]` | `{ rrLineId, approvalId, enteredQty, unitPurchasePrice, note? }` | Mỗi dòng trỏ một dòng RR và quyết định duyệt. |
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

- **Biến:** `supplier` (`status: 'ACTIVE'`), `request` (RR duy nhất của PO), `rr`, `approval`, `source` (dòng RR), `decision` (quyết định dòng), `factor` (= `source.baseUnitsPerUnit` — **hệ số lịch sử của RR**), `amount` (lượng PO đơn vị gốc), `rounded` (có làm tròn diện tích), `value` (`unitPurchasePrice × enteredQty`, làm tròn 6 số).
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

  3. Một dòng RR chỉ có một dòng PO; lượng PO không vượt lượng duyệt:

  ```js
  if (seen.has(String(source._id))) throw validationError("Gộp lượng của cùng dòng RR");
  const amount = toBaseQuantity(line.enteredQty, factor, product, enteredUom);
  if (amount.gt(String(decision.approvedQtyBase)) || amount.lte(0) || ... ) throw validationError("Sản phẩm hoặc lượng PO vượt nguồn được duyệt");
  ```

  *Tại sao:* "One PO line per RR line: lots are split later, at inspection and receipt" — PO chưa biết lô, lô chỉ biết khi hàng đến.

  4. Dựng dòng PO bằng `copyItem(source, amount, { requestItemId, unitPurchasePrice, lineAmount, sources: [sourceLink(rr, source, amount, "REPLENISHMENT_PURCHASE")] })`.

### Hàm: `copyItem(source, quantity, overrides)` và `sourceLink(document, item, quantity, relationCode)`

[document-copy.js:9](../../../src/shared/utils/document-copy.js), [document-copy.js:5](../../../src/shared/utils/document-copy.js)

- `copyItem`: sao dòng nguồn sang chứng từ mới với `_id` mới, giữ `productId, lotId, enteredUnit, baseUnitSnapshot, baseUnitsPerUnit, productNameSnapshot, packagingSnapshot`; `enteredQty = quantity ÷ hệ số` (nếu không chia hết 6 chữ số thập phân thì chỉ chấp nhận khi dòng nguồn vốn đã làm tròn diện tích). Được dùng ở **mọi bước** sau: PO, kiểm nhận, phiếu nhập, giữ hộ, lệnh cất.
- `sourceLink`: tạo `{ documentId, subjectCollection, itemId?, linkedQty?, relationCode }` để lần ngược chuỗi chứng từ.

## 2.6. Bước 5 — Phát hành PO: `confirmPurchaseOrder(user, id, input)`

[purchase-order.commands.js:218](../../../src/modules/purchase-orders/purchase-order.commands.js)

- **Vai trò:** khóa nội dung PO và mở cho kho nhận hàng (`OPEN`).
- **Logic kiểm lại toàn bộ nguồn:**

  ```js
  if (rr?.workflowStatus !== "APPROVED" || rr.header.approvedRevision !== po.header.approvedRequestRevision)
    throw validationError("Nguồn RR đã đổi");
  ...
  if (!source || !decision || !same(source.productId, item.productId) || total.gt(String(decision.approvedQtyBase)))
    throw validationError("Nguồn duyệt PO không còn hợp lệ");
  ...
  po.workflowStatus = "OPEN";
  po.header.issuedAt = new Date();
  ```

  *Tại sao:* PO nháp có thể nằm vài ngày; trong thời gian đó sản phẩm/NCC/kho có thể ngừng hoạt động hoặc RR bị xử lý lại. Phát hành là điểm cam kết với NCC nên phải kiểm lại.

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

[purchase-core.js:9](../../../src/modules/po-receiving/purchase-core.js) — tìm theo `_id` hoặc `documentNo` trong model ứng với `kind` (`PO`, `INSPECTION`, `GR_PURCHASE`, `TO`, …); kiểm kho, riêng Kế toán ở chế độ chỉ đọc thì xem mọi kho.

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

[stock.js:17](../../../src/shared/utils/stock.js) — `WarehouseLocation.findOne({ _id, warehouseId, isActive: true })` và `locationType` phải nằm trong `kinds`; sai ⇒ "Vị trí không thuộc kho hoặc sai loại".

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
  if (destinations.length !== accepted.length || new Set(destinations.map((row) => row.inspectionItemId)).size !== accepted.length)
    throw validationError("Chọn vị trí nhập cho từng phần nhận sở hữu");
  ```

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

- **Tương tác DB:** `WarehouseLocation` (khóa + kiểm), `StocktakeLocationLock`, `GoodsInspection`, `StockHoldingPoint` (find/create), `InventoryBalance` (find/create/update có version), `ProductBatch`, `Product`, `StockTransaction.save`, `saveVersion(GR)`, `saveVersion(PO)`.
- **Logic:**

  1. Kiểm phiếu, PO, hạn mức, kiện:

  ```js
  if (receipt.workflowStatus !== "DRAFT" || !receipt.items.length) throw validationError("Phiếu không còn nháp hoặc không có lượng nhập");
  const po = await activePo(actor, receipt.header.purchaseOrderId, input.expectedPoVersion, session);
  const quantities = await purchaseOrderQuantities(po, session);
  if (quantities.some((row) => exact(row.acceptanceHeadroomQtyBase).lt(0))) throw validationError("Các phiếu nhập vượt hạn mức PO");
  checkPackagingLines(receipt, input.packaging);
  ```

  2. Khóa vị trí và mở bút toán:

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

  *Tại sao:* phiếu nhập nháp có thể bị sửa vị trí; phiếu kiểm là nguồn sự thật về lượng và chất lượng, nên đối chiếu lại tại thời điểm ghi tồn. Dòng có `custodyBalanceId` (hàng giữ hộ được chuyển thành mua) đi nhánh `postOwnedCustody` ([purchase-custody.service.js](../../../src/modules/po-receiving/purchase-custody.service.js)) — ngoài phạm vi luồng chuẩn.

  4. Kiểm sức chứa, lưu sổ cái, cập nhật phiếu và PO:

  ```js
  await verifyCapacity(locations, session);
  await posting.save({ session });
  receipt.workflowStatus = "POSTED";
  receipt.stockTransactionId = posting._id;
  ...
  po.workflowStatus = remaining.every((row) => exact(row.outstandingQtyBase).isZero()) ? "COMPLETED" : "PARTIAL";
  await saveVersion(po, po.version, session);
  ```

### Hàm: `guardLocations(ids, session)`

[stock.js:10](../../../src/shared/utils/stock.js)

```js
for (const locationId of [...new Set(ids.filter(Boolean).map(String))].sort()) {
  const location = await WarehouseLocation.findOneAndUpdate({ _id: locationId, isActive: true }, { $inc: { operationVersion: 1 } }, { session, returnDocument: 'after' });
  if (!location || !await Warehouse.exists({ _id: location.warehouseId, isActive: true }).session(session)) throw validationError('Kho hoặc vị trí đã ngừng hoạt động');
  if (await StocktakeLocationLock.exists({ locationId, status: 'LOCKED' }).session(session)) throw validationError('Vị trí đang khóa kiểm kê');
}
```

*Tại sao:* `$inc operationVersion` biến vị trí thành "khóa": hai giao dịch cùng ghi tồn vào một vị trí sẽ xung đột ghi, một bên chạy lại và thấy tồn mới (quan trọng cho kiểm sức chứa). Sắp xếp id để mọi giao dịch khóa cùng thứ tự. Vị trí đang kiểm kê thì không được động vào.

### Hàm: `beginStock(document, user, operation, input)`

[stock.js:74](../../../src/shared/utils/stock.js)

```js
return new StockTransaction({ sourceType: document.constructor.collection.name, sourceId: document._id,
  operation, eventKey: String(document.version), requestKey: hash({ user, document, operation, key: input.operationKey ?? input.idempotencyKey }),
  requestHash, performedBy: user._id, occurredAt: new Date(), recordedAt: new Date(), movements: [] });
```

*Tại sao:* unique `(sourceId, operation, eventKey)` với `eventKey = version` đảm bảo một version của chứng từ chỉ ghi sổ một lần; unique `requestKey` chặn cùng thao tác ghi hai lần.

### Hàm: `balanceAt(pointFields, source, qualityStatus, session)`

[stock.js:32](../../../src/shared/utils/stock.js)

```js
let point = await StockHoldingPoint.findOne(pointFields).session(session);
if (!point) point = await new StockHoldingPoint(pointFields).save({ session });
const fields = { holdingPointId: point._id, batchId: source.batchId, qualityStatus, ownerType: source.ownerType, ownerId: source.ownerId ?? null };
return await InventoryBalance.findOne(fields).session(session) ??
  await new InventoryBalance({ ...fields, quantityBase: '0', version: 0, packagingPortions: [] }).save({ session });
```

*Tại sao:* tồn được lưu theo khóa **(vị trí, lô, chất lượng, chủ hàng)**; balance chỉ được tạo lần đầu khi có hàng vào. Cùng lô vào cùng vị trí từ hai phiếu nhập khác nhau sẽ dồn vào **một** balance — vì thế phải theo dõi kiện theo dòng (xem `packagingPortionIds` ở bước cất).

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

[stock.js:191](../../../src/shared/utils/stock.js)

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

  *Tại sao:* sức chứa ô kệ tính theo **thể tích**; thùng nguyên tính theo kích thước thùng của lô, hàng lẻ/mở cần thể tích ước tính (`estimateVolume`, dòng 180) hoặc thực đo.

  3. Tổng kiện phải bằng lượng nhập; cộng tồn có khóa version; ghi movement chỉ có đầu `to`:

  ```js
  balance.quantityBase = before.plus(amount).toFixed();
  balance.packagingPortions.push(...received);
  await saveBalance(balance, balance.version, session);
  posting.movements.push({ transactionId: posting._id, lineNo: posting.movements.length + 1,
    packagingPortionIds: received.map(row=>row._id), sourceLineId: item._id, toBalanceId: balance._id,
    quantityBase: amount.toFixed(), toBefore: before.toFixed(), toAfter: balance.quantityBase });
  ```

  `packagingPortionIds` là chìa khóa của bước cất: nó cho biết **kiện nào thuộc dòng phiếu nhập nào** trong một balance có thể dùng chung.

### Hàm: `saveBalance(balance, beforeVersion, session)`

[stock.js:103](../../../src/shared/utils/stock.js) — `updateOne({ _id, version: beforeVersion }, { $set: { quantityBase, packagingPortions }, $inc: { version: 1 } })`; không khớp ⇒ 409 "Tồn đã thay đổi".

### Hàm: `verifyCapacity(locationIds, session)`

[stock.js:164](../../../src/shared/utils/stock.js) — nạp mọi điểm giữ hàng, balance, vị trí, kho, lô của các vị trí liên quan rồi gọi `checkBinCapacity` ([capacity.js](../../../src/models/capacity.js)). Chạy **sau** khi cộng tồn (vẫn trong transaction) nên vượt sức chứa ⇒ toàn bộ giao dịch rollback.

---

## 2.11. Bước 9 · Lập lệnh chuyển vị trí

Chi tiết phiếu mua trả `receivingBalanceId` cho dòng khớp với đích của bút toán nhập. Form BF03 lấy số dư hiện tại qua options. ID số dư có thể được dùng chung giữa các phiếu cùng lô, phẩm cấp và chủ hàng. Kiểm số lượng cần chuyển trên form trước khi lưu.

`createLocationMovement` yêu cầu `stock_relocation:create`. Service kiểm phiên bản số dư, vị trí cùng kho, lô/sản phẩm, quy cách và lượng đã giữ bởi lệnh khác. Xem [API BF03](../08_api/location-movements/README.md).

### Hàm: `pendingTaskQuantity(balanceId, session, excludeTaskId)`

[stock.js:40](../../../src/shared/utils/stock.js) — tổng `qtyBase − đã thực hiện` của mọi `TransferOrder` `OPEN/DRAFT/PARTIAL` có dòng lấy từ balance này.

### Hàm: `splitPortions(portions, quantity, actorId)`

[stock.js:83](../../../src/shared/utils/stock.js)

```js
if (remaining.gte(available)) { taken.push(portion); remaining = remaining.minus(available); continue; }
if (portion.packagingState !== 'SEALED' || portion.measuredVolumeMm3 != null || ...)
  throw validationError('Phần hàng mở/lẻ cần được đo và tách quy cách trước khi chuyển một phần');
const packs = remaining.div(String(portion.packagingSnapshot.baseUnitsPerPackage));
if (!packs.isInteger()) throw validationError('Không tự mở thùng; chọn lượng nguyên thùng hoặc phần hàng lẻ đã đo');
```

Lấy trọn kiện theo thứ tự; chỉ kiện `SEALED` được chia, và chỉ chia theo số thùng nguyên.

## 2.12. Bước 10 · Xác nhận thực chuyển

`confirmLocationMovement` yêu cầu người lập có `stock_relocation:confirm`, phiên bản lệnh hiện tại và đủ lượng của từng dòng. Service khóa các vị trí, đối chiếu lại số dư, chuyển tồn và kiểm sức chứa trong cùng transaction. Người lập có thể sửa hoặc hủy lệnh khi còn `OPEN`.

### Hàm: `moveStock(sourceId, destinationId, quantity, itemId, stockTransaction, user, session, opts)`

[stock.js:109](../../../src/shared/utils/stock.js)

- **Vai trò:** chuyển một lượng giữa hai balance **cùng lô, cùng chủ hàng**, kèm kiện và (tùy chọn) giữ hàng.
- **Từ điển biến:** `source`, `destination` (InventoryBalance), `amount`, `from`, `to` (số dư trước), `reservations`, `reserved`, `pending` (lệnh khác chưa có giữ hàng), `inPool` (lọc kiện theo `portionIds`), `split`, `kept`, `taken`, `movementId`.
- **Logic:**

  ```js
  if (!source || !destination || !same(source.batchId, destination.batchId) || source.ownerType !== destination.ownerType || ...)
    throw validationError('Không đổi lô hoặc chủ hàng khi chuyển tồn');
  if (!amount.gt(0) || amount.gt(from)) throw validationError('Không đủ tồn nguồn');
  ...
  if (amount.plus(pending).plus(preserveReservations ? '0' : reserved).plus(await heldQuantity(sourceId, session)).gt(from))
    throw validationError('Lượng chuyển thuộc phần hàng đang bị chặn');
  ...
  const split = splitPortions(source.packagingPortions.filter(inPool), amount, user._id);
  ...
  destination.packagingPortions.push(...taken);
  source.quantityBase = from.minus(amount).toFixed(); destination.quantityBase = to.plus(amount).toFixed();
  ...
  await saveBalance(source, source.version, session);
  await saveBalance(destination, destination.version, session);
  stockTransaction.movements.push({ _id: movementId, ..., sourceLineId: itemId, fromBalanceId: sourceId, toBalanceId: destinationId,
    quantityBase: amount.toFixed(), fromBefore: from.toFixed(), fromAfter: source.quantityBase, toBefore: to.toFixed(), toAfter: destination.quantityBase });
  ```

  Khi `preserveReservations`, phần giữ hàng vượt quá lượng tự do được "dời" sang balance đích: tăng `movedQty` của giữ hàng cũ, tạo `StockReservation` mới ở đích có `previousReservationId`. Schema `stock_movements` có rule `before ± quantity = after`, nên sổ cái luôn tự cân.

## 2.13. Dữ liệu biến đổi qua toàn quy trình — ví dụ số

Giả sử gạch `G60` có `baseUnit = 'viên'`, lô `L01` có `piecesPerCarton = 4`.

| Bước | Collection | Dữ liệu chính sau bước |
|---|---|---|
| Lập RR | `replenishment_requests` | `items[0] = { enteredUnit: 'Thùng', enteredQty: '10', baseUnitsPerUnit: '4', qtyBase: '40', details.availableQtySnapshot: '12' }`, `DRAFT`, v1 |
| Gửi | `replenishment_requests` | `SUBMITTED`, v2, `submissions[0].documentVersion = 2` |
| Duyệt giảm | `approval_history` + RR | `itemDecisions[0].approvedQtyBase = '32'` (có lý do dòng); RR `APPROVED`, v3, `approvedRevision = 2` |
| Lập + phát hành PO | `purchase_orders` | `items[0] = { qtyBase: '32', requestItemId: RR.items[0]._id }`, `OPEN` |
| Kiểm nhận | `goods_arrivals`, `goods_inspections` | Dòng 1: lô `L01`, 7 thùng = 28 viên, `GOOD/ACCEPT/SEALED`; dòng 2: 3 viên, `GOOD/ACCEPT/LOOSE` |
| Xác nhận kiểm | `goods_receipts` | GR `DRAFT` hai dòng (28 + 3), `destinationLocationId = R-01` (RECEIVING). Headroom PO = 32 − 31 = 1 |
| Ghi tồn | `inventory_balances`, `stock_transactions` | Balance (R-01, L01, GOOD, STORE): `quantityBase` 0 → 31, kiện `[SEALED×7=28, LOOSE 3]`; 2 movement `to`. PO `PARTIAL` (còn 1) |
| Lập lệnh chuyển | `transfer_orders` | TO `RELOCATE` ở `OPEN` chuyển 31 viên từ R-01 đến A-01-01 |
| Xác nhận chuyển | `inventory_balances`, `stock_transactions` | R-01 còn 0 viên, A-01-01 tăng 31 viên, TO `CONFIRMED` |

Sau bước cuối, 31 viên mới được `availableStock()` của RR tính là "tồn khả dụng" (vì nằm ở `STORAGE`, `isPickable`).

---

# Phần 3 — Các điểm cần lưu ý / Rủi ro tiềm ẩn

Các điểm dưới đây rút ra từ đọc code, **chưa** được kiểm bằng test riêng trong lượt viết tài liệu này.

### 3.1. Giao dịch và đồng thời

1. **Mọi lệnh ghi đều trong một transaction** (`command → transaction`), kể cả cập nhật nhiều collection (chứng từ, tồn, sổ cái, biên nhận, audit). Không phát hiện chỗ nào ghi DB mà quên `session` trong các hàm của luồng này. Ngược lại, các hàm **đọc** như `locationMovementOptions`, `inspectionContext`, `requireEditableRequest` chạy không có session — chỉ phục vụ hiển thị, số liệu có thể cũ ngay sau khi trả về; lệnh ghi luôn kiểm lại.
2. **`withTransaction` có thể chạy lại `work` nhiều lần** khi xung đột ghi. Code trong `work` hiện không có tác dụng phụ ngoài DB, nhưng nếu sau này thêm gửi email/gọi API bên ngoài vào trong `work` thì sẽ bị gửi trùng. Dùng `SystemEvent` (outbox) thay vì gọi trực tiếp.
3. **Vòng `for` trong `command()` không bao giờ lặp lại** ([document-command.js:88](../../../src/shared/utils/document-command.js)): nhánh `catch` hoặc `return` replay hoặc `throw`. Biến `attempt` vô tác dụng; việc thử lại thật sự nằm trong `transaction()`. Không sai, nhưng dễ gây hiểu nhầm khi đọc.
4. **Tạo `StockHoldingPoint`/`InventoryBalance` lần đầu đồng thời**: hai giao dịch cùng ghi tồn lần đầu vào cùng (vị trí, lô) có thể cùng `new ...().save()` ⇒ một bên lỗi 11000 trên unique index của balance. `transaction()` chỉ tự thử lại 11000 khi khóa là **mã phiếu**; `command()` chỉ cứu 11000 khi đã có biên nhận. Thực tế `guardLocations` (tăng `operationVersion` của vị trí) chạy trước nên phần lớn trường hợp đã xung đột ghi và được thử lại; nhưng `confirmLocationMovement` khóa cả vị trí đích nên an toàn, còn mọi luồng khác tạo balance mà không khóa vị trí trước sẽ có rủi ro này. Người dùng có thể nhận lỗi 500/409 và phải bấm lại.
5. **Khóa lạc quan theo `version` có ở mọi chứng từ và mọi balance**; FE bắt buộc gửi `expectedVersion`, `expectedPoVersion`, `sourceBalanceVersion`. Một thao tác bị 409 phải tải lại dữ liệu; gửi lại cùng `operationKey` sau khi tải lại sẽ bị coi là **payload khác** (vì `expectedVersion` đổi) ⇒ cần sinh `operationKey` mới.

### 3.2. Toàn vẹn số liệu

6. **Kiểm nhận nháp không giữ hạn mức PO.** Nhiều phiếu kiểm nháp có thể cùng vượt lượng PO; chỉ phiếu xác nhận sau mới bị chặn "Tổng nhận vượt phần PO còn được nhận". Đây là thiết kế có chủ đích (nháp không cam kết), nhưng thủ kho có thể đếm xong mới biết bị vượt.
7. **Dòng `GOOD` + `REJECT`** được chấp nhận ở `prepare()` nhưng ở `confirmInspection()` không đi vào phiếu nhập hay giữ hộ. Nếu hàng bị từ chối nhưng thực tế vẫn nằm trong kho (chờ NCC lấy), nó **không có trong tồn**, không chiếm sức chứa và không ai theo dõi được ngoài phiếu kiểm.
8. **Hàng ở bãi tiếp nhận không được tính "tồn khả dụng"** cho đánh giá RR (`availableStock` chỉ lấy `STORAGE` + `isPickable`). Trong khoảng từ ghi tồn đến cất hàng, hệ thống có thể cảnh báo thiếu hàng dù hàng đã về — nhưng cảnh báo `INCOMING_PO` cũng biến mất khi PO `COMPLETED`. Hệ quả: một RR mới lập trong khoảng này có thể không nhận cảnh báo nào.
9. **`submission()` ghi `conversionVersion: document.version`** ([replenishment.commands.js:245](../../../src/modules/replenishments/replenishment.commands.js)) — đây là version của phiếu RR, không phải version của bản ghi `Conversion`. Ai đọc ảnh gửi duyệt nên dựa vào `conversionSnapshot` (= `baseUnitsPerUnit`), không dựa vào `conversionVersion`.
10. **`reviewReplenishment` với `REJECT`/`REVISE`** đặt `approvedQtyBase = '0'` cho mọi dòng và ghi `itemDecisions` với `outcome = 'REJECT'/'REVISE'`. Sau khi sửa và gửi lại, giá trị `0` cũ vẫn nằm trên dòng cho tới lần duyệt kế tiếp; nơi đọc nên dựa vào quyết định `APPROVE` của đúng revision (như README RR mô tả), không dựa vào `approvedQtyBase` khi phiếu chưa `APPROVED`.
11. **`reviewedContent: document.toObject()`** được chụp **sau** khi đã gán `item.approvedQtyBase`, nên "nội dung đã duyệt" chứa sẵn lượng duyệt mới chứ không phải đúng trạng thái trước quyết định. Ảnh trước quyết định nằm ở `submissions[]`.
12. **Lượng PO dùng hệ số của RR** (`source.baseUnitsPerUnit`), không tra lại bảng quy đổi. Nếu quy đổi m² ↔ viên thay đổi sau khi duyệt RR, PO vẫn dùng hệ số cũ — đúng với nguyên tắc "giữ quy đổi lịch sử trên dòng chứng từ", nhưng kế toán cần biết khi đối chiếu với báo giá NCC.
### 3.3. Kiểm tra null/undefined và đầu vào

13. `prepare()` truy cập `item.packagingSnapshot.baseUnitsPerPackage` cho dòng `SEALED`; an toàn vì `lotId` là bắt buộc nên `makeItem` luôn tạo `packagingSnapshot`. Nếu sau này cho phép kiểm không có lô, dòng này sẽ lỗi.
14. `createPurchaseOrder` không có `checkPermission` ở tầng route; quyền chỉ được kiểm trong `command()`. Kết quả tương đương, nhưng request thiếu quyền vẫn chạy hết validate Zod trước khi bị 403.
15. Cấp mã phiếu quét toàn bộ `_id` cùng tiền tố trong ngày bằng regex (`$in: [RegExp]`) mỗi lần tạo phiếu. Với lượng phiếu lớn trong một ngày/kho, chi phí tăng tuyến tính; số trùng được xử lý bằng thử lại tối đa 20 lần.

### 3.4. Tách bạch trách nhiệm

16. RR: người duyệt ≠ người lập (kiểm ở service và rule schema `approval_history`). PO, kiểm nhận, ghi tồn, cất hàng **không** có ràng buộc người khác người: cùng một người có quyền `goods_receipt_inspection:update` và `:post` có thể vừa kiểm vừa ghi tồn; lệnh cất gán `assignedTo` là chính người lập lệnh. Đây là hiện trạng code, không phải quyết định nghiệp vụ được ghi trong tài liệu này.

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
| Model | [src/models/](../../../src/models/) |
