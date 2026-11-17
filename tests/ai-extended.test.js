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

test('checkAiRateLimit enforces 6/min, recovers after 61s, caps at 40/hour, and isolates user::ip keys', () => {
  const { mod, advanceMs } = loadGeminiWithClock();

  for (let i = 0; i < 6; i++) {
    const r = mod.checkAiRateLimit('alice', '10.0.0.1');
    assert.equal(r.allowed, true, `request #${i + 1} should succeed`);
  }
  const blockedMin = mod.checkAiRateLimit('alice', '10.0.0.1');
  assert.equal(blockedMin.allowed, false);
  assert.ok(blockedMin.retryAfterSec >= 1);

  // Different IP for same user or different user on same IP is isolated
  assert.equal(mod.checkAiRateLimit('alice', '10.0.0.2').allowed, true);
  assert.equal(mod.checkAiRateLimit('bob', '10.0.0.1').allowed, true);

  // Advance past 60s window
  advanceMs(61_000);
  assert.equal(mod.checkAiRateLimit('alice', '10.0.0.1').allowed, true);

  // Exhaust 40/hr quota in batches of 5 every 61s (7 already recorded above: 6 + 1)
  let totalAccepted = 7;
  while (totalAccepted < 40) {
    advanceMs(61_000);
    for (let j = 0; j < 6 && totalAccepted < 40; j++) {
      const ok = mod.checkAiRateLimit('alice', '10.0.0.1');
      assert.equal(ok.allowed, true);
      totalAccepted++;
    }
  }
  advanceMs(61_000);
  const blockedHour = mod.checkAiRateLimit('alice', '10.0.0.1');
  assert.equal(blockedHour.allowed, false);
});

test('normalizeGeneratedQuestions enforces 4-choice requirement, strips prefixes, sanitizes multi-choice, and drops malformed items', () => {
  const { mod } = loadGeminiWithClock();

  const normalized = plain(mod.normalizeGeneratedQuestions([
    { text: 'Valid single', choices: ['A. Một', 'B) Hai', 'C: Ba', 'D - Bốn'], correct: 99 }, // OOB clamps to 0
    { text: 'Multi valid', choices: ['1', '2', '3', '4'], correctIndices: [2, 0, 2, 10] },
    { text: 'Multi 1 choice downgrades', choices: ['W', 'X', 'Y', 'Z'], correctIndices: [1] },
    { text: 'Too few choices', choices: ['OnlyOne', 'OnlyTwo', 'OnlyThree'], correct: 0 },
    { text: '', choices: ['A', 'B', 'C', 'D'], correct: 0 },
  ], 'mixed'));

  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[0].choices, ['Một', 'Hai', 'Ba', 'Bốn']);
  assert.equal(normalized[0].correct, 0);
  assert.equal(normalized[0].isMultiple, undefined);

  assert.equal(normalized[1].isMultiple, true);
  assert.deepEqual(normalized[1].correctChoices, [0, 2]);
  assert.equal(normalized[1].correct, 0);

  assert.equal(normalized[2].isMultiple, undefined);
  assert.equal(normalized[2].correct, 1);

  // Forced single mode strips multiple selection
  const forcedSingle = plain(mod.normalizeGeneratedQuestions([
    { text: 'Multi', choices: ['A', 'B', 'C', 'D'], correctIndices: [0, 2] },
  ], 'single'));
  assert.equal(forcedSingle[0].isMultiple, undefined);
  assert.equal(forcedSingle[0].correct, 0);
});

test('buildWeaknessStatsInput anonymizes PII, keeps <=25 weakest sorted asc, and truncates text <=160 chars', () => {
  const { mod } = loadGeminiWithClock();
  const longText = 'Q'.repeat(220);
  const questionsStats = [];
  for (let i = 0; i < 30; i++) {
    questionsStats.push({
      qIdx: i + 1,
      text: i === 0 ? longText : `Câu hỏi ${i}`,
      correctCount: i,
      totalCount: 30,
      ratioPct: Math.round((i / 30) * 100),
    });
  }

  const input = plain(mod.buildWeaknessStatsInput({
    roomTitle: 'Phòng Kiểm Tra',
    stats: {
      totalQuestions: 30,
      totalCandidates: 25,
      avgScore: 480,
      candidatesMatrix: [{ nick: 'SECRET_STUDENT', score: 900 }],
      questionsStats,
    },
  }));

  assert.equal(input.roomTitle, 'Phòng Kiểm Tra');
  assert.equal(input.totalCandidates, 25);
  assert.equal(input.questions.length, 25);
  assert.equal(Object.hasOwn(input, 'candidatesMatrix'), false);
  // Weakest first
  assert.ok(input.questions[0].ratioPct <= input.questions[1].ratioPct);
  assert.ok(input.questions[0].text.length <= 160);
  assert.equal(JSON.stringify(input).includes('SECRET_STUDENT'), false);
});

