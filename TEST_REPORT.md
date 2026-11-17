# Báo Cáo Kiểm Thử Toàn Diện & Gia Cố Chống Chịu — MiniQuizN12Web

> **Branch base:** `main` (`7c9f56b` — `feat: implement custom confirmation modal and copy similarity check`)  
> **Công cụ chạy:** `npm run lint` (`node scripts/check-syntax.js`) và `npm test` (`node --test tests/*.test.js`)

---

## 1. Tổng hợp kết quả kiểm thử sau cùng

- **`npm run lint`**: **PASS** (`All JavaScript syntax checks passed.`, exit code `0`).
- **`npm test`**:
  - **Tổng số tests:** `93` (`duration_ms: 6723.1561`)
  - **Pass:** `92`
  - **Fail:** `0`
  - **Skipped:** `1` — [tests/db-integration.test.js](tests/db-integration.test.js) *(gồm 5 subtests tích hợp PostgreSQL thật, chỉ chạy khi thiết lập `RUN_DB_TESTS=1` cùng `TEST_DATABASE_URL` / `DATABASE_URL` kết nối được)*.

| File kiểm thử | Nguồn | Số `test(...)` | Pass | Fail | Skip |
|---|---|---:|---:|---:|---:|
| [tests/auth.test.js](tests/auth.test.js) | Mới thêm | 12 | 12 | 0 | 0 |
| [tests/db-layer.test.js](tests/db-layer.test.js) | Mới thêm | 11 | 11 | 0 | 0 |
| [tests/room-manager.test.js](tests/room-manager.test.js) | Mới thêm | 10 | 10 | 0 | 0 |
| [tests/http-routes.test.js](tests/http-routes.test.js) | Mới thêm | 7 | 7 | 0 | 0 |
| [tests/importer.test.js](tests/importer.test.js) | Mới thêm | 11 | 11 | 0 | 0 |
| [tests/ai-extended.test.js](tests/ai-extended.test.js) | Mới thêm | 11 | 11 | 0 | 0 |
| [tests/frontend-logic.test.js](tests/frontend-logic.test.js) | Mới thêm | 5 | 5 | 0 | 0 |
| [tests/concurrency-load.test.js](tests/concurrency-load.test.js) | Mới thêm | 4 | 4 | 0 | 0 |
| [tests/resilience-stress.test.js](tests/resilience-stress.test.js) | Mới thêm | 7 | 7 | 0 | 0 |
| [tests/db-integration.test.js](tests/db-integration.test.js) | Mới thêm | 1 *(5 subtests)* | 0 | 0 | 1 |
| [tests/ai.test.js](tests/ai.test.js) | Gốc trong repo | 2 | 2 | 0 | 0 |
| [tests/security.test.js](tests/security.test.js) | Gốc trong repo | 12 | 12 | 0 | 0 |
| **Tổng cộng** | | **93** | **92** | **0** | **1** |

---

## 2. Kiểm thử chống chịu, các lỗi tái hiện được & bản vá trên mã nguồn (`src/`)

Khi chạy bộ [tests/resilience-stress.test.js](tests/resilience-stress.test.js) trên nền `7c9f56b` trước khi vá (**0/7 pass**), đã tái hiện được các vấn đề sau và khắc phục trực tiếp:

