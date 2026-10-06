const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');

// Run production modules with isolated dependencies; never touch deployed data.
function load(file, overrides = {}, tail = '', env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const context = {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename), Buffer, URL,
    process: { env, exit: code => { throw new Error(`exit:${code}`); } },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {}, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail, context, { filename });
  return context.module.exports;
}

test('room binding, token isolation, concurrent archive and failed archive retry', async () => {
  let calls = 0;
  let fail = true;
  const ids = [];
  const rooms = load('src/rooms/manager.js', { '../db/index.js': {
    async saveHostedGameSession(host, record) {
      calls++; ids.push(record.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (fail) throw new Error('DB down');
    },
  } });
  const a = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [] } });
  const b = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [] } });
  const pin = a.pin;
  const joined = rooms.addPlayer(pin, { id: 'p1', nick: 'someone', accountUserId: 7, accountUsername: 'alice' });
  const guest = rooms.addPlayer(pin, { id: 'guest', nick: 'alice' });
  assert.equal(rooms.getRawRoom(pin).players.find(p => p.id === 'p1').accountUserId, 7);
  assert.equal(rooms.getRawRoom(pin).players.find(p => p.id === 'guest').accountUserId, null);
  assert.equal(rooms.verifyPlayer(rooms.getRawRoom(b.pin), 'p1', joined.player.playerToken), null);
  assert.equal(rooms.addPlayer(pin, { id: 'p1', nick: 'someone', playerToken: joined.player.playerToken, accountUserId: 8 }).success, false);
  await assert.rejects(rooms.finishAndArchiveRoom(pin), /DB down/);
  assert.ok(!rooms.getRawRoom(pin).isArchived);
  fail = false;
  await Promise.all([rooms.finishAndArchiveRoom(pin), rooms.finishAndArchiveRoom(pin)]);
  await rooms.finishAndArchiveRoom(pin);
  assert.equal(calls, 2);
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], rooms.getRawRoom(pin).sessionId);
  assert.ok(guest.player.playerToken);
});

