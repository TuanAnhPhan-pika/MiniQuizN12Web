const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');

function loadModule(file, overrides = {}, tail = '', env = {}, clock = null) {
  const filename = path.join(ROOT, file);
  const realRequire = createRequire(filename);
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && clock) super(clock.now);
      else super(...args);
    }
    static now() { return clock ? clock.now : RealDate.now(); }
  }
  const timers = [];
  const context = {
    require: name => (Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)),
    module: { exports: {} },
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    Date: clock ? MockDate : Date,
    process: { env, exit: code => { throw new Error(`exit:${code}`); } },
    console: { log() {}, warn() {}, error() {} },
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      if (id && typeof id.unref === 'function') id.unref();
      timers.push(id);
      return id;
    },
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail,
    context,
    { filename }
  );
  return { exports: context.module.exports, timers };
}

function makeResilienceHarness(t, opts = {}) {
  const clock = opts.clock || null;
  let dbDelayMs = opts.dbDelayMs || 0;
  let failDbNow = false;
  const dbUsers = new Map();
  const dbSessions = new Map();
  let nextUserId = 1;

  const sampleQuiz = {
    id: 'res-quiz-1',
    title: 'Đề Chịu Tải',
    pointsPerQ: 100,
    timeLimit: 20,
    questions: [
      { text: 'Q1', choices: ['A', 'B', 'C', 'D'], correct: 0, points: 100 },
      { text: 'Q2 Multi', choices: ['1', '2', '3', '4'], correct: 1, correctChoices: [1, 3], isMultiple: true, points: 100 },
    ],
  };

  const delay = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

  const dbMock = {
    useSupabase: () => false,
    async getPrivateQuizzes() {
      if (failDbNow) throw new Error('Simulated DB outage');
      return [sampleQuiz];
    },
    async getPublicQuizzes() {
      if (failDbNow) throw new Error('Simulated DB outage');
      return [];
    },
    async getQuizById(id) {
      await delay(dbDelayMs);
      if (failDbNow) throw new Error('Simulated DB outage');
      return id === sampleQuiz.id ? JSON.parse(JSON.stringify(sampleQuiz)) : null;
    },
    async getPublicQuizById() { return null; },
    async getUserAttempts() {
      if (failDbNow) throw new Error('Simulated DB outage');
      return [];
    },
    async saveAttempt(rec) {
      if (failDbNow) throw new Error('Simulated DB outage');
      return rec;
    },
    async getHostedGameSessions() {
      if (failDbNow) throw new Error('Simulated DB outage');
      return [];
    },
    async createWaitingGameSession() {
      await delay(dbDelayMs);
      if (failDbNow) throw new Error('Simulated DB outage');
    },
    async saveHostedGameSession() {
      if (failDbNow) throw new Error('Simulated DB outage');
    },
    async findUserByUsername(username) {
      return dbUsers.get(String(username || '').toLowerCase()) || null;
    },
    async createUser({ username, displayName, passwordHash, salt }) {
      const lower = username.toLowerCase();
      if (dbUsers.has(lower)) throw new Error('duplicate key value violates unique constraint');
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
    async saveSession() {},
    async deleteSession() {},
    async deleteOtherSessions() {},
  };

  const pgMock = { async query() { return { rows: [] }; } };
  const authRes = loadModule('src/auth.js', { './db/index.js': dbMock, './db/pool.js': pgMock }, '', {}, clock);
  const auth = authRes.exports;
  const seeded = auth.hashPassword('Pass123!');
  auth.upsertUser({ id: 1, username: 'host1', displayName: 'Host 1', passwordHash: seeded.hash, salt: seeded.salt, role: 'teacher' });
  const hostTok = auth.createSession('host1');

  const roomsRes = loadModule('src/rooms/manager.js', { '../db/index.js': dbMock }, '', {}, clock);
  const rooms = roomsRes.exports;
  const geminiRes = loadModule('src/ai/gemini.js', {}, '', {}, clock);
  const gemini = geminiRes.exports;

  const srvRes = loadModule('src/server.js', {
    dotenv: { config() {} },
    './auth.js': auth,
    './db/index.js': dbMock,
    './db/pool.js': pgMock,
    './db/migrate.js': {},
    './rooms/manager.js': rooms,
    './ai/gemini.js': gemini,
  }, '\nmodule.exports = { server };', {}, clock);
  const { server } = srvRes.exports;

  t.after(() => {
    for (const id of [...roomsRes.timers, ...authRes.timers, ...srvRes.timers]) {
      clearInterval(id);
    }
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        server,
        auth,
        rooms,
        gemini,
        hostTok,
        setDbDelayMs: v => { dbDelayMs = v; },
        setFailDb: v => { failDbNow = v; },
      });
    });
  });
}

