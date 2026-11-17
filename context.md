17/11/2026 — Kho 3D: lớp hàng nhiều mã/lô và số thùng là nhãn phương án; measuredCargoHeight là cao phần hàng, cộng đế một lần; actualHeight cũ vẫn là tổng cao. Vượt cao chỉ cảnh báo, vẫn lưu/áp dụng. X/Y pallet tương đối trong ô, xoay theo khu. Xem git_doc/docs/10_Kho3D/STAGE3_PALLET_LAYERS.md. Không ghi tồn hoặc rollout DB.

17/11/2026 — Người dùng duyệt BF03 chuyển nhiều lần trên cùng lệnh: OPEN → PARTIAL → CONFIRMED; mỗi lần chỉ ghi lượng thực chuyển của các dòng chọn. Lượng còn lại tính từ ledger, hủy chỉ phần chưa chuyển, giữ lịch sử và tồn đã chuyển. Chưa có chuyến mới được sửa kế hoạch; không tự mở thùng. Hợp đồng: git_doc/docs/08_api/location-movements/README.md.

17/11/2026 — Xuất hàng được mở thùng và nhập lẻ số thùng theo quyết định người dùng. Ví dụ 1,5 thùng × 4 viên = 6 viên; vẫn kiểm lượng nguyên theo ĐVT gốc. Lưu snapshot quy đổi hiện hành và phần OPEN còn lại; volumeUpperBoundMm3 là giới hạn thể tích bảo thủ, không giả số đo. Chỉ bật cho xuất bán/xuất khác, BF04 picking/dispatch, trả NCC và thực hủy; BF03/nhập kho giữ quy tắc cũ. Xem git_doc/docs/08_api/GOODS_ISSUES.md.

16/11/2026 — Quyết định mới UC-69–72: form tạo chung 5 lý do xuất; Xuất bán và Xuất khác nhập mã tham chiếu tay, sản phẩm/số lượng/ghi chú, không bắt buộc SO/WIR/OD. SALES chỉ Xuất bán, tạo PENDING_APPROVAL; Owner khác creator duyệt đúng phiếu sang DRAFT, không sinh SO/phiếu mới/giữ hàng/trừ tồn. Kho chọn lô/ô khi tạo TO, PGI mới trừ tồn. Điều chuyển/trả NCC/hủy dùng chứng từ nguồn và native command trong form chung. Seed quyền bổ sung create/update cho SALES, approve cho OWNER, giữ các quyền khác. Hợp đồng chính: git_doc/docs/08_api/GOODS_ISSUES.md.

> 12/11/2026: [Phạm vi HieuDT 20 UC mới](git_doc/docs/08_api/HIEUDT_WAREHOUSE_SCOPE.md) theo bảng người dùng: kho/vị trí, tồn, BF03, BF04, đối soát và nhật ký. Đây là nguồn đối chiếu phạm vi hiện tại; các khả năng 18 UC trước vẫn được giữ. Native warehouse-stock thay route demo, không fallback dữ liệu mẫu.

> 10/11/2026: [18 UC HieuDT, ba iteration](git_doc/docs/08_api/HIEUDT_ITERATIONS_NATIVE.md) đã nối API native cho bán/soạn, BF03/BF04, chốt kiểm kê và báo cáo. Mã UC trong tài liệu theo kế hoạch HieuDT gốc. Trạng thái kiểm chứng và điều kiện đầu vào xem hợp đồng; không suy mọi prototype đã hoàn tất.

> Quyết định 09/11/2026 bổ sung [Conversion theo sản phẩm và lô](git_doc/docs/08_api/CONVERSIONS.md). [Iteration 1 native](git_doc/docs/08_api/ITERATION1_NATIVE_2026-11-06.md) tiếp tục áp dụng cho NCC, giữ hộ và đảo nhập.

# Backend context

The runtime uses one registry: `src/models/index.js` exports `registerModels(connection)`; `runtime.js` supplies API models. There are 58 collection schemas directly under `src/models`. Nested schemas do not create collections. `registerReviewedModels` is a compatibility alias. Pure historical transforms and synthetic fixtures under `src/migrations/rebuild` and `src/seeds/rebuild` remain for regression checks.

Start with [PROJECT_GUIDE](git_doc/PROJECT_GUIDE.md), [MODEL_MAP](git_doc/MODEL_MAP.md), [native runtime contract](git_doc/docs/08_api/NATIVE_MODEL_RUNTIME.md) and [documentation rules](git_doc/DOCUMENTATION_RULES.md). The paired frontend is `../fe`.

No automatic commit/push. No remote writes as part of the model synchronization. Preserve dated deployment evidence. D07/D08 remains unresolved.

## Historical return-source decision — 7 November 2026

The user confirmed Accountant verification with uploaded evidence for historical customer-delivery sources. This scope is implemented in [the native return contract](git_doc/docs/08_api/RETURN_WORKFLOWS_NATIVE.md). It does not settle broader new-SO external-source gates. Trungph return workflows now use the native registry; local automated verification and rollout limits are recorded in that contract and the PR evidence. No Atlas data or connection change.

12/11/2026: code Kho 3D chặng 1: warehouses.layout3d, API lưu theo updatedAt và scope; xem git_doc/docs/10_Kho3D/IMPLEMENTATION.md. Chưa có khu vực/ô/pallet và chưa rollout DB.

12/11/2026: Kho 3D chặng 2 mở rộng layout3d cho functions/zones/slots, maxStackHeight và snapshot layout3dApplied/layout3dAppliedAt. PUT layout thêm apply, kiểm containment khi apply và warehouse_layout_function:update khi đổi danh mục chức năng. Danh sách catalogue không trả payload thiết kế. Hợp đồng git_doc/docs/10_Kho3D/STAGE2_ZONES.md.

Kho 3D: functionId rỗng hợp lệ ở nháp, không hợp lệ khi apply; functionId có giá trị phải tồn tại trong functions. Danh mục vẫn kiểm quyền quản trị, không khóa vẽ nháp khi danh mục trống.
