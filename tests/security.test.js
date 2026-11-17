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
  const forbidden = new Set(['correct', 'correctChoice', 'correctIndex', 'correctText', 'is_correct', 'isCorrect', 'scoreEarned', 'newTotalScore', 'explanation', 'playerToken', 'hostToken']);
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
  for (const badBody of [{}, { name: '   ' }, { name: '', title: 'Quiz' }, { title: '   ' }]) {
    const res = await post('/api/rooms', badBody, { ...hostHeaders, Origin: 'http://localhost:3000' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, 'Tên phòng thi không được để trống!');
  }
  const okRoom = await post('/api/rooms', { name: 'Phòng A', title: 'Đề Toán', questions: [{ text: 'Q', choices: ['1', '2'], correct: 0 }] }, { ...hostHeaders, Origin: 'http://localhost:3000' });
  assert.equal(okRoom.status, 200);
  const okRoomData = await okRoom.json();
  assert.equal(okRoomData.room.title, 'Phòng A');
  const room3 = await post('/api/rooms', { name: 'Phòng B', questions: [{ text: 'Q', choices: ['1', '2'], correct: 0 }] }, { ...hostHeaders, Origin: 'http://localhost:3000' });
  assert.equal(room3.status, 200);
  const overLimit = await post('/api/rooms', { name: 'Phòng D', questions: [{ text: 'Q', choices: ['1', '2'], correct: 0 }] }, { ...hostHeaders, Origin: 'http://localhost:3000' });
  assert.equal(overLimit.status, 409);
  assert.equal((await overLimit.json()).message, 'Số phòng bạn có thể giữ chỗ đã đạt giới hạn');
  assert.equal(rooms.countActiveRoomsByHost('teacher'), 3);
  for (const player of rooms.getRawRoom(room.pin).players.filter(p => !p.isHost)) { player.score = 100; player.streak = 2; }
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
    assert.deepEqual(Object.keys(accepted).sort(), ['success', 'qIdx', 'choice', 'answerAccepted'].sort());
    assert.ok(!Object.hasOwn(accepted, 'streak'));
    assert.equal(record.totalScoreAfter, 100 + record.scoreAwarded);
    assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === player.id).score, 100);
    assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === player.id).streak, 2);
    assert.ok(record.responseTimeMs >= 0);
    assert.equal((await (await post(route + '/answer', body)).json()).duplicate, true);
  }
  const hiddenBoard = await (await fetch(base + route + '/leaderboard')).json();
  assert.deepEqual(hiddenBoard.leaderboard.map(p => [p.id, p.score, p.streak]), [['a', 100, 2], ['b', 100, 2]]);
  // Repeating the host's open-question request must not refresh from live scores.
  await post(route + '/advance', { nextQ: 0, phase: 'question' }, hostHeaders);
  assert.equal(rooms.getLeaderboard(room.pin)[0].score, 100);
  for (const suffix of ['', '/status', '/score']) {
    const payload = await (await fetch(base + route + suffix)).json();
    const players = payload.room ? payload.room.players : payload.players;
    for (const player of players.filter(p => !p.isHost)) {
      assert.equal(player.score, 100);
      assert.equal(player.streak, 2);
    }
  }
  const metadata = await (await post(route + '/score', { playerId: 'a', playerToken: players[0].playerToken, score: 99999, streak: 99 })).json();
  assert.equal(Object.hasOwn(metadata.player, 'score'), false);
  assert.equal(Object.hasOwn(metadata.player, 'streak'), false);
  assert.ok(metadata.leaderboard.every(p => p.score === 100 && p.streak === 2));
  const rejoin = await (await post(route + '/join', { id: 'a', nick: 'a', playerToken: players[0].playerToken })).json();
  assert.equal(rejoin.room.players.find(p => p.id === 'a').score, 100);
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
  assert.equal(Object.hasOwn(result, 'playerResult'), false);
  const ownResult = async (id, token, q = 0) => fetch(base + route + `/result?q=${q}&playerId=${id}`, { headers: { 'X-Player-Token': token } });
  const unanswered = rooms.addPlayer(room.pin, { id: 'unanswered', nick: 'unanswered' }).player;
  assert.deepEqual((await (await ownResult('unanswered', unanswered.playerToken)).json()).playerResult, { choice: -1, isCorrect: false, scoreEarned: 0, totalScore: 0, streak: 0 });
  const aResult = await (await ownResult('a', players[0].playerToken)).json();
  const storedA = rooms.getRawRoom(room.pin).answers[0].a;
  assert.deepEqual(aResult.playerResult, { choice: 1, isCorrect: true, scoreEarned: storedA.scoreAwarded, totalScore: storedA.totalScoreAfter, streak: 3 });
  const bResult = await (await ownResult('b', players[1].playerToken)).json();
  assert.deepEqual(bResult.playerResult, { choice: 0, isCorrect: false, scoreEarned: 0, totalScore: 100, streak: 0 });
  assert.equal((await ownResult('a', players[1].playerToken)).status, 403);
  assert.equal((await ownResult('a', 'wrong')).status, 403);
  assert.equal((await fetch(base + route + '/result?q=0&playerId=a')).status, 403);
  const revealedBoard = rooms.getLeaderboard(room.pin);
  assert.equal(revealedBoard.find(p => p.id === 'a').score, storedA.totalScoreAfter);
  assert.equal(revealedBoard.find(p => p.id === 'a').streak, 3);
  assert.equal(result.correctChoice, 1);
  assert.equal(result.explanation, 'Because B');
  assert.deepEqual(result.distribution, [1, 1]);
  assert.equal((await fetch(base + route + '/result?q=1')).status, 403);
  assert.equal(rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: players[0].playerToken, qIdx: 0, choice: 1 }).rejected, true);
  await post(route + '/advance', { nextQ: 1, phase: 'question' }, hostHeaders);
  assert.equal(rooms.getRawRoom(room.pin).phase, 'question');
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').score, storedA.totalScoreAfter);
  rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: players[0].playerToken, qIdx: 1, choice: 0 });
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').score, storedA.totalScoreAfter);
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').streak, 3);
  noLeaks(await (await fetch(base + route)).json());
  assert.equal((await fetch(base + route + '/result?q=1')).status, 403);
  assert.equal((await fetch(base + route + '/result?q=0')).status, 403);
  await post('/api/history/hosted', { pin: room.pin }, hostHeaders);
  for (const q of [0, 1]) assert.equal((await fetch(base + route + '/result?q=' + q)).status, 200);
  assert.deepEqual((await (await ownResult('a', players[0].playerToken, 0)).json()).playerResult, aResult.playerResult);
  assert.equal((await ownResult('a', 'wrong', 1)).status, 403);
  const finished = await (await fetch(base + route)).json();
  assert.equal(finished.room.questions[1].correct, 0);
  assert.equal(JSON.stringify(finished).includes('playerToken'), false);
});


