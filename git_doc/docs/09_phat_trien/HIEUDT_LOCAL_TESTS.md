## Stocktake follow-up checks — 22/11/2026 (lot unit, lock-aware options, plan timezone, cancelled slips)

Isolated `hieudt-mongo` (`mongo:8.0`, replica set `hieudt-test`, `127.0.0.1:27018`; Colima had to be restarted and the stopped container started). No test file was added. Proof script (not committed): a throw-away database created, indexed with `createIndexes()` for every model and dropped afterwards; 29 checks passed — `GET /lots` unit fields, locked vs unlocked location in the location-movement, transfer (stock and locations), sales, direct-sales and return-workflow options plus `lookup?kind=balances` for the Warehouse role, an all-permission role and Sales, lock release by cancelling the slip, Asia/Ho_Chi_Minh schedule anchors (840 occurrences identical to the old UTC results for the `08:00+07` payload), generate → cancel → regenerate the same period (replay, refusal, index backstop for PLANNED/COUNTING, extra CANCELLED allowed) and a misplaced lot pair (A 8→4, B 4→8) posted by `approve-differences` as a separate decrease and increase.

Existing tests adjusted: `test/movement-projections.test.js`, `test/transfer-read-performance.test.js` (mock `StocktakeLocationLock.find`). Suites run on 27018, one flag per command with `--test-concurrency=1`: `RUN_STOCKTAKE_LIST_TESTS` 3/3, `RUN_STOCKTAKE_LIFECYCLE_TESTS` 4/4, `RUN_STOCKTAKE_RESOLUTION_TESTS` 7/7, `RUN_GOODS_ISSUE_TESTS` (goods-issues 4/4, direct-sales 1/1), `RUN_RELOCATION_PARTIAL_TESTS` 1/1, `RUN_HIEUDT_TESTS` (hieudt-iterations 10/10), `RUN_RETURNS_NATIVE_TESTS`+`RUN_HIEUDT_TESTS` (return-workflows 20/20), `RUN_NATIVE_API_TESTS`+`RUN_HIEUDT_TESTS` (native-api 28/28). `RUN_HIEUDT_SCOPE_TESTS` 4/5: the transfer test "UC53–56/120 dispatch reserves once…" fails at `createRequirement` with `Nguồn đã có yêu cầu nội bộ` (`transfer-write.service.js`, a path this change does not touch). Not runnable here: `lots`, `replenishment-warnings` (hard-coded 27017 `rs0`) and `return-lookups` (27028). `npm test`: 403 tests, 272 pass, 0 fail, 131 opt-in skipped.

## Stocktake redesign checks — 22/11/2026

Docker `hieudt-mongo` was recreated on 22/11/2026 with the command above (`mongo:8.0`, `--ulimit nofile=64000:64000`, replica set `hieudt-test` on `127.0.0.1:27018`). Existing opt-in suites were edited for the retired plan workflow (no new test file): `RUN_STOCKTAKE_LIFECYCLE_TESTS=1 test/stocktake-lifecycle.integration.test.js` 4/4, `RUN_STOCKTAKE_RESOLUTION_TESTS=1 test/stocktake-resolution.integration.test.js` 7/7 (historical plans are seeded straight into the document and only the read paths are tested), `RUN_HIEUDT_TESTS=1 test/hieudt-iterations.integration.test.js` 10/10; `npm test` 272 pass, 0 fail, 131 skipped. The new flows (plan create/generate/idempotency, recount, partial approve, locks) were proved by a throw-away script outside the repository against a random database on the same replica set, dropped afterwards (38 checks); it is not a repository test. Opt-in suites that need the rs0 replica on port 27017 were not run (they fail identically before and after the change).

## BF03 multiple trips — 17/11/2026

User approves partial confirmations on the same relocation. Local transaction command: set RUN_RELOCATION_PARTIAL_TESTS=1, run `node test/location-movement-partial.integration.test.js`, then unset the flag. Test creates guarded random relocation_partial_test_<ObjectId> on localhost27018/hieudt-test, batches collection setup, checks creator/scope,16+24trip completion, same-balance multi-line selection, replay/stale/concurrent commands, freeze/capacity rollback, remainder-only cancellation, pending quantities and unchanged warehouse totals; exact DB is dropped after the run. Final run1/1passed,0skip. Validation unit cases cover PARTIAL filters and positive unique actual lines.

