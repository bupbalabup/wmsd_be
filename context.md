22/11/2026 — Stocktake redesign following lecturer feedback (user decision 22 Nov 2026: separate plan/slip, remove blind count, simplified reconciliation, drop closing reason). New collection `stocktake_plans` (recurring plan, `KHKK-` identity, generates ordinary PLANNED slips; no cron) makes the registry 59 collections. Blind count is gone: every reader sees the frozen book quantity while COUNTING (`blind-count.js` deleted; supersedes BF-04 blind count and the 18 Nov 2026 decision, kept as dated history). After reconcile the Owner uses `POST /stocktakes/:id/recount` or `POST /stocktakes/:id/approve-differences` (per-line Clear Difference, one transaction, idempotent, COMPLETED when every line is settled); close/resolution-plan/reopen-counting endpoints and the closing `reason` were removed. Stocktake payloads carry `uomCode`/`uomName`. Contracts: git_doc/docs/08_api/STOCKTAKE_PLANS.md and STOCKTAKE_LIFECYCLE.md#redesign--22-november-2026-current-contract. Collection/index definitions only; no shared-database rollout.

20 November 2026 — Receiving corrections: scoped receipt routes, bounded CR reassessment claims with RELEASED/REACQUIRED history, saved direct-return packaging and measured volume, and damaged-transfer ACTIVE holds. New direct inspections save verified lot packaging for sealed historical returns; partial measured fragments retain a conservative volume bound. Sales sees only linked transfer receipt status. OTHER attachments are allowed only for DRAFT creation or POSTED reversal work; APPROVED cannot drift. Inspection creation contends with PO cancellation through a timestamp write without changing the public version. Canonical contracts: git_doc/docs/08_api/GOODS_RECEIPTS.md and RETURN_WORKFLOWS_NATIVE.md. No backfill or shared-database rollout.

18/11/2026 — BF03 optional mixed SEALED cartons + LOOSE entry, with loose input on line 2. One form row expands into independent typed items via optional details.packagingState; generic historical items retain behavior. Only explicit LOOSE may split known-volume stock with conservative bounds; no carton opening or OPEN substitution. Preserve partial trips, item IDs, versions, retries and scoped posting guards. No collection/index/relationship/migration change. Canonical git_doc/docs/08_api/location-movements/README.md#mixed-sealed-cartons-and-loose-pieces--18-november-2026.

17/11/2026 — BF03 source-stock cells show stored sealed carton counts, base units inside OPEN packaging and LOOSE base units from existing portions. Missing/inconsistent packaging is explicit; no count of physical open cartons is inferred. Only two extra option projection fields, no extra queries or write/schema changes. Canonical git_doc/docs/08_api/location-movements/README.md#source-packaging-breakdown--17-november-2026.

17/11/2026 — UC43/44 inventory: interactive list uses view=summary (labels, physical/available, quality/owner); default full preserves Excel. Projected context/joins, page-batched stock deductions/locks and indexed direct detail replace per-row reads and list reuse. Snapshot, exact decimals and role/warehouse scope remain. Details load history only on request. Canonical git_doc/docs/08_api/HIEUDT_WAREHOUSE_SCOPE.md#inventory-list-and-detail-performance--17-november-2026. No schema/index/migration/online write.

17/11/2026 — BF04 destination receipt posts GOOD stock and automatically creates a waiting ITR/PUTAWAY TO in the same transaction. Destination staff choose STORAGE targets on a separate task page and confirm once. Full requests auto-complete after exact quantities, transit, linked task and variance guards; short requests keep reasoned partial closure. Report creation/replay requires actual destination assignment plus update permission; independent review remains. Canonical git_doc/docs/08_api/transfers/BF04_API.md. No schema migration, grants or online backfill; historical unplanned receipts use an explicit create/reuse command.

17/11/2026 — BF03/BF04 field projections: list view=summary omits item arrays and execution metadata; default full preserves Excel line quantities. Detail/options/ledger/related records select only consumed fields; command versions, packaging factors, scope and posting reads retained. Canonical git_doc/docs/08_api/TRANSFER_PERFORMANCE.md. No DB migration/remote write.

17/11/2026 — BF03/BF04 read performance: batched selection availability (max 4 queries), compact warehouse catalogues without 3D snapshots, optional BF04 mode=locations for destination options and parallel authorized detail reads. Transaction guards unchanged; no remote rollout. Canonical git_doc/docs/08_api/TRANSFER_PERFORMANCE.md.

## Customer details on documents — 17 November 2026

User decision: customers are not managed as catalogue records. New sales orders require `customerName` (1–160 characters) and allow `customerPhone` (up to 30 characters); the delivery address remains on the order. Creating an order does not query or create a Customer. Sales options return an empty compatibility `customers` array.

