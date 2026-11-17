const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const EVIDENCE_DIR = path.resolve('Test Suite/evidence');
const TEST_USERNAME = 'student_demo';
const TEST_DISPLAY_NAME = 'Sinh viên Demo';
const TEST_PASSWORD = process.env.TEST_DEMO_PASSWORD || 'Pass123456!';

function hasRealDatabaseConfig() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (url && !url.includes('your-project-ref') && !url.includes('your-password') && !url.includes('your-pooler-host')) {
    return true;
  }
  return Boolean((process.env.PGHOST || process.env.SQL_HOST || '').trim());
}

function loadModule(file, overrides = {}, tail = '', env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const context = {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
    module: { exports: {} },
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    process: { env, exit: code => { throw new Error(`exit:${code}`); } },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {},
    setTimeout,
    clearTimeout,
  };
  const source = fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '');
  vm.runInNewContext(source + tail, context, { filename });
  return context.module.exports;
}

function createPgHarness() {
  const salt = 'e907bf8186544038a71f3483b6b70620';
  const hash = crypto.scryptSync('Pass123456!', salt, 64).toString('hex');
  const state = {
    users: [
      {
        id: 1,
        username: 'student_demo',
        username_lower: 'student_demo',
        display_name: 'Sinh viên Demo',
        password_hash: hash,
        salt,
        created_at: 1700000000000,
        last_name_change_at: 0,
        last_password_change_at: 0,
      },
    ],
    profiles: [
      {
        id: 1,
        user_id: 1,
        username: 'student_demo',
        display_name: 'Sinh viên Demo',
        avatar: '01',
        bio: '',
        role: 'student',
      },
    ],
    user_sessions: [],
    sqlLog: [],
  };

  const pg = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.sqlLog.push({ sql: normalized, params });

      if (/FROM users u/i.test(normalized) && /WHERE u\.username_lower = \$1/i.test(normalized)) {
        const lower = String(params[0] || '').toLowerCase();
        const u = state.users.find(row => row.username_lower === lower);
        if (!u) return { rows: [], rowCount: 0 };
        const p = state.profiles.find(row => row.user_id === u.id) || {};
        return { rows: [{ ...u, avatar: p.avatar, bio: p.bio, role: p.role }], rowCount: 1 };
      }

      if (/FROM users u/i.test(normalized)) {
        return {
          rows: state.users.map(u => {
            const p = state.profiles.find(row => row.user_id === u.id) || {};
            return { ...u, avatar: p.avatar, bio: p.bio, role: p.role };
          }),
          rowCount: state.users.length,
        };
      }

      if (/SELECT token, username, created_at, expires_at FROM user_sessions WHERE expires_at > \$1/i.test(normalized)) {
        const now = Number(params[0]);
        const rows = state.user_sessions.filter(s => s.expires_at > now);
        return { rows, rowCount: rows.length };
      }

      if (/INSERT INTO user_sessions/i.test(normalized)) {
        const [token, username, createdAt, expiresAt] = params;
        const existing = state.user_sessions.find(s => s.token === token);
        if (existing) existing.expires_at = expiresAt;
        else state.user_sessions.push({ token, username, created_at: createdAt, expires_at: expiresAt });
        return { rows: [], rowCount: 1 };
      }

      if (/DELETE FROM user_sessions WHERE token = \$1/i.test(normalized)) {
        const before = state.user_sessions.length;
        state.user_sessions = state.user_sessions.filter(s => s.token !== params[0]);
        return { rows: [], rowCount: before - state.user_sessions.length };
      }

      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      return fn(this);
    },
  };

  return { state, pg };
}

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const exe of candidates) {
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('Could not find Chrome or Edge executable.');
}

