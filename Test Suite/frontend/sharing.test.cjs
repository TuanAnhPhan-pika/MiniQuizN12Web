const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
const question = { text: 'Q', choices: ['A', 'B'], correct: 0 };
const parent = { id: 'parent', code: '#1', title: 'Original', questions: [question] };
async function setup(t, exam, overrides = {}) {
  return page(t, 'create-exam', {
    '/api/storage/private': { success: true, exams: [exam] },
    '/api/storage/public': { success: true, exams: [parent] }, ...overrides,
  });
}
for (const mode of ['original', 'allowed', 'denied', 'denied-metadata', 'offline-similar', 'offline-changed', 'legacy-copy']) {
  test('sharing: opening modal validates ' + mode, async t => {
    const exam = { id: 'draft', code: mode === 'legacy-copy' ? '#1-1' : '#2', title: 'Draft', questions: [question],
      ...(mode !== 'original' && mode !== 'legacy-copy' ? { parentCode: '#1' } : {}),
    };
    if (mode === 'offline-changed') exam.questions = [{ ...question, text: 'A completely different question with a new subject and context' }];
    if (mode === 'offline-similar') exam.title = parent.title;
    const denied = mode.startsWith('denied');
    const p = await setup(t, exam, { '/api/storage/public/check-share': mode.startsWith('offline') ? new Error('offline') : {
      success: true, allowed: !denied, ...(mode === 'denied-metadata' ? { parentCode: '#1', parentTitle: 'Original', diffPercent: 2 } : {}),
    } }); const w = p.window, d = w.document;
    await w.renderLibraryTab(); await w.openShareModal('missing'); await w.openShareModal('draft');
    const warning = denied || mode === 'offline-similar';
    assert.equal(d.getElementById(warning ? 'share-warning-modal' : 'share-modal').classList.contains('show'), true);
    if (warning) { w.handleWarningEditNow(); assert.equal(d.getElementById('exam-title').value, exam.title); }
    w.closeShareWarningModal(); w.handleWarningEditNow(); w.closeShareModal();
  });
}
for (const mode of ['success', 'conflict', 'conflict-code', 'rejected', 'offline']) {
  test('sharing: publish response ' + mode, async t => {
    const exam = { id: 'draft', code: '#1-1', parentCode: '#1', title: 'Draft', questions: [question] };
    const response = mode === 'offline' ? new Error('offline') : { success: mode === 'success',
      httpStatus: mode === 'success' ? 200 : mode === 'conflict' ? 409 : 400,
      ...(mode === 'conflict-code' ? { code: 'COPY_SIMILARITY_TOO_HIGH', parentCode: '#1', parentTitle: 'Parent', diffPercent: 1 } : {}),
    };
    const p = await setup(t, exam, { '/api/storage/public/check-share': { success: true, allowed: true }, '/api/storage/public/share': response });
    const w = p.window, d = w.document;
    await w.confirmShareExam(); assert.equal(p.calls.some(c => c.url.endsWith('/share')), false);
    await w.openShareModal('draft'); d.getElementById('share-desc-input').value = 'Description';
    await w.confirmShareExam(); await p.settle();
    const request = p.calls.find(c => c.url.endsWith('/share'));
    assert.equal(JSON.parse(request.body).exam.desc, 'Description');
    if (mode.startsWith('conflict')) assert.equal(d.getElementById('share-warning-modal').classList.contains('show'), true);
    else if (mode === 'success') assert.equal(d.getElementById('share-modal').classList.contains('show'), false);
    else assert.ok(d.getElementById('toast').classList.contains('show'));
  });
}
for (const mode of ['cancel', 'success', 'rejected', 'offline']) {
  test('sharing: unpublish ' + mode, async t => {
    const p = await setup(t, { id: 'draft', title: 'Draft', questions: [] }, {
      '/api/storage/public/parent': mode === 'offline' ? new Error('offline') : { success: mode === 'success' },
    });
    const promise = p.window.unshareExamFromPublic('parent'); p.window.resolveSimpleConfirm(mode !== 'cancel');
    await promise; await p.settle();
    assert.equal(p.calls.some(c => c.url.endsWith('/parent') && c.method === 'DELETE'), mode !== 'cancel');
  });
}
