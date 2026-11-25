# Quản trị hệ thống, bảng điều hành và tác vụ nền — 23/11/2026

**Nguồn quyết định.** Người dùng yêu cầu ngày 23/11/2026: ghi 5 tài khoản demo vào README và gỡ khỏi trang đăng nhập; cho `/owner` và Chính sách bán hàng & ngưỡng kho chạy dữ liệu thật; thêm màn hình Nhật ký hệ thống; sửa "Lần đăng nhập cuối"; đưa danh sách API vào DB, admin thêm được URL/tên/mô tả; bỏ menu "Cài đặt hệ thống"; gửi thông báo qua email; cảnh báo tồn dưới ngưỡng; tìm kiếm nhanh toàn hệ thống; log lỗi và theo dõi server cho admin; dọn mã thừa.

Model mới: [app-setting](../../../src/models/app-setting.model.js), [api-endpoint](../../../src/models/api-endpoint.model.js), [error-log](../../../src/models/error-log.model.js); xem [MODEL_MAP](../../MODEL_MAP.md).

## Quyền mới

| Mã quyền | Vai trò mặc định | Dùng cho |
| --- | --- | --- |
| `dashboard:read` | OWNER | `GET /api/dashboard/owner`, route FE `/owner` |
| `sales_policy:read` | OWNER | `GET /api/settings/sales-policy`, route FE `/settings/sales-policy` |
| `sales_policy:update` | OWNER | `PUT /api/settings/sales-policy`, `POST /api/stock-alerts/scan` |
| `audit_log:read` | ADMIN, OWNER | `/api/system/audit-logs*`, route FE `/system/audit-logs` |
| `api_catalogue:read` | ADMIN | `GET /api/system/api-endpoints` |
| `api_catalogue:update` | ADMIN | Đồng bộ, thêm, sửa, xoá mục danh mục API |
| `system_monitor:read` | ADMIN | `/api/system/monitor`, `/api/system/error-logs*` |

**Triển khai:** chạy `npm run seed:sync-permissions` để thêm 7 bản ghi quyền vào DB và gán lại quyền mặc định cho các vai trò hiện có (lệnh này ghi đè chỉnh sửa quyền thủ công của 5 vai trò hệ thống bằng bộ mặc định — đây là hành vi sẵn có của lệnh). Trước khi chạy, vai trò Chủ cửa hàng sẽ bị chặn ở `/owner` vì thiếu `dashboard:read`.

## Lần đăng nhập cuối

`users.lastLoginAt` được ghi khi đăng nhập thành công (không đổi `updatedAt`) và mỗi lần đăng nhập ghi audit `LOGIN`. `GET /api/users`, `GET /api/users/:id` trả `lastLogin` từ trường này (trước đây sai: lấy `updatedAt`); `null` khi chưa ghi nhận. `GET /api/auth/me` trả `lastLoginAt`.

## Bảng điều hành Chủ cửa hàng

`GET /api/dashboard/owner` (`dashboard:read`). Không hiển thị doanh thu, lợi nhuận, công nợ (ngoài phạm vi WMSD). Trả:

- `kpis`: số việc chờ duyệt, số mặt hàng dưới ngưỡng / số ngưỡng đã đặt, số dòng tồn chưa đạt chất lượng, số lô tồn lâu, số sản phẩm và kho đang hoạt động.
- `approvals`: 5 hàng đợi, mỗi hàng đợi có `count` và 5 chứng từ mới nhất: đề nghị nhập `SUBMITTED`, yêu cầu chuyển kho `PENDING_APPROVAL`, chênh lệch chuyển kho `stock_discrepancies` `OPEN`, phiếu kiểm kê `RECONCILING`, hàng lỗi có phương án `SUBMITTED`. Ngoài Chủ cửa hàng, lọc theo kho được phân công.
- `warnings.lowStock` (10 dòng đầu, xem mục cảnh báo tồn), `warnings.qualityHolds` (số dòng tồn `PENDING`/`DAMAGED`/`BLOCKED` > 0), `warnings.agingLots` (lô còn tồn GOOD mà `product_batches.createdAt` cũ hơn `agingInventoryThresholdDays` của chính sách).
- `monthlyActivity`: 12 tháng gần nhất (múi giờ Asia/Ho_Chi_Minh), đếm số giao dịch kho có dòng nhập, có dòng xuất và còn lại là điều chuyển nội bộ. Không cộng số lượng vì đơn vị gốc khác nhau giữa sản phẩm.
- `recentDecisions`: 10 audit gần nhất có thao tác duyệt/từ chối/quyết định/ghi sổ/đóng/khoá.

