const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadModule(file, overrides = {}, tail = '', env = {}) {
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

function makeConcurrentServerHarness(t) {
  const dbUsers = new Map();
  const dbSessions = new Map();
  let nextUserId = 1;
  let saveHostedCalls = 0;
  const savedAttempts = [];

  const quiz = {
    id: 'quiz-load-1',
    title: 'Đề Load & Multi',
    pointsPerQ: 100,
    timeLimit: 20,
    questions: [
      { text: 'Single Q1', choices: ['A', 'B', 'C', 'D'], correct: 1, points: 100 },
      { text: 'Multi Q2', choices: ['1', '2', '3', '4'], correct: 0, correctChoices: [0, 2], isMultiple: true, points: 100 },
    ],
  };

  const dbMock = {
    useSupabase: () => false,
    async getPrivateQuizzes() { return [quiz]; },
    async getPublicQuizzes() { return []; },
    async getQuizById(id) { return id === quiz.id ? JSON.parse(JSON.stringify(quiz)) : null; },
    async getPublicQuizById() { return null; },
    async getUserAttempts(u) { return savedAttempts.filter(a => a.username === u); },
    async saveAttempt(rec) { savedAttempts.push(rec); return rec; },
    async getHostedGameSessions() { return []; },
    async createWaitingGameSession() {},
    async saveHostedGameSession() {
      await new Promise(r => setTimeout(r, 15));
      saveHostedCalls++;
    },
    async findUserByUsername(username) {
      return dbUsers.get(String(username || '').toLowerCase()) || null;
    },
    async createUser({ username, displayName, passwordHash, salt }) {
      await new Promise(r => setTimeout(r, 10)); // widen race window across hash/insert
      const lower = username.toLowerCase();
      if (dbUsers.has(lower)) {
        throw new Error('duplicate key value violates unique constraint');
      }
      const u = {
        id: nextUserId++,
        username,
        usernameLower: lower,
        displayName,
        passwordHash,
        salt,
        createdAt: Date.now(),
        lastNameChangeAt: 0,
        lastPasswordChangeAt: 0,
        avatar: '01',
        bio: '',
        role: 'teacher',
      };
      dbUsers.set(lower, u);
      return u;
    },
    async saveSession(token, username, expiresAt) { dbSessions.set(token, { token, username, expiresAt }); },
    async deleteSession(token) { dbSessions.delete(token); },
    async deleteOtherSessions() {},
  };

  const pgMock = { async query() { return { rows: [] }; } };
  const auth = loadModule('src/auth.js', { './db/index.js': dbMock, './db/pool.js': pgMock });
  // Preseed a host account 'host1' with a valid session
  dbUsers.set('host1', { id: 999, username: 'host1', usernameLower: 'host1', displayName: 'Host', role: 'teacher' });
  dbSessions.set('host-tok', { token: 'host-tok', username: 'host1', createdAt: Date.now(), expiresAt: Date.now() + 3600_000 });
  const origGetSession = auth.getSession;
  auth.getSession = tok => (tok === 'host-tok' ? { username: 'host1' } : origGetSession(tok));
  const origFindSync = auth.findUserByUsernameSync;
  auth.findUserByUsernameSync = u => (u === 'host1' ? dbUsers.get('host1') : origFindSync(u));

  const rooms = loadModule('src/rooms/manager.js', { '../db/index.js': dbMock });
  const { server } = loadModule('src/server.js', {
    dotenv: { config() {} },
    './auth.js': auth,
    './db/index.js': dbMock,
    './db/pool.js': pgMock,
    './db/migrate.js': {},
    './rooms/manager.js': rooms,
    './ai/gemini.js': {},
  }, '\nmodule.exports = { server };');

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        rooms,
        savedAttempts,
        getSaveHostedCalls: () => saveHostedCalls,
      });
    });
  });
}

