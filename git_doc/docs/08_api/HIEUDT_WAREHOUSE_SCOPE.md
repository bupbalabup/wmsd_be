# HieuDT — phạm vi 20 UC được giao ngày 12/11/2026

Bản này đối chiếu bảng người dùng dán mới nhất; thay cách xác định phạm vi HieuDT theo bảng 18 UC cũ. Những chức năng bán/kiểm kê/báo cáo đã làm trước được giữ nguyên. Nguồn thiết kế: phiếu duyệt kho/vị trí 05, H06–H08 ở phiếu 16 và H09–H11 ở phiếu 17. Không thêm collection/model, không seed hoặc ghi DB nhóm.

## Đối chiếu màn hình và API

Tất cả API có tiền tố /api, yêu cầu xác thực và quyền thật từ session.

| UC | Màn hình FE | API |
|---|---|---|
| 38 | /warehouses | GET /warehouses; GET /warehouse-catalogue; GET /warehouse-locations |
| 39 | /warehouses/locations/:id | GET /warehouse-locations/:id |
| 40 | /warehouses/create; /warehouses/locations/create | POST /warehouse-catalogue; POST /warehouse-locations |
| 41–42 | /warehouses/locations/:id/edit | PATCH /warehouse-locations/:id |
| 43 | /inventory | GET /inventory/options; GET /inventory |
| 44 | /inventory/:id | GET /inventory/:id; GET /stock-movements?balanceId= |
| 47–48 | /location-moves; /location-moves/:id | GET /location-movements; GET /location-movements/:id |
| 49 | /location-moves/create; /location-moves/:id/edit | POST /location-movements; PATCH /location-movements/:id |
| 50 | /location-moves/:id | POST /location-movements/:id/confirm |
| 51–52 | /transfers; /transfers/:id | GET /warehouse-transfers; GET /warehouse-transfers/:id |
| 53 | /transfers/create; /transfers/:id/edit | POST /warehouse-transfers; PUT /warehouse-transfers/:id |
| 54 | /transfers/:id | POST /warehouse-transfers/:id/review |
| 55 | /transfers/:id | POST /warehouse-transfers/:id/outbound-deliveries; /documents/:id/internal-requirements; /tasks/:id/confirm; /dispatches/:id/cancel |
| 56 | /transfers/:id | POST /warehouse-transfers/dispatches/:id/differences; /differences/:id/review |
| 114–115 | /inventory/movements; /inventory/movements/:id | GET /stock-movements/options; /stock-movements; /stock-movements/:id |
| 120 | /transfers/:id | POST /warehouse-transfers/dispatches/:id/receipts; /documents/:id/internal-requirements; /tasks/:id/confirm |

## Kho, vị trí và tồn kho

