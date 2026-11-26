const test = require('node:test');
const assert = require('node:assert/strict');
const { createSqliteTestDb } = require('../helpers/sqlite-test-db.js');
const { loadIsolatedModule } = require('../helpers/test-server.js');

function createDbContext() {
  const pool = createSqliteTestDb();
  const db = loadIsolatedModule('src/db/index.js', {
    './pool.js': pool,
  });
  return { pool, db, close: () => pool.close() };
}

test('DB-01 [SQLite Full][Users & Sessions] createUser, findUserByUsername, updateUser, ràng buộc trùng tên và vòng đời user_sessions', async () => {
  const ctx = createDbContext();
  try {
    const u = await ctx.db.createUser({
      username: 'Teacher_DB01',
      displayName: '  Cô Minh Tâm  ',
      passwordHash: 'hash_v1',
      salt: 'salt_v1',
    });
    assert.equal(u.username, 'Teacher_DB01');
    assert.equal(u.usernameLower, 'teacher_db01');
    assert.equal(u.displayName, 'Cô Minh Tâm');

    // Ràng buộc UNIQUE không phân biệt hoa/thường trên username_lower -> mã lỗi 23505
    await assert.rejects(
      () => ctx.db.createUser({
        username: 'teacher_db01',
        displayName: 'Trùng tên',
        passwordHash: 'h',
        salt: 's',
      }),
      err => err.code === '23505' && /unique constraint/i.test(err.message)
    );

    const found = await ctx.db.findUserByUsername('TEACHER_DB01');
    assert.equal(found.id, u.id);
    assert.equal(found.role, 'teacher');

    const updated = await ctx.db.updateUser('Teacher_DB01', {
      displayName: 'Thạc sĩ Minh Tâm',
      passwordHash: 'hash_v2',
      salt: 'salt_v2',
      lastNameChangeAt: 1000,
      lastPasswordChangeAt: 2000,
    });
    assert.equal(updated.displayName, 'Thạc sĩ Minh Tâm');
    assert.equal(updated.passwordHash, 'hash_v2');
    assert.equal(updated.lastNameChangeAt, 1000);
    assert.equal(updated.lastPasswordChangeAt, 2000);

    // Sessions: saveSession upsert, getSession lọc phiên hết hạn, deleteOtherSessions giữ lại phiên hiện hành
    const now = Date.now();
    await ctx.db.saveSession('tok-valid-1', 'Teacher_DB01', now + 60_000, now);
    await ctx.db.saveSession('tok-valid-2', 'teacher_db01', now + 60_000, now);
    await ctx.db.saveSession('tok-expired', 'Teacher_DB01', now - 1000, now - 5000);

    assert.ok(await ctx.db.getSession('tok-valid-1'));
    assert.equal(await ctx.db.getSession('tok-expired'), null, 'Phiên hết hạn không được trả về');

    await ctx.db.deleteOtherSessions('TEACHER_DB01', 'tok-valid-1');
    assert.ok(await ctx.db.getSession('tok-valid-1'));
    assert.equal(await ctx.db.getSession('tok-valid-2'), null);

    await ctx.db.deleteSession('tok-valid-1');
    assert.equal(await ctx.db.getSession('tok-valid-1'), null);
  } finally {
    ctx.close();
  }
});

