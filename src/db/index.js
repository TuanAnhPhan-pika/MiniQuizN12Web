const { query, withTransaction } = require('./pool.js');

// ═══════════════════════════════════════════════════════════════════════════
// 1. USERS & PROFILES & SESSIONS
// ═══════════════════════════════════════════════════════════════════════════

async function findUserByUsername(username) {
  const lower = String(username || '').toLowerCase();
  try {
    const res = await query(
      `SELECT u.id, u.username, u.username_lower, u.display_name, u.password_hash, u.salt,
              u.created_at, u.last_name_change_at, u.last_password_change_at,
              p.avatar, p.bio, p.role
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.username_lower = $1
       LIMIT 1`,
      [lower]
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      usernameLower: r.username_lower,
      displayName: r.display_name,
      passwordHash: r.password_hash,
      salt: r.salt,
      createdAt: Number(r.created_at),
      lastNameChangeAt: Number(r.last_name_change_at || 0),
      lastPasswordChangeAt: Number(r.last_password_change_at || 0),
      avatar: r.avatar || '01',
      bio: r.bio || '',
      role: r.role || 'teacher',
    };
  } catch (err) {
    console.error('Lỗi findUserByUsername:', err.message);
    return null;
  }
}

async function createUser({ username, displayName, passwordHash, salt }) {
  const now = Date.now();
  const lower = username.toLowerCase();
  return await withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO users (username, username_lower, display_name, password_hash, salt, created_at, last_name_change_at, last_password_change_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
       RETURNING id, username, display_name, created_at`,
      [username, lower, displayName.trim(), passwordHash, salt, now]
    );

    const user = res.rows[0];
    await client.query(
      `INSERT INTO profiles (user_id, username, display_name, avatar, role)
       VALUES ($1, $2, $3, '01', 'teacher')
       ON CONFLICT (username) DO NOTHING`,
      [user.id, user.username, user.display_name]
    );

    return {
      id: user.id,
      username: user.username,
      usernameLower: lower,
      displayName: user.display_name,
      passwordHash,
      salt,
      createdAt: now,
      lastNameChangeAt: 0,
      lastPasswordChangeAt: 0,
      avatar: '01',
      role: 'teacher',
    };
  });
}

async function updateUser(username, patch) {
  const lower = String(username || '').toLowerCase();
  return await withTransaction(async (client) => {
    const setClauses = [];
    const values = [];
    let idx = 1;

    if (patch.displayName !== undefined) {
      setClauses.push(`display_name = $${idx++}`);
      values.push(patch.displayName);
    }
    if (patch.passwordHash !== undefined) {
      setClauses.push(`password_hash = $${idx++}`);
      values.push(patch.passwordHash);
    }
    if (patch.salt !== undefined) {
      setClauses.push(`salt = $${idx++}`);
      values.push(patch.salt);
    }
    if (patch.lastNameChangeAt !== undefined) {
      setClauses.push(`last_name_change_at = $${idx++}`);
      values.push(patch.lastNameChangeAt);
    }
    if (patch.lastPasswordChangeAt !== undefined) {
      setClauses.push(`last_password_change_at = $${idx++}`);
      values.push(patch.lastPasswordChangeAt);
    }

    if (setClauses.length > 0) {
      values.push(lower);
      await client.query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE username_lower = $${idx}`,
        values
      );
    }

    if (patch.displayName !== undefined || patch.avatar !== undefined || patch.bio !== undefined) {
      const pClauses = [];
      const pVals = [];
      let pIdx = 1;
      if (patch.displayName !== undefined) {
        pClauses.push(`display_name = $${pIdx++}`);
        pVals.push(patch.displayName);
      }
      if (patch.avatar !== undefined) {
        pClauses.push(`avatar = $${pIdx++}`);
        pVals.push(patch.avatar);
      }
      if (patch.bio !== undefined) {
        pClauses.push(`bio = $${pIdx++}`);
        pVals.push(patch.bio);
      }
      pVals.push(lower);
      await client.query(
        `UPDATE profiles SET ${pClauses.join(', ')}, updated_at = NOW() WHERE LOWER(username) = $${pIdx}`,
        pVals
      );
    }

    return await findUserByUsername(username);
  });
}