FE19/19related tests passed (live location-moves + MovementList); typecheck, changed-file ESLint and build passed. Default BE152pass/0fail/108integration skips. Browser fixture relocation_partial_review_<ObjectId> on the same loopback instance uses API3002/FE3336, synthetic Warehouse Staff and48pieces: LCV-PART-261117-000001 completed16+24, LCV-PART-261117-000002 moved4then cancelled the remaining4, resulting source4/destination44 and exactly3ledger trips. Desktop1440/mobile390captured. Unstarted second fixture was revised through the normal OPEN edit service against current stock version before its first trip. No shared/Atlas writes or schema migration. Fresh finish reviewer returned ship for the extension; all10provided captures were valid. Exact fixture DB, temporary API3002/FE3336, script and browser tab were removed. Existing local previewAPI3001/FE3334 retained. No commit/push for this follow-up.

## Goods Issue manual requests and carton opening — 17/11/2026

Current contract: [UC69–72](../08_api/GOODS_ISSUES.md). Existing documents need no backfill. Target MONGODB_URI deliberately, then run `npm run seed:goods-issue-permissions`: additive Sales create/update, Owner approve, Warehouse update; preserves custom grants. Applied only to wmsd_hieudt_local_20261111 at localhost27018/hieudt-test (modifiedRoles3, replay0); no remote write.

Isolated tests: set RUN_GOODS_ISSUE_TESTS=1, then `node --test test/goods-issue-validation.test.js test/goods-issues.integration.test.js test/outbound-carton-opening.test.js`; unset the flag afterwards. GI fixtures use guarded random goods_issue_test_<ObjectId> databases on loopback27018/hieudt-test, never application MONGODB_URI. The manual scenario includes1.5BOX×4=6PIECE, no-SO approval, opening/picking/posting, scope and concurrent identities. Unit cases check exact residuals, loose-first reuse and capacity bounds. Integration runs with60/300second limits timed out in this final environment; do not count cancelled cases as passes. Final post-merge separate run: `RUN_GOODS_ISSUE_TESTS=1 node test/goods-issues.integration.test.js` completed4/4pass,0skip in170.3seconds; default BE151pass/0fail/107skip, focused validation/opening/inbound-volume8/8pass.

FE command: `npx vitest run --pool=threads --maxWorkers=2 src/features/goods-issues/pages.test.tsx src/shared/components/CartonQtyInput.test.tsx src/features/sales-execution/pages.test.tsx src/features/transfers/live/TransferFlowPage.test.tsx src/features/return-workflows/commandQuantities.test.ts src/features/return-workflows/QuantityProgressTable.test.tsx src/features/return-workflows/usability.test.tsx src/features/return-workflows/pages.test.tsx src/app/routeAccess.test.ts`. Pre-merge result51pass/1known baseline pagination failure. Typecheck/build/changed-file lint passed before final UI copy/label fixes; post-merge54/54related tests, build/typecheck and changed-file lint pass. Fresh UI reviewer scored all three requested fixes resolved (ship at that scope).

Browser fixture goods_issue_request_review_<ObjectId> uses separate API3002/FE3336. PXB-GI-TEST-261116-000001 approval kept same ID with no SO/reservations/ledger. PXK-GI-TEST-261116-000001 posted6PIECE from1.5BOX once;10pieces remain (8sealed+2open with a conservative bound). UI checked1440/390, native-source empty states and guarded physical flow. These are synthetic fixtures, not production evidence. The exact guarded browser DB, temporary scripts and API3002/FE3336 were removed. Persistent local preview remains API3001/FE3334, DB wmsd_hieudt_local_20261111.

## Goods Issue CRU — 16/11/2026

See [UC-69–72 contract](../08_api/GOODS_ISSUES.md). No schema migration is needed.
For an existing database, target its URI explicitly and run the additive permission
seed; it inserts `goods_issue:update` and adds it to WAREHOUSE without replacing
other role grants. This task did not run the command against any shared database.

```powershell
# Run only against the database deliberately selected in MONGODB_URI.
npm run seed:goods-issue-permissions

# Isolated transaction tests; fixed loopback replica set, never MONGODB_URI.
$env:RUN_GOODS_ISSUE_TESTS='1'
node --test test/goods-issue-validation.test.js test/goods-issues.integration.test.js
Remove-Item Env:RUN_GOODS_ISSUE_TESTS
```