| Hạng mục | Lỗi tái hiện trước khi vá | Bản vá đã áp dụng | Kết quả sau vá |
|---|---|---|---|
| **Malformed JSON & Payload `> 2MB`** | Gửi `{"broken":` tới các room sub-routes gây Unhandled Rejection `SyntaxError` trong `readJsonBody` (sập server); route khác trả `500`; `req.destroy()` ngắt TCP trước khi trả `413` | Bọc handler HTTP tổng `handleHttpRequest(...).catch(sendRequestError)`; đếm UTF-8 byte trong `readJsonBody` + cờ `settled`; chuẩn hóa trả `400` / `413` (`Connection: close`); gắn `stream.on('error')` cho static files ([src/server.js](src/server.js)) | **PASS** (10 POST endpoints trả đúng `400`/`413`) |
| **Cookie sai percent-encoding** | `Cookie: mqc_session=%E0%A4%A` ném `URIError: URI malformed` ở `parseCookies` | Bọc `decodeURIComponent` bằng `try/catch` trong `parseCookies` ([src/auth.js](src/auth.js)) | **PASS** (0 `URIError`, 0 lỗi `5xx`) |
| **Race vượt giới hạn 3 phòng/host** | 8 request `POST /api/rooms` đồng thời khi DB trễ 30ms tạo được cả `8/8` phòng | Khóa tuần tự theo `hostUsername` (`withHostRoomCreateLock` trong [src/server.js](src/server.js)) và giữ chỗ `activeRooms.set(pin, room)` trước `await db.createWaitingGameSession` kèm rollback ([src/rooms/manager.js](src/rooms/manager.js)) | **PASS** (`3` tạo mới `200`, `5` chặn `409`) |
| **Slowloris & Socket ngắt giữa chừng** | `server.requestTimeout` mặc định `300000ms` (5 phút) | Đặt `requestTimeout = 45000`, `headersTimeout = 15000`, `keepAliveTimeout = 10000`, `listen` backlog `1024`; xử lý `aborted`/`close` trong `readJsonBody` ([src/server.js](src/server.js)) | **PASS** |
| **DB lỗi giữa transaction & phục hồi** | `withTransaction` để lỗi `ROLLBACK` khi socket đứt nuốt mất lỗi query gốc | Bọc `ROLLBACK` trong `try/catch` để bảo toàn lỗi gốc và luôn `release()` client ([src/db/pool.js](src/db/pool.js)) | **PASS** |
| **Phình RAM rate-limit / session maps** | Flood 15.000 IP giả khiến `loginAttempts`, `registerAttempts`, `userRateBuckets` tăng vô hạn | Không lưu mảng rỗng ở `checkRegisterLimit`; tự tỉa bản ghi hết hạn + trần `MAX_TRACKED_IPS = 5000` ([src/auth.js](src/auth.js)), `MAX_RATE_BUCKETS = 5000` ([src/ai/gemini.js](src/ai/gemini.js)), tỉa `memorySessions` tại ngưỡng `10000` | **PASS** |
| **Nghẽn Event Loop khi vừa thi vừa login** | `scryptSync` chạy đồng bộ trên Main Thread | Thêm `hashPasswordAsync` & `verifyPasswordAsync` (`crypto.scrypt` qua libuv threadpool) dùng cho HTTP routes, giữ nguyên hàm sync tương thích ngược ([src/auth.js](src/auth.js), [src/server.js](src/server.js)) | **PASS** |

### Kết quả Stress Benchmark (sau vá)
- **Kịch bản:** 3 phòng đồng thời × 80 thí sinh (**240 thí sinh**), burst **730 requests** cùng lúc (`240 /answer` + `480 /state & /status` + `10 POST /api/auth/login`) qua HTTP keep-alive pool (`maxSockets: 128`).
- **Đo đạc trực tiếp:** Hoàn tất trong **`542 ms`**, **`p95_el_delay = 55.64 ms`**, **`max_el_delay = 66.03 ms`**, **`0` lỗi `5xx`**, ghi nhận đầy đủ **`240/240`** câu trả lời.
- **Lưu ý hạ tầng Windows Desktop:** Kernel Windows Client giới hạn `SOMAXCONN = 200` với các TCP socket mới mở cùng một thời điểm; trên môi trường production cần đặt sau reverse proxy / load balancer hỗ trợ HTTP keep-alive / HTTP/2.

---

## 3. Chi tiết từng test case (`Tên - Mô tả hành vi và kết quả mong đợi - Kết quả`)

