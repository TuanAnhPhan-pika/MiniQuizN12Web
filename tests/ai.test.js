const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function load(file, overrides = {}, tail = '', env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const context = {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename), Buffer, URL,
    process: { env, exit: code => { throw new Error(`exit:${code}`); } },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {}, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail, context, { filename });
  return context.module.exports;
}

test('ai/gemini helpers: question normalization, stats privacy compression, cache key & rate limit', () => {
  const ai = require('../src/ai/gemini.js');

  const normalizedMixed = ai.normalizeGeneratedQuestions([
    { text: 'Thủ đô Việt Nam?', choices: ['A. Hà Nội', 'B) TP.HCM', 'C: Đà Nẵng', 'D - Huế'], correctIndices: [0] },
    { text: 'Số nguyên tố?', choices: ['2', '4', '5', '9'], correctIndices: [2, 0] },
    { text: 'Câu thiếu đáp án', choices: ['Một', 'Hai'], correctIndices: [0] },
    { text: '   ', choices: ['A', 'B', 'C', 'D'], correctIndices: [0] },
  ], 'mixed');

  assert.equal(normalizedMixed.length, 2);
  assert.deepEqual(normalizedMixed[0], {
    text: 'Thủ đô Việt Nam?',
    choices: ['Hà Nội', 'TP.HCM', 'Đà Nẵng', 'Huế'],
    correct: 0,
  });
  assert.equal(normalizedMixed[1].isMultiple, true);
  assert.equal(normalizedMixed[1].correct, 0);
  assert.deepEqual(normalizedMixed[1].correctChoices, [0, 2]);

  const normalizedSingle = ai.normalizeGeneratedQuestions([
    { text: 'Ép 1 đáp án', choices: ['A', 'B', 'C', 'D'], correctIndices: [1, 3] },
  ], 'single');
  assert.equal(normalizedSingle[0].isMultiple, undefined);
  assert.equal(normalizedSingle[0].correct, 1);

  const compressed = ai.buildWeaknessStatsInput({
    roomTitle: 'Kiểm tra Sinh học',
    stats: {
      totalCandidates: 20,
      avgScore: 520,
      maxScore: 900,
      maxPossibleScore: 1000,
      candidatesMatrix: [{ nick: 'Nguyen Van A', id: 'student-1', score: 900 }],
      questionsStats: [
        { qIdx: 1, text: 'Câu dễ', correctCount: 18, totalCount: 20, ratioPct: 90 },
        { qIdx: 2, text: 'Câu rất khó ' + 'x'.repeat(200), correctCount: 4, totalCount: 20, ratioPct: 20 },
      ],
    },
  });

  assert.equal(Object.hasOwn(compressed, 'candidatesMatrix'), false);
  assert.equal(JSON.stringify(compressed).includes('Nguyen Van A'), false);
  assert.equal(compressed.questions[0].qIdx, 2);
  assert.equal(compressed.questions[0].text.length, 160);

  const k1 = ai.buildWeaknessCacheKey('sess-1', compressed);
  const k2 = ai.buildWeaknessCacheKey('sess-1', compressed);
  assert.equal(k1, k2);

  for (let i = 0; i < 6; i++) {
    assert.equal(ai.checkAiRateLimit('teacher_rate_test', '127.0.0.1').allowed, true);
  }
  const blocked = ai.checkAiRateLimit('teacher_rate_test', '127.0.0.1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test('HTTP /api/ai/* enforces teacher/host auth, logs to 2 AI DB tables, and caches weakness summaries', async t => {
  const aiModule = load('src/ai/gemini.js');
  let geminiCalls = 0;

  aiModule.setGenAIClientFactoryForTest(() => ({
    sdk: {
      Type: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', INTEGER: 'INTEGER', NUMBER: 'NUMBER' },
      ThinkingLevel: { MINIMAL: 'MINIMAL' },
    },
    ai: {
      models: {
        async generateContent({ contents }) {
          geminiCalls++;
          if (contents.includes('Tạo đúng')) {
            return {
              text: JSON.stringify({
                suggestedTitle: 'Đề Toán Hàm Số',
                suggestedSubject: 'Toán học',
                questions: [
                  {
                    text: 'Hàm số y = 2x + 1 có hệ số góc là?',
                    choices: ['A. 2', 'B. 1', 'C. -2', 'D. 0'],
                    correctIndices: [0],
                  },
                  {
                    text: 'Các số chia hết cho 2?',
                    choices: ['2', '3', '4', '5'],
                    correctIndices: [0, 2],
                  },
                ],
              }),
            };
          }
          return {
            text: JSON.stringify({
              overallSummary: 'Lớp nắm vững phần cơ bản nhưng yếu ở câu 2.',
              weakQuestions: [
                { qIdx: 2, topicOrSkill: 'Hàm số bậc hai', accuracyPct: 25, likelyMistake: 'Nhầm dấu hệ số a.' },
              ],
              teachingActions: ['Ôn lại công thức đỉnh parabol đầu giờ sau.'],
            }),
          };
        },
      },
    },
  }));

  const docs = [];
  const jobs = new Map();
  let jobSeq = 0;
  let cachedDbResult = null;

  const db = {
    async saveHostedGameSession() {},
    async getHostedGameSessionById(id) {
      if (id === 'sess-teacher1') {
        return {
          id: 'sess-teacher1',
          hostId: 'teacher1',
          hostUserId: 10,
          roomTitle: 'Lớp 10A',
          stats: {
            totalCandidates: 12,
            avgScore: 450,
            maxScore: 800,
            maxPossibleScore: 1000,
            questionsStats: [
              { qIdx: 1, text: 'Câu 1', correctCount: 10, totalCount: 12, ratioPct: 83 },
              { qIdx: 2, text: 'Câu 2', correctCount: 3, totalCount: 12, ratioPct: 25 },
            ],
          },
        };
      }
      if (id === 'sess-other') {
        return { id: 'sess-other', hostId: 'teacher2', hostUserId: 20, roomTitle: 'Lớp khác', stats: { questionsStats: [{ qIdx: 1, text: 'Q', correctCount: 1, totalCount: 2, ratioPct: 50 }] } };
      }
      return null;
    },
    async createAiDocument(doc) {
      const record = { id: `doc-${docs.length + 1}`, ...doc };
      docs.push(record);
      return record;
    },
    async createAiGenerationJob(job) {
      const id = `job-${++jobSeq}`;
      const record = { id, ...job };
      jobs.set(id, record);
      return record;
    },
    async updateAiGenerationJob(id, patch) {
      const existing = jobs.get(id) || {};
      const updated = { ...existing, ...patch };
      jobs.set(id, updated);
      if (updated.status === 'completed' && updated.resultData?.jobType === 'weakness-analysis') {
        cachedDbResult = { model: updated.resultData.model, analysis: updated.resultData.analysis, cacheKey: updated.resultData.cacheKey };
      }
      return updated;
    },
    async findCachedWeaknessAnalysis(_username, cacheKey) {
      if (cachedDbResult && cachedDbResult.cacheKey === cacheKey) return cachedDbResult;
      return null;
    },
  };

  const rooms = load('src/rooms/manager.js', { '../db/index.js': db });
  const teacher1Room = await rooms.createRoom({
    hostUsername: 'teacher1',
    exam: { title: 'Phòng Giáo Viên 1', questions: [{ text: 'Q1', choices: ['A', 'B'], correct: 0 }] },
  });

  const auth = {
    parseCookies: () => ({}),
    getSession: token => {
      if (token === 'teacher1') return { username: 'teacher1' };
      if (token === 'teacher2') return { username: 'teacher2' };
      if (token === 'student1') return { username: 'student1' };
      return null;
    },
    findUserByUsernameSync: u => {
      if (u === 'teacher1') return { id: 10, role: 'teacher' };
      if (u === 'teacher2') return { id: 20, role: 'teacher' };
      if (u === 'student1') return { id: 30, role: 'student' };
      return null;
    },
  };

  const { server } = load('src/server.js', {
    dotenv: { config() {} },
    './auth.js': auth,
    './db/index.js': db,
    './db/migrate.js': {},
    './rooms/manager.js': rooms,
    './ai/gemini.js': aiModule,
  }, '\nmodule.exports = { server };');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, token) => fetch(base + url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  // 1. Auth & role guards
  assert.equal((await post('/api/ai/generate-questions', { topic: 'Toán' })).status, 401);
  assert.equal((await post('/api/ai/analyze-weakness', { sessionId: 'sess-teacher1' })).status, 401);
  assert.equal((await post('/api/ai/generate-questions', { topic: 'Toán' }, 'student1')).status, 403);
  assert.equal((await post('/api/ai/analyze-weakness', { sessionId: 'sess-teacher1' }, 'student1')).status, 403);

  // 2. Host ownership guards (cannot analyze another teacher's active room or DB session)
  assert.equal((await post('/api/ai/analyze-weakness', { pin: teacher1Room.pin }, 'teacher2')).status, 403);
  assert.equal((await post('/api/ai/analyze-weakness', { sessionId: 'sess-other' }, 'teacher1')).status, 403);

  // 3. Flow A: Generate questions + DB audit in documents & ai_generation_jobs
  const genRes = await post('/api/ai/generate-questions', {
    topic: 'Hàm số bậc nhất',
    gradeOrLevel: 'Lớp 9',
    count: 2,
    questionType: 'mixed',
  }, 'teacher1');
  assert.equal(genRes.status, 200);
  const genData = await genRes.json();
  assert.equal(genData.success, true);
  assert.equal(genData.model, 'gemini-3.1-flash-lite');
  assert.equal(genData.questions.length, 2);
  assert.equal(genData.questions[0].choices[0], '2');
  assert.equal(genData.questions[1].isMultiple, true);
  assert.equal(docs.length, 1);
  assert.equal(jobs.get('job-1').status, 'completed');
  assert.equal(geminiCalls, 1);

  // 4. Flow B: Analyze weakness first call -> hits Gemini; second call -> returns cached without Gemini call
  const weakRes1 = await post('/api/ai/analyze-weakness', { sessionId: 'sess-teacher1' }, 'teacher1');
  assert.equal(weakRes1.status, 200);
  const weakData1 = await weakRes1.json();
  assert.equal(weakData1.success, true);
  assert.equal(weakData1.cached, false);
  assert.equal(weakData1.analysis.weakQuestions[0].qIdx, 2);
  assert.equal(geminiCalls, 2);
  assert.equal(docs.length, 2);
  assert.equal(jobs.get('job-2').status, 'completed');

  const weakRes2 = await post('/api/ai/analyze-weakness', { sessionId: 'sess-teacher1' }, 'teacher1');
  assert.equal(weakRes2.status, 200);
  const weakData2 = await weakRes2.json();
  assert.equal(weakData2.cached, true);
  assert.equal(geminiCalls, 2);
});
