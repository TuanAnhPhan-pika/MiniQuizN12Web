# Báo cáo tổng hợp kiểm thử — 18/11/2026

Đã xóa báo cáo và bằng chứng cũ, chạy lại toàn bộ nhóm test, tạo lại log, coverage và ảnh browser. Không chạy k6 hay phát tải lên web deploy.

| Nhóm | Lệnh | Kết quả mới |
| --- | --- | --- |
| Backend + frontend + performance local và coverage | `npm run test:coverage:check` | **477 qua, 0 lỗi, 0 bỏ qua**, exit 0 |
| PostgreSQL thật | `npm run test:database` với `TEST_DATABASE_URL` | **5 bài con qua**; Node báo 6 tính cả bộ cha; exit 0 |
| Browser đăng nhập | `npm run test:browser:login` | **TC01, TC02, TC03 qua**, exit 0 |
| Browser bảo mật | `npm run test:browser:security` | Hai người chơi submit → chờ → reveal → câu tiếp → kết thúc **qua**, exit 0 |
| Cú pháp | `npm run lint` | **Qua**, exit 0 |

Không cộng số kịch bản browser với số test Node: hai cách chạy không đếm assertion theo cùng đơn vị.

## Coverage code ứng dụng

| Chỉ số | Kết quả | Ngưỡng |
| --- | ---: | ---: |
| Dòng / statements | **91,29%** | 80% |
| Nhánh | **80,17%** | 80% |
| Hàm | **94,96%** | 80% |

Tính toàn bộ JavaScript tự viết trong `src/` và `public/js/`, kể cả file chưa chạy. Không tính thư viện minified, dependency và test. Ngưỡng áp dụng toàn dự án, không phải từng file; số nhánh có thể dao động nhẹ do đường đi sinh PIN ngẫu nhiên.

## Môi trường, cô lập và giới hạn

- Node.js v22.17.1 trên Windows; Node Test Runner và c8.
- Local gồm unit, HTTP local, DOM/jsdom và tải/chống lỗi; DB/AI sử dụng doubles khi phù hợp.
- Browser đăng nhập: Chrome headless, Chrome DevTools Protocol trực tiếp, chạy `--mock`; script này không dùng Playwright và không ghi DB production.
- Browser bảo mật: Playwright điều khiển Chrome headless, server local và auth/database doubles.
- PostgreSQL thật chạy migration, rollback, version câu hỏi, attempt/session và AI document/job/cache trong schema ngẫu nhiên. Transaction ngoài và savepoint; teardown xác nhận rollback schema và dữ liệu. Harness serialize trên một kết nối, không đo tải DB hoặc throughput pool.
- Script seed/reset trong `fixtures/` không phải bài test và không chạy trong đợt này.
- Không có kết luận về tải tối đa production, khả năng tương thích mọi trình duyệt hoặc chất lượng nội dung AI. Coverage không thay thế assertion đúng nghiệp vụ.

## Kết quả thô mới

Log tại `reports/local-coverage.log`, `database.log`, `browser-login.log`, `browser-security.log`, `lint.log`; HTML/JSON/LCOV tại `reports/coverage/`. Ảnh và JSON bằng chứng mới tại `evidence/` cho TC01–TC03.

Log/ảnh/JSON bằng chứng được giữ local và Git bỏ qua. Chỉ báo cáo tổng hợp này được commit, không có thông tin kết nối hoặc cookie/token.
