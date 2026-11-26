# MiniQuizN12Web — Nền tảng thi trắc nghiệm trực tuyến thời gian thực

## Chạy toàn bộ bộ kiểm thử (Bài thực hành 5)

Yêu cầu môi trường: **Node.js >= 22.5** (đã kiểm chứng trên Node.js `v24.14.0`, tích hợp sẵn `node:test` và `node:sqlite`) và trình duyệt Microsoft Edge / Chrome / Chromium cho Playwright E2E.

### Cài đặt phụ thuộc
```bash
npm install
```

### Chạy toàn bộ Unit + Integration + E2E bằng 1 lệnh duy nhất
```bash
npm run test:th5
```

> **Lưu ý về Cơ sở dữ liệu test:** Bộ test Integration và E2E sử dụng **SQLite in-memory** (`node:sqlite` `:memory:`) tách biệt hoàn toàn cho từng test case, không cần cấu hình PostgreSQL/Supabase và không ảnh hưởng tới dữ liệu dev.

## Cấu trúc sản phẩm kiểm thử

- `docs/TEST_PLAN.md`: Kế hoạch & chiến lược kiểm thử (phạm vi 3 chức năng, bảng rủi ro, tháp kiểm thử).
- `docs/TEST_CASES.md`: Bảng 24 test case chi tiết (12 Unit, 10 Integration, 2 E2E).
- `docs/test-results.txt`: Kết quả chạy thực tế toàn bộ bộ test.
- `docs/BUGS.md`: Danh sách lỗi thật phát hiện trong mã nguồn.
- `tests/unit/`: 12 Unit test thuần logic (`auth.unit.test.js`, `room.unit.test.js`).
- `tests/integration/`: 10 Integration test API + SQLite in-memory (`auth.integration.test.js`, `room.integration.test.js`, `storage.integration.test.js`).
- `tests/e2e/`: 2 E2E test trình duyệt thật bằng Playwright (`auth.e2e.test.js`).