Chủ cửa hàng (`OWNER`) có phạm vi toàn bộ kho, kể cả khi `warehouseIds` rỗng hoặc kho vừa được tạo. Đối với [thiết kế Kho 3D](../10_Kho3D/STAGE2_ZONES.md#api-và-quyền), quyền sửa kho của Chủ cửa hàng bao gồm quản lý chức năng khu vực. Các vai trò khác vẫn theo quyền thao tác và phạm vi kho được phân công.

GET /warehouses vẫn trả options theo phạm vi; GET /warehouse-catalogue trả danh sách kho cửa hàng với số vị trí; GET /warehouse-catalogue/:id trả chi tiết. POST/PATCH /warehouse-catalogue dùng warehouse_location:create/update để Owner quản lý kho. Mã kho bất biến sau tạo; tên/địa chỉ/mô tả/kích thước/trạng thái được sửa bằng expectedUpdatedAt + idempotencyKey. Không thể ngừng kho còn tồn, reservation, nhiệm vụ mở; thay đổi kích thước vẫn kiểm tra sức chứa thực. Kho được phân công mới hiển thị cho non-Owner; Owner xem toàn bộ. Danh sách vị trí lọc q literal theo mã/tên/khu vực/mô tả, warehouseId, active=true|false, type, page, limit≤100. Chỉ dùng trường mô hình đã duyệt: areaCode, không tạo aisle/rack giả.

Đọc vị trí dùng warehouse_location:read; tạo dùng warehouse_location:create; sửa/trạng thái dùng warehouse_location:update. Owner mặc định có quyền, custom role theo grant và kho. POST nhận warehouseId, code≤50, name≤160, locationType, usableLengthMm/usableWidthMm chuỗi dương, isPickable, isActive, areaCode/description tùy chọn và idempotencyKey. PATCH thêm expectedVersion. Không đổi warehouseId sau tạo. Chỉ STORAGE được isPickable. Chiều cao lấy clearHeightMm thực của kho.

Từ 18/11/2026, giao diện kho và vị trí nhập/hiển thị kích thước bằng mét, chấp nhận dấu phẩy hoặc chấm thập phân (ví dụ `2,125` m gửi `"2125"` mm). API và sức chứa giữ các đơn vị mm và mm³. Chiều cao tại form vị trí chỉ đọc, lấy từ kho được chọn; sửa tại biểu mẫu cập nhật kho. Ô **Cho phép lấy hàng** chỉ bật cho **Vị trí lưu trữ** (STORAGE) và tự bỏ tick khi đổi loại. Khi có nhiệm vụ mở, so sánh giá trị kích thước theo số chính xác; thay đổi cách viết số không tính là đổi kích thước. Dữ liệu cũ giữ nguyên giá trị vật lý.

Lệnh danh mục dùng command/transaction: tải lại actor/quyền, optimistic version, idempotency receipt, audit/outbox. Khóa operationVersion của vị trí cạnh tranh với lệnh ghi tồn/khóa kiểm kê. Không sửa khi freeze; không ngừng/đổi loại/đổi khả năng lấy hàng nếu còn tồn dương, reservation chưa dùng hoặc nhiệm vụ mở; không đổi mã/kích thước khi còn nhiệm vụ. Sau sửa kiểm lại sức chứa thực. Không sinh giao dịch hoặc sửa quantityBase.

GET chi tiết trả warehouse, stock theo lô/chất lượng/chủ hàng, locked, openTaskCount, capacity={capacityMm3,occupiedMm3}. Thiếu kích thước trả null; thiếu quy cách thực đo trả occupiedMm3=null, không suy ra số giả.

POST /warehouse-locations và PATCH đầy đủ nhận thêm `layoutBinding: {slotIds: string[], expectedUpdatedAt: string}` khi người dùng sửa liên kết. Danh sách là toàn bộ ô của vị trí trong bản nháp kho đã chọn. Bỏ qua trường này để giữ liên kết hiện tại, gửi mảng rỗng để bỏ gán. Dùng updatedAt của kho từ lúc chọn ô. Cần quyền sửa thiết kế warehouse_location:update. Lưu vị trí và liên kết trong cùng transaction, kiểm phiên bản kho, ô tồn tại và chưa thuộc vị trí khác, vị trí đang hoạt động khi gán mới. Bản đã áp dụng chỉ thay đổi khi áp dụng thiết kế.


Chi tiết kho cũng cung cấp vị trí để gán cho ô trên [thiết kế Kho 3D](../10_Kho3D/STAGE2_ZONES.md). Lưu liên kết chỉ ghi ID trong thiết kế; không sửa danh mục vị trí, sức chứa hoặc tồn.

Đọc tồn dùng inventory:read. Bộ lọc warehouseId/locationId/productId/batchId/balanceId/quality/ownerType/q/page/limit. Options lấy sản phẩm/lô/vị trí từ các số dư thuộc phạm vi. Tồn theo từng sản phẩm giữ đơn vị gốc, không cộng gạch khác đơn vị thành KPI tổng. Các số lượng là decimal strings:

- physicalQtyBase: tồn ở điểm vật lý; IN_TRANSIT không tính vật lý.
- transitQtyBase: lượng còn ở điểm giữ IN_TRANSIT liên kết dòng phiếu xuất của kho nguồn.
- custodyQtyBase: lượng CUSTOMER/SUPPLIER; không coi là hàng cửa hàng.
- heldQtyBase: hold thực còn hiệu lực.
- reservedQtyBase: reservation còn lại sau consumed/released/moved.
- pendingQtyBase: lượng nhiệm vụ còn mở chưa được reservation bao phủ; không trừ reservation hai lần.
- usableQtyBase: hàng GOOD/STORE, lô VERIFIED, sản phẩm/kho/vị trí hoạt động, không freeze, trừ hold; gồm hàng tốt ở khu nhận/tập kết.
- availableQtyBase: khả dụng cấp hàng ở STORAGE pickable; trừ reservation, nhiệm vụ chưa được bao phủ và hold, chặn hàng lỗi/giữ hộ/transit/freeze.

Sales chỉ nhận availableQtyBase và định danh catalogue, không nhận tồn vật lý, hold, reservation hoặc tồn giữ hộ. Kho scope áp trước lookup/pagination. Chi tiết không thấy số dư trả 404, kho không có quyền trả 403; không fallback localStorage.

### Inventory list and detail performance — 17 November 2026

User decision: the list shows an overview; secondary quantities and history belong on the detail page. `GET /api/inventory?view=summary&page=1&limit=20` returns `items`, `total`, `page`, `limit` and `capturedAt`. Each summary item contains `id`, `product`, `sku`, `batch`, `warehouse`, `location`, `unit`, `availableQtyBase`; non-Sales also receive `quality`, `ownerType` and `physicalQtyBase`. Summary omits catalogue IDs, versions, detailed quantities and the duplicate warehouse catalogue. Existing filters, literal search, product-name/ID ordering, scope and exact decimal strings remain unchanged. Missing `view` or `view=full` preserves the detailed row contract for Excel export and existing consumers; its warehouse catalogue now selects only `_id`, code, name, isActive and clearHeightMm.

Balance reads exclude packaging portions and unused metadata before lookups. Product/batch joins project only identity, labels, base unit and eligibility flags. The current page batches reservation, open-task, posted-task-movement and active-hold reads (at most four queries), with a single lock query for its locations. Summary reads stock deductions only for eligible pickable rows. Full/detail reads keep usable, held, pending, reserved, transit, custody, version and freeze values. Read calculations reuse exact reservation/partial-task/hold semantics, including released/consumed holds and execution reservations that must not be counted twice. Snapshot transactions remain; operations sharing a transaction session run sequentially. No stock cache, schema, index, permission or write-command change.

`GET /api/inventory/:id` starts with an indexed balance ID match and projected joins to its own holding point, location or source dispatch, warehouse, batch and product. It checks the resulting warehouse scope and Sales visibility, then calculates only that balance; it does not call the list, load all warehouses/locations/dispatches, sort or count the inventory. Unauthorized/missing detail returns 404; permission denial remains 403. Inventory options reuse their scoped warehouse query and select compact context fields without warehouse 3D layouts or stock packaging.

The FE requests summary for the interactive list and keeps the default full API for Excel. The list has seven columns: SKU/product, lot, warehouse/location, quality/owner, physical, available and an explicit detail link. Sales sees five columns without unavailable physical/quality/owner fields. Details retain permitted quantities; the stock-movement request starts only when an authorized user opens “Xem lịch sử biến động”, with independent pagination. History is not loaded on the list, a failed detail read or without its permission. Deploy paired FE/BE for summary validation and DTO support. No database migration or online write is required.

## Nhật ký tồn

stock_movement:read; list/options/detail áp phạm vi điểm giữ của kho trước phân trang. Bộ lọc q (sản phẩm/SKU/lô/vị trí/operation), warehouseId/locationId/productId/batchId/balanceId, operation, from/to ISO có múi giờ, page/limit. Options.operations lấy distinct từ giao dịch thật được phép xem. Từ/đến ngày gồm hai đầu, ngày đảo hoặc trường lạ bị từ chối 400.

Mỗi hàng là một movements[] đã ghi trong StockTransaction: id dòng, transactionId, operation, occurredAt, recordedAt, performedBy từ User, quantityBase, from/to và before/after. Đầu tồn ngoài scope trả null; không lộ số lượng đầu ngoài kho. source chỉ trả mã/loại/lý do khi người đọc có quyền chứng từ nguồn tương ứng; PICK/PUTAWAY BF04 và receipt TRANSFER dùng stock_transfer:read. Thiếu chứng từ/lý do hiển thị chưa có thông tin, không tự điền người hoặc nguyên nhân.

## BF03/BF04

Chi tiết giữ tại [BF03](location-movements/README.md) và [BF04](transfers/BF04_API.md). BF03 cho xác nhận nhiều lần OPEN/PARTIAL theo lượng thực chuyển, hủy phần chưa chuyển và giữ lịch sử từng chuyến (quyết định17/11); q tìm cả sản phẩm/SKU/lô; xác nhận chuyển nguyên tử giữ nguyên lô/chất lượng/chủ hàng và reservation, kiểm freeze/capacity. Tạo/sửa/xác nhận/tìm kiếm dùng native API, không seed UI.

BF04 options của Sales chỉ trả catalogue kho, không trả locations/holdingPoints/balances/batches/products hoặc sourceWarehouseIds tác nghiệp; đã xác minh đọc trên DB review local. BF04 trả REVISE -> REVISION_REQUIRED; chỉ người lập có quyền update và kho nguồn được sửa/gửi lại chưa duyệt, giữ ID dòng tương ứng. Phiếu xuất DRAFT giữ nguồn thật ngay lúc tạo, chuyển reservation sang PICK task khi sinh TO. Xác nhận PICK + bàn giao là giao dịch nguyên tử đã duyệt; không tạo GI thứ hai. Hủy draft do người lập giải phóng reservation, hủy task/requirement mở, trả hạn mức dòng TR, giữ lịch sử và không ghi tồn.

Detail thêm progress theo dòng dispatch và lineProgress theo dòng TR: dispatchedQtyBase, receivedGoodQtyBase, receivedDamagedQtyBase, transitQtyBase, unresolvedQtyBase. Số nhận lấy phiếu POSTED trừ đảo thực, số transit lấy số dư điểm giữ, không dùng số kế hoạch hoặc tổng UI.

Nhận độc lập, cho phép nhiều lần và tách GOOD/DAMAGED cùng dòng; lượng chưa nhận còn transit. Theo quyết định 17/11, ghi nhận GOOD tại RECEIVING tự tạo ITR/TO PUTAWAY chờ chọn đích. Nhân viên kho đích mở trang TO riêng để chọn STORAGE và xác nhận; không tạo/chọn đích trong đơn chuyển. Hàng lỗi nhận QUARANTINE kèm lý do; phiếu toàn hàng lỗi không tạo TO rỗng. Tự COMPLETED khi xuất và nhận hiệu lực đủ duyệt, không còn transit/hồ sơ chênh lệch, mọi ITR/TO liên quan đã xong. Thiếu lượng thì giữ mở hoặc dừng chuyển tiếp có lý do sau khi phần đã giao được xử lý xong. Đơn phiếu, Nhiệm vụ và Báo cáo được mở từ ba nút trên trang đơn.

UC56 báo lượng chưa nhận bằng stock_transfer:update và tài khoản thực sự được phân công kho đích, kể cả khi thử lại lệnh; quyền Owner xem toàn kho không tự cấp quyền tạo báo cáo. Dùng expectedVersion của dispatch; chưa vượt transit hoặc trùng hồ sơ mở. Lưu StockDiscrepancy sẵn có với mã CLCK do server cấp, nguồn dispatch và từng sourceLineId. Duyệt dùng stock_transfer:approve_variance, người duyệt khác người báo. APPROVE cần receiptId của phiếu POSTED cùng dispatch được lập sau báo, lượng thực chưa đảo đủ và chưa dùng cho hồ sơ khác. Ghi ApprovalHistory + resolutionEvents liên kết giao dịch thực, không sửa lượng phiếu đã post. REJECT/REVISE lưu lịch sử quyết định và giữ hồ sơ OPEN. Sau RESOLVED, hệ thống xét tự hoàn thành TR. Lượng thiếu chưa có chứng từ xử lý tiếp tục mở; không tự ghi mất hàng/write-off.

FE dùng trang riêng cho tạo/sửa/xem, header/breadcrumb/trạng thái, tìm kiếm/dropdown/phân trang; bảng cuộn ngang trên điện thoại. Lệnh chưa rõ kết quả giữ đúng key/payload để thử lại. Cache tồn/options/overview/nhật ký được làm mới sau các lệnh kho. Không dùng số kho/KPI/tồn/hàng mẫu làm fallback khi API lỗi. Nhãn enum/brand/giao diện là cấu hình hiển thị hợp lệ.

## Kiểm chứng và triển khai

Xem [hướng dẫn kiểm thử local](../09_phat_trien/HIEUDT_LOCAL_TESTS.md). Không có migration schema; giữ collection/index và liên kết tài liệu cũ. Đích review vẫn loopback 27018; không thay DB nhóm hoặc tự triển khai.

## UI kho và vị trí theo từng kho — 12/11/2026
Danh sách /warehouses chỉ liệt kê kho, không tải toàn bộ vị trí. /warehouses/:id dùng warehouse-catalogue/:id để đọc kho và warehouse-locations?warehouseId=:id để đọc vị trí phân trang theo kho đang xem. Các bộ lọc tìm kiếm/loại/trạng thái giữ warehouseId từ URL. Thêm vị trí chọn sẵn kho theo query warehouseId; BE vẫn kiểm quyền/phạm vi khi lưu. Không đổi API hoặc dữ liệu.
