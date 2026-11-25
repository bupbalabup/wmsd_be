# Trạng thái tài khoản và phân quyền — 12/11/2026

`PATCH /api/users/:id/status` cần quyền `user:update`. Payload `{ "isActive": false, "reason": "Lý do khoá" }` bắt buộc lý do sau khi cắt khoảng trắng (1–2000 ký tự). Mở khoá dùng `{ "isActive": true }`. Không được tự khoá tài khoản hiện tại.

Backend lưu `users.lockReason` khi khoá và trả trường này trong danh sách/chi tiết người dùng. Backend ghi `LOCK_USER` khi tài khoản chuyển sang trạng thái khoá hoặc khi lý do sau khi cắt khoảng trắng thay đổi trên tài khoản đang khoá. Mở khoá xoá lý do hiện tại và ghi `UNLOCK_USER` khi trạng thái đổi. Dữ liệu khoá từ trước có thể chưa có lý do. `PUT /api/users/:id` chỉ sửa thông tin, role và kho.

FE có button Xem, Khoá/Mở khoá tại bảng tài khoản; sửa thông tin trong trang chi tiết. Bảng không hiển thị kho phân công. Nội dung dài xuống dòng trong cột cố định; dưới 768px chuyển thành thẻ tài khoản có phân trang, bộ lọc co theo màn hình. Điều hướng và thao tác trên danh sách dùng button có icon, không dùng liên kết bọc button. Tại trang vai trò, admin có thể tick nhiều tài khoản trên một trang và gán cùng role. FE gọi `PUT /api/users/:id` theo từng tài khoản, báo số ca thành công/thất bại; đây chưa phải giao dịch hàng loạt nguyên tử. Quyền role tiếp tục dùng `PUT /api/roles/:code/permissions` với danh sách mã quyền đang hoạt động. BE kiểm quyền ở từng request; không suy quyền từ checkbox FE.

## UI bảng phân quyền — cập nhật 12/11/2026
Trang phân quyền mở trực tiếp bảng tick của vai trò đầu tiên. Người dùng bấm một vai trò để xem/sửa quyền của vai trò đó. Mỗi hàng là chức năng; cột gồm Chọn cả nhóm, Xem, Tạo mới, Chỉnh sửa và Quyền khác (từng thao tác có nhãn riêng). Ô không có quyền tương ứng hiện dấu gạch, không tạo quyền giả. Lưu gửi đúng mã quyền đã chọn, giữ quyền ngoài bộ lọc. Bản sửa chưa lưu được giữ riêng khi chuyển vai trò. Gán nhiều tài khoản mở bằng nút riêng trong hộp thoại, không chiếm màn chỉnh quyền. Bảng có tiêu đề cố định và cuộn ngang trong vùng bảng ở màn nhỏ.

## Mật khẩu qua email — 22/11/2026

**Nguyên tắc.** Không ai (kể cả quản trị viên) đặt hay đổi mật khẩu của tài khoản khác. Mật khẩu chỉ được hệ thống sinh ngẫu nhiên (12 ký tự gồm chữ hoa, chữ thường và số, bỏ các ký tự dễ nhầm như 0/O, 1/l/I) và gửi về email của tài khoản.

**Tạo tài khoản.** `POST /users` bắt buộc `email` và **không còn nhận `password`** (body strict, gửi `password` sẽ bị từ chối). Server kiểm tra email chưa trùng (không phân biệt hoa thường, lưu chữ thường), tạo tài khoản, sinh mật khẩu và gửi email chứa tên đăng nhập và mật khẩu. Nếu gửi email lỗi thì tài khoản vừa tạo bị xóa và API trả 502, để không có tài khoản không ai đăng nhập được.

**Sửa tài khoản.** `PUT /users/:id` không còn nhận `password`. Từ 23/11/2026 cũng không còn nhận `email` (gửi lên → 400); đổi email phải qua luồng OTP ở mục "Đổi email bằng OTP".