// ── Persistent Sessions in DB ──
async function saveSession(token, username, expiresAt) {
  const now = Date.now();
  await query(
    `INSERT INTO user_sessions (token, username, created_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [token, username, now, expiresAt]
  );
}

async function getSession(token) {
  if (!token) return null;
  const now = Date.now();
  const res = await query(
    `SELECT token, username, created_at, expires_at FROM user_sessions WHERE token = $1 AND expires_at > $2 LIMIT 1`,
    [token, now]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    token: r.token,
    username: r.username,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  };
}

async function deleteSession(token) {
  if (!token) return;
  await query(`DELETE FROM user_sessions WHERE token = $1`, [token]);
}

async function deleteOtherSessions(username, exceptToken) {
  const lower = String(username || '').toLowerCase();
  await query(
    `DELETE FROM user_sessions WHERE LOWER(username) = $1 AND token != $2`,
    [lower, exceptToken || '']
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. QUIZZES, QUESTION BANK & VERSIONING
// ═══════════════════════════════════════════════════════════════════════════

async function formatQuizWithQuestions(quizRow, includeCorrect = true) {
  if (!quizRow) return null;

  // Lấy danh sách câu hỏi qua quiz_questions và question_versions
  const res = await query(
    `SELECT qq.order_index, qq.points, qq.time_limit,
            qv.id as version_id, qv.question_id, qv.version, qv.content, qv.explanation, qv.difficulty, qv.image_url
     FROM quiz_questions qq
     JOIN question_versions qv ON qv.id = qq.question_version_id
     WHERE qq.quiz_id = $1
     ORDER BY qq.order_index ASC`,
    [quizRow.id]
  );

  const questions = [];
  for (const qRow of res.rows) {
    // Lấy choices từ question_options
    const optRes = await query(
      `SELECT id, content, is_correct, order_index
       FROM question_options
       WHERE question_version_id = $1
       ORDER BY order_index ASC`,
      [qRow.version_id]
    );

    const choices = [];
    let correctIndex = 0;
    optRes.rows.forEach((opt, idx) => {
      choices.push(opt.content);
      if (opt.is_correct) correctIndex = idx;
    });

    const qObj = {
      id: qRow.question_id,
      versionId: qRow.version_id,
      version: qRow.version,
      text: qRow.content,
      choices: choices,
      explanation: qRow.explanation || '',
      difficulty: qRow.difficulty || 'medium',
      image: qRow.image_url || '',
      points: qRow.points || 100,
      timeLimit: qRow.time_limit || 15,
    };

    if (includeCorrect) {
      qObj.correct = correctIndex;
    }

    questions.push(qObj);
  }

  return {
    id: quizRow.id,
    code: quizRow.code,
    title: quizRow.title,
    desc: quizRow.description || '',
    subject: quizRow.subject || '',
    author: quizRow.author || '',
    timePerQ: quizRow.time_per_q || 15,
    pointsPerQ: quizRow.points_per_q || 100,
    isPublic: !!quizRow.is_public,
    ownerUsername: quizRow.owner_id || '',
    parentCode: quizRow.parent_code || '',
    copiesIssued: quizRow.copies_issued || 0,
    sharedBy: quizRow.shared_by || '',
    sharedAt: quizRow.shared_at || '',
    createdAt: quizRow.created_at || '',
    updatedAt: quizRow.updated_at || '',
    createdTimestamp: Number(quizRow.created_timestamp || 0),
    questions: questions,
  };
}

async function getPublicQuizzes() {
  const res = await query(
    `SELECT * FROM quizzes WHERE is_public = true ORDER BY created_timestamp DESC`
  );
  const out = [];
  for (const row of res.rows) {
    const qz = await formatQuizWithQuestions(row, true);
    if (qz) out.push(qz);
  }
  return out;
}

async function getPrivateQuizzes(ownerUsername) {
  const lower = String(ownerUsername || '').toLowerCase();
  const res = await query(
    `SELECT * FROM quizzes WHERE LOWER(owner_id) = $1 ORDER BY created_timestamp DESC`,
    [lower]
  );
  const out = [];
  for (const row of res.rows) {
    const qz = await formatQuizWithQuestions(row, true);
    if (qz) out.push(qz);
  }
  return out;
}

async function getQuizById(quizId, { includeCorrect = true } = {}) {
  const res = await query(
    `SELECT * FROM quizzes WHERE id = $1 OR code = $1 LIMIT 1`,
    [quizId]
  );
  if (res.rows.length === 0) return null;
  return await formatQuizWithQuestions(res.rows[0], includeCorrect);
}

/**
 * Lưu hoặc cập nhật Quiz
 * Tự động tạo Question Version mới nếu nội dung câu hỏi bị thay đổi,
 * bảo toàn tính toàn vẹn cho các bài thi cũ hoặc đề thi khác đang tái sử dụng câu hỏi.
 */
async function saveQuiz(exam, ownerUsername, isPublic = false) {
  const savedQuizId = await withTransaction(async (client) => {
    const quizId = exam.id || `exam-${Date.now()}`;
    const code = exam.code || `#${Math.random().toString(16).slice(2, 6)}`;
    const now = Date.now();
    const owner = String(ownerUsername || exam.ownerUsername || 'system').toLowerCase();

    // 1. Lưu thông tin Quiz
    await client.query(
      `INSERT INTO quizzes (id, code, title, description, subject, author, time_per_q, points_per_q, is_public, owner_id, parent_code, copies_issued, shared_by, shared_at, created_at, updated_at, created_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         subject = EXCLUDED.subject,
         author = EXCLUDED.author,
         time_per_q = EXCLUDED.time_per_q,
         points_per_q = EXCLUDED.points_per_q,
         is_public = EXCLUDED.is_public,
         copies_issued = EXCLUDED.copies_issued,
         shared_by = EXCLUDED.shared_by,
         shared_at = EXCLUDED.shared_at,
         updated_at = EXCLUDED.updated_at`,
      [
        quizId,
        code,
        exam.title || 'Đề thi trắc nghiệm',
        exam.desc || exam.description || '',
        exam.subject || '',
        exam.author || '',
        exam.timePerQ || 15,
        exam.pointsPerQ || 100,
        !!isPublic,
        owner,
        exam.parentCode || '',
        exam.copiesIssued || 0,
        exam.sharedBy || '',
        exam.sharedAt || '',
        exam.createdAt || new Date().toISOString(),
        new Date().toISOString(),
        exam.createdTimestamp || now
      ]
    );

    // 2. Xóa liên kết quiz_questions cũ của quiz này
    await client.query(`DELETE FROM quiz_questions WHERE quiz_id = $1`, [quizId]);

    // 3. Xử lý từng câu hỏi và Versioning
    const qs = Array.isArray(exam.questions) ? exam.questions : [];
    for (let idx = 0; idx < qs.length; idx++) {
      const q = qs[idx];
      let questionId = q.id;

      // Nếu câu hỏi chưa có id hoặc id rỗng, sinh id mới
      if (!questionId || questionId.startsWith('temp-')) {
        questionId = `q-${quizId}-${idx + 1}-${Date.now().toString(36)}`;
      }

      // Đảm bảo question tồn tại trong questions
      await client.query(
        `INSERT INTO questions (id, owner_id)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [questionId, owner]
      );

      // Kiểm tra version mới nhất hiện tại của câu hỏi này
      const vRes = await client.query(
        `SELECT version, id, content, explanation, difficulty
         FROM question_versions
         WHERE question_id = $1
         ORDER BY version DESC LIMIT 1`,
        [questionId]
      );

      let targetVersionId = null;
      let targetVersion = 1;

      if (vRes.rows.length === 0) {
        // Chưa có version nào -> tạo version 1
        targetVersion = 1;
        targetVersionId = `${questionId}-v1`;
        await client.query(
          `INSERT INTO question_versions (id, question_id, version, content, explanation, difficulty, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [targetVersionId, questionId, targetVersion, q.text || '', q.explanation || '', q.difficulty || 'medium', q.image || '']
        );

        // Lưu options
        const choices = Array.isArray(q.choices) ? q.choices : [];
        for (let cIdx = 0; cIdx < choices.length; cIdx++) {
          const optId = `${targetVersionId}-opt-${cIdx}`;
          await client.query(
            `INSERT INTO question_options (id, question_version_id, content, is_correct, order_index)
             VALUES ($1, $2, $3, $4, $5)`,
            [optId, targetVersionId, String(choices[cIdx]), (q.correct === cIdx), cIdx]
          );
        }
      } else {
        // Đã có version trước đó -> kiểm tra xem nội dung/lựa chọn có bị thay đổi không
        const lastV = vRes.rows[0];
        const lastOptsRes = await client.query(
          `SELECT content, is_correct, order_index FROM question_options WHERE question_version_id = $1 ORDER BY order_index ASC`,
          [lastV.id]
        );

        const currentChoices = Array.isArray(q.choices) ? q.choices : [];
        let hasChanged = false;

        if (lastV.content !== (q.text || '') || (lastV.explanation || '') !== (q.explanation || '')) {
          hasChanged = true;
        } else if (lastOptsRes.rows.length !== currentChoices.length) {
          hasChanged = true;
        } else {
          for (let cIdx = 0; cIdx < currentChoices.length; cIdx++) {
            const opt = lastOptsRes.rows[cIdx];
            if (opt.content !== String(currentChoices[cIdx]) || opt.is_correct !== (q.correct === cIdx)) {
              hasChanged = true;
              break;
            }
          }
        }

        if (hasChanged) {
          // Tạo VERSION MỚI (không đè lên version cũ để giữ lịch sử thi!)
          targetVersion = lastV.version + 1;
          targetVersionId = `${questionId}-v${targetVersion}`;

          await client.query(
            `INSERT INTO question_versions (id, question_id, version, content, explanation, difficulty, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [targetVersionId, questionId, targetVersion, q.text || '', q.explanation || '', q.difficulty || 'medium', q.image || '']
          );

          for (let cIdx = 0; cIdx < currentChoices.length; cIdx++) {
            const optId = `${targetVersionId}-opt-${cIdx}`;
            await client.query(
              `INSERT INTO question_options (id, question_version_id, content, is_correct, order_index)
               VALUES ($1, $2, $3, $4, $5)`,
              [optId, targetVersionId, String(currentChoices[cIdx]), (q.correct === cIdx), cIdx]
            );
          }
        } else {
          // Không thay đổi -> Tái sử dụng version hiện tại!
          targetVersionId = lastV.id;
        }
      }

      // 4. Ánh xạ vào quiz_questions
      const qqId = `qq-${quizId}-${idx + 1}`;
      await client.query(
        `INSERT INTO quiz_questions (id, quiz_id, question_version_id, order_index, points, time_limit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [qqId, quizId, targetVersionId, idx, exam.pointsPerQ || 100, exam.timePerQ || 15]
      );
    }

    return quizId;
  });

  return await getQuizById(savedQuizId, { includeCorrect: true });
}

async function deleteQuiz(quizId, ownerUsername) {
  const lower = String(ownerUsername || '').toLowerCase();
  const res = await query(
    `DELETE FROM quizzes WHERE id = $1 AND (LOWER(owner_id) = $2 OR $2 = 'admin' OR $2 = 'system') RETURNING id`,
    [quizId, lower]
  );
  return res.rowCount > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. ATTEMPTS & GRANULAR ANSWERS (HISTORY)
// ═══════════════════════════════════════════════════════════════════════════

async function getUserAttempts(username) {
  const lower = String(username || '').toLowerCase();
  const res = await query(
    `SELECT * FROM attempts WHERE LOWER(user_id) = $1 ORDER BY created_at DESC`,
    [lower]
  );

  const out = [];
  for (const a of res.rows) {
    const ansRes = await query(
      `SELECT question_index, user_choice, is_correct, score_awarded, response_time_ms, streak_before, streak_after
       FROM attempt_answers
       WHERE attempt_id = $1
       ORDER BY question_index ASC`,
      [a.id]
    );

    const answersDetail = ansRes.rows.map(ans => ({
      questionIndex: ans.question_index,
      userChoice: ans.user_choice,
      isCorrect: ans.is_correct,
      earned: ans.score_awarded,
      responseTimeMs: ans.response_time_ms,
      streak: ans.streak_after,
    }));

    out.push({
      id: a.id,
      pin: a.pin || '',
      roomTitle: a.room_title || '',
      examTitle: a.exam_title || '',
      score: a.score,
      correctCount: a.correct_count,
      totalQuestions: a.total_questions,
      ratioPct: a.ratio_pct,
      formattedTime: a.formatted_time || (a.finished_at ? new Date(Number(a.finished_at)).toLocaleString('vi-VN') : ''),
      createdAt: Number(a.created_at),
      finishedAt: Number(a.finished_at || a.created_at),
      answersDetail: answersDetail,
    });
  }
  return out;
}

async function saveAttempt(record) {
  const attemptId = record.id || `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = record.createdAt || record.finishedAt || Date.now();
  const user = String(record.username || record.userId || 'guest').toLowerCase();

  return await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO attempts (id, user_id, quiz_id, game_session_id, pin, room_title, exam_title, score, max_score, correct_count, wrong_count, unanswered_count, total_questions, ratio_pct, total_time_ms, formatted_time, started_at, finished_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (id) DO NOTHING`,
      [
        attemptId,
        user,
        record.quizId || null,
        record.gameSessionId || null,
        record.pin || '',
        record.roomTitle || '',
        record.examTitle || record.roomTitle || '',
        record.score || 0,
        record.maxScore || ((record.totalQuestions || 0) * 100),
        record.correctCount || 0,
        record.wrongCount || ((record.totalQuestions || 0) - (record.correctCount || 0)),
        record.unansweredCount || 0,
        record.totalQuestions || 0,
        record.ratioPct !== undefined ? record.ratioPct : (record.accuracyPct || 0),
        record.totalTimeMs || 0,
        record.formattedTime || new Date(now).toLocaleString('vi-VN'),
        record.startedAt || now,
        record.finishedAt || now,
        now
      ]
    );

    const answers = record.answersDetail || record.details || [];
    for (let i = 0; i < answers.length; i++) {
      const ans = answers[i];
      await client.query(
        `INSERT INTO attempt_answers (attempt_id, question_version_id, question_index, user_choice, is_correct, response_time_ms, score_awarded, streak_before, streak_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          attemptId,
          ans.questionVersionId || null,
          ans.questionIndex !== undefined ? ans.questionIndex : i,
          ans.userChoice !== undefined ? ans.userChoice : -1,
          !!ans.isCorrect,
          ans.responseTimeMs || 0,
          ans.earned || ans.scoreAwarded || 0,
          ans.streakBefore || 0,
          ans.streakAfter || ans.streak || 0
        ]
      );
    }

    return { id: attemptId, ...record };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. MULTIPLAYER: GAME SESSIONS & PLAYERS
// ═══════════════════════════════════════════════════════════════════════════

async function saveHostedGameSession(hostUsername, sessionRecord) {
  const sessionId = sessionRecord.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = sessionRecord.finishedAt || Date.now();
  const host = String(hostUsername || 'host').toLowerCase();
  const stats = sessionRecord.stats || {};
  const candidates = stats.candidatesMatrix || [];

  return await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO game_sessions (id, quiz_id, host_id, room_code, room_title, status, capacity, total_players, started_at, ended_at, formatted_time, stats, created_at)
       VALUES ($1, $2, $3, $4, $5, 'finished', $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         ended_at = EXCLUDED.ended_at,
         stats = EXCLUDED.stats,
         total_players = EXCLUDED.total_players`,
      [
        sessionId,
        sessionRecord.quizId || null,
        host,
        sessionRecord.pin || '',
        sessionRecord.roomTitle || sessionRecord.title || 'Phòng thi trực tuyến',
        sessionRecord.capacity || 40,
        candidates.length,
        sessionRecord.createdAt || (now - 60000),
        now,
        sessionRecord.formattedTime || new Date(now).toLocaleString('vi-VN'),
        JSON.stringify(stats),
        sessionRecord.createdAt || now
      ]
    );

    // Lưu từng thí sinh vào game_players
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const playerId = c.id || `p-${sessionId}-${i + 1}`;
      await client.query(
        `INSERT INTO game_players (id, game_session_id, user_id, nickname, avatar, final_score, rank, correct_count, wrong_count, joined_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           final_score = EXCLUDED.final_score,
           rank = EXCLUDED.rank`,
        [
          playerId,
          sessionId,
          c.userId || null,
          c.nick || 'Thí sinh',
          c.av || '01',
          c.score || 0,
          i + 1,
          c.correctCount || 0,
          (c.totalQuestions || 0) - (c.correctCount || 0),
          sessionRecord.createdAt || now,
          now
        ]
      );
    }

    return { id: sessionId, ...sessionRecord };
  });
}

async function getHostedGameSessions(hostUsername) {
  const host = String(hostUsername || '').toLowerCase();
  const res = await query(
    `SELECT * FROM game_sessions WHERE LOWER(host_id) = $1 ORDER BY ended_at DESC LIMIT 20`,
    [host]
  );

  return res.rows.map(row => ({
    id: row.id,
    pin: row.room_code,
    roomTitle: row.room_title,
    createdAt: Number(row.created_at),
    finishedAt: Number(row.ended_at || row.created_at),
    formattedTime: row.formatted_time,
    stats: typeof row.stats === 'string' ? JSON.parse(row.stats) : (row.stats || {}),
  }));
}

module.exports = {
  // Users & Auth
  findUserByUsername,
  createUser,
  updateUser,
  saveSession,
  getSession,
  deleteSession,
  deleteOtherSessions,

  // Quizzes & Questions
  getPublicQuizzes,
  getPrivateQuizzes,
  getQuizById,
  saveQuiz,
  deleteQuiz,

  // Attempts & History
  getUserAttempts,
  saveAttempt,

  // Game Sessions & Players
  saveHostedGameSession,
  getHostedGameSessions,
};