### 3.1. AI mở rộng & UI phân tích điểm yếu ([tests/ai-extended.test.js](tests/ai-extended.test.js) — 11 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `checkAiRateLimit enforces 6/min, recovers after 61s, caps at 40/hour, and isolates user::ip keys` | Cho phép tối đa 6 req/phút, chặn req thứ 7 với `retryAfterSec >= 1`, cô lập bucket `user::ip`, phục hồi sau 61s và chặn khi đạt 40 req/giờ | PASS |
| `normalizeGeneratedQuestions enforces 4-choice requirement, strips prefixes, sanitizes multi-choice, and drops malformed items` | Bỏ câu `< 4` choices hoặc text rỗng, bỏ tiền tố `A./B)/C:/D -`, chuyển đa lựa chọn sang `isMultiple + correctChoices` và ép single-choice khi `requestedType='single'` | PASS |
| `buildWeaknessStatsInput anonymizes PII, keeps <=25 weakest sorted asc, and truncates text <=160 chars` | Giữ tối đa 25 câu yếu nhất sắp theo `ratioPct` tăng dần, cắt text `<= 160` ký tự, loại bỏ hoàn toàn `candidatesMatrix`/tên thí sinh | PASS |
| `buildWeaknessCacheKey is deterministic and normalizeWeaknessAnalysis applies caps & fallbacks` | Sinh key dạng `sess-1:<24-hex>`, áp dụng summary mặc định khi rỗng, giới hạn tối đa 4 `weakQuestions` và 3 `teachingActions` | PASS |
| `memory weakness cache enforces 6h TTL and caps size at 100 entries (LRU eviction)` | Lưu tối đa 100 entry (evict khóa cũ nhất khi thêm vượt 100) và hết hạn trả `null` sau `6h + 1ms` | PASS |
| `generateQuestions throws 503 AI_KEY_MISSING when GEMINI_API_KEY is absent` | Trả lỗi `status=503`, `code='AI_KEY_MISSING'` khi thiếu `GEMINI_API_KEY` | PASS |
| `generateQuestions retries transient 503 once after ~600ms and succeeds on second attempt` | Gặp lỗi transient `503 fetch failed` lần 1, chờ `600ms` và retry thành công ở lần gọi thứ 2 | PASS |
| `generateQuestions maps 429, 403/API_KEY_INVALID, 404/NOT_FOUND, invalid JSON and empty questions accurately` | Map đúng `429 RESOURCE_EXHAUSTED`, `502 GEMINI_AUTH_ERROR`, `502 GEMINI_MODEL_NOT_FOUND`, `502` JSON sai/rỗng câu hợp lệ | PASS |
| `POST /api/ai/generate-questions updates DB job status="failed" on Gemini failure and tolerates DB audit errors` | Cập nhật `ai_generation_jobs.status='failed'` khi Gemini trả 429; và vẫn trả `200` bình thường khi DB audit (`documents`/`jobs`) lỗi | PASS |
| `POST /api/ai/analyze-weakness serves DB cache without consuming rate limit and enforces session ownership 403` | Chặn `bob` truy cập session của `alice` (`403`); trả cache từ DB cho `alice` với `cached=true` mà không gọi rate limiter/Gemini | PASS |
| `AiWeaknessUI validates empty stats, escapes XSS, applies tone-low/tone-mid/tone-ok, and handles API errors` | Chặn gọi API khi stats rỗng, escape HTML chống XSS, gắn đúng class `tone-low`/`tone-mid`/`tone-ok` và hiển thị `.ai-weakness-error` + mở khóa nút khi lỗi | PASS |

