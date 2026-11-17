const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
const text = 'Cau 1: What is 1 + 1?\nA. 2\nB. 3\nANSWER: A';
async function setup(t) {
  const p = await page(t, 'create-exam'); p.run('public/js/exam-importer.js');
  p.window.document.getElementById('import-raw-text').value = text;
  await p.window.handleImportPastedText(); return p;
}
test('import workflow: parse pasted text, edit multi-choice, preserve at least one answer', async t => {
  const p = await setup(t); const w = p.window, d = w.document;
  assert.equal(d.querySelectorAll('.import-q-card').length, 1);
  d.getElementById('import-exam-title').value = 'Imported Quiz';
  let exam = w.buildImportedExamObject(); assert.equal(exam.questions[0].correct, 0);
  w.updateImportQuestionText(0, ' Updated question '); w.updateImportQuestionText(999, 'ignored');
  w.toggleImportQuestionMode(999); w.setImportQuestionCorrect(999, 0);
  w.toggleImportQuestionMode(0); assert.equal(w.buildImportedExamObject(), null);
  w.setImportQuestionCorrect(0, 0); assert.equal(w.buildImportedExamObject(), null);
  w.setImportQuestionCorrect(0, 1); exam = w.buildImportedExamObject();
  assert.equal(exam.questions[0].isMultiple, true); assert.equal(exam.questions[0].text, 'Updated question');
  w.setImportQuestionCorrect(0, 0); w.toggleImportQuestionMode(0); w.setImportQuestionCorrect(0, 0);
  assert.equal(w.buildImportedExamObject().questions[0].correct, 0);
  await w.handleSaveImportedExam(); await p.settle();
  assert.ok(p.calls.some(c => c.method === 'POST' && c.url === '/api/storage/private'));
  w.handleApplyImportToEditor(); assert.equal(w.handleSaveExam(false).questions.length, 1);
  w.deleteImportQuestion(-1); w.deleteImportQuestion(999); w.deleteImportQuestion(0);
  assert.equal(w.buildImportedExamObject(), null); w.resetImportPreview();
  assert.equal(d.getElementById('import-raw-text').value, '');
});
test('import workflow: empty input and importer errors show feedback without a draft', async t => {
  const p = await page(t, 'create-exam'); const w = p.window, d = w.document;
  w.switchImportMode('text'); w.switchImportMode('file');
  await w.handleImportPastedText(); assert.equal(w.buildImportedExamObject(), null);
  await w.handleImportFileInput([]);
  w.ExamImporter = { parseVnText() { throw new Error('Unsupported text'); }, async parseFile() { throw new Error('Bad file'); } };
  d.getElementById('import-raw-text').value = 'bad'; await w.handleImportPastedText();
  assert.match(d.getElementById('toast').textContent, /Unsupported text/);
  await w.handleImportFileInput([{ name: 'invalid.txt' }]);
  assert.match(d.getElementById('toast').textContent, /Bad file/);
  w.ExamImporter = { parseVnText: () => ({ questions: [] }), parseFile: async () => ({ questions: [] }) };
  await w.handleImportPastedText(); await w.handleImportFileInput([{ name: 'empty.txt' }]);
  assert.equal(d.getElementById('import-loading').style.display, 'none');
});
test('import workflow: file metadata and room handoff retain imported questions', async t => {
  const p = await setup(t); const w = p.window;
  w.ExamImporter = { parseFile: async () => ({ title: 'File Quiz', subject: 'Math', questions: [{ text: 'Q', choices: ['A', 'B'], correct: 1 }] }) };
  await w.handleImportFileInput([{ name: 'quiz-file.txt' }]);
  assert.equal(w.buildImportedExamObject().title, 'File Quiz');
  await w.handleCreateRoomFromImported();
  const assigned = JSON.parse(w.sessionStorage.getItem('mqc_assigned_exam'));
  assert.equal(assigned.questions[0].correct, 1);
});
