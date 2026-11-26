# MiniQuizN12Web — Nền tảng thi trắc nghiệm trực tuyến thời gian thực

## Chạy bộ kiểm thử tự động (Không cần PostgreSQL / Supabase)

Yêu cầu môi trường: **Node.js >= 22.5** (đã kiểm chứng trên Node.js `v24.14.0`, tích hợp sẵn `node:test` và `node:sqlite`) và trình duyệt Microsoft Edge / Chrome / Chromium cho Playwright E2E.

### Cài đặt phụ thuộc
```bash
npm install
```

### Các lệnh kiểm thử hệ thống
| Lệnh | Phạm vi kiểm thử |
|---|---|
| `npm run test:full` | Chạy toàn bộ bộ kiểm thử mở rộng trong `tests/` (Unit + Frontend/Importer + SQLite DB & Migration + HTTP API + Security/Fuzzing + Concurrency + Playwright E2E) |
| `npm run test:full:fast` | Chạy nhanh toàn bộ tầng Core (bỏ qua khởi chạy trình duyệt E2E) |
| `npm run test:all` | Chạy kiểm tra cú pháp (`lint`) + toàn bộ `Test Suite/` (477 test) + toàn bộ `tests/` mở rộng (`test:full`) |
| `npm run test:full:coverage` | Đo độ phủ mã nguồn (`c8`) toàn dự án (`src/` và `public/js/`) với ngưỡng kiểm soát `>= 80%` |
| `npm run test:th5` | Chạy riêng 24 test case của bài nộp Thực hành 5 |
| `npm test` | Chạy bộ `Test Suite/run.cjs all` hiện có |

> **Lưu ý về Cơ sở dữ liệu test:** Toàn bộ kiểm thử tích hợp DB, API, Concurrency và E2E khởi tạo **SQLite in-memory** (`node:sqlite` `:memory:`) độc lập cho từng test case (hỗ trợ savepoint lồng nhau, `json_extract`, `json_each` tương thích PostgreSQL), không cần cài đặt PostgreSQL/Supabase và không chạm tới dữ liệu môi trường dev.

## Cấu trúc kiểm thử trong `tests/`

- `tests/helpers/`: Bộ chuyển đổi SQLite in-memory 16 bảng (`sqlite-test-db.js`) và server cô lập (`test-server.js`).
- `tests/unit/`: Kiểm thử đơn vị & biên logic (`auth.unit.test.js`, `room.unit.test.js`, `system-core.unit.test.js`, `frontend-and-importer.test.js` với file mẫu `.docx`, `.xlsx`, `.txt` thật).
- `tests/integration/`: Kiểm thử tích hợp DB quan hệ, Migration, toàn bộ HTTP API và đua tranh đồng thời (`auth.integration.test.js`, `room.integration.test.js`, `storage.integration.test.js`, `db-sqlite-full.integration.test.js`, `api-full.integration.test.js`, `concurrency.integration.test.js`).
- `tests/security/`: Kiểm thử bảo mật, chống XSS qua `Host`/`X-Forwarded-Host` & `APP_URL`, chống Path Traversal, chống lỗi `URIError` `%ZZ`, CORS whitelist, giới hạn payload `413`, fuzzing lệch kiểu dữ liệu và kiểm toán rò rỉ đáp án/token (`security-and-fuzzing.test.js`).
- `tests/e2e/`: Kiểm thử trình duyệt thật bằng Playwright (`auth.e2e.test.js`, `full-system.e2e.test.js` đa ngữ cảnh Giáo viên + Thí sinh).
- `docs/`: Tài liệu kế hoạch kiểm thử, bảng test case và hồ sơ lỗi (`TEST_PLAN.md`, `TEST_CASES.md`, `BUGS.md`, `test-results.txt`).
