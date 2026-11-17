const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function load(file, overrides = {}, tail = '', env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const context = {
    require: name => (Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)),
    module: { exports: {} },
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    process: { env, exit: code => { throw new Error(`exit:${code}`); } },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {},
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail,
    context,
    { filename }
  );
  return context.module.exports;
}

function makeServerHarness(t, env = {}) {
  const publicExams = [
    {
      id: 'pub-1',
      code: '#1001',
      title: 'Đề Lịch Sử Cổ Đại Việt Nam',
      ownerUsername: 'alice',
      sharedBy: 'alice',
      isPublic: true,
      questions: [
        { text: 'Năm 938 ai chiến thắng trên sông Bạch Đằng?', choices: ['Ngô Quyền', 'Lê Hoàn', 'Trần Hưng Đạo', 'Lý Thường Kiệt'], correct: 0 },
        { text: 'Những triều đại nào tồn tại ở thế kỷ XI?', choices: ['Nhà Lý', 'Nhà Ngô', 'Nhà Tiền Lê', 'Nhà Nguyễn'], correct: 0, correctChoices: [0, 2], isMultiple: true },
      ],
    },
  ];
  const savedPrivate = [];
  const savedPublic = [];
  const savedAttempts = [];
  let deletedInfo = null;
  let copiesCounter = 0;

  const dbMock = {
    async getPrivateQuizzes(owner) {
      return owner === 'alice'
        ? [
            { id: 'priv-10', code: '#10', title: 'Mười' },
            { id: 'priv-2', code: '#2', title: 'Hai' },
            { id: 'priv-copy', code: '#1001-1', parentCode: '#1001', title: publicExams[0].title, questions: publicExams[0].questions },
          ]
        : [];
    },
    async getPublicQuizzes() { return [...publicExams, ...savedPublic]; },
    async getQuizById(id, opts) {
      if (id === 'priv-copy') {
        return { id: 'priv-copy', code: '#1001-1', parentCode: '#1001', title: publicExams[0].title, questions: publicExams[0].questions };
      }
      if (id === 'solo-1' && opts?.internal) {
        return {
          id: 'solo-1',
          title: 'Solo Quiz',
          pointsPerQ: 100,
          questions: [
            { text: 'Q1', choices: ['A', 'B'], correct: 1, points: 100 },
            { text: 'Q2 Multi', choices: ['1', '2', '3', '4'], correct: 1, correctChoices: [1, 3], isMultiple: true, points: 100 },
          ],
        };
      }
      if (id === 'mine-room' && opts?.requestingUser?.username === 'alice') {
        return { id: 'mine-room', title: 'Phòng Từ Đề', questions: [{ text: 'Q?', choices: ['A', 'B'], correct: 0 }] };
      }
      return null;
    },
    async getPublicQuizById(idOrCode, opts = {}) {
      const hit = publicExams.find(e => e.id === idOrCode || e.code === idOrCode);
      if (!hit) return null;
      if (opts.includeCorrect) return JSON.parse(JSON.stringify(hit));
      return {
        ...hit,
        questions: hit.questions.map(q => ({ text: q.text, choices: q.choices, ...(q.isMultiple ? { isMultiple: true } : {}) })),
      };
    },
    async incrementQuizCopiesIssued() { return ++copiesCounter; },
    async saveQuiz(exam, owner, isPublic) {
      const rec = { ...exam, ownerUsername: owner, isPublic };
      if (isPublic) savedPublic.push(rec);
      else savedPrivate.push(rec);
      return rec;
    },
    async deleteQuiz(id, user) {
      deletedInfo = { id, user };
      if (typeof user === 'object') return user.role === 'admin' || user.username === 'alice';
      return user === 'alice';
    },
    async getUserAttempts(u) { return savedAttempts.filter(a => a.username === u); },
    async saveAttempt(rec) { savedAttempts.push(rec); return rec; },
    async getHostedGameSessions(u) { return [{ id: 'gs-1', hostId: u }]; },
    async saveHostedGameSession() {},
    async createWaitingGameSession() {},
  };

  const pgMock = {
    async query(sql, params) {
      if (/FROM game_sessions WHERE room_code/.test(sql) && params[0] === '777-888') {
        return {
          rows: [{
            id: 'arch-sess-1', quiz_id: 'pub-1', room_code: '777-888', room_title: 'Phòng Archived',
            total_players: 2, ended_at: 1700000200000, formatted_time: '17/11/2026',
            stats: {
              questionsStats: [{ text: 'Multi', correctIndex: 0, correctIndices: [0, 2], isMultiple: true }],
              candidatesMatrix: [{ id: 'p-arch', nick: 'Alice', score: 98, correctCount: 1, ratioPct: 100, answersMap: [true] }],
            },
          }],
        };
      }
      return { rows: [] };
    },
  };

  const authMock = {
    parseCookies: () => ({}),
    getSession: tok => (
      tok === 'alice' ? { username: 'alice' }
        : tok === 'bob' ? { username: 'bob' }
          : tok === 'fakeAdmin' ? { username: 'admin' }
            : tok === 'realAdmin' ? { username: 'mod' }
              : null
    ),
    findUserByUsernameSync: u => ({
      id: u === 'alice' ? 1 : u === 'bob' ? 2 : u === 'admin' ? 3 : 4,
      username: u,
      role: u === 'mod' ? 'admin' : 'teacher',
    }),
  };

  const rooms = load('src/rooms/manager.js', { '../db/index.js': dbMock });
  const { server } = load('src/server.js', {
    dotenv: { config() {} },
    './auth.js': authMock,
    './db/index.js': dbMock,
    './db/pool.js': pgMock,
    './db/migrate.js': {},
    './rooms/manager.js': rooms,
    './ai/gemini.js': {},
  }, '\nmodule.exports = { server };', env);

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        rooms,
        publicExams,
        savedPrivate,
        savedPublic,
        savedAttempts,
        getDeletedInfo: () => deletedInfo,
        getCopiesCounter: () => copiesCounter,
      });
    });
  });
}