test('DB-02 [SQLite Full][Quiz Versioning & Access Control] Versioning bất biến (content/explanation/choices/difficulty/image), per-question points/timeLimit & Default-Deny', async () => {
  const ctx = createDbContext();
  try {
    const owner = await ctx.db.createUser({ username: 'owner_gv', displayName: 'Owner', passwordHash: 'h', salt: 's' });
    const other = await ctx.db.createUser({ username: 'other_gv', displayName: 'Other', passwordHash: 'h', salt: 's' });

    // v1: tạo đề riêng tư với points & timeLimit riêng cho từng câu
    const v1 = await ctx.db.saveQuiz({
      id: 'quiz-v-test',
      code: '#v100',
      title: 'Đề Versioning',
      pointsPerQ: 100,
      timePerQ: 15,
      questions: [
        {
          id: 'q-immut-1',
          text: 'Câu hỏi gốc',
          choices: ['Đáp án A', 'Đáp án B', 'Đáp án C'],
          correct: 1,
          explanation: 'Giải thích v1',
          difficulty: 'easy',
          image: 'https://example.com/v1.png',
          points: 250,
          timeLimit: 45,
        },
      ],
    }, 'owner_gv', false);

    assert.equal(v1.questions[0].version, 1);
    assert.equal(v1.questions[0].points, 250, 'Phải lưu đúng điểm riêng của từng câu hỏi');
    assert.equal(v1.questions[0].timeLimit, 45, 'Phải lưu đúng thời gian riêng của từng câu hỏi');

    // Lưu lại y hệt không đổi -> tái sử dụng v1 (không tăng version thừa)
    const v1Same = await ctx.db.saveQuiz({
      id: 'quiz-v-test',
      title: 'Đề Versioning (chỉ đổi tên đề)',
      questions: [
        {
          id: 'q-immut-1',
          text: 'Câu hỏi gốc',
          choices: ['Đáp án A', 'Đáp án B', 'Đáp án C'],
          correct: 1,
          explanation: 'Giải thích v1',
          difficulty: 'easy',
          image: 'https://example.com/v1.png',
          points: 250,
          timeLimit: 45,
        },
      ],
    }, 'owner_gv', false);
    assert.equal(v1Same.questions[0].version, 1, 'Không đổi nội dung câu hỏi thì phải giữ nguyên v1');

    // Regression: chỉ đổi difficulty & image -> phải sinh v2 bất biến!
    const v2ImgDiff = await ctx.db.saveQuiz({
      id: 'quiz-v-test',
      title: 'Đề Versioning',
      questions: [
        {
          id: 'q-immut-1',
          text: 'Câu hỏi gốc',
          choices: ['Đáp án A', 'Đáp án B', 'Đáp án C'],
          correct: 1,
          explanation: 'Giải thích v1',
          difficulty: 'hard',
          image: 'https://example.com/v2.png',
          points: 300,
          timeLimit: 60,
        },
      ],
    }, 'owner_gv', false);
    assert.equal(v2ImgDiff.questions[0].version, 2, 'Đổi difficulty/image phải sinh question_versions v2');
    assert.equal(v2ImgDiff.questions[0].difficulty, 'hard');
    assert.equal(v2ImgDiff.questions[0].image, 'https://example.com/v2.png');
    assert.equal(v2ImgDiff.questions[0].points, 300);
    assert.equal(v2ImgDiff.questions[0].timeLimit, 60);

    // Chuyển sang câu nhiều đáp án -> sinh v3
    const v3Multi = await ctx.db.saveQuiz({
      id: 'quiz-v-test',
      title: 'Đề Versioning',
      questions: [
        {
          id: 'q-immut-1',
          text: 'Câu hỏi gốc',
          choices: ['Đáp án A', 'Đáp án B', 'Đáp án C'],
          correctChoices: [0, 2],
          explanation: 'Giải thích v1',
          difficulty: 'hard',
          image: 'https://example.com/v2.png',
        },
      ],
    }, 'owner_gv', false);
    assert.equal(v3Multi.questions[0].version, 3);
    assert.equal(v3Multi.questions[0].isMultiple, true);
    assert.deepEqual(Array.from(v3Multi.questions[0].correctChoices), [0, 2]);

    // Kiểm tra người dùng khác cố ghi đè quiz của owner -> ném lỗi phân quyền & giữ nguyên dữ liệu
    await assert.rejects(
      () => ctx.db.saveQuiz({ id: 'quiz-v-test', title: 'Hack Quiz', questions: [] }, 'other_gv', false),
      /không có quyền chỉnh sửa/
    );

    // Kiểm tra phân quyền Default-Deny trên getQuizById và getPublicQuizById
    assert.equal(await ctx.db.getQuizById('quiz-v-test'), null, 'Khách ẩn danh không đọc được đề riêng tư');
    assert.equal(
      await ctx.db.getQuizById('quiz-v-test', { requestingUser: { username: 'other_gv', userId: other.id, role: 'teacher' } }),
      null,
      'Giáo viên khác không đọc được đề riêng tư'
    );
    assert.ok(
      await ctx.db.getQuizById('quiz-v-test', { requestingUser: { username: 'owner_gv', userId: owner.id, role: 'teacher' } }),
      'Chủ sở hữu đọc được đề riêng tư'
    );
    assert.ok(
      await ctx.db.getQuizById('quiz-v-test', { requestingUser: { username: 'sysadmin', userId: 999, role: 'admin' } }),
      'Admin đọc được đề riêng tư'
    );
    assert.equal(await ctx.db.getPublicQuizById('quiz-v-test'), null, 'getPublicQuizById không bao giờ trả đề riêng tư');

    // Xuất bản đề công khai -> ẩn đáp án trong getPublicQuizzes & tăng copies_issued nguyên tử
    await ctx.db.saveQuiz({
      id: 'quiz-pub-1',
      code: '#pub01',
      title: 'Đề Công Khai',
      questions: [{ id: 'qp1', text: '1+1=?', choices: ['1', '2'], correct: 1, explanation: 'Bí mật' }],
    }, 'owner_gv', true);

    const pubList = await ctx.db.getPublicQuizzes();
    assert.equal(pubList.length, 1);
    assert.equal(pubList[0].questions[0].correct, undefined, 'Danh sách công khai không được lộ đáp án đúng');
    assert.equal(pubList[0].questions[0].explanation, '', 'Danh sách công khai không được lộ lời giải');

    assert.equal(await ctx.db.incrementQuizCopiesIssued('quiz-pub-1'), 1);
    assert.equal(await ctx.db.incrementQuizCopiesIssued('#pub01'), 2);

    // Xóa mềm: other_gv thất bại, admin thành công
    assert.equal(await ctx.db.deleteQuiz('quiz-pub-1', { username: 'other_gv', userId: other.id, role: 'teacher' }), false);
    assert.equal(await ctx.db.deleteQuiz('quiz-pub-1', { username: 'admin_u', userId: 999, role: 'admin' }), true);
    assert.equal((await ctx.db.getPublicQuizzes()).length, 0);
  } finally {
    ctx.close();
  }
});

