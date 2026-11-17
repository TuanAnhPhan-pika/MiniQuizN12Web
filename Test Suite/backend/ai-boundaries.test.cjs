const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load.cjs');
const input = { topic: 'Mathematics', count: 1 };
function aiFixture(reply, thinking) {
  const api = load('src/ai/gemini.js'); let calls = 0; const requests = [];
  api.setGenAIClientFactoryForTest(() => ({ sdk: { Type: { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY', INTEGER: 'INTEGER', NUMBER: 'NUMBER' }, ThinkingLevel: thinking },
    ai: { models: { async generateContent(request) { calls++; requests.push(request); if (reply instanceof Error || typeof reply === 'string') throw reply; return reply; } } } }));
  return { api, requests, count: () => calls };
}
for (const [error, code] of [
  [Object.assign(new Error(''), { statusCode: 429 }), 'RESOURCE_EXHAUSTED'],
  [new Error('RESOURCE_EXHAUSTED'), 'RESOURCE_EXHAUSTED'], [new Error('error 429'), 'RESOURCE_EXHAUSTED'],
  [Object.assign(new Error(''), { status: 400 }), 'GEMINI_AUTH_ERROR'],
  [new Error('API_KEY_INVALID'), 'GEMINI_AUTH_ERROR'], [new Error('PERMISSION_DENIED'), 'GEMINI_AUTH_ERROR'],
  [new Error('NOT_FOUND'), 'GEMINI_MODEL_NOT_FOUND'], [new Error('unknown failure'), 'GEMINI_UNAVAILABLE'],
  ['failure', 'GEMINI_UNAVAILABLE'],
  [Object.assign(new Error('missing key'), { code: 'AI_KEY_MISSING' }), 'AI_KEY_MISSING'],
]) {
  test('AI: maps error ' + String(error.message || error) + ' to ' + code, async () => {
    const h = aiFixture(error);
    await assert.rejects(h.api.generateQuestions(input), e => e.code === code);
    assert.equal(h.count(), 1);
  });
}
for (const status of [500, 503]) {
  test('AI: retries transient HTTP ' + status + ' only once', async () => {
    const h = aiFixture(Object.assign(new Error('unavailable'), { status }));
    await assert.rejects(h.api.generateQuestions(input), e => e.code === 'GEMINI_UNAVAILABLE');
    assert.equal(h.count(), 2);
  });
}
for (const type of ['single', 'multiple', 'invalid-type']) {
  test('AI: generation type ' + type + ' and default response metadata', async () => {
    const h = aiFixture({ text: JSON.stringify({ questions: [{ questionText: 'Question', choices: ['A. Alpha', 'B. Beta', 'C. Gamma', 'D. Delta'], correctIndices: [0, 2] }] }) }, { MINIMAL: 'MINIMAL' });
    const result = await h.api.generateQuestions({ ...input, topic: ' Topic ', questionType: type, gradeOrLevel: 'Grade 5', count: -1 });
    assert.equal(result.suggestedTitle, 'Topic'); assert.equal(result.questions.length, 1);
    assert.equal(!!result.questions[0].isMultiple, type !== 'single');
    assert.equal(h.requests[0].config.thinkingConfig.thinkingLevel, 'MINIMAL');
  });
}
test('AI: normalization discards invalid questions and bounds incorrect answer indices', () => {
  const { api } = aiFixture({});
  assert.equal(api.normalizeGeneratedQuestions(null).length, 0);
  const valid = { text: 'Q', choices: ['A', 'B', 'C', 'D'] };
  for (const correct of [-1, 4, 0.5, 'bad', undefined, 0, '2']) {
    const questions = api.normalizeGeneratedQuestions([null, false, 3, {}, { text: 'Q' }, { ...valid, correct }]);
    assert.equal(questions.length, 1); assert.ok(questions[0].correct >= 0 && questions[0].correct < 4);
  }
});
for (const raw of [null, {}, { weakQuestions: [null, false, {}, { qIdx: 9, accuracyPct: 200 }], teachingActions: [null, '', 'Review'] }]) {
  test('AI: weakness normalization safely handles ' + JSON.stringify(raw), () => {
    const { api } = aiFixture({});
    const compressed = api.buildWeaknessStatsInput({ stats: { questionsStats: [{}, { qIdx: 2, ratioPct: 0 }] } });
    const result = api.normalizeWeaknessAnalysis(raw, compressed);
    assert.ok(result.overallSummary); assert.ok(result.teachingActions.length > 0);
    assert.ok(result.weakQuestions.every(q => q.accuracyPct >= 0 && q.accuracyPct <= 100));
    assert.equal(api.buildWeaknessStatsInput({ stats: null }).questions.length, 0);
    assert.match(api.buildWeaknessCacheKey(null, compressed), /^stats:/);
  });
}
for (const text of [undefined, '', '{bad', '{}']) {
  test('AI: weakness response parsing ' + JSON.stringify(text), async () => {
    const h = aiFixture({ text });
    const payload = { stats: { questionsStats: [{}] } };
    if (text === '{bad') await assert.rejects(h.api.analyzeClassWeakness(payload), e => e.status === 502);
    else {
      const result = await h.api.analyzeClassWeakness(payload); assert.ok(result.analysis.overallSummary);
      assert.equal((await h.api.analyzeClassWeakness(payload)).cached, true);
    }
  });
}