### 3.2. Xác thực & Hồ sơ người dùng ([tests/auth.test.js](tests/auth.test.js) — 12 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `validateUsername accepts 3-20 alphanumeric/underscore and rejects invalid boundaries` | Chấp nhận `3..20` ký tự `[a-zA-Z0-9_]`, từ chối `<3`, `>20`, ký tự đặc biệt/khoảng trắng/dấu | PASS |
| `validateDisplayName and validatePassword enforce trim and length boundaries` | Yêu cầu `displayName` sau trim dài `1..30` ký tự, `password >= 6` ký tự | PASS |
| `hashPassword and verifyPassword use unique salts and reject wrong or length-mismatched hashes` | Mỗi lần hash sinh salt riêng; xác minh đúng trả `true`, sai mật khẩu hoặc lệch độ dài hash trả `false` | PASS |
| `parseCookies, sessionCookieHeader and clearSessionCookieHeader handle encoding and secure flags` | Giải mã URL cookie an toàn, gắn `HttpOnly` + `SameSite=Lax` (HTTP) hoặc `SameSite=None; Secure; Partitioned` (HTTPS), clear cookie với `Max-Age=0` | PASS |
| `initAuth loads users/sessions once (idempotent) and findUserByUsername handles cache, DB fallback and error` | Nạp user/session 1 lần duy nhất (`initAuth` lần 2 không query thêm), fallback DB khi miss cache và trả `null` khi DB lỗi | PASS |
| `cooldownInfo and upsertUser normalize and check expiry boundaries accurately` | Kiểm tra ngưỡng cooldown chính xác đến ms, chuẩn hóa `usernameLower` và mặc định `role='teacher'` | PASS |
| `login rate limiter locks after 15 failures with exponential backoff and resets after 24h or success` | Cảnh báo từ lần sai thứ 13, khóa ở lần thứ 16 với exponential backoff `15s * 2^n`, mở khóa sau 24h hoặc khi đăng nhập đúng | PASS |
| `register sliding window rate limiter blocks at 50/hour and recovers after 1 hour` | Cho phép 50 lượt đăng ký/giờ/IP, chặn lượt 51 và khôi phục sau 1 giờ | PASS |
| `GET /api/auth/check-username handles empty, malformed, case-insensitive taken and available` | Trả `400` khi rỗng, `valid=false` khi sai định dạng, `exists=true` không phân biệt hoa thường khi đã tồn tại, `valid=true` khi khả dụng | PASS |
| `POST /api/auth/register validates inputs, handles duplicate races, rate limit 429 and sets HTTP/HTTPS cookies` | Validate `400`, bắt race trùng DB thành `409`, giới hạn IP `429`, gắn đúng cờ `Set-Cookie` HTTP/HTTPS | PASS |
| `POST /api/auth/login, GET /api/auth/me and POST /api/auth/logout verify transport channels, expiry & lockouts` | Khóa brute-force `429`, hỗ trợ token qua `Bearer`/`X-Session-Token`/`Cookie`, xóa session khi logout và tự hủy session quá hạn 7 ngày | PASS |
| `POST /api/auth/change-profile enforces 7-day cooldowns and revokes other sessions on password change` | Áp dụng cooldown 7 ngày đổi tên & đổi mật khẩu (`429`), mở lại sau 7 ngày + 1ms, thu hồi session khác nhưng giữ nguyên session hiện tại khi đổi mật khẩu | PASS |

### 3.3. Tầng Database & Migration ([tests/db-layer.test.js](tests/db-layer.test.js) — 11 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `pool.js configures SSL correctly for localhost vs remote DATABASE_URL and unix sockets` | Tắt SSL cho localhost, bật `{ rejectUnauthorized: false }` cho remote Postgres URL, hỗ trợ `SQL_HOST` unix socket | PASS |
| `pool.js withTransaction commits on success and rolls back + releases client on error` | Tự gọi `BEGIN`/`COMMIT` khi thành công, `ROLLBACK` khi ném lỗi và luôn gọi `client.release()` | PASS |
| `migrate.js applies only unapplied migrations in sorted order and skips legacy import when quizzes exist` | Chỉ chạy file migration chưa có trong `schema_migrations` theo thứ tự chữ-số và bỏ qua import JSON khi đã có quiz | PASS |
| `db/index.js enforces DATA_BACKEND=pg and disables useSupabase` | Ném lỗi nếu `DATA_BACKEND` khác `pg` và luôn đặt `useSupabase() === false` | PASS |
| `db/index.js user and session CRUD operations issue parameterized SQL correctly` | Toàn bộ truy vấn user/session dùng tham số SQL `$1, $2...` chuẩn xác | PASS |
| `db/index.js getQuizById enforces private RBAC (anonymous, stranger, owner, shared_by, admin, internal)` | Từ chối anonymous/stranger với quiz private; cho phép owner, `shared_by`, admin, và `internal` (kèm đáp án khi `includeCorrect`) | PASS |
| `db/index.js saveQuiz preserves v1 when unchanged and creates v2 on text, choice, or multi-choice change` | Tái sử dụng `v1` khi nội dung không đổi, tạo `v2` khi sửa câu/đáp án/multi-choice và rollback transaction nếu không có quyền | PASS |
| `db/index.js deleteQuiz passes owner userId, username and role=admin check` | Truyền đúng userId, username và cờ `isAdmin` vào câu lệnh xóa quiz | PASS |
| `db/index.js getUserAttempts reconstructs multi-choice details from attempt_answers when details is empty` | Khôi phục `questionType='multiple'` và mảng `correctChoices` từ `attempt_answers` + `question_options` khi JSON `details` rỗng | PASS |
| `db/index.js saveAttempt clears invalid selected_option_id and saveHostedGameSession uses deterministic gp-sha256 IDs` | Đặt `selected_option_id = null` nếu option không thuộc `question_version` và sinh ID `gp-<sha256>` cố định | PASS |
| `db/index.js AI document, job lifecycle and cached weakness lookup queries work properly` | Tạo document, tạo/cập nhật job AI và truy vấn cache phân tích điểm yếu từ `ai_generation_jobs` | PASS |

