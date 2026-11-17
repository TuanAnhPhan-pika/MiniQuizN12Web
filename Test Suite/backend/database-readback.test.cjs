const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load.cjs');
function setup(rows, failAnswers = false) {
  const queries = [];
  const api = load('src/db/index.js', { './pool.js': { async query(sql, args) {
    queries.push({ sql, args });
    if (sql.includes('attempt_answers')) { if (failAnswers) throw new Error('unavailable'); return { rows: [] }; }
    return { rows };
  } } });
  return { api, queries };
}
for (const details of [null, 'invalid-json', '[]', 'null', '"not-array"', [{ questionIndex: 0 }], '[{"questionIndex":0}]']) {
  test('database readback: history details ' + JSON.stringify(details), async () => {
    const h = setup([{ id: 'a', user_id: 'alice', details, score: 10, total_questions: 2, correct_count: 1 }]);
    const rows = await h.api.getUserAttempts('ALICE');
    assert.equal(rows.length, 1); assert.equal(rows[0].accuracyPct, 50);
    assert.ok(Array.isArray(rows[0].details)); assert.equal(h.queries[0].args[0], 'alice');
  });
}
test('database readback: empty and degraded answer tables remain readable', async () => {
  assert.equal((await setup([]).api.getUserAttempts()).length, 0);
  const rows = await setup([{ id: 'a', score: 0, total_questions: 0, correct_count: 0, details: null }], true).api.getUserAttempts('A');
  assert.equal(rows[0].accuracyPct, 0); assert.equal(rows[0].maxScore, 100);
});
for (const stats of [null, {}, '{"totalCandidates":2}']) {
  test('database readback: hosted statistics ' + JSON.stringify(stats), async () => {
    const h = setup([{ id: 'h', room_code: '246-579', created_at: '123', stats }]);
    const rows = await h.api.getHostedGameSessions('ALICE');
    assert.equal(rows[0].createdAt, 123); assert.equal(rows[0].finishedAt, 123);
    assert.equal(typeof rows[0].stats, 'object'); assert.equal(h.queries[0].args[0], 'alice');
  });
}
for (const data of [null, {}, { analysis: { overallSummary: 'Summary' } }, '{"analysis":{"overallSummary":"Summary"},"model":"test-model"}']) {
  test('database readback: weakness cache ' + JSON.stringify(data), async () => {
    const h = setup([{ id: 'job', result_data: data }]);
    const result = await h.api.findCachedWeaknessAnalysis('ALICE', 'cache');
    if (data && (typeof data === 'string' || data.analysis)) assert.equal(result.analysis.overallSummary, 'Summary');
    else assert.equal(result, null);
    assert.equal(await h.api.findCachedWeaknessAnalysis('', 'cache'), null);
    assert.equal(await h.api.findCachedWeaknessAnalysis('alice', ''), null);
  });
}
test('database readback: missing AI jobs and nullable update results', async () => {
  const h = setup([]);
  assert.equal(await h.api.findCachedWeaknessAnalysis('alice', 'cache'), null);
  assert.equal(await h.api.updateAiGenerationJob('', {}), null);
  assert.equal(await h.api.updateAiGenerationJob('job', {}), null);
  assert.equal(await h.api.updateAiGenerationJob('job', { status: 'failed', resultData: { message: 'error' } }), null);
});
