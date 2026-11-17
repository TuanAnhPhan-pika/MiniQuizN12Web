const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const enabled = process.env.RUN_DB_TESTS === '1' && Boolean(dbUrl);

test('PostgreSQL integration suite (gated by RUN_DB_TESTS=1 + DATABASE_URL)', {
  skip: !enabled
    ? 'Skipped real DB integration tests (set RUN_DB_TESTS=1 and TEST_DATABASE_URL/DATABASE_URL to enable)'
    : false,
}, async t => {
  const poolMod = require('../../src/db/pool.js');
  const migrateMod = require('../../src/db/migrate.js');
  const db = require('../../src/db/index.js');

  const suffix = crypto.randomBytes(4).toString('hex');
  const testUser = `it_teacher_${suffix}`;
  const testQuizId = `it-quiz-${suffix}`;
  const testAttemptId = `it-attempt-${suffix}`;
  const testSessionId = `it-session-${suffix}`;
  let createdDocId = null;
  let createdJobId = null;

  t.after(async () => {
    try {
      await poolMod.query('DELETE FROM ai_generation_jobs WHERE id = $1 OR username = $2', [createdJobId, testUser]);
    } catch {}
    try {
      await poolMod.query('DELETE FROM documents WHERE id = $1 OR owner_id = $2', [createdDocId, testUser]);
    } catch {}
    try {
      await poolMod.query('DELETE FROM game_players WHERE session_id = $1', [testSessionId]);
      await poolMod.query('DELETE FROM game_sessions WHERE id = $1', [testSessionId]);
    } catch {}
    try {
      await poolMod.query('DELETE FROM attempt_answers WHERE attempt_id = $1', [testAttemptId]);
      await poolMod.query('DELETE FROM attempts WHERE id = $1', [testAttemptId]);
    } catch {}
    try {
      await poolMod.query('DELETE FROM quiz_questions WHERE quiz_id = $1', [testQuizId]);
      await poolMod.query('DELETE FROM quizzes WHERE id = $1', [testQuizId]);
    } catch {}
    try {
      await poolMod.query('DELETE FROM users WHERE username_lower = $1', [testUser.toLowerCase()]);
    } catch {}
    try {
      const p = poolMod.getPool();
      if (p && typeof p.end === 'function') await p.end();
    } catch {}
  });

  await t.test('runMigration() executes idempotently across repeated calls', async () => {
    await migrateMod.runMigration();
    await migrateMod.runMigration();
    const res = await poolMod.query('SELECT COUNT(*)::int AS cnt FROM schema_migrations');
    assert.ok(res.rows[0].cnt >= 1);
  });

  await t.test('withTransaction() rolls back inserts cleanly when callback throws', async () => {
    const rollbackId = `it-rb-${suffix}`;
    await assert.rejects(
      () => poolMod.withTransaction(async client => {
        await client.query(
          'INSERT INTO quizzes (id, code, title, is_public, owner_id, created_at) VALUES ($1, $2, $3, false, $4, $5)',
          [rollbackId, `#rb${suffix}`, 'Rollback Check', testUser, Date.now()]
        );
        throw new Error('force-rollback');
      }),
      /force-rollback/
    );
    const check = await poolMod.query('SELECT id FROM quizzes WHERE id = $1', [rollbackId]);
    assert.equal(check.rows.length, 0);
  });

  await t.test('saveQuiz() handles v1 -> v2 multi-choice versioning and getQuizById() readback', async () => {
    await db.createUser({ username: testUser, displayName: 'Integration Teacher',
      passwordHash: 'aa', salt: 'bb', createdAt: Date.now() });

    const v1 = await db.saveQuiz({
      id: testQuizId,
      code: `#it${suffix}`,
      title: 'Đề Tích Hợp',
      questions: [{ id: `it-q-${suffix}`, text: 'Câu hỏi gốc?', choices: ['A', 'B', 'C'], correct: 0 }],
    }, testUser, false);
    assert.equal(v1.questions[0].version, 1);

    const v2 = await db.saveQuiz({
      id: testQuizId,
      code: `#it${suffix}`,
      title: 'Đề Tích Hợp',
      questions: [{ id: `it-q-${suffix}`, text: 'Câu hỏi gốc?', choices: ['A', 'B', 'C'], correctChoices: [0, 2], isMultiple: true }],
    }, testUser, false);
    assert.equal(v2.questions[0].version, 2);

    const readBack = await db.getQuizById(testQuizId, {
      requestingUser: { username: testUser, role: 'teacher' },
      includeCorrect: true,
    });
    assert.ok(readBack);
    assert.equal(readBack.questions[0].isMultiple, true);
    assert.deepEqual(readBack.questions[0].correctChoices, [0, 2]);
  });

  await t.test('saveAttempt() is idempotent on duplicate ID and saveHostedGameSession() persists session + players', async () => {
    await db.saveAttempt({
      id: testAttemptId,
      username: testUser,
      pin: '123-456',
      roomTitle: 'Integration Room',
      examTitle: 'Đề Tích Hợp',
      score: 100,
      maxScore: 100,
      correctCount: 1,
      totalQuestions: 1,
      ratioPct: 100,
      rank: 1,
      totalPlayers: 1,
      details: [],
    });
    await db.saveAttempt({
      id: testAttemptId,
      username: testUser,
      pin: '123-456',
      roomTitle: 'Integration Room',
      examTitle: 'Đề Tích Hợp',
      score: 100,
      maxScore: 100,
      correctCount: 1,
      totalQuestions: 1,
      ratioPct: 100,
      rank: 1,
      totalPlayers: 1,
      details: [],
    });
    const attRows = await poolMod.query('SELECT id FROM attempts WHERE id = $1', [testAttemptId]);
    assert.equal(attRows.rows.length, 1);

    await db.saveHostedGameSession(testUser, {
      id: testSessionId,
      pin: '999-888',
      quizId: testQuizId,
      roomTitle: 'Hosted Session IT',
      stats: {
        totalQuestions: 1,
        totalPlayers: 1,
        avgRatioPct: 100,
        questionsStats: [{ text: 'Q1', correctCount: 1, totalAnswered: 1, correctPct: 100, distribution: [1, 0, 0, 0], correctIndex: 0 }],
        candidatesMatrix: [{ id: 'p-it-1', nick: 'PlayerIT', score: 100, correctCount: 1, totalQuestions: 1 }],
      },
    });

    const loaded = await db.getHostedGameSessionById(testSessionId);
    assert.ok(loaded);
    assert.equal(loaded.roomTitle, 'Hosted Session IT');
  });

  await t.test('AI documents, ai_generation_jobs lifecycle and weakness cache roundtrip', async () => {
    const cacheKey = `it-cache-${suffix}`;
    const doc = await db.createAiDocument({
      ownerUsername: testUser,
      title: 'IT Doc',
      filePath: `ai://weakness/${testSessionId}`,
      contentText: JSON.stringify({ roomTitle: 'IT' }),
    });
    createdDocId = doc.id;
    assert.ok(createdDocId);

    const job = await db.createAiGenerationJob({
      username: testUser,
      status: 'pending',
      prompt: 'Analyze IT',
      resultData: { jobType: 'weakness-analysis', cacheKey },
    });
    createdJobId = job.id;
    assert.ok(createdJobId);

    await db.updateAiGenerationJob(createdJobId, {
      status: 'completed',
      resultData: {
        jobType: 'weakness-analysis',
        cacheKey,
        model: 'gemini-3.1-flash-lite',
        analysis: { overallSummary: 'IT summary', weakQuestions: [], teachingActions: [] },
      },
    });

    const hit = await db.findCachedWeaknessAnalysis(testUser, cacheKey);
    assert.ok(hit);
    assert.equal(hit.analysis.overallSummary, 'IT summary');
  });
});
