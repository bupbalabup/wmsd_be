# Kế hoạch triển khai: xuất bán và trả hàng — 25/11/2026

**Trạng thái: đề xuất, chưa triển khai.** Dùng hướng dẫn demo người dùng cung cấp làm đích nghiệm thu: bán 8 viên → khách trả 4 viên → trả NCC 4 viên từ **lô khác**. Mượn cách `ReplenishmentDraftEditor` và `ReplenishmentProductTable` trình bày sản phẩm, căn cứ và đơn vị ngay trên dòng; không bê bước mua–nhập hoặc nút duyệt của luồng mua sang đây.

## 0. Chốt phạm vi và bản chạy

- Làm trên cặp checkout `trungph` của backend/frontend. Ghi SHA hai repo và DB demo cô lập trước khi kiểm thử. Đối chiếu nhánh thực tế chứ không suy ra tính năng từ ảnh hoặc dữ liệu mẫu.
- [API Phiếu xuất hiện hành](../08_api/GOODS_ISSUES.md) từ chối tạo mới `SALE` chỉ bằng mã ngoài; phiếu cũ vẫn giữ luồng tương thích. Bật lại nút `SALE` không tự khôi phục backend.
- **Cổng quyết định:** trước khi viết phần khôi phục, xác nhận cho phép tạo mới `SALE` theo mã ngoài theo đúng chuỗi Kinh doanh tạo → Ban điều hành duyệt → Kho vận giữ chỗ, soạn và ghi xuất. Không mở lại màn Sales Order, không thay đổi luồng bán nội bộ hiện có, không mở rộng quyền hoặc đổi schema chỉ vì bố cục. Rà các quyền và lệnh tương thích trước; nếu không đủ, ghi rõ phần chênh lệch để chốt thay vì nới quyền ngầm.
- Trong lúc chờ quyết định, có thể làm tra cứu khách trả, cải thiện xuất trả NCC và nghiệm thu từ `PXB` đã ghi sổ; không quảng bá ca bắt đầu từ tạo mới `PXB` như đã chạy được.

## 1. Xuất bán theo mã ngoài và quy đổi

1. Đối chiếu `goods-issue.routes.js`, `goods-issue.validation.js`, `goods-issue.service.js` và test xuất trực tiếp/tương thích. Nếu được duyệt, phục hồi đúng nhánh tạo mới theo mã ngoài qua luồng tương thích hiện có; giữ kiểm quyền/warehouse scope, phiên bản, idempotency và audit. Mã ngoài là tham chiếu, không là Sales Order ID hoặc khóa duy nhất. Phải có test từ chối vai trò không đúng, kho ngoài phạm vi, ghi xuất trước khi soạn đủ và gửi lại lệnh ghi xuất không trừ tồn lần hai.
2. Đối chiếu trang tạo và chi tiết phiếu xuất với `DESIGN.md` của FE. Dùng hai vùng: bảng dòng hàng bên trái, thông tin chứng từ và nút đúng vai trò bên phải; màn hẹp xếp chồng hai vùng. Kinh doanh chọn kho rồi tìm SKU/tên; khi đổi kho phải bỏ lựa chọn và dữ liệu khả dụng của kho cũ. Hiện SKU/quy cách, khả dụng, lượng nhập, đơn vị và lượng gốc ngay trên dòng. Khung chứng từ hiện mã ngoài, tên khách và SĐT tùy chọn; không buộc chọn lô lúc tạo phiếu. Kho vận chọn lô khi soạn.
3. Dùng chuyển đổi và quy tắc số nguyên hiện có của phiếu xuất, không dùng cách làm tròn của mua hàng. Chi tiết phiếu thể hiện cả lượng/đơn vị đã nhập và lượng gốc từ snapshot. Số khả dụng trên form chỉ hỗ trợ quyết định; backend kiểm lại theo kho/lô ở bước giữ chỗ và ghi sổ tương ứng. Ban điều hành duyệt không giữ chỗ hoặc thay đổi tồn vật lý; xác nhận soạn không trừ tổng tồn kho.

## 2. Tra cứu chứng từ nguồn khi khách trả