The test creates and drops only its random `goods_issue_test_<ObjectId>` database
on `127.0.0.1:27018`, replica set `hieudt-test`. Example generated codes use
`PXB-GI-TEST-261116-000001` and `LSH-GI-TEST-261116-000001`; IDs remain opaque.
Result: 5 passed, 0 failed, 0 skipped. Checks cover reservation restoration on edit
and cancel (including an unstarted task), partial/full picking, frozen-location
rollback, PGI replay, source/warehouse permissions, old item-linked issues and
competing drafts. Local browser reads used `wmsd_hieudt_local_20261111` on API 3001
and FE 3334; the additive permission seed updated one WAREHOUSE role there, with
no stock write. A separate random `goods_issue_review_<ObjectId>` DB on the same
loopback replica set supported browser create/edit/cancel/pick/post using two lots.
It produced one PGI and one handover, then was dropped with its exact name/prefix
checked; temporary API 3002/FE 3336 and the fixture script were removed. Final related
FE tests: 32 passed; build/typecheck, changed-file lint and docs checks passed.
Desktop 1440, mobile 390 and list boundary 768 were inspected; the finish reviewer
scored the three requested fixes resolved. The default BE suite still has one
unrelated duplicate-return-source assertion failure; integration skips are not passes.

## Kiểm thử vòng đời kiểm kê BF-05 — 13/11/2026

Test `stocktake-lifecycle.integration.test.js` bật bằng `RUN_STOCKTAKE_LIFECYCLE_TESTS=1`, dùng cùng replica set `127.0.0.1:27018/hieudt-test` và DB tạm `stocktake_lc_test_<ObjectId>` (teardown kiểm prefix rồi drop). Chạy tuần tự với các suite integration khác (`--test-concurrency=1`); chạy song song nhiều file tạo/xóa DB cùng lúc rất dễ làm Mongo cạn file descriptor.

Dựng replica set bằng Docker trên macOS khi chưa có instance 27018 (mỗi lần chạy tạo ~59 collection kèm index nên cần nâng giới hạn file; mặc định container sẽ sập với `Too many open files`):

```sh
docker run -d --name hieudt-mongo --ulimit nofile=64000:64000 -p 27018:27018 mongo:8.0 --replSet hieudt-test --port 27018 --bind_ip_all
docker exec hieudt-mongo mongosh --quiet --port 27018 --eval 'rs.initiate({_id:"hieudt-test",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

```sh
RUN_STOCKTAKE_LIFECYCLE_TESTS=1 RUN_HIEUDT_TESTS=1 node --test --test-concurrency=1 test/stocktake-lifecycle.integration.test.js test/hieudt-iterations.integration.test.js
```

Kết quả 13/11/2026: 5/5 và 11/11 đạt. E2E trình duyệt dùng DB tạm `wmsd_demo_bf05_e2e` (seed chuẩn `src/seeds` vào replica set cô lập, backend `PORT=3011`, frontend Vite `VITE_API_PROXY_TARGET=http://127.0.0.1:3011`); không dùng cổng 3001 vì có thể đang bị tunnel SSH chiếm.

## Migration Atlas receipts — 12/11/2026

Migration được thực hiện bằng scripts/migrate-receipts-to-goods-receipts.mjs. Dry-run phát hiện 7 phiếu và 21 liên kết legacy. Apply đã đổi documentKind, giữ _id/documentNo, chuyển sourceType/subjectType/subjectCollection/documentType sang goods_receipts, tạo goods_receipts/uoms/conversions và index, xác minh referencesAfter=0 rồi drop 4 collection legacy. Kết quả Atlas wmsd_database: 58 collections; goods_receipts gồm PURCHASE=1, CUSTOMER_RETURN=1, FAILED_DELIVERY=1, TRANSFER=4; purchase_receipts/customer_return_receipts/failed_delivery_receipts/transfer_receipts không còn. Script yêu cầu đúng database name và cờ --allow-atlas; chạy lại idempotent.

## Định danh chứng từ — kiểm chứng 12/11/2026

Mã tạo mới được kiểm trên test/document-number.test.js: YYYY cũ không còn dùng; ngày local tạo YYMMDD, _id trùng documentNo, số tăng cạnh tranh trong transaction, rollback không tiêu số, không tạo document_sequences. test/document-identities.test.js đạt 4/4: root document dùng DocumentIdentity, source/subject/reservation/transaction refs nhận mã hoặc ObjectId lịch sử, catalogue/item IDs vẫn ObjectId, _id bất biến. Native 15/15 và HieuDT scope2/2 đã chạy lại với mã chuỗi trên DB tách biệt loopback27018.

## Kiểm chứng phạm vi 20 UC mới — 12/11/2026

