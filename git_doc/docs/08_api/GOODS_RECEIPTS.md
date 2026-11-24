# GoodsReceipt API

## Receiving corrections — 20 November 2026

The typed FAILED_DELIVERY list applies the same Sales-order ownership predicate as the unified list and detail before counting and pagination. Typed and unified TRANSFER receipt lists and details keep destination warehouse scope and also apply the BF04 linked-demand scope for Sales. Sales sees receipt identity and status metadata only, plus the authorized transfer request reference on detail. Operational lines, quantities, location/balance IDs and evidence are not returned; shared evidence and document-line lookups do not grant Sales broader receipt access.

OTHER evidence may be attached only in DRAFT (create permission) or POSTED (reverse permission). Both evidence APIs recheck the state in the transaction that updates the receipt version; PENDING_APPROVAL and APPROVED reject attachment so approval remains valid. The detail page exposes Hoàn tác for the reverse capability, checks fresh preflight/version, requires reason and evidence, and preserves the exact command/key after an uncertain response. Posting and reversal refresh inventory, location and lot caches.

The custody destination picker filters CUSTODY/QUARANTINE on the server and reads every page with the existing 100-row API limit. A failed page produces an error and disables posting rather than offering an incomplete list. No collection/index migration or shared-database write is required.

Mọi API có tiền tố `/api`. Một collection `goods_receipts`; mỗi router cố định `documentKind` và chỉ trả phiếu thuộc loại đó. ID loại khác trả `404`; thiếu quyền trả `403`; ngoài kho được giao trả `403`. Quyền được kiểm trước truy vấn và trước lệnh ghi, cùng phiên bản, trạng thái và nguồn nghiệp vụ.

| Loại | List, detail | Quyền đọc | Nơi tạo và quyền ghi |
|---|---|---|---|
| `PURCHASE` | `GET /goods-receipts/purchase`, `GET /goods-receipts/purchase/:id` | `goods_receipt_inspection:read` | Kiểm nhận mua; `goods_receipt_inspection:post/update/reverse`. |
| `CUSTOMER_RETURN` | `GET /goods-receipts/customer-return`, `GET /goods-receipts/customer-return/:id` | `customer_return:read` | `/customer-returns/:id/receipt`; `customer_return:post`. |
| `FAILED_DELIVERY` | `GET /goods-receipts/failed-delivery`, `GET /goods-receipts/failed-delivery/:id` | `failed_delivery:read` | `/failed-deliveries/:id/receipt`; `failed_delivery:inspect/post`. |
| `TRANSFER` | `GET /goods-receipts/transfer`, `GET /goods-receipts/transfer/:id` | `stock_transfer:read` | `/warehouse-transfers/...` nhận tại kho đích; `stock_transfer:receive`. |
| `OTHER` | `GET /goods-receipts/other`, `GET /goods-receipts/other/:id` | `goods_receipt_other:read` | Các lệnh bên dưới. |

List nhận `page` (mặc định 1), `limit` (mặc định 10, tối đa 100), `warehouseId` và `status`. Kết quả `{items,total,page,limit}`. Purchase còn nhận `purchaseOrderId`. BE chỉ truy vấn kho được phân công, Owner xem các kho. DTO trả ObjectId và Decimal128 dưới dạng chuỗi.

## Danh sách gộp và chi tiết