**Quên mật khẩu.** Từ 23/11/2026 người dùng chọn một trong hai cách: nhận mật khẩu mới ngẫu nhiên (mô tả ngay dưới) hoặc nhận mã OTP để tự đặt mật khẩu (mục "Quên mật khẩu bằng OTP"). Cách nhận mật khẩu mới: `POST /auth/forgot-password` (công khai), body `{ email }`.
- Tìm đúng một tài khoản đang hoạt động có email đó. Chỉ cập nhật khi email, trạng thái hoạt động và hash cũ còn khớp, rồi gửi mật khẩu mới và ghi audit `RESET_PASSWORD`. Nếu gửi email lỗi, chỉ khôi phục hash cũ khi hash do yêu cầu này ghi vẫn còn hiện hành.
- Luôn trả cùng một thông báo thành công dù email có tồn tại hay không (không lộ danh sách tài khoản). Email không có, trùng cho nhiều tài khoản hoặc tài khoản bị khóa thì không làm gì.
- Mỗi email chỉ được xử lý 1 lần/phút (bộ nhớ trong tiến trình, mất khi khởi động lại và không dùng chung giữa nhiều instance), tránh bị người lạ spam để khóa tài khoản.

**Cấu hình gửi email** (biến môi trường): `SMTP_HOST`, `SMTP_PORT` (465 = TLS ngay, còn lại dùng STARTTLS nếu máy chủ hỗ trợ), `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL` là địa chỉ FE. Email production dùng `https://wmsd.tanthuong.workers.dev/login` khi thiếu URL HTTPS hợp lệ hoặc cấu hình trỏ localhost. `MAIL_TRANSPORT=console` chỉ in nội dung email ra log, **chỉ dùng khi phát triển** vì mật khẩu sẽ nằm trong log. Thiếu cấu hình thì tạo tài khoản và quên mật khẩu trả 503. Gửi bằng package `nodemailer` (`shared/utils/mailer.js`, nạp khi gửi lần đầu); cần chạy `npm install` sau khi pull.

**Đăng nhập.** Trường `username` của `POST /api/auth/login` nhận tên đăng nhập hoặc email. BE ưu tiên username hiện hành, sau đó so khớp tên cũ hoặc email không phân biệt hoa thường khi có đúng một kết quả. Mật khẩu được xác thực theo tài khoản đang hoạt động.

**Giao diện.** Đăng nhập → "Quên mật khẩu?" chuyển sang `/forgot`: nhập email, bấm "Gửi mật khẩu mới". Form tạo tài khoản bỏ ô mật khẩu và bắt buộc email; trang chi tiết tài khoản bỏ ô đổi mật khẩu.

**Lưu ý.** Không đổi schema. Tài khoản cũ chưa có email sẽ không dùng được "Quên mật khẩu" cho đến khi quản trị viên cập nhật email. Từ 23/11/2026 chủ tài khoản đang đăng nhập có thể tự đặt mật khẩu mới (xem mục dưới); quản trị viên vẫn không đặt/đổi mật khẩu của tài khoản khác.

## Thông tin tài khoản (tự phục vụ) — 23/11/2026

**Nguồn quyết định.** Người dùng yêu cầu ngày 23/11/2026: dựng chức năng "Thông tin tài khoản" và bổ sung "đổi mật khẩu tự chọn nếu là chủ tài khoản đăng nhập". Quyết định này thay cho giới hạn "chỉ đổi mật khẩu qua Quên mật khẩu" ở mục 22/11/2026, chỉ áp dụng cho chính chủ tài khoản.

Mọi endpoint dưới đây chỉ cần đăng nhập (`authenticate`), không cần quyền `user:*`. Đối tượng luôn là `req.user`; API không nhận id từ request.