test('CORS enforces strict whitelist across APP_URL, CORS_ORIGINS, *.ai.studio, *.run.app and rejects unknown origins', async t => {
  const { base } = await makeServerHarness(t, {
    APP_URL: 'https://custom-app.example',
    CORS_ORIGINS: 'https://extra1.example, https://extra2.example',
  });

  for (const origin of [
    'https://custom-app.example',
    'https://extra2.example',
    'https://preview.ai.studio',
    'https://svc.run.app',
    'http://localhost:5173',
    'http://127.0.0.1:8080',
  ]) {
    const res = await fetch(base + '/api/server-info', { headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('vary'), 'Origin');
  }

  // Disallowed origin: GET omits allow header, mutating methods & OPTIONS return 403
  const getBad = await fetch(base + '/api/server-info', { headers: { Origin: 'https://evil.example' } });
  assert.equal(getBad.headers.get('access-control-allow-origin'), null);
  assert.equal(getBad.headers.get('vary'), 'Origin');

  for (const method of ['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await fetch(base + '/api/rooms', { method, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  }
});

test('GET /api/server-info and static assets return expected MIME types, Cache-Control, redirects and 404s', async t => {
  const { base } = await makeServerHarness(t);

  const info = await (await fetch(base + '/api/server-info')).json();
  assert.equal(info.success, true);
  assert.ok(info.lanIp);
  assert.match(info.lanUrl, /^http:\/\//);

  const cssRes = await fetch(base + '/css/base.css');
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type'), /text\/css/);

  const jsRes = await fetch(base + '/js/storage.js');
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type'), /application\/javascript/);

  assert.equal((await fetch(base + '/css')).status, 404); // directory rejected
  assert.equal((await fetch(base + '/missing-file.txt')).status, 404);
  assert.equal((await fetch(base + '/../../package.json')).status, 404);

  for (const p of ['/dashboard.html', '/create-exam.html', '/create-room.html']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /needLogin=1/);
  }
  const authedHtml = await fetch(base + '/dashboard.html', { headers: { Authorization: 'Bearer alice' } });
  assert.equal(authedHtml.status, 200);
  assert.match(authedHtml.headers.get('cache-control') || '', /no-store/);
  assert.match(await authedHtml.text(), /window\.__SERVER_LAN_URL__/);
});

test('Storage private GET/POST/DELETE enforce auth, natural code sort and validation', async t => {
  const { base, savedPrivate, getDeletedInfo } = await makeServerHarness(t);

  assert.equal((await fetch(base + '/api/storage/private')).status, 401);
  const list = await (await fetch(base + '/api/storage/private', { headers: { Authorization: 'Bearer alice' } })).json();
  assert.deepEqual(list.exams.map(e => e.code), ['#2', '#10', '#1001-1']);

  assert.equal((await fetch(base + '/api/storage/private', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice' },
    body: JSON.stringify({ questions: [] }),
  })).status, 400);

  assert.equal((await fetch(base + '/api/storage/private', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice' },
    body: JSON.stringify({ title: 'New Exam', questions: [] }),
  })).status, 200);
  assert.equal(savedPrivate.length, 1);

  assert.equal((await fetch(base + '/api/storage/private/priv-2', { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(base + '/api/storage/private/priv-2', { method: 'DELETE', headers: { Authorization: 'Bearer alice' } })).status, 200);
  assert.equal(getDeletedInfo().id, 'priv-2');
});

test('Storage public /check-share & /share enforce 10% copy similarity guard via server answers', async t => {
  const { base, publicExams, savedPublic } = await makeServerHarness(t);
  const post = (u, b, tok = 'bob') => fetch(base + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(b),
  });

  // Auth & validation
  assert.equal((await post('/api/storage/public/check-share', { exam: {} }, null)).status, 401);
  assert.equal((await post('/api/storage/public/check-share', { exam: {} })).status, 400);

  // Unchanged copy (even with omitted parentCode -> resolved via id) => allowed:false & share 409
  const copy = {
    id: 'priv-copy',
    code: '#x99',
    title: publicExams[0].title,
    questions: publicExams[0].questions,
  };
  const chk0 = await (await post('/api/storage/public/check-share', { exam: copy })).json();
  assert.equal(chk0.allowed, false);
  assert.equal(chk0.diffPercent, 0);
  assert.equal(Object.hasOwn(chk0, 'questions'), false);

  const share0 = await post('/api/storage/public/share', { exam: copy });
  assert.equal(share0.status, 409);
  assert.equal((await share0.json()).code, 'COPY_SIMILARITY_TOO_HIGH');
  assert.equal(savedPublic.length, 0);

  // Substantially edited (>= 10%) => allowed:true & published 200
  const edited = {
    ...copy,
    title: 'Đề Ôn Tập Lịch Sử Việt Nam Nâng Cao Cho Học Sinh Khá Giỏi',
    questions: [
      { text: 'Khởi nghĩa Hai Bà Trưng nổ ra năm nào?', choices: ['Năm 40', 'Năm 248', 'Năm 542', 'Năm 938'], correct: 0 },
      ...copy.questions.slice(1),
    ],
  };
  const chk1 = await (await post('/api/storage/public/check-share', { exam: edited })).json();
  assert.equal(chk1.allowed, true);
  assert.ok(chk1.diffPercent >= 10);

  const share1 = await post('/api/storage/public/share', { exam: edited });
  assert.equal(share1.status, 200);
  assert.equal(savedPublic.length, 1);

  // Brand-new exam with colliding code '#1001' (no parentCode) is NOT blocked by similarity and gets dedup code
  const fresh = {
    id: 'brand-new-99',
    code: '#1001',
    title: publicExams[0].title,
    questions: publicExams[0].questions,
  };
  const shareFresh = await post('/api/storage/public/share', { exam: fresh });
  assert.equal(shareFresh.status, 200);
  const freshData = await shareFresh.json();
  assert.match(freshData.shareCode, /^#1001-\d{4}$/);
});

test('Storage public DELETE RBAC & save-to-private isolation', async t => {
  const { base, getCopiesCounter } = await makeServerHarness(t);

  assert.equal((await fetch(base + '/api/storage/public/pub-1', { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(base + '/api/storage/public/pub-1', { method: 'DELETE', headers: { Authorization: 'Bearer bob' } })).status, 403);
  assert.equal((await fetch(base + '/api/storage/public/pub-1', { method: 'DELETE', headers: { Authorization: 'Bearer fakeAdmin' } })).status, 403);
  assert.equal((await fetch(base + '/api/storage/public/pub-1', { method: 'DELETE', headers: { Authorization: 'Bearer realAdmin' } })).status, 200);

  assert.equal((await fetch(base + '/api/storage/public/save-to-private', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ examId: 'pub-1' }),
  })).status, 401);
  assert.equal((await fetch(base + '/api/storage/public/save-to-private', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bob' }, body: JSON.stringify({ examId: 'priv-10' }),
  })).status, 404);
  const cloneRes = await fetch(base + '/api/storage/public/save-to-private', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bob' }, body: JSON.stringify({ examId: 'pub-1' }),
  });
  assert.equal(cloneRes.status, 200);
  assert.equal((await cloneRes.json()).exam.questions[0].correct, 0);
  assert.equal(getCopiesCounter(), 1);
});