## Chính sách bán hàng & ngưỡng kho

Lưu trong `app_settings` khoá `SALES_POLICY` (thay bản lưu trình duyệt).

- `GET /api/settings/sales-policy` (`sales_policy:read`) → `{ policy, version, updatedAt, updatedBy, changeLog[] }`. Chưa lưu lần nào: `version = 0`, `policy` là giá trị mặc định `{ allowOverStockOrder:false, suggestedLossRate:0, defaultOddLotThreshold:10, returnDaysWindow:30, agingInventoryThresholdDays:180 }`.
- `PUT /api/settings/sales-policy` (`sales_policy:update`), body strict đủ 5 trường + `version`. Giới hạn: hao hụt 0–15 %, lô lẻ ≥ 0 m², thời hạn trả 0–365 ngày (số nguyên), tồn lâu 1–3.650 ngày (số nguyên). Sai version → 409 `ERR-CORE-409-001`. Có thay đổi thì tăng version và ghi audit `UPDATE_SALES_POLICY` kèm từng trường trước/sau (đây là nguồn của `changeLog`).
- **Áp dụng:** chỉ `agingInventoryThresholdDays` được dùng (cảnh báo lô tồn lâu trên dashboard). `allowOverStockOrder`, `suggestedLossRate`, `defaultOddLotThreshold`, `returnDaysWindow` hiện chỉ được ghi nhận, chưa chặn hay tính toán tự động trong đơn bán/trả hàng — cần quyết định nghiệp vụ trước khi áp dụng.
- Ngưỡng tồn tối thiểu/mục tiêu theo sản phẩm × kho vẫn sửa ở `PUT /api/products/:id/warehouse-policies/:warehouseId` (không đổi).

## Cảnh báo tồn dưới ngưỡng

Tồn khả dụng dùng đúng quy tắc của đánh giá đề nghị nhập: hàng `GOOD`, thuộc cửa hàng, ở vị trí `STORAGE` đang hoạt động và soạn được, không bị khoá kiểm kê, trừ lượng đã giữ chỗ; lô `VERIFIED`. Dưới ngưỡng khi khả dụng < `minimumQty`; `shortageQty = targetQty − khả dụng`. Đơn vị là đơn vị gốc của sản phẩm.

- `GET /api/stock-alerts?status=BELOW|OK` (`inventory:read`, lọc theo kho được phân công) → `{ items[], summary: { total, below } }`.
- Tác vụ nền quét mỗi `LOW_STOCK_SCAN_MINUTES` phút (mặc định 15; mốc chạy lưu ở `app_settings` khoá `LOW_STOCK_LAST_SCAN`, nhận việc nguyên tử nên nhiều instance chỉ quét một lần). `POST /api/stock-alerts/scan` (`sales_policy:update`) quét ngay.
- Mỗi người dùng có `notification:read` + `inventory:read` và được phân công kho đó nhận **một** thông báo cho mỗi đợt dưới ngưỡng (`type=LOW_STOCK`, `sourceType=products`, `conditionKey=LOW_STOCK:<product>:<warehouse>`, `conditionState=BELOW`). Khi tồn đạt lại ngưỡng, các thông báo đang mở chuyển `RESOLVED`; lần xuống dưới ngưỡng sau tạo thông báo mới. Chuông thông báo mở `/products/<id>`.

## Thông báo qua email

Mỗi thông báo trong ứng dụng (nghiệp vụ và tồn dưới ngưỡng) được gửi một bản email tới email tài khoản người nhận.

