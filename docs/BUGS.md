# Hồ sơ Lỗi & Khắc phục Toàn Hệ thống (Bug & Hardening Report) — MiniQuizN12Web

Tài liệu tổng hợp **16 lỗi thực tế và lỗ hổng bảo mật** được phát hiện và khắc phục triệt để trong quá trình xây dựng bộ kiểm thử toàn hệ thống (`npm run test:full` / `npm run test:all`). Mọi lỗi đều có test tự động tái hiện và chống hồi quy (regression test).

---

## Phần A — 4 lỗi từ đợt kiểm thử cơ sở (Đã khắc phục)

### BUG-01: `validatePassword` chấp nhận mật khẩu chỉ gồm khoảng trắng & đầu vào phi chuỗi
- **Vị trí:** `src/auth.js` (`validatePassword`, `validateUsername`, `validateDisplayName`), `public/index.html`, `public/dashboard.html`, `public/js/home.js`, `public/js/dashboard.js`
- **Nguyên nhân gốc:** Chỉ kiểm tra `!password || password.length < 6` mà không kiểm tra `typeof === 'string'`, `.trim().length >= 6` và giới hạn độ dài tối đa, cho phép mật khẩu `"      "` / `"     a"` lọt qua hoặc mảng `[1,2,3,4,5,6]` gây crash `crypto.scrypt` (`HTTP 500`). Tương tự `validateUsername(['abc'])` bị ép kiểu mảng thành chuỗi `'abc'` và `validateDisplayName(['A'])` gây crash `.trim()` ở `src/server.js`.
- **Khắc phục:** Bắt buộc `typeof === 'string'` trên cả 3 hàm validate; `validatePassword` yêu cầu `password.trim().length >= 6` và `password.length <= 128` (chống DoS `scrypt`); đồng bộ `maxlength="128"` và kiểm tra UI ở form đăng ký & cài đặt tài khoản.
- **Test chống hồi quy:** `TC-03`, `SYS-U01`, `SEC-03`, `FE-04`.

### BUG-02: API lưu/chia sẻ đề thi chấp nhận tiêu đề toàn khoảng trắng, 0 câu hỏi hoặc kiểu dữ liệu sai
- **Vị trí:** `src/server.js` (`POST /api/storage/private`, `/api/storage/public/check-share`, `/api/storage/public/share`), `public/js/create-exam.js`
- **Nguyên nhân gốc:** Điều kiện `!examData.title` không kiểm tra `typeof examData.title === 'string'`, `.trim()` và bỏ qua kiểm tra đề rỗng `0` câu hỏi (`questions: []`).
- **Khắc phục:** Chặn cứng HTTP `400` khi tiêu đề chuỗi sau `.trim()` rỗng hoặc `questions` không phải mảng có ít nhất 1 câu hỏi tại cả kho cá nhân và chia sẻ công khai; đồng bộ thông báo lỗi khi lưu đề thất bại trên UI `create-exam.js`.
- **Test chống hồi quy:** `TC-14`, `SEC-03`.

### BUG-03: Thí sinh có thể nộp đáp án khi phòng thi vẫn ở trạng thái `waiting`
- **Vị trí:** `src/rooms/manager.js` (`submitAnswer`), `src/server.js` (`POST /api/rooms/:pin/answer`), `public/js/room.js`
- **Nguyên nhân gốc:** Nhánh `(room.status === 'waiting' && qIdxNum === 0)` trong `submitAnswer()` và endpoint HTTP cho phép thí sinh nộp câu 0 sớm tự động chuyển trạng thái phòng thành `started` trước khi Host bấm bắt đầu.
- **Khắc phục:** Chặn triệt để ở cả tầng lõi `roomsManager.submitAnswer()` (chỉ tự động chuyển từ `countdown` sang `started`, giữ nguyên `waiting` và trả `rejected: true`) lẫn tầng HTTP; đồng bộ UI `room.js` xử lý thông báo `res.rejected`.
- **Test chống hồi quy:** `TC-11`, `TC-21`.