- `GET /goods-receipts` trả `{items,total,page,limit}`. Bộ lọc `kind`, `status`, `warehouseId`, `purchaseOrderId`, `q` (tìm theo số phiếu) và `from`/`to` (ISO 8601 theo `createdAt`) chạy trước phân trang. Mỗi dòng trả `documentKind`, header kèm tên kho/NCC nếu có, `lineCount` và `totalQtyBase` dạng chuỗi thập phân.
- `totalsByBaseUnit` gồm `{unit, quantity}`: tổng `qtyBase` theo từng `baseUnitSnapshot`, với `quantity` là chuỗi thập phân và `unit` là `null` nếu thiếu đơn vị. Mảng rỗng khi phiếu không có dòng; `totalQtyBase` được giữ để tương thích.
- Danh sách gộp áp dụng quyền đọc từng loại. Accountant có phạm vi toàn kho cho phiếu mua. SALES chỉ thấy phiếu khách trả từ yêu cầu do chính mình lập trong phạm vi kho. Nếu lọc loại nằm ngoài quyền đọc, kết quả rỗng.
- `GET /goods-receipts/:id` xác định loại từ collection chung và áp dụng cùng quyền với chi tiết từng loại. Dòng phiếu trả hàng và giao thất bại lấy phẩm cấp, vị trí nhận từ giao dịch ghi tồn. Chi tiết phiếu (`PURCHASE`, `OTHER`, `CUSTOMER_RETURN`, `FAILED_DELIVERY`, `TRANSFER`) còn bổ sung dữ liệu đọc từ danh mục hiện hành trên từng dòng qua `enrichLineItems`: `productSkuSnapshot`, `productSpec` (`sku`, `name`, `manufacturerCode`, `material`, `surface`, `color`, `lengthMm`, `widthMm`, `heightMm`, `description`, `baseUnit`), `lotSpec` (`manufacturerLot`, `tone`, `calibre`, `piecesPerCarton`), `destinationLocationCode` và `destinationLocationName`. Chi tiết điều chuyển trả `header.transferRequestId` để mở yêu cầu nguồn qua phiếu xuất.

## Transfer receipt and automatic putaway — 17 November 2026

