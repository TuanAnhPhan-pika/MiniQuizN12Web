const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const plain = v => JSON.parse(JSON.stringify(v));

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
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + tail, context, { filename });
  return context.module.exports;
}

test('pool.js configures SSL correctly for localhost vs remote DATABASE_URL and unix sockets', () => {
  const captured = [];
  class FakePool {
    constructor(cfg) {
      captured.push(cfg);
      this.cfg = cfg;
    }
    on() {}
  }

  const localPool = load('src/db/pool.js', { pg: { Pool: FakePool } }, '', {
    DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/postgres',
  });
  localPool.getPool();
  assert.equal(captured[0].ssl, false);
  assert.equal(captured[0].connectionTimeoutMillis, 10000);

  const remotePool = load('src/db/pool.js', { pg: { Pool: FakePool } }, '', {
    DATABASE_URL: 'postgresql://postgres:pw@aws-0-ap.pooler.supabase.com:5432/postgres',
  });
  remotePool.getPool();
  assert.deepEqual(plain(captured[1].ssl), { rejectUnauthorized: false });

  const unixPool = load('src/db/pool.js', { pg: { Pool: FakePool } }, '', {
    SQL_HOST: '/cloudsql/proj:region:inst',
    SQL_USER: 'app',
    SQL_DB_NAME: 'quizdb',
  });
  unixPool.getPool();
  assert.equal(captured[2].host, '/cloudsql/proj:region:inst');
  assert.equal(captured[2].port, undefined);
});

test('pool.js withTransaction commits on success and rolls back + releases client on error', async () => {
  const commands = [];
  let released = 0;
  class FakePool {
    on() {}
    async connect() {
      return {
        async query(sql) { commands.push(sql); return { rows: [] }; },
        release() { released++; },
      };
    }
  }
  const pool = load('src/db/pool.js', { pg: { Pool: FakePool } }, '', { DATABASE_URL: 'postgresql://localhost/db' });

  const ok = await pool.withTransaction(async c => {
    await c.query('INSERT 1');
    return 42;
  });
  assert.equal(ok, 42);
  assert.deepEqual(commands, ['BEGIN', 'INSERT 1', 'COMMIT']);
  assert.equal(released, 1);

  commands.length = 0;
  await assert.rejects(pool.withTransaction(async c => {
    await c.query('INSERT 2');
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(commands, ['BEGIN', 'INSERT 2', 'ROLLBACK']);
  assert.equal(released, 2);
});

test('migrate.js applies only unapplied migrations in sorted order and skips legacy import when quizzes exist', async () => {
  const executedFiles = [];
  const queries = [];
  const fakePool = {
    getPool: () => ({}),
    async query(sql) {
      queries.push(sql);
      if (/SELECT id FROM schema_migrations/.test(sql)) {
        return { rows: [{ id: '001_initial_schema.sql' }] };
      }
      if (/SELECT COUNT\(\*\) as count FROM quizzes/.test(sql)) {
        return { rows: [{ count: '3' }] };
      }
      return { rows: [] };
    },
    async withTransaction(fn) {
      return fn({
        async query(sql, params) {
          if (/INSERT INTO schema_migrations/.test(sql)) {
            executedFiles.push(params[0]);
          }
          return { rows: [] };
        },
      });
    },
  };

  const migrate = load('src/db/migrate.js', { './pool.js': fakePool, './supabase.js': { isConfigured: () => false } });
  await migrate.runMigration();

  assert.equal(executedFiles.includes('001_initial_schema.sql'), false);
  assert.deepEqual(executedFiles, [
    '002_user_relationships.sql',
    '003_answer_integrity.sql',
    '004_soft_delete_and_status.sql',
    '005_user_topic_mastery.sql',
    '006_permissions_hardening.sql',
    '007_attempt_details_and_rank.sql',
  ]);
});

test('db/index.js enforces DATA_BACKEND=pg and disables useSupabase', () => {
  const pgMock = { async query() { return { rows: [] }; }, async withTransaction(fn) { return fn(this); } };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });
  assert.equal(db.useSupabase(), false);
  assert.throws(() => load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} }, '', { DATA_BACKEND: 'supabase' }), /DATA_BACKEND=pg/);
});