### BUG-04: Tạo phòng thi chấp nhận và lưu sức chứa âm / 0 / số thực / vô cực
- **Vị trí:** `src/server.js` (`POST /api/rooms`), `src/rooms/manager.js` (`createRoom`), `public/create-room.html`, `public/js/create-room.js`
- **Nguyên nhân gốc:** Biểu thức `Number(capacity) || 40` giữ nguyên số âm (`-5`), `-Infinity`, `Infinity` và số thực (`12.9`), khiến phòng sức chứa âm luôn báo đầy (`0 >= -5`).
- **Khắc phục:** API `POST /api/rooms` trả HTTP `400` rõ ràng khi client truyền `capacity` không phải số nguyên trong `[1, 500]` (bỏ trống mặc định `40`); tầng `createRoom` chuẩn hóa phòng thủ `[1, 500]`; đồng bộ giao diện `create-room.html` (`max="500"`) và validation trên `create-room.js` (chỉ xóa `mqc_assigned_exam` sau khi server xác nhận tạo thành công).
- **Test chống hồi quy:** `TC-21`, `SYS-U05`, `FE-04`.

---

## Phần B — 12 lỗi & lỗ hổng mới phát hiện bởi bộ Test mở rộng (Đã khắc phục)

### BUG-05 (Bảo mật Cao): Reflected XSS & Crash HTTP 500 qua Header `X-Forwarded-Host` / `Host` / `APP_URL`
- **Vị trí:** `src/server.js` (`getRequestHost`, `getRequestProto`, `handleHttpRequest`, khối bơm `<script>` HTML tĩnh)
- **Nguyên nhân gốc:**
  1. `host` lấy trực tiếp từ `req.headers['x-forwarded-host']` đưa vào `new URL(req.url, "${proto}://${host}")` gây ngoại lệ `TypeError [ERR_INVALID_URL]` (`HTTP 500`) khi header chứa ký tự lạ hoặc `X-Forwarded-Proto` bất hợp lệ.
  2. Biến `publicUrl` nối thẳng vào `<script>window.__SERVER_PUBLIC_URL__ = "${publicUrl}";</script>` không escape, cho phép đóng thẻ `</script>` và thực thi mã độc XSS.
- **Khắc phục:** Whitelist `proto` (`http`/`https`), kiểm tra cú pháp `host` hợp lệ, bắt lỗi `new URL(...)` trả `400`, và mã hóa toàn bộ biến bơm vào `<script>` bằng `JSON.stringify(...).replace(/</g, '\\u003c')`.
- **Test chống hồi quy:** `SEC-01`.

### BUG-06 (Bảo mật Trung bình): Kiểm tra tiền tố thư mục tĩnh `fp.startsWith(STATIC_DIR)` dễ bị lách & lỗi `URIError` `500` khi URL chứa `%ZZ`
- **Vị trí:** `src/server.js` (Static file serving, `sendRequestError`, các route `/api/rooms/:pin/*` & `DELETE /api/storage/*`)
- **Nguyên nhân gốc:**
  1. `fp.startsWith(STATIC_DIR)` không dùng `path.relative`, có nguy cơ khớp nhầm thư mục anh em cùng tiền tố (`public-secret`) và chưa giải mã URL cho tên file tĩnh.
  2. Các chuỗi phần trăm hỏng (`/%E0%A4%A`, `/api/rooms/%E0%A4%A`) làm `decodeURIComponent` ném `URIError` không có `err.status`, khiến server trả `HTTP 500` thay vì `400`.
- **Khắc phục:** Dùng `path.relative(STATIC_DIR, fp)` kiểm tra không bắt đầu bằng `'..'` và không tuyệt đối; đồng bộ `decodeURIComponent` trên các tham số đường dẫn và ánh xạ `URIError` về `HTTP 400`.
- **Test chống hồi quy:** `SEC-01`.

### BUG-07 (Độ tin cậy Cao): Gửi JSON nguyên thủy (`null`, `123`, `"str"`, `[]`) làm crash `HTTP 500` hàng loạt API POST
- **Vị trí:** `src/server.js` (`readJsonBody`)
- **Nguyên nhân gốc:** `JSON.parse("null")` trả về `null` hợp lệ về mặt cú pháp JSON, khiến lệnh destructuring `const { username } = body` hoặc `body.pin` ở hơn 12 endpoint POST ném `TypeError` (`HTTP 500`).
- **Khắc phục:** Đảm bảo `readJsonBody` từ chối mọi JSON gốc không phải plain object (`!parsed || typeof parsed !== 'object' || Array.isArray(parsed)`) với mã `HTTP 400 INVALID_JSON`.
- **Test chống hồi quy:** `SEC-03`.