- `GET /api/auth/me` — giữ các trường phiên cũ (`id, username, fullName, phone, role, roles, primaryRole, permissions, warehouseIds`) và bổ sung `email`, `roleCode`, `roleName`, `warehouses: [{ id, code, name, isActive }]`, `version`, `createdAt`, `updatedAt`. Không bao giờ trả `passwordHash`.
- `PATCH /api/auth/me` — body strict `{ fullName?, phone?, version }`. `fullName` 2–160 ký tự (cắt khoảng trắng); `phone` tối đa 30 ký tự gồm số và `+ ( ) . -`, chuỗi rỗng xoá số điện thoại. Không nhận `email` (đổi qua luồng OTP bên dưới), role, kho phân công, trạng thái (gửi các trường này → 400). Cập nhật nguyên tử theo `version`; sai version → 409 `ERR-CORE-409-001`. Bản ghi cũ chưa có `version` được coi là 1. Có thay đổi thì tăng version và ghi audit `UPDATE_PROFILE` kèm danh sách trường trước/sau; không thay đổi thì trả dữ liệu hiện tại, không ghi.
- `POST /api/auth/me/password` — body strict `{ currentPassword, newPassword }`. Mật khẩu mới 8–72 ký tự, có chữ hoa, chữ thường, chữ số, không khoảng trắng và phải khác mật khẩu hiện tại. Sai mật khẩu hiện tại → 400 (`fieldErrors[].path = body.currentPassword`). Ghi đè theo điều kiện hash cũ; nếu mật khẩu vừa đổi ở nơi khác (ví dụ Quên mật khẩu) → 409 `ERR-CORE-409-003`. Thành công ghi audit `CHANGE_PASSWORD`. Không đổi `version` hồ sơ.
- `PUT /api/users/:id` (admin) nay tăng `users.version` mỗi lần lưu, để một bản sửa hồ sơ tự phục vụ đồng thời nhận 409 thay vì ghi đè.
- 25/11/2026: `POST /api/users` và `PUT /api/users/:id` kiểm tra `phone` là số Việt Nam `0xxxxxxxxx` hoặc `+84xxxxxxxxx` (9–10 chữ số sau tiền tố); khoảng trắng, dấu chấm, gạch ngang bị bỏ trước khi lưu, chuỗi rỗng được chấp nhận. `username` khi tạo: 3–50 ký tự gồm chữ không dấu, số, `.`, `_`, `-`. Sai định dạng trả 400 kèm thông báo tiếng Việt. FE dùng cùng quy tắc, hiện tổng số trường lỗi khi gửi form tạo tài khoản và cảnh báo kho đã ngừng hoạt động còn trong phân công. Tài khoản cũ có số không hợp lệ chỉ bị chặn khi sửa trường điện thoại.

**Giới hạn còn lại.** Đổi mật khẩu không thu hồi access token/refresh token đã cấp (hệ thống chưa có cơ chế thu hồi phiên); phiên ở thiết bị khác vẫn hợp lệ đến khi hết hạn. Không giới hạn số lần nhập sai mật khẩu hiện tại. Không đổi schema.

**Giao diện.** Menu tài khoản ở cuối sidebar → "Thông tin tài khoản" mở `/profile` (không đặt dưới `/accounts/*` vì các route đó yêu cầu `user:read`): thẻ tóm tắt tài khoản (không hiển thị mã tài khoản), tab "Thông tin cá nhân" (xem/sửa họ tên, số điện thoại; nút "Đổi email" mở hộp thoại OTP), tab "Vai trò & phạm vi" (chỉ đọc) và tab "Bảo mật" (đổi mật khẩu).

## Đổi email bằng OTP — 23/11/2026

**Nguồn quyết định.** Người dùng yêu cầu ngày 23/11/2026: người dùng được tự đổi email nhưng cần OTP; quản trị viên đổi email cho người dùng cũng phải qua OTP. Việc gửi OTP tới **email mới** là lựa chọn triển khai (email là kênh nhận mật khẩu nên phải chứng minh địa chỉ mới nhận được thư); chưa có quyết định riêng về việc gửi thêm mã tới email cũ.

**Luồng hai bước** (dùng chung `src/shared/utils/emailChange.js`):

| Bước | Tự đổi (chỉ cần đăng nhập) | Quản trị viên (`user:update`) |
| --- | --- | --- |
| 1. Gửi mã | `POST /api/auth/me/email/otp` `{ newEmail }` | `POST /api/users/:id/email/otp` `{ newEmail }` |
| 2. Xác nhận | `POST /api/auth/me/email` `{ challengeToken, otp }` | `POST /api/users/:id/email` `{ challengeToken, otp }` |