test('Resilience: malformed JSON and >2MB payloads return 400/413 cleanly across all POST endpoints without unhandled rejections', async t => {
  const { base, hostTok } = await makeResilienceHarness(t);

  const createRes = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
    body: JSON.stringify({ name: 'Phòng Fuzz', examId: 'res-quiz-1' }),
  });
  const { pin } = await createRes.json();

  // Malformed JSON against routes that previously lacked try/catch + guarded routes
  for (const pathUrl of [
    `/api/rooms/${pin}/join`,
    `/api/rooms/${pin}/answer`,
    `/api/rooms/${pin}/leave`,
    `/api/rooms/${pin}/score`,
    `/api/rooms/${pin}/advance`,
    `/api/rooms/${pin}/lock`,
    `/api/rooms/${pin}/start`,
    `/api/rooms/${pin}/kick`,
    '/api/auth/login',
    '/api/rooms',
  ]) {
    const res = await fetch(base + pathUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
      body: '{"broken": ',
    });
    assert.equal(res.status, 400, `Malformed JSON at ${pathUrl} should return 400`);
    const data = await res.json();
    assert.equal(data.success, false);
  }

  // > 2MB oversized JSON payload should return 413 cleanly and server must stay healthy
  const hugeBody = JSON.stringify({ data: 'X'.repeat(2_200_000) });
  for (const pathUrl of [`/api/rooms/${pin}/answer`, '/api/auth/login', '/api/rooms']) {
    const res = await fetch(base + pathUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
      body: hugeBody,
    });
    assert.equal(res.status, 413, `Oversized payload at ${pathUrl} should return 413`);
  }

  // Health check after abuse
  const stillAlive = await fetch(`${base}/api/rooms/${pin}/state`);
  assert.equal(stillAlive.status, 200);
});

test('Resilience: malformed Cookie URI encoding does not throw URIError or crash endpoints', async t => {
  const { base, hostTok, auth } = await makeResilienceHarness(t);
  assert.doesNotThrow(() => auth.parseCookies('mqc_session=%E0%A4%A; good=abc%2B1'));
  const parsed = JSON.parse(JSON.stringify(auth.parseCookies('mqc_session=%E0%A4%A; good=abc%2B1')));
  assert.equal(parsed.good, 'abc+1');

  const createRes = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
    body: JSON.stringify({ name: 'Cookie Resilience', examId: 'res-quiz-1' }),
  });
  const { pin } = await createRes.json();

  for (const url of [`/api/rooms/${pin}`, '/api/auth/me', '/index.html']) {
    const res = await fetch(base + url, {
      headers: { Cookie: 'mqc_session=%E0%A4%A; bad=%ZZ' },
    });
    assert.ok(res.status < 500, `${url} returned ${res.status} on malformed Cookie`);
  }
});

test('Resilience: concurrent POST /api/rooms with DB latency strictly enforces MAX_ROOMS_PER_HOST = 3', async t => {
  const { base, hostTok, rooms } = await makeResilienceHarness(t, { dbDelayMs: 30 });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      fetch(base + '/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
        body: JSON.stringify({ name: `Race Room ${i}`, examId: 'res-quiz-1' }),
      }).then(async r => ({ status: r.status, body: await r.json() }))
    )
  );

  const ok = results.filter(r => r.status === 200);
  const rejected = results.filter(r => r.status === 409);
  assert.equal(ok.length, 3, `Expected exactly 3 rooms created, got ${ok.length}`);
  assert.equal(rejected.length, 5, `Expected 5 conflicts, got ${rejected.length}`);
  assert.equal(rooms.countActiveRoomsByHost('host1'), 3);
});

