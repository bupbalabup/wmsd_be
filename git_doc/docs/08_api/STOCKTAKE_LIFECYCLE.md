# Vòng đời kiểm kê BF-05 — hợp đồng API native (13/11/2026)

Nguồn yêu cầu: luồng "Inventory Audit Process — To-Be" do người dùng cung cấp (Owner lập kế hoạch → Warehouse Staff đóng băng, đếm mù, đối chiếu → tạo phương án khi lệch → Owner duyệt độc lập → Staff ghi thực hiện → Owner chốt) và các bảng review 28/29. Quyết định bổ sung ngày 13/11/2026: **hàng đếm thực tế nhưng chưa có trong sổ (found-not-in-book) thuộc phạm vi lần triển khai này**. Chốt kiểm kê UC-93 giữ nguyên logic ghi sổ; xem [HIEUDT_ITERATIONS_NATIVE.md](HIEUDT_ITERATIONS_NATIVE.md).

Mọi endpoint nằm dưới `/api/stocktakes`, dùng `Authorization: Bearer`, body strict (khóa lạ bị từ chối 400) và nhận `idempotencyKey` (+ `expectedVersion` khi sửa chứng từ có sẵn). Mã đợt là định danh chứng từ `KK-<kho>-YYMMDD-<số>` (dấu nối liền từ 12/11/2026; API vẫn nhận mã cũ có dấu cách); phương án là `PAXLKK-…` (xem [DOCUMENT_IDENTITIES.md](DOCUMENT_IDENTITIES.md)). Phản hồi lệnh: `{ id, version, workflowStatus, operationId, decisionId?, resultRefs, replayed }`; `resultRefs[]` chỉ gồm `documentType`, `documentId`, `itemId?`, `revision?` (đếm → `stocktakes` + `itemId` = mã lần đếm + `revision` = lần thứ; phương án → `stocktake_resolution_plans` + `revision` = phiên bản). **Đối chiếu không trả danh sách chênh lệch trong phản hồi**: bên đọc tính từ `GET /stocktakes/:id` (`snapshots`, `counts`, `header.selectedCounts`; chênh lệch = `countedQtyBase − bookQtyBase`).

## Verification and number allocation follow-up (16 November 2026)

Embedded resolution plans retain ObjectId identities while `documentNo` stores their `PAXLKK` number. The allocator now scans both embedded identity fields, instead of restarting the sequence when only ObjectId `_id` values are present. Existing numbers are not rewritten; no schema, index or migration is introduced. See [DOCUMENT_IDENTITIES](DOCUMENT_IDENTITIES.md) for the concurrency limits.

The lifecycle integration suite passed 5/5 and the native iterations suite passed 11/11 after this change on an isolated loopback replica set. The resolution integration suite is **not green**: its number-uniqueness TODO assertion now succeeds, but its text-filter assertion at `test/stocktake-resolution.integration.test.js:241` fails because literal substring search also matches a plan number containing the requested stocktake number. Search behavior and test files were not changed to hide this failure. Default `npm test` exits zero but skips opt-in integration tests; it is not evidence that this failure is resolved. Full frontend lint also fails. The sole independent reviewer accepted the allocator delta with notes and found no new production issue, but blocked overall BF-05 acceptance because required checks and mobile command verification remain incomplete. Completion and archive remain blocked.

Browser verification exercised both close paths with the real local API and synthetic local data. Execution attachment metadata was inserted into the disposable visual database because no stocktake evidence upload/attach endpoint exists. This proves ID-reference validation, not file storage or upload. Mobile verification covered completed detail/list layout only, not every command form.

## Trạng thái và quyền

`PLANNED → COUNTING → RECONCILING → PENDING_APPROVAL → APPROVED → IN_PROGRESS → COMPLETED` (từ chối phương án quay về `RECONCILING`; không chênh lệch thì chốt thẳng từ `RECONCILING`). Quyền theo vai trò seed: Owner `stocktake:create`, `stock_adjustment:approve`, `stock_adjustment:post`; Warehouse Staff `stocktake:update`, `stocktake:reconcile`, `stock_adjustment:create`, `stock_adjustment:update`. Mọi lệnh còn kiểm tra kho được giao, trạng thái, version, và với đếm/đối chiếu/phương án/thực hiện: nhân viên phải nằm trong `header.assignedCounterIds`.

