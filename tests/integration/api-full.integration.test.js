const test = require('node:test');
const assert = require('node:assert/strict');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

async function registerTeacher(baseUrl, username, displayName = `GV ${username}`, password = 'Password123!') {
  const res = await apiRequest(baseUrl, 'POST', '/api/auth/register', {
    body: { username, displayName, password, confirmPassword: password },
  });
  assert.equal(res.status, 200);
  return { cookie: res.cookieHeader, token: res.json.token, user: res.json.user };
}

test('API-01 [Auth & Profile] check-username, Bearer/X-Session-Token auth, đổi tên & mật khẩu kèm cooldown 7 ngày và thu hồi phiên khác', async () => {
  const ctx = await startIsolatedServer();
  try {
    // 1. check-username biên rỗng, ký tự sai, hợp lệ, đã tồn tại
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', '/api/auth/check-username?u=')).status, 400);
    const badCheck = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/check-username?u=a!');
    assert.equal(badCheck.status, 200);
    assert.equal(badCheck.json.valid, false);

    const freeCheck = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/check-username?u=gv_profile');
    assert.equal(freeCheck.json.valid, true);
    assert.equal(freeCheck.json.exists, false);

    const sess1 = await registerTeacher(ctx.baseUrl, 'gv_profile', 'Tên Ban Đầu', 'OldPass123');
    const takenCheck = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/check-username?u=GV_PROFILE');
    assert.equal(takenCheck.json.exists, true);
    assert.equal(takenCheck.json.valid, false);

    // 2. Đăng nhập trên thiết bị thứ 2 (tạo token thứ 2) và kiểm tra xác thực qua Authorization Bearer & X-Session-Token
    const login2 = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/login', {
      body: { username: 'gv_profile', password: 'OldPass123' },
    });
    assert.equal(login2.status, 200);
    const token2 = login2.json.token;

    const meBearer = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${token2}` },
    });
    assert.equal(meBearer.status, 200);
    assert.equal(meBearer.json.authenticated, true);

    const meHeaderTok = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/me', {
      headers: { 'x-session-token': sess1.token },
    });
    assert.equal(meHeaderTok.status, 200);

    // 3. Đổi tên hiển thị lần 1 thành công, đổi lần 2 ngay lập tức bị chặn 429 (cooldown 7 ngày)
    const rename1 = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/change-profile', {
      cookie: sess1.cookie,
      body: { newDisplayName: 'Tên Mới Đã Đổi' },
    });
    assert.equal(rename1.status, 200);
    assert.equal(rename1.json.displayName, 'Tên Mới Đã Đổi');

    const rename2 = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/change-profile', {
      cookie: sess1.cookie,
      body: { newDisplayName: 'Đổi Tiếp Lần 2' },
    });
    assert.equal(rename2.status, 429, 'Đổi tên hiển thị trong thời gian cooldown 7 ngày phải trả HTTP 429');

    // 4. Đổi mật khẩu: sai mật khẩu cũ trả 400; đúng mật khẩu cũ trả 200, thu hồi phiên token2 và chặn đổi tiếp trong 7 ngày
    const wrongOldPass = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/change-profile', {
      cookie: sess1.cookie,
      body: { currentPassword: 'WrongOld', newPassword: 'NewPass456!', confirmNewPassword: 'NewPass456!' },
    });
    assert.equal(wrongOldPass.status, 400);

    const passChanged = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/change-profile', {
      cookie: sess1.cookie,
      body: { currentPassword: 'OldPass123', newPassword: 'NewPass456!', confirmNewPassword: 'NewPass456!' },
    });
    assert.equal(passChanged.status, 200);

    // Phiên hiện tại (sess1) vẫn sống, nhưng phiên thiết bị 2 (token2) phải bị thu hồi (401)
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', '/api/auth/me', { cookie: sess1.cookie })).status, 200);
    assert.equal(
      (await apiRequest(ctx.baseUrl, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token2}` } })).status,
      401,
      'Đổi mật khẩu phải thu hồi toàn bộ phiên đăng nhập trên các thiết bị khác'
    );

    const passCooldown = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/change-profile', {
      cookie: sess1.cookie,
      body: { currentPassword: 'NewPass456!', newPassword: 'AnotherPass789!', confirmNewPassword: 'AnotherPass789!' },
    });
    assert.equal(passCooldown.status, 429, 'Đổi mật khẩu lần 2 trong vòng 7 ngày phải bị chặn HTTP 429');
  } finally {
    await ctx.close();
  }
});

