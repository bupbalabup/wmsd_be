# Kho 3D — Chặng 2: khu vực và ô pallet

Ngày 12/11/2026. Chặng này mở rộng bản vẽ nền/tường/cửa; chưa quản lý hàng trên pallet hoặc cập nhật tồn.

## Luồng sử dụng

1. Mở thiết kế kho, khép kín mặt bằng, chọn **Khu vực & ô**.
2. Chủ cửa hàng (`OWNER`) có quyền `warehouse_location:update` được cấu hình chức năng khu vực của tất cả kho, kể cả tài khoản chưa được gán kho và kho mới tạo. Vai trò khác cần cả `warehouse_location:update`, `warehouse_layout_function:update` và phân công kho phù hợp. Danh mục hiện thuộc từng kho; tên tự tạo, không trùng. Danh mục trống không khóa việc vẽ/lưu nháp; vùng chưa gán chức năng chưa được áp dụng.
3. Bấm **Vẽ khu vực trên mặt bằng**, kéo từ một góc sang góc đối diện, nhập tên/chức năng/màu rồi thêm; hoặc bấm **Nhập khu vực** để nhập kích thước trực tiếp.
4. Chọn khu vực từ bản vẽ hoặc danh sách. Chỉnh tọa độ, rộng/dài, góc xoay và giới hạn chiều cao trong form. Kéo khu vực trên mặt bằng để di chuyển; các ô bên trong di chuyển theo.
5. Chọn khu vực rồi bấm **Vẽ ô pallet** ngay trên canvas để kéo vẽ ô, hoặc nhập tọa độ tương đối và rộng/dài, hoặc mở **Tính kích thước ô theo pallet**: nhập số hàng/cột, dài/rộng pallet, khoảng hở, khoảng cách tới mép rồi tính. Vẫn sửa kích thước trực tiếp được.
6. Khi thêm hoặc cập nhật ô, dùng **Vị trí trong kho** để tìm theo mã/tên và gán một vị trí đã tạo. Có thể để trống hoặc bỏ gán. Kéo ô để đổi tọa độ trong khu vực; ô dùng cùng hướng với khu vực, chưa xoay riêng. Khu vực xoay quanh góc gốc `(x,y)`.
7. Kiểm tra màu vùng và đường kẻ ô trong 2D/3D. Bấm **Lưu bản nháp** hoặc **Áp dụng thiết kế**.

Chức năng khu vực là nhãn thiết kế; không đổi loại vị trí nghiệp vụ RECEIVING/STORAGE/... và không tự cấm/cho phép giao dịch tồn. Xóa chức năng đang được dùng bị chặn. Từ 18/11/2026, ô thiết kế có thể tham chiếu một WarehouseLocation đã tạo trong cùng kho. Bỏ gán hoặc xóa ô/khu trong thiết kế không xóa vị trí nghiệp vụ hoặc hàng thực tế.

## Quy tắc

- Khu vực chữ nhật xoay được, không chồng lấn diện tích; chạm cạnh được phép. FE chặn khi tạo/sửa/di chuyển; BE kiểm lại mọi lần lưu, kể cả nháp.
- Ô thuộc đúng khu vực chứa nó; tọa độ local `(x,y)` đo từ góc gốc khu vực. Không chồng ô trong cùng khu vực, không trùng tên ô trong cùng khu; ID ô duy nhất trong thiết kế.
- Chỉ vị trí đang hoạt động được chọn khi gán mới. Nếu vị trí ngừng hoạt động sau khi gán, ô hiện tại vẫn hiển thị và giữ liên kết; có thể đổi sang vị trí khác hoặc bỏ gán. Vị trí không tồn tại hoặc thuộc kho khác bị từ chối khi lưu. Mỗi ô có tối đa một liên kết; liên kết không thay đổi kích thước nghiệp vụ, loại vị trí, tồn hay quy trình chuyển hàng.
- Tạo/sửa/di chuyển vùng và ô qua UI yêu cầu nằm trong ranh giới, ngoại trừ khu vực được gán chức năng **Khu tập kết** hoặc **Tập kết** (không phân biệt hoa thường, theo tên chức năng của `zone.functionId`). Theo yêu cầu ngày 18/11/2026, vùng này có thể nằm toàn bộ hoặc một phần ngoài tường kho và vẫn được áp dụng. Tên riêng của vùng không quyết định ngoại lệ. Nút Vừa bản vẽ và góc nhìn 3D ban đầu tính cả phạm vi các vùng ngoài kho.
- Nếu sửa đường bao khiến vùng loại khác ra ngoài hoặc nếu kích thước vùng làm ô không còn vừa, bản nháp vẫn được lưu nhưng không áp dụng được. Khi form sửa vùng làm ô vượt ranh giới, FE giữ trạng thái cũ để người dùng sửa ô trước. Ô và pallet của khu tập kết vẫn phải nằm trong vùng và ô tương ứng; kiểm chồng lấn và chiều cao không đổi.
- Giới hạn xếp kho mặc định bằng chiều cao tường, có thể đặt thấp hơn; giới hạn khu vực tùy chọn, phải không cao hơn giới hạn kho. Ô kế thừa giới hạn hiệu lực của khu vực.
- Kiểm vùng trong kho dùng kiểm cả cạnh, không chỉ bốn góc; hỗ trợ kho lõm/chữ L. Kiểm chồng vùng dùng trục phân tách của các chữ nhật xoay.
- Giới hạn 100 chức năng, 100 khu vực, 500 ô/khu và 2000 ô/toàn thiết kế.
- Công thức lưới pallet: rộng = cột × rộng pallet + (cột − 1) × khoảng hở + 2 × mép; dài tương tự theo hàng và dài pallet. Cấu hình tính kích thước chỉ là thông tin thiết kế ô, chưa tạo pallet thực tế.