test('HTTP CORS, authenticated join, history identity and stable retry', async t => {
  const attempts = new Map();
  let copies = 0;
  let clone = null;
  const db = {
    async saveAttempt(record) { attempts.set(record.id, record); return record; },
    async saveHostedGameSession() {},
    async getPublicQuizById(id, options) {
      if (id !== 'public') return null;
      assert.equal(options.includeCorrect, true);
      return { id: 'public', questions: [{ correct: 1 }] };
    },
    async incrementQuizCopiesIssued(id) { assert.equal(id, 'public'); copies++; },
    async saveQuiz(exam, owner, isPublic) {
      assert.notEqual(exam.id, 'public');
      assert.equal(isPublic, false);
      assert.equal(owner, 'alice');
      clone = exam;
      return exam;
    },
  };
  const rooms = load('src/rooms/manager.js', { '../db/index.js': db });
  const room = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [] } });
  const auth = {
    parseCookies: () => ({}),
    getSession: token => token === 'session' ? { username: 'alice' } : null,
    findUserByUsernameSync: () => ({ id: 7, role: 'student' }),
  };
  const { server } = load('src/server.js', {
    dotenv: { config() {} }, './auth.js': auth, './db/index.js': db,
    './db/migrate.js': {}, './rooms/manager.js': rooms,
  }, '\nmodule.exports = { server };');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, headers = {}) {
    return fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  }
  const denied = await fetch(url + '/api/server-info', { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const allowed = await fetch(url + '/api/server-info', { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.match(allowed.headers.get('access-control-allow-headers'), /X-Player-Token/);
  assert.equal((await fetch(url + '/api/server-info', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  const join = await (await post(`/api/rooms/${room.pin}/join`, { id: 'p1', nick: 'other', accountUserId: 999 }, { Authorization: 'Bearer session' })).json();
  assert.equal(rooms.getRawRoom(room.pin).players.find(p => p.id === 'p1').accountUserId, 7);
  await post(`/api/rooms/${room.pin}/join`, { id: 'guest', nick: 'alice', accountUsername: 'alice' });
  assert.equal(rooms.getRawRoom(room.pin).players.find(p => p.id === 'guest').accountUsername, null);
  rooms.getRawRoom(room.pin).status = 'finished';
  const bad = await post('/api/history', { pin: room.pin, playerId: 'p1', playerToken: 'wrong' }, { Authorization: 'Bearer session' });
  assert.equal(bad.status, 403);
  for (let i = 0; i < 2; i++) {
    assert.equal((await post('/api/history', { pin: room.pin, playerId: 'p1', playerToken: join.player.playerToken }, { Authorization: 'Bearer session' })).status, 200);
  }
  assert.equal(attempts.size, 1);
  assert.equal([...attempts.keys()][0], `attempt-${rooms.getRawRoom(room.pin).sessionId}-p1`);
  assert.equal((await post('/api/history', { pin: room.pin }, { Authorization: 'Bearer session' })).status, 200);
  assert.equal(attempts.size, 1); // Account binding chooses p1, never guest nick='alice'.
  assert.equal((await post('/api/storage/public/save-to-private', { examId: 'private' }, { Authorization: 'Bearer session' })).status, 404);
  assert.equal(copies, 0);
  assert.equal((await post('/api/storage/public/save-to-private', { examId: 'public' }, { Authorization: 'Bearer session' })).status, 200);
  assert.equal(copies, 1);
  assert.equal(clone.questions[0].correct, 1);
});

test('PG attempts and answers use conflict handling; counter updates only quizzes', async () => {
  const statements = [];
  const pg = {
    async query(sql, params) { statements.push({ sql, params }); return { rows: sql.startsWith('UPDATE') ? [{ copies_issued: 1 }] : [] }; },
    async withTransaction(fn) { return fn(this); },
  };
  const db = load('src/db/index.js', { './pool.js': pg, '@supabase/supabase-js': {} });
  const record = { id: 'attempt-session-p1', gameSessionId: 'session', username: 'alice', answersDetail: [{ questionIndex: 0 }] };
  await db.saveAttempt(record);
  await db.saveAttempt(record);
  assert.ok(statements.filter(s => /INSERT INTO attempts /.test(s.sql)).every(s => /ON CONFLICT \(id\)/.test(s.sql)));
  assert.ok(statements.filter(s => /INSERT INTO attempt_answers /.test(s.sql)).every(s => /ON CONFLICT \(attempt_id, question_index\) DO NOTHING/.test(s.sql)));
  statements.length = 0;
  assert.equal(await db.incrementQuizCopiesIssued('quiz'), 1);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /is_public = true/);
  assert.doesNotMatch(statements[0].sql, /question_versions|quiz_questions/);
  await db.getPublicQuizById('private');
  assert.match(statements[1].sql, /is_public = true/);
  assert.match(statements[1].sql, /deleted_at IS NULL/);
  assert.match(statements[1].sql, /archived/);
  assert.throws(() => load('src/db/index.js', { './pool.js': pg, '@supabase/supabase-js': {} }, '', { DATA_BACKEND: 'supabase' }), /DATA_BACKEND=pg/);
});

test('auth initialization errors propagate and startup fails before listen', async () => {
  const auth = load('src/auth.js', {
    './db/index.js': { useSupabase: () => false },
    './db/pool.js': { query: async () => { throw new Error('DB down'); } },
  });
  await assert.rejects(auth.initAuth(), /DB down/);
  let listens = 0;
  const overrides = {
    dotenv: { config() {} }, http: { createServer: () => ({ listen() { listens++; } }) },
    './auth.js': auth, './db/index.js': {}, './rooms/manager.js': {},
    './db/migrate.js': { runMigration: async () => { throw new Error('DB down'); } },
  };
  for (const env of [{}, { DATABASE_URL: 'postgres://unreachable' }]) {
    const { startServer } = load('src/server.js', overrides, '\nmodule.exports = { startServer };', env);
    await assert.rejects(startServer(), /exit:1/);
  }
  assert.equal(listens, 0);
});

test('player storage has no global reads or persistent token writes', () => {
  for (const file of ['public/js/room.js', 'public/js/waiting-room-for-guests.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /getItem\(['"]mqc_my_player_(?:token|id)['"]\)/);
    assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(?:playerToken|myPlayerToken)/);
    assert.match(source, /removeItem\('mqc_my_player_token_' \+ PIN\)/);
  }
});

test('real Node startup exits on unavailable PostgreSQL', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['src/server.js'], {
    env: { ...process.env, DATA_BACKEND: 'pg', ALLOW_OFFLINE_MODE: 'false',
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /server running at/);
});

test('public quiz omits correct answers and explanations unless explicitly internal', async () => {
  const pg = { async query(sql) {
    if (/FROM quizzes/.test(sql)) return { rows: [{ id: 'quiz', is_public: true }] };
    if (/FROM quiz_questions/.test(sql)) return { rows: [{ version_id: 'v1', explanation: 'Answer is B' }] };
    return { rows: [{ content: 'A', is_correct: false }, { content: 'B', is_correct: true }] };
  } };
  const db = load('src/db/index.js', { './pool.js': pg, '@supabase/supabase-js': {} });
  const publicQuiz = await db.getPublicQuizById('quiz');
  assert.equal(Object.hasOwn(publicQuiz.questions[0], 'correct'), false);
  assert.equal(publicQuiz.questions[0].explanation, '');
  assert.equal((await db.getPublicQuizById('quiz', { includeCorrect: true })).questions[0].correct, 1);
});


test('delayed answer reveal, phase gates, host auth and Origin rejection over HTTP', async t => {
  const rooms = load('src/rooms/manager.js', { '../db/index.js': { async saveHostedGameSession() {} } });
  const room = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [
    { text: 'Q1', choices: ['A', 'B'], correct: 1, explanation: 'Because B', timeLimit: 15 },
    { text: 'Q2', choices: ['C', 'D'], correct: 0, explanation: 'Because C' },
  ] } });
  const auth = { parseCookies: () => ({}), getSession: token => token === 'host' ? { username: 'teacher' } : null,
    findUserByUsernameSync: () => ({ id: 1, role: 'teacher' }) };
  const { server } = load('src/server.js', { dotenv: { config() {} }, './auth.js': auth,
    './db/index.js': {}, './db/migrate.js': {}, './rooms/manager.js': rooms }, '\nmodule.exports = { server };');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/api/rooms/${room.pin}`;
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const forbidden = new Set(['correct', 'correctChoice', 'correctIndex', 'correctText', 'is_correct', 'isCorrect', 'explanation', 'playerToken', 'hostToken']);
  function noLeaks(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `Leaked ${key}`);
      noLeaks(nested);
    }
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const url of ['/api/rooms', '/api/auth/change-profile']) {
      assert.equal((await fetch(base + url, { method, headers: { Origin: 'https://evil.example' } })).status, 403);
    }
  }
  assert.equal((await post('/api/rooms', {}, { Origin: 'http://localhost:3000' })).status, 401);
  const players = [];
  for (const id of ['a', 'b']) {
    const joined = await (await post(route + '/join', { id, nick: id }, { Origin: 'http://localhost:3000' })).json();
    assert.equal(joined.success, true);
    noLeaks(joined.room);
    players.push(joined.player);
  }
  assert.equal((await post(route + '/advance', { nextQ: 0, phase: 'question', isHost: true })).status, 401);
  const hostHeaders = { Authorization: 'Bearer host' };
  assert.equal((await post(route + '/advance', { nextQ: 0, phase: 'question' }, hostHeaders)).status, 200);
  const invalidToken = rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: 'wrong', qIdx: 0, choice: 1 });
  assert.equal(invalidToken.unauthorized, true);
  assert.equal(rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: players[0].playerToken, qIdx: 1, choice: 0 }).rejected, true);
  assert.equal(rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: players[0].playerToken, qIdx: 0, choice: 99 }).invalidChoice, true);
  const phaseStartedAt = rooms.getRawRoom(room.pin).phaseStartedAt;
  assert.equal((await post(route + '/advance', { nextQ: 1, phase: 'question' }, { ...hostHeaders, Origin: 'https://evil.example' })).status, 403);
  assert.equal(rooms.getRawRoom(room.pin).currentQ, 0);
  assert.equal(rooms.getRawRoom(room.pin).phaseStartedAt, phaseStartedAt);
  for (const [i, player] of players.entries()) {
    const body = { playerId: player.id, playerToken: player.playerToken, qIdx: 0, choice: i ? 0 : 1, responseTimeMs: -9999, score: 99999 };
    const accepted = await (await post(route + '/answer', body)).json();
    assert.equal(accepted.answerAccepted, true);
    noLeaks(accepted);
    const record = rooms.getRawRoom(room.pin).answers[0][player.id];
    assert.equal(record.isCorrect, i === 0);
    assert.equal(accepted.scoreEarned, record.scoreAwarded);
    assert.ok(record.responseTimeMs >= 0);
    assert.equal((await (await post(route + '/answer', body)).json()).duplicate, true);
  }
  for (const suffix of ['', '/status', '/state', '/question-stats?q=0', '/leaderboard', '?role=host', '/result?q=0&role=host']) {
    noLeaks(await (await fetch(base + route + suffix)).json());
  }
  assert.equal((await fetch(base + route + '/result?q=0')).status, 403);
  assert.equal((await fetch(base + route + '/exam-stats')).status, 403);
  assert.equal((await fetch(base + route + '/exam-stats', { headers: hostHeaders })).status, 200);
  const hostRoom = await (await fetch(base + route, { headers: hostHeaders })).json();
  assert.equal(hostRoom.room.questions[0].correct, 1);
  for (const q of ['-1', '0.5', 'NaN', '', '2', '1e0']) {
    assert.equal((await fetch(base + route + '/result?q=' + q)).status, 400);
  }
  await post(route + '/advance', { nextQ: 0, phase: 'result' }, hostHeaders);
  const result = await (await fetch(base + route + '/result?q=0')).json();
  assert.equal(result.correctChoice, 1);
  assert.equal(result.explanation, 'Because B');
  assert.deepEqual(result.distribution, [1, 1]);
  assert.equal((await fetch(base + route + '/result?q=1')).status, 403);
  assert.equal(rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: players[0].playerToken, qIdx: 0, choice: 1 }).rejected, true);
  await post(route + '/advance', { nextQ: 1, phase: 'question' }, hostHeaders);
  assert.equal(rooms.getRawRoom(room.pin).phase, 'question');
  noLeaks(await (await fetch(base + route)).json());
  assert.equal((await fetch(base + route + '/result?q=1')).status, 403);
  assert.equal((await fetch(base + route + '/result?q=0')).status, 403);
  await post('/api/history/hosted', { pin: room.pin }, hostHeaders);
  for (const q of [0, 1]) assert.equal((await fetch(base + route + '/result?q=' + q)).status, 200);
  const finished = await (await fetch(base + route)).json();
  assert.equal(finished.room.questions[1].correct, 0);
  assert.equal(JSON.stringify(finished).includes('playerToken'), false);
});
