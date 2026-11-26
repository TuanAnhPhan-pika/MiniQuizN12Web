const test = require('node:test');
const assert = require('node:assert/strict');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

const ROOM_QUESTIONS = [
  {
    id: 'q-int-1',
    text: 'Thủ đô của Việt Nam là gì?',
    choices: ['Đà Nẵng', 'Hà Nội', 'Huế', 'Cần Thơ'],
    correct: 1,
    points: 100,
    timeLimit: 20,
  },
];

async function registerAndGetCookie(baseUrl, username) {
  const res = await apiRequest(baseUrl, 'POST', '/api/auth/register', {
    body: {
      username,
      displayName: `Host ${username}`,
      password: 'Password123',
      confirmPassword: 'Password123',
    },
  });
  assert.equal(res.status, 200);
  return res.cookieHeader;
}

test('TC-10 [Integration][Phân vùng tương đương] Luồng tạo phòng, tham gia (ẩn đáp án/token), bắt đầu, nộp bài và xem bảng xếp hạng', async () => {
  const ctx = await startIsolatedServer();
  try {
    const hostCookie = await registerAndGetCookie(ctx.baseUrl, 'host_01');

    // 1. Tạo phòng
    const created = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: hostCookie,
      body: {
        title: 'Kiểm tra Địa lý',
        capacity: 10,
        questions: ROOM_QUESTIONS,
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.success, true);
    assert.match(created.json.pin, /^\d{3}-\d{3}$/, 'Mã PIN phải đúng định dạng XXX-XXX');
    const pin = created.json.pin;

    // 2. Thí sinh tham gia
    const joined = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/join`, {
      body: { nick: 'Minh', av: '02' },
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.json.success, true);
    assert.ok(joined.json.player.playerToken);

    // 3. Khách xem thông tin phòng không được lộ đáp án đúng hoặc playerToken
    const guestRoom = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}`);
    assert.equal(guestRoom.status, 200);
    assert.equal(guestRoom.json.room.questions[0].correct, undefined, 'Khách không được thấy đáp án đúng');
    assert.equal(guestRoom.json.room.players[0].playerToken, undefined, 'Danh sách phòng không được lộ playerToken');

    // 4. Host bắt đầu phòng thi
    const started = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/start`, {
      cookie: hostCookie,
      body: { countdownSec: 1 },
    });
    assert.equal(started.status, 200);
    assert.equal(started.json.success, true);

    // 5. Thí sinh nộp đáp án đúng (choice = 1)
    const answered = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
      body: {
        playerId: joined.json.player.id,
        playerToken: joined.json.player.playerToken,
        qIdx: 0,
        choice: 1,
      },
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.json.success, true);
    assert.equal(answered.json.answerAccepted, true);

    // 6. Host chuyển sang phase 'result' rồi kiểm tra bảng xếp hạng
    const showRes = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/advance`, {
      cookie: hostCookie,
      body: { nextQ: 0, phase: 'result' },
    });
    assert.equal(showRes.status, 200);

    const lb = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}/leaderboard`);
    assert.equal(lb.status, 200);
    assert.equal(lb.json.leaderboard[0].nick, 'Minh');
    assert.ok(lb.json.leaderboard[0].score > 0, 'Bảng xếp hạng phải ghi nhận điểm > 0 cho Minh');
  } finally {
    await ctx.close();
  }
});

test('TC-11 [Integration][Chuyển trạng thái] Từ chối nộp bài khi phòng vẫn đang ở trạng thái waiting (Host chưa bấm bắt đầu)', async () => {
  const ctx = await startIsolatedServer();
  try {
    const hostCookie = await registerAndGetCookie(ctx.baseUrl, 'host_wait');

    const created = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: hostCookie,
      body: {
        title: 'Phòng đang chờ',
        capacity: 5,
        questions: ROOM_QUESTIONS,
      },
    });
    const pin = created.json.pin;

    const joined = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/join`, {
      body: { nick: 'Lan' },
    });

    // KHÔNG gọi /start: phòng vẫn đang ở trạng thái 'waiting'
    const earlyAnswer = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
      body: {
        playerId: joined.json.player.id,
        playerToken: joined.json.player.playerToken,
        qIdx: 0,
        choice: 1,
      },
    });

    assert.equal(
      earlyAnswer.json.success,
      false,
      'BUG-03: Thí sinh nộp câu 0 khi phòng còn waiting nhưng server vẫn chấp nhận và tự đổi trạng thái phòng sang started'
    );
    assert.equal(earlyAnswer.json.rejected, true);
    assert.equal(ctx.roomsManager.getRawRoom(pin).status, 'waiting');
  } finally {
    await ctx.close();
  }
});

test('TC-23 [Integration][Giá trị biên] Host tạo tối đa 3 phòng hoạt động (MAX_ROOMS_PER_HOST = 3), phòng thứ 4 bị chặn 409', async () => {
  const ctx = await startIsolatedServer();
  try {
    const hostCookie = await registerAndGetCookie(ctx.baseUrl, 'host_limit');

    for (let i = 1; i <= 3; i++) {
      const res = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
        cookie: hostCookie,
        body: { title: `Phòng số ${i}`, capacity: 10, questions: ROOM_QUESTIONS },
      });
      assert.equal(res.status, 200, `Phòng thứ ${i} (<= 3) phải tạo thành công`);
      assert.equal(res.json.success, true);
    }

    const fourth = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: hostCookie,
      body: { title: 'Phòng thứ 4 vượt giới hạn', capacity: 10, questions: ROOM_QUESTIONS },
    });
    assert.equal(fourth.status, 409, 'Tạo phòng thứ 4 vượt MAX_ROOMS_PER_HOST phải trả HTTP 409');
    assert.equal(fourth.json.success, false);
  } finally {
    await ctx.close();
  }
});
