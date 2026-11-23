# Docker (backend + frontend)

Từ 23/11/2026, chạy backend bằng `npm run dev` từ thư mục repo BE. Phần dưới ghi lại cấu hình Docker trước khi gỡ Dockerfile của backend.

Updated 17 November 2026. Compose uses image-contained source and dependencies; neither service mounts host source or `node_modules`.

## Cấu trúc file

| File | Vị trí | Vai trò |
|---|---|---|
| `Dockerfile` | repo backend | Một file, hai target: `dev` (nodemon, source and dependencies copied into the image) và `prod` (target cuối, mặc định: chỉ dependency production, chạy user `node`, có healthcheck) |
| `.dockerignore` | repo backend | Loại `.git`, `node_modules`, `.env*`, `test`, `git_doc`, `docs`, `*.md`, cấu hình agent khỏi build context |
| `docker-compose.yml` | thư mục chứa cả hai dự án (workspace root, không phải repo Git) | Chạy `api` (backend, target `dev`) và `web` (frontend `Dockerfile.dev`) |

Backend không còn `Dockerfile.dev`, `docker-compose.yml` hay thư mục `docker/`; script đổi `localhost` trong `MONGODB_URI` sang `host.docker.internal` nay nằm trong target `dev` của `Dockerfile`.

## Lệnh

```sh
# From the workspace containing building-material-management/ and frontend/.
# Run again after every source, package.json or lockfile change.
docker compose up -d --build api web  # api http://localhost:3300, web http://localhost:3334
docker build -t wmsd-api building-material-management   # image production
```

The API publishes host port `3300` to container port `3000` to avoid a local conflict on host port `3000`. Keep `PORT=3000` and the internal proxy target `http://api:3000`; only direct host access uses `http://localhost:3300`. Apply a port-only change with `docker compose up -d api web`; rebuilding is only required when image inputs change.

`api` receives `building-material-management/.env` through `env_file`; the file is not copied into the image. `web` explicitly receives `VITE_API_URL=/api` because the frontend requires it and host `.env` files are no longer mounted. Browser requests use the same-origin `/api` path; Vite proxies them to `http://api:3000` inside the Compose network.

Lần đầu: tạo `building-material-management/.env` từ `.env.example` (file bị gitignore; thiếu file thì `api` chạy không có biến môi trường và không kết nối được database).

Both build contexts exclude host `node_modules` and `.env*` files. The backend `dev` stage now copies source into `/app`; the frontend development Dockerfile already does so. Dependencies remain in each image rather than in named volumes. Source changes on the host do not update a running container; `docker compose restart` does not rebuild it. Use the build-and-up command above to rebuild changed images and recreate their containers.

Existing containers retain their old mounts until recreated. Old `wmsd_api-modules` and `wmsd_web-modules` volume objects are no longer referenced by this configuration; this change does not delete them. No volume cleanup or `down -v` is required.

## MongoDB trên máy host

Entrypoint `dev` chỉ đổi host `localhost`/`127.0.0.1` đầu tiên trong `MONGODB_URI` thành `host.docker.internal`; URI nhiều host hoặc `[::1]` không được đổi. MongoDB replica set quảng bá thành viên ở `127.0.0.1` cần thêm `directConnection=true`, và MongoDB phải bind địa chỉ mà container tới được (không chỉ `127.0.0.1`). API vẫn khởi động khi không kết nối được database (log "Continuing server startup without active database connection"), nên mọi route DB lỗi mà container vẫn chạy.

## An toàn dữ liệu

Compose đặt `AUTO_SEED=false` theo mặc định để container không tự seed vào database dùng chung/từ xa trong `.env`. Chủ động bật bằng `AUTO_SEED=true docker compose up` chỉ với database local đã được phê duyệt; `SEED_ON_STARTUP=false` trong `.env` vẫn chặn seed, và chỉ seed khi database rỗng. Đồng bộ mật khẩu seed lúc khởi động bị bỏ qua trong container vì URI đã đổi sang `host.docker.internal` không còn là URI local.

## Verification — 17 November 2026

Passed: merged Compose assertions (no service/named volumes; build targets, ports, explicit frontend API URL/proxy and disabled auto-seed); `docker compose build --check api web` (no warnings); `docker compose build api web`; isolated, read-only, network-disabled Node filesystem checks for source/dependencies, the backend entrypoint and absence of runtime `.env` files in both images; `npm run docs:check`; `git diff --check`.

Application startup, MongoDB connectivity and web-to-API HTTP requests were not run. The filesystem checks override the entrypoint and do not start the app, seed data or restart existing services. Independent review is tracked in the task handoff, not implied by a successful build.

## Historical verification (15 November 2026)

`docker build --check`, build target `prod` và `dev`, `docker compose config`; image prod chạy user `node`, không chứa `.env` hay `test`, `src/app.js` import được; entrypoint `dev` đổi `localhost` thành `host.docker.internal`.

Image `prod` trả 200 ở `/api/health`; `web` chạy riêng (không phụ thuộc api) trả 200 ở `http://localhost:3334/`. Dockerfile frontend được sửa để build được: base `node:22-alpine` (pnpm 11.27.0 không chạy trên Node 20) và copy thêm `pnpm-workspace.yaml` (chứa `allowBuilds` cho msw). Compose đặt `command` riêng cho `web` (`pnpm exec vite --host 0.0.0.0`) vì `pnpm dev -- --host` không truyền cờ cho Vite.

At that historical checkpoint, full `docker compose up` with real MongoDB, hot reload and web-to-API connectivity had not been verified. Host-source hot reload no longer applies to the current mount-free configuration. `docker build frontend` (image production nginx) hết bộ nhớ khi `pnpm build` trong máy ảo Colima 2 GiB; cần tăng bộ nhớ máy ảo hoặc đặt `NODE_OPTIONS=--max-old-space-size`.
