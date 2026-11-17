const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const plain = v => JSON.parse(JSON.stringify(v));

function loadWithClock(file, overrides = {}, tail = '', env = {}, clock = { now: 1_700_000_000_000 }) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
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
    require: name => (Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)),
    module: { exports: {} },
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    Date: MockDate,
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

function createAuthHarness(clock = { now: 1_700_000_000_000 }) {
  const dbUsers = new Map();
  const dbSessions = new Map();
  let nextUserId = 1;
  let duplicateNext = false;
  let dbFailLookup = false;

  const dbMock = {
    useSupabase: () => false,
    async findUserByUsername(username) {
      if (dbFailLookup) throw new Error('DB lookup error');
      return dbUsers.get(String(username || '').toLowerCase()) || null;
    },
    async createUser({ username, displayName, passwordHash, salt }) {
      const lower = username.toLowerCase();
      if (duplicateNext || dbUsers.has(lower)) {
        duplicateNext = false;
        throw new Error('duplicate key value violates unique constraint');
      }
      const u = {
        id: nextUserId++,
        username,
        usernameLower: lower,
        displayName: displayName.trim(),
        passwordHash,
        salt,
        createdAt: clock.now,
        lastNameChangeAt: 0,
        lastPasswordChangeAt: 0,
        avatar: '01',
        bio: '',
        role: 'teacher',
      };
      dbUsers.set(lower, u);
      return u;
    },
    async updateUser(username, patch) {
      const lower = String(username || '').toLowerCase();
      const u = dbUsers.get(lower);
      if (!u) return null;
      Object.assign(u, patch);
      return u;
    },
    async saveSession(token, username, expiresAt) {
      dbSessions.set(token, { token, username, expiresAt });
    },
    async deleteSession(token) {
      dbSessions.delete(token);
    },
    async deleteOtherSessions(username, exceptToken) {
      for (const [tok, sess] of dbSessions.entries()) {
        if (tok !== exceptToken && sess.username.toLowerCase() === username.toLowerCase()) {
          dbSessions.delete(tok);
        }
      }
    },
  };

  let initQueries = 0;
  const pgPoolMock = {
    async query(sql) {
      initQueries++;
      if (/FROM users/.test(sql)) {
        return {
          rows: [{
            id: 99, username: 'Preloaded', username_lower: 'preloaded',
            display_name: 'Pre', password_hash: 'aa', salt: 'bb',
            created_at: 1000, last_name_change_at: 0, last_password_change_at: 0,
            avatar: '02', bio: 'hi', role: 'admin',
          }],
        };
      }
      if (/FROM user_sessions/.test(sql)) {
        return { rows: [{ token: 'pre-tok', username: 'Preloaded', created_at: 1000, expires_at: clock.now + 60_000 }] };
      }
      return { rows: [] };
    },
  };

  const auth = loadWithClock('src/auth.js', {
    './db/index.js': dbMock,
    './db/pool.js': pgPoolMock,
  }, '', {}, clock);

  return {
    auth,
    dbUsers,
    dbSessions,
    getInitQueries: () => initQueries,
    triggerDuplicateErrorOnce() { duplicateNext = true; },
    setDbFailLookup(v) { dbFailLookup = v; },
  };
}