test('buildWeaknessCacheKey is deterministic and normalizeWeaknessAnalysis applies caps & fallbacks', () => {
  const { mod } = loadGeminiWithClock();
  const compressed = {
    roomTitle: 'Lớp 12',
    totalCandidates: 12,
    totalQuestions: 5,
    questions: [
      { qIdx: 1, text: 'Câu yếu 1', ratioPct: 20, correctCount: 2, totalCount: 10 },
      { qIdx: 2, text: 'Câu yếu 2', ratioPct: 45, correctCount: 4, totalCount: 10 },
    ],
  };
  const k1 = mod.buildWeaknessCacheKey('sess-1', compressed);
  const k2 = mod.buildWeaknessCacheKey('sess-1', compressed);
  assert.equal(k1, k2);
  assert.match(k1, /^sess-1:[a-f0-9]{24}$/);

  const normalized = plain(mod.normalizeWeaknessAnalysis({
    overallSummary: '',
    weakQuestions: Array.from({ length: 7 }, (_, i) => ({
      qIdx: i + 1,
      topicOrSkill: `Q${i + 1}`,
      accuracyPct: 25,
      likelyMistake: 'Nhầm công thức',
    })),
    teachingActions: ['A1', 'A2', 'A3', 'A4', 'A5'],
  }, compressed));

  assert.ok(normalized.overallSummary.length > 0);
  assert.equal(normalized.weakQuestions.length, 4);
  assert.equal(normalized.teachingActions.length, 3);
});

test('memory weakness cache enforces 6h TTL and caps size at 100 entries (LRU eviction)', () => {
  const { mod, advanceMs } = loadGeminiWithClock();

  for (let i = 0; i < 105; i++) {
    mod.setWeaknessInMemoryCache(`k:${i}`, { overallSummary: `summary-${i}` });
  }
  assert.equal(mod.getWeaknessFromMemoryCache('k:0'), null);
  assert.equal(mod.getWeaknessFromMemoryCache('k:4'), null);
  assert.equal(mod.getWeaknessFromMemoryCache('k:5').overallSummary, 'summary-5');
  assert.equal(mod.getWeaknessFromMemoryCache('k:104').overallSummary, 'summary-104');

  // After 6h + 1ms entry expires
  advanceMs(6 * 60 * 60 * 1000 + 1);
  assert.equal(mod.getWeaknessFromMemoryCache('k:104'), null);
});

test('generateQuestions throws 503 AI_KEY_MISSING when GEMINI_API_KEY is absent', async () => {
  const { mod } = loadGeminiWithClock(1_700_000_000_000, {});
  await assert.rejects(
    () => mod.generateQuestions({ topic: 'Toán', count: 3 }),
    err => err.status === 503 && err.code === 'AI_KEY_MISSING'
  );
});

