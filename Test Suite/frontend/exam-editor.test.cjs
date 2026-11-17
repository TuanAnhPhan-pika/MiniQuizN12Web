const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
function fill(w, mode = 'single') {
  const d = w.document;
  w.setQuestionTypeMode(mode);
  d.getElementById('q-text').value = '<script>Question</script>';
  for (let i = 0; i < 4; i++) d.getElementById('choice-input-' + i).value = 'Choice ' + i;
  const inputs = d.querySelectorAll('[name="correct-answer"]');
  inputs.forEach((el, i) => { el.checked = mode === 'multiple' ? i < 2 : i === 0; });
}
test('exam editor: validates, creates, edits and deletes single and multiple choice questions', async t => {
  const p = await page(t, 'create-exam'); const w = p.window, d = w.document;
  w.handleAddNewExam(); w.handleSaveQuestion(); assert.equal(d.activeElement.id, 'q-text');
  d.getElementById('q-text').value = 'Question'; w.handleSaveQuestion(); assert.equal(d.activeElement.id, 'choice-input-0');
  fill(w); w.handleSaveQuestion();
  d.getElementById('exam-title').value = 'Test Quiz';
  let exam = w.handleSaveExam(false); assert.equal(exam.questions.length, 1);
  assert.equal(d.querySelector('#questions-list script'), null);
  w.editQuestion(0); d.getElementById('q-text').value = 'Updated'; w.handleSaveQuestion();
  fill(w, 'multiple'); w.handleSaveQuestion(); exam = w.handleSaveExam(false);
  assert.equal(exam.questions.length, 2); assert.equal(exam.questions[1].isMultiple, true);
  assert.equal(JSON.stringify(exam.questions[1].correctChoices), '[0,1]');
  w.editQuestion(1); w.cancelEditQuestion();
  const cancelled = w.deleteQuestion(0); w.resolveSimpleConfirm(false); await cancelled;
  assert.equal(w.handleSaveExam(false).questions.length, 2);
  const deleted = w.deleteQuestion(0); w.resolveSimpleConfirm(true); await deleted;
  assert.equal(w.handleSaveExam(false).questions.length, 1);
  w.loadExamForEditing(exam.id); w.handleSavedExamSearchInput(); w.clearSavedExamSearch();
  await p.settle(); assert.ok(p.calls.some(c => c.url === '/api/storage/private' && c.method === 'POST'));
});
for (const mode of ['success', 'empty', 'rejected', 'offline']) {
  test('exam editor: AI generation ' + mode, async t => {
    const p = await page(t, 'create-exam', { '/api/ai/generate-questions': mode === 'offline' ? new Error('offline') : {
      success: mode !== 'rejected', suggestedTitle: 'AI Quiz', suggestedSubject: 'Math',
      questions: mode === 'empty' ? [] : [{ text: 'AI Question', choices: ['A', 'B'], correct: 0 }],
    } }); const w = p.window, d = w.document;
    w.handleAddNewExam(); w.openAiGenerateModal(); d.getElementById('ai-topic-input').value = '';
    await w.handleGenerateQuestionsAI(); assert.equal(d.getElementById('ai-gen-error').style.display, 'block');
    d.getElementById('ai-topic-input').value = 'Mathematics';
    await w.handleGenerateQuestionsAI();
    assert.equal(d.getElementById('btn-ai-submit').disabled, false);
    if (mode === 'success') assert.equal(w.handleSaveExam(false).questions.length, 1);
    else assert.equal(d.getElementById('ai-gen-error').style.display, 'block');
    w.closeAiGenerateModal();
  });
}