test('Rooms HTTP sub-routes enforce host auth, own-PIN restore limit bypass, validation & 404s', async t => {
  const { base, rooms } = await makeServerHarness(t);
  const post = (u, b, tok = null) => fetch(base + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(b),
  });

  // Invalid body / missing name / unauthorized examId
  assert.equal((await post('/api/rooms', [], 'alice')).status, 400);
  assert.equal((await post('/api/rooms', { name: '   ' }, 'alice')).status, 400);
  assert.equal((await post('/api/rooms', { name: 'R', examId: 'priv-other' }, 'alice')).status, 403);

  // Create 3 rooms -> 4th hits 409, but restoring own PIN succeeds
  const pins = [];
  for (let i = 0; i < 3; i++) {
    const r = await post('/api/rooms', { name: `Room ${i}`, examId: 'mine-room' }, 'alice');
    assert.equal(r.status, 200);
    pins.push((await r.json()).pin);
  }
  assert.equal((await post('/api/rooms', { name: 'Room 4', examId: 'mine-room' }, 'alice')).status, 409);
  assert.equal((await post('/api/rooms', { pin: pins[0], name: 'Room 0 Restored', examId: 'mine-room' }, 'alice')).status, 200);

  const pin = pins[0];
  assert.equal((await fetch(`${base}/api/rooms/000-000`)).status, 404);
  assert.equal((await post(`/api/rooms/${pin}/advance`, { nextQ: 99, phase: 'question' }, 'alice')).status, 400);
  assert.equal((await post(`/api/rooms/${pin}/advance`, { nextQ: 0, phase: 'question' }, 'bob')).status, 403);
  assert.equal((await post(`/api/rooms/${pin}/lock`, { isLocked: true }, 'bob')).status, 403);
  assert.equal((await post(`/api/rooms/${pin}/kick`, { playerId: 'x' }, 'bob')).status, 403);
  assert.equal((await post(`/api/rooms/${pin}/start`, { countdownSec: 5 }, 'bob')).status, 403);
  assert.equal((await fetch(`${base}/api/rooms/${pin}`, { method: 'DELETE', headers: { Authorization: 'Bearer bob' } })).status, 403);

  // Malformed subpaths return 400
  assert.equal((await post(`/api/rooms/${pin}/leave/extra`, {})).status, 400);
  assert.equal((await post(`/api/rooms/${pin}/advance/extra`, {}, 'alice')).status, 400);

  // Clean up one room -> count drops to 2 so new room allowed
  assert.equal((await fetch(`${base}/api/rooms/${pin}`, { method: 'DELETE', headers: { Authorization: 'Bearer alice' } })).status, 200);
  assert.equal(rooms.countActiveRoomsByHost('alice'), 2);
  assert.equal((await post('/api/rooms', { name: 'Room Replace', examId: 'mine-room' }, 'alice')).status, 200);
});