### 3.4. Quản lý phòng thi ([tests/room-manager.test.js](tests/room-manager.test.js) — 10 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `createRoom generates natural unique PINs, allows own PIN restore and blocks overwriting another host PIN` | Sinh PIN `XXX-XXX` không trùng, cho phép host khôi phục chính PIN của mình nhưng cấp PIN mới cho người khác | PASS |
| `cleanupExpiredRooms evicts rooms older than 4 hours and updates countActiveRoomsByHost` | Xóa các phòng tạo quá 4 giờ và cập nhật đúng số phòng active của host | PASS |
| `addPlayer enforces capacity (excluding host), lock, nick 25-char truncation & reconnect token/account rules` | Tính sĩ số không gồm host, chặn phòng khóa (`locked`), cắt nick tối đa 25 ký tự, xác thực token/account khi reconnect và báo `full` khi đầy | PASS |
| `verifyPlayer supports token lookup fallback and rejects invalid/mismatched credentials` | Hỗ trợ tìm thí sinh theo `playerToken` khi thiếu `id`, từ chối token sai hoặc rỗng | PASS |
| `removePlayer preserves candidates during countdown/started unless kicked by host` | Cho tự rời ở `waiting`, giữ nguyên thí sinh nếu rời lúc đang thi (`preserved`), chỉ xóa khi host kick và không bao giờ xóa host | PASS |
| `startRoom & advanceQuestion validate states, clamp countdown [1, 60] and reject out-of-range qIdx` | Giới hạn countdown trong `[1, 60]`, từ chối câu hỏi ngoài phạm vi hợp lệ | PASS |
| `submitAnswer scoring, 2s grace window, streak cap 50, wrong reset & auto-start on qIdx=0` | Chấm điểm theo tốc độ + bonus streak tối đa `+50`, reset streak khi sai, hỗ trợ grace window 2s sau deadline và tự chuyển sang `started` ở câu 0 | PASS |
| `getLeaderboard tie-breaks by lastUpdated and updatePlayerMetadata hides score during question phase` | Hòa điểm xếp theo `lastUpdated` sớm hơn; ẩn điểm khỏi payload public khi đang ở phase `question` | PASS |
| `calculateExamStats handles 0 candidates and multi-choice questions cleanly` | Không chia cho 0 khi 0 thí sinh và thống kê phân bố chính xác cho câu nhiều đáp án | PASS |
| `finishAndArchiveRoom handles legacy room without sessionId, concurrent calls & DB failures` | Chống double-archive khi gọi đồng thời và xóa cờ `archivePromise` để retry nếu DB thất bại | PASS |

