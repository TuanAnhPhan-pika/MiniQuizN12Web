const test = require('node:test');
const assert = require('node:assert/strict');
const { browser } = require('../helpers/browser.cjs');
function setup(t, blocked = false) {
  const b = browser(); t.after(() => b.close());
  if (blocked) for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(b.window, key, { get() { throw new Error('Storage denied'); } });
  }
  b.run('public/js/storage.js');
  return { w: b.window, s: b.window.MQC_Storage };
}
for (const scope of ['Global', 'User', 'Room', 'Session']) {
  for (const value of ['raw text', { score: 10 }, false, 0, null, [1, 2]]) {
    test(`storage ${scope}: roundtrip ${JSON.stringify(value)} and remove`, t => {
      const { s } = setup(t);
      const args = ['User', 'Room'].includes(scope) ? ['key', 'Alice'] : ['key'];
      s['set' + scope](...args, value);
      assert.equal(JSON.stringify(s['get' + scope](...args)), JSON.stringify(value));
      s['remove' + scope](...args);
      assert.equal(s['get' + scope](...args, 'missing'), 'missing');
    });
  }
  test(`storage ${scope}: unavailable storage returns default without throwing`, t => {
    const { s } = setup(t, true);
    const args = ['User', 'Room'].includes(scope) ? ['key', 'Alice'] : ['key'];
    assert.equal(s['get' + scope](...args, 'fallback'), 'fallback');
    assert.doesNotThrow(() => s['set' + scope](...args, { score: 1 }));
    assert.doesNotThrow(() => s['remove' + scope](...args));
    assert.doesNotThrow(() => s.clearUser('Alice'));
    assert.doesNotThrow(() => s.clearRoom('123-456'));
  });
}
test('storage: account and room clearing preserves unrelated data and anonymous writes are ignored', t => {
  const { w, s } = setup(t);
  for (const scope of ['User', 'Room']) {
    s['set' + scope]('draft', '', 'ignored');
    s['remove' + scope]('draft', '');
    assert.equal(s['get' + scope]('draft', '', 'fallback'), 'fallback');
  }
  s.clearUser(''); s.clearRoom('');
  s.setUser('draft', 'Alice', 1); s.setUser('draft', 'Bob', 2);
  w.localStorage.setItem('mqc_user_alice_custom', '1');
  s.clearUser('ALICE');
  assert.equal(s.getUser('draft', 'Alice'), null);
  assert.equal(s.getUser('draft', 'Bob'), 2);
  assert.equal(w.localStorage.getItem('mqc_user_alice_custom'), null);
  s.setRoom('draft', '123-456', 3); s.setRoom('draft', '654-321', 4);
  s.clearRoom('123-456');
  assert.equal(s.getRoom('draft', '123-456'), null);
  assert.equal(s.getRoom('draft', '654-321'), 4);
  assert.equal(s.getRoomKey('draft'), 'mqc_room_general_draft');
  assert.equal(w.getUserStorageKey('draft'), 'draft_anonymous');
});
test('storage: dark theme legacy fallback and synchronization', t => {
  const { w, s } = setup(t);
  w.localStorage.setItem('mqc-dark', '1'); assert.equal(s.getGlobal('dark'), 1);
  for (const value of [true, '1', false, '0']) {
    s.setGlobal('dark', value);
    assert.equal(w.localStorage.getItem('mqc-dark'), value === true || value === '1' ? '1' : '0');
  }
  s.removeGlobal('dark'); assert.equal(w.localStorage.getItem('mqc-dark'), null);
});
