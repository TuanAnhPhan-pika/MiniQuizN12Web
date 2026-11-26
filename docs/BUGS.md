# Danh sách lỗi phát hiện được (Bug Report) — MiniQuizN12Web

Tài liệu ghi nhận trung thực **4 lỗi thật** trong mã nguồn sản phẩm được phát hiện khi chạy bộ kiểm thử tự động (`npm run test:th5`). Theo đúng quy tắc kiểm thử, **không sửa test cho "xanh" để che lỗi** và giữ nguyên bằng chứng tái hiện bằng test tự động.

---

## BUG-01: Hàm kiểm tra mật khẩu chấp nhận mật khẩu chỉ gồm khoảng trắng
- **Mức độ nghiêm trọng:** Trung bình
- **Vị trí mã nguồn:** `src/auth.js` (hàm `validatePassword`, dòng 209–214)
- **Bước tái hiện:**
  1. Gọi `auth.validatePassword("      ")` (chuỗi gồm 6 dấu cách) hoặc gửi `POST /api/auth/register` với `password: "      "`, `confirmPassword: "      "`.
  2. Quan sát giá trị trả về của hàm kiểm tra mật khẩu.
- **Kết quả mong đợi:** Hàm trả về chuỗi thông báo lỗi, từ chối mật khẩu rỗng hoặc chỉ chứa ký tự khoảng trắng.
- **Kết quả thực tế:** Hàm chỉ kiểm tra `password.length < 6` mà không loại bỏ/kiểm tra khoảng trắng nên trả về `null` (coi là hợp lệ).
- **Test case / Test code phát hiện:** `TC-03` — `tests/unit/auth.unit.test.js` (`validatePassword phải từ chối mật khẩu chỉ gồm 6 khoảng trắng`).

---

## BUG-02: API lưu đề thi cá nhân chấp nhận tiêu đề toàn khoảng trắng và đề thi 0 câu hỏi
- **Mức độ nghiêm trọng:** Trung bình
- **Vị trí mã nguồn:** `src/server.js` (endpoint `POST /api/storage/private`, dòng 1103–1108)
- **Bước tái hiện:**
  1. Đăng nhập tài khoản giáo viên hợp lệ để lấy session cookie.
  2. Gửi `POST /api/storage/private` với body `{ "exam": { "title": "   ", "questions": [] } }`.
  3. Kiểm tra HTTP status trả về và số bản ghi trong bảng `quizzes`.
- **Kết quả mong đợi:** Server trả HTTP `400`, `success: false`, báo dữ liệu đề thi không hợp lệ và không ghi bản ghi rỗng vào bảng `quizzes`.
- **Kết quả thực tế:** Điều kiện `if (!examData || !examData.title)` không gọi `.trim()` và không kiểm tra mảng `questions` có ít nhất 1 câu hỏi, nên server trả HTTP `200`, `success: true` và lưu đề rỗng xuống cơ sở dữ liệu.
- **Test case / Test code phát hiện:** `TC-14` — `tests/integration/storage.integration.test.js` (`Từ chối lưu đề thi có tiêu đề chỉ gồm khoảng trắng và 0 câu hỏi`).

---

## BUG-03: Thí sinh có thể nộp đáp án câu 0 khi phòng thi vẫn ở trạng thái `waiting` (chủ phòng chưa bắt đầu)
- **Mức độ nghiêm trọng:** Cao
- **Vị trí mã nguồn:** `src/rooms/manager.js` (hàm `submitAnswer`, dòng 484–488)
- **Bước tái hiện:**
  1. Chủ phòng tạo phòng mới qua `POST /api/rooms` (trạng thái phòng mặc định là `waiting`, **không** gọi `POST /api/rooms/:pin/start`).
  2. Thí sinh tham gia phòng qua `POST /api/rooms/:pin/join` để lấy `playerId` và `playerToken`.
  3. Thí sinh gọi trực tiếp `POST /api/rooms/:pin/answer` với `{ playerId, playerToken, qIdx: 0, choice: 1 }`.
- **Kết quả mong đợi:** Server từ chối đáp án (`success: false`, `rejected: true`), giữ nguyên `room.status === "waiting"` và không cộng điểm vì chủ phòng chưa phát lệnh bắt đầu.
- **Kết quả thực tế:** Nhánh điều kiện `(room.status === 'waiting' && Number(qIdx) === 0)` tự động chuyển `room.status` thành `"started"`, chấp nhận bài nộp (`success: true`, `answerAccepted: true`) và chấm điểm luôn — tạo lỗ hổng gian lận cho thí sinh gửi request sớm trước khi phòng mở thi.
- **Test case / Test code phát hiện:** `TC-11` — `tests/integration/room.integration.test.js` (`Từ chối nộp bài khi phòng vẫn đang ở trạng thái waiting`).

---

## BUG-04: Tạo phòng thi chấp nhận và lưu sức chứa âm (`capacity < 1`)
- **Mức độ nghiêm trọng:** Trung bình
- **Vị trí mã nguồn:** `src/rooms/manager.js` (hàm `createRoom`, dòng 116)
- **Bước tái hiện:**
  1. Gọi `roomsManager.createRoom({ hostUsername: "host_neg", exam, capacity: -5, title: "Phòng sức chứa âm" })` (hoặc truyền `capacity: -5` qua `POST /api/rooms`).
  2. Kiểm tra thuộc tính `room.capacity` vừa tạo và thử cho thí sinh tham gia phòng.
- **Kết quả mong đợi:** Hệ thống từ chối giá trị sức chứa `< 1` hoặc chuẩn hóa về giá trị hợp lệ tối thiểu (`>= 1`).
- **Kết quả thực tế:** Biểu thức `Number(capacity) || 40` đánh giá `-5` là truthy nên lưu nguyên `room.capacity = -5`. Khi thí sinh tham gia, điều kiện `candidates.length >= room.capacity` (`0 >= -5`) luôn đúng khiến phòng bị kẹt trạng thái đầy vĩnh viễn và không thí sinh nào vào được.
- **Test case / Test code phát hiện:** `TC-21` — `tests/unit/room.unit.test.js` (`createRoom không được lưu sức chứa âm`).
