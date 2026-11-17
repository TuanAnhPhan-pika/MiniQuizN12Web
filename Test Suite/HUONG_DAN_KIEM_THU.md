# Mô tả bộ kiểm thử MiniQuiz

Ngày xác nhận: 18/11/2026. Phạm vi: code local trong repository MiniQuizN12Web.

## 1. Bộ test được tổ chức như thế nào?

```text
Test Suite/
├── run.cjs                     Chọn nhóm và gọi Node Test Runner
├── coverage.json               Phạm vi đo và ngưỡng coverage
├── backend/                    Test backend bổ sung
├── frontend/                   Test hành vi DOM bổ sung
├── performance/                Test tải đồng thời và chống lỗi local
├── browser/                    Script trình duyệt chạy riêng
├── fixtures/                   Script DB và SQL seed/reset đăng nhập
├── RESULTS.md                  Báo cáo tổng hợp của đợt chạy mới nhất
├── evidence/                   Bằng chứng test cũ
├── database/
│   └── postgres.test.cjs       Điểm vào bộ PostgreSQL có cô lập
├── helpers/                    Công cụ dựng môi trường test
├── reports/coverage/           Báo cáo được sinh khi chạy, không commit
├── README.md                   Lệnh sử dụng
├── RESULTS.md                  Kết quả và giới hạn
└── HUONG_DAN_KIEM_THU.md       Tài liệu này

```

Toàn bộ test cũ đã được chuyển vào các nhóm tương ứng trong `Test Suite/`; đường dẫn fixture và runner đã được cập nhật. Script browser và DB thật chỉ chạy khi gọi riêng. Không chạy k6 hoặc test tải trên web deploy trong đợt sắp xếp này.

### Số lượng theo nhóm chạy

| Nhóm | Lệnh | Số test đã chạy | Kết quả |
| --- | --- | ---: | --- |
| Backend | `npm run test:backend` | 243 | Qua hết |
| Frontend | `npm run test:frontend` | 223 | Qua hết |
| Đồng thời và chống lỗi | `npm run test:performance` | 11 | Qua hết |
| Tổng local không cần DB ngoài | `npm run test:suite` | **477** | **477 qua, 0 lỗi** |
| PostgreSQL thật, chạy riêng | `npm run test:database` | 5 bài con, Node báo 6 tính cả bộ cha | Đã qua ở lần kiểm tra DB trước |

477 không bao gồm bộ PostgreSQL chạy riêng. Các test được tạo trong vòng lặp theo nhiều bộ dữ liệu, vì vậy đếm số dòng `test(...)` trong file sẽ không bằng số test thực tế.

## 2. Phân loại kiểm thử

Nhóm thư mục là cách tổ chức và chạy. Loại kiểm thử là cách kiểm tra hành vi; một file có thể chứa nhiều loại, nên không cộng số lượng theo loại để ra 477.

| Loại | Cách làm trong dự án | Ví dụ | Giới hạn |
| --- | --- | --- | --- |
| Unit test | Gọi một hàm hoặc module với dữ liệu và dependency được kiểm soát | Chuẩn hóa đáp án AI, token, dữ liệu storage, tính thống kê | Không xác nhận hệ thống triển khai thật |
| Integration API local | Dựng HTTP server thật ở cổng ngẫu nhiên trên `127.0.0.1`; gửi request và kiểm tra response | Đăng nhập, tạo phòng, quyền host, lưu đề | Database và AI thường dùng mock |
| Integration PostgreSQL | Thực thi SQL và migration trên PostgreSQL thật trong schema test | Tạo user/profile, phiên bản câu hỏi, lưu kết quả, AI cache | Có transaction cô lập; không đo throughput của pool thật |
| Kiểm thử hành vi DOM | Nạp HTML thật của dự án vào jsdom; thao tác input, nút, sự kiện và timer | Tạo câu hỏi, import đề, chờ phòng, xem điểm | Không phải Chrome thật; không kiểm tra bố cục/CSS/mobile |
| Kiểm thử lỗi và biên | Thay đổi dữ liệu đầu vào, thời điểm và trạng thái dependency | Thiếu trường, chỉ số đáp án ngoài phạm vi, mất mạng, JSON hỏng | Chỉ xác nhận các tình huống đã viết assertion |
| Kiểm thử bảo mật chức năng | Gửi token sai, đổi danh tính, thao tác không đúng quyền | Thí sinh không được điều khiển phòng; không lộ đáp án trước thời điểm | Không thay thế pentest hay audit bảo mật toàn diện |
| Kiểm thử đồng thời/tải | Phát nhiều request bất đồng bộ và đối chiếu dữ liệu sau xử lý | 8 request tạo phòng; 240 người giả lập | Chạy local, phần lớn DB giả lập; không chứng minh năng lực production |
| Regression test | Giữ lại tình huống từng có lỗi, chạy lại sau thay đổi | Vượt giới hạn 3 phòng, JSON gây unhandled rejection | Đây là mục đích của test, không phải một nhóm riêng |