## Cấu trúc dữ liệu mở rộng

`warehouses.layout3d` vẫn là bản nháp hiện tại. Các field tùy chọn mới:

| Field | Nội dung |
|---|---|
| `maxStackHeight` | Giới hạn chiều cao xếp hàng của kho, m |
| `functions[]` | `{id, name}`, danh mục chức năng của kho |
| `zones[]` | `{id, name, x, y, width, length, rotation, color, functionId, maxHeight?, slots[]}` |
| `zones[].slots[]` | `{id, name, x, y, width, length, locationId?, palletPlan?}`; `locationId` là chuỗi ObjectId của `warehouse_locations._id` |
| `palletPlan` | `{rows, columns, palletWidth, palletLength, gap, margin}` |

Từ danh mục có thể chọn các ô đã lưu của kho khi tạo hoặc sửa vị trí. Danh sách và chi tiết vị trí tra ngược qua cùng `slot.locationId`. Chi tiết phân biệt bản nháp và bản đã áp dụng. Chọn tên ô trong bản nháp để mở đúng kho, khu vực và ô; từ ô có thể mở lại vị trí nghiệp vụ.


Tất cả số đo bằng mét, góc bằng độ. ID của các đối tượng thiết kế là UUID do FE cấp; `locationId` lưu riêng, không thay ID ô. `maxHeight` bỏ trống là kế thừa. Chiều rộng/dài dương tối thiểu 0,01 m; tên tối đa 120 ký tự; màu dạng hex `#RRGGBB`.

Kho thêm hai field tùy chọn, không đổi index/quan hệ collection:

```mermaid
classDiagram
  class Warehouse {
    Object layout3d
    Object layout3dApplied
    Date layout3dAppliedAt
    Date updatedAt
  }
  class Layout {
    Point[] points
    number height
    Door[] doors
    number maxStackHeight
    AreaFunction[] functions
    Zone[] zones
  }
  class Zone {
    string id
    string functionId
    number rotation
    number maxHeight
    Slot[] slots
  }
  class Slot {
    string id
    string locationId
  }
  class WarehouseLocation {
    ObjectId _id
  }
  Layout *-- Zone
  Zone *-- Slot
  Slot ..> WarehouseLocation : optional reference
  Warehouse *-- Layout
```

`layout3dApplied` là snapshot thiết kế được áp dụng gần nhất; `layout3dAppliedAt` là thời điểm áp dụng. Lưu nháp không sửa snapshot này. Chưa có lịch sử nhiều revision hoặc cơ chế khôi phục snapshot từ UI.

## API và quyền

Giữ `PUT /api/warehouse-catalogue/:id/layout` và thêm body `apply?: boolean`:

