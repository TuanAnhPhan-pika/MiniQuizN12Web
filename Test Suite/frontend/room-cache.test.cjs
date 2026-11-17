const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
test('room cache: expired, completed and cancelled reservations are removed without removing active rooms', async t => {
  const now = Date.now();
  const rooms = [
    { pin: '246-579', name: 'Active', createdAt: now },
    { pin: 'expired', createdAt: now - 25 * 3600000 },
    { pin: 'cancelled', isCancelled: true },
    { pin: 'finished', isFinished: true },
    { pin: 'unheld', createdAt: now - 24 * 3600000 - 1000 },
  ];
  const p = await page(t, 'create-room', {}, { localStorage: {
    mqc_created_rooms_teacher: JSON.stringify(rooms), mqc_custom_rooms: JSON.stringify(Object.fromEntries(rooms.map(r => [r.pin, r]))),
  } });
  const cached = JSON.parse(p.window.localStorage.getItem('mqc_created_rooms_teacher'));
  assert.equal(cached.some(r => ['expired', 'cancelled', 'finished'].includes(r.pin)), false);
  assert.equal(cached.some(r => r.pin === '246-579'), true);
  assert.equal(p.window.document.querySelectorAll('.created-room-item').length, 1);
});
for (const state of ['missing', 'cancelled', 'finished', 'finished-phase', 'active', 'offline']) {
  test('room cache: server validation ' + state, async t => {
    const response = state === 'offline' ? new Error('offline') : state === 'missing' ? { httpStatus: 404 } : {
      success: true, room: { status: state === 'finished-phase' ? 'started' : state, phase: state === 'finished-phase' ? 'finished' : 'question' },
    };
    const p = await page(t, 'create-room', { '/api/rooms/246-579': response }, { localStorage: {
      mqc_created_rooms_teacher: JSON.stringify([{ pin: '246-579', name: 'Room', createdAt: Date.now() - 60000 }]),
    } });
    await p.settle();
    const rows = JSON.parse(p.window.localStorage.getItem('mqc_created_rooms_teacher'));
    assert.equal(rows.length, ['active', 'offline'].includes(state) ? 1 : 0);
  });
}
