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
    require: name => (Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)),
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
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail,
    context,
    { filename }
  );
  return context.module.exports;
}

function makeServerHarness(t, env = {}) {
  const publicExams = [
    {
      id: 'pub-1',
      code: '#1001',
      title: 'Đề Lịch Sử Cổ Đại Việt Nam',
      ownerUsername: 'alice',
      sharedBy: 'alice',
      isPublic: true,
      questions: [
        { text: 'Năm 938 ai chiến thắng trên sông Bạch Đằng?', choices: ['Ngô Quyền', 'Lê Hoàn', 'Trần Hưng Đạo', 'Lý Thường Kiệt'], correct: 0 },
        { text: 'Những triều đại nào tồn tại ở thế kỷ XI?', choices: ['Nhà Lý', 'Nhà Ngô', 'Nhà Tiền Lê', 'Nhà Nguyễn'], correct: 0, correctChoices: [0, 2], isMultiple: true },
      ],
    },
  ];
  const savedPrivate = [];
  const savedPublic = [];
  const savedAttempts = [];
  let deletedInfo = null;
  let copiesCounter = 0;

  const dbMock = {
    async getPrivateQuizzes(owner) {
      return owner === 'alice'
        ? [
            { id: 'priv-10', code: '#10', title: 'Mười' },
            { id: 'priv-2', code: '#2', title: 'Hai' },
            { id: 'priv-copy', code: '#1001-1', parentCode: '#1001', title: publicExams[0].title, questions: publicExams[0].questions },
          ]
        : [];
    },
    async getPublicQuizzes() { return [...publicExams, ...savedPublic]; },
    async getQuizById(id, opts) {
      if (id === 'priv-copy') {
        return { id: 'priv-copy', code: '#1001-1', parentCode: '#1001', title: publicExams[0].title, questions: publicExams[0].questions };
      }
      if (id === 'solo-1' && opts?.internal) {
        return {
          id: 'solo-1',
          title: 'Solo Quiz',
          pointsPerQ: 100,
          questions: [
            { text: 'Q1', choices: ['A', 'B'], correct: 1, points: 100 },
            { text: 'Q2 Multi', choices: ['1', '2', '3', '4'], correct: 1, correctChoices: [1, 3], isMultiple: true, points: 100 },
          ],
        };
      }
      if (id === 'mine-room' && opts?.requestingUser?.username === 'alice') {
        return { id: 'mine-room', title: 'Phòng Từ Đề', questions: [{ text: 'Q?', choices: ['A', 'B'], correct: 0 }] };
      }
      return null;
    },
    async getPublicQuizById(idOrCode, opts = {}) {
      const hit = publicExams.find(e => e.id === idOrCode || e.code === idOrCode);
      if (!hit) return null;
      if (opts.includeCorrect) return JSON.parse(JSON.stringify(hit));
      return {
        ...hit,
        questions: hit.questions.map(q => ({ text: q.text, choices: q.choices, ...(q.isMultiple ? { isMultiple: true } : {}) })),
      };
    },
    async incrementQuizCopiesIssued() { return ++copiesCounter; },
    async saveQuiz(exam, owner, isPublic) {
      const rec = { ...exam, ownerUsername: owner, isPublic };
      if (isPublic) savedPublic.push(rec);
      else savedPrivate.push(rec);
      return rec;
    },
    async deleteQuiz(id, user) {
      deletedInfo = { id, user };
      if (typeof user === 'object') return user.role === 'admin' || user.username === 'alice';
      return user === 'alice';
    },
    async getUserAttempts(u) { return savedAttempts.filter(a => a.username === u); },
    async saveAttempt(rec) { savedAttempts.push(rec); return rec; },
    async getHostedGameSessions(u) { return [{ id: 'gs-1', hostId: u }]; },
    async saveHostedGameSession() {},
    async createWaitingGameSession() {},
  };

  const pgMock = {
    async query(sql, params) {
      if (/FROM game_sessions WHERE room_code/.test(sql) && params[0] === '777-888') {
        return {
          rows: [{
            id: 'arch-sess-1', quiz_id: 'pub-1', room_code: '777-888', room_title: 'Phòng Archived',
            total_players: 2, ended_at: 1700000200000, formatted_time: '17/11/2026',
            stats: {
              questionsStats: [{ text: 'Multi', correctIndex: 0, correctIndices: [0, 2], isMultiple: true }],
              candidatesMatrix: [{ id: 'p-arch', nick: 'Alice', score: 98, correctCount: 1, ratioPct: 100, answersMap: [true] }],
            },
          }],
        };
      }
      return { rows: [] };
    },
  };

  const authMock = {
    parseCookies: () => ({}),
    getSession: tok => (
      tok === 'alice' ? { username: 'alice' }
        : tok === 'bob' ? { username: 'bob' }
          : tok === 'fakeAdmin' ? { username: 'admin' }
            : tok === 'realAdmin' ? { username: 'mod' }
              : null
    ),
    findUserByUsernameSync: u => ({
      id: u === 'alice' ? 1 : u === 'bob' ? 2 : u === 'admin' ? 3 : 4,
      username: u,
      role: u === 'mod' ? 'admin' : 'teacher',
    }),
  };

  const rooms = load('src/rooms/manager.js', { '../db/index.js': dbMock });
  const { server } = load('src/server.js', {
    dotenv: { config() {} },
    './auth.js': authMock,
    './db/index.js': dbMock,
    './db/pool.js': pgMock,
    './db/migrate.js': {},
    './rooms/manager.js': rooms,
    './ai/gemini.js': {},
  }, '\nmodule.exports = { server };', env);

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        rooms,
        publicExams,
        savedPrivate,
        savedPublic,
        savedAttempts,
        db: dbMock,
        auth: authMock,
        pg: pgMock,
        getDeletedInfo: () => deletedInfo,
        getCopiesCounter: () => copiesCounter,
      });
    });
  });
}


module.exports = { makeServerHarness };