test('question snapshots preserve ranking, repeated opens, late joins and streak resets', async () => {
  const rooms = load('src/rooms/manager.js', { '../db/index.js': { async saveHostedGameSession() {} } });
  const room = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [
    { choices: ['A', 'B'], correct: 1 }, { choices: ['C', 'D'], correct: 0 },
  ] } });
  const a = rooms.addPlayer(room.pin, { id: 'a', nick: 'a' }).player;
  rooms.addPlayer(room.pin, { id: 'b', nick: 'b' });
  for (const player of room.players.filter(p => !p.isHost)) { player.score = 100; player.streak = 2; player.lastUpdated = player.id === 'a' ? 1 : 2; }
  rooms.startRoom(room.pin, 1);
  // The /status handler changes countdown to started without calling advance.
  room.status = 'started';
  rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: a.playerToken, qIdx: 0, choice: 1 });
  assert.equal(rooms.getLeaderboard(room.pin).map(p => p.id).join(','), 'a,b');
  assert.ok(rooms.getLeaderboard(room.pin).every(p => p.score === 100 && p.streak === 2));
  const score = room.players.find(p => p.id === 'a').score;
  assert.ok(score > 100);
  assert.equal(rooms.getLeaderboard(room.pin, true)[0].score, score);
  rooms.advanceQuestion(room.pin, 0, 'question');
  assert.equal(rooms.getLeaderboard(room.pin)[0].score, 100);
  const late = rooms.addPlayer(room.pin, { id: 'late', nick: 'late' }).player;
  rooms.submitAnswer(room.pin, { playerId: 'late', playerToken: late.playerToken, qIdx: 0, choice: 1 });
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'late').score, 0);
  rooms.advanceQuestion(room.pin, 0, 'result');
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').score, score);
  rooms.advanceQuestion(room.pin, 1, 'question');
  rooms.submitAnswer(room.pin, { playerId: 'a', playerToken: a.playerToken, qIdx: 1, choice: 1 });
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').streak, 3);
  assert.equal(room.players.find(p => p.id === 'a').streak, 0);
  rooms.advanceQuestion(room.pin, 1, 'question');
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').streak, 3);
  await rooms.finishAndArchiveRoom(room.pin);
  assert.equal(rooms.getLeaderboard(room.pin).find(p => p.id === 'a').streak, 0);
});

