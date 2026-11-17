const test = require('node:test');
const assert = require('node:assert/strict');
const { browser } = require('../helpers/browser.cjs');
function setup(t) {
  const b = browser('<div id="result"></div><button id="analyze"></button>');
  t.after(() => b.close()); b.run('public/js/ai-weakness-ui.js');
  return { b, ui: b.window.AiWeaknessUI, containerEl: b.window.document.querySelector('#result'), btnEl: b.window.document.querySelector('button') };
}
test('weakness UI: reset, null guards, empty lists and escaped content', t => {
  const h = setup(t); h.ui.reset(null, null); h.ui.reset(h.containerEl, h.btnEl);
  assert.equal(h.btnEl.disabled, false);
  h.ui.renderAnalysis(null, {}); h.ui.renderAnalysis(h.containerEl, null);
  h.ui.renderAnalysis(h.containerEl, { overallSummary: '<script>&"\'', teachingActions: null }, false);
  assert.equal(h.containerEl.querySelector('script'), null);
  assert.match(h.containerEl.innerHTML, /&lt;script&gt;/);
  assert.equal(h.containerEl.querySelectorAll('.ai-weak-item').length, 0);
});
test('weakness UI: percentage severity boundaries and recommendations', t => {
  const h = setup(t);
  h.ui.renderAnalysis(h.containerEl, { overallSummary: null,
    weakQuestions: [0, 49, 50, 69, 70, 100, 'invalid'].map(accuracyPct => ({ accuracyPct, topicOrSkill: '<b>topic</b>', likelyMistake: undefined })),
    teachingActions: ['<img src=x>', 'review'] }, true);
  assert.equal(h.containerEl.querySelectorAll('.ai-weak-item.tone-low').length, 3);
  assert.equal(h.containerEl.querySelectorAll('.ai-weak-item.tone-mid').length, 2);
  assert.equal(h.containerEl.querySelectorAll('.ai-weak-item.tone-ok').length, 2);
  assert.equal(h.containerEl.querySelectorAll('li').length, 2);
  assert.equal(h.containerEl.querySelector('img'), null);
});
for (const mode of ['success', 'http-error', 'missing-analysis', 'invalid-json', 'network-error']) {
  test('weakness UI: analyze ' + mode, async t => {
    const h = setup(t); let calls = 0;
    h.b.window.fetch = async (url, init) => {
      calls++; assert.equal(url, '/api/ai/analyze-weakness');
      assert.equal(JSON.parse(init.body).pin, '123-456');
      if (mode === 'network-error') throw new Error('offline');
      return { ok: mode !== 'http-error', json: async () => {
        if (mode === 'invalid-json') throw new Error('invalid JSON');
        return { success: true, message: '<script>error</script>', analysis: mode === 'missing-analysis' ? null : { overallSummary: 'Summary' } };
      } };
    };
    await h.ui.analyze({ ...h, pin: '123-456', stats: { questionsStats: [{}] } });
    assert.equal(calls, 1); assert.equal(h.btnEl.disabled, false);
    assert.equal(h.containerEl.querySelector('script'), null);
    assert.ok(h.containerEl.querySelector(mode === 'success' ? '.ai-weakness-result' : '.ai-weakness-error'));
  });
}
test('weakness UI: prevents duplicate and unconfigured analysis requests', async t => {
  const h = setup(t);
  await h.ui.analyze({}); await h.ui.analyze({ ...h, stats: null });
  assert.ok(h.containerEl.querySelector('.ai-weakness-error'));
  h.btnEl.disabled = true;
  await h.ui.analyze({ ...h, stats: { questionsStats: [{}] } });
  assert.equal(h.btnEl.disabled, true);
});
