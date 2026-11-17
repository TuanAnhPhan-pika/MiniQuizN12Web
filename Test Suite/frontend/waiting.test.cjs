const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
test('guest waiting room: joins and keeps player credentials in session storage only', async t => {
  const p = await page(t, 'waiting-room-for-guests'); const w = p.window;
  await w.joinWaitingRoom();
  assert.equal(w.sessionStorage.getItem('mqc_my_player_token_246-579'), 'test-player-token');
  assert.equal(w.localStorage.getItem('mqc_my_player_token_246-579'), null);
  assert.equal(w.document.querySelectorAll('.player-slot-card').length, 2);
  w.renderPlayers([]); assert.equal(w.document.querySelectorAll('.player-slot-card').length, 0);
  w.renderPlayers([{ nick: '<script>bad</script>', isHost: true }, { nick: 'Student', av: '02' }]);
  assert.equal(w.document.getElementById('players-grid').querySelector('script'), null);
  w.syncLocalRoomState([], 'started'); assert.equal(w.localStorage.getItem('mqc_room_status_246-579'), 'started');
});
for (const mode of ['denied', 'not-found', 'offline']) {
  test('guest waiting room: join ' + mode, async t => {
    const p = await page(t, 'waiting-room-for-guests', { '/api/rooms/246-579/join':
      mode === 'offline' ? new Error('offline') : { success: false, httpStatus: mode === 'not-found' ? 404 : 200 } });
    await p.window.joinWaitingRoom(); assert.ok(p.alerts.length > 0);
  });
}
test('host waiting room: renders members, lock state and start validation', async t => {
  const p = await page(t, 'waiting-for-host'); const w = p.window;
  assert.equal(w.document.getElementById('pin-display').textContent, '246-579');
  w.renderMembers([]); w.renderMembers(p.room.players);
  w.updateLockUI(true); w.updateLockUI(false);
  await w.handleToggleLock();
  assert.ok(p.calls.some(c => c.url.endsWith('/lock')));
  await w.handleHostStart();
  assert.ok(p.calls.some(c => c.url.endsWith('/start')) || p.alerts.length > 0);
});
for (const state of ['waiting', 'countdown', 'started', 'not-found', 'offline']) {
  test('guest waiting room: polling handles ' + state, async t => {
    const p = await page(t, 'waiting-room-for-guests'); const w = p.window;
    await w.joinWaitingRoom();
    p.routes['/api/rooms/246-579/status'] = state === 'offline' ? new Error('offline') : {
      success: true, status: state, countdown: 2, title: 'Updated Room', players: p.room.players, httpStatus: state === 'not-found' ? 404 : 200,
    };
    await p.tick(1000);
    if (state === 'not-found') {
      assert.equal(w.sessionStorage.getItem('mqc_my_player_token_246-579'), null);
      assert.equal(w.document.getElementById('cancelled-modal').classList.contains('show'), true);
      w.handleRoomCancelled();
    } else if (state === 'countdown') {
      assert.equal(w.document.getElementById('countdown-num').textContent, '2');
      await p.tick(1000); await p.tick(1000); await p.tick(600);
      assert.equal(w.document.getElementById('countdown-num').textContent, 'GO!');
    } else if (state === 'waiting') assert.equal(w.document.getElementById('room-title-display').textContent, 'Updated Room');
    else assert.ok(p.calls.some(c => c.url.endsWith('/status')));
  });
}
test('guest waiting room: explicit leave sends session token and clears credentials', async t => {
  const p = await page(t, 'waiting-room-for-guests'); const w = p.window;
  await w.joinWaitingRoom(); await w.handleLeaveWaitingRoom();
  const request = p.calls.find(c => c.url.endsWith('/leave'));
  assert.equal(JSON.parse(request.body).playerToken, 'test-player-token');
  assert.equal(w.sessionStorage.getItem('mqc_my_player_token_246-579'), null);
});
test('host waiting room: countdown completes and repeated missing rooms stop polling', async t => {
  const p = await page(t, 'waiting-for-host'); const w = p.window;
  w.startCountdownProcess(2); await p.tick(1000); await p.tick(1000); await p.tick(600);
  assert.equal(w.document.getElementById('countdown-num').textContent, 'GO!');
  w.copyPinCode(); await p.settle();
});
for (const state of ['waiting', 'countdown', 'not-found', 'offline']) {
  test('host waiting room: server polling ' + state, async t => {
    const p = await page(t, 'waiting-for-host');
    p.routes['/api/rooms/246-579/status'] = state === 'offline' ? new Error('offline') : {
      success: true, title: 'Updated', capacity: 2, isLocked: true, players: [],
      status: state, countdown: 1, httpStatus: state === 'not-found' ? 404 : 200,
    };
    for (let i = 0; i < 4; i++) await p.tick(1000);
    if (state === 'not-found') assert.ok(p.calls.some(c => c.url === '/api/rooms' && c.method === 'POST'));
    else if (state === 'countdown') assert.equal(p.window.document.getElementById('countdown-num').textContent, 'GO!');
    else assert.ok(p.calls.some(c => c.url.endsWith('/status')));
  });
}