test('DB-03 [SQLite Full][Attempts, Relational Answers, Game Sessions & AI Cache] Khôi phục bài làm từ bảng quan hệ, chống selected_option_id giả mạo, lưu phòng & cache AI', async () => {
  const ctx = createDbContext();
  try {
    await ctx.db.createUser({ username: 'student_01', displayName: 'Học sinh 1', passwordHash: 'h', salt: 's' });
    await ctx.db.createUser({ username: 'host_01', displayName: 'Chủ phòng 1', passwordHash: 'h', salt: 's' });

    const savedQuiz = await ctx.db.saveQuiz({
      id: 'quiz-rel-1',
      code: '#rel1',
      title: 'Đề Quan Hệ',
      questions: [
        { id: 'q-rel-1', text: 'Chọn đáp án đúng (nhiều lựa chọn)', choices: ['Sai 1', 'Đúng 1', 'Đúng 2'], correctChoices: [1, 2] },
      ],
    }, 'host_01', true);
    const versionId = savedQuiz.questions[0].versionId;
    const validOptId = `${versionId}-opt-1`;

    // Lưu attempt với selectedOptionId giả mạo (không thuộc questionVersionId) -> DB tự động gán NULL bảo toàn khóa ngoại
    await ctx.db.saveAttempt({
      id: 'att-rel-1',
      username: 'student_01',
      quizId: 'quiz-rel-1',
      roomTitle: 'Phòng Kiểm Tra Quan Hệ',
      score: 120,
      maxScore: 100,
      correctCount: 1,
      totalQuestions: 1,
      ratioPct: 100,
      rank: 1,
      totalPlayers: 3,
      details: [
        {
          questionIndex: 0,
          questionVersionId: versionId,
          selectedOptionId: 'forged-option-from-other-question',
          userChoice: 1,
          isCorrect: true,
          earned: 120,
          responseTimeMs: 3200,
          streakBefore: 0,
          streakAfter: 1,
        },
      ],
    });

    const ansRow = await ctx.pool.query('SELECT selected_option_id FROM attempt_answers WHERE attempt_id = $1', ['att-rel-1']);
    assert.equal(ansRow.rows[0].selected_option_id, null, 'selected_option_id không khớp question_version phải bị chặn về NULL');

    // Lưu attempt thứ 2 với selectedOptionId hợp lệ, sau đó xóa cột JSON details để buộc getUserAttempts khôi phục qua JOIN = ANY($1)!
    await ctx.db.saveAttempt({
      id: 'att-rel-2',
      username: 'student_01',
      quizId: 'quiz-rel-1',
      roomTitle: 'Phòng Khôi Phục SQL',
      score: 100,
      maxScore: 100,
      correctCount: 1,
      totalQuestions: 1,
      ratioPct: 100,
      details: [
        {
          questionIndex: 0,
          questionVersionId: versionId,
          selectedOptionId: validOptId,
          userChoice: 1,
          isCorrect: true,
          earned: 100,
          responseTimeMs: 1500,
          streakAfter: 2,
        },
      ],
    });
    await ctx.pool.query('UPDATE attempts SET details = NULL WHERE id = $1', ['att-rel-2']);

    const attempts = await ctx.db.getUserAttempts('STUDENT_01');
    assert.equal(attempts.length, 2);
    const reconstructed = attempts.find(a => a.id === 'att-rel-2');
    assert.equal(reconstructed.details.length, 1);
    assert.equal(reconstructed.details[0].questionText, 'Chọn đáp án đúng (nhiều lựa chọn)');
    assert.deepEqual(Array.from(reconstructed.details[0].choices), ['Sai 1', 'Đúng 1', 'Đúng 2']);
    assert.deepEqual(Array.from(reconstructed.details[0].correctChoices), [1, 2]);
    assert.equal(reconstructed.details[0].questionType, 'multiple');

    // Kiểm tra Game Sessions (waiting -> finished) & Game Players
    await ctx.db.createWaitingGameSession({
      sessionId: 'sess-db-1',
      examId: 'quiz-rel-1',
      hostUsername: 'host_01',
      pin: '357-951',
      title: 'Phòng Đang Chờ',
      capacity: 30,
      isLocked: false,
      createdAt: Date.now() - 10_000,
    });
    await ctx.db.saveHostedGameSession('host_01', {
      id: 'sess-db-1',
      pin: '357-951',
      roomTitle: 'Phòng Đã Kết Thúc',
      capacity: 30,
      stats: {
        totalCandidates: 2,
        questionsStats: [{ qIdx: 1, text: 'Q1', correctCount: 1, totalCount: 2, ratioPct: 50 }],
        candidatesMatrix: [
          { id: 'p1', nick: 'An', av: '02', score: 120, correctCount: 1, totalQuestions: 1 },
          { id: 'p2', nick: 'Bình', av: '03', score: 0, correctCount: 0, totalQuestions: 1 },
        ],
      },
    });

    const hostedList = await ctx.db.getHostedGameSessions('HOST_01');
    assert.equal(hostedList.length, 1);
    assert.equal(hostedList[0].roomTitle, 'Phòng Đã Kết Thúc');
    const hostedById = await ctx.db.getHostedGameSessionById('sess-db-1');
    assert.equal(hostedById.pin, '357-951');
    assert.equal(hostedById.stats.candidatesMatrix.length, 2);

    const gpRows = await ctx.pool.query('SELECT nickname, rank, correct_count, wrong_count FROM game_players WHERE game_session_id = $1 ORDER BY rank ASC', ['sess-db-1']);
    assert.equal(gpRows.rows.length, 2);
    assert.equal(gpRows.rows[0].nickname, 'An');
    assert.equal(gpRows.rows[0].rank, 1);
    assert.equal(gpRows.rows[1].wrong_count, 1);

    // Kiểm tra AI Documents, Jobs & JSON Cache (->>'jobType' và ->>'cacheKey')
    const doc = await ctx.db.createAiDocument({
      ownerUsername: 'host_01',
      title: 'Tài liệu AI Địa lý',
      filePath: 'ai-topic://mixed/12',
      contentText: 'Địa lý tự nhiên Việt Nam',
    });
    assert.ok(doc.id);

    const job = await ctx.db.createAiGenerationJob({
      username: 'host_01',
      status: 'pending',
      prompt: 'Weakness analysis',
      resultData: { jobType: 'weakness-analysis', cacheKey: 'sess-db-1:abcdef123456' },
    });
    assert.ok(job.id);
    assert.equal(await ctx.db.findCachedWeaknessAnalysis('host_01', 'sess-db-1:abcdef123456'), null, 'Job đang pending chưa được coi là cache hit');

    await ctx.db.updateAiGenerationJob(job.id, {
      status: 'completed',
      resultData: {
        jobType: 'weakness-analysis',
        cacheKey: 'sess-db-1:abcdef123456',
        model: 'gemini-3.1-flash-lite',
        analysis: { overallSummary: 'Lớp nắm bài khá tốt.', weakQuestions: [], teachingActions: ['Ôn câu 1'] },
      },
    });

    const cachedHit = await ctx.db.findCachedWeaknessAnalysis('HOST_01', 'sess-db-1:abcdef123456');
    assert.ok(cachedHit);
    assert.equal(cachedHit.analysis.overallSummary, 'Lớp nắm bài khá tốt.');
    assert.equal(await ctx.db.findCachedWeaknessAnalysis('other_host', 'sess-db-1:abcdef123456'), null, 'Cache AI phải cô lập theo từng tài khoản giáo viên');

    // Kiểm tra withTransaction rollback hoàn toàn khi xảy ra lỗi giữa chừng
    await assert.rejects(
      () => ctx.pool.withTransaction(async client => {
        await client.query('INSERT INTO tags (name) VALUES ($1)', ['tag_rollback_test']);
        throw new Error('BOOM_ROLLBACK');
      }),
      /BOOM_ROLLBACK/
    );
    const tagCheck = await ctx.pool.query('SELECT COUNT(*) AS cnt FROM tags WHERE name = $1', ['tag_rollback_test']);
    assert.equal(Number(tagCheck.rows[0].cnt), 0, 'Transaction lỗi phải rollback sạch dữ liệu đã ghi tạm');
  } finally {
    ctx.close();
  }
});