### 3.5. HTTP Routes, CORS & Bảo mật ([tests/http-routes.test.js](tests/http-routes.test.js) — 7 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `CORS enforces strict whitelist across APP_URL, CORS_ORIGINS, *.ai.studio, *.run.app and rejects unknown origins` | Trả `Access-Control-Allow-Origin` cho whitelist hợp lệ (kể cả `localhost` & `127.0.0.1`) và không cấp cho origin lạ | PASS |
| `GET /api/server-info and static assets return expected MIME types, Cache-Control, redirects and 404s` | Phục vụ `/api/server-info`, MIME HTML/JS/CSS, header `no-store`/`Cache-Control`, redirect khi truy cập page bảo vệ chưa đăng nhập và `404` cho path traversal/file thiếu | PASS |
| `Storage private GET/POST/DELETE enforce auth, natural code sort and validation` | Bắt buộc auth `401`, sắp xếp tự nhiên theo `code` (`#2` trước `#10`), kiểm tra dữ liệu lưu/xóa | PASS |
| `Storage public /check-share & /share enforce 10% copy similarity guard via server answers` | Từ chối chia sẻ bản copy sửa `< 10%` (`409 COPY_SIMILARITY_TOO_HIGH`) dựa trên đáp án gốc lấy từ DB; cho phép khi chỉnh sửa đủ khác biệt | PASS |
| `Storage public DELETE RBAC & save-to-private isolation` | Chỉ chủ sở hữu hoặc admin mới được xóa đề public; lưu bản copy về kho cá nhân gắn `parentCode` và tăng bộ đếm `copies_issued` | PASS |
| `Rooms HTTP sub-routes enforce host auth, own-PIN restore limit bypass, validation & 404s` | Áp dụng giới hạn tối đa 3 phòng/host (`409`), cho khôi phục PIN cũ không bị chặn hạn mức, chặn non-host `403` trên mọi sub-route điều khiển | PASS |
| `History HTTP routes enforce auth and execute all 4 POST /api/history branches accurately` | Kiểm tra `401` khi thiếu session và chạy đủ 4 nhánh: phòng active (`409`), fallback archived DB, tự chấm điểm solo quiz phía server, và practice mode | PASS |

### 3.6. Trình nhập đề thi ExamImporter ([tests/importer.test.js](tests/importer.test.js) — 11 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `parseVnText rejects empty or whitespace-only input` | Ném/báo lỗi khi nội dung văn bản rỗng hoặc chỉ toàn khoảng trắng | PASS |
| `parseVnText extracts title and subject metadata from header lines` | Trích xuất đúng `title` và `subject` từ phần header đề thi | PASS |
| `parseVnText parses sample Mau_De_Thi_Aiken.txt completely` | Parse thành công toàn bộ file mẫu Aiken đính kèm trong repo | PASS |
| `parseVnText supports mixed prefixes (Bài, Question, Q) and single-choice answer markers` | Nhận diện các tiền tố `Câu`, `Bài`, `Question`, `Q` cùng các dòng đánh dấu `Đáp án:`/`ANSWER:` | PASS |
| `parseVnText parses inline choices and multiple asterisk markers` | Hỗ trợ nhiều đáp án trên cùng 1 dòng và đánh dấu `*` cho cả single lẫn multiple choice | PASS |
| `parseVnText handles multiline questions/choices, trailing answer key tables and drops <2 choices` | Ghép đúng nội dung xuống nhiều dòng, đọc bảng đáp án cuối đề và loại bỏ câu có ít hơn 2 lựa chọn | PASS |
| `parseVnText supports multi-choice via Đáp án: A, B, D and semicolon lists` | Hỗ trợ định dạng nhiều đáp án đúng phân tách bằng dấu phẩy hoặc chấm phẩy | PASS |
| `parseCsv handles comma, semicolon, tab delimiters, quotes, numeric & multi-choice answers` | Tự nhận dấu `,` / `;` / `\t`, xử lý chuỗi trong ngoặc kép chứa dấu phẩy và đáp án số/đa lựa chọn | PASS |
| `parseExcelRows rejects insufficient rows and handles multi-choice answers` | Báo lỗi khi bảng thiếu dòng hợp lệ và parse đúng cột đáp án nhiều lựa chọn | PASS |
| `parseFile parses real sample .xlsx and .docx files cleanly` | Đọc và parse thành công 2 file mẫu `.xlsx` và `.docx` thật trong repo bằng SheetJS & Mammoth | PASS |
| `parseFile handles .json, .txt, malformed JSON, null & unsupported extensions` | Parse `.json`/`.txt`, báo lỗi rõ ràng với JSON hỏng, input `null` hoặc đuôi file không hỗ trợ | PASS |

