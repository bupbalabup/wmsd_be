18/11/2026 — BF03 theo yêu cầu người dùng: tùy chọn chuyển thùng nguyên + viên rời, ô viên rời xuống dòng 2. Lưu từng phần SEALED/LOOSE trên hai item để xác nhận từng chuyến đúng loại; không tự mở thùng, không dùng OPEN thay hàng rời. Chỉ explicit LOOSE được tách phần có thể tích biết trước bằng giới hạn bảo thủ. Schema thêm optional details.packagingState, không collection/index/migration. [Hợp đồng](docs/08_api/location-movements/README.md#mixed-sealed-cartons-and-loose-pieces--18-november-2026).

## Receiving corrections — 20 November 2026

Receiving fixes preserve source claims across CR reassessment, inspected packaging and measured volume on direct returns, and usable defect holds on damaged transfer receipts. Sales sees only linked TRANSFER receipt status within warehouse scope and owned direct FAILED_DELIVERY receipts. OTHER reversal is available in the receipt UI; evidence cannot invalidate an approved receipt. Purchase inspection creation contends with cancellation on its source PO without changing its version. See [receipt contract](docs/08_api/GOODS_RECEIPTS.md) and [return contract](docs/08_api/RETURN_WORKFLOWS_NATIVE.md). No historical record repair or shared-database rollout is included.

## Phạm vi chức năng hiện hành

Phạm vi hiện hành ngày 26/11/2026 có hai cách lập phiếu xuất bán: đơn bán mới dùng lịch giao và giữ tồn FIFO theo lịch; phiếu bán độc lập dùng mã tham chiếu ngoài, Sales gửi chờ duyệt và Kho vận chỉ soạn sau khi Owner khác duyệt. Cả hai đều cần phiếu xuất đã ghi sổ làm nguồn khách trả. Không có danh mục khách hàng; lưu tên/SĐT theo chứng từ. Hàng trả khách được kiểm, Sales quyết định, rồi Kho vận chỉ ghi nhập phần được chấp nhận. Trả nhà cung cấp vẫn theo thỏa thuận nguồn riêng: Kế toán ghi nhận phản hồi NCC, sau đó đối chiếu/đóng; ACK không ghi tồn lần nữa.

Nguồn yêu cầu: [Report 3, phạm vi và BF-06/BF-07](docs/01_bao_cao/WMSD_Report3_Fix.docx.txt). Thiết kế tương ứng: [Report 4](docs/01_bao_cao/WMSD_Report4_Draft.md). Các mô tả WIR/OD/picking bán hàng/danh mục khách phía dưới là lịch sử hoặc tương thích runtime khi trái phạm vi này. Lượt cập nhật tài liệu không thay code, quyền, collection hay dữ liệu.

## Historical sales and returns snapshot — 17 November 2026

This dated snapshot records the then-current Sales Order → direct Goods Issue path and inline handling of unreceived goods. It is retained for older documents and compatibility; the current scheduled-order and standalone external-reference paths are described above and in [the Goods Issue contract](docs/08_api/GOODS_ISSUES.md). New customer-return inspections record facts only; acceptance authorizes receipt, and only receipt posts STORE stock. Optional issue header/order/customer/sourceBalance and embedded customerReceipts, CR intakeMode/handbacks, and FAILED_DELIVERY receipt goodsIssueId add no collection.

## Customer return source rules — 18 November 2026, extended 25 November

Customer Return may start from a posted SALE Goods Issue with or without a Sales Order. The source picker can search by issue number or external reference and shows the actual outbound lots and remaining quantity. SO-linked issue lines use evidence-backed customer receipt less claims; standalone issue lines use posted quantity less undelivered receipts and outstanding claims. A request may split quantities across source lots, with each lot cap rechecked by the backend. Warehouse inspection records facts without stock movement, Sales accepts/rejects, and Warehouse receipt posts only the accepted amount. See [current contract](docs/08_api/RETURN_WORKFLOWS_NATIVE.md).

17/11/2026 — Kho 3D [lớp pallet](docs/10_Kho3D/STAGE3_PALLET_LAYERS.md): nhập mã/lô/số thùng như phương án; không tạo balance/chứng từ. Cao đo phần hàng cộng đế; giữ nghĩa actualHeight lịch sử. Vượt giới hạn khu/kho chỉ cảnh báo, không chặn lưu/áp dụng theo quyết định trực tiếp người dùng.

17/11/2026 — Người dùng duyệt BF03 chuyển nhiều lần trên cùng lệnh: OPEN → PARTIAL → CONFIRMED; mỗi lần chỉ ghi lượng thực chuyển của các dòng chọn. Lượng còn lại tính từ ledger, hủy chỉ phần chưa chuyển, giữ lịch sử và tồn đã chuyển. Chưa có chuyến mới được sửa kế hoạch; không tự mở thùng. Hợp đồng: docs/08_api/location-movements/README.md.

17/11/2026 — Xuất hàng được mở thùng và nhập lẻ số thùng theo quyết định người dùng. Ví dụ 1,5 thùng × 4 viên = 6 viên; vẫn kiểm lượng nguyên theo ĐVT gốc. Lưu snapshot quy đổi hiện hành và phần OPEN còn lại; volumeUpperBoundMm3 là giới hạn thể tích bảo thủ, không giả số đo. Chỉ bật cho xuất bán/xuất khác, BF04 picking/dispatch, trả NCC và thực hủy; BF03/nhập kho giữ quy tắc cũ. Xem docs/08_api/GOODS_ISSUES.md.

16/11/2026 — Quyết định mới UC-69–72: form tạo chung 5 lý do xuất; Xuất bán và Xuất khác nhập mã tham chiếu tay, sản phẩm/số lượng/ghi chú, không bắt buộc SO/WIR/OD. SALES chỉ Xuất bán, tạo PENDING_APPROVAL; Owner khác creator duyệt đúng phiếu sang DRAFT, không sinh SO/phiếu mới/giữ hàng/trừ tồn. Kho chọn lô/ô khi tạo TO, PGI mới trừ tồn. Điều chuyển/trả NCC/hủy dùng chứng từ nguồn và native command trong form chung. Seed quyền bổ sung create/update cho SALES, approve cho OWNER, giữ các quyền khác. Hợp đồng chính: docs/08_api/GOODS_ISSUES.md.

15 November 2026 — quantity workflow refinements: CR can split a verified sale source into independently inspected/decided request parts, retaining cumulative source caps. BF02 can propose multiple disposition outcomes against one hold, with combined in-flight plan limits. Refused CR parts can be handed back after the accepted part is received; approved stock cannot be consumed by handback. Details expose posted-document quantity progress and remaining caps. See docs/08_api/RETURN_WORKFLOWS_NATIVE.md for the current DTO, historical conversion and stage rules.

> 13/11/2026: [Vòng đời kiểm kê BF-05](docs/08_api/STOCKTAKE_LIFECYCLE.md) là hợp đồng hiện hành cho các lệnh kiểm kê trước bước chốt UC-93.

14 November 2026 — user-approved receiving alternate flow: non-GOOD inspection quantities must enter supplier custody. Confirm creates CustodyReceipt DRAFT; Warehouse posts before starting SupplierReturn. Custody detail offers a scoped per-line proposal, then Accountant agreement, Warehouse CustodyRelease dispatch and Accountant ACK/closure. No DefectReport or store-owned issue for this intake incident. Canonical API contracts: docs/08_api/NATIVE_MODEL_RUNTIME.md and RETURN_WORKFLOWS_NATIVE.md.


> 13/11/2026: [Vòng đời kiểm kê BF-05](docs/08_api/STOCKTAKE_LIFECYCLE.md) là hợp đồng hiện hành cho các lệnh kiểm kê trước bước chốt UC-93.
> 12/11/2026: [Phạm vi HieuDT 20 UC mới](docs/08_api/HIEUDT_WAREHOUSE_SCOPE.md) theo bảng người dùng: kho/vị trí, tồn, BF03, BF04, đối soát và nhật ký. Đây là nguồn đối chiếu phạm vi hiện tại; các khả năng 18 UC trước vẫn được giữ. Native warehouse-stock thay route demo, không fallback dữ liệu mẫu.

> 11/11/2026: BF03 dùng bảng chọn hàng theo kho/vị trí, chỉ số nguyên thùng/viên; không tự mở thùng. Luồng tạo/sửa kiểm quy cách ngay trước lưu. Thử đơn vị/quy đổi trên DB local riêng và chờ người dùng kiểm tra trước triển khai lên wmsd_database.

> 10/11/2026: [Hợp đồng 18 UC HieuDT](docs/08_api/HIEUDT_ITERATIONS_NATIVE.md) là nguồn hiện hành cho SO/WIR/OD/picking, chốt kiểm kê và báo cáo; [kiểm thử local](docs/09_phat_trien/HIEUDT_LOCAL_TESTS.md). Chốt kiểm kê kiểm phê duyệt đúng nội dung, count mới nhất, thực hiện/bằng chứng trước khi ghi tồn và mở khóa nguyên tử.

> Quyết định 09/11/2026 bổ sung [Conversion theo sản phẩm và lô](docs/08_api/CONVERSIONS.md). [Iteration 1 native](docs/08_api/ITERATION1_NATIVE_2026-11-06.md) tiếp tục áp dụng cho NCC, giữ hộ và đảo nhập.

# WMSD — Hướng dẫn chung khi phát triển

Mốc tổng hợp 05/11/2026. Phạm vi cửa hàng gạch ốp lát, nhiều kho, sản phẩm/lô, mua–nhập, chuyển, bán–giao, hàng lỗi/trả và kiểm kê. Các dữ kiện dưới đây là thiết kế đã duyệt; trạng thái triển khai được ghi riêng.

## 1. Phân biệt thiết kế và runtime

The runtime uses one registry: `src/models/index.js` exports `registerModels(connection)`; `runtime.js` supplies API models. There are 59 collection schemas (`*.model.js`); five GoodsReceipt kinds share `goods_receipts`. Nested schemas do not create collections. `registerReviewedModels` is a compatibility alias. Pure historical transforms and synthetic fixtures under `src/migrations/rebuild` and `src/seeds/rebuild` remain for regression checks.

[Hợp đồng runtime mới](docs/08_api/NATIVE_MODEL_RUNTIME.md) phân biệt API đã chuyển và phạm vi kiểm chứng. Việc có schema cho một nghiệp vụ không có nghĩa mọi màn hình demo đã thành chức năng vận hành.

[Hợp đồng GoodsReceipt BE](docs/08_api/GOODS_RECEIPTS.md) là nguồn hiện hành cho năm loại phiếu nhập, quyền tách riêng khách trả/giao thất bại, phiếu `OTHER`, Bỏ ghi và API đã gỡ. FE dùng danh sách phiếu nhập gộp, chi tiết theo loại và form ghi tồn từ chứng từ nguồn. Kiểm hàng và tạm giữ có màn hình riêng. Nhập mua hoàn tất ở `POSTED`. Kho dùng Chuyển vị trí (BF03) để đưa hàng từ RECEIVING lên STORAGE, với quyền `stock_relocation:read/create/confirm` theo từng thao tác. Bán hàng chọn tồn tại STORAGE có `isPickable`. Xếp hàng điều chuyển liên kho thực hiện qua ITR (BF04).

Warehouse có thể hủy phiếu giữ hộ nhà cung cấp còn nháp với quyền cập nhật kiểm nhận. Đảo phiếu giữ hộ đã ghi cần cả quyền đảo và ghi nhập tại kho. Đảo phiếu nhập hoặc giữ hộ dựa vào phần đóng gói của phiếu tại vị trí gốc. Khi kiểm nhận đã xác nhận cần sửa, preflight liệt kê phiếu nhập, phiếu giữ hộ và các chứng từ liên quan phải xử lý trước. [Điều kiện hủy, đảo và sửa kiểm nhận](docs/08_api/GOODS_RECEIPTS.md#hủy-nháp-và-đảo-phiếu).

## 2. Thứ tự dùng nguồn

1. Quyết định trực tiếp mới nhất của người dùng trong phạm vi công việc.
2. Các phiếu đã duyệt và [nhật ký duyệt](docs/03_thiet_ke/DB_Rebuild_Review/04_Nhat_ky_duyet.md).
3. Hướng dẫn này, MODEL_MAP, Data Dictionary và schema code khi xác định hiện trạng.
4. Hợp đồng module hiện có để bảo toàn tương thích trong giai đoạn chuyển API.
5. Baseline UC/report/quy trình cũ cho phần còn phù hợp. Dùng cả tên UC và crosswalk khi mã số đã được đổi.

Code thực tế chứng minh hiện trạng triển khai, không tự thay quyết định nghiệp vụ. Nếu quyết định chưa rõ, ghi điểm mở và hỏi đúng phần phụ thuộc. D07/D08 về xác minh chứng từ nguồn vẫn chờ người phụ trách, không tự đánh dấu đã duyệt.

## 3. Quyết định cần nắm trước khi sửa bất kỳ model nào

| Chủ đề | Quy tắc đã chốt | Nguồn chi tiết |
|---|---|---|
| Tài khoản/quyền | Một user có một role, có thể phụ trách nhiều kho. Tên role kho là Warehouse Staff. Admin được tạo role và tick quyền có sẵn, role mới thực hiện theo quyền. Kiểm thêm kho, người tạo, trạng thái và tách người duyệt khi luồng yêu cầu. | [A01–A03](docs/03_thiet_ke/DB_Rebuild_Review/02_Duyet_tai_khoan_va_phan_quyen.md) |
| SKU và lô | Nhận diện sản phẩm bằng hãng + SKU hãng + màu; khác màu là productId khác. Sản phẩm có lengthMm/widthMm/heightMm của từng viên. Lô theo productId + manufacturerLot; không có calibre/tone. Số viên/thùng cố định theo lô, kích thước ngoài thùng ghi thực tế, không suy từ thể tích viên. | [B04/B05 hiện hành](docs/03_thiet_ke/DB_Rebuild_Review/39_San_pham_va_lo_dang_chot.md) |
| Đơn vị/thùng | Uom giữ mã, tên, trạng thái và dấu hiệu đơn vị thùng. Conversion giữ hệ số theo sản phẩm, lô tùy chọn và ngày hiệu lực. Chứng từ lưu snapshot hệ số và quy cách. Một thùng vật lý chỉ chứa một sản phẩm, một lô. Gộp thùng cùng sản phẩm, lô và quy cách trên một dòng. | [Quy đổi](docs/08_api/CONVERSIONS.md), [nhận thùng](docs/03_thiet_ke/DB_Rebuild_Review/15_Duyet_hang_den_kiem_nhan_va_phieu_nhap.md) |
| Kho và sức chứa | Ô giữ chiều dài/rộng; chiều cao dùng chung từ kho. Không quản lý chồng. packagingPortions[] giữ thùng nguyên/hàng lẻ và thể tích thực đo. BE kiểm cạnh thùng vừa ô và tổng thể tích. Chưa có tọa độ xếp kiện nên lượng thùng còn xếp được chỉ là ước tính; 3D triển khai sau. | [B01/B02](docs/03_thiet_ke/DB_Rebuild_Review/05_Duyet_kho_vi_tri_don_vi_tinh.md), [quy cách và kiểm sức chứa](docs/03_thiet_ke/DB_Rebuild_Review/39_San_pham_va_lo_dang_chot.md) |
| Kho 3D — yêu cầu mới 12/11, chưa triển khai | Thiết kế mặt bằng đa giác, khu chữ nhật xoay, ô thuộc khu; pallet nhiều sản phẩm/lô và lớp hàng; chồng pallet, đồng bộ thao tác 2D/3D; giới hạn chiều cao theo kho/khu và cảnh báo vẫn cho lưu. Đây là mục tiêu phát triển tiếp theo, không mô tả runtime đã có hoặc tự bỏ kiểm sức chứa giao dịch ở dòng trên. | [Đặc tả Kho 3D và điểm tích hợp còn mở](docs/10_Kho3D/README.md) |
| Người mua/NCC/bàn giao | Người mua được ghi theo chứng từ, không có danh mục khách trong phạm vi mới. Danh mục NCC vẫn giữ; không quản lý delivery riêng. | [B08A](docs/03_thiet_ke/DB_Rebuild_Review/08A_Khach_hang.md), [B08B](docs/03_thiet_ke/DB_Rebuild_Review/08B_Nha_cung_cap.md), [bàn giao H11](docs/03_thiet_ke/DB_Rebuild_Review/17_Duyet_phieu_xuat_nhan_va_ban_giao_chuyen_kho.md) |
| RR và PO | Một RR tối đa một PO còn hiệu lực, một PO thuộc một RR, một NCC, một kho. Lượng gốc là căn cứ duyệt, đặt và đối chiếu khi nhận. Accountant chọn đơn vị theo từng dòng khi lập hoặc sửa nháp. Chỉ đơn vị thùng được vượt lượng duyệt và chỉ đặt số thùng nguyên nhỏ nhất đủ phủ lượng duyệt. Accountant lập và cùng Owner xem giá mua/tổng tiền. | [H01/H02](docs/03_thiet_ke/DB_Rebuild_Review/13_Duyet_yeu_cau_bo_sung_va_don_mua.md) |
| Giá bán/hóa đơn | SO lưu giá bán, quy đổi và giá lịch sử. Accountant lập hóa đơn cuối theo SO, mỗi SO tối đa một bản đang hiệu lực. Ghi từng phiếu/ngày xuất và lượng xuất, tính tiền theo lượng khách nhận. 100 xuất/98 nhận thì hiển thị 100 và tính 98. | [H12](docs/03_thiet_ke/DB_Rebuild_Review/18_Duyet_don_ban_yeu_cau_xuat_va_lenh_giao.md), [H37](docs/03_thiet_ke/DB_Rebuild_Review/19_Duyet_xuat_ban_giao_nhan_va_hoa_don.md) |
| Tiền và nguồn ngoài | Sales xác nhận nhận đủ tiền bên ngoài theo H17. WMSD không tích hợp trực tiếp MISA hoặc thực hiện thu/chuyển tiền, công nợ. Chưa suy ra cơ chế xác minh nguồn D07/D08 từ khả năng tạo SO. | [H17](docs/03_thiet_ke/DB_Rebuild_Review/20_Duyet_xac_nhan_tien_ngoai.md), [D07/D08](docs/03_thiet_ke/DB_Rebuild_Review/33_Duyet_lich_su_quyet_dinh_va_tep_dinh_kem.md) |
| Cách lưu | Collection riêng cho từng nghiệp vụ. Dòng hàng có `_id` ổn định trong `items[]`. Liên kết chứng từ/dòng đặt ở đúng nguồn xử lý. Bàn giao nằm trong phiếu xuất. | [D01](docs/03_thiet_ke/DB_Rebuild_Review/31_Duyet_cach_to_chuc_ho_so_nghiep_vu.md), [D02–D04](docs/03_thiet_ke/DB_Rebuild_Review/32_Duyet_dong_hang_va_lien_ket_chung_tu.md) |

Không tạo general policy editor. Danh mục quyền được định nghĩa bởi chức năng phần mềm, không cho Admin nhập tùy ý mã thao tác mới. Khi thêm quyền cho tính năng mới, cập nhật catalogue, mặc định role và đặc tả quyền trong cùng thay đổi.

## 4. Chuỗi nghiệp vụ và hiệu ứng tồn

| Luồng | Chuỗi và mốc xác nhận |
|---|---|
| BF01 mua/nhập | RR → duyệt → kế toán chốt với NCC → lập và phát hành PO → hàng đến → kiểm nhận → nhập sở hữu → xếp hàng. Sửa nội dung khi PO còn nháp. Khi `OPEN`/`PARTIAL`, đổi ngày dự kiến chung cho phần chưa nhận bằng lệnh có lý do. Theo dõi các lần nhận qua phiếu kiểm và phiếu nhập. Ngừng chờ phần chưa nhận qua quy trình duyệt đóng. Hàng giữ hộ ghi chủ riêng. Nhận sở hữu hàng đã giữ hộ chuyển đúng chủ, không nhận vật lý lần hai. |
| BF02 hàng lỗi | Phát hiện/chặn đúng lượng → đề xuất → duyệt cách xử lý → thực hiện. Chặn giữ nguyên tổng. Hủy thực tế mới giảm. Trả NCC đi BF08. |
| BF03 chuyển ô | Create TO → Confirm TO. Người tạo sửa/hủy trước confirm và tự confirm. Mỗi TO xác nhận trọn lệnh một lần. Chuyển hai ô cùng kho giữ tổng, lô, chủ và liên kết giữ hàng. |
| BF04 liên kho | TR → Owner duyệt/từ chối có lý do → phiếu xuất tại Tạo phiếu xuất kho → yêu cầu lấy hàng sinh TO → confirm PICK đồng thời xuất đi → nhận tại kho đích tự sinh ITR/TO PUTAWAY cho hàng tốt → chọn vị trí trên trang TO riêng và confirm → tự hoàn thành TR đủ lượng/đủ điều kiện. Thiếu lượng chỉ đóng thủ công qua dừng chuyển tiếp có lý do. Báo chênh lệch cần quyền và phân công thực tế tại kho đích. Đơn phiếu/Nhiệm vụ/Báo cáo mở qua ba nút trên đơn. |
| BF04 số đợt | Một TR nhiều phiếu xuất, mỗi phiếu xuất nhiều phiếu nhận. Khi chọn lô trên đơn, có thể phân bổ một phần theo ô nguồn. Khi lập phiếu xuất, ưu tiên các lượng đã phân bổ và lấy phần còn lại từ tồn khả dụng của cùng lô. Người nhận khác người xuất. Hàng lỗi vào QUARANTINE trong kho nhận. Nhận thực tế giảm transit, PUTAWAY chỉ chuyển vị trí. [BF04 source locations](docs/08_api/transfers/BF04_API.md#source-locations-on-transfer-requests--22-november-2026). |
| BF05 kiểm kê | **Hiện hành từ 22/11/2026** (quyết định người dùng 22/11/2026 theo phản hồi giảng viên: tách kế hoạch/phiếu, bỏ đếm mù, đối chiếu đơn giản, bỏ lý do chốt): Owner lập kế hoạch định kỳ (`stocktake_plans`) hoặc phiếu ad-hoc → tạo phiếu từ kế hoạch → Warehouse kích hoạt khóa ô + snapshot → đếm (thấy số sổ + ĐVT)/đếm lại giữ lịch sử; xác nhận ô trống sai có lệnh sửa append-only → Warehouse đối chiếu → Owner **đếm lại** từng dòng hoặc **duyệt chênh lệch** (Clear Difference, UC-93) theo dòng được chọn: ghi tồn về số đã đếm trong một transaction, hết dòng thì COMPLETED và mở khóa. Không còn phương án/duyệt/thực hiện và không còn lý do chốt. Lịch sử 13–18/11/2026 (đếm mù, phương án): xem [STOCKTAKE_LIFECYCLE](docs/08_api/STOCKTAKE_LIFECYCLE.md). |
| BF06 đơn bán/xuất kho | Đơn bán mới → lịch giao và giữ tồn FIFO → Warehouse ghi phiếu xuất cho lịch; Sales lưu bằng chứng khách nhận trên phiếu đã ghi sổ. Luồng bán độc lập: Sales lập SALE bằng mã ngoài → Owner khác duyệt → Warehouse chọn lô, soạn và ghi xuất. |
| BF07 khách trả | Chọn dòng phiếu xuất bán đã ghi sổ theo mã phiếu/mã ngoài và lô thực xuất → Warehouse kiểm thực tế (không đổi tồn) → Sales chấp nhận/từ chối → Warehouse ghi nhập phần được chấp nhận. Hạn mức theo từng dòng/lô được BE kiểm lại. Lịch sử nguồn đã xác minh vẫn dùng được. |
| BF08 trả NCC | Warehouse đề nghị từ nguồn NCC phù hợp → Accountant xác minh thỏa thuận → Warehouse ghi xuất hàng sở hữu cửa hàng hoặc bàn giao hàng giữ hộ → Accountant ghi ACK riêng rồi đối chiếu/đóng khi đã giải trình. ACK/đóng không ghi tồn lần hai; không cần Owner duyệt. |

Đọc phiếu H06–H11, H18–H36 và C01–C08 trong [bộ duyệt](docs/03_thiet_ke/DB_Rebuild_Review/01_Danh_muc_duyet.md) trước sửa nhóm tương ứng.

Opening stock exception — explicit user decision, 16 November 2026: only Owner may import and confirm opening stock, including their own draft, once per warehouse. This supersedes the older H36 preparer/verifier split for opening stock only. Other workflows retain their separation-of-duties rules. See [current contract](docs/08_api/EXCEL_AND_OPENING_STOCK.md).

Tồn đầu từ file ghi hàng tốt của cửa hàng vào `TONDAU-NHAN`, khu tiếp nhận được tạo khi lưu nháp có hàng. Sau khi ghi tồn, kho cất hàng vào khu lưu trữ bằng BF03. Xem [hợp đồng nhập tồn đầu](docs/08_api/EXCEL_AND_OPENING_STOCK.md#opening-stock-receiving).

## 5. Quy tắc dữ liệu dùng chung

- V5 đã [rà trường trên 58 bảng](docs/03_thiet_ke/DB_Rebuild_Review/38_Ra_soat_truong_58_bang.md). Đầu phiếu dùng một `version`, bỏ `revision` trùng. Các `approvedRevision`, `subjectRevision`, `scopeVersion`, phiên bản giá và nguồn giữ nguyên vai trò lịch sử. `status` không thay phép kiểm sửa đồng thời. Danh mục products/warehouses/customers/suppliers bỏ version, khi port API phải kiểm updatedAt của dữ liệu vừa đọc. Các FK đã được bảng cha xác định không lưu lặp trong phần nhúng.

- Số lượng/tiền dùng Decimal128 và helper decimal, API trả decimal string. Giữ nguyên hệ số, giá và quy cách đã ghi trên chứng từ cũ.
- Tồn theo điểm giữ hàng + lô + chất lượng + chủ. Hàng transit, hàng giữ hộ, hàng đã giữ cho nhu cầu được theo dõi riêng. Hàng chưa nhận không tính available.
- Xác nhận tồn phải nguyên tử với balance, transaction, movement, chứng từ, hạn mức/giữ hàng, audit và outbox. Cùng request key/payload trả lại kết quả cũ, key khác nội dung phải báo xung đột.
- Kiểm active user, permission hiện tại, warehouseIds, nguồn, creator/approver/receiver, trạng thái, revision, freeze, số lượng còn lại và sức chứa ngay khi ghi. UI không thay kiểm quyền BE.
- Khoá tài khoản qua lệnh đổi trạng thái phải nhập lý do. Xem quy tắc lưu lý do và ghi nhật ký trong [hợp đồng trạng thái tài khoản](docs/08_api/USER_ACCESS_STATUS.md).
- Người dùng tự đặt lại mật khẩu qua email đã được triển khai (UC-145, trước đây UC-131; từ 23/11/2026): yêu cầu OTP ở màn đăng nhập (`POST /api/auth/forgot-password/otp`), nhập mã và mật khẩu mới (`POST /api/auth/forgot-password/reset`). Administrator yêu cầu OTP từ chi tiết tài khoản (UC-160, trước đây UC-132) vẫn đang chờ triển khai. Luồng, quyền và ngoại lệ nằm trong [Report 3](docs/01_bao_cao/WMSD_Report3_Fix.docx.txt).
- Chứng từ đã ghi tồn, snapshot, kết quả đếm và lịch sử duyệt giữ dấu vết. Sửa sai dùng phiếu đảo/điều chỉnh có nguồn và kiểm phụ thuộc.
- Tệp/bằng chứng theo quyền phiếu và kho. Không lộ giá mua, giá bán hoặc chứng cứ nội bộ qua DTO, export hay audit ngoài quyền.
- Email/notification qua outbox sau commit. Lỗi gửi thư chỉ thử gửi lại.

## 6. Kiểm chứng và giới hạn hiện tại

Mốc BF03/BF04 07/11: đã kiểm 5/5 native integration trên localhost replica test,
gồm full BF03/replay, BF04/custom role và ca nhận toàn hàng hỏng. BF04 options
trả danh mục kho đích nhưng chỉ trả tồn/vị trí kho được phân công; một nguồn chỉ
sinh một ITR, mỗi ITR một TO. Chi tiết tại [BF03](docs/08_api/location-movements/README.md)
và [BF04](docs/08_api/transfers/BF04_API.md). FE build và 3 test presentation BF03
đạt; chưa kiểm toàn luồng qua trình duyệt.

Các API đang gắn router dùng registry mới. Ba kiểm thử tích hợp trên MongoDB replica set thử riêng đã qua: RR–PO–kiểm–nhập–xếp từng phần, đảo nhập với người duyệt độc lập, và chuyển kho đủ các bước. FE đã build nhưng toàn bộ kiểm thử giao diện còn lỗi do hợp đồng/kỳ vọng cũ; chưa xác nhận toàn project hoàn tất. D07/D08 vẫn chờ xác minh. Không tự ghi dữ liệu remote.

## 7. Quy trình làm việc của nhóm

Đọc [quy tắc tài liệu](DOCUMENTATION_RULES.md). Mỗi thay đổi code có ảnh hưởng model, API, quyền, nghiệp vụ, seed, cấu hình hoặc cách chạy phải sửa tài liệu hiện hành trong cùng lượt. Ghi quyết định chưa duyệt ở phần mở, không ghi thành đã chốt. Không đổi toàn bộ mã UC chỉ để khớp model đang làm.

## Gộp bảng lần hai

[Gộp thêm 5 bảng](docs/03_thiet_ke/DB_Rebuild_Review/37_Gop_them_5_bang.md). Biến động nằm trong giao dịch tồn; chặn và phương án lỗi trong hồ sơ lỗi; phương án kiểm kê trong đợt; khách nhận trong SO. Các lần phát sinh và quyền vẫn giữ.

## 8. Mốc triển khai DB ngày 06/11/2026

Atlas `wmsd_database` đã nhận dữ liệu chỉ còn gạch từ local `wmsd_demo_tile_shop_v7`: 59 collection/633 bản ghi. Giữ nguyên v6 để truy vết, không ghi đè dữ liệu đã có. Việc tải DB không đồng nghĩa các API đã port; kết nối ứng dụng chưa đổi. [Quy trình và kết quả](docs/09_phat_trien/ATLAS_DEPLOYMENT.md).

## 9. Category v8 và kiểm thư mục

Người dùng duyệt 5 nhóm sau tham khảo Gạch Tốt. Mỗi product có một categoryId bắt buộc; Category 1–n Product. Hãng/kích thước/màu giữ riêng. Không đổi nghiệp vụ tồn. Mốc hiện hành là local v8 và Atlas wmsd_database, 59 collection/638 bản ghi. Tại lúc thực hiện local v7 và Atlas đều trống, nên đã tạo lại mẫu; không coi các DB cũ là hiện còn trên máy. Đây là mốc trước yêu cầu đồng bộ runtime. Quyết định mới hơn ngày 06/11 đã cho phép bỏ cả ba thư mục model và các phụ thuộc được rà; xem hợp đồng runtime ở mục 1. [Chi tiết và nguồn duyệt](docs/03_thiet_ke/DB_Rebuild_Review/40_Category_va_don_model.md), [triển khai](docs/09_phat_trien/CATEGORIES_V8.md).

## Historical return-source decision — 7 November 2026

The user confirmed Accountant verification with uploaded evidence for historical customer-delivery sources. This scope is implemented in [the native return contract](docs/08_api/RETURN_WORKFLOWS_NATIVE.md). It does not settle broader new-SO external-source gates. Trungph return workflows now use the native registry; local automated verification and rollout limits are recorded in that contract and the PR evidence. No Atlas data or connection change.

## Cảnh báo bổ sung hàng — 11/11/2026

[Hợp đồng RR](docs/08_api/REPLENISHMENT_COVERAGE.md) quy định cảnh báo RR đang mở, PO chưa nhận đủ và tồn khả dụng. Người lập quyết định lượng, xác nhận và giải trình khi có cảnh báo. SO/WIR và kiểm kê là tham chiếu truy vết. Lý do từng dòng tùy chọn. Người duyệt độc lập xét lượng, còn PO dựa trên lượng RR đã duyệt.

Kho 3D chặng 1 đã có code vẽ nền/tường/cửa, dùng warehouses.layout3d và quyền kho hiện có; không áp bố trí vào tồn. Hợp đồng: [Kho 3D](docs/10_Kho3D/IMPLEMENTATION.md).

Kho 3D chặng 2: vùng chữ nhật xoay, ô local và danh mục chức năng riêng từng kho; lưu bản nháp và snapshot áp dụng tách biệt, kiểm phạm vi/updatedAt. Ô thiết kế có thể gán vị trí nghiệp vụ đã tạo trong cùng kho. Việc gán chỉ thay đổi thiết kế, không tự ghi tồn. Không đồng nhất chức năng tự tạo với enum vị trí nghiệp vụ. [Hợp đồng chặng 2](docs/10_Kho3D/STAGE2_ZONES.md).

Kho 3D: cho phép vẽ và lưu nháp khu vực chưa gán chức năng (functionId rỗng); áp dụng cần gán đầy đủ. Từ 18/11/2026, Chủ cửa hàng dùng quyền sửa kho để quản lý danh mục chức năng của mọi kho mà không cần phân công kho. Các vai trò còn lại cần thêm warehouse_layout_function:update và đúng kho đã được phân công. Xem [hợp đồng Kho 3D](docs/10_Kho3D/STAGE2_ZONES.md).