async function launchBrowser() {
  const exe = findBrowserExecutable();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqc-cdp-'));
  const proc = spawn(
    exe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,820',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout. Output:\n${stderr}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}):\n${stderr}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function close() {
    try { await send('Browser.close'); } catch (e) {}
    try { ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  }

  return { send, onEvent, close };
}

async function openIsolatedPage(browser) {
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const { targetId } = await browser.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Network.enable', {}, sessionId);
  await browser.send('Network.setBlockedURLs', {
    urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'],
  }, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);

  const networkRequests = new Map();
  const off = browser.onEvent((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Network.requestWillBeSent') {
      networkRequests.set(msg.params.requestId, {
        url: msg.params.request.url,
        method: msg.params.request.method,
        postData: msg.params.request.postData || null,
        status: null,
        responseHeaders: null,
        responseBody: null,
        bodyPromise: null,
      });
    } else if (msg.method === 'Network.responseReceived') {
      const rec = networkRequests.get(msg.params.requestId);
      if (rec) {
        rec.status = msg.params.response.status;
        rec.responseHeaders = msg.params.response.headers;
      }
    } else if (msg.method === 'Network.loadingFinished') {
      const rec = networkRequests.get(msg.params.requestId);
      if (rec && rec.url.includes('/api/auth/login')) {
        rec.bodyPromise = browser
          .send('Network.getResponseBody', { requestId: msg.params.requestId }, sessionId)
          .then(resp => {
            rec.responseBody = JSON.parse(resp.body);
          })
          .catch(() => {});
      }
    }
  });

  async function evalJs(expression) {
    const res = await browser.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(`JS error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async function waitFor(fnExpr, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await evalJs(`Boolean(${fnExpr})`);
      if (ok) return;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`Timeout waiting for: ${fnExpr}`);
  }

  async function goto(url) {
    await browser.send('Page.navigate', { url }, sessionId);
    await waitFor('(document.readyState === "interactive" || document.readyState === "complete") && Boolean(document.querySelector("#header-auth-wrap .btn-login"))', 20000);
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  async function screenshot(filePath) {
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  }

  async function getApiLoginLogs() {
    const matches = [];
    for (const [requestId, rec] of networkRequests.entries()) {
      if (rec.url.includes('/api/auth/login')) {
        if (rec.bodyPromise) await rec.bodyPromise;
        let body = rec.responseBody;
        if (!body) {
          try {
            const resp = await browser.send('Network.getResponseBody', { requestId }, sessionId);
            body = JSON.parse(resp.body);
          } catch (e) {}
        }
        matches.push({
          method: rec.method,
          url: rec.url,
          requestBody: rec.postData ? JSON.parse(rec.postData) : null,
          status: rec.status,
          setCookieHeaderPresent: Boolean(rec.responseHeaders && (rec.responseHeaders['Set-Cookie'] || rec.responseHeaders['set-cookie'])),
          responseBody: body,
        });
      }
    }
    return matches;
  }

  async function dispose() {
    off();
    try { await browser.send('Target.disposeBrowserContext', { browserContextId }); } catch (e) {}
  }

  return { evalJs, waitFor, goto, screenshot, getApiLoginLogs, dispose };
}

async function createRuntimeContext() {
  const args = new Set(process.argv.slice(2));
  const forceMock = args.has('--mock');
  const forceLive = args.has('--live-db');

  if (!forceMock) {
    try { require('dotenv').config(); } catch (e) {}
  }

  const useLiveDb = !forceMock && (forceLive || hasRealDatabaseConfig());
  if (forceLive && !hasRealDatabaseConfig()) {
    throw new Error('Missing real DATABASE_URL / PGHOST / SQL_HOST in .env for --live-db mode.');
  }

  if (useLiveDb) {
    console.log('[browser-login] Mode: LIVE PostgreSQL (.env)');
    const realPool = require('../../src/db/pool.js');
    try {
      const sqlLog = [];
      const pgSpy = {
        getPool: realPool.getPool,
        async query(sql, params) {
          sqlLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
          return realPool.query(sql, params);
        },
        async withTransaction(fn) {
          return realPool.withTransaction(fn);
        },
      };

      const schemaSql = fs.readFileSync(path.resolve('src/db/migrations/001_initial_schema.sql'), 'utf8');
      await realPool.query(schemaSql);

      const db = loadModule('src/db/index.js', { './pool.js': pgSpy }, '', process.env);
      const auth = loadModule('src/auth.js', { './db/index.js': db, './db/pool.js': pgSpy }, '', process.env);

      // Seed synthetic student_demo account without touching any other users
      const { salt, hash } = auth.hashPassword(TEST_PASSWORD);
      const now = Date.now();
      await realPool.withTransaction(async (client) => {
        const uRes = await client.query(
          `INSERT INTO users (username, username_lower, display_name, password_hash, salt, created_at, last_name_change_at, last_password_change_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
           ON CONFLICT (username_lower) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 password_hash = EXCLUDED.password_hash,
                 salt = EXCLUDED.salt
           RETURNING id, username, display_name`,
          [TEST_USERNAME, TEST_USERNAME.toLowerCase(), TEST_DISPLAY_NAME, hash, salt, now]
        );
        const u = uRes.rows[0];
        await client.query(
          `INSERT INTO profiles (user_id, username, display_name, avatar, role)
           VALUES ($1, $2, $3, '01', 'student')
           ON CONFLICT (username) DO UPDATE
             SET user_id = EXCLUDED.user_id,
                 display_name = EXCLUDED.display_name,
                 role = EXCLUDED.role`,
          [u.id, u.username, u.display_name]
        );
        await client.query(`DELETE FROM user_sessions WHERE LOWER(username) = $1`, [TEST_USERNAME.toLowerCase()]);
      });

      await auth.initAuth();

      const env = { ...process.env };
      const { server } = loadModule(
        'src/server.js',
        {
          dotenv: { config() {} },
          './auth.js': auth,
          './db/index.js': db,
          './db/migrate.js': { async runMigration() {} },
          './rooms/manager.js': { getRawRoom: () => null },
        },
        '\nmodule.exports = { server };',
        env
      );

      return {
        dbMode: 'live-postgresql',
        server,
        env,
        sqlLog,
        async resetSessions() {
          await realPool.query(`DELETE FROM user_sessions WHERE LOWER(username) = $1`, [TEST_USERNAME.toLowerCase()]);
          sqlLog.length = 0;
        },
        async summarizeSessions() {
          const res = await realPool.query(
            `SELECT token, username, created_at, expires_at
             FROM user_sessions
             WHERE LOWER(username) = $1
             ORDER BY created_at DESC`,
            [TEST_USERNAME.toLowerCase()]
          );
          return {
            count: res.rowCount,
            rows: res.rows.map(r => ({
              tokenPrefix: String(r.token).slice(0, 12) + '...',
              username: r.username,
              created_at: Number(r.created_at),
              expires_at: Number(r.expires_at),
            })),
          };
        },
        async cleanup() {
          await realPool.getPool().end().catch(() => {});
        },
      };
    } catch (err) {
      await realPool.getPool().end().catch(() => {});
      throw err;
    }
  }

  console.log('[browser-login] Mode: isolated in-memory PG harness');
  const { state, pg } = createPgHarness();
  const db = loadModule('src/db/index.js', {
    './pool.js': pg,
    '@supabase/supabase-js': { createClient() { return {}; } },
  });
  const auth = loadModule('src/auth.js', {
    './db/index.js': db,
    './db/pool.js': pg,
  });
  await auth.initAuth();

  const env = {};
  const { server } = loadModule(
    'src/server.js',
    {
      dotenv: { config() {} },
      './auth.js': auth,
      './db/index.js': db,
      './db/migrate.js': { async runMigration() {} },
      './rooms/manager.js': { getRawRoom: () => null },
    },
    '\nmodule.exports = { server };',
    env
  );

  return {
    dbMode: 'isolated-in-memory-pg-harness',
    server,
    env,
    sqlLog: state.sqlLog,
    async resetSessions() {
      state.user_sessions.length = 0;
      state.sqlLog.length = 0;
    },
    async summarizeSessions() {
      return {
        count: state.user_sessions.length,
        rows: state.user_sessions.map(r => ({
          tokenPrefix: r.token.slice(0, 12) + '...',
          username: r.username,
          created_at: r.created_at,
          expires_at: r.expires_at,
        })),
      };
    },
    async cleanup() {},
  };
}

(async () => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const ctx = await createRuntimeContext();
  const { server, env, sqlLog } = ctx;

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  env.APP_URL = baseUrl;

  // Tap exact wire-level /api/auth/login responses emitted by server.js so
  // fast redirects (TC01 -> dashboard.html) never lose CDP responseBody or Set-Cookie headers.
  const serverLoginTrace = [];
  const origEmit = server.emit.bind(server);
  server.emit = function (eventName, req, res, ...rest) {
    if (eventName === 'request' && req.url && req.url.startsWith('/api/auth/login')) {
      const chunks = [];
      let statusCode = null;
      let setCookiePresent = false;
      const origWriteHead = res.writeHead.bind(res);
      const origEnd = res.end.bind(res);
      res.writeHead = function (code, headers, ...args) {
        statusCode = code;
        if (headers && (headers['Set-Cookie'] || headers['set-cookie'])) {
          setCookiePresent = true;
        }
        return origWriteHead(code, headers, ...args);
      };
      res.end = function (chunk, ...args) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        let parsedBody = null;
        try { parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        serverLoginTrace.push({
          method: req.method,
          url: `${baseUrl}${req.url}`,
          status: statusCode || res.statusCode,
          setCookieHeaderPresent: setCookiePresent,
          responseBody: parsedBody,
        });
        return origEnd(chunk, ...args);
      };
    }
    return origEmit(eventName, req, res, ...rest);
  };

  let browser = null;
  try {
    browser = await launchBrowser();
    // ── TC01 (R1): Đăng nhập hợp lệ ──────────────────────────────────────────
    await ctx.resetSessions();
    serverLoginTrace.length = 0;
    const tc01Before = await ctx.summarizeSessions();
    assert.equal(tc01Before.count, 0);

    const p1 = await openIsolatedPage(browser);
    await p1.goto(`${baseUrl}/index.html`);
    await p1.evalJs(`document.querySelector('#header-auth-wrap .btn-login').click()`);
    await p1.waitFor(`document.getElementById('login-modal').classList.contains('show')`);
    await p1.evalJs(`(() => {
      document.getElementById('login-user').value = 'student_demo';
      document.getElementById('login-pass').value = 'Pass123456!';
    })()`);
    await p1.screenshot(path.join(EVIDENCE_DIR, 'TC01_ui_login_modal.png'));

    await p1.evalJs(`document.querySelector('#form-login .btn-join').click()`);
    await p1.waitFor(`window.location.pathname.endsWith('/dashboard.html') && document.getElementById('user-chip-label')?.textContent.includes('student_demo')`, 15000);
    await new Promise(resolve => setTimeout(resolve, 250));
    await p1.screenshot(path.join(EVIDENCE_DIR, 'TC01_ui_dashboard.png'));

    const tc01Network = await p1.getApiLoginLogs();
    const tc01Wire = serverLoginTrace[0];
    const tc01ChipText = await p1.evalJs(`document.getElementById('user-chip-label').textContent`);
    const tc01After = await ctx.summarizeSessions();
    assert.equal(tc01Network.length, 1);
    assert.equal(tc01Network[0].status, 200);
    assert.equal(tc01Wire.status, 200);
    assert.equal(tc01Wire.setCookieHeaderPresent, true);
    assert.equal(tc01After.count, 1);
    assert.equal(tc01ChipText, 'Sinh viên Demo (student_demo)');

    const tc01Token = tc01Wire.responseBody && tc01Wire.responseBody.token
      ? tc01Wire.responseBody.token.slice(0, 12) + '...'
      : null;

    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'TC01_response_and_data.json'),
      JSON.stringify({
        testCase: 'TC01',
        rule: 'R1 - Đăng nhập hợp lệ',
        dbMode: ctx.dbMode,
        executedAt: new Date().toISOString(),
        uiResult: {
          finalUrlPath: '/dashboard.html',
          userChipLabel: tc01ChipText,
        },
        networkLoginCall: {
          method: tc01Network[0].method,
          url: tc01Network[0].url,
          requestBody: { username: 'student_demo', password: '***' },
          status: tc01Wire.status,
          setCookieHeaderPresent: tc01Wire.setCookieHeaderPresent,
          responseBody: {
            ...tc01Wire.responseBody,
            token: tc01Token,
          },
        },
        dbBefore: tc01Before,
        dbAfter: tc01After,
        sqlWrites: sqlLog.filter(x => /INSERT INTO user_sessions/i.test(x.sql)).map(x => x.sql),
      }, null, 2)
    );
    await p1.dispose();

    // ── TC02 (R2): Sai mật khẩu ──────────────────────────────────────────────
    await ctx.resetSessions();
    serverLoginTrace.length = 0;
    const tc02Before = await ctx.summarizeSessions();
    assert.equal(tc02Before.count, 0);

    const p2 = await openIsolatedPage(browser);
    await p2.goto(`${baseUrl}/index.html`);
    await p2.evalJs(`document.querySelector('#header-auth-wrap .btn-login').click()`);
    await p2.waitFor(`document.getElementById('login-modal').classList.contains('show')`);
    await p2.evalJs(`(() => {
      document.getElementById('login-user').value = 'student_demo';
      document.getElementById('login-pass').value = 'SaiMatKhau123';
      document.querySelector('#form-login .btn-join').click();
    })()`);
    await p2.waitFor(`document.getElementById('error-login').classList.contains('show')`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await p2.screenshot(path.join(EVIDENCE_DIR, 'TC02_ui_error.png'));

    const tc02ErrorText = await p2.evalJs(`document.getElementById('error-login').textContent`);
    const tc02Network = await p2.getApiLoginLogs();
    const tc02After = await ctx.summarizeSessions();
    assert.equal(tc02Network.length, 1);
    assert.equal(tc02Network[0].status, 401);
    assert.equal(tc02After.count, 0);

    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'TC02_response_and_data.json'),
      JSON.stringify({
        testCase: 'TC02',
        rule: 'R2 - Sai tài khoản hoặc mật khẩu',
        dbMode: ctx.dbMode,
        executedAt: new Date().toISOString(),
        uiResult: {
          stayedOnIndex: true,
          errorBannerText: tc02ErrorText,
        },
        networkLoginCall: {
          ...tc02Network[0],
          requestBody: { username: 'student_demo', password: '***' },
        },
        dbBefore: tc02Before,
        dbAfter: tc02After,
        sqlWrites: sqlLog.filter(x => /INSERT INTO user_sessions/i.test(x.sql)).map(x => x.sql),
      }, null, 2)
    );
    await p2.dispose();

    // ── TC03 (R3): Thiếu / rỗng mật khẩu (UI chặn + gọi API trực tiếp) ───────
    await ctx.resetSessions();
    const tc03Before = await ctx.summarizeSessions();
    assert.equal(tc03Before.count, 0);

    const p3 = await openIsolatedPage(browser);
    await p3.goto(`${baseUrl}/index.html`);
    await p3.evalJs(`document.querySelector('#header-auth-wrap .btn-login').click()`);
    await p3.waitFor(`document.getElementById('login-modal').classList.contains('show')`);
    await p3.evalJs(`(() => {
      document.getElementById('login-user').value = 'student_demo';
      document.getElementById('login-pass').value = '';
      document.querySelector('#form-login .btn-join').click();
    })()`);
    await p3.waitFor(`document.getElementById('error-login').classList.contains('show')`);
    await new Promise(resolve => setTimeout(resolve, 150));
    await p3.screenshot(path.join(EVIDENCE_DIR, 'TC03_ui_validation.png'));

    const tc03UiErrorText = await p3.evalJs(`document.getElementById('error-login').textContent`);
    const tc03UiNetwork = await p3.getApiLoginLogs();
    assert.equal(tc03UiNetwork.length, 0); // UI blocks empty submit before network call

    // Kiểm tra riêng quy tắc máy chủ bằng HTTP API trực tiếp (theo Bước 5 của đề bài)
    const apiRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'student_demo', password: '' }),
    });
    const apiBody = await apiRes.json();
    const tc03After = await ctx.summarizeSessions();
    assert.equal(apiRes.status, 400);
    assert.equal(apiBody.code, 'MISSING_CREDENTIALS');
    assert.equal(tc03After.count, 0);

    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'TC03_response_and_data.json'),
      JSON.stringify({
        testCase: 'TC03',
        rule: 'R3 - Thiếu hoặc rỗng tài khoản / mật khẩu',
        dbMode: ctx.dbMode,
        executedAt: new Date().toISOString(),
        uiResult: {
          clientValidationBlockedRequest: true,
          errorBannerText: tc03UiErrorText,
          uiNetworkCallsCount: tc03UiNetwork.length,
        },
        directServerApiCall: {
          method: 'POST',
          url: `${baseUrl}/api/auth/login`,
          requestBody: { username: 'student_demo', password: '' },
          status: apiRes.status,
          setCookieHeader: apiRes.headers.get('set-cookie'),
          responseBody: apiBody,
        },
        dbBefore: tc03Before,
        dbAfter: tc03After,
        sqlWrites: sqlLog.filter(x => /INSERT INTO user_sessions/i.test(x.sql)).map(x => x.sql),
      }, null, 2)
    );
    await p3.dispose();

    console.log(`PASS: Browser + API verification (${ctx.dbMode}) completed for TC01, TC02, TC03. Evidence written to Test Suite/evidence/.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await ctx.cleanup();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
