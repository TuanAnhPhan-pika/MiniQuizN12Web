const test = require('node:test');
const assert = require('node:assert/strict');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

test('CONC-01 [Concurrency][Auth & Room Limits] Đua tranh đăng ký trùng username (15 luồng) & đua tranh tạo phòng vượt MAX_ROOMS_PER_HOST (10 luồng)', async () => {
  const ctx = await startIsolatedServer();
  try {
    // 1. 15 request POST /api/auth/register đồng thời cho cùng một tài khoản 'race_teacher'
    const regBurst = await Promise.all(
      Array.from({ length: 15 }, (_, idx) =>
        apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
          headers: { 'X-Forwarded-For': `10.99.0.${idx + 1}` },
          body: {
            username: idx % 2 === 0 ? 'race_teacher' : 'RACE_TEACHER',
            displayName: `Race ${idx}`,
            password: 'Password123!',
            confirmPassword: 'Password123!',
          },
        })
      )
    );

    const okRegs = regBurst.filter(r => r.status === 200);
    const conflictRegs = regBurst.filter(r => r.status === 409);
    assert.equal(okRegs.length, 1, 'Chỉ đúng 1 luồng đăng ký được phép thành công (HTTP 200)');
    assert.equal(conflictRegs.length, 14, '14 luồng đua tranh còn lại phải trả đúng HTTP 409 mà không gây lỗi 500');

    const dbUserCnt = await ctx.sqlitePool.query(`SELECT COUNT(*) AS cnt FROM users WHERE username_lower = 'race_teacher'`);
    assert.equal(Number(dbUserCnt.rows[0].cnt), 1);

    // 2. 10 request POST /api/rooms đồng thời từ cùng một Host -> withHostRoomCreateLock chỉ cho phép tối đa 3 phòng
    const hostCookie = okRegs[0].cookieHeader;
    const roomBurst = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
          cookie: hostCookie,
          body: {
            title: `Phòng Đua Tranh #${idx + 1}`,
            capacity: 20,
            questions: [{ text: 'Q1', choices: ['A', 'B'], correct: 0 }],
          },
        })
      )
    );

    const createdRooms = roomBurst.filter(r => r.status === 200);
    const rejectedRooms = roomBurst.filter(r => r.status === 409);
    assert.equal(createdRooms.length, 3, 'Chỉ đúng 3 phòng được phép tạo (MAX_ROOMS_PER_HOST = 3)');
    assert.equal(rejectedRooms.length, 7, '7 request vượt ngưỡng đồng thời phải trả HTTP 409');
  } finally {
    await ctx.close();
  }
});

test('CONC-02 [Concurrency][Capacity, Anti-Duplicate Answer & Idempotent Archive] 25 thí sinh đua vào phòng 10 chỗ, 20 lần nộp trùng 1 câu và đua lưu trữ phòng', async () => {
  const ctx = await startIsolatedServer();
  try {
    const host = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: { username: 'host_conc2', displayName: 'Host Conc', password: 'Password123!', confirmPassword: 'Password123!' },
    });
    const hostCookie = host.cookieHeader;

    const roomRes = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: hostCookie,
      body: {
        title: 'Phòng Chịu Tải Đồng Thời',
        capacity: 10,
        questions: [{ text: '3 * 7 = ?', choices: ['14', '21', '28', '35'], correct: 1, points: 100, timeLimit: 30 }],
      },
    });
    const pin = roomRes.json.pin;

    // 1. 25 thí sinh gửi /join đồng thời vào phòng sức chứa 10
    const joinBurst = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/join`, {
          body: { nick: `ThiSinh_${i + 1}`, av: '03' },
        })
      )
    );
    const admitted = joinBurst.filter(r => r.json && r.json.success === true);
    const fullRejected = joinBurst.filter(r => r.json && r.json.full === true);
    assert.equal(admitted.length, 10, 'Đúng 10 thí sinh được vào phòng');
    assert.equal(fullRejected.length, 15, '15 thí sinh vượt sức chứa phải nhận cờ full: true');

    // Tất cả 10 token được cấp phải hoàn toàn phân biệt
    const tokenSet = new Set(admitted.map(r => r.json.player.playerToken));
    assert.equal(tokenSet.size, 10);

    // 2. Mở câu hỏi 0 -> Thí sinh đầu tiên bắn 20 request nộp bài trùng lặp cùng lúc, 9 thí sinh còn lại nộp đồng thời
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/advance`, {
      cookie: hostCookie,
      body: { nextQ: 0, phase: 'question' },
    });

    const p0 = admitted[0].json.player;
    const dupAnswerBurst = await Promise.all(
      Array.from({ length: 20 }, () =>
        apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
          body: { playerId: p0.id, playerToken: p0.playerToken, qIdx: 0, choice: 1 },
        })
      )
    );
    const acceptedCount = dupAnswerBurst.filter(r => r.json.answerAccepted === true).length;
    const duplicateCount = dupAnswerBurst.filter(r => r.json.duplicate === true).length;
    assert.equal(acceptedCount, 1, 'Chỉ chấp nhận đúng 1 lần nộp bài đầu tiên');
    assert.equal(duplicateCount, 19, '19 request trùng lặp đồng thời phải bị gắn cờ duplicate: true');

    await Promise.all(
      admitted.slice(1).map((r, idx) =>
        apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
          body: {
            playerId: r.json.player.id,
            playerToken: r.json.player.playerToken,
            qIdx: 0,
            choice: idx % 2 === 0 ? 1 : 0,
          },
        })
      )
    );

    const qStats = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}/question-stats?q=0`);
    assert.equal(qStats.json.totalAnswered, 10);
    assert.equal(qStats.json.allAnswered, true);

    // 3. 8 request kết thúc & lưu trữ phòng đồng thời (/api/history/hosted) -> chỉ ghi 1 phiên duy nhất vào game_sessions & 10 dòng game_players
    const archiveBurst = await Promise.all(
      Array.from({ length: 8 }, () =>
        apiRequest(ctx.baseUrl, 'POST', '/api/history/hosted', {
          cookie: hostCookie,
          body: { pin },
        })
      )
    );
    assert.ok(archiveBurst.every(r => r.status === 200 && r.json.success === true));

    const sessCount = await ctx.sqlitePool.query('SELECT COUNT(*) AS cnt FROM game_sessions WHERE room_code = $1', [pin]);
    const gpCount = await ctx.sqlitePool.query('SELECT COUNT(*) AS cnt FROM game_players');
    assert.equal(Number(sessCount.rows[0].cnt), 1, 'Không được nhân bản bản ghi game_sessions khi lưu trữ đồng thời');
    assert.equal(Number(gpCount.rows[0].cnt), 10, 'Phải lưu đúng 10 thí sinh vào bảng game_players');
  } finally {
    await ctx.close();
  }
});
