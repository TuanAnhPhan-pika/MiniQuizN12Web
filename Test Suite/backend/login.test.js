const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

function loadModule(file, overrides = {}, tail = '', env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const context = {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
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
  const source = fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '');
  vm.runInNewContext(source + tail, context, { filename });
  return context.module.exports;
}

function createPgHarness(options = {}) {
  const salt = 'e907bf8186544038a71f3483b6b70620';
  const hash = crypto.scryptSync('Pass123456!', salt, 64).toString('hex');
  const state = {
    users: [
      {
        id: 1,
        username: 'student_demo',
        username_lower: 'student_demo',
        display_name: 'Sinh viên Demo',
        password_hash: hash,
        salt,
        created_at: 1700000000000,
        last_name_change_at: 0,
        last_password_change_at: 0,
      },
    ],
    profiles: [
      {
        id: 1,
        user_id: 1,
        username: 'student_demo',
        display_name: 'Sinh viên Demo',
        avatar: '01',
        bio: '',
        role: 'student',
      },
    ],
    user_sessions: [],
    sqlLog: [],
    failSaveSession: !!options.failSaveSession,
  };

  const pg = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.sqlLog.push({ sql: normalized, params });

      if (/FROM users u/i.test(normalized) && /WHERE u\.username_lower = \$1/i.test(normalized)) {
        const lower = String(params[0] || '').toLowerCase();
        const u = state.users.find(row => row.username_lower === lower);
        if (!u) return { rows: [], rowCount: 0 };
        const p = state.profiles.find(row => row.user_id === u.id) || {};
        return { rows: [{ ...u, avatar: p.avatar, bio: p.bio, role: p.role }], rowCount: 1 };
      }

      if (/FROM users u/i.test(normalized)) {
        return {
          rows: state.users.map(u => {
            const p = state.profiles.find(row => row.user_id === u.id) || {};
            return { ...u, avatar: p.avatar, bio: p.bio, role: p.role };
          }),
          rowCount: state.users.length,
        };
      }

      if (/SELECT token, username, created_at, expires_at FROM user_sessions WHERE expires_at > \$1/i.test(normalized)) {
        const now = Number(params[0]);
        const rows = state.user_sessions.filter(s => s.expires_at > now);
        return { rows, rowCount: rows.length };
      }

      if (/INSERT INTO user_sessions/i.test(normalized)) {
        if (state.failSaveSession) {
          throw new Error('Simulated PostgreSQL write failure');
        }
        const [token, username, createdAt, expiresAt] = params;
        const existing = state.user_sessions.find(s => s.token === token);
        if (existing) {
          existing.expires_at = expiresAt;
        } else {
          state.user_sessions.push({ token, username, created_at: createdAt, expires_at: expiresAt });
        }
        return { rows: [], rowCount: 1 };
      }

      if (/DELETE FROM user_sessions WHERE token = \$1/i.test(normalized)) {
        const before = state.user_sessions.length;
        state.user_sessions = state.user_sessions.filter(s => s.token !== params[0]);
        return { rows: [], rowCount: before - state.user_sessions.length };
      }

      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      return fn(this);
    },
  };

  return { state, pg };
}

async function createLoginServer(t, options = {}) {
  const { state, pg } = createPgHarness(options);
  const db = loadModule('src/db/index.js', {
    './pool.js': pg,
    '@supabase/supabase-js': { createClient() { return {}; } },
  });
  const auth = loadModule('src/auth.js', {
    './db/index.js': db,
    './db/pool.js': pg,
  });
  await auth.initAuth();

  const { server } = loadModule(
    'src/server.js',
    {
      dotenv: { config() {} },
      './auth.js': auth,
      './db/index.js': db,
      './db/migrate.js': { async runMigration() {} },
      './rooms/manager.js': { getRawRoom: () => null },
    },
    '\nmodule.exports = { server };'
  );

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, state, auth };
}

test('TC01 (R1): valid login returns 200, sets cookie/token, and creates exactly 1 user_sessions row', async (t) => {
  const { baseUrl, state } = await createLoginServer(t);
  assert.equal(state.user_sessions.length, 0);

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student_demo', password: 'Pass123456!' }),
  });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.equal(data.username, 'student_demo');
  assert.equal(data.displayName, 'Sinh viên Demo');
  assert.equal(data.user.role, 'student');
  assert.match(data.token, /^[a-f0-9]{64}$/);
  assert.match(res.headers.get('set-cookie') || '', new RegExp(`mqc_session=${data.token}`));

  assert.equal(state.user_sessions.length, 1);
  assert.equal(state.user_sessions[0].username, 'student_demo');
  assert.equal(state.user_sessions[0].token, data.token);
  assert.equal(
    state.sqlLog.filter(entry => /INSERT INTO user_sessions/i.test(entry.sql)).length,
    1
  );

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  const meData = await meRes.json();
  assert.equal(meRes.status, 200);
  assert.equal(meData.authenticated, true);
  assert.equal(meData.username, 'student_demo');
});

test('TC02 (R2): wrong password or unknown account returns 401 and creates 0 user_sessions rows', async (t) => {
  const { baseUrl, state } = await createLoginServer(t);
  assert.equal(state.user_sessions.length, 0);

  const wrongPassRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student_demo', password: 'SaiMatKhau123' }),
  });
  const wrongPassData = await wrongPassRes.json();

  assert.equal(wrongPassRes.status, 401);
  assert.equal(wrongPassData.success, false);
  assert.equal(wrongPassData.code, 'INVALID_CREDENTIALS');
  assert.equal(wrongPassRes.headers.get('set-cookie'), null);
  assert.equal(state.user_sessions.length, 0);

  const unknownUserRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'unknown_user', password: 'Pass123456!' }),
  });
  const unknownUserData = await unknownUserRes.json();

  assert.equal(unknownUserRes.status, 401);
  assert.equal(unknownUserData.success, false);
  assert.equal(unknownUserData.code, 'INVALID_CREDENTIALS');
  assert.equal(state.user_sessions.length, 0);
  assert.equal(
    state.sqlLog.filter(entry => /INSERT INTO user_sessions/i.test(entry.sql)).length,
    0
  );
});

test('TC03 (R3): missing or empty username/password returns 400 without creating sessions or incrementing lock counter', async (t) => {
  const { baseUrl, state } = await createLoginServer(t);
  assert.equal(state.user_sessions.length, 0);

  const payloads = [
    { username: 'student_demo', password: '' },
    { username: 'student_demo' },
    { username: '   ', password: 'Pass123456!' },
    {},
  ];

  for (const payload of payloads) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.code, 'MISSING_CREDENTIALS');
    assert.equal(res.headers.get('set-cookie'), null);
  }

  // Repeated missing-input calls (> 15) must not trigger 429 brute-force lock.
  for (let i = 0; i < 16; i++) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'student_demo', password: '' }),
    });
    assert.equal(res.status, 400);
  }

  // Malformed JSON must return 400 rather than 500.
  const badJsonRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(badJsonRes.status, 400);

  assert.equal(state.user_sessions.length, 0);
  assert.equal(
    state.sqlLog.filter(entry => /INSERT INTO user_sessions/i.test(entry.sql)).length,
    0
  );
});

test('DB write failure on login returns 500 and leaves memory session cache empty', async (t) => {
  const { baseUrl, state, auth } = await createLoginServer(t, { failSaveSession: true });

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'student_demo', password: 'Pass123456!' }),
  });
  const data = await res.json();

  assert.equal(res.status, 500);
  assert.equal(data.success, false);
  assert.equal(state.user_sessions.length, 0);
  assert.equal(auth.getUsers().length, 1);
});
