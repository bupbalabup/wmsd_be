# Kế hoạch triển khai: xuất bán và trả hàng — 25/11/2026

**Trạng thái: đã triển khai và kiểm chứng backend; FE còn 5 lỗi jsdom trong bộ test tập trung.** Đích nghiệm thu là bán 8 viên → khách trả 4 viên → trả NCC 4 viên từ **lô khác**. Mượn cách `ReplenishmentDraftEditor` và `ReplenishmentProductTable` trình bày sản phẩm, căn cứ và đơn vị ngay trên dòng; không bê bước mua–nhập hoặc nút duyệt của luồng mua sang đây.

## 26/11/2026 — FE follow-up sau khi chạy lại bộ kiểm tra

- **Thay đổi:** form tạo đề nghị trả lưu rõ `salesIssueLineId` hoặc `originLineId` vào dòng của `Form.List` khi người dùng bấm “Thêm vào danh sách”. Trước đó picker đã hiển thị dòng nguồn nhưng payload có thể thiếu định danh dòng, khiến luồng tạo không giữ được căn cứ đã chọn.
- **Thay đổi:** bộ chọn sản phẩm của phiếu xuất loại trừ sản phẩm đã có theo các field đang sống của `Form.List`, thay vì đọc snapshot `lines` cũ sau khi đổi kho. Vì vậy đổi kho xóa đúng dòng cũ nhưng vẫn cho tìm lại sản phẩm khả dụng ở kho mới.
- **Tài liệu liên quan:** `sales-returns-fe/src/features/return-workflows/create.tsx`, `sales-returns-fe/src/features/goods-issues/GoodsIssueCreatePage.tsx`.
- **Kiểm chứng:** `npm run typecheck` ở FE đạt. Bộ tập trung trước đó vẫn còn 5 lỗi jsdom/Ant Design: một lỗi chọn sản phẩm sau đổi kho và bốn kịch bản tạo đề nghị bị chặn bởi tương tác/fixture bắt buộc tên khách; chưa ghi các lỗi này thành bằng chứng pass.
- **Không đổi:** API, model, quyền, quy tắc tồn hoặc migration backend; full-flow backend 8 → 4 → supplier 4 đã có trong `test/return-workflows.integration.test.js`.

## 0. Chốt phạm vi và bản chạy

- Làm trên cặp checkout `trungph` của backend/frontend. Ghi SHA hai repo và DB demo cô lập trước khi kiểm thử. Đối chiếu nhánh thực tế chứ không suy ra tính năng từ ảnh hoặc dữ liệu mẫu.
- [API Phiếu xuất hiện hành](../08_api/GOODS_ISSUES.md) cho phép Sales tạo `SALE` độc lập bằng mã ngoài; không có màn Sales Order mới.
- Đã thực hiện chuỗi Kinh doanh tạo → Owner khác duyệt → Kho vận chọn lô, soạn và ghi xuất. Duyệt không giữ chỗ hoặc đổi tồn; PICK TO giữ hàng và ghi xuất giảm tồn đúng một lần.
- Backend full-flow test dùng fixture riêng cho 8 viên và một lô NCC khác; không ghi DB dùng chung.

## 1. Xuất bán theo mã ngoài và quy đổi

1. `goods-issue.validation.js` và `goods-issue.service.js` nhận tạo `SALE` độc lập, giữ kiểm quyền/kho, phiên bản, idempotency và audit. Mã ngoài là tham chiếu, không là Sales Order ID hoặc khóa duy nhất. Test HTTP kiểm tra retry, kho ngoài phạm vi, chưa được soạn và duyệt không tạo reservation/stock transaction.
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

- Backend: `RUN_GOODS_ISSUE_TESTS=1 node --test test/direct-sales.integration.test.js` đạt 1/1 trên MongoDB local `27018/hieudt-test`; `RUN_RETURNS_NATIVE_TESTS=1 RUN_HIEUDT_TESTS=1 node --test test/return-workflows.integration.test.js` đạt 22/22. Hai bài gồm HTTP SALE contract và full flow 8 → 4 → supplier 4 khác lô.
- Frontend: `npx vitest run src/features/goods-issues/pages.test.tsx src/features/return-workflows/usability.test.tsx` đạt 27/32. Năm lỗi còn lại là jsdom/Ant Design interaction ở test đổi kho và staged return; các assertion SALE/source lookup/conversion mới đạt. Chưa chạy browser visual test.
- Chia commit theo thay đổi có thể review độc lập: (1) phục hồi cổng tạo `SALE` BE và test, nếu được duyệt; (2) bố cục/quy đổi xuất bán FE; (3) lookup nguồn khách trả BE và test phạm vi; (4) picker và chi tiết khách trả FE; (5) bố cục xuất NCC và kiểm hạn mức; (6) fixture/kịch bản nghiệm thu nếu có thay đổi riêng. Không tạo commit rỗng hoặc tách code khỏi test trực tiếp của nó.
- Đã cập nhật `git_doc/change_logs.md`, [Phiếu xuất](../08_api/GOODS_ISSUES.md), [Trả hàng](../08_api/RETURN_WORKFLOWS_NATIVE.md), hướng dẫn demo/local, MODEL_MAP, data dictionary và model changelog sau khi triển khai/xác minh. FE commit được ghi cạnh backend commit để truy vết.