test('History HTTP routes enforce auth and execute all 4 POST /api/history branches accurately', async t => {
  const { base, rooms } = await makeServerHarness(t);
  const post = (u, b, tok = null) => fetch(base + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(b),
  });

  assert.equal((await fetch(base + '/api/history')).status, 401);
  assert.equal((await fetch(base + '/api/history/hosted')).status, 401);
  assert.equal((await fetch(base + '/api/history', { headers: { Authorization: 'Bearer alice' } })).status, 200);
  assert.equal((await fetch(base + '/api/history/hosted', { headers: { Authorization: 'Bearer alice' } })).status, 200);

  // Branch 1: Active room with 2 questions at q=0 -> 409
  const r = await rooms.createRoom({
    hostUsername: 'alice',
    exam: { questions: [{ text: 'Q1', choices: ['A', 'B'], correct: 0 }, { text: 'Q2', choices: ['C', 'D'], correct: 1 }] },
  });
  const stu = rooms.addPlayer(r.pin, { id: 'stu1', nick: 'Bob', accountUserId: 2, accountUsername: 'bob' }).player;
  assert.equal((await post('/api/history', { pin: r.pin, playerId: 'stu1', playerToken: stu.playerToken })).status, 409);

  // Branch 2: Archived room DB fallback
  const archRes = await post('/api/history', { pin: '777-888', playerId: 'p-arch', details: [{ userChoices: [0, 2] }] }, 'alice');
  assert.equal(archRes.status, 200);
  const archData = await archRes.json();
  assert.equal(archData.historyItem.gameSessionId, 'arch-sess-1');
  assert.equal(archData.historyItem.details[0].questionType, 'multiple');

  // Branch 3: Solo quiz re-graded server-side (Q1 right = 100, Q2 multi exact = 100 -> 200)
  const soloRes = await post('/api/history', {
    quizId: 'solo-1',
    score: 1,
    details: [{ userChoice: 1 }, { userChoices: [3, 1] }],
  }, 'bob');
  assert.equal(soloRes.status, 200);
  assert.equal((await soloRes.json()).historyItem.score, 200);

  // Branch 4: Guest unverified practice -> 400; logged-in practice -> 200
  assert.equal((await post('/api/history', { details: [{ isCorrect: true }] })).status, 400);
  assert.equal((await post('/api/history', { details: [{ isCorrect: true }] }, 'bob')).status, 200);

  // Hosted history guards
  assert.equal((await post('/api/history/hosted', {}, 'alice')).status, 400);
  assert.equal((await post('/api/history/hosted', { pin: '000-001' }, 'alice')).status, 404);
  assert.equal((await post('/api/history/hosted', { pin: r.pin }, 'bob')).status, 403);
  assert.equal((await post('/api/history/hosted', { pin: r.pin }, 'alice')).status, 200);
});
