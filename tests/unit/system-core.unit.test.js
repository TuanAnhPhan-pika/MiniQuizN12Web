const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIsolatedModule } = require('../helpers/test-server.js');

function createIsolatedAuth({ dbOverrides = {}, clock = null } = {}) {
  const realDateNow = Date.now;
  const noopDb = {
    useSupabase: () => false,
    findUserByUsername: async () => null,
    createUser: async u => ({ id: 1, usernameLower: u.username.toLowerCase(), ...u }),
    updateUser: async (u, patch) => ({ id: 1, username: u, usernameLower: u.toLowerCase(), displayName: patch.displayName || u, ...patch }),
    saveSession: async () => {},
    deleteSession: async () => {},
    deleteOtherSessions: async () => {},
    ...dbOverrides,
  };
  const extraTail = clock
    ? `\nDate.now = () => globalThis.__testClock.now;`
    : '';
  const mod = loadIsolatedModule('src/auth.js', {
    './db/index.js': noopDb,
    './db/pool.js': { query: async () => ({ rows: [] }) },
  }, extraTail);
  if (clock) {
    // Inject clock into module's globalThis via closure if needed
  }
  void realDateNow;
  return mod;
}

function loadWithClock(relPath, overrides = {}, initialNow = 1_750_000_000_000) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const projectRoot = path.resolve(__dirname, '..', '..');
  const filename = path.join(projectRoot, relPath);
  const localRequire = createRequire(filename);
  const clock = { now: initialNow };

  class MockDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() {
      return clock.now;
    }
  }

  const context = {
    require(spec) {
      if (Object.hasOwn(overrides, spec)) return overrides[spec];
      return localRequire(spec);
    },
    module: { exports: {} },
    exports: {},
    __filename: filename,
    __dirname: path.dirname(filename),
    Date: MockDate,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process: {
      ...process,
      env: { ...process.env, DATA_BACKEND: 'pg', ALLOW_OFFLINE_MODE: 'true' },
      exit(code) { throw new Error(`process.exit(${code})`); },
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
  };
  context.exports = context.module.exports;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { mod: context.module.exports, clock };
}

test('SYS-U01 [Auth][Type Confusion] validateUsername, validateDisplayName, validatePassword chống đầu vào phi chuỗi', () => {
  const auth = createIsolatedAuth();

  for (const bad of [null, undefined, 123456, true, false, ['abc'], { length: 10 }, {}]) {
    assert.equal(typeof auth.validateUsername(bad), 'string', `validateUsername phải chặn ${ JSON.stringify(bad) }`);
    assert.equal(typeof auth.validateDisplayName(bad), 'string', `validateDisplayName phải chặn ${ JSON.stringify(bad) }`);
    assert.equal(typeof auth.validatePassword(bad), 'string', `validatePassword phải chặn ${ JSON.stringify(bad) }`);
  }

  // Ký tự đặc biệt / khoảng trắng / SQL / HTML trong username phải bị từ chối
  for (const badUser of ['ab', 'a'.repeat(21), 'user name', 'user@1', 'admin;--', '<script>', 'tiếngviệt']) {
    assert.equal(typeof auth.validateUsername(badUser), 'string');
  }
  assert.equal(auth.validateUsername('Teacher_01'), null);

  // DisplayName hỗ trợ tiếng Việt có dấu nhưng chặn rỗng/quá 30 ký tự
  assert.equal(auth.validateDisplayName('Nguyễn Văn Ánh'), null);
  assert.equal(typeof auth.validateDisplayName('\t\n  '), 'string');
  assert.equal(typeof auth.validateDisplayName('Đ'.repeat(31)), 'string');

  // Password chặn chuỗi chỉ chứa khoảng trắng, thiếu 6 ký tự thực sau trim, hoặc quá 128 ký tự
  assert.equal(typeof auth.validatePassword(' \t\n   '), 'string');
  assert.equal(typeof auth.validatePassword('  a1  '), 'string', 'Mật khẩu chỉ có 2 ký tự thực sau trim phải bị từ chối');
  assert.equal(typeof auth.validatePassword('     a'), 'string', 'Mật khẩu chỉ có 1 ký tự thực sau trim phải bị từ chối');
  assert.equal(typeof auth.validatePassword('a'.repeat(129)), 'string', 'Mật khẩu > 128 ký tự phải bị từ chối');
  assert.equal(auth.validatePassword('  abc123  '), null, 'Mật khẩu >= 6 ký tự thực sau trim và <= 128 ký tự phải hợp lệ');
  assert.equal(auth.validatePassword('a'.repeat(128)), null, 'Mật khẩu đúng biên trên 128 ký tự phải hợp lệ');
});