- Bỏ trống/false: ghi bản nháp; containment lỗi trả trong `data.issues` nhưng không chặn lưu.
- true: kiểm containment, không đạt thì từ chối toàn bộ; đạt thì ghi bản nháp và snapshot áp dụng cùng transaction/audit.
- Response thêm `data.appliedAt` nếu đã từng áp dụng và `data.issues`.
- GET chi tiết kho trả thiết kế và danh sách mã/tên/trạng thái vị trí thuộc chính kho đó; không cần thêm API để lấy danh sách chọn. PUT kiểm các ID theo lô trong transaction cho cả bản nháp lẫn áp dụng, đối chiếu ô tương ứng trong bản đã lưu khi giữ một liên kết ngừng hoạt động.
- Mọi ghi kiểm `warehouse_location:update`, phạm vi kho và `expectedUpdatedAt`. Phạm vi của `OWNER` bao gồm mọi kho, không phụ thuộc `warehouseIds`. Với vai trò khác, đổi `functions[]` so với bản đã lưu kiểm thêm `warehouse_layout_function:update` bên trong transaction; người thiếu quyền này vẫn sửa vùng/ô với danh mục hiện có ở kho được phân công.
- Audit áp dụng dùng `APPLY_WAREHOUSE_LAYOUT`; lưu nháp giữ `SAVE_WAREHOUSE_LAYOUT`. Hai lệnh hiện dùng cùng quyền sửa kho; quyền riêng cho áp dụng sẽ cần thiết kế nếu muốn tách sau.

Áp dụng hiện chỉ xác lập snapshot thiết kế hình học, không tạo/chuyển/xóa balance, WarehouseLocation hay phiếu nghiệp vụ. Không coi snapshot này là đã tự bố trí hàng tồn.

## Tương thích và kiểm chứng

Thiết kế chặng 1 thiếu functions/zones/maxStackHeight vẫn đọc/sửa được, danh sách rỗng và giới hạn kế thừa từ tường. Không backfill/migration/ghi DB chung trong lượt này. BE nạp lại code để nhận schema/API mở rộng.

FE và BE giữ cùng mã geometry; FE có file khai báo kiểu riêng. Kiểm thử có chữ nhật xoay/chạm mép, vùng cắt phần lõm dù góc nằm trong kho, ô vượt khu, chồng ô, giới hạn cao, công thức lưới và tọa độ local xoay theo khu. Component test có tạo chức năng → vùng → ô → áp dụng, cùng lưu nháp có lỗi containment/chặn áp dụng.

Chưa kiểm giao diện WebGL trực tiếp hoặc transaction DB qua API trong chặng này. Chưa có hàng/pallet/chồng hàng hoặc tích hợp tồn, chưa có thao tác kéo khu/ô trực tiếp trong 3D; 3D hiện phản ánh bố trí chỉnh trên 2D/form. Các phần đó thuộc chặng tiếp theo.

## Sửa lỗi công cụ vẽ — 12/11/2026
Bỏ điều kiện functions rỗng làm vô hiệu nút vẽ khu vực. `zone.functionId` có thể là chuỗi rỗng trong bản nháp; mã không rỗng vẫn phải thuộc danh mục, và áp dụng vẫn bắt buộc mọi vùng được gán chức năng. Không mở quyền tạo danh mục cho người thiếu quyền quản trị.

Canvas có nút Vẽ khu vực và Vẽ ô pallet. Ô cần chọn khu vực trước, tọa độ kéo được đổi về hệ local của vùng (kể cả vùng xoay). Lấy kích thước từ tọa độ sự kiện thả chuột, tránh phụ thuộc frame preview chưa render. Sau thả giữ preview vùng/ô và hiện nút xác nhận liên kết tới form thuộc tính; có nút hủy. Pan/zoom không tạo hình.

## Chặng pallet và cảnh báo chiều cao — 12/11/2026

Mỗi ô có thể có `pallets[]`. FE cho nhập mã pallet, vị trí local trong ô, rộng/dài, chiều cao đế và chiều cao hàng dự kiến. Chiều cao hiệu lực là `actualHeight` nếu có, nếu không là `baseHeight + stackHeight`. Pallet vượt giới hạn khu vực/kho hiện màu đỏ trên 2D/3D và hiện cảnh báo; bản nháp vẫn lưu và được áp dụng; xem cập nhật 17/11 bên dưới. Pallet vượt mép ô bị chặn ngay. Phần lớp hàng nhiều mã/lô và số đo thực tế đã bổ sung ngày 17/11 tại [chặng lớp hàng](STAGE3_PALLET_LAYERS.md). Chưa ghi tồn hoặc tự tạo pallet nghiệp vụ.