### BUG-08 (Độ tin cậy Trung bình): `POST /api/auth/change-profile` crash `HTTP 500` khi `newDisplayName` hoặc mật khẩu không phải chuỗi
- **Vị trí:** `src/server.js` (`POST /api/auth/change-profile`)
- **Nguyên nhân gốc:** Gọi trực tiếp `newDisplayName.trim()` khi client gửi số (`12345`) hoặc mảng, và truyền `currentPassword`/`newPassword` kiểu phi chuỗi vào `crypto.scrypt` gây `TypeError` (`HTTP 500`).
- **Khắc phục:** Kiểm tra `typeof === 'string'` cho `newDisplayName`, `newPassword`, `currentPassword` trước khi xử lý và trả `HTTP 400` rõ ràng.
- **Test chống hồi quy:** `SEC-03`.

### BUG-09 (Logic Nghiệp vụ Cao): `POST /api/rooms/:pin/answer` tự động ép `choice = null / "" / false / []` thành đáp án `0`
- **Vị trí:** `src/server.js` (`POST /api/rooms/:pin/answer`)
- **Nguyên nhân gốc:** `Number(null)`, `Number("")`, `Number(false)` và `Number([])` trong JavaScript đều trả về `0`, khiến request thiếu/sai kiểu lựa chọn bị chấm nhầm thành chọn phương án A (`0`) và mất lượt nộp bài của thí sinh; tương tự `Number(body.qIdx) || 0` biến `qIdx = "abc"` hoặc `null` thành `0`.
- **Khắc phục:** Tách hàm kiểm tra giá trị rỗng/boolean/mảng (`isBlankScalar`) để truyền `NaN`, buộc `submitAnswer` từ chối an toàn (`invalidChoice: true` / `rejected: true`) và giữ nguyên lượt làm bài.
- **Test chống hồi quy:** `SEC-03`.

### BUG-10 (Logic Dữ liệu Cao): `POST /api/history` làm hỏng `correctCount` và `accuracyPct` thành `NaN` (`null`) ở chế độ luyện tập
- **Vị trí:** `src/server.js` (`POST /api/history` — nhánh luyện tập & nhánh tra cứu `game_sessions` đã lưu)
- **Nguyên nhân gốc:**
  1. Biểu thức `Number(body.correctCount) !== undefined` luôn đúng (`NaN !== undefined` là `true`), ghi đè kết quả vừa tính bằng `NaN` khi client không gửi trường này.
  2. `sess.stats` đọc từ cột TEXT/JSON chưa `JSON.parse` khi trả về dạng chuỗi, làm mất `candidatesMatrix` khi khôi phục lịch sử từ DB.
- **Khắc phục:** Dùng `Number.isFinite(Number(...))` và parse an toàn `sess.stats` khi ở dạng chuỗi JSON.
- **Test chống hồi quy:** `API-03`.

### BUG-11 (Toàn vẹn Dữ liệu Trung bình): `saveQuiz` làm mất điểm/thời gian riêng từng câu và bỏ sót version mới khi sửa ảnh/độ khó
- **Vị trí:** `src/db/index.js` (`saveQuiz`)
- **Nguyên nhân gốc:**
  1. Khi ghi `quiz_questions`, hàm dùng `exam.pointsPerQ` và `exam.timePerQ` thay vì ưu tiên `q.points` và `q.timeLimit` của từng câu hỏi.
  2. Biến `hasChanged` chỉ so sánh `content`, `explanation` và `options` mà bỏ quên `difficulty` và `image_url`, khiến chỉnh sửa ảnh minh họa hoặc độ khó không tạo `question_versions` mới.
- **Khắc phục:** Bổ sung so sánh `difficulty` + `image_url` trong `hasChanged` và lưu `q.points || exam.pointsPerQ || 100`, `q.timeLimit || exam.timePerQ || 15`.
- **Test chống hồi quy:** `DB-02`.

