# Dữ liệu mô phỏng cửa hàng gạch ốp lát

Bản seed BE `wmsd-tile-shop-20261119-v12` dựng 58 collection dữ liệu mẫu. Các tên, giá và số đo là dữ liệu tổng hợp. Bằng chứng là PNG test và SMTP không gửi thật. [Sản phẩm, lô và thùng](../03_thiet_ke/DB_Rebuild_Review/39_San_pham_va_lo_dang_chot.md).

`RR-202610-001` lưu lượng duyệt 120 viên. `PO-202610-001` đặt 120 viên với đơn giá 35.000 VNĐ/viên và thành tiền 4.200.000 VNĐ. Quy đổi thùng của seed nằm ở cấp lô để sử dụng khi nhận hàng.

## Mở trong Compass

```text
mongodb://localhost:27017/wmsd_api_test_6aedf823b3e33975e06c07d1
```

Sau reset test, database trên phải chưa tồn tại cho đến khi người dùng chạy `npm run seed` từ BE với URI loopback.

## Dữ liệu demo Atlas đã nạp

Ngày 17/11/2026, theo yêu cầu người dùng, đã xoá `src/seeds/atlas-demo.seed.js` và test riêng `test/atlas-demo.integration.test.js`. Không còn lệnh chạy seed demo Atlas này. Việc xoá file không xoá hoặc thay đổi dữ liệu đã nạp trong `wmsd_database`; các seed khác được giữ nguyên. Phần dưới mô tả bộ dữ liệu đã nạp trước khi xoá script, không phải xác minh lại dữ liệu đang chạy.

Bộ mẫu `wmsd-demo-261116-v1` có 4.016 bản ghi, chia thành tám nhóm `DM01` đến `DM08` tại `K-GACH-01` và `K-GACH-02`. Tìm theo tiền tố trên SKU, mã vị trí hoặc ghi chú phiếu. So sánh trạng thái và lọc theo ngày có thể dùng các chứng từ trải qua nhiều kỳ. Các nhóm có lô, tồn, bút toán và chứng từ nguồn riêng.

| Muốn demo | Tìm dữ liệu |
|---|---|
| Tồn, lô, đóng thùng và quy đổi | SKU `DM01-AP6601` |
| Chuỗi mua đã nhập | PO `ĐMH-K-GACH-01-261010-901001` và phiếu nhập `PNM-K-GACH-01-261010-901001` |
| Mua và nhận đang xử lý | RR chờ duyệt trong `DM02`, PO nháp trong `DM04`, PO mở trong `DM05`, kiểm nhận nháp từng phần trong `DM06` và đủ lượng trong `DM07` |
| Phiếu nhập khác | `PNK-K-GACH-01-261115-901001` đang nháp |
| Xuất bán và giao hàng | `ĐBH-KD-261012-901001`, có yêu cầu xuất, lệnh giao, phiếu xuất và hóa đơn |
| Điều chuyển và kiểm kê | `YCĐC-KG1-261019-901001` và `KK-K-GACH-02-261025-901001` |
| Trả hàng và giao thất bại | `ĐTK-K-GACH-01-261017-901001`, `ĐTNCC-K-GACH-01-261022-901001` và `GHTB-K-GACH-01-261015-901001` |

Quyền xem và thao tác vẫn theo tài khoản và kho được phân công. Một số phiếu lịch sử giữ kiểu ID ObjectId để các trường tham chiếu cũ hoạt động. Metadata bằng chứng mẫu ở trạng thái `SUPERSEDED` và không có tệp tải xuống. Bộ seed không tạo thông báo hay yêu cầu gửi email.

## Quy mô

| Nhóm | Dữ liệu |
|---|---|
| Kho | 3 kho: gạch trung tâm 3.000 m², gạch số 2 1.000 m², gạch dự phòng 900 m² (chưa có hàng trong bộ mẫu; đổi nhãn kho mẫu, không khẳng định khảo sát thực tế đổi). Chiều dài/rộng/cao được mô phỏng phù hợp diện tích khảo sát |
| Nhân sự | 15 tài khoản: Owner, Admin, 7 Sales, 3 Warehouse, 3 Accountant. Có role mẫu Trưởng ca kho |
| Category | 5 nhóm: lát nền (9), ốp tường (3), trang trí (2), sân vườn (2), giả gỗ (2); mỗi product một categoryId |
| Sản phẩm | 18 mã gạch hãng giả lập: ốp/lát/sân/giả gỗ; bỏ thiết bị vệ sinh theo yêu cầu |
| Lô | 39 lô theo sản phẩm + mã hãng, số viên/thùng cố định và một lô chờ xác minh |
| Đối tác | 20 khách, 3 NCC; không có danh mục đội xe, biển số ghi trên bàn giao |
| Tồn | 51 nhóm số dư theo ô/lô/chất lượng/chủ hàng, 32 giao dịch tồn và 70 dòng biến động |
| Đơn vị và quy đổi | Mã và tên lần lượt là Viên, Thùng (`isCarton: true`) và Mét vuông (`areaMm2: 1000000` kiểu Decimal128). Viên và Thùng có `areaMm2: null`. |
| Tổng | 58 collection nghiệp vụ, 702 bản ghi cấp bảng. 81 hồ sơ nghiệp vụ tính cả bàn giao nhúng, 115 dòng nhúng. Không có collection marker kỹ thuật |

## Nên xem

