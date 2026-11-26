# Kế hoạch kiểm thử (Test Plan) — MiniQuizN12Web

- **Dự án:** Mini Quiz Classroom (`MiniQuizN12Web`) — nền tảng thi trắc nghiệm trực tuyến thời gian thực (Node.js HTTP + PostgreSQL + HTML/JS).
- **Người thực hiện:** Thực hiện cá nhân (đảm nhiệm toàn bộ vai trò: Test Plan, thiết kế Test Cases, lập trình Unit / Integration / E2E và tổng hợp lỗi).

## 1. Phạm vi kiểm thử (In Scope)
Chọn **3 chức năng cốt lõi nhất** quyết định tính bảo mật, tính chính xác của buổi thi và tính toàn vẹn ngân hàng đề:
1. **Đăng ký & Đăng nhập tài khoản (`Auth`):** Cổng truy cập bắt buộc của giáo viên/người dùng; lỗi validate, lộ `passwordHash`/token hoặc hỏng khóa brute-force gây rủi ro bảo mật trực tiếp.
2. **Tạo phòng thi, Tham gia phòng & Nộp bài chấm điểm (`Room & Gameplay`):** Nghiệp vụ trung tâm của ứng dụng (sinh PIN, giới hạn sức chứa, kiểm tra đáp án phía server, tính điểm và xếp hạng).
3. **Quản lý kho đề thi cá nhân (`Private Exam Storage`):** Nơi lưu trữ và xóa đề thi của giáo viên; lỗi phân quyền hoặc dữ liệu rỗng làm mất/hỏng dữ liệu bài thi.

## 2. Bảng đánh giá rủi ro
*(Thang điểm 1–3; Rủi ro = Tần suất sử dụng × Mức thiệt hại nếu hỏng)*

| Chức năng | Tần suất | Thiệt hại | Điểm rủi ro | Mức ưu tiên |
|---|---:|---:|---:|---|
| 1. Đăng ký & Đăng nhập (`Auth`) | 3 | 3 | **9** | Rất cao |
| 2. Phòng thi & Chấm điểm (`Room & Gameplay`) | 3 | 3 | **9** | Rất cao |
| 3. Kho đề thi cá nhân (`Private Exam Storage`) | 2 | 3 | **6** | Cao |

## 3. Chiến lược kiểm thử (theo tháp kiểm thử — 12 Unit, 10 Integration, 2 E2E)
- **Đăng ký & Đăng nhập (Rủi ro 9) → Unit + Integration + E2E:**
  - *Unit (6 case):* Kiểm thử hàm thuần `validateUsername`, `validateDisplayName`, `validatePassword`, `hashPassword`/`verifyPassword`, `checkLoginLock`/`recordLoginFailure` (không cần DB/mạng).
  - *Integration (3 case):* Gọi `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` với DB test, kiểm tra HTTP status, cookie phiên, thu hồi phiên khi logout, không lộ `passwordHash`/`salt` và trạng thái bảng `users`.
  - *E2E (2 case):* Rủi ro cao nhất và là luồng người dùng đầu tiên → chạy trình duyệt thật (Playwright + Edge) kiểm tra đăng nhập thành công chuyển sang `dashboard.html` và đăng nhập sai hiển thị thông báo lỗi.
- **Phòng thi & Chấm điểm (Rủi ro 9) → Unit + Integration:**
  - *Unit (6 case):* Kiểm thử logic thuần trong `src/rooms/manager.js` (`getCorrectChoices`, `isMultiChoiceQuestion`, sức chứa biên & âm, khóa phòng, chống giả mạo nickname, chấm điểm câu đơn & nhiều đáp án All-or-Nothing, chống nộp trùng).
  - *Integration (3 case):* Gọi chuỗi API `/api/rooms` → `/join` → `/start` → `/answer` → `/advance` → `/leaderboard`, giới hạn `MAX_ROOMS_PER_HOST = 3`, kiểm tra chuyển trạng thái phòng (`waiting` vs `started`) và không lộ đáp án đúng cho thí sinh. Không chạy E2E để tránh chậm/flaky do đồng bộ đa tab thời gian thực.
- **Kho đề thi cá nhân (Rủi ro 6) → Integration (4 case):**
  - Trọng tâm là tương tác HTTP + kiểm tra session/quyền sở hữu + truy vấn SQL (`quizzes`, `question_versions` bất biến v1/v2, soft delete và validate dữ liệu biên). Không cần E2E vì rủi ro thấp hơn Auth và kiểm chứng chính xác, nhanh ở tầng API + DB.

## 4. Ngoài phạm vi (Out of Scope)
- **Tích hợp AI Gemini (`/api/ai/*`):** Phụ thuộc API bên thứ ba và hạn mức API key.
- **Kiểm thử hiệu năng / chịu tải lớn (`stress/load`) và giao diện đa kích thước màn hình:** Không nằm trong mục tiêu kiểm thử chức năng 90 phút.

## 5. Môi trường & Công cụ kiểm thử
- **Runtime & Runner:** Node.js `v24.14.0` sử dụng `node:test` và `node:assert/strict` (nhanh, không phụ thuộc framework ngoài).
- **E2E Browser:** `playwright` điều khiển trình duyệt **Microsoft Edge** cài sẵn trên máy (`channel: 'msedge'`, chế độ headless).
- **Cơ sở dữ liệu test (tách biệt hoàn toàn DB dev):** Sử dụng **SQLite in-memory** tích hợp sẵn trong Node (`node:sqlite` với `:memory:`) kết hợp lớp adapter tương thích câu lệnh PostgreSQL của `src/db/pool.js`. Mỗi nhóm test khởi tạo một DB `:memory:` mới tinh (độc lập thứ tự, tự hủy khi xong, tuyệt đối không đụng DB dev).
- **Lệnh chạy toàn bộ bộ test (1 lệnh duy nhất):**
  ```bash
  npm run test:th5
  ```