### 3.7. Logic Frontend & Kiểm tra toàn vẹn HTML ([tests/frontend-logic.test.js](tests/frontend-logic.test.js) — 5 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `MQC_Storage isolates global, user, and room scopes, purges legacy keys, and cleans up scopes` | Cô lập key theo `username` và `pin`, xóa sạch legacy key dùng chung và dọn từng scope không làm ảnh hưởng tài khoản/phòng khác | PASS |
| `MQC_Auth injects Bearer + x-session-token for all header types, tracks login/me/logout, and skips non-API paths` | Tự chèn auth header cho plain object, array pairs và `Headers` instance; bắt token mới ở `/login`, `/register`, `/me`; xóa rỗng ở `/logout` và không gắn vào static path | PASS |
| `room.js multi-choice helpers, clock sync, scoring, ARIA checkboxes, XSS escaping, auto-rejoin & test cleanup` | Kiểm tra multi-choice checkbox (`role="checkbox"`, `aria-checked`), `escapeHtml`, `syncServerClock`, `calcScore`, tự động `/join` lại khi `401 unauthorized`, reset `historySaved` khi lưu lỗi, và dọn `mqc_custom_rooms` trong chế độ `isTest=1` | PASS |
| `create-exam.js search ranking, copy canonicalization/similarity %, and showSimpleConfirm modal + Escape key` | Xếp hạng tìm kiếm tiếng Việt bỏ dấu (`Exact > Prefix > Substring > Multi-token > 0`), chuẩn hóa & tính `%` diff bài copy, và confirm modal xử lý `Escape` trả về `false` | PASS |
| `public/*.html asset references exist on disk and contain required UI DOM IDs without javascript: links` | Kiểm tra 100% đường dẫn nội bộ JS/CSS/link trong tất cả `public/*.html` tồn tại trên đĩa, không chứa `href="javascript:"`, và đủ 7 DOM ID trọng yếu | PASS |

### 3.8. Tải đồng thời & Chống tranh chấp ([tests/concurrency-load.test.js](tests/concurrency-load.test.js) — 4 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `60 concurrent players join, poll endpoints, and submit single + multi-choice answers with zero 5xx and exact aggregation` | 60 thí sinh tham gia phòng `capacity=100`, poll `/state`, `/status`, `/question-stats`, `/leaderboard` và nộp đáp án đơn + đa lựa chọn đồng thời: 0 phản hồi `5xx`, `totalAnswered=60`, giấu `isCorrect` ở HTTP `/answer` nhưng chấm đúng 20/60 câu multi phía server, BXH sắp giảm dần | PASS |
| `20 concurrent duplicate /answer submissions from one player accept only once and mark 19 duplicate:true` | 20 request `/answer` đồng thời từ 1 thí sinh chỉ chấp nhận 1 (`success=true`), 19 request còn lại bị đánh dấu `duplicate: true` và giữ nguyên điểm | PASS |
| `20 concurrent POST /api/history and /api/history/hosted archive hosted session once and save distinct attempt-* rows` | 20 lần lưu player history + 5 lần hosted history đồng thời chỉ gọi `saveHostedGameSession` duy nhất 1 lần qua `archivePromise` và tạo đúng 20 `attempt-*` riêng biệt | PASS |
| `concurrent POST /api/auth/register for same username allows one 200/201 and rejects others cleanly with 409` | 8 request đăng ký trùng username đồng thời cho phép duy nhất 1 thành công và 7 request còn lại trả `409` (0 lỗi `5xx`) | PASS |

