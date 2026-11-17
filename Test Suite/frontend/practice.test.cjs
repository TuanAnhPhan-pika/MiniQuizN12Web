const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
for (const mode of ['correct', 'wrong', 'unanswered', 'multiple']) {
  test('practice: offline scoring, review and cleanup ' + mode, async t => {
    const pin = 'TEST-practice';
    const question = mode === 'multiple' ? { text: 'Multi', choices: ['A', 'B', 'C'], correctChoices: [0, 2], isMultiple: true } : { text: 'Single', choices: ['A', 'B'], correct: 0 };
    const p = await page(t, 'room', { ['/api/rooms/' + pin]: new Error('offline') }, {
      url: 'https://quiz.test/room.html?pin=' + pin + '&nick=Student&isTest=1',
      localStorage: { mqc_custom_rooms: JSON.stringify({ [pin]: { title: 'Practice', id: 'practice-exam', questions: [question], isTest: true, timePerQ: 10 } }) },
    }); const w = p.window, d = w.document;
    if (mode === 'multiple') { w.toggleMultiChoice(0); w.toggleMultiChoice(2); w.submitMultiAnswer(); }
    else if (mode !== 'unanswered') w.selectAnswer(mode === 'correct' ? 0 : 1);
    await p.settle(); await w.revealAndShow(); await p.tick(1200); await p.tick(4000); await p.settle();
    assert.equal(d.getElementById('final-panel').classList.contains('show'), true);
    w.showReview(); assert.equal(d.querySelectorAll('.review-question-card').length, 1);
    assert.equal(JSON.parse(w.localStorage.getItem('mqc_custom_rooms'))[pin], undefined);
    assert.equal(p.calls.some(c => c.url === '/api/history' && c.method === 'POST'), false);
    if (['correct', 'multiple'].includes(mode)) assert.match(d.getElementById('stat-accuracy-rate').textContent, /100%/);
    else assert.match(d.getElementById('stat-accuracy-rate').textContent, /0%/);
  });
}
for (const state of ['waiting', 'countdown', 'started', 'cancelled', 'players', 'invalid-players']) {
  test('practice waiting room: offline storage event ' + state, async t => {
    const pin = 'TEST-waiting';
    const p = await page(t, 'waiting-room-for-guests', { ['/api/rooms/' + pin + '/join']: new Error('offline'), ['/api/rooms/' + pin + '/status']: new Error('offline') }, {
      url: 'https://quiz.test/waiting-room-for-guests.html?pin=' + pin + '&nick=Student',
      localStorage: { ['mqc_waiting_players_' + pin]: '[]' },
    }); const w = p.window;
    await w.joinWaitingRoom();
    assert.equal(w.document.querySelectorAll('.player-slot-card').length, 1);
    if (state.endsWith('players')) {
      w.dispatchEvent(new w.StorageEvent('storage', { key: 'mqc_waiting_players_' + pin, newValue: state === 'players' ? JSON.stringify([{ nick: 'Other', isHost: true }]) : '{' }));
      assert.equal(w.document.querySelectorAll('.player-slot-card').length, 1);
    } else {
      w.localStorage.setItem('mqc_room_status_' + pin, state);
      w.dispatchEvent(new w.StorageEvent('storage', { key: 'mqc_room_status_' + pin, newValue: state }));
      if (state === 'cancelled') assert.equal(w.document.getElementById('cancelled-modal').classList.contains('show'), true);
      else if (state === 'countdown') assert.equal(w.document.getElementById('countdown-overlay').classList.contains('show'), true);
      else await p.tick(1000);
    }
  });
}
