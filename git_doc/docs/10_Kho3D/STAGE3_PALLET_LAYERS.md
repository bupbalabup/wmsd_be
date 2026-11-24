# Kho 3D — Lớp hàng và chiều cao pallet

Ngày 17/11/2026. Nguồn: yêu cầu tiếp tục Kho 3D và các quyết định trực tiếp trước đó về pallet nhiều mã/lô, nhập lớp hàng, đo thực tế, vượt cao chỉ cảnh báo. Đây là dữ liệu phương án thiết kế, không phải tồn kho hoặc chứng từ nhập/xuất.

## Sử dụng

Mở thiết kế kho → Khu vực & ô → chọn khu vực → chọn ô đã lưu. Chọn pallet cũ để sửa hoặc thêm pallet mới. Nhập mã, X/Y tương đối trong ô, rộng/dài và cao đế. Thêm các lớp từ dưới lên, mỗi lớp có chiều cao và các dòng mã sản phẩm, mã lô, số thùng nguyên dương. Nhiều dòng trong cùng lớp nằm cạnh nhau: chiều cao lớp chỉ cộng một lần, không nhân theo số thùng.

Mã sản phẩm/lô là nhãn phương án nhập tay, chưa đối chiếu danh mục hoặc giữ hàng. Không diễn giải các dòng này thành lượng tồn đã có. Xóa pallet chỉ xóa đối tượng thiết kế sau xác nhận, không xóa hàng. Nút **Lưu pallet** cập nhật bản đang vẽ; cần **Lưu bản nháp** hoặc **Áp dụng thiết kế** để ghi server.

Chiều cao hiệu lực:

1. Có `measuredCargoHeight`: `baseHeight + measuredCargoHeight`.
2. Không có số đo mới nhưng có `actualHeight` lịch sử: giữ nguyên tổng chiều cao lịch sử (đã gồm đế).
3. Có lớp: `baseHeight + sum(layers[].height)`.
4. Chưa có lớp: `baseHeight + stackHeight` để tương thích thiết kế cũ.

Sửa lớp/dòng hàng qua UI xóa số đo thay thế cũ và báo phải đo lại nếu muốn dùng số đo. Sửa cao hàng nhập trực tiếp cũng bỏ số đo cũ. Không tự tính chiều cao từ kích thước viên hoặc tổng thể tích. Không tự mở thùng.

Vượt giới hạn hiệu lực khu/kho: hiện cảnh báo có mã pallet, khu/ô, chiều cao, giới hạn và phần vượt; pallet được tô đỏ trên 2D/3D. Vẫn cho lưu **và áp dụng**, theo quyết định người dùng. Lỗi hình học, mã trùng hoặc lớp không hợp lệ vẫn chặn. Mức bằng giới hạn không cảnh báo (dung sai số thực 1e-7 m).

## Hợp đồng bổ sung

Giữ API/quyền/scope/optimistic `expectedUpdatedAt` tại [chặng 2](STAGE2_ZONES.md). Không thêm collection, index hay quan hệ nghiệp vụ. Field bổ sung trong `layout3d.zones[].slots[].pallets[]` và snapshot áp dụng:

| Field | Quy tắc |
|---|---|
| `measuredCargoHeight?` | number hữu hạn, 0–100 m, phần hàng không gồm đế |
| `layers?` | tối đa 100 lớp; bỏ trống dùng dữ liệu cao cũ |
| `layers[].id` | chuỗi ổn định, không trùng trong pallet |
| `layers[].height` | number hữu hạn, 0,01–100 m |
| `layers[].items` | 1–100 dòng; không tự gộp mã/lô |
| `items[].id` | chuỗi ổn định, không trùng trong lớp |
| `items[].productCode`, `lotCode` | chuỗi đã trim, 1–120 ký tự, nhãn thiết kế |
| `items[].cartons` | số nguyên dương an toàn trong JavaScript |

Tổng cao hiệu lực tối đa 100 m là giới hạn dữ liệu, khác giới hạn xếp của kho. Pallet phải nằm trọn trong ô; mã/id pallet duy nhất trong thiết kế. X/Y pallet tính từ góc ô; khi render cộng gốc ô rồi xoay theo khu, kể cả tâm và hướng khối 3D.

Response lưu thêm `data.warnings: string[]`; `data.issues` chỉ còn lỗi chặn áp dụng (vùng ngoài kho, thiếu chức năng). Không cần migration/backfill, không đổi ý nghĩa `actualHeight` cũ. FE và BE phải cùng phiên bản trước khi lưu các field mới; BE cũ dùng Zod strict sẽ từ chối payload mới.

## Giới hạn và kiểm chứng

Bổ sung [bố trí trực tiếp 2D/3D](STAGE4_PALLET_PLACEMENT.md): chọn và kéo pallet trong ô, nhập tọa độ, undo và ẩn tường. Chưa có chồng pallet lên pallet, xoay pallet độc lập, liên kết mã sản phẩm/lô với tồn thực hoặc nguồn hàng dự kiến. Các quy tắc mặt đỡ/va chạm và di chuyển pallet thực cần thiết kế riêng; không tự tạo BF03 khi sửa tọa độ.

Kiểm chứng: FE 21 test Kho 3D, BE 6 test layout schema, FE typecheck/build và docs:check đạt. Eslint module 0 error/1 warning cũ Scene; lint toàn FE còn 45 errors/13 warnings. ui:check/ui:cleanup bị Bash/E_ACCESSDENIED và thiếu file script trong checkout. Browser: role Warehouse không có quyền sửa được kiểm read-only; Owner thử tạo khu/ô/pallet/lớp, hiển thị vượt 7,150/6 m, đổi số đo hàng 0,8 m thành tổng 0,95 m và render WebGL pallet đỏ. Viewport 1440/390 không tràn ngang. Không bấm lưu nháp/apply lên server; chưa kiểm transaction DB, round-trip dữ liệu thực hoặc đo tương phản tự động. Không rollout/ghi DB chung.