test('db/index.js user and session CRUD operations issue parameterized SQL correctly', async () => {
  const calls = [];
  const pgMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO users/.test(sql)) return { rows: [{ id: 12, username: params[0], display_name: params[2], created_at: params[5] }] };
      if (/FROM users u/.test(sql)) return { rows: [{ id: 12, username: 'Alice', username_lower: 'alice', display_name: 'Alice', password_hash: 'h', salt: 's', created_at: 1, role: 'teacher' }] };
      if (/FROM user_sessions/.test(sql)) return { rows: [{ token: 't1', username: 'Alice', created_at: 1, expires_at: 9999999999999 }] };
      return { rows: [] };
    },
    async withTransaction(fn) { return fn(this); },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });

  const created = await db.createUser({ username: 'Alice', displayName: ' Alice ', passwordHash: 'h', salt: 's' });
  assert.equal(created.id, 12);
  assert.ok(calls.some(c => /INSERT INTO profiles/.test(c.sql)));

  await db.updateUser('Alice', { displayName: 'Alice 2' });
  assert.ok(calls.some(c => /UPDATE users SET display_name = \$1 WHERE username_lower = \$2/.test(c.sql)));

  await db.saveSession('t1', 'Alice', 9999999999999);
  const sess = await db.getSession('t1');
  assert.equal(sess.username, 'Alice');
  await db.deleteOtherSessions('Alice', 't1');
  await db.deleteSession('t1');
  assert.ok(calls.some(c => /DELETE FROM user_sessions WHERE LOWER\(username\)/.test(c.sql)));
});

test('db/index.js getQuizById enforces private RBAC (anonymous, stranger, owner, shared_by, admin, internal)', async () => {
  const privateRow = { id: 'q-priv', code: '#111', title: 'Private', is_public: false, owner_id: 'alice', owner_user_id: 1, shared_by: 'helper' };
  const pgMock = {
    async query(sql) {
      if (/FROM quizzes/.test(sql)) return { rows: [privateRow] };
      if (/FROM quiz_questions/.test(sql)) return { rows: [{ version_id: 'v1', question_id: 'q1', version: 1, content: 'Q?', explanation: 'Exp' }] };
      return { rows: [{ content: 'A', is_correct: false }, { content: 'B', is_correct: true }] };
    },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });

  assert.equal(await db.getQuizById('q-priv'), null);
  assert.equal(await db.getQuizById('q-priv', { requestingUser: { username: 'stranger', userId: 9, role: 'teacher' } }), null);
  assert.ok(await db.getQuizById('q-priv', { requestingUser: { username: 'alice', userId: 1, role: 'teacher' } }));
  assert.ok(await db.getQuizById('q-priv', { requestingUser: { username: 'helper', userId: 5, role: 'teacher' } }));
  assert.ok(await db.getQuizById('q-priv', { requestingUser: { username: 'mod', userId: 8, role: 'admin' } }));
  const internal = await db.getQuizById('q-priv', { internal: true, includeCorrect: true });
  assert.equal(internal.questions[0].correct, 1);
  assert.equal(internal.questions[0].explanation, 'Exp');
});

