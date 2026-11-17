const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
function exams(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'pub' + i, code: '#' + (i + 1), title: 'Quiz ' + i,
    subject: i % 2 ? 'Math' : 'Science', author: i % 2 ? 'Author' : '', timePerQ: 15,
    sharedBy: i % 2 ? 'teacher' : 'other', questions: [{ text: '<script>Q</script>', choices: ['A', 'B'], correct: 0 }] }));
}
for (const count of [4, 18, 90]) {
  test(`library: ${count} exams paginate, filter, search and preview`, async t => {
    const p = await page(t, 'create-exam', { '/api/storage/public': { success: true, exams: exams(count) } });
    const w = p.window, d = w.document;
    await w.renderLibraryTab(); assert.equal(d.querySelectorAll('.library-card').length, Math.min(9, count));
    w.changeLibPage(999); await p.settle(); assert.ok(d.querySelectorAll('.library-card').length > 0);
    w.changeLibPage(-1); await p.settle(); assert.equal(d.querySelectorAll('.library-card').length, Math.min(9, count));
    if (count > 9) {
      for (const value of ['', '0', '999', '2']) {
        const input = d.getElementById('lib-jump-input'); input.value = value; w.jumpLibPage(Math.ceil(count / 9)); await p.settle();
      }
    }
    w.filterLibBySubject('Math'); await p.settle();
    assert.ok([...d.querySelectorAll('.lib-subject')].every(el => el.textContent === 'Math'));
    w.filterLibBySubject('missing-subject'); await p.settle(); assert.ok(d.querySelector('.library-empty-state'));
    w.filterLibBySubject('#1'); await p.settle(); assert.ok(d.querySelectorAll('.library-card').length > 0);
    w.clearLibSubjectFilter(); await p.settle();
    d.getElementById('lib-search-subject').value = 'Quiz 0'; w.handleLibSearchInput(); await p.tick(250);
    assert.equal(d.querySelectorAll('.library-card').length, 1);
    w.openQuickViewModal('pub0', 'public'); assert.equal(d.getElementById('quickview-modal').classList.contains('show'), true);
    assert.equal(d.getElementById('quickview-modal').querySelector('script'), null); w.closeQuickViewModal();
    await w.renderShareTab(); assert.ok(d.querySelectorAll('.is-shared').length > 0);
  });
}
test('library: fallback, copying public exams and room assignment', async t => {
  const p = await page(t, 'create-exam', { '/api/storage/public': new Error('offline') });
  const w = p.window;
  await w.renderLibraryTab(); assert.equal(w.document.querySelectorAll('.library-card').length, 4);
  await w.handleCreateRoomFromPublic('public-1');
  const assigned = JSON.parse(w.sessionStorage.getItem('mqc_assigned_exam'));
  assert.equal(assigned.sourceParentId, 'public-1'); assert.equal(assigned.questions.length, 3);
  await w.handleCreateRoomFromPublic('missing');
  await w.savePublicExamToPrivate('missing');
});
for (const mode of ['success', 'http-error', 'missing-exam', 'offline']) {
  test('library: save public copy ' + mode + ' preserves parent identity', async t => {
    const publicExam = exams(1)[0];
    const copy = { ...publicExam, id: 'saved-copy', code: '#1-1', parentCode: '#1' };
    const p = await page(t, 'create-exam', {
      '/api/storage/public': { success: true, exams: [publicExam] },
      '/api/storage/public/save-to-private': mode === 'offline' ? new Error('offline') : {
        success: true, httpStatus: mode === 'http-error' ? 500 : 200, ...(mode === 'missing-exam' ? {} : { exam: copy }),
      },
    }); const w = p.window;
    await w.renderLibraryTab();
    const result = await w.savePublicExamToPrivate('pub0'); assert.equal(result.parentCode, '#1');
    await w.saveAndEditPublicExam('pub0'); assert.equal(w.document.getElementById('exam-title').value, publicExam.title);
    await w.saveAndEditPublicExam('missing');
    await w.saveExamFromPublicToPrivate('pub0'); await p.settle();
    assert.ok(w.getSavedExams().some(e => e.parentCode === '#1'));
  });
}
test('library: deleting saved exams respects confirmation and updates editor selection', async t => {
  const p = await page(t, 'create-exam'); const w = p.window;
  w.loadExamForEditing('exam1');
  let promise = w.deleteSavedExam('exam1'); w.resolveSimpleConfirm(false); await promise;
  assert.ok(w.getSavedExams().some(e => e.id === 'exam1'));
  promise = w.deleteSavedExam('exam1'); w.resolveSimpleConfirm(true); await promise; await p.settle();
  assert.equal(w.getSavedExams().some(e => e.id === 'exam1'), false);
  assert.ok(p.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/exam1')));
});