### 3.9. Khả năng chống chịu & Stress Benchmark ([tests/resilience-stress.test.js](tests/resilience-stress.test.js) — 7 tests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `Resilience: malformed JSON and >2MB payloads return 400/413 cleanly across all POST endpoints without unhandled rejections` | Gửi JSON sai cú pháp và payload `> 2MB` vào 10 POST endpoints (kể cả 8 room sub-routes): không phát sinh Unhandled Rejection/crash, trả đúng `400` / `413` và server tiếp tục phục vụ bình thường | PASS |
| `Resilience: malformed Cookie URI encoding does not throw URIError or crash endpoints` | Gửi `Cookie: mqc_session=%E0%A4%A; bad=%ZZ` lên `parseCookies`, `/api/rooms/:pin`, `/api/auth/me`, `/index.html`: không throw `URIError`, không trả 5xx | PASS |
| `Resilience: concurrent POST /api/rooms with DB latency strictly enforces MAX_ROOMS_PER_HOST = 3` | Gửi 8 `POST /api/rooms` đồng thời khi DB có độ trễ 30ms: đúng 3 request `200`, 5 request bị chặn `409`, `countActiveRoomsByHost === 3` | PASS |
| `Resilience: abrupt client socket disconnects and Slowloris HTTP timeouts stay bounded and stable` | Kiểm tra `requestTimeout <= 60s`, `headersTimeout <= 30s`, đóng TCP socket đột ngột giữa thân POST body không làm treo hoặc crash server | PASS |
| `Resilience: DB outages degrade cleanly without crashing and recover once DB returns; pool preserves root tx error` | `withTransaction` bảo toàn lỗi query gốc khi `ROLLBACK` cũng lỗi trên socket đứt và luôn `release()` client; HTTP routes trả `500` khi DB đứt và tự phục hồi `200` khi DB trở lại | PASS |
| `Resilience: in-memory rate-limit & session maps enforce bounds and prune expired entries under IP/session flood` | Flood 15.000 IP giả vào `auth` và `gemini`: các Map tự dọn bản ghi hết hạn và bị chặn trần kích thước tối đa `<= 5000` | PASS |
| `Stress benchmark: 3 concurrent rooms x 80 candidates (240 players) + burst polling & login, measuring errors and Event Loop lag` | 240 thí sinh across 3 phòng song song, burst 730 requests (240 `/answer` + 480 `/state` & `/status` + 10 `/api/auth/login` đồng thời với async `scrypt`): hoàn tất trong `542ms`, `p95_el_delay=55.64ms`, `max_el_delay=66.03ms`, 0 lỗi 5xx, ghi nhận đủ 240/240 câu trả lời | PASS |

### 3.10. Tích hợp PostgreSQL thật ([tests/db-integration.test.js](tests/db-integration.test.js) — 1 suite / 5 subtests)

| Tên | Mô tả hành vi và kết quả mong đợi | Kết quả |
|---|---|---|
| `PostgreSQL integration suite (gated by RUN_DB_TESTS=1 + DATABASE_URL)` | Gồm 5 subtests: `runMigration()` idempotent, `withTransaction()` rollback, `saveQuiz()` `v1->v2` multi-choice, `saveAttempt()` + `saveHostedGameSession()` idempotent, AI `documents`/`jobs`/cache roundtrip & tự dọn sạch dữ liệu test | SKIPPED *(cần `RUN_DB_TESTS=1` và PostgreSQL `DATABASE_URL` có thể kết nối)* |

### 3.11. Các kiểm thử gốc có sẵn ([tests/ai.test.js](tests/ai.test.js) — 2 tests, [tests/security.test.js](tests/security.test.js) — 12 tests)

| File & Tên test | Kết quả |
|---|---|
| `ai.test.js` — `ai/gemini helpers: question normalization, stats privacy compression, cache key & rate limit` | PASS |
| `ai.test.js` — `HTTP /api/ai/* enforces teacher/host auth, logs to 2 AI DB tables, and caches weakness summaries` | PASS |
| `security.test.js` — `room binding, token isolation, concurrent archive and failed archive retry` | PASS |
| `security.test.js` — `HTTP CORS, authenticated join, history identity and stable retry` | PASS |
| `security.test.js` — `PG attempts and answers use conflict handling; counter updates only quizzes` | PASS |
| `security.test.js` — `auth initialization errors propagate and startup fails before listen` | PASS |
| `security.test.js` — `player storage has no global reads or persistent token writes` | PASS |
| `security.test.js` — `real Node startup exits on unavailable PostgreSQL` | PASS |
| `security.test.js` — `public quiz omits correct answers and explanations unless explicitly internal` | PASS |
| `security.test.js` — `delayed answer reveal, phase gates, host auth and Origin rejection over HTTP` | PASS |
| `security.test.js` — `question snapshots preserve ranking, repeated opens, late joins and streak resets` | PASS |
| `security.test.js` — `2s server lag grace window, UTC clock metadata, and multiple-choice all-or-nothing lifecycle` | PASS |
| `security.test.js` — `PG multi-choice persistence round-trip and ExamImporter multi-choice parsing` | PASS |
| `security.test.js` — `Public share copy similarity check enforces 10% threshold using full parent answers` | PASS |

---

## 4. Lệnh chạy lại

```bash
npm run lint
npm test

# Chạy thêm 5 subtests PostgreSQL thật khi có DB kết nối được:
# RUN_DB_TESTS=1 DATABASE_URL="postgresql://..." npm test
```
