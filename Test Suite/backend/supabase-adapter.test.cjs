const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load.cjs');
function adapter(mode = 'success', data = null, env = { SUPABASE_URL: 'https://example.test/rest/v1/', SUPABASE_SERVICE_ROLE_KEY: 'test-only' }) {
  const calls = [];
  const chain = new Proxy({}, { get(_, method) {
    if (method === 'then') return (resolve, reject) => mode === 'throw' ? reject(new Error('offline')) : resolve({ data, error: mode === 'error' ? { message: 'denied' } : null });
    return (...args) => { calls.push([method, ...args]); return chain; };
  } });
  const api = load('src/db/supabase.js', { '@supabase/supabase-js': { createClient(url, key, config) {
    calls.push(['createClient', url, key, config]);
    if (mode === 'init-error') throw new Error('invalid URL');
    return chain;
  } } }, env);
  return { api, calls };
}
const operations = {
  findUserByUsername: ['ALICE'], createUser: [{ username: 'Alice', displayName: 'A', passwordHash: 'hash', salt: 'salt' }],
  updateUser: ['ALICE', {}], getPublicExams: [], getPrivateExams: ['ALICE'],
  saveExam: [{ id: 'exam-1' }, 'ALICE'], deleteExam: ['exam-1'],
  getUserHistory: ['ALICE'], appendUserHistory: ['ALICE', {}],
  getHostedRooms: ['ALICE'], saveHostedRoom: ['ALICE', {}],
};
for (const [name, args] of Object.entries(operations)) {
  for (const mode of ['unconfigured', 'init-error', 'error', 'throw']) {
    test(`Supabase ${name}: ${mode} returns documented fallback`, async () => {
      const { api } = adapter(mode, null, mode === 'unconfigured' ? {} : undefined);
      const result = await api[name](...args);
      assert.equal(result, name === 'deleteExam' && !['unconfigured', 'init-error'].includes(mode) ? false : null);
    });
  }
}
test('Supabase: configuration normalization and environment key fallbacks', () => {
  for (const key of ['SUPABASE_KEY', 'SUPABASE_ANON_KEY']) {
    const { api, calls } = adapter('success', null, { SUPABASE_URL: ' https://example.test/// ', [key]: ' test ' });
    assert.equal(api.isConfigured(), true);
    assert.equal(calls[0][1], 'https://example.test'); assert.equal(calls[0][2], 'test');
    assert.equal(calls[0][3].auth.persistSession, false);
  }
});
test('Supabase: users normalize identities, map optional dates and preserve updates', async () => {
  const row = { id: 1, username: 'Alice', username_lower: 'alice', display_name: 'A', password_hash: 'hash', salt: 'salt', created_at: '123' };
  const { api, calls } = adapter('success', row);
  const user = await api.findUserByUsername('ALICE');
  assert.equal(user.createdAt, 123); assert.equal(user.lastNameChangeAt, 0);
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'username_lower' && c[2] === 'alice'));
  assert.equal((await api.findUserByUsername(null)).username, 'Alice');
  const input = { username: 'Alice', createdAt: 123, lastNameChangeAt: 5, lastPasswordChangeAt: 6 };
  assert.equal(await api.createUser(input), input);
  await api.updateUser('Alice', { displayName: 'B', passwordHash: 'new', salt: 's', lastNameChangeAt: 7, lastPasswordChangeAt: 8 });
  const patch = calls.find(c => c[0] === 'update')[1];
  assert.equal(patch.display_name, 'B'); assert.equal(patch.last_password_change_at, 8);
  assert.equal(await adapter('success', null).api.findUserByUsername('missing'), null);
});
test('Supabase: exam lists map rows and missing lists become empty', async () => {
  const { api } = adapter('success', [{ id: 'e', title: 'Quiz', time_per_q: 20, questions: [{ text: 'Q' }] }]);
  for (const rows of [await api.getPublicExams(), await api.getPrivateExams(null)]) {
    assert.equal(rows[0].timePerQ, 20); assert.equal(rows[0].questions[0].text, 'Q');
  }
  const empty = adapter('success', null).api;
  for (const name of ['getPublicExams', 'getPrivateExams', 'getUserHistory', 'getHostedRooms']) {
    assert.equal((await empty[name]()).length, 0);
  }
});
test('Supabase: exam persistence keeps metadata and normalizes owner', async () => {
  const { api, calls } = adapter();
  const exam = { id: 'e', title: 'Quiz', subject: 'Math', author: 'A', timePerQ: 20, pointsPerQ: 50,
    description: 'D', questions: [{}], parentCode: 'parent', copiesIssued: 3, sharedBy: 'A', sharedAt: 'now', createdAt: 'then', updatedAt: 'now' };
  assert.equal(await api.saveExam(exam, 'ALICE', true), exam);
  const record = calls.find(c => c[0] === 'upsert')[1];
  assert.equal(record.owner_username, 'alice'); assert.equal(record.is_public, true); assert.equal(record.description, 'D');
  await api.saveExam({ id: 'empty' }, null); assert.equal(await api.deleteExam('e'), true);
});
test('Supabase: history and hosted room records roundtrip their field mappings', async () => {
  const { api, calls } = adapter('success', [{ id: 'h', created_at: '12', finished_at: '13', room_title: 'Room', score: 5, stats: { totalPlayers: 1 } }]);
  assert.equal((await api.getUserHistory('ALICE'))[0].createdAt, 12);
  assert.equal((await api.getHostedRooms('ALICE'))[0].finishedAt, 13);
  const record = await api.appendUserHistory('ALICE', { id: 'h', pin: '123-456', roomTitle: 'Room', examTitle: 'Quiz', score: 2,
    correctCount: 1, totalQuestions: 2, ratioPct: 50, formattedTime: 'today', createdAt: 10, answersDetail: [{}] });
  assert.equal(record.username, 'alice'); assert.equal(record.ratio_pct, 50);
  const fallback = await api.appendUserHistory('A', { accuracyPct: 25, finishedAt: 100, details: [{}], roomTitle: 'Fallback' });
  assert.equal(fallback.ratio_pct, 25); assert.equal(fallback.created_at, 100);
  await api.appendUserHistory('A', {});
  const hosted = { id: 'hosted', pin: '123-456', title: 'Title', createdAt: 1, finishedAt: 2, formattedTime: 'today', stats: {} };
  assert.equal(await api.saveHostedRoom('ALICE', hosted), hosted);
  await api.saveHostedRoom('A', { roomTitle: 'Room', finishedAt: 100 }); await api.saveHostedRoom('A', {});
  assert.ok(calls.some(c => c[0] === 'limit' && c[1] === 20));
});
