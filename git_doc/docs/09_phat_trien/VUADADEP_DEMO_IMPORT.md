# Lịch sử import dữ liệu demo từ Vua Đá Đẹp

Bộ import đã tạo sản phẩm và một lô nội bộ `UNKNOWN` cho mỗi sản phẩm được duyệt. Bản xem trước đối chiếu danh mục và bản ghi trùng tại cơ sở dữ liệu đích theo chế độ chỉ đọc. Các script đã được xóa theo yêu cầu ngày 27/11/2026.

## Phạm vi dữ liệu và kiểm tra

- Manifest khi chạy ghi đường dẫn ảnh gốc, quy cách đã công bố và giả định demo theo từng sản phẩm. API WMSD cho gắn tối đa 5 ảnh mỗi sản phẩm. Ảnh còn lại được lưu trong bộ tải trước khi dọn.
- Mã sản phẩm bắt đầu bằng `VDD-` và mã lô bằng `DEMO-VDD-`. Mẫu Kim Sa Trung dùng SKU `VDD-CAU-THANG-DA-KIM-SA-TRUNG-AN-DO` và lô `DEMO-VDD-CAU-THANG-DA-KIM-SA-TRUNG-AN-DO`. Mã hãng `VDD-DEMO` đánh dấu mẫu thiếu mã hãng ở nguồn. `VIGLACERA` và `PRIME` lấy từ tên do nguồn công bố.
- Tạo sản phẩm dùng quy đổi diện tích và audit theo backend. Lô `UNKNOWN` có quy cách đóng thùng demo. Quy đổi thùng theo lô cần lô đã xác minh. Giá niêm yết trong manifest phục vụ đối chiếu, phạm vi ghi dữ liệu gồm sản phẩm, lô và các bản ghi dịch vụ tạo kèm.
- Lần kiểm tra ngày 26/11/2026 dự kiến tạo 20 sản phẩm và 20 lô trên Atlas `wmsd_database`. Kịch bản ghi trên MongoDB replica set local cô lập đã kiểm tra chạy lại, tạo bù lô và số lượng tồn. Kịch bản dùng trình tải ảnh giả lập. Các bài kiểm tra sản phẩm, ảnh, quy đổi diện tích và API lô đạt 21/21. Sau khi người dùng duyệt, lượt ghi vào Atlas `wmsd_database` tạo đủ 20 sản phẩm và 20 lô `UNKNOWN`. Kiểm tra đọc lại khớp quy cách từng lô, truy cập được 85/85 URL ảnh và tìm thấy 0 số dư cho các lô mới. Dry-run sau import trả `SKIP` cho cả 20 dòng. Sau đó người dùng yêu cầu xóa bộ dữ liệu. Đã xác minh Atlas còn 0 sản phẩm và 0 lô từ lượt import, Cloudinary còn 0 ảnh trong 85 ảnh đã tải lên và các file tải về đã được dọn.