1. Mở rộng lookup `kind=sources&purpose=customer-returns` trong `native.lookup.js` để tra cả số `PXB` và mã ngoài trên phiếu xuất. Lọc quyền, kho và phiếu `POSTED` trước khi phân trang; giữ nguyên nhánh nguồn lịch sử đã xác minh và các mục đích lookup khác. Tìm theo chuỗi literal, không khớp suy đoán theo tên/SĐT. Nếu trùng mã ngoài, trả từng phiếu đủ quyền với ngày, số phiếu, mã ngoài và thông tin dòng/lô để người dùng chọn.
2. Trên form `ĐTK`, hiển thị lượng còn được trả theo dòng/lô. Chỉ lấy tên/SĐT từ phiếu được chọn nếu nguồn có thông tin; nếu thiếu tên thì giữ cách nhập tay hiện hành. Không dùng `salesOrderReference` để cấp quyền, chọn nguồn hoặc tính hạn mức. Khi đổi phiếu, xóa lựa chọn dòng/lô và thông tin khách lấy từ nguồn cũ.
3. Chi tiết cho Kho vận hiện ngay `PXB` nguồn, lô, lượng đề nghị và lượng thực kiểm. Không đổi loại chứng cứ, thẩm quyền hoặc chuyển trạng thái: Kho vận kiểm → Kinh doanh quyết định → Kho vận ghi nhập phần được chấp nhận. Backend kiểm lại hạn mức và nguồn trong transaction; phiếu bán nội bộ vẫn tính theo lượng khách xác nhận đã nhận, phiếu standalone áp dụng hạn mức hiện hành của nguồn đó.

## 3. Xuất trả NCC theo thỏa thuận

- Dùng cùng bố cục nhưng cột riêng: sản phẩm/lô nguồn → lượng đã bàn giao → còn được bàn giao → lượng lần này theo đơn vị gốc. Cột phải hiện NCC, kho, nguồn thỏa thuận, chứng cứ và người nhận. Không tạo một lệnh độc lập nếu màn `Phiếu xuất` và màn `ĐTNCC` đều đã dẫn vào cùng thao tác bàn giao.
- Lấy số còn bàn giao từ thỏa thuận hợp lệ trừ lượng đã bàn giao; kiểm lại khi ghi sổ. Nếu nhập vượt phần còn lại, từ chối toàn bộ thao tác, không sinh chứng từ hay ghi tồn. Kế toán ghi nhận NCC đã nhận trên dòng bàn giao, không sinh lần xuất thứ hai. Giữ nguyên nhánh hàng giữ hộ và không dùng `PXNCC` cho hàng thuộc sở hữu NCC.

## 4. Nghiệm thu, triển khai và chia commit

- Chạy test BE/FE tập trung theo ma trận trong [hướng dẫn demo local](TRUNG_DEMO_LOCAL.md). Ghi SHA, dữ liệu ban đầu, chứng từ, thay đổi tồn và kết quả thật. Không sửa chứng từ demo gốc hoặc ghi DB dùng chung.
- Chia commit theo thay đổi có thể review độc lập: (1) phục hồi cổng tạo `SALE` BE và test, nếu được duyệt; (2) bố cục/quy đổi xuất bán FE; (3) lookup nguồn khách trả BE và test phạm vi; (4) picker và chi tiết khách trả FE; (5) bố cục xuất NCC và kiểm hạn mức; (6) fixture/kịch bản nghiệm thu nếu có thay đổi riêng. Không tạo commit rỗng hoặc tách code khỏi test trực tiếp của nó.
- Mỗi phần cập nhật `git_doc/change_logs.md` và tài liệu tương ứng: [Phiếu xuất](../08_api/GOODS_ISSUES.md), [Trả hàng](../08_api/RETURN_WORKFLOWS_NATIVE.md), hướng dẫn demo/local, và quyền hoặc model map **chỉ nếu thực sự đổi**. Với commit FE, cập nhật tài liệu ở BE cùng task, ghi commit FE tương ứng để truy vết. Chỉ cập nhật hợp đồng hiện hành sau khi hành vi đã được triển khai và xác minh.
