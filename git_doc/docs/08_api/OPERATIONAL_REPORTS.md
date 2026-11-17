# Báo cáo vận hành UC-113 — hợp đồng API (15/11/2026)

Nguồn: bảng vai trò – nhóm báo cáo do chủ cửa hàng xác nhận ngày 15/11/2026 (`openspec/changes/complete-fe08-fe09-use-cases`, quyết định D5, nằm ngoài repo này), đối chiếu SRS SC-20. "Movement" trong SC-20 không có nhóm báo cáo riêng vì nhật ký chuyển động thuộc UC-114. Mã nguồn: `src/modules/operational-reports/`; kiểm thử: `test/operational-reports.test.js`.

Báo cáo chỉ đọc: chạy hoặc xuất báo cáo không tạo, sửa, duyệt hay ghi sổ bất kỳ bản ghi nào. Mọi endpoint nằm dưới `/api/reports`, dùng `Authorization: Bearer` và cần quyền `report:read`.

## Nhóm báo cáo theo vai trò

Máy chủ quyết định theo `role.code` của tài khoản (`OWNER`, `ACCOUNTANT`, `WAREHOUSE`); giao diện không tự suy nhóm.

| Vai trò | Nhóm được chạy |
|---|---|
| `OWNER` | cả 11 nhóm: `inventory`, `purchases`, `receipts`, `issues`, `sales`, `transfers`, `defects`, `returns`, `supplierReturns`, `stocktakes`, `adjustments` |
| `ACCOUNTANT` | `purchases`, `receipts` |
| `WAREHOUSE` | `inventory`, `transfers`, `stocktakes`, `adjustments` |
| vai trò khác có `report:read` | không nhóm nào |
| không có `report:read` | không dùng được `/reports` (403) |

Seed hiện cấp `report:read` cho Owner, Accountant và Warehouse Staff (`src/seeds/data/permissions.data.js`).

**Giới hạn vai trò tùy chỉnh.** Admin có thể tạo vai trò mới và gán `report:read`, nhưng bảng ánh xạ chỉ biết ba mã trên: vai trò tùy chỉnh nhận danh sách nhóm rỗng và bị từ chối mọi nhóm. Muốn cấp nhóm cho vai trò mới phải đổi mã nguồn (hằng `ROLE_GROUPS`) hoặc có quyết định nghiệp vụ mới; việc này chưa được yêu cầu nên chưa có cấu hình động.

## Endpoint

| Endpoint | Quyền | Kết quả |
|---|---|---|
| `GET /api/reports/options` | `report:read` | Nhóm được phép và kho trong phạm vi của người gọi |
| `GET /api/reports` | `report:read` + nhóm được phép | Một báo cáo theo bộ lọc |

`GET /reports/options` trả:

```json
{ "data": { "groups": ["purchases", "receipts"], "warehouses": [{ "id": "…", "code": "WH-01", "name": "Kho chính" }] } }
```

`groups` giữ thứ tự cố định như bảng trên (nhóm đầu tiên là nhóm giao diện chọn sẵn). Owner thấy mọi kho; vai trò khác chỉ thấy kho được giao.

## Bộ lọc

Query strict, mọi bộ lọc là tùy chọn:

| Tham số | Ý nghĩa |
|---|---|
| `group` | một trong 11 nhóm; mặc định `inventory` |
| `warehouseId` | ObjectId kho; phải nằm trong kho được giao (Owner: mọi kho) |
| `from`, `to` | ISO 8601 có múi giờ (`Z` hoặc `+07:00`), gồm hai đầu, lọc theo ngày lập chứng từ (`createdAt`). Nhóm `inventory` là ảnh chụp tồn hiện tại, giao diện không gửi khoảng ngày cho nhóm này |

Không có `warehouseId` thì báo cáo bao phủ đúng các kho được giao của người gọi (Owner: mọi kho). Khóa lạ, nhóm lạ, `warehouseId` sai định dạng, ngày sai định dạng (kể cả ngày không có giờ hoặc múi giờ) hoặc `from` > `to` đều bị từ chối `400` và không trả dòng nào; `from` = `to` hợp lệ.

## Từ chối

| Tình huống | HTTP / mã lỗi |
|---|---|
| Thiếu `report:read`, tài khoản khóa hoặc không có vai trò hợp lệ | `403` `ERR-CORE-403-001` |
| Nhóm ngoài danh sách của vai trò | `403` `ERR-CORE-403-001`; không đọc dữ liệu nào |
| `warehouseId` ngoài kho được giao | `403` `ERR-CORE-403-002` |
| Bộ lọc sai (xem trên) | `400` `ERR-CORE-400-001` |

Thứ tự kiểm tra: quyền, nhóm, kho, rồi mới đọc dữ liệu.

## Nội dung báo cáo

Chỉ đại lượng vận hành, số lượng dạng chuỗi thập phân chính xác kèm đơn vị gốc: tồn vật lý, khả dụng, đã giữ, giữ hộ, đang chuyển (tách riêng khỏi tồn trên kệ), lượng còn chờ nhận/xuất, lượng khách thực nhận, đơn đã giao/hoàn tất/hủy, kết quả hàng lỗi, điều chuyển, trả hàng, kiểm kê. **Không có doanh thu, giá vốn, giá hay lợi nhuận** trong bất kỳ dòng nào; dòng được dựng từ danh sách trường cố định nên trường giá của chứng từ gốc không lọt ra. Test kiểm tra điều này cho cả 11 nhóm.

Phản hồi: `{ group, capturedAt, rows }` (`inventory` thêm `basis: "CURRENT_TRANSACTION_SNAPSHOT"`). File CSV xuất từ màn hình chỉ chứa đúng các dòng và cột đang hiển thị, tạo ở trình duyệt, không gọi thêm API ghi.

## Kiểm chứng và giới hạn

Test dùng model giả lập và hàm thuần: ánh xạ ba vai trò và vai trò tùy chỉnh, từ chối nhóm, thiếu `report:read`, kho ngoài phạm vi, phạm vi kho mặc định, khoảng ngày đảo ngược/sai định dạng, không có trường tài chính, không gọi hàm ghi của model. Chưa chạy chống MongoDB thật; route `/reports` chưa được gọi qua HTTP có xác thực trong test (schema query được test trực tiếp).
