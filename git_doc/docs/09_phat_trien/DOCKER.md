# Docker (backend + frontend)

Updated 24 November 2026. Backend and frontend are two independent dev containers, each with its own Dockerfile. There is no nginx at runtime: the frontend image runs the Vite dev server.

## Cấu trúc file

| File | Vị trí | Vai trò |
|---|---|---|
| `Dockerfile` | repo backend | Image dev: `node:22-alpine`, `npm ci`, chạy `npm run dev` (nodemon) |
| `Dockerfile` | repo frontend | Image dev: `node:22-alpine` + pnpm 11.27.0, chạy `pnpm exec vite --host 0.0.0.0 --port 3334` |
| `docker-compose.yml` | workspace root (không phải repo Git) | Định nghĩa 2 service độc lập `api` và `web` |

Cả hai repo có `.dockerignore` loại `node_modules`, `.env*`, `.git`, tài liệu và test. Không bind mount source vào container: muốn cập nhật code thì rebuild image.

> Theo yêu cầu người dùng 23/11/2026, Dockerfiles cũ (multi-stage `dev`/`prod`, `Dockerfile.dev`, entrypoint đổi `MONGODB_URI`, image frontend nginx) đã bị xóa khi chuyển sang deploy Cloudflare Workers. Ngày 24/11/2026 các Dockerfile dev đơn giản được tạo lại theo yêu cầu chạy Docker riêng biệt, không nginx.

## Lệnh

Chạy từ workspace chứa `building-material-management/` và `frontend/`:

```sh
docker compose up -d --build api   # backend: http://localhost:3300
docker compose up -d --build web   # frontend: http://localhost:3334
```

Hai service không có `depends_on`: có thể khởi động, dừng và rebuild riêng lẻ. Sau mỗi thay đổi source, `package.json` hoặc lockfile thì chạy lại lệnh tương ứng với `--build`; `docker compose restart` không cập nhật code trong image.

## Cổng và proxy

- `api`: host `3300` → container `3000`. Compose đặt `PORT=3000` để ghi đè `PORT=3333` trong `.env` local (giữ đúng mapping).
- `web`: host `3334` → container `3334` (đúng `strictPort` trong `vite.config.ts`). `VITE_API_URL=/api` được truyền rõ cho Vite.
- Trình duyệt gọi cùng origin `/api`; Vite proxy tới `VITE_API_PROXY_TARGET`, mặc định là `http://host.docker.internal:3300` (cổng host đã publish của `api`). Điều này giúp `web` chạy riêng vẫn tới được backend. Nếu backend chạy ở cổng khác trên host, override:

```sh
VITE_API_PROXY_TARGET=http://host.docker.internal:3000 docker compose up -d --build web
```

Cả hai service khai báo `extra_hosts: host.docker.internal:host-gateway`. Port publish dùng `0.0.0.0` (dev); chỉ dùng trên máy/local network tin cậy, không mang cấu hình này ra production.

## Biến môi trường và dữ liệu

- Compose đọc `building-material-management/.env` qua `env_file` (không đưa secret vào image). File `.env` không có trong build context nhờ `.dockerignore`.
- Không còn biến `AUTO_SEED`: backend không đọc biến này. Seed chỉ chạy bằng lệnh CLI tường minh, không tự động lúc khởi động container.
- `MONGODB_URI` trong `.env` hiện trỏ tới cụm Atlas từ xa; backend kết nối trực tiếp, không cần rewrite `localhost`. Với MongoDB chạy trên host, phải bind địa chỉ container tới được và cài `directConnection=true` nếu replica set quảng báo `127.0.0.1`.
- `.env` hiện thiếu `JWT_SECRET` / `REFRESH_TOKEN_SECRET`, backend đang rơi về giá trị mặc định trong code. Đây là rủi ro và cần được bổ sung bởi người quản lý cấu hình trước khi dùng ngoài local.

## Kiểm chứng — 24/11/2026

Đã chạy: `docker compose config --quiet`; build riêng `api` và `web`; `docker compose up -d api` rồi `docker compose up -d web`; `curl http://127.0.0.1:3300/api/health` → `{"status":"ok"}`; `curl http://127.0.0.1:3334/` → HTTP 200; `curl http://127.0.0.1:3334/api/health` → cùng JSON (chứng tỏ proxy Vite → API hoạt động); `curl http://127.0.0.1:3300/api/auth/me` → 401 (route có authenticate chạy được). Log backend báo `Connected to MongoDB.`

Giới hạn: `/api/health` là endpoint tĩnh, không tự chứng minh mọi route DB; chỉ kiểm tra thêm một route có middleware auth. Không chạy luồng nghiệp vụ đầy đủ (đăng nhập, tạo chứng từ) trong lần này. Reviewer độc lập xác nhận giao diện render ổn ở desktop 1280×720 và mobile 390×844, không lỗi console.

## Historical verification (17/11/2026)

Cấu hình cũ (đã xóa) từng dùng target `dev`/`prod`, `Dockerfile.dev`, image frontend nginx, entrypoint đổi `localhost` trong `MONGODB_URI`, proxy nội bộ `http://api:3000` và `AUTO_SEED`. Các kết quả build/check tại thời điểm đó chỉ còn giá trị lịch sử, không mô tả cấu hình hiện tại.