test('db/index.js saveQuiz preserves v1 when unchanged and creates v2 on text, choice, or multi-choice change', async () => {
  const state = { users: new Map([['alice', 1]]), quizzes: new Map(), versions: new Map(), qq: new Map(), rollbacks: 0 };
  const pgMock = {
    async query(sql, p = []) {
      if (/SELECT id FROM users/.test(sql)) return { rows: state.users.has(p[0]) ? [{ id: state.users.get(p[0]) }] : [] };
      if (/SELECT id, owner_id, owner_user_id FROM quizzes/.test(sql)) return { rows: state.quizzes.has(p[0]) ? [state.quizzes.get(p[0])] : [] };
      if (/INSERT INTO quizzes/.test(sql)) { state.quizzes.set(p[0], { id: p[0], code: p[1], title: p[2], is_public: p[8], owner_id: p[9], owner_user_id: p[10] }); return { rows: [] }; }
      if (/DELETE FROM quiz_questions/.test(sql)) { state.qq.set(p[0], []); return { rows: [] }; }
      if (/SELECT id, version, content, explanation/.test(sql)) { const l = state.versions.get(p[0]) || []; return { rows: l.length ? [l.at(-1)] : [] }; }
      if (/INSERT INTO question_versions/.test(sql)) {
        const l = state.versions.get(p[1]) || [];
        l.push({ id: p[0], question_id: p[1], version: p[2], content: p[3], explanation: p[4], options: [] });
        state.versions.set(p[1], l);
        return { rows: [] };
      }
      if (/INSERT INTO question_options/.test(sql)) {
        for (const l of state.versions.values()) {
          const v = l.find(x => x.id === p[1]);
          if (v) v.options.push({ id: p[0], content: p[2], is_correct: p[3], order_index: p[4] });
        }
        return { rows: [] };
      }
      if (/SELECT .* FROM question_options/.test(sql)) {
        for (const l of state.versions.values()) {
          const v = l.find(x => x.id === p[0]);
          if (v) return { rows: v.options };
        }
        return { rows: [] };
      }
      if (/INSERT INTO quiz_questions/.test(sql)) {
        const l = state.qq.get(p[1]) || [];
        l.push({ order_index: p[3], points: p[4], time_limit: p[5], version_id: p[2] });
        state.qq.set(p[1], l);
        return { rows: [] };
      }
      if (/SELECT \* FROM quizzes/.test(sql)) return { rows: state.quizzes.has(p[0]) ? [state.quizzes.get(p[0])] : [] };
      if (/FROM quiz_questions qq/.test(sql)) {
        return {
          rows: (state.qq.get(p[0]) || []).map(link => {
            for (const l of state.versions.values()) {
              const v = l.find(x => x.id === link.version_id);
              if (v) return { ...link, question_id: v.question_id, version: v.version, content: v.content, explanation: v.explanation };
            }
            return null;
          }).filter(Boolean),
        };
      }
      return { rows: [] };
    },
    async withTransaction(fn) {
      try { return await fn(this); }
      catch (e) { state.rollbacks++; throw e; }
    },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });

  const s1 = await db.saveQuiz({ id: 'qz1', title: 'Q', questions: [{ id: 'q1', text: 'T1', choices: ['A', 'B', 'C'], correct: 0 }] }, 'alice', false);
  assert.equal(s1.questions[0].version, 1);

  // Save unchanged -> reuses v1
  const s2 = await db.saveQuiz({ id: 'qz1', title: 'Q', questions: [{ id: 'q1', text: 'T1', choices: ['A', 'B', 'C'], correct: 0 }] }, 'alice', false);
  assert.equal(s2.questions[0].version, 1);

  // Change to multi-choice -> creates v2
  const s3 = await db.saveQuiz({ id: 'qz1', title: 'Q', questions: [{ id: 'q1', text: 'T1', choices: ['A', 'B', 'C'], correctChoices: [0, 2], isMultiple: true }] }, 'alice', false);
  assert.equal(s3.questions[0].version, 2);
  assert.deepEqual(plain(s3.questions[0].correctChoices), [0, 2]);

  // Stranger rejected and transaction rolled back
  await assert.rejects(db.saveQuiz({ id: 'qz1', title: 'Hack', questions: [] }, 'bob', false), /không có quyền/);
  assert.equal(state.rollbacks, 1);
});

test('db/index.js deleteQuiz passes owner userId, username and role=admin check', async () => {
  const calls = [];
  const pgMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 7 }] };
      return { rowCount: params[3] || params[1] === 7 ? 1 : 0 };
    },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });

  assert.equal(await db.deleteQuiz('qz1', 'alice'), true);
  assert.equal(calls.at(-1).params[3], false);
  assert.equal(await db.deleteQuiz('qz1', { username: 'mod', userId: 99, role: 'admin' }), true);
  assert.equal(calls.at(-1).params[3], true);
});

