# BÁO CÁO REFACTOR HỆ THỐNG DATABASE (DATABASE_REFACTOR.md)

## 1. Vấn đề của Database cũ (Legacy Architecture)
- **Phụ thuộc vào JSON/Local file**: Dữ liệu đề thi (`data/public/exams.json`), private exams (`data/private/*.json`), lịch sử làm bài (`data/history/**/history.json`), phòng thi đang chạy (`data/active_rooms.json`) và tài khoản (`data/auth/users.json`) được lưu dưới dạng file cục bộ trên đĩa. Khi restart container hoặc scale môi trường Cloud Run / Serverless, dữ liệu có nguy cơ bị mất hoặc không đồng bộ.
- **Dữ liệu Quiz lưu nguyên JSON blob**: Toàn bộ câu hỏi, đáp án, giải thích bị đóng gói trong cột JSON `questions` hoặc file JSON. Không thể truy vấn ngân hàng câu hỏi, không thể tái sử dụng câu hỏi giữa các đề thi khác nhau.
- **Không có Question Versioning**: Khi giáo viên chỉnh sửa một câu hỏi, các đề thi đã phát hành hoặc kết quả bài làm trước đó bị ảnh hưởng hoặc sai lệch kết quả lịch sử.
- **Lịch sử làm bài không tách bạch (Granularity kém)**: Kết quả bài thi lưu nguyên mảng `answers_detail` trong 1 trường JSON, không cho phép thống kê tỷ lệ đúng theo từng câu hỏi, độ khó, hoặc kỹ năng của người học.
- **Lỗ hổng bảo mật đáp án**: Đáp án đúng (`correct`) bị gửi kèm xuống client của học sinh ngay từ lúc nạp câu hỏi, cho phép học sinh xem trước đáp án qua DevTools Console / Network. Điểm số dựa trên client gửi lên thay vì backend xác nhận.

---

## 2. Schema mới & Bảng đã tạo (PostgreSQL Normalized Schema)

Hệ thống đã chuyển toàn bộ sang **PostgreSQL (Single Source of Truth)** với mô hình phân tầng chuẩn hoá:

### Danh mục bảng:
1. **`users` & `user_sessions`**: Lưu trữ tài khoản và phiên làm việc (Session) tập trung trong cơ sở dữ liệu.
2. **`profiles`**: Hồ sơ người dùng (avatar, bio, role: teacher/student/admin), liên kết 1-1 với `users`.
3. **`organizations` & `organization_members`**: Cấu trúc tổ chức/trường học/lớp học mở rộng cho mô hình đa người dùng (RBAC).
4. **`subjects`, `topics`, `tags`, `question_tags`**: Phân loại ngân hàng câu hỏi theo môn học, chủ đề, nhãn.
5. **`questions`**: Định danh thực thể câu hỏi độc lập trong Ngân hàng đề thi (Question Bank).
6. **`question_versions`**: Quản lý phiên bản câu hỏi (`version`, `content`, `explanation`, `difficulty`, `image_url`). Khóa duy nhất `(question_id, version)`.
7. **`question_options`**: Tách bạch từng lựa chọn đáp án (`content`, `is_correct`, `order_index`).
8. **`quizzes`**: Quản lý đề thi (`id`, `code`, `title`, `subject`, `author`, `time_per_q`, `points_per_q`, `is_public`, `owner_id`).
9. **`quiz_questions`**: Bảng quan hệ ánh xạ nhiều-nhiều giữa `quizzes` và `question_versions` (`quiz_id`, `question_version_id`, `order_index`, `points`, `time_limit`).
10. **`game_sessions`**: Lưu trữ bền vững các phòng thi multiplayer (`id`, `quiz_id`, `host_id`, `room_code`, `status`, `total_players`, `stats`).
11. **`game_players`**: Lưu kết quả từng thí sinh trong phòng (`final_score`, `rank`, `correct_count`, `wrong_count`, `joined_at`, `finished_at`).
12. **`attempts` & `attempt_answers`**: Chi tiết lịch sử làm bài thi. Từng lựa chọn của thí sinh được lưu riêng biệt vào `attempt_answers` (`question_version_id`, `user_choice`, `is_correct`, `score_awarded`, `response_time_ms`, `streak_before`, `streak_after`).
13. **`question_statistics` & `user_topic_mastery`**: Nền tảng thống kê độ chính xác từng câu hỏi và mức độ thành thạo môn học của học sinh.
14. **Bảng mở rộng tương lai**: `documents`, `ai_generation_jobs`, `ai_question_reviews`, `audit_logs`.

