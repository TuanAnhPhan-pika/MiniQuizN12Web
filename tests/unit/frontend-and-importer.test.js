const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const plain = v => JSON.parse(JSON.stringify(v));

function loadImporterWithLibs() {
  const ctx = {
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
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.global = ctx;

  for (const rel of ['public/js/xlsx.full.min.js', 'public/js/mammoth.browser.min.js', 'public/js/exam-importer.js']) {
    const fp = path.join(PROJECT_ROOT, rel);
    vm.runInNewContext(fs.readFileSync(fp, 'utf8'), ctx, { filename: fp });
  }
  return ctx.ExamImporter;
}

function makeFileFromDisk(relPath) {
  const fullPath = path.join(PROJECT_ROOT, relPath);
  const buf = fs.readFileSync(fullPath);
  return {
    name: path.basename(fullPath),
    async text() { return buf.toString('utf8'); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

function makeTextFile(name, content) {
  const buf = Buffer.from(content, 'utf8');
  return {
    name,
    async text() { return content; },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

test('FE-01 [Importer][Real Files] Đọc thành công cả 3 file mẫu thật (.txt Aiken, .docx Word, .xlsx Excel) trong public/samples/', async () => {
  const ExamImporter = loadImporterWithLibs();

  const txtRes = await ExamImporter.parseFile(makeFileFromDisk('public/samples/Mau_De_Thi_Aiken.txt'));
  assert.ok(txtRes.questions.length >= 5, 'File mẫu Aiken .txt phải trích xuất đủ câu hỏi');
  assert.ok(txtRes.questions.every(q => q.choices.length >= 2 && Number.isInteger(q.correct)));

  const docxRes = await ExamImporter.parseFile(makeFileFromDisk('public/samples/Mau_De_Thi_Word.docx'));
  assert.ok(docxRes.questions.length >= 1, 'File mẫu Word .docx phải trích xuất được câu hỏi bằng Mammoth thật');
  assert.ok(docxRes.questions.every(q => q.text.length > 0 && q.choices.length >= 2));

  const xlsxRes = await ExamImporter.parseFile(makeFileFromDisk('public/samples/Mau_De_Thi_Mini_Quiz.xlsx'));
  assert.ok(xlsxRes.questions.length >= 1, 'File mẫu Excel .xlsx phải trích xuất được câu hỏi bằng SheetJS thật');
  assert.ok(xlsxRes.questions.every(q => q.text.length > 0 && q.choices.length >= 2));
});

test('FE-02 [Importer][Regression & Edge Cases] CSV ngoặc kép lồng "" RFC-4180, nhãn "Đáp án đúng: B" / "Choice B", JSON & định dạng lỗi', async () => {
  const ExamImporter = loadImporterWithLibs();

  // Regression 1: Nhãn chữ "Đáp án đúng: B" và "Choice D" không được bắt nhầm chữ G trong ĐÚNG hoặc C,H,E trong CHOICE
  const excelRows = [
    ['Câu hỏi', 'Đáp án A', 'Đáp án B', 'Đáp án C', 'Đáp án D', 'Đáp án đúng'],
    ['Thủ đô Việt Nam?', 'Huế', 'Hà Nội', 'Đà Nẵng', 'Cần Thơ', 'Đáp án đúng: B'],
    ['2 * 5 = ?', '5', '7', '9', '10', 'Choice D'],
    ['Chọn số nguyên tố', '2', '3', '4', '9', '1, 2'],
  ];
  const parsedExcel = ExamImporter.parseExcelRows(excelRows, 'Đề Kiểm Tra Nhãn');
  assert.equal(parsedExcel.questions.length, 3);
  assert.deepEqual(plain(parsedExcel.questions[0].correctChoices), [1], '"Đáp án đúng: B" chỉ được nhận B (index 1)');
  assert.equal(parsedExcel.questions[0].isMultiple, false);
  assert.deepEqual(plain(parsedExcel.questions[1].correctChoices), [3], '"Choice D" chỉ được nhận D (index 3)');
  assert.equal(parsedExcel.questions[1].isMultiple, false);
  assert.deepEqual(plain(parsedExcel.questions[2].correctChoices), [0, 1], 'Chỉ số 1-based "1, 2" phải ra [0, 1]');
  assert.equal(parsedExcel.questions[2].isMultiple, true);

  // Regression 2: CSV có dấu ngoặc kép thoát "" và dấu phẩy bên trong nội dung câu hỏi + nhiều đáp án
  const csvContent = [
    'Câu hỏi,A,B,C,D,Đáp án',
    '"Từ khóa ""const, let"" thuộc ngôn ngữ nào?",Python,JavaScript,SQL,HTML,B',
    '"Chọn các thẻ ""inline"" hợp lệ",<span>,<div>,<strong>,<section>,"A, C"',
  ].join('\r\n');
  const csvRes = await ExamImporter.parseFile(makeTextFile('de_thi_js.csv', csvContent));
  assert.equal(csvRes.questions.length, 2);
  assert.equal(csvRes.questions[0].text, 'Từ khóa "const, let" thuộc ngôn ngữ nào?');
  assert.equal(csvRes.questions[0].correct, 1);
  assert.equal(csvRes.questions[1].text, 'Chọn các thẻ "inline" hợp lệ');
  assert.deepEqual(plain(csvRes.questions[1].correctChoices), [0, 2]);

  // Kiểm tra BẢNG ĐÁP ÁN cuối đề tiếng Việt & câu nhiều đáp án
  const vnText = [
    'ĐỀ KIỂM TRA CUỐI KỲ',
    'Môn: Mạng máy tính',
    'Câu 1: Giao thức tầng giao vận nào hướng kết nối?',
    'A. UDP',
    'B. TCP',
    'C. IP',
    'D. ICMP',
    'Câu 2: Chọn các cổng chuẩn của HTTP và HTTPS:',
    'A. 80',
    'B. 21',
    'C. 443',
    'D. 25',
    'BẢNG ĐÁP ÁN',
    '1.B   2.A,C',
  ].join('\n');
  const vnRes = ExamImporter.parseVnText(vnText);
  assert.equal(vnRes.subject, 'Mạng máy tính');
  assert.equal(vnRes.questions.length, 2);
  assert.equal(vnRes.questions[0].correct, 1);
  assert.deepEqual(plain(vnRes.questions[1].correctChoices), [0, 2]);
  assert.equal(vnRes.questions[1].isMultiple, true);

  // Luồng lỗi: file rỗng, JSON hỏng, định dạng .pdf không hỗ trợ, Excel thiếu hàng
  await assert.rejects(() => ExamImporter.parseFile(null), /Không có tệp/);
  await assert.rejects(() => ExamImporter.parseFile(makeTextFile('bad.json', '{broken')), /JSON không hợp lệ/);
  await assert.rejects(() => ExamImporter.parseFile(makeTextFile('doc.pdf', '%PDF-1.4')), /chưa được hỗ trợ/);
  assert.throws(() => ExamImporter.parseExcelRows([['Chỉ 1 hàng']], 'Lỗi'), /không có đủ dữ liệu/);
});

test('FE-03 [Storage & AuthClient & AiWeaknessUI] Cô lập dữ liệu tài khoản/phòng, tự gắn Bearer token và chống XSS trong UI AI', async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body><button id="ai-btn">Phân tích</button><div id="ai-box"></div></body></html>`, {
    url: 'http://127.0.0.1:3000/dashboard.html',
    runScripts: 'outside-only',
  });
  try {
    const { window } = dom;

    const capturedRequests = [];
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      capturedRequests.push({ url, init });
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ success: true, token: 'tok-abc-999' }), { status: 200 });
      }
      if (url.includes('/api/ai/analyze-weakness')) {
        return new Response(JSON.stringify({
          success: true,
          cached: false,
          analysis: {
            overallSummary: '<b>Nguy cơ XSS</b> & cần ôn tập',
            weakQuestions: [
              { qIdx: 1, topicOrSkill: '<img src=x onerror=alert(1)>', accuracyPct: 25, likelyMistake: 'Nhầm <script>alert(2)</script>' },
            ],
            teachingActions: ['Ôn lại bài <svg onload=alert(3)>'],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    // Nạp storage.js, auth-client.js, ai-weakness-ui.js vào JSDOM
    for (const rel of ['public/js/storage.js', 'public/js/auth-client.js', 'public/js/ai-weakness-ui.js']) {
      window.eval(fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8'));
    }

    // 1. Cô lập tài khoản trong MQC_Storage
    window.MQC_Storage.setUser('drafts', 'Teacher_One', [{ id: 1 }]);
    window.MQC_Storage.setUser('drafts', 'Teacher_Two', [{ id: 2 }]);
    window.MQC_Storage.setRoom('state', '123-456', { q: 3 });
    assert.deepEqual(plain(window.MQC_Storage.getUser('drafts', 'teacher_one')), [{ id: 1 }]);
    assert.deepEqual(plain(window.MQC_Storage.getUser('drafts', 'teacher_two')), [{ id: 2 }]);

    // 2. AuthClient tự bắt token sau login và đính kèm vào các lệnh /api/* tiếp theo, xóa sạch khi logout
    await window.fetch('/api/auth/login', { method: 'POST' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(window.MQC_Auth.getToken(), 'tok-abc-999');

    await window.fetch('/api/storage/private');
    const privCall = capturedRequests.find(c => c.url === '/api/storage/private');
    assert.equal(privCall.init.headers.Authorization, 'Bearer tok-abc-999');
    assert.equal(privCall.init.headers['x-session-token'], 'tok-abc-999');

    // 3. AiWeaknessUI chống XSS tuyệt đối khi render dữ liệu từ AI
    const containerEl = window.document.getElementById('ai-box');
    const btnEl = window.document.getElementById('ai-btn');
    await window.AiWeaknessUI.analyze({
      containerEl,
      btnEl,
      pin: '123-456',
      roomTitle: 'Phòng XSS',
      stats: { questionsStats: [{ qIdx: 1, text: 'Q1', ratioPct: 25 }] },
    });
    assert.equal(containerEl.querySelectorAll('script, img, svg, b').length, 0, 'Không được chèn thẻ HTML sống từ dữ liệu AI');
    assert.match(containerEl.textContent, /Nguy cơ XSS/);
    assert.ok(containerEl.querySelector('.ai-weak-pct.tone-low'), 'Tỷ lệ 25% (<50%) phải mang class tone-low');

    // 4. Logout thu hồi token trên trình duyệt và clearUser chỉ xóa đúng user được chỉ định
    await window.fetch('/api/auth/logout', { method: 'POST' });
    assert.equal(window.MQC_Auth.getToken(), '');
    window.MQC_Storage.clearUser('Teacher_One');
    assert.equal(window.MQC_Storage.getUser('drafts', 'Teacher_One'), null);
    assert.deepEqual(plain(window.MQC_Storage.getUser('drafts', 'Teacher_Two')), [{ id: 2 }], 'Dữ liệu của Teacher_Two phải còn nguyên');
  } finally {
    dom.window.close();
  }
});

test('FE-04 [UI Validation Sync] home.js chặn mật khẩu khoảng trắng/quá 128 ký tự & create-room.js chặn capacity ngoài 1..500', async () => {
  const { JSDOM } = require('jsdom');

  // 1. Kiểm tra validate mật khẩu trên home.js
  const homeHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'public/index.html'), 'utf8');
  const homeDom = new JSDOM(homeHtml, { url: 'http://localhost/index.html', runScripts: 'dangerously' });
  try {
    const hw = homeDom.window;
    let regCalls = 0;
    hw.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/auth/register')) {
        regCalls++;
        return new Response(JSON.stringify({ success: false }), { status: 400 });
      }
      return new Response(JSON.stringify({ authenticated: false }), { status: 401 });
    };
    hw.eval(fs.readFileSync(path.join(PROJECT_ROOT, 'public/js/storage.js'), 'utf8'));
    hw.eval(fs.readFileSync(path.join(PROJECT_ROOT, 'public/js/auth-client.js'), 'utf8'));
    hw.eval(fs.readFileSync(path.join(PROJECT_ROOT, 'public/js/home.js'), 'utf8'));

    hw.document.getElementById('reg-user').value = 'gv_ui_01';
    hw.document.getElementById('reg-name').value = 'Giáo Viên UI';
    hw.document.getElementById('reg-pass').value = '     a';
    hw.document.getElementById('reg-confirm').value = '     a';
    await hw.handleRegister();
    assert.equal(regCalls, 0, 'UI phải chặn mật khẩu thiếu 6 ký tự thực trước khi gọi /api/auth/register');
    assert.match(hw.document.getElementById('error-register').textContent, /6-128/);

    hw.document.getElementById('reg-pass').value = 'a'.repeat(129);
    hw.document.getElementById('reg-confirm').value = 'a'.repeat(129);
    await hw.handleRegister();
    assert.equal(regCalls, 0, 'UI phải chặn mật khẩu vượt quá 128 ký tự');
  } finally {
    homeDom.window.close();
  }

  // 2. Kiểm tra validate capacity ngoài [1, 500] trên create-room.js
  const crHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'public/create-room.html'), 'utf8');
  const crDom = new JSDOM(crHtml, { url: 'http://localhost/create-room.html', runScripts: 'dangerously' });
  try {
    const cw = crDom.window;
    let roomApiCalls = 0;
    cw.QRCode = class { static CorrectLevel = { H: 2 }; clear() {} makeCode() {} };
    cw.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return new Response(JSON.stringify({ authenticated: true, username: 'gv_ui', displayName: 'GV UI' }), { status: 200 });
      }
      if (u.includes('/api/storage/private')) {
        return new Response(JSON.stringify({
          success: true,
          exams: [{ id: 'ex1', title: 'Đề Mẫu UI', questions: [{ text: '1+1?', choices: ['1', '2'], correct: 1 }] }],
        }), { status: 200 });
      }
      if (u.includes('/api/history/hosted')) {
        return new Response(JSON.stringify({ success: true, rooms: [] }), { status: 200 });
      }
      if (u.includes('/api/rooms')) {
        roomApiCalls++;
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    cw.eval(fs.readFileSync(path.join(PROJECT_ROOT, 'public/js/storage.js'), 'utf8'));
    cw.eval(fs.readFileSync(path.join(PROJECT_ROOT, 'public/js/auth-client.js'), 'utf8'));
    cw.eval(fs.readFileSync(path.join(PROJECT_ROOT, 'public/js/create-room.js'), 'utf8'));
    await new Promise(r => setTimeout(r, 30));

    cw.document.getElementById('room-name').value = 'Phòng Kiểm Tra UI';
    for (const badCap of ['-5', '0', '501', '12.5']) {
      cw.document.getElementById('room-capacity').value = badCap;
      await cw.handleCreateRoomNow();
      assert.equal(roomApiCalls, 0, `UI không được gọi /api/rooms khi capacity=${badCap}`);
      assert.ok(cw.document.getElementById('warning-modal').classList.contains('show'), 'Phải hiện modal cảnh báo khi capacity sai');
      cw.closeWarningModal();
    }
  } finally {
    crDom.window.close();
  }
});