Coverage là phép đo đi kèm các test trên, không phải một loại test độc lập chứng minh phần mềm đúng.

## 3. Một test được viết và chạy ra sao?

Mẫu chung gồm ba bước:

1. **Chuẩn bị:** dựng module/server/DOM, tạo fixture và đặt trạng thái ban đầu.
2. **Thực hiện:** gọi hàm, gửi request, hoặc phát sự kiện như click/input.
3. **Đối chiếu:** dùng `node:assert/strict` kiểm tra kết quả cụ thể; sau đó đóng server/DOM hoặc rollback dữ liệu.

Ví dụ khái niệm kiểm tra giới hạn phòng:

```js
// Chuẩn bị: tài khoản host chưa có phòng, DB giả lập có độ trễ.
// Thực hiện: gửi 8 POST /api/rooms đồng thời bằng Promise.all.
// Đối chiếu:
// - Chính xác 3 response 200.
// - Chính xác 5 response 409.
// - Số phòng thật trong state của host là 3.
```

Không chỉ kiểm tra “không throw”. Những test nghiệp vụ quan trọng còn kiểm tra số bản ghi, số điểm, dữ liệu trả về, quyền thao tác, token không xuất hiện ở nơi không được phép và số lần ghi database.

### Luồng chạy suite

```text
Lệnh npm
  → Test Suite/run.cjs chọn nhóm file
  → Node Test Runner chạy các file test
  → Mỗi test dựng fixture và môi trường riêng
  → Gọi hành vi cần kiểm tra
  → Assert kết quả
  → Teardown: đóng server/DOM, hủy timer hoặc rollback
  → Tổng hợp số test qua/lỗi
```

Với coverage:

```text
npm run test:coverage:check
  → c8 thu dữ liệu thực thi từ V8
  → Chạy 477 test local
  → Tính coverage code ứng dụng, gồm file chưa thực thi
  → Xuất HTML / JSON / LCOV
  → Đối chiếu ngưỡng 80%
  → Exit 0 nếu test và ngưỡng đều đạt; exit khác 0 nếu không đạt
```

## 4. “Luồng nghiệp vụ” và “nhánh điều kiện” khác nhau thế nào?

**Luồng nghiệp vụ** là chuỗi thao tác, chẳng hạn host tạo phòng → thí sinh tham gia → trả lời → kết thúc → xem lịch sử.

**Nhánh điều kiện** là đường đi trong code khi dữ liệu hoặc trạng thái khác nhau. Ví dụ:

```js
if (soPhong >= 3) {
  return { status: 409 };
}
return { status: 200 };
```

Chỉ test host có 0 phòng thì mới kiểm tra phía tạo thành công. Phải test thêm host có 3 phòng mới đi qua phía bị chặn. Còn test 8 request đồng thời kiểm tra tính đúng của toàn bộ thao tác “đếm rồi tạo” khi các request xen kẽ nhau.

“Nhánh” trong coverage không phải branch Git. Công cụ V8 còn ghi nhận các đường đi liên quan đến biểu thức ba ngôi, `&&`, `||`, giá trị mặc định, nhánh lỗi và callback; không chỉ đếm từng `if` trong mã nguồn.

## 5. Các luồng và nhánh đang được kiểm tra

