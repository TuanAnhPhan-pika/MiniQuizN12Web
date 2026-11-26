const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startIsolatedServer } = require('../helpers/test-server.js');

async function launchBrowser() {
  for (const opts of [
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
    { headless: true },
  ]) {
    try {
      return await chromium.launch(opts);
    } catch (_) {
      // Thử trình duyệt tiếp theo nếu máy không có channel này
    }
  }
  throw new Error('Không tìm thấy trình duyệt Chromium/Edge/Chrome để chạy Playwright E2E');
}

async function setupE2E() {
  const ctx = await startIsolatedServer();
  let browser = null;
  let browserContext = null;
  try {
    await ctx.auth.createUser({
      username: 'student_demo',
      displayName: 'Sinh viên Demo',
      password: 'Pass123456!',
    });

    browser = await launchBrowser();
    browserContext = await browser.newContext();
    const page = await browserContext.newPage();

    // Chặn tải font Google bên ngoài để E2E chạy nhanh & ổn định ngay cả khi không có mạng
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());

    return {
      ctx,
      page,
      async teardown() {
        if (browserContext) await browserContext.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await ctx.close();
      },
    };
  } catch (err) {
    if (browserContext) await browserContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await ctx.close();
    throw err;
  }
}

test('TC-15 [E2E][Phân vùng tương đương] Đăng nhập hợp lệ trên trình duyệt chuyển sang /dashboard.html và hiển thị tên người dùng', async () => {
  const env = await setupE2E();
  try {
    await env.page.goto(`${env.ctx.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await env.page.click('.btn-login');
    await env.page.waitForSelector('#login-user', { state: 'visible' });

    await env.page.fill('#login-user', 'student_demo');
    await env.page.fill('#login-pass', 'Pass123456!');
    await env.page.click('#form-login button.btn-join');

    await env.page.waitForURL(/\/dashboard\.html/, { timeout: 10000 });
    await env.page.waitForFunction(
      () => {
        const el = document.getElementById('user-chip-label');
        return el && el.textContent && el.textContent.includes('Sinh viên Demo');
      },
      { timeout: 10000 }
    );

    const displayedName = await env.page.textContent('#user-chip-label');
    assert.match(displayedName, /Sinh viên Demo/, 'Dashboard phải hiển thị đúng tên hiển thị của người dùng');
  } finally {
    await env.teardown();
  }
});

test('TC-16 [E2E][Đoán lỗi] Đăng nhập sai mật khẩu giữ nguyên trang đăng nhập và hiển thị thông báo lỗi', async () => {
  const env = await setupE2E();
  try {
    await env.page.goto(`${env.ctx.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await env.page.click('.btn-login');
    await env.page.waitForSelector('#login-user', { state: 'visible' });

    await env.page.fill('#login-user', 'student_demo');
    await env.page.fill('#login-pass', 'WrongPass999');
    await env.page.click('#form-login button.btn-join');

    await env.page.waitForFunction(
      () => {
        const el = document.getElementById('error-login');
        return el && el.textContent && el.textContent.trim().length > 0;
      },
      { timeout: 10000 }
    );

    const errText = (await env.page.textContent('#error-login')).trim();
    assert.ok(errText.length > 0, 'Phải hiển thị thông báo lỗi đăng nhập trên UI');
    assert.doesNotMatch(env.page.url(), /\/dashboard\.html/, 'Sai mật khẩu không được chuyển hướng sang dashboard');
  } finally {
    await env.teardown();
  }
});