test('API-02 [Public Library & 10% Copy Similarity] Xuất bản công khai, sao chép về kho cá nhân, chặn chia sẻ lại bản sao <10% khác biệt kể cả khi xóa parentCode', async () => {
  const ctx = await startIsolatedServer();
  try {
    const author = await registerTeacher(ctx.baseUrl, 'author_pub');
    const copier = await registerTeacher(ctx.baseUrl, 'copier_pub');

    // 1. Tác giả xuất bản đề công khai
    const shareRes = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/share', {
      cookie: author.cookie,
      body: {
        exam: {
          code: '#orig1',
          title: 'Đề Giải Tích Nâng Cao Cấp Quốc Gia',
          questions: [
            { text: 'Đạo hàm của hàm số x^2 tại x = 3 bằng bao nhiêu?', choices: ['3', '6', '9', '12'], correct: 1, explanation: '2x = 6' },
            { text: 'Tích phân từ 0 đến 1 của 2x dx bằng bao nhiêu?', choices: ['0', '1', '2', '4'], correct: 1, explanation: 'x^2|_0^1 = 1' },
          ],
        },
      },
    });
    assert.equal(shareRes.status, 200);
    const pubExamId = shareRes.json.exam.id;
    assert.equal(shareRes.json.shareCode, '#orig1');

    // 2. Kho công khai ẩn đáp án đúng và lời giải với người xem
    const pubList = await apiRequest(ctx.baseUrl, 'GET', '/api/storage/public');
    assert.equal(pubList.status, 200);
    assert.equal(pubList.json.exams.length, 1);
    assert.equal(pubList.json.exams[0].questions[0].correct, undefined);
    assert.equal(pubList.json.exams[0].questions[0].explanation, '');

    // 3. Giáo viên khác lưu bản sao về kho cá nhân -> tăng copiesIssued và gắn parentCode
    const copyRes = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/save-to-private', {
      cookie: copier.cookie,
      body: { examId: pubExamId },
    });
    assert.equal(copyRes.status, 200);
    const copiedPrivate = copyRes.json.exam;
    assert.equal(copiedPrivate.parentCode, '#orig1');

    // Không cho phép save-to-private một đề riêng tư của người khác
    const privSave = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: author.cookie,
      body: { exam: { title: 'Đề Kín Của Author', questions: [{ text: 'Kín', choices: ['A', 'B'], correct: 0 }] } },
    });
    const stealRes = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/save-to-private', {
      cookie: copier.cookie,
      body: { examId: privSave.json.exam.id },
    });
    assert.equal(stealRes.status, 404, 'Không được sao chép đề riêng tư qua endpoint save-to-private');

    // 4. Cố tình xóa parentCode ở phía client nhưng giữ id bản sao -> server vẫn phát hiện đạo văn (<10% khác biệt) và chặn 409!
    const strippedCopy = { ...copiedPrivate, parentCode: '' };
    const checkShare = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/check-share', {
      cookie: copier.cookie,
      body: { exam: strippedCopy },
    });
    assert.equal(checkShare.status, 200);
    assert.equal(checkShare.json.allowed, false);

    const blockedShare = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/share', {
      cookie: copier.cookie,
      body: { exam: strippedCopy },
    });
    assert.equal(blockedShare.status, 409);
    assert.equal(blockedShare.json.code, 'COPY_SIMILARITY_TOO_HIGH');

    // 5. Biên soạn lại khác biệt hoàn toàn (>10%) -> được phép xuất bản
    const reworked = {
      ...copiedPrivate,
      title: 'Đề Lịch Sử Thế Giới Hiện Đại Thế Kỷ XX',
      questions: [
        { text: 'Liên Hợp Quốc chính thức thành lập vào năm nào sau Thế chiến II?', choices: ['1918', '1945', '1954', '1975'], correct: 1 },
        { text: 'Hiệp hội các quốc gia Đông Nam Á (ASEAN) ra đời tại thành phố nào?', choices: ['Hà Nội', 'Bangkok', 'Jakarta', 'Manila'], correct: 1 },
      ],
    };
    const allowedShare = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/share', {
      cookie: copier.cookie,
      body: { exam: reworked },
    });
    assert.equal(allowedShare.status, 200);
    assert.equal(allowedShare.json.success, true);

    // 6. Phân quyền xóa đề công khai: copier xóa đề của author bị 403; author xóa thành công 200
    assert.equal(
      (await apiRequest(ctx.baseUrl, 'DELETE', `/api/storage/public/${pubExamId}`, { cookie: copier.cookie })).status,
      403
    );
    assert.equal(
      (await apiRequest(ctx.baseUrl, 'DELETE', `/api/storage/public/${pubExamId}`, { cookie: author.cookie })).status,
      200
    );
  } finally {
    await ctx.close();
  }
});

