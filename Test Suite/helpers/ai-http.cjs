const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const plain = v => JSON.parse(JSON.stringify(v));

function loadGeminiWithClock(initialNow = 1_700_000_000_000, env = {}) {
  const filename = path.resolve('src/ai/gemini.js');
  const realRequire = createRequire(filename);
  let now = initialNow;
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  const setTimeoutCalls = [];
  const context = {
    require: name => realRequire(name),
    module: { exports: {} },
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    Date: MockDate,
    process: { env: { ...env } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, ms, ...args) {
      setTimeoutCalls.push(ms);
      return setTimeout(fn, Math.min(ms, 5), ...args);
    },
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return {
    mod: context.module.exports,
    advanceMs: ms => { now += ms; },
    setTimeoutCalls,
  };
}

function loadServerHarness(t, { dbOverrides = {}, aiOverrides = {}, authOverrides = {}, env = {} } = {}) {
  function load(file, overrides = {}, tail = '') {
    const filename = path.resolve(file);
    const realRequire = createRequire(filename);
    const context = {
      require: name => (Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)),
      module: { exports: {} },
      __dirname: path.dirname(filename),
      Buffer,
      URL,
      process: { env: { ...env }, exit: code => { throw new Error(`exit:${code}`); } },
      console: { log() {}, warn() {}, error() {} },
      setInterval() {},
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(
      fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail,
      context,
      { filename }
    );
    return context.module.exports;
  }

  const jobUpdates = [];
  const createdDocs = [];
  const createdJobs = [];
  let cachedHit = null;

  const dbMock = {
    async getHostedGameSessionById(id) {
      if (id === 'sess-alice') {
        return {
          id: 'sess-alice',
          hostId: 'alice',
          roomCode: '111-222',
          roomTitle: 'Lớp 10A',
          stats: {
            totalQuestions: 2,
            totalCandidates: 10,
            avgScore: 500,
            questionsStats: [
              { qIdx: 1, text: 'Câu 1 <script>alert(1)</script>', correctCount: 3, totalCount: 10, ratioPct: 30 },
              { qIdx: 2, text: 'Câu 2', correctCount: 7, totalCount: 10, ratioPct: 70 },
            ],
          },
        };
      }
      return null;
    },
    async createAiDocument(doc) { createdDocs.push(doc); return 'doc-uuid-1'; },
    async createAiGenerationJob(job) { createdJobs.push(job); return { id: 'job-uuid-1' }; },
    async updateAiGenerationJob(id, patch) { jobUpdates.push({ id, ...patch }); },
    async findCachedWeaknessAnalysis() { return cachedHit; },
    async getHostedGameSessions() { return []; },
    async getPrivateQuizzes() { return []; },
    async getPublicQuizzes() { return []; },
    async getUserAttempts() { return []; },
    ...dbOverrides,
  };

  const authMock = {
    parseCookies: () => ({}),
    getSession: tok => (tok === 'alice' ? { username: 'alice' } : tok === 'bob' ? { username: 'bob' } : null),
    findUserByUsernameSync: u => ({ id: u === 'alice' ? 1 : 2, username: u, role: 'teacher' }),
    ...authOverrides,
  };

  const geminiReal = loadGeminiWithClock(1_700_000_000_000, env);
  const geminiMod = { ...geminiReal.mod, ...aiOverrides };
  const rooms = load('src/rooms/manager.js', { '../db/index.js': dbMock });
  const { server } = load('src/server.js', {
    dotenv: { config() {} },
    './auth.js': authMock,
    './db/index.js': dbMock,
    './db/pool.js': { async query() { return { rows: [] }; } },
    './db/migrate.js': {},
    './rooms/manager.js': rooms,
    './ai/gemini.js': geminiMod,
  }, '\nmodule.exports = { server };');

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        gemini: geminiReal,
        jobUpdates,
        createdDocs,
        createdJobs,
        setCachedHit: v => { cachedHit = v; },
      });
    });
  });
}


module.exports = { loadServerHarness };
