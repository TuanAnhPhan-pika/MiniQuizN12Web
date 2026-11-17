const test = require('node:test');
const assert = require('node:assert/strict');
const { browser } = require('../helpers/browser.cjs');
function setup(t, blocked = []) {
  const b = browser(); t.after(() => b.close());
  for (const key of blocked) Object.defineProperty(b.window, key, { get() { throw new Error('denied'); } });
  const calls = []; let response = { ok: true, clone: () => ({ json: async () => ({}) }) };
  b.window.fetch = async (...args) => { calls.push(args); return response; };
  b.run('public/js/auth-client.js');
  return { w: b.window, calls, auth: b.window.MQC_Auth, respond(value) { response = value; } };
}
for (const blocked of [[], ['localStorage'], ['sessionStorage'], ['localStorage', 'sessionStorage']]) {
  test(`auth bridge: token survives unavailable ${blocked.join(',') || 'none'} storage`, t => {
    const { auth } = setup(t, blocked);
    assert.equal(auth.getToken(), ''); auth.setToken(' token '); assert.equal(auth.getToken(), 'token');
    auth.setToken(null); assert.equal(auth.getToken(), ''); auth.setToken(123); assert.equal(auth.getToken(), '123');
    auth.clearToken(); assert.equal(auth.getToken(), '');
  });
}
for (const kind of ['object', 'array', 'Headers', 'absent']) {
  test(`auth bridge: ${kind} API headers and credentials`, async t => {
    const { w, auth, calls } = setup(t); auth.setToken('secret');
    const headers = kind === 'Headers' ? new Headers({ Authorization: 'Bearer explicit', 'x-session-token': 'explicit' }) :
      kind === 'array' ? [['Accept', 'application/json']] : kind === 'object' ? { authorization: 'Bearer explicit', 'x-session-token': 'explicit' } : undefined;
    await w.fetch({ url: '/api/storage/private' }, { headers, credentials: 'include' });
    const actual = new Headers(calls[0][1].headers);
    assert.equal(actual.get('Authorization'), ['object', 'Headers'].includes(kind) ? 'Bearer explicit' : 'Bearer secret');
    assert.equal(calls[0][1].credentials, 'include');
    auth.clearToken(); await w.fetch('/api/server-info', { headers });
    assert.equal(calls[1][1].credentials, 'same-origin');
    await w.fetch('/style.css'); assert.equal(calls[2][1].headers, undefined);
    await w.fetch(null); assert.equal(calls[3][1].headers, undefined);
  });
}
test('auth bridge: session fallback, account cleanup and response failures', async t => {
  const h = setup(t); h.w.sessionStorage.setItem('mqc_session_token', 'session'); assert.equal(h.auth.getToken(), 'session');
  let cleared; h.w.MQC_Storage = { clearUser(u) { cleared = u; } };
  h.auth.clearToken('Alice'); assert.equal(cleared, 'Alice');
  for (const response of [
    { ok: false }, { ok: true, clone() { throw new Error('consumed'); } },
    { ok: true, clone: () => ({ json: async () => { throw new Error('bad JSON'); } }) },
    { ok: true, clone: () => ({ json: async () => null }) },
  ]) { h.respond(response); await h.w.fetch('/api/auth/me'); }
  h.respond({ ok: true, clone: () => ({ json: async () => ({ token: 'fresh' }) }) });
  await h.w.fetch('/api/auth/register'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.auth.getToken(), 'fresh');
  await h.w.fetch('/api/auth/logout'); assert.equal(h.auth.getToken(), '');
});