test('API-03 [Room Lifecycle & History All 4 Modes] Vòng đời phòng đầy đủ (/check, /lock, /kick, /result, /exam-stats) và cả 4 nhánh chấm điểm /api/history', async () => {
  const ctx = await startIsolatedServer();
  try {
    const host = await registerTeacher(ctx.baseUrl, 'host_full');
    const student = await registerTeacher(ctx.baseUrl, 'stu_full');
    const stranger = await registerTeacher(ctx.baseUrl, 'stranger_full');

    // Tạo đề trong DB để test tạo phòng bằng examId & chấm Solo Quiz
    const savedQuiz = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: host.cookie,
      body: {
        exam: {
          title: 'Đề Thi Tổng Hợp 2 Câu',
          questions: [
            { id: 'qf1', text: 'Câu đơn: 5 + 5 = ?', choices: ['8', '10', '12', '15'], correct: 1, explanation: '5+5=10' },
            { id: 'qf2', text: 'Câu multi: Số nguyên tố?', choices: ['2', '4', '5', '9'], correctChoices: [0, 2], isMultiple: true },
          ],
        },
      },
    });
    const examId = savedQuiz.json.exam.id;

    // Người lạ không được dùng examId riêng tư của host để mở phòng (403)
    const forbiddenRoom = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: stranger.cookie,
      body: { title: 'Phòng Trộm Đề', examId },
    });
    assert.equal(forbiddenRoom.status, 403);

    // Host mở phòng hợp lệ bằng examId
    const roomRes = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: host.cookie,
      body: { title: 'Phòng Thi Chính Thức', examId, capacity: 2 },
    });
    assert.equal(roomRes.status, 200);
    const pin = roomRes.json.pin;

    // Kiểm tra ?check=1 khi mở vs khi khóa
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}?check=1`)).json.success, true);
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/lock`, { cookie: host.cookie, body: { isLocked: true } });
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}?check=1`)).json.locked, true);
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/lock`, { cookie: host.cookie, body: { isLocked: false } });

    // Student (đăng nhập) & Guest 2 tham gia; Guest bị kick
    const pStu = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/join`, {
      cookie: student.cookie,
      body: { nick: 'Học Sinh A', av: '04' },
    });
    const pKick = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/join`, {
      body: { nick: 'Người Lạ Bị Kick' },
    });
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}?check=1`)).json.full, true);

    // Non-host không được kick (403), Host kick thành công (200)
    assert.equal(
      (await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/kick`, { cookie: stranger.cookie, body: { playerId: pKick.json.player.id } })).status,
      403
    );
    assert.equal(
      (await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/kick`, { cookie: host.cookie, body: { playerId: pKick.json.player.id } })).status,
      200
    );

    // Bắt đầu câu 0 -> kiểm tra /result và /exam-stats bị chặn 403 với khách khi đang làm bài
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/advance`, { cookie: host.cookie, body: { nextQ: 0, phase: 'question' } });
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}/result?q=0`)).status, 403);
    assert.equal((await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}/exam-stats`)).status, 403);

    // Chưa tới câu cuối và chưa kết thúc -> nộp /api/history sớm bị chặn 409
    const prematureHist = await apiRequest(ctx.baseUrl, 'POST', '/api/history', {
      cookie: student.cookie,
      body: { pin, playerId: pStu.json.player.id, playerToken: pStu.json.player.playerToken },
    });
    assert.equal(prematureHist.status, 409);

    // Nộp câu 0 đúng -> mở phase result -> kiểm tra /result với token đúng & token sai
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
      body: { playerId: pStu.json.player.id, playerToken: pStu.json.player.playerToken, qIdx: 0, choice: 1 },
    });
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/advance`, { cookie: host.cookie, body: { nextQ: 0, phase: 'result' } });

    const resWrongTok = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}/result?q=0&playerId=${pStu.json.player.id}`, {
      headers: { 'x-player-token': 'forged-token' },
    });
    assert.equal(resWrongTok.status, 403);

    const resOkTok = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}/result?q=0&playerId=${pStu.json.player.id}`, {
      headers: { 'x-player-token': pStu.json.player.playerToken },
    });
    assert.equal(resOkTok.status, 200);
    assert.equal(resOkTok.json.correctChoice, 1);
    assert.equal(resOkTok.json.playerResult.isCorrect, true);

    // Chuyển câu 1 (multi-choice) -> nộp [2, 0] -> kết thúc phòng
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/advance`, { cookie: host.cookie, body: { nextQ: 1, phase: 'question' } });
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
      body: { playerId: pStu.json.player.id, playerToken: pStu.json.player.playerToken, qIdx: 1, choices: [2, 0] },
    });

    // Nhánh 1 của /api/history: Active Room (bác bỏ điểm giả mạo 999999 từ client!)
    const histLive = await apiRequest(ctx.baseUrl, 'POST', '/api/history', {
      cookie: student.cookie,
      body: { pin, playerId: pStu.json.player.id, playerToken: pStu.json.player.playerToken, score: 999999 },
    });
    assert.equal(histLive.status, 200);
    assert.ok(histLive.json.historyItem.score > 0 && histLive.json.historyItem.score < 1000, 'Phải lấy điểm thật từ server thay vì điểm 999999 client gửi');
    assert.equal(histLive.json.historyItem.correctCount, 2);

    // Xóa phòng khỏi RAM qua DELETE /api/rooms/:pin -> kiểm tra Nhánh 2 của /api/history (đọc lại từ game_sessions SQLite JSON stats!)
    const delRoom = await apiRequest(ctx.baseUrl, 'DELETE', `/api/rooms/${pin}`, { cookie: host.cookie });
    assert.equal(delRoom.status, 200);

    const histArchived = await apiRequest(ctx.baseUrl, 'POST', '/api/history', {
      cookie: student.cookie,
      body: { pin, playerId: pStu.json.player.id, nick: 'Học Sinh A' },
    });
    assert.equal(histArchived.status, 200);
    assert.equal(histArchived.json.historyItem.correctCount, 2, 'Phải khôi phục đúng kết quả từ game_sessions JSON khi phòng đã xóa khỏi RAM');

    // Nhánh 3 của /api/history: Solo Quiz từ DB (tự chấm lại đáp án bất kể score client gửi)
    await apiRequest(ctx.baseUrl, 'POST', '/api/storage/public/share', {
      cookie: host.cookie,
      body: {
        exam: {
          code: '#solo99',
          title: 'Đề Tự Luyện Công Khai',
          questions: [
            { text: '10 / 2 = ?', choices: ['2', '5', '8'], correct: 1, points: 150 },
            { text: 'Chọn chẵn', choices: ['2', '3', '4'], correctChoices: [0, 2], points: 200 },
          ],
        },
      },
    });
    const pubSolo = (await apiRequest(ctx.baseUrl, 'GET', '/api/storage/public')).json.exams[0];
    const histSolo = await apiRequest(ctx.baseUrl, 'POST', '/api/history', {
      cookie: student.cookie,
      body: {
        quizId: pubSolo.id,
        score: 999999,
        details: [{ userChoice: 1 }, { userChoices: [0] }], // Câu 1 đúng (150đ), Câu 2 thiếu đáp án -> sai (0đ)
      },
    });
    assert.equal(histSolo.status, 200);
    assert.equal(histSolo.json.historyItem.score, 150);
    assert.equal(histSolo.json.historyItem.correctCount, 1);

    // Nhánh 4 của /api/history: Bài luyện tập tự do KHÔNG truyền correctCount & accuracyPct (Regression fix NaN !== undefined!)
    const histPractice = await apiRequest(ctx.baseUrl, 'POST', '/api/history', {
      cookie: student.cookie,
      body: {
        roomTitle: 'Luyện tập nhanh',
        details: [
          { questionText: 'Q1', choices: ['A', 'B'], correctChoice: 0, userChoice: 0, isCorrect: true, earned: 100 },
          { questionText: 'Q2', choices: ['A', 'B'], correctChoice: 1, userChoice: 0, isCorrect: false, earned: 0 },
        ],
      },
    });
    assert.equal(histPractice.status, 200);
    assert.equal(histPractice.json.historyItem.correctCount, 1, 'correctCount không được bị biến thành NaN/null');
    assert.equal(histPractice.json.historyItem.accuracyPct, 50, 'accuracyPct không được bị biến thành NaN/null');

    // Khách chưa đăng nhập gửi dữ liệu giả mạo không có phòng/quiz thật bị từ chối 400
    const unauthFakeHist = await apiRequest(ctx.baseUrl, 'POST', '/api/history', {
      body: { roomTitle: 'Fake', details: [{ isCorrect: true, earned: 500 }] },
    });
    assert.equal(unauthFakeHist.status, 400);

    // Kiểm tra đọc lại toàn bộ lịch sử của student và hosted rooms của host
    const stuHistory = await apiRequest(ctx.baseUrl, 'GET', '/api/history', { cookie: student.cookie });
    assert.equal(stuHistory.status, 200);
    assert.ok(stuHistory.json.history.length >= 3);

    const hostedHistory = await apiRequest(ctx.baseUrl, 'GET', '/api/history/hosted', { cookie: host.cookie });
    assert.equal(hostedHistory.status, 200);
    assert.equal(hostedHistory.json.rooms.length, 1);
  } finally {
    await ctx.close();
  }
});

