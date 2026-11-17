# MongoDB local hiện hành

Ngày 06/11/2026: local v8 có 59 collection / 638 bản ghi, gồm 18 product gạch và 5 categories. Trong Compass dùng:

```text
mongodb://localhost:27017/wmsd_demo_tile_shop_v8
```

Refresh Databases rồi chọn v8. Product giữ categoryId trỏ tới categories._id. Bản trên Atlas là wmsd_database; phải dùng kết nối Atlas riêng để xem.

```powershell
npm run db:demo
npm run db:local:seed
npm run db:local:verify
npm run test:db-rebuild
```

Lúc kiểm tra lần này, local v7 và Atlas wmsd_database đều trống; đã tạo lại bộ mẫu v8, không ghi đè dữ liệu. Báo cáo cũ là lịch sử, không khẳng định DB cũ còn trên máy. Seed chỉ ghi DB demo local riêng hoặc kiểm target đã có; không drop DB để chạy lại. API legacy và kết nối ứng dụng chưa chuyển.

[Bộ mẫu](SEED_CUA_HANG_GACH.md) · [Category và triển khai v8](CATEGORIES_V8.md) · [Báo cáo local](../../outputs/categories_v8_local_seed_2026-11-06.json).

## Ngừng lệnh cất hàng mua

Chạy từ thư mục backend. Script yêu cầu URI loopback có tên database ứng dụng. Áp dụng cần MongoDB replica set. Ví dụ dùng DB demo mặc định `wmsd_demo_tile_shop_v9`.

1. Xem trước danh sách lệnh và quyền sẽ thay đổi.

   ```powershell
   node scripts/retire-purchase-putaway.mjs --uri=mongodb://127.0.0.1:27017/wmsd_demo_tile_shop_v9
   ```

2. Áp dụng trên DB local trước khi dùng phiên bản mới của BE và FE.

   ```powershell
   node scripts/retire-purchase-putaway.mjs --uri=mongodb://127.0.0.1:27017/wmsd_demo_tile_shop_v9 --apply
   ```

   Một transaction hủy lệnh mua `OPEN/PARTIAL`, tăng version, ghi audit hệ thống và tắt các quyền `putaway_task:*`. Báo cáo `tasks[].lines[].releasedQtyBase` là lượng còn lại được giải phóng theo đơn vị gốc. Bút toán đã chuyển của lệnh `PARTIAL` được giữ để đối soát. Lệnh có ITR được loại khỏi migration. Để đưa phần tồn còn lại lên kệ, lập lệnh BF03 mới.

3. Chạy lại lệnh xem trước. Sau lần áp dụng thành công, `tasks` và `permissions` là mảng rỗng. Đối soát tồn trên cùng DB.

   ```powershell
   $env:MONGODB_URI='mongodb://127.0.0.1:27017/wmsd_demo_tile_shop_v9?replicaSet=rs0'
   node scripts/purchase-maintenance.mjs reconcile
   ```

Kết quả local 17/11/2026: tắt bốn quyền cũ, không có lệnh mở thuộc phạm vi. Đối soát DB demo báo `RR_ALLOWANCE` trên PO mẫu có ID `cc960c05c1448703b0b768cc`. Kiểm thử native dùng dữ liệu riêng để xác minh hủy lệnh `OPEN/PARTIAL`, giữ bút toán đã chuyển và chạy lại an toàn.