function startAuthServer(t, auth, clock = { now: 1_700_000_000_000 }) {
  const { server } = loadWithClock('src/server.js', {
    dotenv: { config() {} },
    './auth.js': auth,
    './db/index.js': {},
    './db/migrate.js': {},
    './rooms/manager.js': { getRawRoom: () => null },
    './ai/gemini.js': {},
  }, '\nmodule.exports = { server };', {}, clock);

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('validateUsername accepts 3-20 alphanumeric/underscore and rejects invalid boundaries', () => {
  const { auth } = createAuthHarness();
  for (const bad of ['', null, undefined, 'ab', 'a'.repeat(21), 'bad-name', 'has space', 'tên']) {
    assert.ok(auth.validateUsername(bad), `expected error for "${bad}"`);
  }
  for (const good of ['abc', 'User_20_Characters_', '007']) {
    assert.equal(auth.validateUsername(good), null);
  }
});

test('validateDisplayName and validatePassword enforce trim and length boundaries', () => {
  const { auth } = createAuthHarness();
  assert.ok(auth.validateDisplayName(''));
  assert.ok(auth.validateDisplayName('   '));
  assert.ok(auth.validateDisplayName('x'.repeat(31)));
  assert.equal(auth.validateDisplayName('  Nguyễn Văn A  '), null);
  assert.equal(auth.validateDisplayName('x'.repeat(30)), null);

  assert.ok(auth.validatePassword(''));
  assert.ok(auth.validatePassword('12345'));
  assert.equal(auth.validatePassword('123456'), null);
});

test('hashPassword and verifyPassword use unique salts and reject wrong or length-mismatched hashes', () => {
  const { auth } = createAuthHarness();
  const a = auth.hashPassword('MySecret99');
  const b = auth.hashPassword('MySecret99');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(auth.verifyPassword('MySecret99', a.salt, a.hash), true);
  assert.equal(auth.verifyPassword('WrongPass', a.salt, a.hash), false);
  assert.equal(auth.verifyPassword('MySecret99', a.salt, 'deadbeef'), false);
});

test('parseCookies, sessionCookieHeader and clearSessionCookieHeader handle encoding and secure flags', () => {
  const { auth } = createAuthHarness();
  assert.deepEqual(plain(auth.parseCookies('')), {});
  assert.deepEqual(plain(auth.parseCookies('foo=bar; badpart; mqc_session=abc%2B123')), {
    foo: 'bar',
    mqc_session: 'abc+123',
  });

  const httpCookie = auth.sessionCookieHeader('tok1', false);
  assert.match(httpCookie, /HttpOnly/);
  assert.match(httpCookie, /SameSite=Lax/);
  assert.doesNotMatch(httpCookie, /Secure/);

  const httpsCookie = auth.sessionCookieHeader('tok1', true);
  assert.match(httpsCookie, /SameSite=None; Secure; Partitioned/);

  const cleared = auth.clearSessionCookieHeader(true);
  assert.equal(cleared.length, 3);
  assert.ok(cleared.every(c => c.includes('Max-Age=0')));
});

test('initAuth loads users/sessions once (idempotent) and findUserByUsername handles cache, DB fallback and error', async () => {
  const clock = { now: 1_700_000_000_000 };
  const h = createAuthHarness(clock);
  await h.auth.initAuth();
  assert.equal(h.getInitQueries(), 2);
  await h.auth.initAuth();
  assert.equal(h.getInitQueries(), 2);

  const pre = h.auth.findUserByUsernameSync('PRELOADED');
  assert.equal(pre.role, 'admin');
  assert.ok(h.auth.getSession('pre-tok'));

  // DB lookup fallback when not in memory
  h.dbUsers.set('lateuser', { id: 100, username: 'LateUser', usernameLower: 'lateuser' });
  const fetched = await h.auth.findUserByUsername('LateUser');
  assert.equal(fetched.id, 100);
  assert.equal(h.auth.findUserByUsernameSync('lateuser').id, 100);

  // DB failure returns null gracefully
  h.setDbFailLookup(true);
  assert.equal(await h.auth.findUserByUsername('UnknownErr'), null);
});

test('cooldownInfo and upsertUser normalize and check expiry boundaries accurately', () => {
  const clock = { now: 1_700_000_000_000 };
  const { auth } = createAuthHarness(clock);

  assert.deepEqual(plain(auth.cooldownInfo(0, 1000)), { allowed: true, nextAllowedAt: 0 });
  assert.deepEqual(plain(auth.cooldownInfo(clock.now - 500, 1000)), { allowed: false, nextAllowedAt: clock.now + 500 });
  assert.deepEqual(plain(auth.cooldownInfo(clock.now - 1000, 1000)), { allowed: true, nextAllowedAt: 0 });

  const upserted = auth.upsertUser({ id: 5, username: 'MixCase', passwordHash: 'h', salt: 's' });
  assert.equal(upserted.usernameLower, 'mixcase');
  assert.equal(upserted.role, 'teacher');
  assert.equal(auth.upsertUser(null), null);
});

test('login rate limiter locks after 15 failures with exponential backoff and resets after 24h or success', () => {
  const clock = { now: 1_700_000_000_000 };
  const { auth } = createAuthHarness(clock);
  const ip = '192.0.2.10';

  for (let i = 1; i <= 15; i++) {
    const f = auth.recordLoginFailure(ip);
    assert.equal(f.locked, false);
    if (i < 13) assert.equal(f.warning, null);
    else assert.match(f.warning, /Còn \d+ lần thử/);
  }

  // 16th -> locked 15s; 17th -> 30s; 18th -> 60s
  const f16 = auth.recordLoginFailure(ip);
  assert.equal(f16.locked, true);
  assert.equal(f16.waitSeconds, 15);
  assert.equal(auth.checkLoginLock(ip).locked, true);

  const f17 = auth.recordLoginFailure(ip);
  assert.equal(f17.waitSeconds, 30);

  const f18 = auth.recordLoginFailure(ip);
  assert.equal(f18.waitSeconds, 60);

  // Success clears lock immediately
  auth.recordLoginSuccess(ip);
  assert.equal(auth.checkLoginLock(ip).locked, false);

  // Window reset after 24h
  for (let i = 0; i < 16; i++) auth.recordLoginFailure(ip);
  assert.equal(auth.checkLoginLock(ip).locked, true);
  clock.now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(auth.checkLoginLock(ip).locked, false);
});

test('register sliding window rate limiter blocks at 50/hour and recovers after 1 hour', () => {
  const clock = { now: 1_700_000_000_000 };
  const { auth } = createAuthHarness(clock);
  const ip = '198.51.100.44';

  for (let i = 0; i < 50; i++) {
    assert.equal(auth.checkRegisterLimit(ip).allowed, true);
    auth.recordRegister(ip);
  }
  const blocked = auth.checkRegisterLimit(ip);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAt > clock.now);

  clock.now += 60 * 60 * 1000 + 1;
  assert.equal(auth.checkRegisterLimit(ip).allowed, true);
});