| Luồng | Đường thành công | Đường thất bại/biên được kiểm tra | File tiêu biểu |
| --- | --- | --- | --- |
| Đăng ký | Dữ liệu hợp lệ → tạo user → tạo session → trả token | Username/tên/mật khẩu không hợp lệ, xác nhận sai, trùng username, giới hạn IP, DB lỗi | `backend/auth-routes.test.cjs`, `backend/auth.test.js` |
| Đăng nhập | Tìm user → kiểm tra mật khẩu → lưu session → trả cookie/token | Thiếu trường, kiểu dữ liệu sai, không có user, sai mật khẩu, bị khóa, DB lỗi, JSON sai | `backend/auth-routes.test.cjs`, `backend/login.test.js` |
| Phiên đăng nhập | Token hợp lệ đọc được danh tính | Token sai/hết hạn, user đã mất, logout, lỗi ghi session, storage bị chặn | `backend/auth-initialization.test.cjs`, `frontend/auth-client.test.cjs` |
| Đổi thông tin | Đổi tên/mật khẩu hợp lệ → cập nhật → thu hồi phiên khác khi đổi mật khẩu | Không thay đổi, thiếu mật khẩu cũ, sai mật khẩu, cooldown, xác nhận sai, update thất bại | `backend/auth-routes.test.cjs`, `frontend/dashboard.test.cjs` |
| Soạn đề | Thêm → sửa → lưu câu đơn/nhiều đáp án | Thiếu nội dung/lựa chọn, câu nhiều đáp án thiếu đáp án đúng, xóa hoặc hủy xóa | `frontend/exam-editor.test.cjs` |
| Import đề | Parse text/file → xem trước → sửa đáp án → lưu hoặc chuyển tạo phòng | Rỗng, file lỗi, parse lỗi, không có câu hợp lệ, metadata mặc định | `frontend/import-workflow.test.cjs`, `frontend/importer.test.js` |
| Ngân hàng đề | Phân trang → lọc/tìm → xem trước → lưu bản sao | Không tìm thấy, vượt trang, API lỗi, bản sao phải giữ nguồn đề | `frontend/library.test.cjs` |
| Chia sẻ đề | Kiểm tra bản sao → xác nhận chia sẻ → cập nhật thư viện | Khác biệt dưới 10%, HTTP 409, lỗi mạng, phản hồi thiếu metadata, hủy gỡ đề | `frontend/sharing.test.cjs`, `backend/http-routes.test.js` |
| Tạo phòng | Chọn đề, tên hợp lệ → server cấp PIN → lưu và hiển thị | Thiếu tên/đề, quá 3 phòng, API lỗi, tạo đồng thời, DB lỗi phải hoàn tác giữ chỗ | `frontend/create-room.test.cjs`, `backend/room-boundaries.test.cjs`, `performance/resilience-stress.test.js` |
| Phòng chờ | Join → lưu player token trong sessionStorage → polling → countdown | Token sai, nickname trùng, phòng khóa/đầy, phòng mất, mất mạng, thoát phòng | `frontend/waiting.test.cjs`, `backend/room-boundaries.test.cjs` |
| Làm bài | Chọn đáp án → gửi → đợi server cho phép reveal → xem điểm | Nộp trùng, quá hạn, sai câu, sai phase, lựa chọn ngoài phạm vi, sai token | `frontend/room-player.test.cjs`, `backend/room-boundaries.test.cjs`, `backend/security.test.js` |
| Nhiều đáp án | Chuẩn hóa lựa chọn, chấm all-or-nothing | Chọn thiếu/thừa, lựa chọn trùng/không hợp lệ, chưa chọn gì | `frontend/room-player.test.cjs`, `backend/room-manager.test.js` |
| Kết thúc/lịch sử | Lưu kết quả → đọc lại → render chi tiết và xếp hạng | Lưu trùng ID, archive đồng thời, lỗi DB, thiếu dữ liệu chi tiết, không có thí sinh | `frontend/dashboard.test.cjs`, `backend/database-readback.test.cjs`, `performance/concurrency-load.test.js` |
| AI | Sinh câu hỏi/phân tích → chuẩn hóa → cache → render | Không có key, quota, lỗi quyền/model, retry lỗi tạm thời, JSON sai, dữ liệu rỗng, sai chủ phòng | `backend/ai-boundaries.test.cjs`, `backend/ai-routes-boundaries.test.cjs`, `frontend/weakness-ui.test.cjs` |
| Dữ liệu trình duyệt | Lưu/đọc/xóa đúng scope tài khoản/phòng/tab | Storage bị chặn, dữ liệu cũ, raw string/JSON, xóa scope không ảnh hưởng scope khác | `frontend/storage.test.cjs`, `frontend/auth-client.test.cjs` |
| UI hỗ trợ | Theme được khôi phục, copy link, hiện thông báo | Clipboard bị từ chối, copy fallback, thiếu nút, timer dọn thông báo | `frontend/theme.test.cjs`, `frontend/clipboard.test.cjs` |
| Thi thử | Chấm cục bộ → xem kết quả → dọn phòng test | Đúng/sai/bỏ qua/nhiều đáp án, server offline, không ghi lịch sử thi thật | `frontend/practice.test.cjs` |