test('DB-04 [SQLite Full][Migration & Legacy Import] runMigration nạp idempotent dữ liệu mẫu data/public/exams.json + đề nhiều đáp án vào SQLite in-memory', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const ctx = createDbContext();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqc-mig-'));
  try {
    // Tạo cây dữ liệu legacy cô lập trong thư mục tạm, kết hợp dữ liệu mẫu thật từ data/public/exams.json
    const realPublicJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../data/public/exams.json'), 'utf8')
    ).slice(0, 2);

    fs.mkdirSync(path.join(tmpRoot, 'data', 'public'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'data', 'private', 'gv_legacy'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'data', 'history'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'data', 'auth'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'auth', 'users.json'),
      JSON.stringify([{ username: 'gv_legacy', usernameLower: 'gv_legacy', displayName: 'GV Legacy', passwordHash: 'hh', salt: 'ss', createdAt: 1700000000000 }])
    );
    fs.writeFileSync(path.join(tmpRoot, 'data', 'public', 'exams.json'), JSON.stringify(realPublicJson));
    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'private', 'gv_legacy', 'multi.json'),
      JSON.stringify({
        id: 'legacy-multi-1',
        code: '#lgm1',
        title: 'Đề Legacy Nhiều Đáp Án',
        questions: [{ id: 'qlg1', text: 'Chọn đáp án đúng', choices: ['A', 'B', 'C'], correctChoices: [0, 2] }],
      })
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'history', 'gv_legacy.json'),
      JSON.stringify([{ id: 'att-legacy-1', pin: '111-222', roomTitle: 'Phòng Cũ', score: 200, maxScore: 200, correctCount: 2, totalQuestions: 2, ratioPct: 100 }])
    );

    // Đánh dấu các file .sql PG thuần đã áp dụng để kiểm thử luồng tracking schema_migrations + legacy import trên SQLite
    const migDir = path.resolve(__dirname, '../../src/db/migrations');
    for (const f of fs.readdirSync(migDir).filter(x => x.endsWith('.sql'))) {
      await ctx.pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', [f]);
    }

    const fakePath = {
      ...path,
      resolve(...args) {
        const res = path.resolve(...args);
        const realProjectRoot = path.resolve(__dirname, '../..');
        if (res === realProjectRoot) return tmpRoot;
        return res;
      },
    };

    const migrateMod = loadIsolatedModule('src/db/migrate.js', {
      './pool.js': ctx.pool,
      './supabase.js': { isConfigured: () => false },
      path: fakePath,
    });

    await migrateMod.runMigration();
    const firstQuizCount = Number((await ctx.pool.query('SELECT COUNT(*) AS cnt FROM quizzes')).rows[0].cnt);
    assert.equal(firstQuizCount, realPublicJson.length + 1);

    // Chạy lần 2 phải idempotent (bỏ qua import khi DB đã có đề thi)
    await migrateMod.runMigration();
    const secondQuizCount = Number((await ctx.pool.query('SELECT COUNT(*) AS cnt FROM quizzes')).rows[0].cnt);
    assert.equal(secondQuizCount, firstQuizCount);

    // Xác minh đề nhiều đáp án từ legacy import bảo toàn đủ cả 2 đáp án đúng [0, 2]
    const importedMulti = await ctx.db.getQuizById('legacy-multi-1', {
      includeCorrect: true,
      requestingUser: { username: 'gv_legacy', role: 'teacher' },
    });
    assert.ok(importedMulti);
    assert.equal(importedMulti.questions[0].isMultiple, true);
    assert.deepEqual(Array.from(importedMulti.questions[0].correctChoices), [0, 2]);

    const importedAttempts = await ctx.db.getUserAttempts('gv_legacy');
    assert.equal(importedAttempts.length, 1);
    assert.equal(importedAttempts[0].score, 200);
  } finally {
    ctx.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
