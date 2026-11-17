const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load } = require('../helpers/load.cjs');
function harness(mode = 'success') {
  const calls = [];
  const users = [{ username: 'Teacher', usernameLower: 'teacher', displayName: 'Teacher', passwordHash: 'hash', salt: 'salt' }];
  const quizzes = [{ id: 'public1', code: '#1', title: 'Public', questions: [{ text: 'Question', choices: ['A', 'B'], correct: 0 }] },
    { id: 'public2', title: 'Empty', questions: null }];
  const files = new Map([
    ['users.json', JSON.stringify(users)], ['exams.json', JSON.stringify(quizzes)],
    ['private1.json', JSON.stringify({ id: 'private1', title: 'Private', questions: [] })],
    ['teacher.json', JSON.stringify([{ id: 'attempt1', score: 100 }, {}])],
    ['001.sql', 'CREATE TABLE test_fixture (id int)'],
  ]);
  const fs = {
    existsSync(p) { return mode !== 'missing-files'; },
    readdirSync(p) {
      if (p.endsWith('migrations')) return ['001.sql', 'notes.txt'];
      if (p.endsWith('private')) return ['teacher', 'ignored.txt'];
      if (p.endsWith('teacher')) return ['private1.json', 'invalid.json', 'notes.txt'];
      if (p.endsWith('history')) return ['teacher.json', 'ignored.txt'];
      return [];
    },
    statSync(p) { return { isDirectory: () => !p.endsWith('.txt') }; },
    readFileSync(p) {
      if (mode === 'bad-json' && p.endsWith('.json')) return '{';
      if (p.endsWith('invalid.json')) return '{';
      return files.get(path.basename(p)) || '[]';
    },
  };
  const query = async (sql, values) => {
    calls.push({ sql, values });
    if (mode === 'db-error' && sql.includes('CREATE TABLE')) throw new Error('database unavailable');
    if (mode === 'insert-error' && sql.includes('INSERT INTO') && !sql.includes('schema_migrations')) throw new Error('write failed');
    if (sql.includes('SELECT id FROM schema_migrations')) return { rows: mode === 'already-applied' ? [{ id: '001.sql' }] : [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: mode === 'nonempty' ? '2' : '0' }] };
    return { rows: [{ id: 1 }] };
  };
  const supabase = { isConfigured: () => mode.startsWith('supabase'), client: { from(table) {
    return { async select() {
      if (mode === 'supabase-error') throw new Error('REST unavailable');
      return { data: table === 'users' ? [{ username: 'Remote', display_name: 'Remote' }] : [{ id: 'remote-quiz', questions: [{}] }] };
    } };
  } } };
  const api = load('src/db/migrate.js', { fs, './pool.js': { query, getPool() {}, withTransaction: fn => fn({ query }) }, './supabase.js': supabase });
  return { api, calls };
}
for (const mode of ['success', 'already-applied', 'missing-files', 'bad-json', 'insert-error', 'supabase-success', 'supabase-error']) {
  test('migration: ' + mode + ' handles legacy sources without stopping startup', async () => {
    const h = harness(mode); await h.api.runMigration();
    assert.ok(h.calls.some(c => c.sql.includes('COUNT(*)')));
    if (mode === 'success') {
      assert.ok(h.calls.some(c => c.sql.includes('INSERT INTO profiles')));
      assert.ok(h.calls.some(c => c.sql.includes('INSERT INTO question_options')));
      assert.ok(h.calls.some(c => c.sql.includes('INSERT INTO attempts')));
    }
    if (mode === 'already-applied') assert.equal(h.calls.some(c => c.sql === 'CREATE TABLE test_fixture (id int)'), false);
  });
}
test('migration: nonempty database skips importing local accounts and exams', async () => {
  const h = harness('nonempty'); await h.api.runMigration();
  assert.equal(h.calls.some(c => c.sql.includes('INSERT INTO users')), false);
});
test('migration: schema failure propagates to caller', async () => {
  await assert.rejects(harness('db-error').api.runMigration(), /database unavailable/);
});