Các hàng trên mô tả một số kịch bản tiêu biểu; không có nghĩa mọi tổ hợp của các điều kiện đã được kiểm tra.

## 6. Mức đồng thời: bao nhiêu “luồng”?

Các bài này dùng request bất đồng bộ (`Promise.all`), không tạo tương ứng từng ấy luồng CPU hay trình duyệt.

| Kịch bản | Số lượng phát đồng thời | Điều cần chứng minh |
| --- | ---: | --- |
| Tạo phòng | 8 request | Chỉ tạo tối đa 3 phòng/host |
| Đăng ký cùng username | 8 request | Chỉ một đăng ký thành công, còn lại bị từ chối rõ ràng |
| Nộp trùng một câu | 20 request từ cùng người chơi | Chỉ tính một đáp án/một lần điểm |
| Lưu lịch sử | 20 player request + 5 host request | Không nhân bản archive, giữ đủ attempt riêng biệt |
| Một phòng đông người | 60 người giả lập | Join, trả lời câu đơn/đa đáp án và thống kê không mất dữ liệu |
| Đợt nộp câu đầu ở bài 60 người | 60 answer + 80 request đọc = 140 request | Không có 5xx; thống kê đếm đúng |
| Stress lớn nhất | 3 phòng × 80 = 240 người giả lập | Không mất đáp án giữa các phòng |
| Burst của stress test | 240 answer + 480 state/status + 10 login = 730 request | Không có 5xx, đủ 80 đáp án mỗi phòng |

Stress test dùng HTTP agent tối đa **128 kết nối cùng lúc**. 730 là số request được lên lịch trong một đợt, không phải 730 kết nối hoặc 730 người. Đăng nhập trong burst dùng mật khẩu sai để tạo công việc xác minh mật khẩu; assertion “không có 5xx” vẫn cho phép lỗi 4xx dự kiến.

Các bài tải còn đo thời gian hoàn thành và độ trễ event loop. Số đo trên máy local không phải cam kết tốc độ của Cloud Run hoặc PostgreSQL production.

## 7. Cách cô lập PostgreSQL thật

```text
Đọc TEST_DATABASE_URL từ môi trường
  → Kết nối PostgreSQL
  → BEGIN transaction ngoài
  → CREATE SCHEMA test_suite_<ngẫu nhiên>
  → SET LOCAL search_path chỉ vào schema đó
  → Chạy migration và các bài test
  → Mỗi query/transaction dùng savepoint để lỗi không phá cả bộ
  → ROLLBACK transaction ngoài
  → Đóng kết nối
```

Năm bài con gồm:

1. Migration chạy lặp lại không áp dụng lại migration đã ghi nhận.
2. Lỗi trong thao tác transaction không để lại bản ghi đã thử chèn.
3. Lưu đề/câu hỏi từ phiên bản v1 sang v2 khi chuyển nhiều đáp án, rồi đọc lại.
4. Lưu attempt trùng ID không nhân đôi; lưu phiên thi và người chơi đọc lại được.
5. Document/job AI và cache phân tích đọc–ghi được.