### Sơ đồ quan hệ chính:
```
quizzes (1) ──── (N) quiz_questions (N) ──── (1) question_versions
                                                          │ (1)
                                                          ├── (N) question_options
                                                          └── (1) questions
attempts (1) ──── (N) attempt_answers (N) ──── (1) question_versions
game_sessions (1) ──── (N) game_players
users (1) ──── (1) profiles
```

---

## 3. Các file code đã cập nhật & tạo mới

| File | Hành động | Mục đích |
|---|---|---|
| `src/db/schema.sql` | Tạo mới | Định nghĩa 24 bảng chuẩn hóa, indexes, foreign keys, unique constraints. |
| `src/db/pool.js` | Tạo mới | Quản lý kết nối PostgreSQL qua `pg.Pool`, hỗ trợ transaction `withTransaction`. |
| `src/db/migrate.js` | Tạo mới | Script tự động chạy migration nạp dữ liệu cũ (JSON & Supabase) vào schema chuẩn hóa. |
| `src/db/index.js` | Tạo mới | Service tầng dữ liệu: Users, Quizzes, Question Bank, Versioning, Attempts, Game Sessions. |
| `src/rooms/manager.js` | Tạo mới | Module quản trị phòng thi realtime tách rời, tính điểm server-side, tự động archive vào DB. |
| `src/auth.js` | Refactor | Chuyển toàn bộ quản lý tài khoản & session sang PostgreSQL, loại bỏ đọc/ghi file JSON. |
| `src/server.js` | Refactor | Bỏ toàn bộ code đọc/ghi file local; tích hợp API với `src/db/index.js` và `roomsManager`. |
| `public/js/room.js` | Refactor | Nhận kết quả chấm điểm và đáp án từ backend sau khi trả lời; bảo vệ tính bảo mật. |
| `package.json` | Refactor | Dọn dẹp các thư viện thừa (firebase, drizzle); chốt stack `pg` + `@supabase/supabase-js`. |

---

## 4. Quá trình Migration đã thực hiện
1. **Áp dụng Schema**: Tạo thành công 24 bảng quan hệ và các chỉ mục (`idx_quizzes_owner_id`, `idx_quiz_questions_quiz_id`, `idx_question_versions_question_id`, `idx_attempts_user_created`, v.v.).
2. **Di trú Người dùng**: Nạp 100% tài khoản vào bảng `users` và tự động sinh bản ghi tương ứng trong `profiles`.
3. **Di trú Đề thi sang Question Bank**: Tách toàn bộ câu hỏi trong đề mẫu và đề riêng thành các thực thể độc lập trong `questions`, tạo version 1 trong `question_versions`, tạo các lựa chọn trong `question_options`, và liên kết trong `quiz_questions`.
4. **Di trú Lịch sử**: Chuyển đổi dữ liệu lịch sử cũ sang `attempts` và bung mảng chi tiết thành các dòng trong `attempt_answers`.
5. **Di trú Phòng thi**: Chuyển các phòng thi đã tổ chức sang `game_sessions` và `game_players`.

---