| Lệnh | Endpoint | Quyền | Hiệu lực |
|---|---|---|---|
| Danh sách (UC-93) | `GET /` | `stocktake:read` | Chỉ đọc. Owner thấy mọi kho, vai trò khác chỉ kho được giao. Query strict (khóa lạ, id/ngày sai hoặc `from` > `to` → 400): `warehouseId` (ngoài phạm vi → bị chặn), `status`, `locationId` (đợt có vị trí này trong `header.scopeLocationIds`), `from`/`to` (ISO, bao gồm hai đầu, lọc theo `header.cutoffAt` nên đợt `PLANNED` chưa có cutoff bị loại khi có khoảng cutoff), `q` (mã đợt, khớp nguyên văn, không phân biệt hoa thường), `page`, `limit` ≤ 100. Mặc định sắp xếp `createdAt` giảm dần; `total` khớp tập đã lọc. Không thêm index mới. |
| Tùy chọn lập kế hoạch | `GET /options` | `stocktake:create` | Kho, vị trí, nhân viên có quyền đếm trong kho. |
| Lập kế hoạch | `POST /` | `stocktake:create` | Tạo `PLANNED` (version 1), phạm vi ≥1 vị trí, không đổi tồn, không khóa. |
| Sửa kế hoạch | `POST /:id/update` | `stocktake:create` | Chỉ `PLANNED`, đúng version; đổi phạm vi tăng `scopeVersion`. |
| Kích hoạt | `POST /:id/activate` | `stocktake:update` (người được giao) | Một transaction: tăng `operationVersion` mọi vị trí, từ chối nếu còn giữ chỗ/nhiệm vụ/hold hoặc vị trí đã bị đợt khác khóa, chụp snapshot `BOOK` cho từng balance, khóa **mọi** vị trí kể cả trống → `COUNTING`. Thua tranh chấp thì rollback toàn bộ. |
| Ghi số đếm | `POST /:id/counts` | `stocktake:update` (người được giao) | Chỉ `COUNTING`; chỉ ghi thêm (append-only). Đếm lại cần `previousCountId` (lần mới nhất) và `recountReason`. |
| Đối chiếu | `POST /:id/reconcile` | `stocktake:reconcile` (người được giao) | Cần mọi snapshot có lần đếm mới nhất và mọi vị trí không có snapshot có xác nhận trống = 0; lưu `header.selectedCounts` → `RECONCILING`. Không ghi tồn, không mở khóa. |
| Trình phương án | `POST /:id/resolution-plans` | `stock_adjustment:create` | Chỉ khi có lệch; gắn `scopeVersion` và đúng `selectedCounts`; dòng `DELTA`/`RECLASS`/`RELOCATE` không vượt chênh lệch; → `PENDING_APPROVAL`. Không cần phương án nếu mọi dòng khớp (bị từ chối nếu nộp). |
| Duyệt/từ chối | `POST /:id/resolution-plans/:planId/review` | `stock_adjustment:approve` | Đúng `expectedPlanVersion`; người lập không tự duyệt; lưu `approval_history` với nội dung đã duyệt (hash đối chiếu khi chốt). Duyệt không ghi tồn. |
| Ghi thực hiện | `POST /:id/resolution-plans/:planId/executions` | `stock_adjustment:update` (người được giao) | Sau khi duyệt; không vượt lượng dòng; bằng chứng phải là `Attachment` `ATTACHED`, thuộc đợt/phương án và do chính người ghi tải lên. Không ghi tồn. |
| Chốt | `POST /:id/close` | `stock_adjustment:post` | UC-93: chỉ chốt khi đã đối chiếu và `selectedCounts` khớp `header.selectedCounts`; không lệch → không cần phương án, không tạo phiếu điều chỉnh; có lệch → phương án được duyệt độc lập, đủ thực hiện. Ghi sổ một lần, mở khóa cùng transaction; lỗi thì giữ nguyên khóa. |

## UC-94 detail read metadata (15 November 2026)

`GET /api/stocktakes/:id` requires `stocktake:read` and warehouse access before any related-record lookup. The response retains the native document plus `snapshots`, `counts` (descending `attemptNo`) and `locks` for its current `scopeVersion`. It additionally returns `lookups` with allowlisted catalogue projections:

- `warehouses[]`: `{ id, code, name }` for the record warehouse.
- `locations[]`: `{ id, warehouseId, code, name }` for `header.scopeLocationIds`, constrained to that warehouse.
- `batches[]`: `{ id, productId, manufacturerLot }` referenced by those snapshots.
- `products[]`: `{ id, sku, name }` referenced by those batches.

These are current catalogue labels, not historical product-name/unit snapshots. Missing catalogue references are omitted; callers retain the stable snapshot/reference identity and display unavailable labels. No `inventory:read` permission, inventory-options request or current balance lookup is needed. This read performs no stock/workflow writes and adds no schema, index or migration.

The frontend displays stored `header.cutoffAt` and `snapshot.baseUnitSnapshot`; it never substitutes current balances, current base units or current conversion factors. Exact decimal variance uses the explicitly selected attempt in `header.selectedCounts`; the latest attempt is a fallback only when that snapshot has no selection. Missing book quantities and invalid selections are not zero or a match. History displays recorded attempts, timestamps, recount reasons and condition notes without evidence-download URLs. Empty-location confirmations remain distinct from stock snapshot counts.

**Blind-count limitation is unchanged:** the server still returns book quantities to stocktake readers during `COUNTING`. Frontend detail transformation removes these values before caching and hides book/variance throughout the view and history. This is presentation/cache protection, not server-side redaction.

Verification: `node --test test/stocktake-detail.test.js` covers stocktake-only readers, owner/warehouse authorization, missing references, empty snapshots and no current-balance query with mocked Mongoose models. It does not prove live MongoDB query execution or transactional isolation.

## Resolution request reads (UC-100, UC-101; 15 November 2026)

Resolution plans stay sub-documents of the stocktake (`resolutionPlans`, `ST_RESOLUTION`); there is no separate request collection and nothing is written. Both reads require `stock_adjustment:read` and use the same warehouse scope as the stocktake list: the Owner sees every warehouse, other roles only assigned warehouses. Both are registered before `GET /:id`.

**`GET /api/stocktakes/resolution-plans`** — one row per plan version. Strict query (unknown key, malformed id or unknown status -> 400), every filter optional and combined:

| Query | Rule |
|---|---|
| `warehouseId` | 24-hex id; a warehouse outside the actor's scope -> 403 (not an empty list) |
| `stocktakeId` | stocktake identity (document number or historical 24-hex id) |
| `lotId` | 24-hex `ProductBatch` id, matched on the plan line's `lotId` |
| `locationId` | 24-hex location id; the stocktake must have it in `header.scopeLocationIds` and a line must touch it through its selected count (`details.countId`) or a balance endpoint (`fromBalanceId`/`toBalanceId`) resolving to a snapshot at that location. Lot and location must hold on the same line |
| `status` | plan status: `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `EXECUTED`, `CLOSED`, `CANCELLED` |
| `q` | 1-80 chars, literal case-insensitive match on the plan number or the stocktake number |
| `page`, `limit` | default 1 and 20, `limit` <= 100 |

Sorted by `proposedAt` descending. Response `data`: `{ items, total, page, limit, lookups }` with `items[]`: `{ id, documentNo, planVersion, workflowStatus, reason?, proposedBy, proposedAt, scopeVersion, lineCount, stocktakeId, stocktakeNo, stocktakeStatus, warehouseId }` and `lookups`: `{ warehouses: [{ id, code, name }], users: [{ id, username, fullName }] }` for the rows returned. `reason` is omitted when absent. `proposedBy`/`proposedAt` fall back to `createdBy`/`occurredAt` for plans stored without them.

**`GET /api/stocktakes/resolution-plans/:planId`** — `:planId` is the 24-hex plan `_id` (the same id the review and execution commands take). Unknown plan -> 404, warehouse outside the scope -> 403, before any related read. Response `data`:

- `plan`: `{ id, documentNo, workflowStatus, version, planVersion, scopeVersion, previousPlanId, reason, note, createdBy, proposedBy, proposedAt, approvalId, closureBatchId, closedBy, closedAt, items[], selectedCounts[], reviewDecisions[], executionRecords[] }`.
- `plan.items[]`: `{ id, lineNo, productId, lotId, productNameSnapshot, baseUnitSnapshot, qtyBase, executedQtyBase, details: { actionKind, deltaQty, countId, fromBalanceId, toBalanceId, holdId }, snapshotId, fromSnapshotId, toSnapshotId, variance }`. `variance` is `{ locationId, qualityStatus, baseUnit, bookQtyBase, countedQtyBase, differenceBase }` computed with exact decimals (`differenceBase = countedQtyBase - bookQtyBase`) from the frozen snapshot and the selected count, or `null` when either record can no longer be resolved; it is never replaced by a zero.
- `plan.reviewDecisions[]`: `{ decisionId, revision, reviewedBy, reviewedAt, decision, reason }`. `plan.executionRecords[]`: `{ itemId, performedBy, performedAt, quantityBase, transactionId, note, evidence[] }` where `evidence[]` is `{ id, available: true, status, originalName, mediaType }` or `{ id, available: false }` for a reference that no longer resolves. No download URL is returned.
- `stocktake`: `{ id, documentNo, workflowStatus, version, header: { warehouseId, scopeVersion, scopeLocationIds, plannedAt, cutoffAt, activatedAt, completedAt } }`.
- `versions[]`: `{ id, documentNo, planVersion, workflowStatus }` for every plan of the stocktake, ascending by `planVersion`.
- `snapshots[]` and `counts[]`: only the records referenced by the plan lines, for the plan's own `scopeVersion` (`snapshots`: `{ id, locationId, batchId, sourceBalanceId, ownerType, ownerId, qualityStatus, bookQtyBase, baseUnitSnapshot, origin }`; `counts`: `{ id, snapshotId, locationId, targetType, attemptNo, countedQtyBase, baseUnitSnapshot, countedBy, countedAt }`).
- `lookups`: `{ warehouses, locations (with warehouseId), batches, products, users }` with the same projections as the detail read plus `users: [{ id, username, fullName }]`. References missing from the catalogue are omitted; callers keep the identity and show it as unavailable.

Neither read creates, decides, posts or unlocks anything; proposing, approving, executing and closing stay on the stocktake commands above. No schema, index, seed or migration was added: the list filters before unwinding the embedded plans, and an index request is raised only if it proves slow on real data. Verification: `node --test test/stocktake-resolution-list.test.js test/stocktake-resolution-detail.test.js` with mocked Mongoose models (scope, permission, filters, exact decimals, refusals, no write call); it does not prove live MongoDB aggregation or timing.

## Count sheet read (UC-121; 15 November 2026)

`GET /api/stocktakes/:id/count-sheet` returns the data for a printable, blind count sheet built from the activation snapshot. It requires `stocktake:export` (seeded for Owner and Warehouse Staff) and checks, in order: permission, existence (404), warehouse access (403 `ERR-CORE-403-002`), counter assignment (403 `ERR-CORE-403-001`; the Owner is exempt) and activation (400 when `header.activatedAt` is missing, i.e. a `PLANNED` session that has no snapshot). An activated session is allowed in any later status.

Response `data`:

- `stocktake`: `{ id, documentNo, workflowStatus, scopeVersion, cutoffAt, activatedAt }`; `warehouse`: `{ id, code, name }`; `counters[]`: `{ id, username, fullName }`.
- `locations[]` (every location of `header.scopeLocationIds`, sorted by location code): `{ locationId, code, name, rows[], emptyConfirmation }`. `emptyConfirmation` is `true` exactly when the location had no snapshot entry at cutoff; its `rows` is empty and the sheet shows a line to confirm it is empty.
- `rows[]`: `{ snapshotId, productId, sku, productName, batchId, manufacturerLot, qualityStatus, ownerType, ownerId, owner: { code, name } | null, baseUnit }`, sorted by SKU then lot. `owner` is resolved for supplier- and customer-owned stock only. Missing catalogue labels are `null`.

**Blind contract.** The response never contains `bookQtyBase`, a variance or any count: the service does not select the book quantity from the database and does not read counts, locks or current balances. Only `origin: BOOK` snapshots of the current `scopeVersion` are listed, so stock moved after cutoff still shows what was frozen and items found during counting are not printed. The blank count and note cells, the confirmation line for empty locations and the blank rows for newly found items are layout decisions of the client, not response fields. The read changes no count, status, version, lock or stock, so printing twice yields the same data.

Limitation: unlike this read, `GET /stocktakes/:id` still returns book quantities to `stocktake:read` holders during `COUNTING` (see Limits below). Verification: `node --test test/stocktake-count-sheet.test.js` (mocked models: each refusal, empty-location rows, absence of book quantity, no write or count/lock/balance read).

## Hàng phát hiện ngoài sổ (found-not-in-book)

`POST /:id/counts` với `targetType: "STOCK"`, **không** `snapshotId`, kèm:

```json
{ "discovered": { "locationId": "…", "batchId": "…", "ownerType": "STORE|SUPPLIER|CUSTOMER", "ownerId": "… (bắt buộc nếu không phải STORE)", "qualityStatus": "GOOD|…" },
  "countedQtyBase": "8", "evidenceIds": ["<attachmentId>"] }