test('SYS-U02 [Auth][Crypto] hashPasswordAsync & verifyPasswordAsync tương thích chéo và an toàn khi hash sai độ dài', async () => {
  const auth = createIsolatedAuth();
  const asyncHash = await auth.hashPasswordAsync('MyStrongPass#2026');
  const syncHash = auth.hashPassword('MyStrongPass#2026');

  assert.equal(auth.verifyPassword('MyStrongPass#2026', asyncHash.salt, asyncHash.hash), true);
  assert.equal(await auth.verifyPasswordAsync('MyStrongPass#2026', syncHash.salt, syncHash.hash), true);
  assert.equal(await auth.verifyPasswordAsync('WrongPass', asyncHash.salt, asyncHash.hash), false);

  // Hash hex bị cắt ngắn hoặc rỗng không được ném RangeError từ timingSafeEqual
  assert.equal(auth.verifyPassword('MyStrongPass#2026', asyncHash.salt, 'abcd'), false);
  assert.equal(await auth.verifyPasswordAsync('MyStrongPass#2026', asyncHash.salt, ''), false);
});

test('SYS-U03 [Auth][Rate-Limit & Lockout] Lũy thừa khóa đăng nhập (15s -> cap 24h), cửa sổ 24h, và giới hạn 50 đăng ký/giờ', () => {
  const { mod: auth, clock } = loadWithClock('src/auth.js', {
    './db/index.js': { useSupabase: () => false, saveSession: async () => {}, deleteSession: async () => {} },
    './db/pool.js': { query: async () => ({ rows: [] }) },
  });

  const ip = '203.0.113.7';
  for (let i = 1; i <= 12; i++) {
    const r = auth.recordLoginFailure(ip);
    assert.equal(r.warning, null);
    assert.equal(r.locked, false);
  }
  // Lần 13, 14, 15 cảnh báo số lần còn lại (2, 1, 0)
  assert.match(auth.recordLoginFailure(ip).warning, /Còn 2 lần/);
  assert.match(auth.recordLoginFailure(ip).warning, /Còn 1 lần/);
  assert.match(auth.recordLoginFailure(ip).warning, /Còn 0 lần/);
  assert.equal(auth.checkLoginLock(ip).locked, false);

  // Lần 16 -> khóa 15s; lần 17 -> 30s; lần 18 -> 60s
  const f16 = auth.recordLoginFailure(ip);
  assert.equal(f16.locked, true);
  assert.equal(f16.waitSeconds, 15);
  assert.equal(auth.recordLoginFailure(ip).waitSeconds, 30);
  assert.equal(auth.recordLoginFailure(ip).waitSeconds, 60);

  // Tăng nhiều lần không bao giờ vượt trần 24h (86400s)
  for (let i = 0; i < 30; i++) auth.recordLoginFailure(ip);
  assert.equal(auth.checkLoginLock(ip).waitSeconds, 86400);

  // Qua cửa sổ 24h + 1ms -> tự mở khóa
  clock.now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(auth.checkLoginLock(ip).locked, false);

  // Kiểm tra giới hạn 50 lượt đăng ký / giờ / IP
  const regIp = '198.51.100.22';
  for (let i = 0; i < 50; i++) {
    assert.equal(auth.checkRegisterLimit(regIp).allowed, true);
    auth.recordRegister(regIp);
  }
  const blockedReg = auth.checkRegisterLimit(regIp);
  assert.equal(blockedReg.allowed, false);
  assert.ok(blockedReg.retryAt > clock.now);

  // Sau 60 phút + 1ms -> đăng ký lại được
  clock.now += 60 * 60 * 1000 + 1;
  assert.equal(auth.checkRegisterLimit(regIp).allowed, true);
});

