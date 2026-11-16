# Docker (backend + frontend)

Cập nhật 15/11/2026.

## Cấu trúc file

| File | Vị trí | Vai trò |
|---|---|---|
| `Dockerfile` | repo backend | Một file, hai target: `dev` (nodemon, mã nguồn mount từ host) và `prod` (target cuối, mặc định: chỉ dependency production, chạy user `node`, có healthcheck) |
| `.dockerignore` | repo backend | Loại `.git`, `node_modules`, `.env*`, `test`, `git_doc`, `docs`, `*.md`, cấu hình agent khỏi build context |
| `docker-compose.yml` | thư mục chứa cả hai dự án (workspace root, không phải repo Git) | Chạy `api` (backend, target `dev`) và `web` (frontend `Dockerfile.dev`) |

Backend không còn `Dockerfile.dev`, `docker-compose.yml` hay thư mục `docker/`; script đổi `localhost` trong `MONGODB_URI` sang `host.docker.internal` nay nằm trong target `dev` của `Dockerfile`.

## Lệnh

```sh
# từ thư mục chứa building-material-management/ và frontend/
docker compose up --build            # api http://localhost:3000, web http://localhost:3334
docker build -t wmsd-api building-material-management   # image production
```

`api` đọc `building-material-management/.env` qua `env_file`; file này không vào image. `web` gọi API qua `http://api:3000` trong mạng compose.

Lần đầu: tạo `building-material-management/.env` từ `.env.example` (file bị gitignore; thiếu file thì `api` chạy không có biến môi trường và không kết nối được database).

Sau khi đổi `package.json`/lockfile, xóa volume `node_modules` cũ: `docker compose down -v` (hoặc `docker volume rm wmsd_api-modules wmsd_web-modules`), vì `--build` không ghi đè volume đã có.

## MongoDB trên máy host

Entrypoint `dev` chỉ đổi host `localhost`/`127.0.0.1` đầu tiên trong `MONGODB_URI` thành `host.docker.internal`; URI nhiều host hoặc `[::1]` không được đổi. MongoDB replica set quảng bá thành viên ở `127.0.0.1` cần thêm `directConnection=true`, và MongoDB phải bind địa chỉ mà container tới được (không chỉ `127.0.0.1`). API vẫn khởi động khi không kết nối được database (log "Continuing server startup without active database connection"), nên mọi route DB lỗi mà container vẫn chạy.

## An toàn dữ liệu

Compose đặt `AUTO_SEED=false` theo mặc định để container không tự seed vào database dùng chung/từ xa trong `.env`. Chủ động bật bằng `AUTO_SEED=true docker compose up` chỉ với database local đã được phê duyệt; `SEED_ON_STARTUP=false` trong `.env` vẫn chặn seed, và chỉ seed khi database rỗng. Đồng bộ mật khẩu seed lúc khởi động bị bỏ qua trong container vì URI đã đổi sang `host.docker.internal` không còn là URI local.

## Đã kiểm tra (15/11/2026)

`docker build --check`, build target `prod` và `dev`, `docker compose config`; image prod chạy user `node`, không chứa `.env` hay `test`, `src/app.js` import được; entrypoint `dev` đổi `localhost` thành `host.docker.internal`.

Image `prod` trả 200 ở `/api/health`; `web` chạy riêng (không phụ thuộc api) trả 200 ở `http://localhost:3334/`. Dockerfile frontend được sửa để build được: base `node:22-alpine` (pnpm 11.27.0 không chạy trên Node 20) và copy thêm `pnpm-workspace.yaml` (chứa `allowBuilds` cho msw). Compose đặt `command` riêng cho `web` (`pnpm exec vite --host 0.0.0.0`) vì `pnpm dev -- --host` không truyền cờ cho Vite.

Chưa kiểm tra: `docker compose up` đủ hai service với MongoDB thật, hot reload, kết nối web → api. `docker build frontend` (image production nginx) hết bộ nhớ khi `pnpm build` trong máy ảo Colima 2 GiB; cần tăng bộ nhớ máy ảo hoặc đặt `NODE_OPTIONS=--max-old-space-size`.