test('generateQuestions retries transient 503 once after ~600ms and succeeds on second attempt', async () => {
  const { mod, setTimeoutCalls } = loadGeminiWithClock(1_700_000_000_000, { GEMINI_API_KEY: 'test-key' });
  let calls = 0;
  mod.setGenAIClientFactoryForTest(() => ({
    sdk: { Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN' }, ThinkingLevel: { LOW: 'LOW' } },
    ai: {
      models: {
        async generateContent() {
          calls++;
          if (calls === 1) throw new Error('503 UNAVAILABLE fetch failed');
          return {
            text: JSON.stringify({
              questions: [{ text: '1+1=?', choices: ['1', '2', '3', '4'], correctIndices: [1] }],
            }),
          };
        },
      },
    },
  }));

  const res = plain(await mod.generateQuestions({ topic: 'Toán tiểu học', count: 1 }));
  assert.equal(calls, 2);
  assert.ok(setTimeoutCalls.includes(600));
  assert.equal(res.questions.length, 1);
  assert.equal(res.model, mod.DEFAULT_MODEL);
});

test('generateQuestions maps 429, 403/API_KEY_INVALID, 404/NOT_FOUND, invalid JSON and empty questions accurately', async () => {
  const cases = [
    { err: Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }), status: 429, code: 'RESOURCE_EXHAUSTED' },
    { err: Object.assign(new Error('API_KEY_INVALID PERMISSION_DENIED'), { status: 403 }), status: 502, code: 'GEMINI_AUTH_ERROR' },
    { err: Object.assign(new Error('Model NOT_FOUND'), { status: 404 }), status: 502, code: 'GEMINI_MODEL_NOT_FOUND' },
    { text: '{not-json', status: 502, msgRe: /định dạng/ },
    { text: JSON.stringify({ questions: [{ text: 'bad', choices: ['only1'], correct: 0 }] }), status: 502, msgRe: /Không tạo được câu hỏi/ },
  ];

  for (const c of cases) {
    const { mod } = loadGeminiWithClock(1_700_000_000_000, { GEMINI_API_KEY: 'test-key' });
    mod.setGenAIClientFactoryForTest(() => ({
      sdk: { Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN' }, ThinkingLevel: { LOW: 'LOW' } },
      ai: {
        models: {
          async generateContent() {
            if (c.err) throw c.err;
            return { text: c.text };
          },
        },
      },
    }));
    await assert.rejects(
      () => mod.generateQuestions({ topic: 'Vật lý', count: 2 }),
      e => e.status === c.status && (!c.code || e.code === c.code) && (!c.msgRe || c.msgRe.test(e.message))
    );
  }
});

test('POST /api/ai/generate-questions updates DB job status="failed" on Gemini failure and tolerates DB audit errors', async t => {
  const { base, jobUpdates } = await loadServerHarness(t, {
    aiOverrides: {
      async generateQuestions() {
        const e = new Error('Quota exhausted');
        e.status = 429;
        e.code = 'GEMINI_RATE_LIMIT';
        throw e;
      },
    },
  });

  const failRes = await fetch(base + '/api/ai/generate-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice' },
    body: JSON.stringify({ topic: 'Sinh học', count: 3, questionType: 'mixed' }),
  });
  assert.equal(failRes.status, 429);
  assert.ok(jobUpdates.some(u => u.id === 'job-uuid-1' && u.status === 'failed'));

  // DB audit failure must NOT break generation when AI succeeds
  const { base: baseResilient } = await loadServerHarness(t, {
    dbOverrides: {
      async createAiDocument() { throw new Error('DB down'); },
      async createAiGenerationJob() { throw new Error('DB down'); },
      async updateAiGenerationJob() { throw new Error('DB down'); },
    },
    aiOverrides: {
      async generateQuestions() {
        return { model: 'gemini-3.1-flash-lite', questions: [{ text: 'Q?', choices: ['A', 'B'], correct: 0 }] };
      },
    },
  });

  const okRes = await fetch(baseResilient + '/api/ai/generate-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice' },
    body: JSON.stringify({ topic: 'Hóa học', count: 1 }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.questions.length, 1);
});