test('SYS-U04 [Auth][Sessions & Cookies] TTL phiên 7 ngày, thu hồi phiên khác khi đổi mật khẩu, parseCookies & cooldown', async () => {
  const deletedOthers = [];
  const { mod: auth, clock } = loadWithClock('src/auth.js', {
    './db/index.js': {
      useSupabase: () => false,
      saveSession: async () => {},
      deleteSession: async () => {},
      deleteOtherSessions: async (u, tok) => { deletedOthers.push([u, tok]); },
    },
    './db/pool.js': { query: async () => ({ rows: [] }) },
  });

  const t1 = await auth.createSessionPersisted('TeacherA');
  const t2 = auth.createSession('teachera');
  const tOther = auth.createSession('TeacherB');

  assert.ok(auth.getSession(t1));
  assert.ok(auth.getSession(t2));

  // Thu hồi mọi phiên khác của TeacherA (không phân biệt hoa/thường), giữ nguyên t1 và TeacherB
  auth.deleteOtherSessions('TEACHERA', t1);
  assert.ok(auth.getSession(t1));
  assert.equal(auth.getSession(t2), null);
  assert.ok(auth.getSession(tOther));
  assert.equal(deletedOthers.length, 1);

  // Không crash nếu gọi deleteOtherSessions với null/undefined
  assert.doesNotThrow(() => auth.deleteOtherSessions(null, t1));

  // Hết hạn sau 7 ngày + 1ms
  clock.now += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(auth.getSession(t1), null);

  // parseCookies xử lý dấu '=' trong giá trị và chuỗi URI lỗi mà không throw URIError
  const cookies = auth.parseCookies('mqc_session=tok=123==; bad=%E0%A4%A; empty=; =nokey; theme=dark%20mode');
  assert.equal(cookies.mqc_session, 'tok=123==');
  assert.equal(cookies.bad, '%E0%A4%A');
  assert.equal(cookies.theme, 'dark mode');

  // Header cookie bảo mật HTTPS vs HTTP
  assert.match(auth.sessionCookieHeader('abc', true), /SameSite=None; Secure; Partitioned/);
  assert.match(auth.sessionCookieHeader('abc', false), /SameSite=Lax/);
  assert.equal(auth.clearSessionCookieHeader(true).length, 3);

  // upsertUser bảo toàn bio, avatar, role
  const up = auth.upsertUser({ id: 9, username: 'gv_bio', bio: 'Giáo viên Toán', avatar: '12', role: 'admin' });
  assert.equal(up.bio, 'Giáo viên Toán');
  assert.equal(up.role, 'admin');

  // Cooldown 7 ngày
  const tChange = clock.now;
  assert.equal(auth.cooldownInfo(tChange, auth.NAME_CHANGE_COOLDOWN_MS).allowed, false);
  clock.now += auth.NAME_CHANGE_COOLDOWN_MS;
  assert.equal(auth.cooldownInfo(tChange, auth.NAME_CHANGE_COOLDOWN_MS).allowed, true);
});

test('SYS-U05 [RoomManager] Chuẩn hóa capacity biên, rollback khi DB lỗi, khôi phục PIN chủ phòng và chống cướp PIN', async () => {
  let failDb = false;
  const { mod: rm, clock } = loadWithClock('src/rooms/manager.js', {
    '../db/index.js': {
      createWaitingGameSession: async () => {
        if (failDb) throw new Error('DB_WRITE_FAILED');
      },
      saveHostedGameSession: async () => {},
    },
  });

  // Kiểm tra chuẩn hóa mọi giá trị capacity bất thường về số nguyên >= 1
  for (const badCap of [-100, -1, 0, NaN, Infinity, -Infinity, null, '', 'abc']) {
    const r = await rm.createRoom({ hostUsername: 'host_cap', exam: { questions: [] }, capacity: badCap });
    assert.equal(r.capacity, 40, `capacity=${badCap} phải chuẩn hóa về 40`);
    rm.deleteRoom(r.pin);
  }
  const floatRoom = await rm.createRoom({ hostUsername: 'host_cap', exam: { questions: [] }, capacity: 12.9 });
  assert.equal(floatRoom.capacity, 12);
  rm.deleteRoom(floatRoom.pin);

  const cappedRoom = await rm.createRoom({ hostUsername: 'host_cap', exam: { questions: [] }, capacity: 999 });
  assert.equal(cappedRoom.capacity, 500, 'capacity vượt 500 phải chuẩn hóa tối đa 500');
  rm.deleteRoom(cappedRoom.pin);

  // Host tạo phòng với PIN cụ thể -> Host khác không được ghi đè -> Chính host đó khôi phục được -> Nếu DB lỗi phải khôi phục phòng cũ
  const origRoom = await rm.createRoom({ pin: '246-813', hostUsername: 'alice', title: 'Phòng gốc', exam: { questions: [] } });
  assert.equal(origRoom.pin, '246-813');

  const hijackAttempt = await rm.createRoom({ pin: '246-813', hostUsername: 'bob', title: 'Cướp PIN', exam: { questions: [] } });
  assert.notEqual(hijackAttempt.pin, '246-813', 'Host khác không được ghi đè PIN đang hoạt động');
  assert.equal(rm.getRawRoom('246-813').title, 'Phòng gốc');

  // Khi DB lỗi lúc alice ghi đè chính phòng của mình -> phải rollback giữ nguyên phòng cũ của alice
  failDb = true;
  await assert.rejects(
    () => rm.createRoom({ pin: '246-813', hostUsername: 'alice', title: 'Phòng lỗi DB', exam: { questions: [] } }),
    /DB_WRITE_FAILED/
  );
  assert.equal(rm.getRawRoom('246-813').title, 'Phòng gốc', 'Phải khôi phục phòng cũ khi DB lỗi');
  failDb = false;

  // Dọn phòng hết hạn sau 4 giờ
  clock.now += 4 * 60 * 60 * 1000 + 1000;
  assert.equal(rm.getRawRoom('246-813'), null, 'Phòng quá 4 giờ phải tự động được dọn dẹp');
});

