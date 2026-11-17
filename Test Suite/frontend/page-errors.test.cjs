const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
for (const name of ['dashboard', 'create-room', 'create-exam', 'home']) {
  for (const state of ['unauthenticated', 'http-error', 'network-error']) {
    test(`${name}: initial authentication handles ${state}`, async t => {
      const value = state === 'network-error' ? new Error('offline') : { authenticated: false, httpStatus: state === 'http-error' ? 401 : 200 };
      const p = await page(t, name, { '/api/auth/me': value });
      assert.ok(p.calls.some(c => c.url === '/api/auth/me'));
      if (name === 'home') assert.ok(p.window.document.querySelector('#header-auth-wrap .btn-login'));
      else assert.equal(p.window.MQC_Auth.getToken(), '');
    });
  }
}
for (const state of ['http-error', 'network-error']) {
  test(`dashboard: history ${state} does not break other widgets`, async t => {
    const value = state === 'network-error' ? new Error('offline') : { httpStatus: 500 };
    const p = await page(t, 'dashboard', { '/api/history': value, '/api/history/hosted': value });
    assert.match(p.window.document.getElementById('user-chip-label').textContent, /teacher/);
    await p.window.loadUserHistory(); await p.window.loadHostedRoomsHistory();
    assert.equal(p.window.document.querySelectorAll('.history-item').length, 0);
  });
}
test('host monitor: finishing archives once and shows fallback statistics when unavailable', async t => {
  const p = await page(t, 'host-monitor', { '/api/rooms/246-579/exam-stats': new Error('offline') });
  await p.window.handleHostNextNow(); await p.settle();
  assert.ok(p.calls.some(c => c.url === '/api/history/hosted' && c.method === 'POST'));
  assert.equal(p.window.document.getElementById('final-stats-panel').classList.contains('show'), true);
  assert.equal(p.window.sessionStorage.getItem('mqc_monitor_finished_246-579'), '1');
});
test('create room: lock and delete update scoped state and cancellation flag', async t => {
  const p = await page(t, 'create-room', { '/api/rooms': { success: true, pin: '246-579' } }); const w = p.window;
  w.document.getElementById('room-name').value = 'Disposable'; await w.handleCreateRoomNow(); await p.settle();
  await w.handleToggleLockRoom('missing');
  await w.handleToggleLockRoom('246-579', { stopPropagation() {} });
  assert.equal(JSON.parse(w.localStorage.getItem('mqc_custom_rooms'))['246-579'].isLocked, true);
  await w.handleToggleLockRoom('246-579');
  assert.equal(JSON.parse(w.localStorage.getItem('mqc_custom_rooms'))['246-579'].isLocked, false);
  w.confirm = () => true;
  await w.handleDeleteRoom('246-579', { stopPropagation() {} });
  assert.equal(JSON.parse(w.localStorage.getItem('mqc_custom_rooms'))['246-579'], undefined);
  assert.equal(w.localStorage.getItem('mqc_room_status_246-579'), 'cancelled');
});
for (const state of ['taken', 'invalid', 'available', 'offline']) {
  test('home: realtime username feedback ' + state, async t => {
    const p = await page(t, 'home', { '/api/auth/check-username?u=student': state === 'offline' ? new Error('offline') : {
      exists: state === 'taken', valid: state !== 'invalid', message: state,
    } }); const w = p.window, d = w.document;
    w.setupRealtimeUsernameCheck();
    const input = d.getElementById('reg-user');
    for (const value of ['', 'ab', 'student']) {
      input.value = value; input.dispatchEvent(new w.Event('input')); await p.tick(300);
    }
    if (state === 'offline') assert.equal(d.getElementById('reg-user-feedback').textContent, '');
    else assert.match(d.getElementById('reg-user-feedback').textContent, new RegExp(state));
  });
}
