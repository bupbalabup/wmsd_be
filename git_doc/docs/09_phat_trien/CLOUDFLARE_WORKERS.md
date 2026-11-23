# Backend trên Cloudflare Workers

Kết nối repo backend trong Workers & Pages. Với repo riêng cho BE, để thư mục gốc là `/` và dùng lệnh deploy `npx wrangler@4.166.0 deploy`. Tên Worker trong `wrangler.json` là `wmsd-be`. Nếu dự án trên dashboard dùng tên khác, điền tên đó vào thuộc tính `name` trước khi deploy.

Thêm `MONGODB_URI`, `JWT_SECRET` và `REFRESH_TOKEN_SECRET` dưới dạng Worker secrets. Dùng DB Atlas thử có replica set khi kiểm tra giao dịch tồn kho. Cấu hình `CLOUDINARY_URL` cho tải ảnh và các biến `SMTP_*` / `MAIL_FROM` nếu phiên bản backend triển khai có luồng email. Đặt `NOTIFICATIONS_START_AT` theo ISO UTC để Cron Trigger xử lý tối đa 25 sự kiện mỗi phút.

Worker chuyển request HTTP vào Express qua một Durable Object, nơi Mongoose có thể dùng lại kết nối. Route `GET /api/health` kiểm tra HTTP. Kiểm tra thêm đăng nhập, refresh cookie và thao tác chuyển kho trên DB thử để xác nhận kết nối thực tế. Nếu FE dùng `VITE_API_URL=/api`, cấu hình proxy production từ FE đến Worker.

```powershell
npx wrangler@4.166.0 deploy --dry-run
```

Đã kiểm tra bundle, health, đăng nhập, chữ ký JWT, cookie Secure và refresh đồng thời với đọc thông tin tài khoản qua Wrangler local. MongoDB dùng một DB thử trên localhost. Giao dịch kho và Cron Trigger với dữ liệu thật còn cần kiểm tra ở môi trường staging.