test('SYS-U06 [RoomManager] addPlayer chống nick rỗng/phi chuỗi, reconnect giữ điểm khi phòng khóa/đầy, chặn đổi accountUserId, và luật rời phòng/kick', async () => {
  const { mod: rm } = loadWithClock('src/rooms/manager.js', {
    '../db/index.js': { createWaitingGameSession: async () => {}, saveHostedGameSession: async () => {} },
  });

  const room = await rm.createRoom({
    hostUsername: 'teacher_rm',
    capacity: 2,
    exam: { questions: [{ text: 'Q1', choices: ['A', 'B'], correct: 0 }] },
  });

  // Nick chỉ khoảng trắng hoặc kiểu số/mảng không được tạo chuỗi rỗng hoặc throw TypeError
  const pBlank = rm.addPlayer(room.pin, { nick: '    ', accountUserId: 101, accountUsername: 'st1' });
  assert.equal(pBlank.success, true);
  assert.equal(pBlank.player.nick, 'Thí sinh');

  // Vì 'Thí sinh' đã tồn tại và pNumeric không có token -> pNumeric cũng fallback về 'Thí sinh' mà không throw TypeError và bị chặn trùng tên
  const pNumeric = rm.addPlayer(room.pin, { nick: 12345 });
  assert.equal(pNumeric.success, false, 'Nick phi chuỗi fallback về Thí sinh trùng với người trước phải bị chặn giả mạo');

  const p2 = rm.addPlayer(room.pin, { nick: 'Bình_2' });
  assert.equal(p2.success, true);

  // Khóa phòng và phòng đã đầy (2/2): thí sinh cũ có token đúng vẫn reconnect được, nhưng khác accountUserId bị chặn
  rm.setRoomLock(room.pin, true);
  const wrongAccountReconnect = rm.addPlayer(room.pin, {
    id: pBlank.player.id,
    nick: 'Thí sinh',
    playerToken: pBlank.player.playerToken,
    accountUserId: 999,
  });
  assert.equal(wrongAccountReconnect.success, false);
  assert.match(wrongAccountReconnect.message, /another account/i);

  const validReconnect = rm.addPlayer(room.pin, {
    id: pBlank.player.id,
    nick: 'Thí sinh',
    av: '09',
    playerToken: pBlank.player.playerToken,
    accountUserId: 101,
  });
  assert.equal(validReconnect.success, true);
  assert.equal(validReconnect.player.av, '09');

  // Khi phòng đang started: thí sinh tự leave được bảo toàn (preserved: true), nhưng Host kick thì xóa hẳn (không xóa host)
  rm.startRoom(room.pin, 5);
  const guestLeaveInCountdown = rm.removePlayer(room.pin, {
    id: p2.player.id,
    playerToken: p2.player.playerToken,
    isHost: false,
  });
  assert.equal(guestLeaveInCountdown.success, true);
  assert.equal(guestLeaveInCountdown.preserved, true);
  assert.equal(rm.getRawRoom(room.pin).players.filter(p => !p.isHost).length, 2);

  // Host kick p2 thành công và không bao giờ tự xóa host
  assert.equal(rm.removePlayer(room.pin, { id: p2.player.id, isHost: true }).success, true);
  assert.equal(rm.getRawRoom(room.pin).players.filter(p => !p.isHost).length, 1);
  rm.removePlayer(room.pin, { id: `host-teacher_rm`, isHost: true });
  assert.equal(rm.getRawRoom(room.pin).players.some(p => p.isHost), true, 'Không bao giờ xóa bản ghi Host khỏi phòng');
});