test('2s server lag grace window, UTC clock metadata, and multiple-choice all-or-nothing lifecycle', async t => {
  const savedAttempts = [];
  const db = {
    async saveAttempt(record) { savedAttempts.push(record); return record; },
    async saveHostedGameSession() {},
  };
  const rooms = load('src/rooms/manager.js', { '../db/index.js': db });
  const room = await rooms.createRoom({
    hostUsername: 'teacher',
    exam: {
      title: 'Multi & Grace Exam',
      questions: [
        { text: 'Single Q', choices: ['A', 'B'], correct: 1, timeLimit: 10 },
        { text: 'Multi Q', choices: ['2', '4', '5', '9'], correct: 0, correctChoices: [0, 2], isMultiple: true, timeLimit: 10 },
      ],
    },
  });
  const auth = {
    parseCookies: () => ({}),
    getSession: token => token === 'host' ? { username: 'teacher' } : (token === 'student' ? { username: 'alice' } : null),
    findUserByUsernameSync: u => u === 'teacher' ? { id: 1, role: 'teacher' } : { id: 7, role: 'student' },
  };
  const { server } = load('src/server.js', {
    dotenv: { config() {} }, './auth.js': auth, './db/index.js': db,
    './db/migrate.js': {}, './rooms/manager.js': rooms,
  }, '\nmodule.exports = { server };');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/api/rooms/${room.pin}`;
  const hostHeaders = { Authorization: 'Bearer host' };
  const post = (url, body, headers = {}) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  const pExact = (await (await post(route + '/join', { id: 'pExact', nick: 'exact' }, { Authorization: 'Bearer student' })).json()).player;
  const pPartial = (await (await post(route + '/join', { id: 'pPartial', nick: 'partial' })).json()).player;
  const pLateOk = (await (await post(route + '/join', { id: 'pLateOk', nick: 'lateok' })).json()).player;
  const pTooLate = (await (await post(route + '/join', { id: 'pTooLate', nick: 'toolate' })).json()).player;

  // Room & /state include UTC clock timestamps and never leak correct/correctChoices before reveal
  await post(route + '/advance', { nextQ: 0, phase: 'question' }, hostHeaders);
  const studentRoom = await (await fetch(base + route)).json();
  assert.equal(typeof studentRoom.room.serverNow, 'number');
  assert.equal(typeof studentRoom.room.questionStartedAt, 'number');
  assert.equal(studentRoom.room.questionDeadline, studentRoom.room.questionStartedAt + 10000);
  assert.equal(Object.hasOwn(studentRoom.room.questions[1], 'correctChoices'), false);
  assert.equal(studentRoom.room.questions[1].isMultiple, true);

  const stateRes = await (await fetch(base + route + '/state')).json();
  assert.equal(typeof stateRes.serverNow, 'number');
  assert.equal(stateRes.questionDeadline, stateRes.questionStartedAt + 10000);

  // Test 2-second grace window: 11.5s elapsed (within 10s + 2s grace) is accepted & clamped to 10s
  rooms.getRawRoom(room.pin).questionStartedAt = Date.now() - 11500;
  const lateOkRes = await (await post(route + '/answer', {
    playerId: pLateOk.id, playerToken: pLateOk.playerToken, qIdx: 0, choice: 1,
  })).json();
  assert.equal(lateOkRes.success, true);
  assert.equal(rooms.getRawRoom(room.pin).answers[0][pLateOk.id].responseTimeMs, 10000);

  // Test > 2-second grace window: 12.5s elapsed (past 10s + 2s grace) is rejected as timedOut
  rooms.getRawRoom(room.pin).questionStartedAt = Date.now() - 12500;
  const tooLateRes = await (await post(route + '/answer', {
    playerId: pTooLate.id, playerToken: pTooLate.playerToken, qIdx: 0, choice: 1,
  })).json();
  assert.equal(tooLateRes.success, false);
  assert.equal(tooLateRes.rejected, true);
  assert.equal(tooLateRes.timedOut, true);

  // Advance to Q1 (Multiple Choice: correct [0, 2])
  await post(route + '/advance', { nextQ: 1, phase: 'question' }, hostHeaders);

  // Exact match [2, 0] (unsorted from client) -> correct!
  const exactAns = await (await post(route + '/answer', {
    playerId: pExact.id, playerToken: pExact.playerToken, qIdx: 1, choices: [2, 0],
  })).json();
  assert.equal(exactAns.success, true);
  assert.deepEqual(exactAns.choices, [0, 2]);

  // Partial match [0] -> wrong (All-or-Nothing)
  await post(route + '/answer', {
    playerId: pPartial.id, playerToken: pPartial.playerToken, qIdx: 1, choices: [0],
  });

  // Extra match [0, 1, 2] -> wrong (All-or-Nothing)
  await post(route + '/answer', {
    playerId: pLateOk.id, playerToken: pLateOk.playerToken, qIdx: 1, choices: [0, 1, 2],
  });

  // Check /question-stats tallies all chosen options while counting unique players
  const qStats = await (await fetch(base + route + '/question-stats?q=1')).json();
  assert.equal(qStats.totalAnswered, 3);
  assert.deepEqual(qStats.choicesCount, [3, 1, 2, 0]);

  // Reveal Q1 result
  await post(route + '/advance', { nextQ: 1, phase: 'result' }, hostHeaders);
  const q1Result = await (await fetch(base + route + '/result?q=1&playerId=' + pExact.id, {
    headers: { 'X-Player-Token': pExact.playerToken },
  })).json();
  assert.equal(q1Result.isMultiple, true);
  assert.deepEqual(q1Result.correctChoices, [0, 2]);
  assert.equal(q1Result.correctText, '2, 5');
  assert.deepEqual(q1Result.distribution, [3, 1, 2, 0]);
  assert.equal(q1Result.playerResult.isCorrect, true);
  assert.deepEqual(q1Result.playerResult.choices, [0, 2]);

  const partialResult = await (await fetch(base + route + '/result?q=1&playerId=' + pPartial.id, {
    headers: { 'X-Player-Token': pPartial.playerToken },
  })).json();
  assert.equal(partialResult.playerResult.isCorrect, false);
  assert.equal(partialResult.playerResult.scoreEarned, 0);

  // Finish & verify calculateExamStats + POST /api/history details
  await post('/api/history/hosted', { pin: room.pin }, hostHeaders);
  const histRes = await post('/api/history', { pin: room.pin, playerId: pExact.id, playerToken: pExact.playerToken }, { Authorization: 'Bearer student' });
  assert.equal(histRes.status, 200);
  assert.equal(savedAttempts.length, 1);
  assert.equal(savedAttempts[0].answersDetail[1].questionType, 'multiple');
  assert.deepEqual(Array.from(savedAttempts[0].answersDetail[1].correctChoices), [0, 2]);
  assert.deepEqual(Array.from(savedAttempts[0].answersDetail[1].userChoices), [0, 2]);
  assert.equal(savedAttempts[0].answersDetail[1].isCorrect, true);
});

test('PG multi-choice persistence round-trip and ExamImporter multi-choice parsing', async () => {
  // 1. PG formatQuizWithQuestionsPG & public privacy check for multi-choice
  const pg = {
    async query(sql) {
      if (/FROM quizzes/.test(sql)) return { rows: [{ id: 'mq1', is_public: true }] };
      if (/FROM quiz_questions/.test(sql)) return { rows: [{ version_id: 'v1', explanation: '' }] };
      return {
        rows: [
          { content: '2', is_correct: true },
          { content: '4', is_correct: false },
          { content: '5', is_correct: true },
          { content: '9', is_correct: false },
        ],
      };
    },
  };
  const db = load('src/db/index.js', { './pool.js': pg, '@supabase/supabase-js': {} });
  const pub = await db.getPublicQuizById('mq1');
  assert.equal(pub.questions[0].isMultiple, true);
  assert.equal(Object.hasOwn(pub.questions[0], 'correct'), false);
  assert.equal(Object.hasOwn(pub.questions[0], 'correctChoices'), false);

  const internal = await db.getPublicQuizById('mq1', { includeCorrect: true });
  assert.equal(internal.questions[0].isMultiple, true);
  assert.equal(internal.questions[0].correct, 0);
  assert.deepEqual(Array.from(internal.questions[0].correctChoices), [0, 2]);

  // 2. ExamImporter multi-choice parsing (Text/Word, Aiken, end key, Excel rows, CSV)
  const importerCtx = { console, window: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve('public/js/exam-importer.js'), 'utf8'), importerCtx);
  const ExamImporter = importerCtx.window.ExamImporter;

  const textRes = ExamImporter.parseVnText(`
Câu 1: Số nào là số nguyên tố?
*A. 2
B. 4
*C. 5
D. 9

Câu 2: Ngôn ngữ web?
A. JavaScript
B. HTML
C. C++
D. CSS
Đáp án: A, B, D

Câu 3: Thử bảng đáp án cuối đề
A. Một
B. Hai
C. Ba
D. Bốn

Đáp án:
3. A, C
  `);
  assert.equal(textRes.questions.length, 3);
  assert.deepEqual(Array.from(textRes.questions[0].correctChoices), [0, 2]);
  assert.equal(textRes.questions[0].isMultiple, true);
  assert.deepEqual(Array.from(textRes.questions[1].correctChoices), [0, 1, 3]);
  assert.equal(textRes.questions[1].isMultiple, true);
  assert.deepEqual(Array.from(textRes.questions[2].correctChoices), [0, 2]);
  assert.equal(textRes.questions[2].isMultiple, true);

  const excelRes = ExamImporter.parseExcelRows([
    ['Câu hỏi', 'A', 'B', 'C', 'D', 'Đáp án'],
    ['Chọn nguyên âm', 'a', 'b', 'e', 'd', 'A, C'],
  ]);
  assert.equal(excelRes.questions.length, 1);
  assert.deepEqual(Array.from(excelRes.questions[0].correctChoices), [0, 2]);
  assert.equal(excelRes.questions[0].isMultiple, true);

  const csvRes = ExamImporter.parseCsv('Câu hỏi,A,B,C,D,Đáp án\n"Chọn 2 số chẵn",1,2,3,4,"B, D"');
  assert.equal(csvRes.questions.length, 1);
  assert.deepEqual(Array.from(csvRes.questions[0].correctChoices), [1, 3]);
  assert.equal(csvRes.questions[0].isMultiple, true);
});

test('Public share copy similarity check enforces 10% threshold using full parent answers', async t => {
  const parentPublicExam = {
    id: 'pub-orig-1',
    code: '#orig',
    title: 'Đề kiểm tra Lịch sử Việt Nam cổ đại và trung đại',
    isPublic: true,
    questions: [
      {
        text: 'Chiến thắng Bạch Đằng năm 938 do ai lãnh đạo để đánh bại quân Nam Hán?',
        choices: ['Ngô Quyền', 'Lê Hoàn', 'Lý Thường Kiệt', 'Trần Hưng Đạo'],
        correct: 0,
      },
      {
        text: 'Nhà Lý dời đô từ Hoa Lư ra thành Đại La và đổi tên thành Thăng Long vào năm nào?',
        choices: ['Năm 968', 'Năm 1010', 'Năm 1054', 'Năm 1225'],
        correct: 1,
      },
    ],
  };

  let savedPublicCount = 0;
  const savedPrivateCopy = {
    id: 'priv-copy-1',
    code: '#c999',
    parentCode: '#orig',
    title: parentPublicExam.title,
    questions: parentPublicExam.questions,
  };

  const db = {
    async saveAttempt() {},
    async saveHostedGameSession() {},
    async getPublicQuizzes() {
      // Public list omits correct answers just like production
      return [{
        ...parentPublicExam,
        questions: parentPublicExam.questions.map(q => ({ text: q.text, choices: q.choices })),
      }];
    },
    async getPublicQuizById(id, options = {}) {
      if (id !== '#orig' && id !== 'pub-orig-1') return null;
      if (options.includeCorrect) return JSON.parse(JSON.stringify(parentPublicExam));
      return {
        ...parentPublicExam,
        questions: parentPublicExam.questions.map(q => ({ text: q.text, choices: q.choices })),
      };
    },
    async getQuizById(id) {
      if (id === 'priv-copy-1') return JSON.parse(JSON.stringify(savedPrivateCopy));
      return null;
    },
    async saveQuiz(exam, owner, isPublic) {
      if (isPublic) savedPublicCount++;
      return { ...exam, isPublic };
    },
  };

  const rooms = load('src/rooms/manager.js', { '../db/index.js': db });
  const auth = {
    parseCookies: () => ({}),
    getSession: token => token === 'teacher-session' ? { username: 'teacher' } : null,
    findUserByUsernameSync: () => ({ id: 10, role: 'teacher' }),
  };
  const { server } = load('src/server.js', {
    dotenv: { config() {} }, './auth.js': auth, './db/index.js': db,
    './db/migrate.js': {}, './rooms/manager.js': rooms,
  }, '\nmodule.exports = { server };');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(url + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer teacher-session' },
    body: JSON.stringify(body),
  });

  // 1. Unchanged copy (same content & same answers) -> 0% diff -> rejected
  const checkUnchanged = await (await post('/api/storage/public/check-share', { exam: savedPrivateCopy })).json();
  assert.equal(checkUnchanged.success, true);
  assert.equal(checkUnchanged.allowed, false);
  assert.equal(checkUnchanged.diffPercent, 0);
  assert.equal(Object.hasOwn(checkUnchanged, 'questions'), false);

  const shareUnchangedRes = await post('/api/storage/public/share', { exam: savedPrivateCopy });
  assert.equal(shareUnchangedRes.status, 409);
  const shareUnchangedData = await shareUnchangedRes.json();
  assert.equal(shareUnchangedData.code, 'COPY_SIMILARITY_TOO_HIGH');
  assert.equal(shareUnchangedData.diffPercent, 0);
  assert.equal(savedPublicCount, 0);

  // 2. Shuffled questions & shuffled choices -> still 0% diff -> rejected 409
  const shuffledCopy = {
    ...savedPrivateCopy,
    questions: [
      {
        text: parentPublicExam.questions[1].text,
        choices: ['Năm 1225', 'Năm 1010', 'Năm 968', 'Năm 1054'],
        correct: 1,
      },
      {
        text: parentPublicExam.questions[0].text,
        choices: ['Trần Hưng Đạo', 'Lý Thường Kiệt', 'Ngô Quyền', 'Lê Hoàn'],
        correct: 2,
      },
    ],
  };
  assert.equal((await post('/api/storage/public/share', { exam: shuffledCopy })).status, 409);
  assert.equal(savedPublicCount, 0);

  // 3. Minor edit (< 10%) & client omitted parentCode -> server resolves parentCode via DB id & rejects 409
  const minorEditCopy = {
    id: 'priv-copy-1',
    code: '#c999',
    title: 'Đề kiểm tra Lịch sử Việt Nam cổ đại và trung đại 2',
    questions: parentPublicExam.questions,
  };
  const minorRes = await post('/api/storage/public/share', { exam: minorEditCopy });
  assert.equal(minorRes.status, 409);
  const minorData = await minorRes.json();
  assert.ok(minorData.diffPercent > 0 && minorData.diffPercent < 10);
  assert.equal(savedPublicCount, 0);

  // 4. Substantial edit (>= 10%) -> allowed & published (200)
  const majorEditCopy = {
    ...savedPrivateCopy,
    title: 'Bộ đề ôn tập chuyên sâu Lịch sử Việt Nam thời phong kiến',
    questions: [
      {
        text: 'Ai là người sáng lập triều đại nhà Lý và ban Chiếu dời đô năm 1010?',
        choices: ['Lý Công Uẩn', 'Lý Thường Kiệt', 'Đinh Bộ Lĩnh', 'Lê Đại Hành'],
        correct: 0,
      },
      ...parentPublicExam.questions.slice(1),
    ],
  };
  const checkMajor = await (await post('/api/storage/public/check-share', { exam: majorEditCopy })).json();
  assert.equal(checkMajor.allowed, true);
  assert.ok(checkMajor.diffPercent >= 10);

  const shareMajorRes = await post('/api/storage/public/share', { exam: majorEditCopy });
  assert.equal(shareMajorRes.status, 200);
  const shareMajorData = await shareMajorRes.json();
  assert.equal(shareMajorData.success, true);
  assert.equal(savedPublicCount, 1);

  // 5. Original exam (no parentCode) even with colliding code '#orig' -> NOT blocked by false parentCode fallback
  const brandNewExam = {
    id: 'priv-new-1',
    code: '#orig',
    title: parentPublicExam.title,
    questions: parentPublicExam.questions,
  };
  const brandNewRes = await post('/api/storage/public/share', { exam: brandNewExam });
  assert.equal(brandNewRes.status, 200);
  const brandNewData = await brandNewRes.json();
  assert.equal(brandNewData.success, true);
  assert.notEqual(brandNewData.shareCode, '#orig');
  assert.equal(savedPublicCount, 2);
});