test('POST /api/ai/analyze-weakness serves DB cache without consuming rate limit and enforces session ownership 403', async t => {
  let rateCalls = 0;
  let aiAnalyzeCalls = 0;
  const cachedPayload = {
    overallSummary: 'Đã cache từ DB',
    weakQuestions: [{ questionNumber: 1, questionText: 'Câu 1', correctPct: 30, likelyMisconception: 'A', remediationTip: 'B' }],
    teachingActions: ['Giảng lại mục 1'],
  };

  const { base, setCachedHit } = await loadServerHarness(t, {
    aiOverrides: {
      checkAiRateLimit() { rateCalls++; return { allowed: true }; },
      async analyzeClassWeakness() { aiAnalyzeCalls++; throw new Error('should not call Gemini on cache hit'); },
    },
  });

  // Ownership check: bob cannot analyze alice's session even when sending inline stats
  const forbidden = await fetch(base + '/api/ai/analyze-weakness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bob' },
    body: JSON.stringify({
      sessionId: 'sess-alice',
      roomTitle: 'Giả mạo',
      stats: { totalQuestions: 1, totalCandidates: 1, avgScore: 0, questionsStats: [{ qIdx: 1, text: 'X', correctCount: 0, totalCount: 1, ratioPct: 0 }] },
    }),
  });
  assert.equal(forbidden.status, 403);

  // DB cache hit hydrates RAM and bypasses Gemini + rate limiter
  setCachedHit({ model: 'gemini-3.1-flash-lite', analysis: cachedPayload });
  const cachedRes = await fetch(base + '/api/ai/analyze-weakness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice' },
    body: JSON.stringify({ sessionId: 'sess-alice' }),
  });
  assert.equal(cachedRes.status, 200);
  const body = await cachedRes.json();
  assert.equal(body.cached, true);
  assert.equal(body.analysis.overallSummary, 'Đã cache từ DB');
  assert.equal(rateCalls, 0);
  assert.equal(aiAnalyzeCalls, 0);
});

test('AiWeaknessUI validates empty stats, escapes XSS, applies tone-low/tone-mid/tone-ok, and handles API errors', async () => {
  const filename = path.resolve('public/js/ai-weakness-ui.js');
  const containerEl = { innerHTML: '' };
  const btnEl = { disabled: false, textContent: 'Tạo tóm tắt điểm yếu' };
  let fetchResponder = async () => ({ ok: true, json: async () => ({}) });
  const win = { AiWeaknessUI: null };
  const context = {
    window: win,
    fetch: (...args) => fetchResponder(...args),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const UI = win.AiWeaknessUI;
  assert.ok(UI && typeof UI.analyze === 'function' && typeof UI.renderAnalysis === 'function' && typeof UI.reset === 'function');

  // Empty stats short-circuits without calling fetch
  let fetched = false;
  fetchResponder = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
  await UI.analyze({
    containerEl,
    btnEl,
    roomTitle: 'Empty',
    stats: { questionsStats: [] },
  });
  assert.equal(fetched, false);
  assert.ok(containerEl.innerHTML.includes('Chưa có dữ liệu'));

  // XSS escaping + tone classes (<50 low, <70 mid, >=70 ok)
  fetchResponder = async () => ({
    ok: true,
    json: async () => ({
      success: true,
      cached: true,
      analysis: {
        overallSummary: '<img src=x onerror=alert(1)>',
        weakQuestions: [
          { qIdx: 1, topicOrSkill: '<b>Low</b>', accuracyPct: 40, likelyMistake: '<script>1</script>' },
          { qIdx: 2, topicOrSkill: 'Mid', accuracyPct: 60, likelyMistake: 'Nhầm' },
          { qIdx: 3, topicOrSkill: 'Ok', accuracyPct: 75, likelyMistake: 'Ổn' },
        ],
        teachingActions: ['<svg onload=alert(2)>'],
      },
    }),
  });

  await UI.analyze({
    containerEl,
    btnEl,
    sessionId: 'sess-1',
    roomTitle: 'Room',
    stats: { totalQuestions: 3, totalCandidates: 10, questionsStats: [{ qIdx: 1, text: 'Q1', correctCount: 4, totalCount: 10, ratioPct: 40 }] },
  });
  const html = containerEl.innerHTML;
  assert.equal(btnEl.disabled, false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<svg onload'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('ai-weak-item tone-low'));
  assert.ok(html.includes('ai-weak-item tone-mid'));
  assert.ok(html.includes('ai-weak-item tone-ok'));

  // Error response renders inline error box and re-enables button
  fetchResponder = async () => ({ ok: false, json: async () => ({ message: 'Hết hạn mức AI <test>' }) });
  await UI.analyze({
    containerEl,
    btnEl,
    roomTitle: 'Room',
    stats: { totalQuestions: 1, totalCandidates: 5, questionsStats: [{ qIdx: 1, text: 'Q1', correctCount: 1, totalCount: 5, ratioPct: 20 }] },
  });
  assert.equal(btnEl.disabled, false);
  assert.ok(containerEl.innerHTML.includes('ai-weakness-error'));
  assert.ok(containerEl.innerHTML.includes('Hết hạn mức AI &lt;test&gt;'));
});