test('GET /api/auth/check-username handles empty, malformed, case-insensitive taken and available', async t => {
  const h = createAuthHarness();
  await h.auth.initAuth();
  const base = await startAuthServer(t, h.auth);

  assert.equal((await fetch(base + '/api/auth/check-username?u=')).status, 400);
  const bad = await (await fetch(base + '/api/auth/check-username?u=bad!')).json();
  assert.deepEqual({ exists: bad.exists, valid: bad.valid }, { exists: false, valid: false });

  const taken = await (await fetch(base + '/api/auth/check-username?u=preloaded')).json();
  assert.deepEqual({ exists: taken.exists, valid: taken.valid }, { exists: true, valid: false });

  const avail = await (await fetch(base + '/api/auth/check-username?u=Fresh_User')).json();
  assert.deepEqual({ exists: avail.exists, valid: avail.valid }, { exists: false, valid: true });
});

test('POST /api/auth/register validates inputs, handles duplicate races, rate limit 429 and sets HTTP/HTTPS cookies', async t => {
  const h = createAuthHarness();
  await h.auth.initAuth();
  const base = await startAuthServer(t, h.auth);
  const post = (body, headers = {}) => fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  assert.equal((await post({ username: 'x', displayName: 'A', password: 'secret1', confirmPassword: 'secret1' })).status, 400);
  assert.equal((await post({ username: 'Valid1', displayName: '   ', password: 'secret1', confirmPassword: 'secret1' })).status, 400);
  assert.equal((await post({ username: 'Valid1', displayName: 'A', password: '123', confirmPassword: '123' })).status, 400);
  assert.equal((await post({ username: 'Valid1', displayName: 'A', password: 'secret1', confirmPassword: 'other' })).status, 400);

  h.triggerDuplicateErrorOnce();
  assert.equal((await post({ username: 'Race1', displayName: 'R', password: 'secret1', confirmPassword: 'secret1' })).status, 409);

  const okHttp = await post({ username: 'Alice_1', displayName: '  Cô Alice ', password: 'secret1', confirmPassword: 'secret1' });
  assert.equal(okHttp.status, 200);
  assert.match(okHttp.headers.get('set-cookie') || '', /SameSite=Lax/);

  const okHttps = await post(
    { username: 'Bob_2', displayName: 'Bob', password: 'secret2', confirmPassword: 'secret2' },
    { 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.5' }
  );
  assert.equal(okHttps.status, 200);
  assert.match(okHttps.headers.get('set-cookie') || '', /SameSite=None; Secure; Partitioned/);

  // Case-insensitive duplicate
  assert.equal((await post({ username: 'alice_1', displayName: 'A', password: 'secret1', confirmPassword: 'secret1' })).status, 409);

  // Rate limit 429
  for (let i = 0; i < 50; i++) h.auth.recordRegister('198.51.100.88');
  assert.equal((await post(
    { username: 'Spam99', displayName: 'S', password: 'secret1', confirmPassword: 'secret1' },
    { 'x-forwarded-for': '198.51.100.88, 10.0.0.1' }
  )).status, 429);
});

test('POST /api/auth/login, GET /api/auth/me and POST /api/auth/logout verify transport channels, expiry & lockouts', async t => {
  const clock = { now: 1_700_000_000_000 };
  const h = createAuthHarness(clock);
  await h.auth.initAuth();
  await h.auth.createUser({ username: 'TeacherA', displayName: 'GV A', password: 'password1' });
  const base = await startAuthServer(t, h.auth, clock);

  const post = (route, body, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  // Unknown user and wrong password lockouts
  for (let i = 1; i <= 16; i++) {
    assert.equal((await post('/api/auth/login', { username: 'TeacherA', password: 'bad' }, { 'x-forwarded-for': '10.9.9.9' })).status, 401);
  }
  assert.equal((await post('/api/auth/login', { username: 'TeacherA', password: 'password1' }, { 'x-forwarded-for': '10.9.9.9' })).status, 429);

  // Successful login from another IP
  const loginRes = await post('/api/auth/login', { username: 'teachera', password: 'password1' }, { 'x-forwarded-for': '10.9.9.10' });
  assert.equal(loginRes.status, 200);
  const { token } = await loginRes.json();

  // /me via Bearer, X-Session-Token and Cookie
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { 'X-Session-Token': token } })).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: `mqc_session=${token}` } })).status, 200);
  assert.equal((await fetch(base + '/api/auth/me')).status, 401);

  // Logout clears session
  const out = await post('/api/auth/logout', {}, { Authorization: `Bearer ${token}` });
  assert.equal(out.status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status, 401);

  // Expired session returns 401 and self-deletes
  const login2 = await (await post('/api/auth/login', { username: 'TeacherA', password: 'password1' }, { 'x-forwarded-for': '10.9.9.11' })).json();
  clock.now += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${login2.token}` } })).status, 401);
});

test('POST /api/auth/change-profile enforces 7-day cooldowns and revokes other sessions on password change', async t => {
  const clock = { now: 1_700_000_000_000 };
  const h = createAuthHarness(clock);
  await h.auth.initAuth();
  await h.auth.createUser({ username: 'TeacherB', displayName: 'GV B', password: 'password1' });
  const tokA = h.auth.createSession('TeacherB');
  const tokB = h.auth.createSession('TeacherB');
  const base = await startAuthServer(t, h.auth, clock);

  const post = (body, token) => fetch(base + '/api/auth/change-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await post({ newDisplayName: 'X' })).status, 401);
  assert.equal((await post({ newDisplayName: 'GV B' }, tokA)).status, 200); // no-op
  assert.equal((await post({ newDisplayName: '   ' }, tokA)).status, 400);

  // Change displayName -> sets 7-day cooldown
  assert.equal((await post({ newDisplayName: 'GV B Mới' }, tokA)).status, 200);
  assert.equal((await post({ newDisplayName: 'GV B Mới 2' }, tokA)).status, 429);

  // Advance 7 days -> login fresh sessions (previous 7d sessions expire at +7d+1ms) and verify cooldown reset
  clock.now += 7 * 24 * 60 * 60 * 1000 + 1;
  const tokA2 = h.auth.createSession('TeacherB');
  const tokB2 = h.auth.createSession('TeacherB');
  assert.equal((await post({ newDisplayName: 'GV B Sau 7d' }, tokA2)).status, 200);

  // Password validation & revocation of tokB2 while tokA2 remains active
  assert.equal((await post({ newPassword: 'newpass1', confirmNewPassword: 'newpass1' }, tokA2)).status, 400);
  assert.equal((await post({ currentPassword: 'wrong', newPassword: 'newpass1', confirmNewPassword: 'newpass1' }, tokA2)).status, 400);
  assert.equal((await post({ currentPassword: 'password1', newPassword: 'short', confirmNewPassword: 'short' }, tokA2)).status, 400);
  assert.equal((await post({ currentPassword: 'password1', newPassword: 'newpass1', confirmNewPassword: 'diff' }, tokA2)).status, 400);

  assert.equal((await post({ currentPassword: 'password1', newPassword: 'newpass1', confirmNewPassword: 'newpass1' }, tokA2)).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${tokA2}` } })).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${tokB2}` } })).status, 401);

  // Immediate second password change hits 429 cooldown
  assert.equal((await post({ currentPassword: 'newpass1', newPassword: 'newpass2', confirmNewPassword: 'newpass2' }, tokA2)).status, 429);
});
