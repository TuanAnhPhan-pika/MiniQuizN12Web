const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createSqliteTestDb } = require('./sqlite-test-db.js');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function loadIsolatedModule(relPath, overrides = {}, extraTail = '', extraEnv = {}) {
  const filename = path.join(PROJECT_ROOT, relPath);
  const localRequire = createRequire(filename);
  const context = {
    require(spec) {
      if (Object.hasOwn(overrides, spec)) return overrides[spec];
      return localRequire(spec);
    },
    module: { exports: {} },
    exports: {},
    __filename: filename,
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process: {
      ...process,
      env: { ...process.env, DATA_BACKEND: 'pg', ALLOW_OFFLINE_MODE: 'true', ...extraEnv },
      exit(code) { throw new Error(`process.exit(${code})`); },
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
  };
  context.exports = context.module.exports;

  const source = fs.readFileSync(filename, 'utf8');
  vm.runInNewContext(source + extraTail, context, { filename });
  return context.module.exports;
}

/**
 * Khởi chạy một instance server HTTP cục bộ cô lập hoàn toàn,
 * gắn với cơ sở dữ liệu SQLite in-memory mới tinh (không đụng DB dev).
 */
async function startIsolatedServer() {
  const sqlitePool = createSqliteTestDb();

  const dbIndex = loadIsolatedModule('src/db/index.js', {
    './pool.js': sqlitePool,
  });

  const auth = loadIsolatedModule('src/auth.js', {
    './db/index.js': dbIndex,
    './db/pool.js': sqlitePool,
  });

  const roomsManager = loadIsolatedModule('src/rooms/manager.js', {
    '../db/index.js': dbIndex,
  });

  const serverSourcePath = path.join(PROJECT_ROOT, 'src/server.js');
  const rawServerSource = fs.readFileSync(serverSourcePath, 'utf8')
    .replace(/startServer\(\);\s*$/, '');

  const localRequire = createRequire(serverSourcePath);
  const serverOverrides = {
    './auth.js': auth,
    './db/index.js': dbIndex,
    './db/pool.js': sqlitePool,
    './db/migrate.js': { runMigration: async () => {} },
    './rooms/manager.js': roomsManager,
  };

  const ctx = {
    require(spec) {
      if (Object.hasOwn(serverOverrides, spec)) return serverOverrides[spec];
      return localRequire(spec);
    },
    module: { exports: {} },
    exports: {},
    __filename: serverSourcePath,
    __dirname: path.dirname(serverSourcePath),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process: {
      ...process,
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'test',
        DATA_BACKEND: 'pg',
        ALLOW_OFFLINE_MODE: 'true',
      },
      exit(code) { throw new Error(`process.exit(${code})`); },
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    `${rawServerSource}\nmodule.exports = { server, handleHttpRequest };`,
    ctx,
    { filename: serverSourcePath }
  );

  const { server } = ctx.module.exports;

  await auth.initAuth();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    server,
    sqlitePool,
    db: dbIndex,
    auth,
    roomsManager,
    async close() {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(resolve => server.close(() => resolve()));
      sqlitePool.close();
    },
  };
}

/**
 * Tiện ích gọi HTTP API trả về { status, headers, setCookies, cookieHeader, json }.
 */
async function apiRequest(baseUrl, method, pathname, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);

  const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');

  return {
    status: res.status,
    headers: res.headers,
    setCookies,
    cookieHeader,
    json,
    text,
  };
}

module.exports = {
  loadIsolatedModule,
  startIsolatedServer,
  apiRequest,
};