- `products`: lọc `{ "sku": "AP6601" }` để xem gạch lát nền vân đá trắng 60×60, đơn vị gốc Viên.
- `product_batches`: lọc theo productId đó để thấy manufacturerLot, piecesPerCarton và cartonLengthMm/cartonWidthMm/cartonHeightMm; không có calibre/tone.
- `goods_arrivals`, `goods_receipts` với `documentKind: "PURCHASE"`: mở `items` để xem productId, lotId, enteredUnit/enteredQty, baseUnitsPerUnit, qtyBase và packagingSnapshot. Dòng 10 thùng × 4 viên cho qtyBase 40. Các phần kiểm nhận/hàng mở có thể ghi theo viên thực tế.
- `opening_stocks`: các dòng thùng nguyên theo lô có locationId, số thùng và quy cách. Nguồn tồn này có người kho lập, Owner xác minh, transaction và movement tương ứng.
- `inventory_balances.packagingPortions[]`: SEALED ghi số thùng nguyên và quy cách; OPEN/LOOSE ghi hàng mở/lẻ và thể tích đo. Đây là bố trí cùng lượng tồn, không cộng thêm lần nữa; không có bảng storage_stacks/storage_stack_items.
- `warehouse_transfer_requests`, `transfer_dispatches`, `goods_receipts` với `documentKind: "TRANSFER"`: TR có nhiều phiếu xuất, một phiếu xuất có nhiều lần nhận. Liên kết bằng ID dòng và header nguồn.
- `goods_receipts` với `documentKind: "OTHER"`: nhập thủ công, phê duyệt và các tình huống sửa sai (`NK-202610-001` đã ghi sổ kèm chứng cứ, `NK-202610-002-OLD` đã bỏ ghi `REVERSED`, `NK-202610-002` thay thế liên kết `originalReceiptId`, `NK-202610-003` nháp có chứng cứ).
- `transfer_orders`: lọc `{ "header.taskKind": "RELOCATE" }` cho BF03 hoặc PICK/PUTAWAY cho BF04.
- `sales_invoices`: hóa đơn `HD-202610-001` có hai phiếu xuất khác ngày, 12 viên khách nhận, giá mô phỏng 50.000 đồng/viên, tổng 600.000 đồng. Mở goodsIssueId để đối chiếu phiếu xuất.
- `stocktake_counts`: lọc `{ "attemptNo": 2 }` để xem đếm lại và liên kết lần đếm cũ.

## Nguồn seed và cách thay

- `src/seeds/rebuild/data.js` dựng đồ thị dữ liệu và gọi các kịch bản.
- `tile-shop.js` khai báo danh mục mô phỏng, nhân sự, lô, ô, tồn đầu kỳ theo thùng và quy cách số dư cuối kỳ.
- `workflow-data.js`, `scenarios.js`, `support-data.js` giữ các kịch bản liên luồng và lịch sử.
- `validate.js` kiểm schema/ref, chuỗi tồn, lượng giữ, quyền duyệt, TR/nhận, sức chứa, hóa đơn và dữ liệu thùng.
- `database.js` kiểm tập collection, fingerprint và ghi seed. `run.js` là CLI.

Một thùng chứa đúng một sản phẩm và một lô. Các thùng chung dòng phải cùng quy cách. Quy cách của seed nằm trong mã seed để tạo snapshot trên dòng, không phải danh mục UOM mới. Kích thước sản phẩm và kích thước ngoài thùng có ý nghĩa riêng.

```powershell
npm run seed                    # Tự động seed toàn bộ 58 collection khi DB trống
npm run seed:goods-receipts     # Seed riêng 5 loại GoodsReceipt (PURCHASE, CUSTOMER_RETURN, FAILED_DELIVERY, TRANSFER, OTHER)
npm run db:demo
npm run test:db-rebuild
npm run db:local:seed
npm run db:local:verify
npm run docs:check
```

Các lệnh dưới đây đã nạp và xác minh seed trên MongoDB cục bộ bằng một database riêng. Đối soát ghi nhận 1 PO, 1 phiếu nhập và 0 lỗi.

```powershell
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/admin?replicaSet=rs0'
npm run db:demo -- --apply --target wmsd_demo_rr_po_quantity_20261119
npm run db:demo -- --verify --target wmsd_demo_rr_po_quantity_20261119
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/wmsd_demo_rr_po_quantity_20261119?replicaSet=rs0'
npm run purchase:reconcile
```

Lệnh xem trước không cần MongoDB. Lệnh seed tạo target mới hoặc xác minh đúng target đã seed cùng version. Khi bộ đã seed bị sửa, công cụ từ chối ghi đè. Khi thay nội dung seed, tăng version và chọn một target local mới hoặc chuẩn bị kế hoạch chuyển rõ ràng. Không drop DB để làm test pass.

### Đồng bộ danh mục UOM trên DB local hiện có

Ngày 14/11/2026, DB `mongodb://localhost:27017/wmsd_demo_tile_shop_v9` được đồng bộ riêng collection `uoms` trong một transaction. Ba mục đang dùng là `Viên`, `Thùng` và `Mét vuông`. Các mục trùng từ `PIECE` và `BOX` được đổi mã và tên thành `Viên (cũ)`, `Thùng (cũ)` rồi ngừng sử dụng. Kiểm tra trước khi ghi không thấy mã cũ được lưu dưới dạng chuỗi ở các collection khác. Việc giữ nguyên ID bảo toàn cả 81 tham chiếu từ `conversions`, đã kiểm tra lại sau khi ghi. `npm run seed` chỉ seed toàn bộ khi DB trống.

Đã bổ sung test category và kiểm liên kết. [Seed local v8](../../outputs/categories_v8_local_seed_2026-11-06.json); [Atlas v8](../../outputs/categories_v8_atlas_deployed_2026-11-06.json); [hướng dẫn category](CATEGORIES_V8.md). Các test này kiểm dữ liệu/model, không phải chứng nhận API/FE đã chuyển hoàn tất.