- Bước 1 kiểm tra email hợp lệ, khác email hiện tại (không phân biệt hoa thường), chưa thuộc tài khoản khác; sinh mã 6 chữ số và gửi tới email mới. Trả `{ challengeToken, maskedEmail, expiresAt, resendAfterSeconds }`. Gửi lại trong 60 giây → 429 (`details.retryAfterSeconds`). Không cấu hình SMTP → 503; gửi lỗi → 502.
- Quản trị viên đổi email: mã gửi tới hộp thư mới của người dùng; người dùng đọc mã cho quản trị viên nhập, coi như đồng ý.
- Bước 2: mã có hiệu lực 10 phút, dùng một lần, tối đa 5 lần sai (sau đó phải gửi lại mã). Sai mã → 400, `fieldErrors[].path = body.otp`, kèm số lần còn lại. Nếu email tài khoản đã đổi sau khi gửi mã → 409 `ERR-CORE-409-003`. Thành công: cập nhật `users.email` (chữ thường) có điều kiện theo email cũ, tăng `version`, ghi audit `CHANGE_EMAIL` (trước/sau, người thực hiện), gửi thư báo tới email cũ (lỗi gửi thư báo không huỷ thay đổi). Tự đổi trả về dữ liệu `GET /auth/me`; quản trị viên nhận dữ liệu chi tiết người dùng.
- **Bảo mật token.** Mã không lưu DB; chỉ HMAC của mã nằm trong `challengeToken` (JWT ký bằng khoá dẫn xuất riêng từ `JWT_SECRET`, không dùng được làm access token). Token gắn với người thực hiện, tài khoản đích và email cũ, nên người dùng không dùng lại được token do quản trị viên tạo và ngược lại.

**Giới hạn.** Bộ đếm gửi lại/nhập sai/đã dùng nằm trong bộ nhớ tiến trình (như cooldown Quên mật khẩu): mất khi khởi động lại và không chia sẻ giữa nhiều instance (Cloudflare Workers). Không đổi schema.

**Giao diện.** Trang `/profile` (tab Thông tin cá nhân) và trang chi tiết tài khoản của quản trị viên có nút "Đổi email" mở hộp thoại hai bước: nhập email mới → nhập mã 6 số (đếm ngược gửi lại 60 giây). Ô email trong biểu mẫu sửa tài khoản của quản trị viên chỉ còn đọc.

## Quên mật khẩu bằng OTP — 23/11/2026

**Nguồn quyết định.** Người dùng yêu cầu ngày 23/11/2026: khi quên mật khẩu, cho phép chọn nhận OTP hoặc nhận mật khẩu mới. Cách nhận mật khẩu mới giữ nguyên.

- `POST /api/auth/forgot-password/otp` (công khai), body `{ email }`. Luôn trả cùng thông báo và cùng dạng dữ liệu `{ challengeToken, maskedEmail, expiresAt, resendAfterSeconds }`, dù email có tồn tại hay không. Chỉ gửi mã 6 chữ số khi email thuộc đúng một tài khoản đang hoạt động. Mỗi địa chỉ (tính cả địa chỉ không tồn tại) chỉ gửi được 1 lần/60 giây → 429 `details.retryAfterSeconds`.
- `POST /api/auth/forgot-password/reset` (công khai), body strict `{ challengeToken, otp, newPassword }`. Mã hiệu lực 10 phút, dùng một lần, tối đa 5 lần sai. `newPassword` theo cùng chính sách với tự đổi mật khẩu (8–72 ký tự, có chữ hoa, chữ thường, chữ số, không khoảng trắng). Thành công: đặt mật khẩu mới, ghi audit `RESET_PASSWORD` (lý do "Đặt lại mật khẩu bằng mã OTP gửi qua email"), gửi thư báo tới email tài khoản.
- Phiên xác thực gắn với tài khoản, email và dấu vân tay của mật khẩu hiện tại: nếu mật khẩu đã đổi bằng cách khác (đổi mật khẩu, nhận mật khẩu mới, lần đặt lại trước) hoặc email/trạng thái tài khoản thay đổi thì mã cũ hết hiệu lực → 400 "Phiên xác thực không còn hiệu lực".
- Lõi OTP dùng chung với đổi email nằm ở `src/shared/utils/otpChallenge.js` (khoá ký riêng cho từng mục đích, nên token đổi email không dùng được để đặt lại mật khẩu và ngược lại).

**Giới hạn.** Nếu gửi thư lỗi với tài khoản có thật thì API trả 502/503 (giống cách nhận mật khẩu mới), nên trường hợp này có thể để lộ email tồn tại. Bộ đếm OTP nằm trong bộ nhớ tiến trình. Không đổi schema.

**Giao diện.** Trang `/forgot` cho chọn "Nhận mật khẩu mới qua email" hoặc "Nhận mã OTP và tự đặt mật khẩu". Chọn OTP: nhập email → nhập mã 6 số, mật khẩu mới và nhập lại (có danh sách yêu cầu mật khẩu) → thành công thì quay về đăng nhập.