```

Đúng một trong `snapshotId` hoặc `discovered` (hoặc `targetType: "EMPTY_LOCATION"` + `locationId`). Backend tạo snapshot `origin: "DISCOVERED"` với `bookQtyBase = 0`, `discoveredBy/At`, kèm `InventoryBalance` số lượng 0 tại vị trí (và `sourceBalanceId` của snapshot trỏ tới nó) để phương án/duyệt/chốt xử lý như mọi snapshot khác; không đổi logic ghi sổ UC-93. Từ chối khi: vị trí ngoài phạm vi hoặc đã xác nhận trống; bộ định danh (vị trí, lô, chất lượng, chủ hàng) đã có snapshot sổ (phải đếm theo mốc); đã có số dư dương cho bộ định danh; lô không `VERIFIED`/sản phẩm ngừng hoạt động/ngoài bộ lọc lô-sản phẩm của đợt; số lượng không dương; thiếu hoặc sai bằng chứng; sản phẩm nguyên đơn vị gốc mà số lượng không nguyên. Đếm lại cùng bộ định danh dùng lại snapshot đã phát hiện.

Giới hạn đã biết của hợp đồng hiện hành (không phải thay đổi mới): chốt từ chối hai `DELTA` ngược dấu trên cùng lô + chủ hàng (phải dùng `RECLASS`/`RELOCATE`); không tự mở thùng nên `DELTA` giảm phải là bội số nguyên thùng nếu không kèm quy cách đo; `DELTA` tăng của hàng lẻ cần `packaging` khi chốt.

## Giới hạn và điểm chưa quyết

- **Đếm mù chỉ được thực thi ở UI.** `GET /stocktakes/:id` vẫn trả `bookQtyBase` cho người có `stocktake:read` ở mọi trạng thái; màn nhập đếm frontend xóa số sổ khỏi cache khi `COUNTING`. Muốn chặn ở máy chủ cần quyết định riêng về redaction theo vai trò/trạng thái.
- **Chưa có API tải bằng chứng cho kiểm kê.** `evidenceIds` phải là `Attachment` đã `ATTACHED` với `ownerDocumentId` là mã đợt (hoặc phương án) và `uploadedBy` là người thao tác. Hiện frontend cho dán mã tệp; các module khác (mua hàng, đổi trả) có luồng upload riêng. Cần quyết định kho lưu trữ và endpoint upload/attach cho kiểm kê.
- Hủy/abort đợt đang khóa và mở lại đợt sau đối chiếu chưa có quy trình được duyệt; không tự mở khóa.

## Kiểm chứng

`test/stocktake-lifecycle.integration.test.js` (bật `RUN_STOCKTAKE_LIFECYCLE_TESTS=1`, replica set cô lập `127.0.0.1:27018/hieudt-test`, DB `stocktake_lc_test_<ObjectId>` bị drop khi kết thúc) kiểm: lập kế hoạch Owner-only, kích hoạt đóng băng và khóa kể cả vị trí trống, đếm chỉ-ghi-thêm/đếm lại/trễ, bao phủ đủ khi đối chiếu, hàng phát hiện ngoài sổ (bằng chứng, trùng sổ, ngoài phạm vi), phương án (sai chiều/vượt), duyệt độc lập (người lập, version cũ, từ chối + trình lại), thực hiện (vượt, sai người tải), chốt có lệch ghi sổ đúng một lần + phát hiện thành tồn thật, chốt không lệch không phiếu điều chỉnh, kích hoạt đồng thời hai đợt chồng vị trí (một thắng), và DTO HTTP strict. Kết quả thực từng lần chạy ghi ở [change_logs](../../change_logs.md).