test('Resilience: abrupt client socket disconnects and Slowloris HTTP timeouts stay bounded and stable', async t => {
  const { base, port, server, hostTok } = await makeResilienceHarness(t);

  // Server must define bounded HTTP timeouts (no 5-minute default exposure to Slowloris)
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 60_000, `requestTimeout=${server.requestTimeout}`);
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 30_000, `headersTimeout=${server.headersTimeout}`);

  const createRes = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
    body: JSON.stringify({ name: 'Socket Abort Test', examId: 'res-quiz-1' }),
  });
  const { pin } = await createRes.json();

  // Abrupt TCP disconnect mid-body
  await new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(`POST /api/rooms/${pin}/answer HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"playerId":`);
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 10);
    });
    sock.on('error', reject);
  });

  await new Promise(r => setTimeout(r, 30));
  const health = await fetch(`${base}/api/rooms/${pin}/state`);
  assert.equal(health.status, 200);
});

test('Resilience: DB outages degrade cleanly without crashing and recover once DB returns; pool preserves root tx error', async t => {
  // 1. pool.withTransaction preserves root query error even if ROLLBACK fails on dropped connection
  class DroppingClient {
    async query(sql) {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'ROLLBACK') throw new Error('socket closed during rollback');
      throw new Error('root DB query timeout');
    }
    release() { this.released = true; }
  }
  const client = new DroppingClient();
  const poolMod = loadModule('src/db/pool.js', {
    pg: { Pool: class { async connect() { return client; } on() {} } },
  }).exports;
  await assert.rejects(
    () => poolMod.withTransaction(c => c.query('SELECT 1')),
    err => err.message === 'root DB query timeout'
  );
  assert.equal(client.released, true);

  // 2. HTTP routes degrade cleanly with 500 JSON during runtime DB outage and recover immediately when DB comes back
  const { base, hostTok, setFailDb } = await makeResilienceHarness(t);
  setFailDb(true);
  const failedStorage = await fetch(base + '/api/storage/private', { headers: { Authorization: `Bearer ${hostTok}` } });
  assert.equal(failedStorage.status, 500);
  const failedRoom = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostTok}` },
    body: JSON.stringify({ name: 'DB Down Room', examId: 'res-quiz-1' }),
  });
  assert.equal(failedRoom.status, 500);

  // DB recovers -> routes immediately work again
  setFailDb(false);
  const recovered = await fetch(base + '/api/storage/private', { headers: { Authorization: `Bearer ${hostTok}` } });
  assert.equal(recovered.status, 200);
});

test('Resilience: in-memory rate-limit & session maps enforce bounds and prune expired entries under IP/session flood', () => {
  const clock = { now: 1_700_000_000_000 };
  const authRes = loadModule('src/auth.js', {
    './db/index.js': { async saveSession() {}, async deleteSession() {} },
    './db/pool.js': { async query() { return { rows: [] }; } },
  }, '', {}, clock);
  const auth = authRes.exports;
  const geminiRes = loadModule('src/ai/gemini.js', {}, '', {}, clock);
  const gemini = geminiRes.exports;

  // Simulate 15,000 unique spoofed IPs hitting register/login limiters across sliding windows
  for (let i = 0; i < 15_000; i++) {
    auth.checkRegisterLimit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    auth.recordLoginFailure(`192.168.${(i >> 8) & 255}.${i & 255}`);
    gemini.checkAiRateLimit(`user_${i}`, `172.16.${(i >> 8) & 255}.${i & 255}`);
  }

  // Advance past expiry (25 hours) and trigger a few checks
  clock.now += 25 * 60 * 60 * 1000;
  auth.checkRegisterLimit('1.1.1.1');
  auth.recordLoginFailure('1.1.1.1');
  gemini.checkAiRateLimit('fresh', '1.1.1.1');

  const authStats = auth.getSecurityMapStats ? auth.getSecurityMapStats() : null;
  const aiStats = gemini.getRateLimitBucketCount ? gemini.getRateLimitBucketCount() : null;

  assert.ok(authStats && authStats.loginAttempts <= 5000, `Unbounded loginAttempts map: ${JSON.stringify(authStats)}`);
  assert.ok(authStats && authStats.registerAttempts <= 5000, `Unbounded registerAttempts map: ${JSON.stringify(authStats)}`);
  assert.ok(aiStats !== null && aiStats <= 5000, `Unbounded AI rate bucket map: ${aiStats}`);
});

test('Stress benchmark: 3 concurrent rooms x 80 candidates (240 players) + burst polling & login, measuring errors and Event Loop lag', async t => {
  const { base, hostTok, rooms } = await makeResilienceHarness(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  t.after(() => agent.destroy());

  const reqJson = (urlPath, { method = 'GET', headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(base + urlPath, {
        method,
        agent,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : {}; } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });

  const loopMon = monitorEventLoopDelay({ resolution: 10 });
  loopMon.enable();

  const pins = [];
  for (let rIdx = 0; rIdx < 3; rIdx++) {
    const res = await reqJson('/api/rooms', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostTok}` },
      body: { name: `Stress Room ${rIdx}`, examId: 'res-quiz-1', capacity: 100 },
    });
    assert.equal(res.status, 200);
    pins.push(res.body.pin);
  }

  // 240 players join across 3 rooms concurrently over pooled keep-alive sockets
  const joinedAll = await Promise.all(
    pins.flatMap((pin, rIdx) =>
      Array.from({ length: 80 }, (_, pIdx) =>
        reqJson(`/api/rooms/${pin}/join`, {
          method: 'POST',
          body: { nick: `R${rIdx}_P${pIdx}` },
        }).then(r => ({ pin, status: r.status, body: r.body }))
      )
    )
  );
  assert.equal(joinedAll.length, 240);
  assert.ok(joinedAll.every(x => x.status === 200 && x.body?.player?.id));

  // Start all 3 rooms
  await Promise.all(pins.map(pin =>
    reqJson(`/api/rooms/${pin}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostTok}` },
      body: { countdownSec: 1 },
    })
  ));

  // Blast 240 /answer + 480 /state & /status + 10 concurrent /api/auth/login simultaneously
  const tStart = performance.now();
  const burst = [
    ...joinedAll.map((j, idx) =>
      reqJson(`/api/rooms/${j.pin}/answer`, {
        method: 'POST',
        body: {
          playerId: j.body.player.id,
          playerToken: j.body.player.playerToken,
          qIdx: 0,
          choice: idx % 4,
        },
      })
    ),
    ...joinedAll.flatMap(j => [
      reqJson(`/api/rooms/${j.pin}/state`),
      reqJson(`/api/rooms/${j.pin}/status`),
    ]),
    ...Array.from({ length: 10 }, (_, k) =>
      reqJson('/api/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': `203.0.113.${k + 1}` },
        body: { username: 'host1', password: 'WrongPassword!' },
      })
    ),
  ];

  const responses = await Promise.all(burst);
  const elapsedMs = Math.round(performance.now() - tStart);
  loopMon.disable();

  const p95LoopMs = Math.round((loopMon.percentile(95) / 1e6) * 100) / 100;
  const maxLoopMs = Math.round((loopMon.max / 1e6) * 100) / 100;
  console.log(`[Stress 240 players + 730 reqs] elapsed=${elapsedMs}ms p95_el_delay=${p95LoopMs}ms max_el_delay=${maxLoopMs}ms`);

  assert.ok(responses.every(r => r.status < 500), 'Zero 5xx expected during 730-request burst');
  for (const pin of pins) {
    const q0 = rooms.getRawRoom(pin).answers[0] || {};
    assert.equal(Object.keys(q0).length, 80, `Room ${pin} must record all 80 answers without loss`);
  }
});