Harness dùng một kết nối, serialize các query và thay transaction bên trong bằng savepoint. Nó kiểm tra SQL thực tế và rollback cô lập, nhưng không kiểm tra khả năng chịu tải hoặc concurrency của pool PostgreSQL. Unit test pool kiểm tra riêng trình tự BEGIN/COMMIT/ROLLBACK và release client.

Chỉ chạy qua `npm run test:database` hoặc `npm run test:coverage:database` để có cơ chế cô lập này. Không lưu URL/mật khẩu/service-role key vào test.

## 8. Cách đọc coverage

| Chỉ số | Ý nghĩa | Kết quả đã xác nhận |
| --- | --- | ---: |
| Lines | Dòng mã được công cụ ghi nhận đã thực thi | 91,29% |
| Statements | Câu lệnh được ghi nhận đã thực thi | 91,29% |
| Functions | Hàm được gọi trong các môi trường đo | 94,96% |
| Branches | Đường đi điều kiện được ghi nhận đã đi qua | 80,17% |

Ngưỡng toàn dự án là **80% cho cả bốn chỉ số**. Không phải mọi file đều đạt 80%; mở HTML report để xem file cụ thể. Trong lần đo được lưu, nhánh là 3761/4691 đường đi mà công cụ ghi nhận. Số vị trí công cụ ghi nhận có thể thay đổi khi thêm test, đổi môi trường hoặc thay cách nạp module.

Phạm vi tính gồm mọi JavaScript tự viết trong `src/` và `public/js/`, kể cả file chưa chạy. Loại trừ dependency, test và thư viện minified bên ngoài. Một số test cũ nạp code qua `vm` và thêm export để quan sát state, nên cần đọc assertion cùng số liệu, không dùng coverage làm bằng chứng duy nhất.

Ví dụ: một test có thể chạy qua hàm tính điểm nhưng không đối chiếu điểm đúng. Nó tăng coverage mà chưa chứng minh chấm điểm đúng. Các test cần có assertion về điểm, đáp án, danh tính và số lần lưu.

## 9. Cách chạy và xem báo cáo

Chạy từ thư mục gốc repository:

```powershell
# Toàn bộ local, không cần DB bên ngoài
npm run test:suite

# Chạy từng nhóm
npm run test:backend
npm run test:frontend
npm run test:performance

# Một file cụ thể
node --test "Test Suite/frontend/room-player.test.cjs"

# Coverage chỉ báo cáo hoặc có kiểm tra ngưỡng
npm run test:coverage
npm run test:coverage:check

# DB thật: đặt TEST_DATABASE_URL bằng cấu hình môi trường riêng trước
npm run test:database
npm run test:coverage:database
```

Mở `Test Suite/reports/coverage/index.html`. Chọn file cần xem để thấy dòng/nhánh chưa được thực thi. Dùng `coverage-summary.json` để đọc số tổng, `coverage-final.json` để phân tích chi tiết và `lcov.info` cho công cụ CI hỗ trợ LCOV.

`npm test` và `npm run test:suite` cùng chạy toàn bộ nhóm local. `npm run test:performance` chạy nhóm tải local; lệnh cũ `npm run test:resilience` được giữ làm alias. Việc có script không đồng nghĩa pipeline CI hiện tại đã được cấu hình gọi chúng.

## 10. Những điều chưa được chứng minh

- 477 test local không phải 477 hành trình người dùng độc lập.
- Không có khẳng định bộ này đã chạy E2E đầy đủ trên Chrome/Playwright.
- jsdom không kiểm tra responsive, pixel, bố cục hay tốc độ trình duyệt thật.
- Test tải local không chứng minh web production chịu được 240 người dùng thật.
- AI được mock trong test, không đánh giá chất lượng sư phạm của câu hỏi Gemini sinh ra.
- Các kiểm tra API đã làm trực tiếp trên web trước đó là đợt xác minh triển khai riêng, không nằm trong 477 test local này.
- Đạt 80% không có nghĩa đã hết lỗi, và không thay thế kiểm tra thủ công các luồng host–thí sinh quan trọng.