Receiving a TRANSFER remains a destination operation in `/receipts`, independent
of the dispatcher. Posting GOOD lines automatically creates one OPEN ITR/PUTAWAY
TO in the same transaction. The TO waits for destination STORAGE choices on its
separate page; receipt posting never invents a storage target. All-DAMAGED receipts
remain in quarantine with defect records and need no PUTAWAY. The transfer request
groups linked receipts/dispatches under Đơn phiếu and TOs under Nhiệm vụ. Exact
full completion is automatic after related tasks/variance checks; stopping a short
transfer remains explicit with a reason. See [BF04 lifecycle and task API](transfers/BF04_API.md#main-flow).
This does not restore the retired purchase putaway routes or modify purchase receipts.

## Kiểm hàng, hàng tạm giữ và hàng đợi ghi nhập

- `GET /goods-inspections` và chi tiết trả `items`, `arrival`, `receipts` và `custodyReceipts`. `GET /purchase-orders/:id/inspection-context` trả `purchaseOrder.items` (đã qua `enrichLineItems`), hạn mức theo ĐVT gốc, lô xác minh và vị trí kho. Context còn trả `products[]` (`id`, `sku`, `name`, `manufacturerCode`, `material`, `surface`, `color`, `description`, `baseUnit`, `lengthMm`, `widthMm`, `heightMm`) và `cartonUnits[]` (mã ĐVT thùng đang hoạt động) để FE hiển thị quy cách đầy đủ và quy đổi sang đơn vị gốc, m². Dòng kiểm (tạo/sửa) nhận `enteredUnit?` (mặc định là ĐVT của dòng PO); BE quy đổi `enteredQty` bằng `Conversion` theo lô (thùng) hoặc 1 (đơn vị gốc) và đối chiếu hạn mức theo `qtyBase`. Dòng nháp nhận `receivingLocationId?` cho quyết định `ACCEPT` tại vị trí `RECEIVING` cùng kho. Khi chốt, `destinations` tham chiếu ID dòng kiểm đã lưu. `resultRefs` trả ID phiếu nhập mua và phiếu tạm giữ phát sinh.
- `GET /custody-receipts` dùng `goods_receipt_inspection:read`, nhận `status=DRAFT|POSTED|CANCELLED|REVERSED|CLOSED`, `warehouseId`, `purchaseOrderId`, `page`, `limit`. `CLOSED` được chấp nhận để tương thích bộ lọc cũ. Lọc PO theo hàng đến và biên bản kiểm. Chi tiết trả `sourceInspection`, mã PO, tên kho/NCC và vị trí đã ghi lấy theo giao dịch tồn. `POST /custody-receipts/:id/post` nhận `handedOverBy` tùy chọn (bỏ trống, rỗng hoặc null đều được) và yêu cầu vị trí `CUSTODY` hoặc `QUARANTINE` cho mỗi dòng. Có thể gửi quy cách cho hàng đã mở thùng hoặc hàng lẻ. Thể tích thực đo là tùy chọn khi đủ dữ liệu ước tính.
- `GET /purchase-receiving/queue` dùng `goods_receipt_inspection:read`. `stage` nhận `DRAFT_INSPECTION`, `AWAITING_POST` hoặc `CORRECTION`. Bộ lọc gồm `warehouseId`, `purchaseOrderId`, `page`, `limit` và `q` theo mã chứng từ của stage tương ứng.
- `GET /purchase-orders/:id/receiving-summary` trả `documents` gồm `INSPECTION`, `GR_PURCHASE` và `CUSTODY_RECEIPT`. `openWork` đếm `draftInspections` và `draftReceipts`. Lượng đã nhận trên PO tăng ngay khi phiếu nhập mua được ghi sổ.

Tham số `q` là chuỗi tùy chọn dài 1–100 ký tự sau khi bỏ khoảng trắng hai đầu. BE tìm đoạn mã khớp theo ký tự, không phân biệt hoa thường, và áp dụng cùng các bộ lọc trước khi tính `total` và phân trang. FE bỏ qua tham số khi ô tìm kiếm trống và gửi lại `page=1` khi từ khóa thay đổi.

## Chi tiết phiếu nhập mua

`GET /goods-receipts/purchase/:id` bổ sung `header.supplierName` và `header.warehouseName` theo tên hiện tại của NCC và kho trên phiếu. BE lấy các tên sau khi kiểm quyền và phạm vi đọc phiếu. Màn chi tiết dùng trực tiếp dữ liệu này trong phần thông tin chung.

`header.postedAt` là thời điểm ghi sổ (chuỗi ISO 8601), `header.postedBy` là ID người ghi sổ, và `header.postedByName` là họ tên hiện tại của người đó. BE lấy mốc và người thực hiện từ `GoodsReceipt.postedAt` và `GoodsReceipt.postedBy`, vốn được lưu trong cùng giao dịch ghi tồn. Phiếu đã đảo vẫn hiển thị mốc ghi sổ gốc. Trường tương ứng được bỏ qua nếu phiếu chưa có dữ liệu ghi sổ hoặc không tra được tên. FE hiển thị giờ Việt Nam và dùng `—` cho dữ liệu thiếu. Phiếu cũ dùng được với dữ liệu đã lưu, không cần migration.

Nếu có chứng từ hàng đến liên kết cùng kho và cùng PO của phiếu, `arrival.header` trả `arrivedAt`, `deliveredBy` và `deliveryReference`. FE tách số điện thoại đã lưu trong `deliveredBy` theo định dạng `tên - số điện thoại` của form kiểm nhận, hoặc hiển thị riêng số điện thoại nếu chỉ có số. Tên người giao không kèm số được hiển thị nguyên văn.

Mỗi dòng trả `inspectionResult` từ dòng kiểm nhận nguồn, cùng dữ liệu đọc bổ sung từ danh mục hiện hành (`productSkuSnapshot`, `productSpec`, `lotSpec`, `destinationLocationCode`, `destinationLocationName`, `poLineNote`). Nếu phiếu thiếu `lotLabelSnapshot`, API dùng nhãn trên dòng hàng đến liên kết khi ID lô khớp. `header.purchaseOrderNo` trả mã đơn mua hàng gốc; riêng vai trò `OWNER` và `ACCOUNTANT` nhận thêm `items[].unitPurchasePrice`, `items[].poEnteredUnit` và `items[].receivedLineAmount` để đối chiếu giá với hóa đơn nhà cung cấp (`WAREHOUSE` bị ẩn các trường giá qua `redactPrices`).

| Trường | Kiểu | Điều kiện trả về |
| --- | --- | --- |
| `items[].receivingBalanceId` | Chuỗi ObjectId | Phiếu `POSTED` chưa đảo và bút toán gốc có `toBalanceId` khớp ID dòng. Bỏ qua trường khi thiếu dữ liệu. |
| `capabilities.relocate` | Boolean | `true` khi phiếu mua `POSTED` chưa đảo, người dùng có quyền thao tác tại kho và có `stock_relocation:create`. |

Thao tác **Chuyển vị trí** mở [form BF03](location-movements/README.md#purchase-receipt-shortcut). Phiếu nhập kết thúc ở `POSTED`. Việc chuyển hàng giữa các vị trí có vòng đời và bút toán riêng. Xem [điều kiện đảo phiếu](#hủy-nháp-và-đảo-phiếu).

## Lệnh `OTHER`

`POST /goods-receipts/other` dùng `operationKey`, `warehouseId`, `reason`, `note?` và `lines` (bắt buộc, 1–100 dòng). Mỗi dòng gồm `productId`, `lotId`, `enteredUnit`, `enteredQty` chuỗi decimal, `destinationLocationId`, `qualityCode`. Warehouse Staff cần `goods_receipt_other:create`.

`PUT /goods-receipts/other/:id` cho phép sửa phiếu `DRAFT` với `expectedVersion`, `operationKey`, `reason`, `note?` và `lines`. Kho lấy từ phiếu đã lưu. Lệnh dựng lại dòng qua cùng quy tắc tạo mới và trả `id`, `version`, `workflowStatus`, `resultRefs`.

Trên giao diện, đính kèm minh chứng nháp qua `POST /return-workflows/:id/evidence`. Có thể tải/gắn chứng cứ qua `POST /purchase-documents/:id/evidence/uploads` và `/purchase-documents/:id/evidence/attach` (API chứng cứ dùng chung vẫn giữ). `POST /goods-receipts/other/:id/submit` dùng `expectedVersion`, `operationKey`, yêu cầu ít nhất một chứng cứ đã gắn và luôn chuyển phiếu sang `PENDING_APPROVAL`.

Phiếu thay thế (`originalReceiptId`, tự duyệt theo hash nội dung phiếu gốc) đã bỏ ngày 22/11/2026 theo quyết định người dùng. Phiếu đã ghi tồn bị sai thì đảo phiếu đó, lập phiếu mới và trình duyệt lại.

`POST /goods-receipts/other/:id/approve` dùng `expectedVersion`, `operationKey`, `decision: APPROVE|REJECT`, `reason`; chỉ Owner khác người lập, với `goods_receipt_other:approve`. Duyệt lưu `ApprovalHistory` theo đúng phiên bản và ghi `approvedVersion`; phiếu đã duyệt không sửa được vì sửa, gửi duyệt và hủy đều đòi `DRAFT`. `POST /goods-receipts/other/:id/post` chỉ Warehouse Staff với `goods_receipt_other:post`; dùng `expectedVersion`, `operationKey`, `packaging?`. Khi bỏ trống `packaging`, hệ thống tách thùng nguyên và phần lẻ. Phần lẻ và phần `OPEN`/`LOOSE` khai thiếu thể tích dùng [công thức ước tính](NATIVE_MODEL_RUNTIME.md#mua-và-nhập). Hệ thống kiểm lại lô, quy đổi, kho/vị trí, sức chứa, khóa kiểm kê, chứng cứ, trạng thái `APPROVED` và `approvedVersion` bằng `version`. Tồn, quy cách, chứng từ và StockTransaction được ghi nguyên tử. Gửi lại cùng key/payload nhận kết quả replay; phiên bản khác bị từ chối.

`POST /goods-receipts/other/:id/cancel` hủy nháp với `expectedVersion`, `operationKey` và `reason`. Lệnh đảo phiếu `OTHER` tạo trực tiếp một `StockTransaction` có `reversedTransactionId` và đưa phiếu gốc sang `REVERSED`.

API ghi nhập mua dùng `/goods-receipts/purchase/:id/post`, `/:id/reverse`, `/:id/reversal-preflight`, `/:id/cancel` và `/:id/destinations`. Các đường dẫn `/putaway-tasks`, `/:id/putaway-context` và `/:id/putaway-tasks` đã gỡ theo quyết định 17/11/2026. API chứng cứ lịch sử của TransferOrder kiểm `stock_relocation:read` khi đọc và `stock_relocation:confirm` khi ghi, cùng phạm vi kho. Xếp hàng điều chuyển liên kho dùng [API ITR](transfers/BF04_API.md).

## Hủy nháp và đảo phiếu

Các lệnh ghi trong bảng nhận `expectedVersion` của phiếu, `operationKey` và `reason` bắt buộc. Các lệnh đảo chấp nhận `evidenceIds` tùy chọn gồm tối đa 20 ID khác nhau, đã gắn vào phiếu nguồn. Có thể bỏ trường hoặc gửi mảng rỗng. Gửi lại cùng khóa và payload trả kết quả đã ghi khi người gọi vẫn có quyền.

| API | Quyền trong kho | Trường bổ sung và kết quả |
|---|---|---|
| `POST /goods-receipts/purchase/:id/cancel` | `goods_receipt_inspection:update` | `expectedPoVersion`. Hủy phiếu `DRAFT`, trả hạn mức PO và giữ phiếu kiểm ở `CONFIRMED`. |
| `POST /custody-receipts/:id/cancel` | `goods_receipt_inspection:update` | Chỉ phiếu giữ hộ NCC `DRAFT`. Ghi `cancelledBy`, `cancelledAt`, `cancelReason` và chuyển phiếu sang `CANCELLED`. Lệnh chỉ ghi trên phiếu giữ hộ. |
| `GET /goods-receipts/purchase/:id/reversal-preflight`, `GET /custody-receipts/:id/reversal-preflight` | `goods_receipt_inspection:reverse` và `goods_receipt_inspection:post` | Trả `{ eligible, reason?, receiptVersion }`. Giữ hộ chỉ áp dụng cho phiếu NCC. |
| `POST /goods-receipts/purchase/:id/reverse` | `goods_receipt_inspection:reverse` và `goods_receipt_inspection:post` | Thêm `expectedPoVersion`. Tạo `StockReversal` ở `POSTED`, cập nhật PO và chuyển phiếu sang `REVERSED`. Phiếu nhập từ hàng giữ hộ trả hàng về số dư NCC gốc. |
| `POST /custody-receipts/:id/reverse` | `goods_receipt_inspection:reverse` và `goods_receipt_inspection:post` | Trừ hàng giữ hộ NCC, tạo `StockReversal` ở `POSTED` và chuyển phiếu sang `REVERSED`. ID trả về là ID phiếu đảo. Lệnh chỉ ghi trên phiếu giữ hộ và sổ tồn liên quan. |
| `GET /goods-receipts/other/:id/reversal-preflight` | `goods_receipt_other:read` và `goods_receipt_other:reverse` | Trả `{ eligible, reason?, receiptVersion }`. |
| `POST /goods-receipts/other/:id/reverse` | `goods_receipt_other:reverse` | Trả ID phiếu gốc ở `REVERSED`. |

BE kiểm phiếu `POSTED` và giao dịch gốc chưa từng bị đảo. Từng dòng phải còn đủ phần đóng gói mang ID của lần ghi nhập tại vị trí gốc. Phiếu khác cùng số dư có thể ghi nhập hoặc chuyển phần của chính phiếu đó. Nếu có giữ chỗ, tổng lượng đảo trên số dư phải nằm trong lượng khả dụng. Bút toán lịch sử thiếu `packagingPortionIds` dùng toàn bộ số dư để chọn phần đóng gói.

Lệnh chuyển `DRAFT`, `OPEN` hoặc `PARTIAL` trên cùng số dư, lượt đếm kiểm kê tại vị trí từ lúc ghi nhập, hoặc phần tồn bị giữ do báo lỗi đang hiệu lực đều chặn đảo. Các điều kiện này áp dụng trên số dư hoặc vị trí chung. Chứng từ phụ thuộc cũng chặn trừ khi đã `CANCELLED`, `REJECTED` hoặc `REVERSED`. Chứng từ trả NCC và xuất giữ hộ còn hiệu lực được báo theo loại, mã và trạng thái. Lệnh chuyển vị trí lấy các phần đóng gói theo thứ tự trên số dư sau khi lọc loại đóng gói nếu có.

Tái kiểm hàng giữ hộ được giữ làm lịch sử. Phiếu nhập từ giữ hộ còn hiệu lực phải hủy nếu nháp hoặc đảo nếu đã ghi. BE lần theo bút toán đảo để nhận diện phần thùng đã tách và trả về đúng dòng giữ hộ. Đảo giữ hộ tăng phiên bản và chấm dứt việc thực hiện quyết định cũ. Tái kiểm và quyết định xử lý giữ hộ vẫn yêu cầu bằng chứng.

Chi tiết phiếu giữ hộ NCC trả `capabilities.cancel` cho nháp với quyền cập nhật và `capabilities.reversePreflight` cho phiếu đã ghi với cả hai quyền đảo và ghi sổ trong kho. Preflight kiểm theo dữ liệu lúc đọc. Lệnh đảo kiểm lại điều kiện, phiên bản, khóa vị trí và sức chứa trong transaction. [Routes nhận mua và giữ hộ](../../../src/modules/po-receiving/po-receiving.routes.js), [kiểm điều kiện và ghi đảo](../../../src/modules/po-receiving/purchase-correction.service.js).

## Sửa kết quả kiểm đã xác nhận

`GET /goods-inspections/:id/correction-preflight` cần `goods_receipt_inspection:update` và quyền vào kho. API trả `{ eligible, blockers, inspectionVersion, reason? }`. Khi phiếu chưa `CONFIRMED` hoặc thiếu hàng đến, `eligible` là `false`, `blockers` rỗng và `reason` mô tả điều kiện chưa đạt. Chi tiết phiếu trả `capabilities.correct` nếu phiếu đã xác nhận, chưa có bản thay thế và người gọi có quyền cập nhật trong kho. Chi tiết phiếu kiểm cũng trả `replacedBy: { _id, documentNo, workflowStatus } | null`, tức bản kiểm thay thế chưa hủy có `header.previousInspectionId` trỏ về phiếu này. FE dùng trường này để đánh dấu phiếu cũ chỉ còn là lịch sử và mở bản thay thế (bổ sung 20/11/2026 theo yêu cầu người dùng).

Mỗi phần tử trong `blockers` có `documentType`, `documentId`, `documentNo`, `workflowStatus`, `action` và `message`. Thứ tự là phiếu nhập từ giữ hộ, phiếu nhập trực tiếp, phiếu giữ hộ, bản kiểm thay thế rồi chứng từ trả NCC liên kết trực tiếp. BE dò cả phiếu nhập tham chiếu lần tái kiểm qua chứng từ giữ hộ. `action` nhận `CANCEL_RECEIPT`, `REVERSE_RECEIPT`, `CANCEL_CUSTODY`, `REVERSE_CUSTODY`, `USE_REPLACEMENT` hoặc `null` cho chứng từ chỉ báo loại, mã và trạng thái.

`POST /goods-inspections/:id/corrections` dùng cùng quyền và nhận form kiểm nhận mới (`expectedPoVersion`, `arrivedAt`, `deliveryReference?`, `deliveredBy?`, `lines`). Gửi dòng mới với ID dòng PO và bỏ ID dòng kiểm cũ. Thêm `expectedVersion`, `operationKey`, `reason` và `evidenceIds?`. Bằng chứng gửi kèm phải gắn vào phiếu kiểm gốc. Nếu còn chứng từ chặn, API trả HTTP `400`, `code: "ERR-CORE-400-001"`, thông báo tổng số và toàn bộ danh sách trong `fieldErrors` theo cùng định dạng với `blockers`. Thành công trả ID phiếu kiểm mới `DRAFT` có `header.previousInspectionId`. [Kiểm và tạo bản thay thế](../../../src/modules/po-receiving/purchase-correction.service.js).
