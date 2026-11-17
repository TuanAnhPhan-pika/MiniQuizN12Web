const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServerHarness } = require('../helpers/http.cjs');
async function setup(t) {
  const h = await makeServerHarness(t); const deleted = [], updates = [];
  const user = { username: 'alice', displayName: 'Alice', passwordHash: 'hash', salt: 'salt', role: 'teacher' };
  Object.assign(h.auth, {
    validateUsername: s => typeof s !== 'string' || s.length < 3 ? 'Invalid username' : null,
    validateDisplayName: s => typeof s !== 'string' || !s.trim() ? 'Invalid name' : null,
    validatePassword: s => typeof s !== 'string' || s.length < 6 ? 'Invalid password' : null,
    findUserByUsername: async name => name === 'alice' ? user : null,
    checkRegisterLimit: () => ({ allowed: true }), checkLoginLock: () => ({ locked: false }),
    recordRegister() {}, recordLoginSuccess() {}, recordLoginFailure: () => ({}),
    createUser: async () => {}, createSession: () => 'new-token', sessionCookieHeader: () => 'session=new-token',
    clearSessionCookieHeader: () => 'session=; Max-Age=0', deleteSession: token => deleted.push(token),
    verifyPassword: password => password === 'correct', hashPassword: () => ({ salt: 'new-salt', hash: 'new-hash' }),
    cooldownInfo: () => ({ allowed: true }), NAME_CHANGE_COOLDOWN_MS: 1000, PASSWORD_CHANGE_COOLDOWN_MS: 1000,
    updateUser: async (_, patch) => { updates.push(patch); return { ...user, ...patch }; },
    deleteOtherSessions: (_, token) => deleted.push('other:' + token),
  });
  async function request(path, body, token = 'alice') {
    const res = await fetch(h.base + '/api/auth/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
  }
  return { ...h, user, updates, deleted, request };
}
test('auth routes: username availability validates empty, invalid, existing and available names', async t => {
  const h = await setup(t);
  for (const [name, status, valid] of [['', 400, false], ['ab', 200, false], ['alice', 200, false], ['newuser', 200, true]]) {
    const res = await h.request('check-username?u=' + name);
    assert.equal(res.status, status); assert.equal(res.body.valid, valid);
  }
});
for (const mode of ['missing', 'unknown', 'wrong', 'warning', 'locked', 'sync-success', 'async-success', 'db-error']) {
  test('auth routes: login ' + mode, async t => {
    const h = await setup(t);
    if (mode === 'locked') h.auth.checkLoginLock = () => ({ locked: true, waitSeconds: 10 });
    if (mode === 'warning') h.auth.recordLoginFailure = () => ({ warning: 'Slow down' });
    if (mode === 'async-success') {
      h.auth.verifyPasswordAsync = async () => true; h.auth.createSessionPersisted = async () => 'persisted';
      h.user.avatar = '02'; h.user.role = 'admin';
    }
    if (mode === 'db-error') h.auth.findUserByUsername = async () => { throw new Error('DB unavailable'); };
    const body = mode === 'missing' ? { username: null, password: 123 } : { username: mode === 'unknown' ? 'unknown' : 'alice', password: mode.endsWith('success') ? 'correct' : 'wrong' };
    const res = await h.request('login', body, '');
    assert.equal(res.status, mode === 'missing' ? 400 : mode === 'locked' ? 429 : mode === 'db-error' ? 500 : mode.endsWith('success') ? 200 : 401);
    if (mode.endsWith('success')) assert.ok(res.body.token);
    if (mode === 'warning') assert.equal(res.body.message, 'Slow down');
  });
}
for (const mode of ['limited', 'bad-user', 'bad-name', 'bad-password', 'mismatch', 'existing', 'duplicate', 'unique', 'db-error', 'success']) {
  test('auth routes: registration ' + mode, async t => {
    const h = await setup(t);
    if (mode === 'limited') h.auth.checkRegisterLimit = () => ({ allowed: false, retryAt: Date.now() + 60000 });
    if (['duplicate', 'unique', 'db-error'].includes(mode)) h.auth.createUser = async () => { throw new Error(mode === 'duplicate' ? 'duplicate key' : mode === 'unique' ? 'unique constraint' : 'DB unavailable'); };
    const body = { username: mode === 'bad-user' ? 'ab' : mode === 'existing' ? 'alice' : 'newuser', displayName: mode === 'bad-name' ? '' : 'New User', password: mode === 'bad-password' ? 'abc' : 'correct', confirmPassword: mode === 'mismatch' ? 'other' : 'correct' };
    const res = await h.request('register', body, '');
    assert.equal(res.status, mode === 'limited' ? 429 : mode.startsWith('bad-') || mode === 'mismatch' ? 400 : ['existing', 'duplicate', 'unique'].includes(mode) ? 409 : mode === 'db-error' ? 500 : 200);
  });
}
test('auth routes: session lookup handles expired users, defaults and logout', async t => {
  const h = await setup(t);
  let res = await h.request('me'); assert.equal(res.status, 200); assert.equal(res.body.user.username, 'alice');
  h.user.avatar = '03'; h.user.role = 'admin'; res = await h.request('me'); assert.equal(res.body.user.avatar, '03');
  h.auth.findUserByUsername = async () => null;
  res = await h.request('me'); assert.equal(res.status, 401); assert.ok(res.cookie.includes('Max-Age=0'));
  res = await h.request('logout', {}); assert.equal(res.status, 200); assert.ok(h.deleted.length > 0);
  res = await h.request('logout', {}, ''); assert.equal(res.status, 200);
});
for (const mode of ['no-change', 'bad-name', 'name-cooldown', 'missing-password', 'wrong-password', 'bad-password', 'mismatch', 'password-cooldown', 'sync-success', 'async-success', 'no-session', 'no-user', 'update-error']) {
  test('auth routes: profile change ' + mode, async t => {
    const h = await setup(t);
    let body = { newPassword: 'new-password', confirmNewPassword: 'new-password', currentPassword: 'correct' };
    if (mode === 'no-change') body = { newDisplayName: 'Alice', newPassword: '' };
    if (mode === 'bad-name') body = { newDisplayName: '' };
    if (mode === 'name-cooldown') { body = { newDisplayName: 'New Name' }; h.auth.cooldownInfo = () => ({ allowed: false, nextAllowedAt: Date.now() + 86400000 }); }
    if (mode === 'password-cooldown') h.auth.cooldownInfo = () => ({ allowed: false, nextAllowedAt: Date.now() + 86400000 });
    if (mode === 'missing-password') body.currentPassword = '';
    if (mode === 'wrong-password') body.currentPassword = 'wrong';
    if (mode === 'bad-password') body.newPassword = 'abc';
    if (mode === 'mismatch') body.confirmNewPassword = 'other';
    if (mode === 'async-success') { h.auth.verifyPasswordAsync = async () => true; h.auth.hashPasswordAsync = async () => ({ salt: 'async', hash: 'async-hash' }); body.newDisplayName = 'Updated'; }
    if (mode === 'no-user') h.auth.findUserByUsername = async () => null;
    if (mode === 'update-error') h.auth.updateUser = async () => { throw new Error('write failed'); };
    const res = await h.request('change-profile', body, mode === 'no-session' ? '' : 'alice');
    assert.equal(res.status, ['no-session', 'no-user'].includes(mode) ? 401 : mode.endsWith('cooldown') ? 429 : mode === 'update-error' ? 500 : ['no-change', 'sync-success', 'async-success'].includes(mode) ? 200 : 400);
    if (mode.endsWith('success')) { assert.equal(h.updates.length, 1); assert.ok(h.deleted.includes('other:alice')); }
  });
}
