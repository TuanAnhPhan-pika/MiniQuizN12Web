const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
for (const choice of [0, 1, null]) {
  test('player room: answer ' + choice + ', server reveal, final review and history', async t => {
    const p = await page(t, 'room'); const w = p.window, d = w.document;
    assert.equal(d.querySelectorAll('.choice-btn').length, 2);
    if (choice !== null) { w.selectAnswer(choice); await p.settle(); }
    p.routes['/api/rooms/246-579/result?q=0&playerId=student'] = {
      success: true, correctChoice: 0, correctChoices: [0],
      playerResult: { choice: choice ?? -1, choices: choice === null ? [] : [choice], isCorrect: choice === 0, scoreEarned: choice === 0 ? 100 : 0, totalScore: choice === 0 ? 100 : 0 },
    };
    await w.revealAndShow(); await p.tick(1200);
    assert.equal(d.getElementById('result-panel').classList.contains('show'), true);
    const sorted = [{ id: 'student', name: 'Student', score: choice === 0 ? 100 : 0, isYou: true, av: '01' }];
    await w.showFinal(sorted, 1); await p.settle();
    assert.equal(d.getElementById('final-panel').classList.contains('show'), true);
    w.showReview(); assert.equal(d.getElementById('review-panel').classList.contains('show'), true);
    assert.equal(d.querySelectorAll('.review-question-card').length, 1);
    w.backToFinal(); assert.equal(d.getElementById('review-panel').classList.contains('show'), false);
    assert.ok(p.calls.some(c => c.url === '/api/history' && c.method === 'POST'));
    await w.saveHistoryRecord(sorted, 1);
    assert.equal(p.calls.filter(c => c.url === '/api/history' && c.method === 'POST').length, 1);
  });
}
test('player room: timeout locks inputs and rejects late answers', async t => {
  const p = await page(t, 'room'); const w = p.window;
  w.lockQuestionInputsOnTimeout(); w.selectAnswer(0); w.toggleMultiChoice(0); w.submitMultiAnswer();
  assert.equal(p.calls.filter(c => c.url.endsWith('/answer')).length, 0);
  assert.ok([...w.document.querySelectorAll('.choice-btn')].every(b => b.disabled));
  w.updateTimerUI(1, 15); w.updateTimerUI(10, 15);
});
for (const correct of [true, false]) {
  test('player room: multiple answers ' + (correct ? 'correct' : 'wrong') + ' remain hidden until server reveal', async t => {
    const p = await page(t, 'room'); const w = p.window, d = w.document;
    p.room.questions = [{ text: 'Pick two', choices: ['A', 'B', 'C'], correctChoices: [0, 2], isMultiple: true }];
    await w.syncRoomFromServer(); w.loadQuestion(0);
    w.submitMultiAnswer(); assert.equal(p.calls.some(c => c.url.endsWith('/answer')), false);
    w.toggleMultiChoice(0); w.toggleMultiChoice(0); w.toggleMultiChoice(0);
    w.toggleMultiChoice(correct ? 2 : 1); w.submitMultiAnswer(); w.submitMultiAnswer(); await p.settle();
    assert.equal(p.calls.filter(c => c.url.endsWith('/answer')).length, 1);
    assert.equal(d.querySelectorAll('.choice-btn.correct').length, 0);
    p.routes['/api/rooms/246-579/result?q=0&playerId=student'] = {
      success: true, isMultiple: true, correctChoices: [0, 2],
      playerResult: { choice: 0, choices: correct ? [0, 2] : [0, 1], isCorrect: correct, scoreEarned: correct ? 100 : 0, totalScore: correct ? 100 : 0 },
    };
    await w.revealAndShow();
    assert.equal(d.querySelectorAll('.choice-btn.wrong').length, correct ? 0 : 1);
    assert.equal(d.querySelectorAll('.choice-btn.correct').length, correct ? 2 : 1);
    await p.tick(1200); await w.showFinal([{ id: 'student', name: 'Student', score: 0, isYou: true }], 1);
    w.showReview(); assert.equal(d.querySelectorAll('.review-question-card').length, 1);
  });
}
for (const state of ['next', 'finished', 'result', 'offline', 'http-error', 'unsuccessful']) {
  test('player room: host state polling ' + state, async t => {
    const p = await page(t, 'room'); const w = p.window;
    if (state === 'next') {
      p.room.questions.push({ text: 'Second', choices: ['C', 'D'], correct: 1 }); await w.syncRoomFromServer();
    }
    p.routes['/api/rooms/246-579/state'] = state === 'offline' ? new Error('offline') : {
      success: state !== 'unsuccessful', httpStatus: state === 'http-error' ? 500 : 200,
      status: state === 'finished' ? 'finished' : 'started', phase: state === 'result' ? 'result' : 'question', currentQ: state === 'next' ? 1 : 0,
      serverNow: Date.now(), questionStartedAt: Date.now(), questionDeadline: Date.now() + 15000,
    };
    w.startPlayerStateTracking(); await p.tick(500);
    if (state === 'next') assert.match(w.document.getElementById('question-text').textContent, /Second/);
    else if (state === 'finished') assert.equal(w.document.getElementById('final-panel').classList.contains('show'), true);
    else assert.ok(p.calls.some(c => c.url.endsWith('/state')));
  });
}
