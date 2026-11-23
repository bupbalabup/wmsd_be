# Trạng thái tài khoản và phân quyền — 12/11/2026

`PATCH /api/users/:id/status` cần quyền `user:update`. Payload `{ "isActive": false, "reason": "Lý do khoá" }` bắt buộc lý do sau khi cắt khoảng trắng (1–2000 ký tự). Mở khoá dùng `{ "isActive": true }`. Không được tự khoá tài khoản hiện tại.

Backend lưu `users.lockReason` khi khoá và trả trường này trong danh sách/chi tiết người dùng. Backend ghi `LOCK_USER` khi tài khoản chuyển sang trạng thái khoá hoặc khi lý do sau khi cắt khoảng trắng thay đổi trên tài khoản đang khoá. Mở khoá xoá lý do hiện tại và ghi `UNLOCK_USER` khi trạng thái đổi. Dữ liệu khoá từ trước có thể chưa có lý do. `PUT /api/users/:id` chỉ sửa thông tin, role và kho.

FE có button Xem, Khoá/Mở khoá tại bảng tài khoản; sửa thông tin trong trang chi tiết. Bảng không hiển thị kho phân công. Nội dung dài xuống dòng trong cột cố định; dưới 768px chuyển thành thẻ tài khoản có phân trang, bộ lọc co theo màn hình. Điều hướng và thao tác trên danh sách dùng button có icon, không dùng liên kết bọc button. Tại trang vai trò, admin có thể tick nhiều tài khoản trên một trang và gán cùng role. FE gọi `PUT /api/users/:id` theo từng tài khoản, báo số ca thành công/thất bại; đây chưa phải giao dịch hàng loạt nguyên tử. Quyền role tiếp tục dùng `PUT /api/roles/:code/permissions` với danh sách mã quyền đang hoạt động. BE kiểm quyền ở từng request; không suy quyền từ checkbox FE.

## UI bảng phân quyền — cập nhật 12/11/2026
Trang phân quyền mở trực tiếp bảng tick của vai trò đầu tiên. Người dùng bấm một vai trò để xem/sửa quyền của vai trò đó. Mỗi hàng là chức năng; cột gồm Chọn cả nhóm, Xem, Tạo mới, Chỉnh sửa và Quyền khác (từng thao tác có nhãn riêng). Ô không có quyền tương ứng hiện dấu gạch, không tạo quyền giả. Lưu gửi đúng mã quyền đã chọn, giữ quyền ngoài bộ lọc. Bản sửa chưa lưu được giữ riêng khi chuyển vai trò. Gán nhiều tài khoản mở bằng nút riêng trong hộp thoại, không chiếm màn chỉnh quyền. Bảng có tiêu đề cố định và cuộn ngang trong vùng bảng ở màn nhỏ.

## Mật khẩu qua email — 22/11/2026

**Nguyên tắc.** Không ai (kể cả quản trị viên) đặt hay đổi mật khẩu của tài khoản khác. Mật khẩu chỉ được hệ thống sinh ngẫu nhiên (12 ký tự gồm chữ hoa, chữ thường và số, bỏ các ký tự dễ nhầm như 0/O, 1/l/I) và gửi về email của tài khoản.

**Tạo tài khoản.** `POST /users` bắt buộc `email` và **không còn nhận `password`** (body strict, gửi `password` sẽ bị từ chối). Server kiểm tra email chưa trùng (không phân biệt hoa thường, lưu chữ thường), tạo tài khoản, sinh mật khẩu và gửi email chứa tên đăng nhập và mật khẩu. Nếu gửi email lỗi thì tài khoản vừa tạo bị xóa và API trả 502, để không có tài khoản không ai đăng nhập được.

**Sửa tài khoản.** `PUT /users/:id` không còn nhận `password`. Đổi email vẫn được nhưng không được trùng email tài khoản khác.

**Quên mật khẩu.** `POST /auth/forgot-password` (công khai), body `{ email }`.
- Tìm đúng một tài khoản đang hoạt động có email đó; đặt ngay mật khẩu mới ngẫu nhiên, gửi về email, ghi audit `RESET_PASSWORD`. Mật khẩu cũ hết hiệu lực ngay. Nếu gửi email lỗi thì khôi phục mật khẩu cũ và trả 502.
- Luôn trả cùng một thông báo thành công dù email có tồn tại hay không (không lộ danh sách tài khoản). Email không có, trùng cho nhiều tài khoản hoặc tài khoản bị khóa thì không làm gì.
- Mỗi email chỉ được xử lý 1 lần/phút (bộ nhớ trong tiến trình, mất khi khởi động lại và không dùng chung giữa nhiều instance), tránh bị người lạ spam để khóa tài khoản.

**Cấu hình gửi email** (biến môi trường): `SMTP_HOST`, `SMTP_PORT` (465 = TLS ngay, còn lại dùng STARTTLS nếu máy chủ hỗ trợ), `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, tùy chọn `APP_URL` (đưa liên kết đăng nhập vào email). `MAIL_TRANSPORT=console` chỉ in nội dung email ra log, **chỉ dùng khi phát triển** vì mật khẩu sẽ nằm trong log. Thiếu cấu hình thì tạo tài khoản và quên mật khẩu trả 503. Gửi bằng package `nodemailer` (`shared/utils/mailer.js`, nạp khi gửi lần đầu); cần chạy `npm install` sau khi pull.

**Giao diện.** Đăng nhập → "Quên mật khẩu?" chuyển sang `/forgot`: nhập email, bấm "Gửi mật khẩu mới". Form tạo tài khoản bỏ ô mật khẩu và bắt buộc email; trang chi tiết tài khoản bỏ ô đổi mật khẩu.

**Lưu ý.** Không đổi schema. Tài khoản cũ chưa có email sẽ không dùng được "Quên mật khẩu" cho đến khi quản trị viên cập nhật email. Người dùng không có cách tự đổi mật khẩu khi đã đăng nhập; chỉ qua "Quên mật khẩu".
