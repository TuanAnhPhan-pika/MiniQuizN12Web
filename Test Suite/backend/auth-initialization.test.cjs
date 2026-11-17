const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load.cjs');
for (const populated of [false, true]) {
  test('auth: Supabase initialization ' + (populated ? 'loads users and sessions once' : 'accepts empty tables'), async () => {
    let calls = 0;
    const rows = { users: [{ id: 1, username: 'teacher', username_lower: 'teacher', display_name: 'Teacher', created_at: '123' },
      { id: 2, username: 'student', username_lower: 'student', display_name: 'Student', created_at: 124 }],
    profiles: [{ username: 'teacher', role: 'admin', avatar: '02', bio: 'Bio' }],
    user_sessions: [{ token: 'session-token', username: 'teacher', created_at: 123, expires_at: Date.now() + 60000 }] };
    const db = { useSupabase: () => true, supabase: { from(table) {
      calls++; const chain = { select() { return chain; }, gt() { return chain; }, then(resolve) { resolve({ data: populated ? rows[table] : null }); } }; return chain;
    } } };
    const auth = load('src/auth.js', { './db/index.js': db });
    await auth.initAuth(); await auth.initAuth(); assert.equal(calls, 3);
    assert.equal(auth.getUsers().length, populated ? 2 : 0);
    if (populated) {
      assert.equal(auth.findUserByUsernameSync('TEACHER').role, 'admin');
      assert.equal(auth.findUserByUsernameSync('student').role, 'teacher');
      assert.equal(auth.getSession('session-token').username, 'teacher');
    }
  });
}
test('auth: async password failures reject rather than silently succeeding', async () => {
  const real = require('node:crypto');
  const auth = load('src/auth.js', { './db/index.js': {}, crypto: { ...real, scrypt(password, salt, length, callback) { callback(new Error('scrypt failed')); } } });
  await assert.rejects(auth.hashPasswordAsync('password'), /scrypt failed/);
  await assert.rejects(auth.verifyPasswordAsync('password', 'salt', 'hash'), /scrypt failed/);
});