test('SYS-U07 [AI Gemini] Rate limit 6/phút & 40/giờ, retry lỗi 503, phân loại lỗi API, ẩn danh PII và bộ nhớ đệm LRU', async () => {
  const { mod: ai, clock } = loadWithClock('src/ai/gemini.js', {});

  // 1. Rate limit 6/phút, hồi phục sau 61s, chạm trần 40/giờ
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 6; i++) {
      assert.equal(ai.checkAiRateLimit('gv1', '1.1.1.1').allowed, true);
    }
    assert.equal(ai.checkAiRateLimit('gv1', '1.1.1.1').allowed, false, 'Lần thứ 7 trong cùng phút phải bị chặn');
    clock.now += 61_000;
  }
  // Đã dùng 36 lượt trong giờ -> thêm 4 lượt đạt 40 -> lượt 41 bị chặn theo giờ
  for (let i = 0; i < 4; i++) {
    assert.equal(ai.checkAiRateLimit('gv1', '1.1.1.1').allowed, true);
  }
  const hourBlocked = ai.checkAiRateLimit('gv1', '1.1.1.1');
  assert.equal(hourBlocked.allowed, false);
  assert.match(hourBlocked.message, /giờ/);
  // User hoặc IP khác hoàn toàn độc lập
  assert.equal(ai.checkAiRateLimit('gv2', '1.1.1.1').allowed, true);

  // 2. Ẩn danh PII trong buildWeaknessStatsInput
  const compressed = ai.buildWeaknessStatsInput({
    roomTitle: 'Kiểm tra Sinh học',
    stats: {
      totalCandidates: 30,
      avgScore: 250,
      maxScore: 400,
      maxPossibleScore: 400,
      topCandidateNick: 'Nguyễn Văn Bí Mật',
      candidatesMatrix: [{ id: 'p1', nick: 'Lê Thị Ẩn Danh', score: 400 }],
      questionsStats: [
        { qIdx: 1, text: 'Câu dễ', correctCount: 28, totalCount: 30, ratioPct: 93 },
        { qIdx: 2, text: 'Câu rất khó', correctCount: 5, totalCount: 30, ratioPct: 17 },
      ],
    },
  });
  const serialized = JSON.stringify(compressed);
  assert.equal(serialized.includes('Bí Mật'), false, 'Không được gửi tên học sinh lên AI');
  assert.equal(serialized.includes('Ẩn Danh'), false, 'Không được gửi ma trận thí sinh lên AI');
  assert.equal(compressed.questions[0].qIdx, 2, 'Câu có tỷ lệ đúng thấp nhất phải xếp đầu');

  // 3. Kiểm tra generateQuestions retry lỗi tạm thời 503 và chuẩn hóa tiền tố A./B./C./D.
  let callCount = 0;
  ai.setGenAIClientFactoryForTest(async () => ({
    sdk: { Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY', INTEGER: 'INTEGER', NUMBER: 'NUMBER' } },
    ai: {
      models: {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            const transient = new Error('Service Unavailable');
            transient.status = 503;
            throw transient;
          }
          return {
            text: JSON.stringify({
              suggestedTitle: 'Đề Hoá Học 10',
              suggestedSubject: 'Hoá học',
              questions: [
                {
                  text: 'Nguyên tử gồm hạt nào?',
                  choices: ['A. Proton, Neutron, Electron', 'B) Chỉ Proton', 'C: Chỉ Electron', 'D - Photon'],
                  correctIndices: [0, 99],
                },
                {
                  text: 'Câu thiếu lựa chọn phải bị loại',
                  choices: ['Chỉ 1', 'Chỉ 2'],
                  correctIndices: [0],
                },
              ],
            }),
          };
        },
      },
    },
  }));

  const gen = await ai.generateQuestions({ topic: 'Cấu tạo nguyên tử', count: 5, questionType: 'single' });
  assert.equal(callCount, 2, 'Phải tự động retry đúng 1 lần khi gặp HTTP 503');
  assert.equal(gen.questions.length, 1);
  assert.deepEqual(Array.from(gen.questions[0].choices), ['Proton, Neutron, Electron', 'Chỉ Proton', 'Chỉ Electron', 'Photon']);
  assert.equal(gen.questions[0].correct, 0);
  assert.equal(gen.questions[0].isMultiple, undefined);
});