Customer-return creation sends warehouse and source lines only, without `customerId` or a customer selector. The server resolves name/phone from the source sales order or verified historical delivery and saves a snapshot on the return. Each new request is limited to one source document, while allowing multiple lines and split parts from that document. Warehouse access, source ownership/permissions, confirmed received quantity, claims, evidence, versions and idempotency remain enforced. Direct goods issues retain the sales-order link and no longer require a customer catalogue ID.

Historical verification requires customer name text and optional phone from the external document; verification/evidence remains mandatory. New historical sources with customer snapshots use the current inspection/acceptance/receipt flow without custody. Previously stored sources and custody ledgers retain their legacy behavior. Optional legacy customerId fields and the Customer collection remain readable; no records or collections are deleted or backfilled. Deploy FE and BE together; old clients sending customerId to new creation endpoints must update.

Validation: focused sales/return contract tests and the local direct-sales transaction test passed using an isolated database on the local rs0 replica set (port 27017). The transaction fixture creates a new sale and return with no Customer record, and separately verifies legacy custody compatibility. No Atlas write or migration was performed.

## Phạm vi hiện hành

Theo quyết định người dùng ngày 17/11/2026, bỏ danh mục khách hàng và delivery riêng; giữ đơn bán và khách trả. Xem [phạm vi và nguồn yêu cầu](git_doc/PROJECT_GUIDE.md#phạm-vi-chức-năng-hiện-hành). Mô tả triển khai cũ bên dưới không tự mở lại các chức năng đã loại khỏi phạm vi. Đây là thay đổi tài liệu; code/DB chưa được thay đổi trong lượt này.

17/11/2026. Phiếu nhập mua hoàn tất khi ghi nhập. Chuyển hàng từ bãi tiếp nhận lên kệ dùng BF03. Xem [API phiếu nhập](git_doc/docs/08_api/GOODS_RECEIPTS.md#chi-tiết-phiếu-nhập-mua) và [rollout local](git_doc/docs/09_phat_trien/MONGODB_LOCAL.md#ngừng-lệnh-cất-hàng-mua).

## 17 November 2026 — simplified sales and returns

Latest explicit user decision supersedes manual-sale and custody requirements for new records. Sales Order → direct Goods Issue; Sales confirms evidenced customer receipt; Warehouse receives undelivered goods inline. New CR inspection records facts only, acceptance authorizes receipt, and only receipt posts STORE stock. Legacy mode markers are absent and retain original ledgers. Optional issue header/order/customer/sourceBalance and embedded customerReceipts, CR intakeMode/handbacks, and FAILED_DELIVERY receipt goodsIssueId add no collection. See [current contract](git_doc/docs/08_api/GOODS_ISSUES.md) for permissions, exact caps, schema, compatibility and setup.

17/11/2026 — Kho 3D: lớp hàng nhiều mã/lô và số thùng là nhãn phương án; measuredCargoHeight là cao phần hàng, cộng đế một lần; actualHeight cũ vẫn là tổng cao. Vượt cao chỉ cảnh báo, vẫn lưu/áp dụng. X/Y pallet tương đối trong ô, xoay theo khu. Xem git_doc/docs/10_Kho3D/STAGE3_PALLET_LAYERS.md. Không ghi tồn hoặc rollout DB.

17/11/2026 — Người dùng duyệt BF03 chuyển nhiều lần trên cùng lệnh: OPEN → PARTIAL → CONFIRMED; mỗi lần chỉ ghi lượng thực chuyển của các dòng chọn. Lượng còn lại tính từ ledger, hủy chỉ phần chưa chuyển, giữ lịch sử và tồn đã chuyển. Chưa có chuyến mới được sửa kế hoạch; không tự mở thùng. Hợp đồng: git_doc/docs/08_api/location-movements/README.md.

17/11/2026 — Xuất hàng được mở thùng và nhập lẻ số thùng theo quyết định người dùng. Ví dụ 1,5 thùng × 4 viên = 6 viên; vẫn kiểm lượng nguyên theo ĐVT gốc. Lưu snapshot quy đổi hiện hành và phần OPEN còn lại; volumeUpperBoundMm3 là giới hạn thể tích bảo thủ, không giả số đo. Chỉ bật cho xuất bán/xuất khác, BF04 picking/dispatch, trả NCC và thực hủy; BF03/nhập kho giữ quy tắc cũ. Xem git_doc/docs/08_api/GOODS_ISSUES.md.

16/11/2026 — Quyết định mới UC-69–72: form tạo chung 5 lý do xuất; Xuất bán và Xuất khác nhập mã tham chiếu tay, sản phẩm/số lượng/ghi chú, không bắt buộc SO/WIR/OD. SALES chỉ Xuất bán, tạo PENDING_APPROVAL; Owner khác creator duyệt đúng phiếu sang DRAFT, không sinh SO/phiếu mới/giữ hàng/trừ tồn. Kho chọn lô/ô khi tạo TO, PGI mới trừ tồn. Điều chuyển/trả NCC/hủy dùng chứng từ nguồn và native command trong form chung. Seed quyền bổ sung create/update cho SALES, approve cho OWNER, giữ các quyền khác. Hợp đồng chính: git_doc/docs/08_api/GOODS_ISSUES.md.

> 12/11/2026: [Phạm vi HieuDT 20 UC mới](git_doc/docs/08_api/HIEUDT_WAREHOUSE_SCOPE.md) theo bảng người dùng: kho/vị trí, tồn, BF03, BF04, đối soát và nhật ký. Đây là nguồn đối chiếu phạm vi hiện tại; các khả năng 18 UC trước vẫn được giữ. Native warehouse-stock thay route demo, không fallback dữ liệu mẫu.

> 10/11/2026: [18 UC HieuDT, ba iteration](git_doc/docs/08_api/HIEUDT_ITERATIONS_NATIVE.md) đã nối API native cho bán/soạn, BF03/BF04, chốt kiểm kê và báo cáo. Mã UC trong tài liệu theo kế hoạch HieuDT gốc. Trạng thái kiểm chứng và điều kiện đầu vào xem hợp đồng; không suy mọi prototype đã hoàn tất.

> Quyết định 09/11/2026 bổ sung [Conversion theo sản phẩm và lô](git_doc/docs/08_api/CONVERSIONS.md). [Iteration 1 native](git_doc/docs/08_api/ITERATION1_NATIVE_2026-11-06.md) tiếp tục áp dụng cho NCC, giữ hộ và đảo nhập.

> 19/11/2026. RR duyệt theo lượng gốc. RR và PO lưu lượng diện tích đã quy đổi ngược từ lượng nguyên viên. PO chỉ được vượt lượng duyệt với số thùng nguyên nhỏ nhất đủ phủ phần duyệt. Xem [hợp đồng mua và nhập](git_doc/docs/08_api/NATIVE_MODEL_RUNTIME.md#mua-và-nhập).

# Backend context

The runtime uses one registry: `src/models/index.js` exports `registerModels(connection)`; `runtime.js` supplies API models. There are 59 collection schemas directly under `src/models`. Nested schemas do not create collections. `registerReviewedModels` is a compatibility alias. Pure historical transforms and synthetic fixtures under `src/migrations/rebuild` and `src/seeds/rebuild` remain for regression checks.

Start with [PROJECT_GUIDE](git_doc/PROJECT_GUIDE.md), [MODEL_MAP](git_doc/MODEL_MAP.md), [native runtime contract](git_doc/docs/08_api/NATIVE_MODEL_RUNTIME.md) and [documentation rules](git_doc/DOCUMENTATION_RULES.md). The paired frontend is `../fe`.

No automatic commit/push. No remote writes as part of the model synchronization. Preserve dated deployment evidence. D07/D08 remains unresolved.

## Historical return-source decision — 7 November 2026

The user confirmed Accountant verification with uploaded evidence for historical customer-delivery sources. This scope is implemented in [the native return contract](git_doc/docs/08_api/RETURN_WORKFLOWS_NATIVE.md). It does not settle broader new-SO external-source gates. Trungph return workflows now use the native registry; local automated verification and rollout limits are recorded in that contract and the PR evidence. No Atlas data or connection change.

12/11/2026: code Kho 3D chặng 1: warehouses.layout3d, API lưu theo updatedAt và scope; xem git_doc/docs/10_Kho3D/IMPLEMENTATION.md. Chưa có khu vực/ô/pallet và chưa rollout DB.

12/11/2026: Kho 3D chặng 2 mở rộng layout3d cho functions/zones/slots, maxStackHeight và snapshot layout3dApplied/layout3dAppliedAt. PUT layout thêm apply, kiểm containment khi apply và warehouse_layout_function:update khi đổi danh mục chức năng. Danh sách catalogue không trả payload thiết kế. Hợp đồng git_doc/docs/10_Kho3D/STAGE2_ZONES.md.

Kho 3D: functionId rỗng hợp lệ ở nháp, không hợp lệ khi apply; functionId có giá trị phải tồn tại trong functions. Danh mục vẫn kiểm quyền quản trị, không khóa vẽ nháp khi danh mục trống.

16 November 2026: Excel operational-list exports and opening-stock import are implemented in the paired frontend. Backend draft/preview/post/cancel contract, Owner-only import/self-confirmation, exact packaging and one-time warehouse initialization: [EXCEL_AND_OPENING_STOCK](git_doc/docs/08_api/EXCEL_AND_OPENING_STOCK.md). Existing local databases need additive permission/index setup; no remote rollout. Shared stock guards now serialize on warehouses.stockOperationVersion without changing catalogue updatedAt.
