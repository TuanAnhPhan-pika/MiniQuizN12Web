const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

async function launchBrowser() {
  for (const opts of [
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
    { headless: true },
  ]) {
    try {
      return await chromium.launch(opts);
    } catch (_) {}
  }
  throw new Error('Không tìm thấy trình duyệt Chromium/Edge/Chrome cho Playwright E2E');
}

async function blockExternalFonts(contextOrPage) {
  await contextOrPage.route('https://fonts.googleapis.com/**', route => route.abort());
  await contextOrPage.route('https://fonts.gstatic.com/**', route => route.abort());
}

test('E2E-F01 [Playwright][Auth Guard & Register & Create Exam] Chặn trang bảo vệ khi chưa đăng nhập, đăng ký giáo viên mới và soạn + lưu đề thi thật xuống SQLite', async () => {
  const ctx = await startIsolatedServer();
  const browser = await launchBrowser();
  const bCtx = await browser.newContext();
  await blockExternalFonts(bCtx);
  const page = await bCtx.newPage();

  try {
    // 1. Chưa đăng nhập truy cập thẳng /create-exam.html -> bị server redirect về /index.html?needLogin=1...
    await page.goto(`${ctx.baseUrl}/create-exam.html`, { waitUntil: 'domcontentloaded' });
    assert.match(page.url(), /\/index\.html\?needLogin=1/);

    // 2. Đăng ký tài khoản giáo viên mới ngay trên giao diện modal
    const loginModalVisible = await page.locator('#login-modal.open, #login-user:visible').count();
    if (!loginModalVisible) {
      await page.click('.btn-login');
    }
    await page.click('#tab-register');
    await page.waitForSelector('#reg-user', { state: 'visible' });

    await page.fill('#reg-user', 'gv_e2e_new');
    await page.fill('#reg-name', 'Cô Giáo E2E');
    await page.fill('#reg-pass', 'PassE2E123!');
    await page.fill('#reg-confirm', 'PassE2E123!');
    await page.click('#btn-submit-register');

    // Có thể chuyển về /create-exam.html (do redirect param) hoặc /dashboard.html
    await page.waitForURL(/\/(dashboard|create-exam)\.html/, { timeout: 10000 });

    // 3. Mở trang soạn đề /create-exam.html, tạo câu hỏi và bấm Lưu đề thi
    if (!page.url().includes('/create-exam.html')) {
      await page.goto(`${ctx.baseUrl}/create-exam.html`, { waitUntil: 'domcontentloaded' });
    }
    page.on('dialog', dialog => dialog.accept());

    await page.fill('#exam-title', 'Đề Thi E2E Trình Duyệt Thật');
    await page.fill('#exam-subject', 'Công nghệ Web');
    await page.fill('#q-text', 'Giao thức nào dùng mặc định cho cổng 443?');
    await page.fill('#choice-input-0', 'HTTP');
    await page.fill('#choice-input-1', 'HTTPS');
    await page.fill('#choice-input-2', 'FTP');
    await page.fill('#choice-input-3', 'SSH');
    await page.check('input[name="correct-answer"][value="1"]');
    await page.click('#btn-save-q');

    await page.waitForFunction(() => {
      const badge = document.getElementById('q-count-badge');
      return badge && badge.textContent.includes('1');
    });

    await page.click('.btn-save-exam');

    // Chờ bản ghi thực sự xuất hiện trong bảng quizzes của SQLite in-memory
    await page.waitForFunction(async () => {
      const r = await fetch('/api/storage/private');
      const d = await r.json();
      return Array.isArray(d.exams) && d.exams.some(e => e.title === 'Đề Thi E2E Trình Duyệt Thật');
    }, { timeout: 10000 });

    const quizRows = await ctx.sqlitePool.query(`SELECT title, subject, owner_id FROM quizzes WHERE owner_id = 'gv_e2e_new'`);
    assert.equal(quizRows.rows.length, 1);
    assert.equal(quizRows.rows[0].title, 'Đề Thi E2E Trình Duyệt Thật');
    assert.equal(quizRows.rows[0].subject, 'Công nghệ Web');
  } finally {
    await bCtx.close().catch(() => {});
    await browser.close().catch(() => {});
    await ctx.close();
  }
});