test('db/index.js getUserAttempts reconstructs multi-choice details from attempt_answers when details is empty', async () => {
  const pgMock = {
    async query(sql) {
      if (/FROM attempts/.test(sql)) {
        return {
          rows: [{
            id: 'att-1', pin: '123-456', room_title: 'Room', exam_title: 'Exam',
            score: 100, max_score: 100, correct_count: 1, total_questions: 1,
            ratio_pct: 100, rank: 1, total_players: 2, details: [],
          }],
        };
      }
      if (/FROM attempt_answers aa/.test(sql)) {
        return {
          rows: [
            { attempt_id: 'att-1', question_index: 0, user_choice: 0, is_correct: true, score_awarded: 100, response_time_ms: 500, streak_after: 1, q_text: 'Multi?', opt_content: 'A', opt_is_correct: true },
            { attempt_id: 'att-1', question_index: 0, user_choice: 0, is_correct: true, score_awarded: 100, response_time_ms: 500, streak_after: 1, q_text: 'Multi?', opt_content: 'B', opt_is_correct: false },
            { attempt_id: 'att-1', question_index: 0, user_choice: 0, is_correct: true, score_awarded: 100, response_time_ms: 500, streak_after: 1, q_text: 'Multi?', opt_content: 'C', opt_is_correct: true },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });
  const list = await db.getUserAttempts('alice');
  assert.equal(list.length, 1);
  assert.equal(list[0].details[0].questionType, 'multiple');
  assert.deepEqual(plain(list[0].details[0].correctChoices), [0, 2]);
});

test('db/index.js saveAttempt clears invalid selected_option_id and saveHostedGameSession uses deterministic gp-sha256 IDs', async () => {
  const inserts = [];
  const pgMock = {
    async query(sql, params) {
      if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT id FROM question_options/.test(sql)) return { rows: [] }; // invalid option mismatch
      inserts.push({ sql, params });
      return { rows: [] };
    },
    async withTransaction(fn) { return fn(this); },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });

  await db.saveAttempt({
    id: 'att-x',
    username: 'alice',
    details: [{ questionIndex: 0, questionVersionId: 'v1', selectedOptionId: 'bad-opt', userChoices: [1, 2], isCorrect: true }],
  });
  const ansInsert = inserts.find(x => /INSERT INTO attempt_answers/.test(x.sql));
  assert.equal(ansInsert.params[3], null); // invalidated selectedOptionId
  assert.equal(ansInsert.params[4], 1); // primaryUserChoice from userChoices[0]

  inserts.length = 0;
  await db.saveHostedGameSession('Teacher', {
    id: 'sess-99',
    pin: '112-334',
    stats: { candidatesMatrix: [{ id: 'p1', nick: 'An', score: 90, correctCount: 1, totalQuestions: 1 }] },
  });
  const gpInsert = inserts.find(x => /INSERT INTO game_players/.test(x.sql));
  assert.match(gpInsert.params[0], /^gp-[0-9a-f]{64}$/);
});

test('db/index.js AI document, job lifecycle and cached weakness lookup queries work properly', async () => {
  const queries = [];
  const pgMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 5 }] };
      if (/INSERT INTO documents/.test(sql)) return { rows: [{ id: 'doc-uuid', title: params[2] }] };
      if (/INSERT INTO ai_generation_jobs/.test(sql)) return { rows: [{ id: 'job-uuid', status: params[2] }] };
      if (/UPDATE ai_generation_jobs/.test(sql)) return { rows: [{ id: params[0], status: params[1] }] };
      if (/FROM ai_generation_jobs/.test(sql)) {
        return {
          rows: [{
            id: 'job-uuid',
            result_data: JSON.stringify({ model: 'gemini-3.1-flash-lite', analysis: { overallSummary: 'Good' } }),
          }],
        };
      }
      return { rows: [] };
    },
  };
  const db = load('src/db/index.js', { './pool.js': pgMock, '@supabase/supabase-js': {} });

  const doc = await db.createAiDocument({ ownerUsername: 'teacher', title: 'T', filePath: 'ai://x', contentText: '{}' });
  assert.equal(doc.id, 'doc-uuid');
  const job = await db.createAiGenerationJob({ username: 'teacher', status: 'pending', prompt: 'P', resultData: { jobType: 'weakness-analysis' } });
  assert.equal(job.id, 'job-uuid');
  await db.updateAiGenerationJob(job.id, { status: 'completed', resultData: { ok: true } });
  const cached = await db.findCachedWeaknessAnalysis('TEACHER', 'ck-1');
  assert.equal(cached.analysis.overallSummary, 'Good');
  assert.equal(await db.getHostedGameSessionById(''), null);
});
