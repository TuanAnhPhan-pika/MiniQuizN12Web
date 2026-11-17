const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
test('dashboard: renders authenticated identity, theme toggle and empty history', async t => {
  const p = await page(t, 'dashboard'); const d = p.window.document;
  assert.match(d.getElementById('user-chip-label').textContent, /teacher/);
  assert.equal(d.getElementById('hist-count').textContent, '0');
  d.getElementById('btn-dark').click(); assert.equal(d.body.classList.contains('dark'), true);
  d.getElementById('btn-dark').click(); assert.equal(d.body.classList.contains('dark'), false);
  p.window.openSettingsModal(); assert.equal(d.getElementById('settings-modal').classList.contains('show'), true);
  p.window.closeSettingsModal();
});
for (const state of ['locked', 'full', 'missing', 'offline', 'available']) {
  test('dashboard: room join ' + state, async t => {
    const body = state === 'offline' ? new Error('offline') : state === 'available' ? { success: true, room: { title: 'Room' } } : { [state]: true };
    const p = await page(t, 'dashboard', { '/api/rooms/246-579?check=1': body }); const d = p.window.document;
    d.getElementById('pin-input').value = 'bad'; await p.window.handleJoin();
    assert.equal(d.getElementById('error-msg').classList.contains('show'), true);
    d.getElementById('pin-input').value = '246-579'; await p.window.handleJoin();
    if (state === 'available') {
      assert.ok(d.querySelectorAll('.av-btn').length > 0);
      p.window.selectAvatar('02'); assert.match(d.getElementById('avatar-preview').src, /02.png/);
      p.window.backToDashboardGrid();
    } else assert.equal(d.getElementById('error-msg').classList.contains('show'), true);
  });
}
for (const mode of ['mismatch', 'success', 'limited', 'rejected', 'offline']) {
  test('dashboard: profile settings ' + mode, async t => {
    const result = mode === 'offline' ? new Error('offline') : { success: mode === 'success', displayName: 'Updated', username: 'teacher', httpStatus: mode === 'limited' ? 429 : 200 };
    const p = await page(t, 'dashboard', { '/api/auth/change-profile': result }); const d = p.window.document;
    d.getElementById('settings-name').value = 'Updated';
    d.getElementById('settings-new-pass').value = 'new-password';
    d.getElementById('settings-confirm-pass').value = mode === 'mismatch' ? 'other' : 'new-password';
    await p.window.handleSaveSettings();
    if (mode === 'success') assert.match(d.getElementById('user-chip-label').textContent, /Updated/);
    else assert.equal(d.getElementById('settings-msg').classList.contains('show'), true);
    if (mode === 'mismatch') assert.equal(p.calls.some(c => c.url === '/api/auth/change-profile'), false);
  });
}
test('dashboard: history renders ranks, fallback metadata and escaped titles', async t => {
  const history = [1, 2, 3, 4].map(rank => ({ rank, roomTitle: '<script>Room</script>', score: rank * 100,
    correctCount: 1, totalQuestions: 2, createdAt: 1700000000000, details: [] }));
  const p = await page(t, 'dashboard', { '/api/history': { history } }); const d = p.window.document;
  assert.equal(d.getElementById('hist-count').textContent, '4');
  assert.equal(d.querySelectorAll('.history-item').length, 4);
  assert.equal(d.getElementById('hist-list').querySelector('script'), null);
  p.window.openHistoryDetails(0); p.window.closeHistoryDetails(); p.window.openHistoryDetails(99);
  p.window.renderHistoryList([{ pin: '246-579', score: 0, formattedTime: 'today' }]);
  assert.match(d.getElementById('hist-list').textContent, /246-579/);
});
test('dashboard: detailed answers distinguish correct, wrong, unanswered and multiple choice', async t => {
  const details = [
    { questionText: '<script>Q</script>', choices: ['A', 'B', 'C'], userChoice: 0, correctChoice: 0, isCorrect: true, earned: 100 },
    { text: 'Wrong', choices: ['A', 'B', 'C'], userChoice: 1, correctChoice: 0, scoreAwarded: 0 },
    { choices: ['A', 'B'], correctChoice: 0 },
    { questionType: 'multiple', choices: ['A', 'B', 'C'], userChoices: [0, 1], correctChoices: [0, 2] },
    { userChoices: [7], correctChoices: [7], isCorrect: true }, {},
  ];
  const history = [
    { examTitle: 'Quiz', score: 100, totalQuestions: 6, correctCount: 1, ratioPct: 17, details },
    { pin: '246-579', score: 0, totalQuestions: 0, accuracyPct: 0, answersDetail: details },
    { score: 1, totalQuestions: 1, correctCount: 1, details: [] },
  ];
  const p = await page(t, 'dashboard', { '/api/history': { history } }); const w = p.window, d = w.document;
  for (let i = 0; i < history.length; i++) {
    w.openHistoryDetails(i); assert.equal(d.getElementById('history-modal').classList.contains('show'), true); w.closeHistoryDetails();
  }
  w.openHistoryDetails(0);
  assert.equal(d.querySelectorAll('.detail-q-card').length, 6);
  assert.equal(d.getElementById('hist-details-list').querySelector('script'), null);
});
test('dashboard: hosted reports display empty and populated statistics without unsafe markup', async t => {
  const stats = { totalCandidates: 2, capacity: 20, avgScore: 50, maxScore: 100, maxPossibleScore: 100,
    questionsStats: [20, 60, 80, 50, 100].map((ratioPct, qIdx) => ({ qIdx, ratioPct, text: '<script>Q</script>', correctIndex: 0, correctCount: 1, totalCount: 2 })),
    candidatesMatrix: [{ nick: 'Low', score: 0, ratioPct: 0, answersMap: [false] }, { nick: 'High', score: 100, ratioPct: 100, answersMap: [true] }] };
  const rooms = [{ id: 'h1', pin: '246-579', roomTitle: 'Room', stats, createdAt: 1700000000000 }, { pin: 'other', stats: {} }];
  const p = await page(t, 'dashboard', { '/api/history/hosted': { rooms, history: rooms } }); const w = p.window, d = w.document;
  w.openHostedStatsModal(0);
  assert.equal(d.querySelectorAll('#d-questions-tbody tr').length, 5);
  assert.equal(d.getElementById('d-questions-tbody').querySelector('script'), null);
  assert.match(d.querySelector('#d-matrix-tbody tr').textContent, /High/);
  assert.equal(d.getElementById('d-matrix-table').classList.contains('has-horizontal-scroll'), true);
  w.closeHostedStatsModal(); w.openHostedStatsModal(1);
  assert.equal(d.getElementById('d-matrix-table').classList.contains('has-horizontal-scroll'), false);
  w.openHostedStatsModal(999); w.closeHostedStatsModal(); w.renderHostedRoomsList(null);
});