test('E2E-F02 [Playwright][Multiplayer Live Flow] Giáo viên mở phòng chờ + Thí sinh nhập PIN từ trang chủ, vào phòng chờ, làm bài trên trình duyệt thật và ghi điểm', async () => {
  const ctx = await startIsolatedServer();
  const browser = await launchBrowser();
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await blockExternalFonts(hostContext);
  await blockExternalFonts(guestContext);

  try {
    // 1. Tạo tài khoản Host và tạo phòng thi qua API trên cùng server SQLite
    const hostReg = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: { username: 'host_live_e2e', displayName: 'Thầy Chủ Phòng', password: 'Password123!', confirmPassword: 'Password123!' },
    });
    const roomCreated = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie: hostReg.cookieHeader,
      body: {
        title: 'Phòng Thi Trực Tuyến E2E',
        capacity: 15,
        questions: [
          {
            id: 'q-live-1',
            text: 'Ngôn ngữ nào chạy trực tiếp trong trình duyệt web?',
            choices: ['C++', 'JavaScript', 'Assembler', 'COBOL'],
            correct: 1,
            points: 100,
            timeLimit: 30,
          },
        ],
      },
    });
    const pin = roomCreated.json.pin;

    // 2. Cửa sổ trình duyệt 1 (Giáo viên): Đăng nhập và mở màn hình phòng chờ Host
    const hostPage = await hostContext.newPage();
    hostPage.on('dialog', d => d.accept());
    await hostPage.goto(`${ctx.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await hostPage.click('.btn-login');
    await hostPage.fill('#login-user', 'host_live_e2e');
    await hostPage.fill('#login-pass', 'Password123!');
    await hostPage.click('#form-login button.btn-join');
    await hostPage.waitForURL(/\/dashboard\.html/, { timeout: 10000 });

    await hostPage.goto(`${ctx.baseUrl}/waiting-for-host.html?pin=${encodeURIComponent(pin)}`, { waitUntil: 'domcontentloaded' });
    await hostPage.waitForFunction(expectedPin => {
      const el = document.getElementById('pin-display');
      return el && el.textContent.replace(/\s+/g, '') === expectedPin.replace(/\s+/g, '');
    }, pin, { timeout: 10000 });

    // 3. Cửa sổ trình duyệt 2 (Thí sinh ẩn danh): Nhập mã PIN ở trang chủ -> đặt Nickname -> vào phòng chờ khách
    const guestPage = await guestContext.newPage();
    guestPage.on('dialog', d => d.accept());
    await guestPage.goto(`${ctx.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await guestPage.fill('#pin-input', pin);
    await guestPage.click('#step-pin button.btn-join');

    await guestPage.waitForSelector('#step-nick', { state: 'visible', timeout: 10000 });
    await guestPage.fill('#nickname-input', 'Minh_E2E');
    await guestPage.click('#step-nick button.btn-join');

    await guestPage.waitForURL(/waiting-room-for-guests\.html/, { timeout: 10000 });

    // Màn hình phòng chờ của Giáo viên tự động cập nhật hiển thị thí sinh Minh_E2E và sĩ số = 1
    await hostPage.waitForFunction(() => {
      const grid = document.getElementById('members-grid');
      const curr = document.getElementById('count-curr');
      return grid && grid.textContent.includes('Minh_E2E') && curr && curr.textContent.trim() === '1';
    }, { timeout: 10000 });

    // 4. Giáo viên mở câu hỏi đầu tiên (advance sang phase 'question'), Thí sinh làm bài tại room.html và chọn đáp án đúng (B - JavaScript)
    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/advance`, {
      cookie: hostReg.cookieHeader,
      body: { nextQ: 0, phase: 'question' },
    });

    await guestPage.goto(`${ctx.baseUrl}/room.html?pin=${encodeURIComponent(pin)}&nick=Minh_E2E&av=01`, { waitUntil: 'domcontentloaded' });
    await guestPage.waitForFunction(() => {
      const qEl = document.getElementById('question-text');
      return qEl && qEl.textContent.includes('trình duyệt web');
    }, { timeout: 10000 });

    const choiceButtons = guestPage.locator('#choices button, #choices .choice-btn, #choices > *');
    await choiceButtons.nth(1).click();

    // Chờ server ghi nhận đáp án đúng và cộng điểm > 0 cho Minh_E2E
    await guestPage.waitForFunction(() => {
      const meta = document.getElementById('question-meta');
      return meta && meta.textContent.includes('Đã ghi nhận');
    }, { timeout: 10000 });

    const lb = ctx.roomsManager.getLeaderboard(pin, true);
    assert.equal(lb.length, 1);
    assert.equal(lb[0].nick, 'Minh_E2E');
    assert.ok(lb[0].score > 0, `Điểm chấm phía server của Minh_E2E phải > 0 (thực tế: ${lb[0].score})`);
  } finally {
    await hostContext.close().catch(() => {});
    await guestContext.close().catch(() => {});
    await browser.close().catch(() => {});
    await ctx.close();
  }
});
