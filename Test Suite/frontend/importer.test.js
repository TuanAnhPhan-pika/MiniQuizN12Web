const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = v => JSON.parse(JSON.stringify(v));

function loadImporter({ withLibs = false } = {}) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    TextDecoder,
    TextEncoder,
    document: { head: { appendChild() {} }, createElement: () => ({}) },
  };
  context.window = context;
  context.self = context;
  context.global = context;

  if (withLibs) {
    const xlsxPath = path.resolve(__dirname, '../../public/js/xlsx.full.min.js');
    vm.runInNewContext(fs.readFileSync(xlsxPath, 'utf8'), context, { filename: xlsxPath });
    const mammothPath = path.resolve(__dirname, '../../public/js/mammoth.browser.min.js');
    vm.runInNewContext(fs.readFileSync(mammothPath, 'utf8'), context, { filename: mammothPath });
  }

  const importerPath = path.resolve(__dirname, '../../public/js/exam-importer.js');
  vm.runInNewContext(fs.readFileSync(importerPath, 'utf8'), context, { filename: importerPath });
  return context.ExamImporter;
}

function makeMockFile(name, bufferOrText) {
  const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText), 'utf8');
  return {
    name,
    async text() { return buf.toString('utf8'); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

test('parseVnText rejects empty or whitespace-only input', () => {
  const ExamImporter = loadImporter();
  const empty = ExamImporter.parseVnText('   \r\n\t  ');
  assert.equal(empty.questions.length, 0);
  assert.match(empty.error, /trống/);
});

test('parseVnText extracts title and subject metadata from header lines', () => {
  const ExamImporter = loadImporter();
  const res = ExamImporter.parseVnText([
    'Đề thi: Kiểm tra giữa kỳ 1',
    'Môn học: Toán học 12',
    'Câu 1: 1 + 1 = ?',
    'A. 1',
    '*B. 2',
  ].join('\n'));
  assert.equal(res.title, 'Kiểm tra giữa kỳ 1');
  assert.equal(res.subject, 'Toán học 12');
  assert.equal(res.questions[0].correct, 1);
});

test('parseVnText parses sample Mau_De_Thi_Aiken.txt completely', () => {
  const ExamImporter = loadImporter();
  const txt = fs.readFileSync(path.resolve(__dirname, '../../public/samples/Mau_De_Thi_Aiken.txt'), 'utf8');
  const res = ExamImporter.parseVnText(txt);
  assert.equal(res.questions.length, 5);
  assert.deepEqual(plain(res.questions.map(q => q.correct)), [1, 0, 2, 3, 1]);
});

test('parseVnText supports mixed prefixes (Bài, Question, Q) and single-choice answer markers', () => {
  const ExamImporter = loadImporter();
  const res = ExamImporter.parseVnText([
    'Bài 1 - Thủ đô Pháp?',
    'A. Berlin',
    'B. Paris',
    'Key: B',
    'Question 2: Nước sôi ở?',
    'A. 50C',
    'B. 100C',
    'Đ/a: B',
    'Q3) 3 * 3 = ?',
    'A. 6',
    'B. 9',
    'ANSWER: B',
  ].join('\n'));
  assert.equal(res.questions.length, 3);
  assert.deepEqual(plain(res.questions.map(q => q.correct)), [1, 1, 1]);
});

test('parseVnText parses inline choices and multiple asterisk markers', () => {
  const ExamImporter = loadImporter();
  const res = ExamImporter.parseVnText([
    'Câu 1: Giá trị của 2^3 là?',
    'A. 2    B. 4    *C. 8    D. 16',
    'Câu 2: Số chẵn?',
    '*A. 2   B. 3   *C. 4   D. 5',
  ].join('\n'));
  assert.equal(res.questions.length, 2);
  assert.deepEqual(plain(res.questions[0].choices), ['2', '4', '8', '16']);
  assert.equal(res.questions[0].correct, 2);
  assert.equal(res.questions[1].isMultiple, true);
  assert.deepEqual(plain(res.questions[1].correctChoices), [0, 2]);
});

test('parseVnText handles multiline questions/choices, trailing answer key tables and drops <2 choices', () => {
  const ExamImporter = loadImporter();
  const res = ExamImporter.parseVnText([
    'Câu 1: Dòng 1',
    'Dòng 2',
    'A. Lựa chọn một',
    'nối dòng',
    'B. Lựa chọn hai',
    'C. Lựa chọn ba',
    'Câu 2: Thiếu lựa chọn',
    'A. Chỉ một',
    'Câu 3: Đáp án ngoài biên',
    'A. Một',
    'B. Hai',
    'Đáp án: G',
    'Câu 4: Nhiều đáp án từ bảng cuối',
    'A. X',
    'B. Y',
    'C. Z',
    'D. W',
    'BẢNG ĐÁP ÁN:',
    '1.B  3-A  4.AC',
  ].join('\n'));

  assert.equal(res.questions.length, 3);
  assert.match(res.questions[0].text, /Dòng 1\nDòng 2/);
  assert.equal(res.questions[0].choices[0], 'Lựa chọn một nối dòng');
  assert.equal(res.questions[0].correct, 1);
  assert.equal(res.questions[1].correct, 0);
  assert.equal(res.questions[2].isMultiple, true);
  assert.deepEqual(plain(res.questions[2].correctChoices), [0, 2]);
});

test('parseVnText supports multi-choice via Đáp án: A, B, D and semicolon lists', () => {
  const ExamImporter = loadImporter();
  const res = ExamImporter.parseVnText([
    'Câu 1: Ngôn ngữ web?',
    'A. JS',
    'B. HTML',
    'C. C++',
    'D. CSS',
    'Đáp án: A, B, D',
  ].join('\n'));
  assert.equal(res.questions.length, 1);
  assert.equal(res.questions[0].isMultiple, true);
  assert.deepEqual(plain(res.questions[0].correctChoices), [0, 1, 3]);
});

test('parseCsv handles comma, semicolon, tab delimiters, quotes, numeric & multi-choice answers', () => {
  const ExamImporter = loadImporter();
  const r1 = ExamImporter.parseCsv([
    '"Câu hỏi","A","B","C","D","Đáp án"',
    '"1 + 2 = ?","2","3","4","5","B"',
    '"Chọn chẵn","1","2","3","4","B, D"',
    '"3 + 4 = ?","6","7","8","9","2"',
  ].join('\n'), 'CSV');
  assert.equal(r1.questions.length, 3);
  assert.equal(r1.questions[0].correct, 1);
  assert.equal(r1.questions[1].isMultiple, true);
  assert.deepEqual(plain(r1.questions[1].correctChoices), [1, 3]);
  assert.equal(r1.questions[2].correct, 1);

  assert.equal(ExamImporter.parseCsv('Câu hỏi;A;B;C;D;Đáp án\nQ1;1;2;3;4;D').questions[0].correct, 3);
  assert.equal(ExamImporter.parseCsv('Câu hỏi\tA\tB\tC\tD\tĐáp án\nQ2\t1\t2\t3\t4\tC').questions[0].correct, 2);
});

test('parseExcelRows rejects insufficient rows and handles multi-choice answers', () => {
  const ExamImporter = loadImporter();
  assert.throws(() => ExamImporter.parseExcelRows([['Only header']], 'Empty'), /không có đủ dữ liệu/);
  const res = ExamImporter.parseExcelRows([
    ['Câu hỏi', 'A', 'B', 'C', 'D', 'Đáp án'],
    ['Nguyên âm?', 'a', 'b', 'e', 'd', 'A, C'],
  ], 'Excel');
  assert.equal(res.questions[0].isMultiple, true);
  assert.deepEqual(plain(res.questions[0].correctChoices), [0, 2]);
});

test('parseFile parses real sample .xlsx and .docx files cleanly', async () => {
  const ExamImporter = loadImporter({ withLibs: true });
  const xlsxBuf = fs.readFileSync(path.resolve(__dirname, '../../public/samples/Mau_De_Thi_Mini_Quiz.xlsx'));
  const xlsxRes = await ExamImporter.parseFile(makeMockFile('Mau_De_Thi_Mini_Quiz.xlsx', xlsxBuf));
  assert.ok(xlsxRes.questions.length >= 1);

  const docxBuf = fs.readFileSync(path.resolve(__dirname, '../../public/samples/Mau_De_Thi_Word.docx'));
  const docxRes = await ExamImporter.parseFile(makeMockFile('Mau_De_Thi_Word.docx', docxBuf));
  assert.ok(docxRes.questions.length >= 1);
});

test('parseFile handles .json, .txt, malformed JSON, null & unsupported extensions', async () => {
  const ExamImporter = loadImporter();

  const jsonObj = await ExamImporter.parseFile(makeMockFile('de_toan.json', JSON.stringify({
    title: 'Đề JSON',
    subject: 'Tin',
    questions: [
      { text: 'Q1', choices: ['A', 'B', 'C'], correct: 'C' },
      { text: 'Q2', choices: ['1', '2', '3', '4'], correctChoices: [3, 1] },
      { text: 'Invalid', choices: ['Only1'] },
    ],
  })));
  assert.equal(jsonObj.questions.length, 2);
  assert.equal(jsonObj.questions[0].correct, 2);
  assert.deepEqual(plain(jsonObj.questions[1].correctChoices), [1, 3]);

  const jsonArr = await ExamImporter.parseFile(makeMockFile('arr-exam.json', JSON.stringify([
    { question: 'Câu mảng', options: ['Đúng', 'Sai'], correct: 0 },
  ])));
  assert.equal(jsonArr.title, 'arr exam');

  const txtRes = await ExamImporter.parseFile(makeMockFile('my_quiz.txt', 'Câu 1: X?\nA. 1\n*B. 2'));
  assert.equal(txtRes.title, 'my quiz');
  assert.equal(txtRes.questions[0].correct, 1);

  await assert.rejects(ExamImporter.parseFile(makeMockFile('bad.json', '{')), /JSON không hợp lệ/);
  await assert.rejects(ExamImporter.parseFile(makeMockFile('bad.pdf', 'pdf')), /chưa được hỗ trợ/);
  await assert.rejects(ExamImporter.parseFile(null), /Không có tệp/);
});