## 5. Phần Legacy đã loại bỏ
- Đã loại bỏ hoàn toàn việc đọc/ghi `active_rooms.json`, `active_rooms.json.tmp`.
- Đã loại bỏ hoàn toàn việc lưu `users.json`, `sessions.json`, `login_attempts.json`, `register_attempts.json`.
- Đã loại bỏ hoàn toàn các hàm ghi file JSON lịch sử (`writeUserHistory`, `writeHostRoomHistory`).
- Đã loại bỏ hoàn toàn các hàm ghi file JSON đề thi (`writePrivateExams`, `writePublicExams`).
- Đã loại bỏ các dependencies không sử dụng: `firebase`, `firebase-admin`, `drizzle-orm`, `drizzle-kit`.

---

## 6. Bảo mật & Tính toàn vẹn (Security Hardening)
- **Chống lộ đáp án**: Khi thí sinh truy vấn `/api/rooms/:pin`, server không gửi trường `correct` hoặc `is_correct`. Thí sinh không thể dùng DevTools để gian lận.
- **Server-authoritative Scoring**: Hàm `submitAnswer` tại `src/rooms/manager.js` trực tiếp đối chiếu câu trả lời với đáp án trong hệ thống, tự động tính Speed Bonus và Streak Bonus trên server.
- **Question Versioning**: Khi giáo viên sửa câu hỏi trong đề thi, hệ thống kiểm tra sự thay đổi nội dung/lựa chọn. Nếu thay đổi, hệ thống tự động sinh `version 2` (v.v.) và trỏ quiz sang version mới. Version cũ được giữ nguyên vẹn để bảo toàn lịch sử làm bài của học sinh.

---

## 7. Hướng mở rộng Redis khi cần scale lớn (Scale Roadmap)
Hiện tại `src/rooms/manager.js` đã được thiết kế theo dạng **State Abstraction**:
- Khi số lượng phòng thi tăng lên hàng nghìn phòng đồng thời trên nhiều cụm server (Multi-instance):
  1. Giữ nguyên toàn bộ API routes và client interface.
  2. Trong `src/rooms/manager.js`, thay thế `activeRooms = new Map()` bằng Redis Client (ví dụ `ioredis`).
  3. Dùng Redis Hash (`HSET room:<pin>`) để lưu thông tin phòng, Redis Sets cho danh sách players, và Redis Pub/Sub cho các sự kiện lockstep.
  4. Các hàm `submitAnswer`, `updatePlayerScore`, `advanceQuestion` sẽ thao tác atomic trên Redis, sau đó khi phòng kết thúc vẫn gọi nguyên vẹn `db.saveHostedGameSession()` lưu vào PostgreSQL.

---

## 8. Kết quả kiểm thử chức năng (All Passed)
1. Server Info: OK
2. Đăng ký & Đăng nhập (Auth & Session): OK
3. Kiểm tra Session `/api/auth/me`: OK
4. Tạo đề thi mới (Tách Questions & Options): OK
5. Sửa đề thi & Question Versioning (Tự động sinh v2 mà không sửa v1): OK
6. Xuất bản đề thi công khai (Public share): OK
7. Sao chép đề thi công khai về kho cá nhân (Duplicate & Reuse): OK
8. Tạo phòng thi Multiplayer: OK
9. Thí sinh tham gia phòng (Player Join): OK
10. Kiểm tra bảo mật (Ẩn đáp án đúng trước khi làm): PASSED
11. Bắt đầu phòng thi & Chuyển câu hỏi: OK
12. Nộp đáp án & Chấm điểm Server-side + Chuỗi streak: OK
13. Bảng xếp hạng Realtime Leaderboard: OK
14. Lưu trữ kết quả chi tiết vào `attempts` & `attempt_answers`: OK
15. Truy vấn lịch sử làm bài từ database: OK
16. Lưu trữ kết thúc phòng vào `game_sessions` & `game_players`: OK
17. Khởi động lại Server kiểm tra Persistence: **Dữ liệu được bảo toàn 100% trong PostgreSQL.**
