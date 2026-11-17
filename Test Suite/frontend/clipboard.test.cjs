const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
for (const name of ['create-room', 'waiting-for-host', 'waiting-room-for-guests']) {
  for (const mode of ['clipboard', 'clipboard-denied', 'legacy-copy', 'legacy-denied', 'missing-button']) {
    test(`${name}: copy invitation using ${mode}`, async t => {
      const p = await page(t, name); const w = p.window, d = w.document; let copied = '';
      if (name === 'create-room') d.getElementById('pin-display').textContent = '246-579';
      if (mode === 'clipboard' || mode === 'clipboard-denied' || mode === 'missing-button') {
        Object.defineProperty(w.navigator, 'clipboard', { value: { async writeText(value) {
          if (mode === 'clipboard-denied') throw new Error('denied'); copied = value;
        } } });
      } else d.execCommand = command => { if (mode === 'legacy-denied') throw new Error('denied'); copied = d.querySelector('textarea').value; return command === 'copy'; };
      if (mode === 'missing-button') d.getElementById('btn-copy-pin')?.remove();
      w.copyPinCode(); await p.settle(); await p.tick(1500);
      assert.equal(d.querySelectorAll('textarea').length, 0);
      if (!mode.endsWith('denied')) assert.match(copied, /index.html\?pin=246-579$/);
    });
  }
}
test('host waiting room: join and leave notifications expire without leaving DOM nodes', async t => {
  const p = await page(t, 'waiting-for-host'); const w = p.window;
  w.showToast('Joined', 'join'); w.showToast('Left', 'leave'); w.showToast('Info');
  assert.ok(w.document.querySelectorAll('.host-toast-item').length >= 3);
  await p.tick(2800); await p.tick(300);
  assert.equal(w.document.querySelectorAll('.host-toast-item').length, 0);
  w.document.getElementById('toast-container').remove(); w.showToast('No container');
});
