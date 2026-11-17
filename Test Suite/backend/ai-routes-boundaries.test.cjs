const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServerHarness } = require('../helpers/ai-http.cjs');
const stats = { questionsStats: [{ qIdx: 1, text: 'Q', ratioPct: 40, correctCount: 2, totalCount: 5 }] };
async function post(h, path, body, token = 'alice') {
  const response = await fetch(h.base + '/api/ai/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
for (const mode of ['missing', 'foreign', 'owner-id', 'admin', 'owner-name', 'snapshot-foreign', 'snapshot-error', 'snapshot-owner', 'no-stats']) {
  test('AI routes: hosted ownership ' + mode, async t => {
    const session = mode === 'missing' ? null : { id: 'session', hostId: mode === 'owner-name' ? 'ALICE' : null,
      hostUserId: mode === 'owner-id' ? 1 : 999, roomTitle: mode === 'snapshot-owner' ? '' : 'Room', stats };
    const h = await loadServerHarness(t, {
      dbOverrides: { async getHostedGameSessionById() { if (mode === 'snapshot-error') throw new Error('offline'); return session; } },
      authOverrides: { findUserByUsernameSync: () => ({ id: 1, username: 'alice', role: mode === 'admin' ? 'admin' : 'teacher' }) },
      aiOverrides: { async analyzeClassWeakness() { return { model: 'fixture', cached: false, analysis: { overallSummary: 'Summary' } }; } },
    });
    const body = mode === 'no-stats' ? {} : { sessionId: 'session', ...(mode.startsWith('snapshot') ? { stats } : {}) };
    const res = await post(h, 'analyze-weakness', body);
    assert.equal(res.status, mode === 'missing' ? 404 : mode === 'no-stats' ? 400 : ['foreign', 'snapshot-foreign', 'snapshot-owner'].includes(mode) ? 403 : 200);
    if (res.status === 200) assert.equal(res.body.analysis.overallSummary, 'Summary');
  });
}
for (const mode of ['rate-limit', 'cache-error', 'cache-default-model', 'audit-error', 'generation-error']) {
  test('AI routes: analysis ' + mode, async t => {
    const h = await loadServerHarness(t, {
      dbOverrides: {
        async findCachedWeaknessAnalysis() {
          if (mode === 'cache-error') throw new Error('cache unavailable');
          return mode === 'cache-default-model' ? { analysis: { overallSummary: 'Cached' } } : null;
        },
        async createAiDocument() { if (mode === 'audit-error') throw new Error('audit unavailable'); return { id: 'doc' }; },
        async updateAiGenerationJob() { throw new Error('audit write unavailable'); },
      },
      aiOverrides: {
        checkAiRateLimit: () => ({ allowed: mode !== 'rate-limit', message: 'rate limited' }),
        async analyzeClassWeakness() { if (mode === 'generation-error') throw new Error('generation failed'); return { analysis: { overallSummary: 'Summary' } }; },
      },
    });
    const res = await post(h, 'analyze-weakness', { stats, roomTitle: 'Room' });
    assert.equal(res.status, mode === 'rate-limit' ? 429 : mode === 'generation-error' ? 500 : 200);
    if (mode === 'cache-default-model') { assert.equal(res.body.cached, true); assert.ok(res.body.model); }
  });
}
test('AI routes: reject unauthenticated and student callers before invoking AI', async t => {
  const h = await loadServerHarness(t, { authOverrides: { findUserByUsernameSync: () => ({ username: 'alice', role: 'student' }) } });
  for (const route of ['generate-questions', 'analyze-weakness']) {
    assert.equal((await post(h, route, {}, '')).status, 401);
    assert.equal((await post(h, route, {})).status, 403);
  }
});