- Bật khi có cấu hình gửi thư (`SMTP_HOST` hoặc `MAIL_TRANSPORT=console`), tắt bằng `NOTIFICATION_EMAIL=off`. Người dùng không có email hoặc bị khoá: `emailDelivery.status = SKIPPED`.
- Thông báo mới có `emailDelivery.status = PENDING`; tác vụ nền gửi tối đa 20 thư mỗi lượt, thành công → `SENT` + `sentAt`; lỗi tăng `attempts`, sau 5 lần → `FAILED` + `lastError`. Lỗi máy chủ thư dừng lượt hiện tại và thử lại lượt sau. `APP_URL` (nếu có) dùng để đưa liên kết chi tiết vào thư.
- Chưa có tuỳ chọn tắt email theo từng người dùng.

## Tác vụ nền

`src/modules/notifications/background.js` gom: xử lý sự kiện thông báo nghiệp vụ (chỉ khi đặt `NOTIFICATIONS_START_AT`, như trước), quét tồn dưới ngưỡng và gửi email. Server Node: vòng lặp thông báo 2 giây giữ nguyên, thêm vòng 30 giây cho tồn thấp + email. Cloudflare Worker: cron mỗi phút gọi `processNotifications()`, nay chạy cả ba việc (trước đây chỉ chạy khi có `NOTIFICATIONS_START_AT`). Lỗi tác vụ nền được ghi `error_logs` với `source=WORKER`.

## Nhật ký hệ thống

Chỉ đọc, quyền `audit_log:read`.

- `GET /api/system/audit-logs?page&limit(≤100)&search&action&subjectType&actorId&result&from&to` → `{ items, total, page, limit }`, mới nhất trước. `search` khớp lý do/thao tác/loại đối tượng hoặc đúng mã đối tượng. Mỗi dòng có `actionLabel`, `subjectLabel` tiếng Việt khi biết, `changeCount`.
- `GET /api/system/audit-logs/options` → danh sách thao tác, loại đối tượng, người thực hiện đã xuất hiện.
- `GET /api/system/audit-logs/:id` → chi tiết gồm `changes[]` (trường, trước, sau).
- Từ 24/11/2026 thao tác vai trò cũng ghi audit (đối tượng `roles`): `CREATE_ROLE` ("Tạo vai trò", `changes` = mã và danh sách quyền) và `UPDATE_ROLE_PERMISSIONS` ("Cập nhật quyền vai trò", `changes` = quyền trước/sau). Bản ghi viết sau khi lưu vai trò; nếu ghi audit lỗi thì API trả lỗi dù vai trò đã lưu, giống khoá/mở khoá tài khoản.

## Danh mục API

Bảng `api_endpoints`. `src/shared/utils/routeRegistry.js` (nạp trước mọi route) ghi lại đường dẫn mount để dựng URL đầy đủ, vì Express 5 không lưu chuỗi này.

- `GET /api/system/api-endpoints?page&limit(≤200)&search&module&method&source=SYSTEM|MANUAL&status=present|missing|inactive` (`api_catalogue:read`). Danh mục trống thì tự đồng bộ lần đầu.
- `POST /api/system/api-endpoints/sync` (`api_catalogue:update`): thêm route mới (tên mặc định `METHOD URL`), giữ tên/mô tả admin đã sửa, đánh dấu `isPresent=false` cho route `SYSTEM` không còn trong mã; ghi audit `SYNC_API_CATALOGUE`. Lần chạy thử 23/11/2026 phát hiện 295 API.
- `POST /api/system/api-endpoints` body strict `{ method?, url, name, description?, module? }` → dòng `MANUAL`. Trùng `{method,url}` → 409 `ERR-CORE-409-002`.
- `PATCH /api/system/api-endpoints/:id` `{ name?, description?, url?, method?, module?, isActive? }`. Dòng `SYSTEM` không đổi được `url`/`method` (400).
- `DELETE /api/system/api-endpoints/:id`: chỉ dòng `MANUAL`; dòng `SYSTEM` dùng `isActive=false`.
- Danh mục chỉ để tra cứu và ghi chú; **không** dùng để cấp quyền hay chặn truy cập.