### BUG-12 (Toàn vẹn Dữ liệu Thấp): `saveHostedGameSession` không cập nhật `room_title` khi ghi đè phiên chờ sẵn có
- **Vị trí:** `src/db/index.js` (`saveHostedGameSession`)
- **Nguyên nhân gốc:** Mệnh đề `ON CONFLICT (id) DO UPDATE` thiếu `room_title = EXCLUDED.room_title`, giữ lại tiêu đề cũ từ lúc phòng mới tạo.
- **Khắc phục:** Bổ sung `room_title = EXCLUDED.room_title` vào câu lệnh upsert.
- **Test chống hồi quy:** `DB-03`.

### BUG-13 (Toàn vẹn Dữ liệu Trung bình): `migrate.js` làm mất đáp án đúng của câu hỏi nhiều lựa chọn khi import dữ liệu cũ
- **Vị trí:** `src/db/migrate.js` (`migrateQuizzesAndQuestions`)
- **Nguyên nhân gốc:** Vòng lặp tạo `question_options` chỉ kiểm tra `(quest.correct === cIdx)` mà bỏ qua mảng `quest.correctChoices`.
- **Khắc phục:** Chuẩn hóa tập `correctSet` từ `quest.correctChoices` (hoặc fallback `quest.correct`) trước khi ghi `is_correct`.
- **Test chống hồi quy:** `DB-04`.

### BUG-14 (Độ tin cậy Trung bình): `addPlayer` tạo nickname rỗng `""` khi nhập khoảng trắng và crash `TypeError` khi `nick` không phải chuỗi
- **Vị trí:** `src/rooms/manager.js` (`addPlayer`) & `src/auth.js` (`deleteOtherSessions`, `upsertUser`)
- **Nguyên nhân gốc:** `(nick || 'Thí sinh').trim()` trả về `""` khi `nick = "   "` và ném `TypeError` khi `nick = 12345`. Ngoài ra `upsertUser` làm rơi trường `bio` và `deleteOtherSessions(null)` có thể crash.
- **Khắc phục:** Kiểm tra `typeof nick === 'string'`, fallback về `'Thí sinh'` sau khi `.trim()`, bảo toàn `bio` trong `upsertUser` và chuẩn hóa `String(username || '')` trong `deleteOtherSessions`.
- **Test chống hồi quy:** `SYS-U04`, `SYS-U06`, `SEC-03`.

### BUG-15 (Trích xuất Đề thi Trung bình): `ExamImporter` bắt nhầm chữ cái trong nhãn đáp án & lỗi dấu ngoặc kép thoát `""` trong CSV
- **Vị trí:** `public/js/exam-importer.js` (`parseAnswerIndices`, `parseCsv`)
- **Nguyên nhân gốc:**
  1. `parseAnswerIndices` quét mọi ký tự `[A-H]` trên toàn chuỗi nên `"Đáp án đúng: B"` khớp cả chữ `'G'` trong `"ĐÚNG"` (biến thành câu nhiều đáp án `[B, G]`), còn `"Choice D"` khớp `C, H, E, D`.
  2. Bộ tách CSV đảo `inQuotes` trên mọi dấu `"` mà không xử lý cặp `""` chuẩn RFC-4180 bên trong ô có dấu phẩy.
- **Khắc phục:** Loại bỏ tiền tố nhãn phổ biến (`Đáp án đúng:`, `Answer:`, `Choice`, `Option`, `Key:`...) trước khi tách ký tự đáp án và xử lý đúng cặp `""` trong `parseCsv`.
- **Test chống hồi quy:** `FE-02`.

### BUG-16 (Bảo mật Trung bình): Open Redirect qua tham số `?redirect=` & mất focus ô nhập khi đăng nhập/đăng ký
- **Vị trí:** `public/js/home.js` (`sanitizeRedirectTarget`, `handleLogin`, `handleRegister`, `openLoginModal`, `renderHeaderAuth`)
- **Nguyên nhân gốc:** Đọc thẳng `urlParams.get('redirect')` gán vào `window.location.href` mà không kiểm tra cùng origin (`https://evil.com`, `//evil.com`, `javascript:...`), đồng thời hàm `renderHeaderAuth` và `openLoginModal` làm mất focus ô đang nhập.
- **Khắc phục:** Thêm `sanitizeRedirectTarget()` chỉ cho phép đường dẫn tương đối cùng origin (mặc định về `dashboard.html` nếu sai) và giữ nguyên DOM nút đăng nhập/focus modal khi đang thao tác.
- **Test chống hồi quy:** `FE-03`, `E2E-F01`.
