const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
test('host monitor: question, answer normalization, live counts and reveal', async t => {
  const p = await page(t, 'host-monitor'); const w = p.window, d = w.document;
  assert.match(d.getElementById('room-title').textContent, /Test Room/);
  assert.equal(d.querySelectorAll('.monitor-choice-item').length, 2);
  assert.equal(JSON.stringify(w.getQuestionCorrectList({ choices: ['a', 'b'], correctChoices: [1, 0, 1, -1, 3, 'bad'] })), '[0,1]');
  assert.equal(JSON.stringify(w.getQuestionCorrectList({ correct: 0 })), '[0]');
  assert.equal(w.getQuestionCorrectList(null).length, 0);
  assert.equal(w.getQuestionCorrectList({ correct: -1 }).length, 0);
  w.updateChoiceStatsUI([1, 0], 1, 1);
  assert.match(d.getElementById('choice-badge-0').textContent, /100%/);
  w.updateTimerUI(1, 15); w.updateTimerUI(8, 15);
  w.handleTimeUp(); await p.settle();
  assert.ok(p.calls.some(c => c.url.includes('/advance')));
  w.renderPodiumAndRows([]);
  w.renderPodiumAndRows([1, 2, 3, 4].map(i => ({ nick: '<script>Player</script>' + i, score: i * 10, av: '01' })));
  assert.equal(d.querySelector('.leaderboard-panel script'), null);
});
test('host monitor: statistics, severity boundaries and result matrix sorting', async t => {
  const p = await page(t, 'host-monitor'); const w = p.window, d = w.document;
  const stats = { totalCandidates: 3, capacity: 40, avgScore: 50, maxScore: 100, maxPossibleScore: 100,
    questionsStats: [0, 49, 50, 69, 70].map((ratioPct, qIdx) => ({ qIdx, ratioPct, text: '<script>Q</script>', correctIndex: 0, correctCount: 1, totalCount: 2 })),
    candidatesMatrix: [{ nick: 'Low', ratioPct: 0, score: 0, answersMap: [false] }, { nick: 'High', ratioPct: 100, score: 100, answersMap: [true] }] };
  w.renderStatsUI(stats);
  assert.equal(d.querySelectorAll('#questions-stats-tbody tr').length, 5);
  assert.equal(d.querySelectorAll('.ratio-high').length, 1);
  assert.equal(d.querySelectorAll('.ratio-mid').length, 2);
  assert.match(d.querySelector('#matrix-tbody tr').textContent, /High/);
  assert.equal(d.getElementById('matrix-table').classList.contains('has-horizontal-scroll'), true);
  w.renderStatsUI({ ...stats, questionsStats: [], candidatesMatrix: [] });
  assert.equal(d.getElementById('matrix-table').classList.contains('has-horizontal-scroll'), false);
  w.renderFallbackStats(); assert.match(d.getElementById('stat-candidates').textContent, /0/);
});
test('host monitor: moving between questions, optional metadata and unavailable AI widget', async t => {
  const p = await page(t, 'host-monitor'); const w = p.window, d = w.document;
  p.room.questions = [{ text: 'First', choices: ['A', 'B'], correct: 0 }, { text: 'Second', choices: [], timeLimit: 1 }];
  await w.initMonitor(); await w.handleHostNextNow(); await p.settle();
  assert.ok(p.calls.some(c => c.url.endsWith('/advance') && c.body && JSON.parse(c.body).nextQ === 1));
  assert.equal(JSON.stringify(w.getQuestionCorrectList({ correctChoices: [-1, 99], choices: ['A'], correct: 0 })), '[0]');
  assert.equal(w.getQuestionCorrectList({ correctChoices: [99], choices: ['A'] }).length, 0);
  assert.equal(w.getQuestionCorrectList({ correct: 0.5 }).length, 0);
  w.AiWeaknessUI = null; w.handleAnalyzeWeaknessAI(); w.renderFallbackStats();
  w.renderStatsUI({ candidatesMatrix: [{ nick: 'A', ratioPct: 50 }, { nick: 'B', ratioPct: 50 }] });
  assert.equal(d.querySelectorAll('#matrix-tbody tr').length, 2);
  w.renderStatsUI({}); assert.equal(d.querySelectorAll('#matrix-tbody tr').length, 0);
  await w.showLeaderboardPanel(); await p.settle();
  assert.ok(p.calls.some(c => c.url.endsWith('/leaderboard')));
});