test('60 concurrent players join, poll endpoints, and submit single + multi-choice answers with zero 5xx and exact aggregation', async t => {
  const { base, rooms } = await makeConcurrentServerHarness(t);

  const createRes = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ examId: 'quiz-load-1', name: 'Phòng 60 Players', timePerQ: 20, capacity: 100 }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  const pin = created.pin;

  // 60 players join in parallel
  const joined = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      fetch(`${base}/api/rooms/${pin}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: `Player_${String(i + 1).padStart(2, '0')}` }),
      }).then(async r => ({ status: r.status, body: await r.json() }))
    )
  );
  assert.ok(joined.every(r => r.status === 200 && r.body.player?.id && r.body.player?.playerToken));

  // Host starts game -> Q0 (single, correct=1)
  const startRes = await fetch(`${base}/api/rooms/${pin}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ countdownSec: 1 }),
  });
  assert.equal(startRes.status, 200);

  // Concurrently poll /state, /status, /question-stats, /leaderboard while all 60 submit Q0
  const reqs = [];
  for (let i = 0; i < 60; i++) {
    const p = joined[i].body.player;
    const choice = i % 2 === 0 ? 1 : 0; // 30 correct, 30 wrong
    reqs.push(
      fetch(`${base}/api/rooms/${pin}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: p.id, playerToken: p.playerToken, qIdx: 0, choice }),
      })
    );
    if (i % 3 === 0) {
      reqs.push(fetch(`${base}/api/rooms/${pin}/state`));
      reqs.push(fetch(`${base}/api/rooms/${pin}/status`));
      reqs.push(fetch(`${base}/api/rooms/${pin}/question-stats?q=0`, { headers: { Authorization: 'Bearer host-tok' } }));
      reqs.push(fetch(`${base}/api/rooms/${pin}/leaderboard`, { headers: { Authorization: 'Bearer host-tok' } }));
    }
  }

  const responses = await Promise.all(reqs);
  assert.ok(responses.every(r => r.status < 500), 'Expected zero 5xx responses under concurrent load');

  const statsRes = await fetch(`${base}/api/rooms/${pin}/question-stats?q=0`, { headers: { Authorization: 'Bearer host-tok' } });
  const stats0 = await statsRes.json();
  assert.equal(stats0.totalAnswered, 60);
  assert.equal(stats0.choicesCount[1], 30);
  assert.equal(stats0.choicesCount[0], 30);
  assert.equal(stats0.choicesCount.reduce((a, b) => a + b, 0), 60);

  // Advance to Q1 (multi-choice, correctChoices=[0, 2]) and submit 60 answers simultaneously
  const nextRes = await fetch(`${base}/api/rooms/${pin}/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ phase: 'question', nextQ: 1 }),
  });
  assert.equal(nextRes.status, 200);

  const q1Responses = await Promise.all(
    joined.map((j, i) =>
      fetch(`${base}/api/rooms/${pin}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: j.body.player.id,
          playerToken: j.body.player.playerToken,
          qIdx: 1,
          choices: i < 20 ? [0, 2] : [1], // 20 correct multi, 40 wrong
        }),
      }).then(async r => ({ status: r.status, body: await r.json() }))
    )
  );
  assert.ok(q1Responses.every(r => r.status === 200 && r.body.success === true && r.body.isCorrect === undefined));
  const q1Recorded = Object.values(rooms.getRawRoom(pin).answers[1] || {});
  assert.equal(q1Recorded.length, 60);
  assert.equal(q1Recorded.filter(a => a.isCorrect === true).length, 20);

  const stats1Res = await fetch(`${base}/api/rooms/${pin}/question-stats?q=1`, { headers: { Authorization: 'Bearer host-tok' } });
  const stats1 = await stats1Res.json();
  assert.equal(stats1.totalAnswered, 60);
  assert.equal(stats1.choicesCount[0], 20);
  assert.equal(stats1.choicesCount[2], 20);
  assert.equal(stats1.choicesCount[1], 40);

  // Leaderboard ordering determinism (candidates sorted non-increasing by score)
  const lb = rooms.getLeaderboard(pin);
  assert.equal(lb.length, 60);
  for (let i = 1; i < lb.length; i++) {
    assert.ok(lb[i - 1].score >= lb[i].score);
  }
});

test('20 concurrent duplicate /answer submissions from one player accept only once and mark 19 duplicate:true', async t => {
  const { base } = await makeConcurrentServerHarness(t);

  const created = await (await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ examId: 'quiz-load-1', name: 'Phòng Duplicate' }),
  })).json();
  const join = await (await fetch(`${base}/api/rooms/${created.pin}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nick: 'SoloSpammer' }),
  })).json();
  await fetch(`${base}/api/rooms/${created.pin}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ countdownSec: 1 }),
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${base}/api/rooms/${created.pin}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: join.player.id, playerToken: join.player.playerToken, qIdx: 0, choice: 1 }),
      }).then(r => r.json())
    )
  );

  const fresh = results.filter(r => r.success === true && !r.duplicate);
  const dups = results.filter(r => r.duplicate === true);
  assert.equal(fresh.length, 1);
  assert.equal(dups.length, 19);
  assert.equal(fresh[0].score, dups[0].score);
});

test('20 concurrent POST /api/history and /api/history/hosted archive hosted session once and save distinct attempt-* rows', async t => {
  const { base, savedAttempts, getSaveHostedCalls } = await makeConcurrentServerHarness(t);

  const created = await (await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ examId: 'quiz-load-1', name: 'Phòng Archive' }),
  })).json();
  const pin = created.pin;

  const joins = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      fetch(`${base}/api/rooms/${pin}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: `P${i}` }),
      }).then(r => r.json())
    )
  );

  await fetch(`${base}/api/rooms/${pin}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ countdownSec: 1 }),
  });
  await fetch(`${base}/api/rooms/${pin}/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ phase: 'question', nextQ: 1 }),
  });
  await fetch(`${base}/api/rooms/${pin}/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
    body: JSON.stringify({ phase: 'result', nextQ: 1 }),
  });

  // Hammer /api/history (20 concurrent players) + /api/history/hosted (5 concurrent host calls)
  const calls = [
    ...joins.map((j, i) =>
      fetch(base + '/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
        body: JSON.stringify({
          pin,
          playerId: j.player.id,
          playerToken: j.player.playerToken,
          nick: `P${i}`,
          correctCount: 1,
          totalQ: 2,
          score: 100,
        }),
      })
    ),
    ...Array.from({ length: 5 }, () =>
      fetch(base + '/api/history/hosted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-tok' },
        body: JSON.stringify({ pin }),
      })
    ),
  ];

  const responses = await Promise.all(calls);
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(getSaveHostedCalls(), 1, 'archivePromise must deduplicate concurrent saveHostedGameSession calls to 1');

  const uniqueAttemptIds = new Set(savedAttempts.map(a => a.id));
  assert.equal(savedAttempts.length, 20);
  assert.equal(uniqueAttemptIds.size, 20);
  assert.ok(savedAttempts.every(a => a.id.startsWith('attempt-')));
});

test('concurrent POST /api/auth/register for same username allows one 200/201 and rejects others cleanly with 409', async t => {
  const { base } = await makeConcurrentServerHarness(t);

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(base + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'raceuser',
          displayName: 'Race User',
          password: 'Password123!',
          confirmPassword: 'Password123!',
        }),
      }).then(async r => ({ status: r.status, body: await r.json() }))
    )
  );

  assert.ok(results.every(r => r.status < 500), 'No 5xx errors allowed on duplicate registration race');
  const created = results.filter(r => r.status === 200 || r.status === 201);
  const conflicts = results.filter(r => r.status === 409);
  assert.equal(created.length, 1);
  assert.equal(conflicts.length, 7);
});