[Hợp đồng hiện hành](../08_api/HIEUDT_WAREHOUSE_SCOPE.md). Test mới test/hieudt-scope.integration.test.js dùng RUN_HIEUDT_SCOPE_TESTS=1, URI cố định loopback27018/hieudt-test, DB ngẫu nhiên prefix wmsd_hieudt_scope_test_; teardown kiểm prefix rồi drop đúng DB. Giữ đầy đủ collection/index, không dùng DB app hoặc dữ liệu nhóm. Phạm vi: location create/replay/update/stale/freeze/scope; inventory và Sales redaction; TR revise/update/approve; reservation draft/cancel/recreate; pick/handover; độc lập nhận GOOD+DAMAGED; linked difference review; good putaway; close và ledger/progress. Kết quả cuối2/2 pass, không skip.

Kiểm tra BE mặc định npm test:110 pass,0 fail,80 integration skip (190 tổng). Các bộ có cờ bật chạy riêng; không cộng các bài skip thành pass. FE các màn native mới, BF03/BF04, route/session và MovementList:41/41 pass; lint file liên quan, typecheck/build đạt. Full FE lần rà đầu437 pass/24 fail (prototype cũ, products/lots/issue/replenishments và session stub đã đổi route); lint toàn FE còn59 lỗi,13 warning trong các module ngoài native warehouse-stock/BF03/BF04. Không khẳng định toàn FE xanh. Browser desktop và viewport390x844 đã xem danh sách kho/vị trí, tồn, nhật ký, bảng tiến độ transfer hoàn thành; không chạy browser mutation trên DB nhóm.

Chạy scope integration từ PowerShell BE:

```powershell
$env:RUN_HIEUDT_SCOPE_TESTS='1'
node --test test/hieudt-scope.integration.test.js
Remove-Item Env:RUN_HIEUDT_SCOPE_TESTS
```

Hồi quy native cuối15/15 pass,0 fail,0 skip (410.8 giây, phần lớn khởi tạo đầy đủ collection/index). Ca toàn hàng lỗi xác nhận createRequirement bị từ chối, không tạo ITR/TO, vẫn đóng TR khi transit bằng0 và các điều kiện khác đã đủ. Đã kiểm chỉ đọc trên DB review rằng Sales options không trả tồn/địa điểm/nguồn tác nghiệp. Giữ các báo cáo ngày trước như lịch sử, không dùng thay bằng chứng của code mới.

## Local review for manual testing — 11/11/2026

User requires local review before any rollout of units/conversions to wmsd_database. Local review DB: mongodb://127.0.0.1:27018/wmsd_hieudt_local_20261111?replicaSet=hieudt-test. Source is the existing standalone local wmsd_demo_tile_shop_v8 at port 27017, copied read-only into a new DB; it is not a live snapshot of the shared DB. The local copy receives the active Viên/BOX UOMs, 38 batch carton conversions derived from verified packaging, 5 FE email preset accounts, and warehouse2@ceratile.vn as an independent local receiving tester. Source DB and shared wmsd_database remain unchanged.

Replica set 27018 is named hieudt-test and PRIMARY; standalone 27017 cannot be made transactional by appending replicaSet=rs0 to the URI. Keep the standalone instance intact. In BE run npm run dev:hieudt-local to start port 3001 with a hard-coded local-only URI and no startup seed/password sync. FE .env.development.local has VITE_API_PROXY_TARGET=http://127.0.0.1:3001; normal default remains port 3000. Restart Vite after changing this local-only setting. Local test account passwords match current FE/SEED_ACCOUNTS presets. The receiver warehouse2@ceratile.vn uses Kho2@12345678 and inherits thukho02 warehouse scope. No shared rollout until user checks and explicitly approves.

Cập nhật 11/11: thêm test/document-number.test.js. Bật RUN_HIEUDT_TESTS=1 để kiểm lấy mã cuối +1, tạo đồng thời, rollback và tách tháng trên DB tạm hieudt_numbers_<ObjectId> tại replica set test. Mã cũ không bị đánh lại. Collection kỹ thuật document_sequences cần được tạo trước transaction đầu tiên.

# Kiểm thử local ba iteration HieuDT — 10/11/2026

Đọc [phạm vi và hợp đồng](../08_api/HIEUDT_ITERATIONS_NATIVE.md) trước khi chuẩn bị dữ liệu. Không dùng DB nhóm làm nơi chạy fixture.

## Bật lại replica set hiện có trên máy này

Đã xác minh port 27018 có setName hieudt-test, isWritablePrimary=true. Port 27017 là standalone; thêm replicaSet=rs0 vào URI không cấu hình được server. Nếu instance 27018 đã chạy thì chỉ cần dùng URI đúng ở trên. Khi cần khởi động lại instance đã cấu hình, mở PowerShell riêng và chạy:

```powershell
& 'C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe' --dbpath 'E:\Doan\outputs\hieudt-number-mongo' --port 27018 --bind_ip 127.0.0.1 --replSet hieudt-test --wiredTigerCacheSizeGB 1
```

Giữ terminal đó chạy. Trong MongoDB Compass kết nối URI local, mở MongoDB Shell rồi dùng db.adminCommand({hello:1}) hoặc rs.status(). Một thư mục dữ liệu mới chỉ cần khởi tạo một lần với rs.initiate({_id:'hieudt-test',members:[{_id:0,host:'127.0.0.1:27018'}]}); thư mục hiện có đã khởi tạo nên không cần chạy lại. Chờ isWritablePrimary=true trước khi dùng transaction.

## Kết quả kiểm tra local thực — 11/11/2026

FE3334 proxy sang BE3001, health có header X-WMSD-Review-Database=wmsd_hieudt_local_20261111. Hai script check-bf03-local.mjs và check-bf04-local.mjs từ chối chạy nếu proxy không có dấu local này. Các script chỉ mở URI local cố định và tạo chứng từ/vị trí thử; không chạy với DB shared.

BF03 tạo LCV–K-GACH-01–202611–000001, chuyển 1 thùng = 8 viên vào BF03-LOCAL-DEST; tạo lệnh chưa đổi tồn, xác nhận ghi 1 ledger, retry không ghi lần hai; số thập phân và tách 1 viên bị từ chối 400. BF04 tạo YCĐC–K-GACH-01–202611–000001, chuyển tiếp 8 viên sang kho02 qua đầy đủ tạo/duyệt/xuất/pick/nhận/putaway/đóng, trạng thái COMPLETED; người nhận warehouse2 khác người gửi warehouse. Dữ liệu thử được giữ trong local để người dùng xem. Native cuối 15/15 pass; FE component 10/10; typecheck và production build đạt. Đây là kiểm API qua proxy và component, chưa kiểm browser E2E vì truy cập trình duyệt đang tắt trong Work.

## Replica set riêng

Test `hieudt-iterations.integration.test.js` được bật bằng `RUN_HIEUDT_TESTS=1`. Đích cố định `127.0.0.1:27018`, replica set `hieudt-test`, DB tên `hieudt_test_<ObjectId>`. Hook teardown kiểm prefix trước khi xóa DB tạm. `native-api.integration.test.js` khi có cùng cờ dùng replica set này và prefix `wmsd_api_test_`; không đổi instance 27017.

Chuẩn bị một thư mục dữ liệu trống riêng, chạy MongoDB với `--port 27018 --bind_ip 127.0.0.1 --replSet hieudt-test --dbpath <test-data-dir> --logpath <test-log-file>`. Trên Windows dùng Start-Process -WindowStyle Hidden. Khởi tạo một lần bằng admin command `replSetInitiate` với cấu hình `{_id:'hieudt-test',members:[{_id:0,host:'127.0.0.1:27018'}]}`; chờ PRIMARY. Không thay cấu hình DB đang dùng.

Tại BE, PowerShell:

```powershell
$env:RUN_HIEUDT_TESTS='1'
node --test test/hieudt-iterations.integration.test.js
$env:RUN_NATIVE_API_TESTS='1'
node --test test/native-api.integration.test.js
Remove-Item Env:RUN_HIEUDT_TESTS, Env:RUN_NATIVE_API_TESTS
npm test
npm run docs:check
```

Tại FE:

```powershell
npx tsc --noEmit
npx vitest run src/features/sales-execution/pages.test.tsx src/app/routeAccess.test.ts src/features/location-moves/live/presentation.test.ts src/features/operational-reports/live.test.ts
npm run build
```

## Loại bằng chứng

Suite HieuDT kiểm tạo nguồn SO/replay/trùng, sửa-hủy/cam kết, tạo OD đồng thời, nhiều nhiệm vụ không giữ hàng hai lần, soạn từng phần/đúng người/khóa kiểm kê/lượng nguyên, giao bù-hủy chung hạn mức, chốt kiểm kê không lệch/DELTA/RECLASS với count mới và rollback, báo cáo thật và HTTP auth/DTO/validation. Native suite kiểm BF03/BF04 và mua/nhập/đảo theo main; không dùng kết quả này thay cho chứng minh các UC chưa được gọi.

Suite mặc định có các integration bị skip theo cờ và live Cloudinary test chưa bật. FE tests kiểm list thực, retry payload, quyền route và CSV. Build/typecheck không chứng minh thao tác đầy đủ trong browser. Không seed hoặc sửa dữ liệu shared/Atlas. Kết quả thực từng lần ghi ở [change_logs](../../change_logs.md).