test('API-04 [AI Endpoints + SQLite Audit & Cache + Protected Pages] Kiểm thử toàn diện /api/ai/*, phân quyền student/host và trang bảo vệ', async () => {
  let aiCallCount = 0;
  const ctx = await startIsolatedServer({
    aiClientFactory: async () => ({
      sdk: { Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY', INTEGER: 'INTEGER', NUMBER: 'NUMBER' } },
      ai: {
        models: {
          async generateContent({ contents }) {
            aiCallCount++;
            if (String(contents).includes('Phân tích điểm yếu')) {
              return {
                text: JSON.stringify({
                  overallSummary: 'Lớp còn nhầm khái niệm HTTP Status.',
                  weakQuestions: [{ qIdx: 1, topicOrSkill: 'HTTP 401 vs 403', accuracyPct: 20, likelyMistake: 'Nhầm xác thực với phân quyền' }],
                  teachingActions: ['So sánh ví dụ thực tế 401 và 403'],
                }),
              };
            }
            return {
              text: JSON.stringify({
                suggestedTitle: 'Đề Mạng Máy Tính AI',
                suggestedSubject: 'CNTT',
                questions: [
                  { text: 'HTTP chạy ở tầng nào?', choices: ['Ứng dụng', 'Giao vận', 'Mạng', 'Vật lý'], correctIndices: [0] },
                ],
              }),
            };
          },
        },
      },
    }),
  });

  try {
    const teacher = await registerTeacher(ctx.baseUrl, 'teacher_ai');
    const otherTeacher = await registerTeacher(ctx.baseUrl, 'other_ai');
    const studentAcc = await registerTeacher(ctx.baseUrl, 'student_ai');
    // Hạ quyền student_ai xuống role = 'student' trong cả SQLite và bộ nhớ auth
    await ctx.sqlitePool.query(`UPDATE profiles SET role = 'student' WHERE username = $1`, ['student_ai']);
    ctx.auth.upsertUser({ ...ctx.auth.findUserByUsernameSync('student_ai'), role: 'student' });

    // 1. Chưa đăng nhập (401) & tài khoản student (403) & chủ đề quá ngắn (400)
    assert.equal((await apiRequest(ctx.baseUrl, 'POST', '/api/ai/generate-questions', { body: { topic: 'Toán' } })).status, 401);
    assert.equal((await apiRequest(ctx.baseUrl, 'POST', '/api/ai/generate-questions', { cookie: studentAcc.cookie, body: { topic: 'Toán' } })).status, 403);
    assert.equal((await apiRequest(ctx.baseUrl, 'POST', '/api/ai/generate-questions', { cookie: teacher.cookie, body: { topic: 'A' } })).status, 400);

    // 2. Tạo câu hỏi AI thành công -> lưu cả documents và ai_generation_jobs (completed) trong SQLite
    const genRes = await apiRequest(ctx.baseUrl, 'POST', '/api/ai/generate-questions', {
      cookie: teacher.cookie,
      body: { topic: 'Giao thức HTTP', gradeOrLevel: 'Đại học', count: 3, questionType: 'single' },
    });
    assert.equal(genRes.status, 200);
    assert.equal(genRes.json.questions.length, 1);

    const jobRows = await ctx.sqlitePool.query(`SELECT status FROM ai_generation_jobs WHERE user_id = 'teacher_ai'`);
    assert.equal(jobRows.rows.length, 1);
    assert.equal(jobRows.rows[0].status, 'completed');

    // 3. Phân tích điểm yếu phòng thi: chặn giáo viên khác phân tích phòng của teacher_ai (403), và phục vụ từ cache ở lần gọi thứ 2!
    const room = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: teacher.cookie,
      body: { title: 'Phòng AI', questions: [{ text: '401 vs 403?', choices: ['A', 'B'], correct: 0 }] },
    });
    const pin = room.json.pin;

    const foreignAnalyze = await apiRequest(ctx.baseUrl, 'POST', '/api/ai/analyze-weakness', {
      cookie: otherTeacher.cookie,
      body: { pin },
    });
    assert.equal(foreignAnalyze.status, 403);

    const callsBefore = aiCallCount;
    const analyze1 = await apiRequest(ctx.baseUrl, 'POST', '/api/ai/analyze-weakness', {
      cookie: teacher.cookie,
      body: { pin },
    });
    assert.equal(analyze1.status, 200);
    assert.equal(analyze1.json.cached, false);
    assert.equal(aiCallCount, callsBefore + 1);

    const analyze2 = await apiRequest(ctx.baseUrl, 'POST', '/api/ai/analyze-weakness', {
      cookie: teacher.cookie,
      body: { pin },
    });
    assert.equal(analyze2.status, 200);
    assert.equal(analyze2.json.cached, true);
    assert.equal(aiCallCount, callsBefore + 1, 'Lần phân tích thứ 2 cùng dữ liệu phải lấy từ cache, không gọi lại Gemini');

    // 4. Kiểm tra /api/server-info, chuyển hướng /pin=... và chặn trang quản trị khi chưa đăng nhập
    const info = await apiRequest(ctx.baseUrl, 'GET', '/api/server-info');
    assert.equal(info.status, 200);
    assert.equal(info.json.success, true);

    const pinRedirect = await apiRequest(ctx.baseUrl, 'GET', '/pin/123-456', { redirect: 'manual' });
    assert.equal(pinRedirect.status, 302);
    assert.match(pinRedirect.headers.get('location') || '', /\/index\.html\?pin=123-456/);

    for (const protectedPage of ['/dashboard.html', '/create-exam.html', '/create-room.html']) {
      const unauthPage = await apiRequest(ctx.baseUrl, 'GET', protectedPage, { redirect: 'manual' });
      assert.equal(unauthPage.status, 302, `Trang ${protectedPage} phải redirect 302 khi chưa đăng nhập`);
      const authPage = await apiRequest(ctx.baseUrl, 'GET', protectedPage, { cookie: teacher.cookie, redirect: 'manual' });
      assert.equal(authPage.status, 200, `Trang ${protectedPage} phải trả 200 khi đã đăng nhập`);
    }
  } finally {
    await ctx.close();
  }
});
