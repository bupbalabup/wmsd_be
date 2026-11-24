# Kho 3D — Bố trí pallet trực tiếp trên 2D/3D

Ngày 17/11/2026. Thực hiện tiếp yêu cầu người dùng thao tác pallet ở cả hai chế độ, sau [lớp hàng](STAGE3_PALLET_LAYERS.md). Chỉ cập nhật phương án thiết kế, không chuyển tồn.

## Thao tác

- Bấm pallet trên 2D/3D hoặc chọn **Pallet đang chọn** (tìm theo mã pallet, khu hoặc ô). Pallet được đánh dấu viền. Có thể dùng Tab rồi Enter/Space để chọn pallet trên 2D; danh sách dùng được bằng bàn phím ở cả hai chế độ.
- Kéo chuột trái trên pallet để di chuyển **trong ô hiện tại**. Tọa độ làm tròn theo bước 0,05 m, đã đổi về hệ local của khu vực xoay. Pallet không kéo theo ô/khu và không chuyển sang ô khác.
- Có thể nhập X/Y chính xác bằng mét, bấm **Đặt vị trí pallet**. Không bắt buộc tọa độ nhập tay theo bước 0,05 m.
- Trong 3D, kéo nền xoay camera; chuột phải hoặc Ctrl + kéo di chuyển góc nhìn, cuộn để zoom. Camera không xoay theo khi đang kéo pallet. Góc camera được giữ khi sửa pallet trên cùng mặt bằng; thay đường bao/chiều cao khởi tạo lại góc nhìn.
- **Ẩn tường / Hiện tường** chỉ đổi cách xem, không xóa tường hoặc làm bẩn bản nháp; giúp chọn pallet bên trong kho có tường cao.
- Esc hoặc pointer cancel hủy lần kéo, phục hồi preview và quyền điều khiển camera. Chỉ thả chuột mới ghi thay đổi vào bản đang vẽ; click không di chuyển không tạo lịch sử/dirty.
- Thả vượt mép ô: báo lỗi và giữ vị trí cũ. Vượt chiều cao tiếp tục chỉ cảnh báo theo chặng trước. Chưa thêm quy tắc va chạm/chồng pallet.
- Nút **Hoàn tác** chuyển lên thanh công cụ dùng chung 2D/3D, giữ 50 bước như trước. Lưu/áp dụng vẫn là thao tác riêng, qua API/quyền/scope/updatedAt hiện hành.

## Dữ liệu và quyền

Không thêm field/schema/API/permission hoặc migration cho thao tác kéo pallet. Chỉ sửa `layout3d.zones[].slots[].pallets[].x/y` và giữ mã, lớp hàng, số đo, ô/khu ban đầu. Bản thiết kế áp dụng không đổi cho đến khi áp dụng qua API. [Ô thiết kế có thể tham chiếu WarehouseLocation](STAGE2_ZONES.md), nhưng việc kéo pallet không liên kết balance, không gọi BF03 và không ghi giao dịch hàng thực.

Quyền ghi vẫn là `warehouse_location:update` cùng phạm vi kho của BE. FE khóa thao tác kéo/đặt tọa độ khi chỉ xem hoặc đang lưu; vẫn cho chọn đối tượng và điều khiển camera. BE vẫn kiểm đầy đủ payload thiết kế theo chặng 3, không tin quyền từ FE.

## Kiểm chứng và giới hạn

Test mới kiểm biến đổi tọa độ khu xoay, snap, không đổi ô/khu/hàng, chọn không dirty, từ chối vượt ô, undo, raycast 3D bằng Three.js thật, restore preview/camera controls khi Esc/cancel, readonly và Ctrl/chuột phải. Không dùng WebGL trong unit test.

Giới hạn tiếp theo: chưa xoay pallet độc lập, chồng pallet lên nhau, kiểm tải trọng/mặt đỡ/va chạm, kéo qua ô khác hoặc liên kết tồn thực. Không tự chốt các quy tắc mặt đỡ/chuyển tồn còn mở trong đặc tả. Kết quả build/test/browser của lượt này ghi trong [nhật ký](../../change_logs.md).
