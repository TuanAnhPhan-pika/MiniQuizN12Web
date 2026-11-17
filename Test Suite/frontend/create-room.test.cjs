const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
test('create room: exam selection, preview, name validation and server creation', async t => {
  const p = await page(t, 'create-room', { '/api/rooms': { success: true, pin: '246-579' } });
  const w = p.window, d = w.document;
  assert.equal(d.getElementById('selected-exam-id').value, 'exam1');
  w.toggleExamDropdown(); assert.equal(d.getElementById('custom-exam-wrapper').classList.contains('open'), true);
  w.selectExam('exam1', { stopPropagation() {} });
  w.previewCurrentExam(); w.closeQuickViewModal(); w.openQuickViewModal('missing');
  d.getElementById('room-name').value = '';
  await w.handleCreateRoomNow();
  assert.equal(p.calls.some(c => c.url === '/api/rooms'), false);
  w.closeWarningModal();
  d.getElementById('room-name').value = '  Class A  ';
  d.getElementById('room-capacity').value = '20';
  await w.handleCreateRoomNow(); await p.settle();
  const request = p.calls.find(c => c.url === '/api/rooms');
  assert.equal(JSON.parse(request.body).name, 'Class A');
  assert.equal(JSON.parse(request.body).capacity, 20);
  assert.equal(d.getElementById('room-name').value, '');
  assert.match(d.getElementById('pin-display').textContent, /246-579/);
  w.handleRoomHover('246-579'); w.handleRoomLeave(); w.handleRoomClick('246-579');
  w.handleRoomClick('246-579'); w.renderRoomQR(null); w.renderRoomQR('246-579');
});
for (const mode of ['server-error', 'offline', 'no-exams']) {
  test('create room: rejects ' + mode + ' without storing a room', async t => {
    const p = await page(t, 'create-room', {
      '/api/rooms': mode === 'offline' ? new Error('offline') : { success: false, httpStatus: 409, message: 'limit' },
      ...(mode === 'no-exams' ? { '/api/storage/private': { exams: [] } } : {}),
    });
    p.window.document.getElementById('room-name').value = 'Class';
    await p.window.handleCreateRoomNow();
    assert.equal(p.window.localStorage.getItem('mqc_custom_rooms'), null);
    assert.ok(p.alerts.length > 0 || p.window.document.getElementById('warning-modal').classList.contains('show'));
  });
}
test('create room: natural PIN format and clipboard fallback', async t => {
  const p = await page(t, 'create-room');
  for (let i = 0; i < 20; i++) {
    const pin = p.window.generateNaturalPin(); assert.match(pin, /^\d{3}-\d{3}$/);
    for (const triple of pin.split('-')) {
      assert.notEqual(triple[0] === triple[1] && triple[1] === triple[2], true);
    }
  }
  p.window.copyPinCode(); await p.settle();
});
for (const source of ['author', 'shared', 'empty']) {
  test('create room: preview ' + source + ' exam metadata and multi-choice answers', async t => {
    const exam = { id: 'preview', title: 'Preview',
      ...(source === 'author' ? { author: 'Author', subject: 'Math', code: '#12', timePerQ: 20 } : source === 'shared' ? { sharedBy: 'Teacher' } : {}),
      questions: source === 'empty' ? null : [{ text: '<script>Q</script>', choices: ['A', 'B', 'C'], correctChoices: [0, 2], isMultiple: true }, { text: 'No choices' }],
    };
    const p = await page(t, 'create-room', { '/api/storage/private': { success: true, exams: [exam] } });
    p.window.openQuickViewModal('preview', { stopPropagation() {} });
    assert.equal(p.window.document.getElementById('quickview-modal').classList.contains('show'), true);
    assert.equal(p.window.document.getElementById('qv-questions-list').querySelector('script'), null);
    assert.equal(p.window.document.querySelectorAll('.qv-correct-badge').length, source === 'empty' ? 0 : 2);
    p.window.closeQuickViewModal();
  });
}
