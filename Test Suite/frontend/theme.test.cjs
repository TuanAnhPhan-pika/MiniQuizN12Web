const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
for (const name of ['home', 'dashboard', 'create-exam', 'create-room', 'host-monitor', 'room', 'waiting-for-host', 'waiting-room-for-guests']) {
  test(name + ': restores saved dark theme and persists user toggle', async t => {
    const p = await page(t, name, {}, { localStorage: { 'mqc-dark': '1' } }); const w = p.window, d = w.document;
    assert.equal(d.body.classList.contains('dark'), true);
    d.getElementById('btn-dark').click(); assert.equal(d.body.classList.contains('dark'), false);
    assert.equal(w.localStorage.getItem('mqc-dark'), '0');
    d.getElementById('btn-dark').click(); assert.equal(w.localStorage.getItem('mqc-dark'), '1');
  });
}