## Theo dõi server và nhật ký lỗi

Quyền `system_monitor:read`.

- `GET /api/system/monitor`: trạng thái (OK khi DB kết nối), thời gian chạy, bộ nhớ, Node, nền tảng; số yêu cầu, lỗi 4xx/5xx, p50/p95 trên 500 yêu cầu gần nhất (đo trong bộ nhớ từng tiến trình, đặt lại khi khởi động lại, không gộp giữa nhiều instance); ping DB, số collection, dung lượng; số lỗi chưa xử lý và trong 24 giờ; trạng thái email, sự kiện thông báo chờ/lỗi, lần quét tồn cuối.
- `GET /api/system/error-logs?page&limit&status=open|resolved|all&source&search` và `POST /api/system/error-logs/:id/resolve` (audit `RESOLVE_ERROR_LOG`).
- Ghi lỗi: mọi phản hồi ≥ 500 (bộ xử lý lỗi Express), lỗi tác vụ nền, `unhandledRejection` của tiến trình Node. Gộp theo dấu vân tay (nguồn, phương thức, đường dẫn đã bỏ mã định danh, tên lỗi, nội dung đã bỏ số); lỗi đã xử lý xuất hiện lại sẽ mở lại. Không lưu body, query, cookie, token.

## Tìm kiếm nhanh

`GET /api/search?q=<2–100 ký tự>&limit=<1–10, mặc định 5>`. Tìm theo nhóm mà người gọi có quyền đọc: sản phẩm (SKU, tên, mã hãng), lô (số lô), nhà cung cấp (mã, tên, MST), kho, tài khoản (`user:read`), và số chứng từ của đơn mua, đề nghị nhập, đơn bán, phiếu nhập, phiếu xuất, chuyển kho, kiểm kê, hàng khách trả, trả NCC, hàng lỗi. `subtitle` của chứng từ là nhãn tiếng Việt tính lúc đọc từ `workflowStatus` (trạng thái chưa có nhãn hiện nguyên mã). Chứng từ lọc theo kho được phân công trừ Chủ cửa hàng. Kết quả trả `href` của màn hình FE; màn hình đích vẫn tự kiểm quyền. FE: ô tìm ở header, phím tắt Ctrl/⌘+K.

## Giao diện (FE)

- Trang đăng nhập không còn khối "Chọn nhanh vai trò mẫu" và không điền sẵn tài khoản; 5 tài khoản demo nằm ở [README BE](../../../README.md#tài-khoản-demo).
- Bỏ mục "Cài đặt hệ thống Tân Thương" (không có chức năng) khỏi menu tài khoản ở sidebar.
- `/owner` và `/settings/sales-policy` viết lại theo API thật; `/system/audit-logs`, `/system/api-endpoints`, `/system/monitor` mới, nhóm menu "Quản trị hệ thống".
- Chi tiết tài khoản (admin) và trang hồ sơ hiển thị "Đăng nhập gần nhất".
- Dọn mã thừa FE 23/11/2026: xoá 251 file không còn được tham chiếu từ `main.tsx` (các trang phiên bản giả lập cũ của hàng khách trả, hàng lỗi, tồn kho, chuyển vị trí, kho, báo cáo, trả NCC, đơn hàng `orders`, dashboard cũ, cùng test chỉ kiểm tra các trang đó). Kiểu dữ liệu mock `/orders` của hạ tầng test chuyển vào `mocks/orderTypes.ts`. BE không có file mã thừa.

## Giới hạn còn lại

- Các trang **Yêu cầu xuất kho** (`/issue-requests`) và **Tạo lô hàng** (`/lots/create`) vẫn đọc danh mục sản phẩm/lô/kho/NCC từ dữ liệu giả `mockStore` trong trình duyệt; cần nối API thật (chưa làm trong đợt này).
- Số liệu yêu cầu trong theo dõi server và bộ đếm OTP/thời gian chờ nằm trong bộ nhớ từng tiến trình.
- 4 trong 5 trường chính sách bán hàng chưa được áp dụng tự động (xem trên).
