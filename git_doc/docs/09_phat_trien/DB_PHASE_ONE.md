# Tinh gọn DB đợt 1

Phạm vi gồm collection replenishment_locks, sales_orders.replenishmentPlanningVersion và warehouse_transfer_requests.header.executionStatus. Registry mới có 58 collection. Chứng từ cũ vẫn dùng được với ID, version, workflowStatus và phân bổ từng vị trí ban đầu. Dữ liệu lịch sử bên trong snapshot kiểm toán giữ nguyên.

Chạy các lệnh từ thư mục BE. MONGODB_URI trong môi trường hoặc .env phải chọn đúng tên database trong lệnh. File sao lưu nằm ngoài Git, chỉ gồm bản ghi khóa, thuộc tính và index collection, cùng ID và giá trị BSON của hai trường tại thời điểm sao lưu. Dùng một tên file mới cho mỗi lần backup.

```powershell
node scripts/migrate-db-phase-one.mjs backup wmsd_database .local/db-phase1-wmsd-20261122.ejson
node scripts/migrate-db-phase-one.mjs apply wmsd_database .local/db-phase1-wmsd-20261122.ejson
```

Apply kiểm lại bản sao với dữ liệu đích, đổi tên collection khóa sang tên tạm riêng, cập nhật hai trường trong transaction và chỉ xóa collection tạm sau khi kiểm chứng. Nếu bị gián đoạn, dùng lại đúng file backup để chạy tiếp hoặc khôi phục. Nếu giá trị mới xuất hiện ngoài bản sao, kiểm tra tiến trình ghi dùng schema cũ. Cập nhật các instance backend chạy cùng DB để schema cũ ngừng ghi default khi lập đơn.

Lệnh khôi phục tái lập collection cùng index và giá trị từng trường theo ID. Nó dừng khi ID mất hoặc giá trị xung đột. Giữ file backup ở nơi lưu trữ riêng có kiểm soát truy cập.

```powershell
node scripts/migrate-db-phase-one.mjs restore wmsd_database .local/db-phase1-wmsd-20261122.ejson
```

## Kết quả triển khai

Ngày 23/11/2026 đã áp dụng trên wmsd_database, từ 59 còn 58 collection. Bản sao gồm 6 khóa và index, 45 giá trị planning và 0 executionStatus. Đã so khớp mã băm của tất cả trường còn lại trên 45 đơn bán và 5 phiếu chuyển. Kiểm thử local gồm 57 test model/seed, 21 test tích hợp và hai lần chạy mỗi chiều apply/restore trên DB diễn tập. Phân bổ 40/160 viên đã lưu và đọc lại thành công.
