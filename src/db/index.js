const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const pg = require('./pool.js');

let rawUrl = (process.env.SUPABASE_URL || '').trim();
rawUrl = rawUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
const supabaseUrl = rawUrl;
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

let supabase = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (err) {
    console.error('Lỗi khởi tạo Supabase client:', err.message);
  }
}

const DATA_BACKEND = process.env.DATA_BACKEND || 'pg';
if (DATA_BACKEND !== 'pg') throw new Error('Runtime CRUD requires DATA_BACKEND=pg');
function useSupabase() { return false; } // Never fallback from pg to REST.

async function findUserByUsername(username) {
  const lower = String(username || '').toLowerCase();
  if (useSupabase()) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('username_lower', lower)
        .maybeSingle();

      if (error || !data) return null;

      // Lấy profile kèm theo
      const pRes = await supabase
        .from('profiles')
        .select('*')
        .eq('username', data.username)
        .maybeSingle();

      const prof = pRes.data || {};
      return {
        id: data.id,
        username: data.username,
        usernameLower: data.username_lower,
        displayName: data.display_name,
        passwordHash: data.password_hash,
        salt: data.salt,
        createdAt: Number(data.created_at),
        lastNameChangeAt: Number(data.last_name_change_at || 0),
        lastPasswordChangeAt: Number(data.last_password_change_at || 0),
        avatar: prof.avatar || '01',
        bio: prof.bio || '',
        role: prof.role || 'teacher',
      };
    } catch (e) {
      console.error('Supabase findUser error:', e.message);
      return null;
    }
  }

  // PG Fallback
  try {
    const res = await pg.query(
      `SELECT u.id, u.username, u.username_lower, u.display_name, u.password_hash, u.salt,
              u.created_at, u.last_name_change_at, u.last_password_change_at,
              p.avatar, p.bio, p.role
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.username_lower = $1 LIMIT 1`,
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
    console.error('PG findUser error:', err.message);
    return null;
  }
}

async function createUser({ username, displayName, passwordHash, salt }) {
  const now = Date.now();
  const lower = username.toLowerCase();

  if (useSupabase()) {
    try {
      const { data: user, error: uErr } = await supabase
        .from('users')
        .insert({
          username,
          username_lower: lower,
          display_name: displayName.trim(),
          password_hash: passwordHash,
          salt,
          created_at: now,
          last_name_change_at: 0,
          last_password_change_at: 0
        })
        .select()
        .single();

      if (uErr) throw new Error(uErr.message);

      await supabase.from('profiles').insert({
        user_id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar: '01',
        role: 'teacher'
      });

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
    } catch (e) {
      console.error('Supabase createUser exception:', e.message);
      throw e;
    }
  }

  // PG Fallback
  return await pg.withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO users (username, username_lower, display_name, password_hash, salt, created_at, last_name_change_at, last_password_change_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0) RETURNING id, username, display_name, created_at`,
      [username, lower, displayName.trim(), passwordHash, salt, now]
    );
    const user = res.rows[0];
    await client.query(
      `INSERT INTO profiles (user_id, username, display_name, avatar, role)
       VALUES ($1, $2, $3, '01', 'teacher') ON CONFLICT (username) DO NOTHING`,
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

  if (useSupabase()) {
    try {
      const uPatch = {};
      if (patch.displayName !== undefined) uPatch.display_name = patch.displayName;
      if (patch.passwordHash !== undefined) uPatch.password_hash = patch.passwordHash;
      if (patch.salt !== undefined) uPatch.salt = patch.salt;
      if (patch.lastNameChangeAt !== undefined) uPatch.last_name_change_at = patch.lastNameChangeAt;
      if (patch.lastPasswordChangeAt !== undefined) uPatch.last_password_change_at = patch.lastPasswordChangeAt;

      if (Object.keys(uPatch).length > 0) {
        await supabase.from('users').update(uPatch).eq('username_lower', lower);
      }

      const pPatch = {};
      if (patch.displayName !== undefined) pPatch.display_name = patch.displayName;
      if (patch.avatar !== undefined) pPatch.avatar = patch.avatar;
      if (patch.bio !== undefined) pPatch.bio = patch.bio;
      if (Object.keys(pPatch).length > 0) {
        await supabase.from('profiles').update(pPatch).eq('username', username);
      }

      return await findUserByUsername(username);
    } catch (e) {
      console.error('Supabase updateUser exception:', e.message);
      return null;
    }
  }

  // PG Fallback
  return await pg.withTransaction(async (client) => {
    const setClauses = [];
    const values = [];
    let idx = 1;
    if (patch.displayName !== undefined) { setClauses.push(`display_name = $${idx++}`); values.push(patch.displayName); }
    if (patch.passwordHash !== undefined) { setClauses.push(`password_hash = $${idx++}`); values.push(patch.passwordHash); }
    if (patch.salt !== undefined) { setClauses.push(`salt = $${idx++}`); values.push(patch.salt); }
    if (patch.lastNameChangeAt !== undefined) { setClauses.push(`last_name_change_at = $${idx++}`); values.push(patch.lastNameChangeAt); }
    if (patch.lastPasswordChangeAt !== undefined) { setClauses.push(`last_password_change_at = $${idx++}`); values.push(patch.lastPasswordChangeAt); }

    if (setClauses.length > 0) {
      values.push(lower);
      await client.query(`UPDATE users SET ${setClauses.join(', ')} WHERE username_lower = $${idx}`, values);
    }
    return await findUserByUsername(username);
  });
}

// ── Sessions ──
async function saveSession(token, username, expiresAt) {
  const now = Date.now();
  if (useSupabase()) {
    try {
      await supabase.from('user_sessions').upsert({ token, username, created_at: now, expires_at: expiresAt });
      return;
    } catch (e) {}
  }
  try {
    await pg.query(
      `INSERT INTO user_sessions (token, username, created_at, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [token, username, now, expiresAt]
    );
  } catch (e) {}
}

async function getSession(token) {
  if (!token) return null;
  const now = Date.now();
  if (useSupabase()) {
    try {
      const { data } = await supabase.from('user_sessions').select('*').eq('token', token).gt('expires_at', now).maybeSingle();
      if (!data) return null;
      return { token: data.token, username: data.username, createdAt: Number(data.created_at), expiresAt: Number(data.expires_at) };
    } catch (e) { return null; }
  }
  try {
    const res = await pg.query(`SELECT token, username, created_at, expires_at FROM user_sessions WHERE token = $1 AND expires_at > $2 LIMIT 1`, [token, now]);
    if (res.rows.length === 0) return null;
    return { token: res.rows[0].token, username: res.rows[0].username, createdAt: Number(res.rows[0].created_at), expiresAt: Number(res.rows[0].expires_at) };
  } catch (e) { return null; }
}

async function deleteSession(token) {
  if (!token) return;
  if (useSupabase()) {
    try { await supabase.from('user_sessions').delete().eq('token', token); } catch (e) {}
    return;
  }
  try { await pg.query(`DELETE FROM user_sessions WHERE token = $1`, [token]); } catch (e) {}
}

async function deleteOtherSessions(username, exceptToken) {
  const lower = String(username || '').toLowerCase();
  if (useSupabase()) {
    try { await supabase.from('user_sessions').delete().eq('username', username).neq('token', exceptToken || ''); } catch (e) {}
    return;
  }
  try { await pg.query(`DELETE FROM user_sessions WHERE LOWER(username) = $1 AND token != $2`, [lower, exceptToken || '']); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. QUIZZES, QUESTION BANK & VERSIONING
// ═══════════════════════════════════════════════════════════════════════════

async function formatQuizWithQuestionsSupabase(quizRow, includeCorrect = true) {
  if (!quizRow) return null;
  const { data: qqList } = await supabase
    .from('quiz_questions')
    .select('*, question_versions(*)')
    .eq('quiz_id', quizRow.id)
    .order('order_index', { ascending: true });

  const questions = [];
  for (const qq of (qqList || [])) {
    const qv = qq.question_versions || {};
    const { data: optList } = await supabase
      .from('question_options')
      .select('*')
      .eq('question_version_id', qv.id || qq.question_version_id)
      .order('order_index', { ascending: true });

    const choices = [];
    let correctIndex = 0;
    (optList || []).forEach((opt, idx) => {
      choices.push(opt.content);
      if (opt.is_correct) correctIndex = idx;
    });

    const qObj = {
      id: qv.question_id || qq.question_version_id,
      versionId: qv.id || qq.question_version_id,
      version: qv.version || 1,
      text: qv.content || '',
      choices: choices,
      explanation: qv.explanation || '',
      difficulty: qv.difficulty || 'medium',
      image: qv.image_url || '',
      points: qq.points || 100,
      timeLimit: qq.time_limit || 15,
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
    ownerUserId: quizRow.owner_user_id || null,
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
  const res = await pg.query(
    `SELECT * FROM quizzes 
     WHERE is_public = true 
       AND (deleted_at IS NULL)
       AND (status IS NULL OR status != 'archived')
     ORDER BY created_timestamp DESC`
  );
  const out = [];
  for (const row of res.rows) {
    const qz = await formatQuizWithQuestionsPG(row, false);
    if (qz) out.push(qz);
  }
  return out;
}

async function getPrivateQuizzes(ownerUsername) {
  const lower = String(ownerUsername || '').toLowerCase();
  const uRes = await pg.query(`SELECT id FROM users WHERE username_lower = $1 LIMIT 1`, [lower]);
  const ownerUserId = uRes.rows[0]?.id || null;

  const res = await pg.query(
    `SELECT * FROM quizzes 
     WHERE (owner_user_id = $1 OR LOWER(owner_id) = $2)
       AND (deleted_at IS NULL)
       AND (status IS NULL OR status != 'archived')
     ORDER BY created_timestamp DESC`,
    [ownerUserId, lower]
  );
  const out = [];
  for (const row of res.rows) {
    const qz = await formatQuizWithQuestionsPG(row, true);
    if (qz) out.push(qz);
  }
  return out;
}

async function getQuizById(quizId, { includeCorrect = false, requestingUser = null, internal = false } = {}) {
  const res = await pg.query(
    `SELECT * FROM quizzes 
     WHERE (id = $1 OR code = $1)
       AND (deleted_at IS NULL)
       AND (status IS NULL OR status != 'archived')
     LIMIT 1`,
    [quizId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  // Phân quyền: nếu đề thi là riêng tư (is_public = false), bắt buộc requestingUser hợp lệ (Default-Deny)
  if (!row.is_public && !internal) {
    if (!requestingUser) {
      return null;
    }
    const reqUname = String(typeof requestingUser === 'string' ? requestingUser : requestingUser.username || '').toLowerCase();
    const reqUid = typeof requestingUser === 'object' ? (requestingUser.userId || requestingUser.id) : null;
    const isOwner = (reqUid && row.owner_user_id === reqUid) ||
                    (row.owner_id && row.owner_id.toLowerCase() === reqUname) ||
                    (row.shared_by && row.shared_by.toLowerCase() === reqUname) ||
                    (typeof requestingUser === 'object' && requestingUser.role === 'admin');
    if (!isOwner) {
      return null;
    }
  }

  return await formatQuizWithQuestionsPG(row, includeCorrect);
}

/**
 * Hàm chuyên biệt truy vấn đề thi công khai:
 * - Chỉ trả về đề thi có is_public = true, chưa bị xóa và chưa bị lưu trữ.
 * - Mặc định KHÔNG trả về đáp án đúng (includeCorrect = false).
 */
async function getPublicQuizById(quizId, { includeCorrect = false } = {}) {
  const res = await pg.query(
    `SELECT * FROM quizzes 
     WHERE (id = $1 OR code = $1)
       AND is_public = true
       AND (deleted_at IS NULL)
       AND (status IS NULL OR status != 'archived')
     LIMIT 1`,
    [quizId]
  );
  if (res.rows.length === 0) return null;
  return await formatQuizWithQuestionsPG(res.rows[0], includeCorrect);
}

/**
 * Tăng bộ đếm bản sao của đề thi công khai mà không rebuild hay ghi đè đề thi
 */
async function incrementQuizCopiesIssued(quizId) {
  const res = await pg.query(
    `UPDATE quizzes 
     SET copies_issued = COALESCE(copies_issued, 0) + 1 
     WHERE (id = $1 OR code = $1)
       AND is_public = true
       AND deleted_at IS NULL
     RETURNING copies_issued`,
    [quizId]
  );
  return res.rows[0]?.copies_issued || 0;
}

async function saveQuiz(exam, ownerUsername, isPublic = false) {
  const quizId = exam.id || `exam-${Date.now()}`;
  const code = exam.code || `#${Math.random().toString(16).slice(2, 6)}`;
  const now = Date.now();
  const owner = String(ownerUsername || exam.ownerUsername || 'system').toLowerCase();

  // PG Direct Transaction
  const savedQuizId = await pg.withTransaction(async (client) => {
    // 1. Tra cứu user_id của chủ sở hữu
    const uRes = await client.query(`SELECT id FROM users WHERE username_lower = $1 LIMIT 1`, [owner]);
    const ownerUserId = uRes.rows[0]?.id || null;

    // 2. Kiểm tra Ownership nếu đang cập nhật quiz đã tồn tại
    const existingRes = await client.query(
      `SELECT id, owner_id, owner_user_id FROM quizzes WHERE id = $1 LIMIT 1`,
      [quizId]
    );

    if (existingRes.rows.length > 0) {
      const ex = existingRes.rows[0];
      const isOwner = (ownerUserId && ex.owner_user_id === ownerUserId) ||
                      (ex.owner_id && ex.owner_id.toLowerCase() === owner);
      if (!isOwner) {
        throw new Error('Bạn không có quyền chỉnh sửa đề thi của người dùng khác!');
      }
    }

    // 3. Upsert Quiz
    await client.query(
      `INSERT INTO quizzes (id, code, title, description, subject, author, time_per_q, points_per_q, is_public, owner_id, owner_user_id, owner_username_snapshot, parent_code, copies_issued, shared_by, shared_at, created_at, updated_at, created_timestamp, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'active')
       ON CONFLICT (id) DO UPDATE 
       SET title = EXCLUDED.title, 
           description = EXCLUDED.description,
           subject = EXCLUDED.subject,
           author = EXCLUDED.author,
           time_per_q = EXCLUDED.time_per_q,
           points_per_q = EXCLUDED.points_per_q,
           is_public = EXCLUDED.is_public,
           parent_code = EXCLUDED.parent_code,
           updated_at = EXCLUDED.updated_at,
           status = 'active',
           deleted_at = NULL`,
      [
        quizId, code, exam.title || 'Đề thi trắc nghiệm', exam.desc || exam.description || '',
        exam.subject || '', exam.author || '', exam.timePerQ || exam.time_per_q || 15,
        exam.pointsPerQ || exam.points_per_q || 100, !!isPublic, owner, ownerUserId, owner,
        exam.parentCode || exam.parent_code || '', exam.copiesIssued || exam.copies_issued || 0,
        exam.sharedBy || exam.shared_by || '', exam.sharedAt || exam.shared_at || '',
        exam.createdAt || new Date().toISOString(), new Date().toISOString(),
        exam.createdTimestamp || now
      ]
    );

    // 4. Xóa mapping quiz_questions cũ (để cập nhật lại thứ tự)
    await client.query(`DELETE FROM quiz_questions WHERE quiz_id = $1`, [quizId]);

    // 5. Question Versioning BẤT BIẾN (Immutable question versions)
    const qs = Array.isArray(exam.questions) ? exam.questions : [];
    for (let idx = 0; idx < qs.length; idx++) {
      const q = qs[idx];
      let questionId = q.id;
      if (!questionId || questionId.startsWith('temp-')) {
        questionId = `q-${quizId}-${idx + 1}-${Date.now().toString(36)}`;
      }

      await client.query(
        `INSERT INTO questions (id, owner_id, owner_user_id, owner_username_snapshot)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET owner_user_id = COALESCE(EXCLUDED.owner_user_id, questions.owner_user_id)`,
        [questionId, owner, ownerUserId, owner]
      );

      // Tra cứu version mới nhất hiện có
      const lastVRes = await client.query(
        `SELECT id, version, content, explanation, difficulty, image_url 
         FROM question_versions 
         WHERE question_id = $1 
         ORDER BY version DESC LIMIT 1`,
        [questionId]
      );

      let targetVersionId = null;
      let targetVersion = 1;
      const currentChoices = Array.isArray(q.choices) ? q.choices : [];

      if (lastVRes.rows.length === 0) {
        // Chưa có version nào -> Tạo v1
        targetVersion = 1;
        targetVersionId = `${questionId}-v1`;
        await client.query(
          `INSERT INTO question_versions (id, question_id, version, content, explanation, difficulty, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [targetVersionId, questionId, targetVersion, q.text || '', q.explanation || '', q.difficulty || 'medium', q.image || '']
        );
        for (let cIdx = 0; cIdx < currentChoices.length; cIdx++) {
          await client.query(
            `INSERT INTO question_options (id, question_version_id, content, is_correct, order_index)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
            [`${targetVersionId}-opt-${cIdx}`, targetVersionId, String(currentChoices[cIdx]), (q.correct === cIdx), cIdx]
          );
        }
      } else {
        const lastV = lastVRes.rows[0];
        const lastOptsRes = await client.query(
          `SELECT content, is_correct, order_index FROM question_options WHERE question_version_id = $1 ORDER BY order_index ASC`,
          [lastV.id]
        );
        const lastOpts = lastOptsRes.rows;

        // So sánh xem nội dung hoặc các đáp án có thay đổi không
        let hasChanged = (lastV.content !== (q.text || '') || (lastV.explanation || '') !== (q.explanation || ''));
        if (!hasChanged && lastOpts.length !== currentChoices.length) hasChanged = true;
        if (!hasChanged) {
          for (let cIdx = 0; cIdx < currentChoices.length; cIdx++) {
            const opt = lastOpts[cIdx];
            if (!opt || opt.content !== String(currentChoices[cIdx]) || opt.is_correct !== (q.correct === cIdx)) {
              hasChanged = true;
              break;
            }
          }
        }

        if (hasChanged) {
          // BẢO ĐẢM TÍNH BẤT BIẾN: KHÔNG SỬA ĐỔI VERSION CŨ! TẠO VERSION MỚI (v2, v3,...)
          targetVersion = lastV.version + 1;
          targetVersionId = `${questionId}-v${targetVersion}`;
          await client.query(
            `INSERT INTO question_versions (id, question_id, version, content, explanation, difficulty, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [targetVersionId, questionId, targetVersion, q.text || '', q.explanation || '', q.difficulty || 'medium', q.image || '']
          );
          for (let cIdx = 0; cIdx < currentChoices.length; cIdx++) {
            await client.query(
              `INSERT INTO question_options (id, question_version_id, content, is_correct, order_index)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
              [`${targetVersionId}-opt-${cIdx}`, targetVersionId, String(currentChoices[cIdx]), (q.correct === cIdx), cIdx]
            );
          }
        } else {
          // Tái sử dụng version cũ bất biến
          targetVersionId = lastV.id;
        }
      }

      // 6. Ánh xạ quiz_questions
      await client.query(
        `INSERT INTO quiz_questions (id, quiz_id, question_version_id, order_index, points, time_limit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`qq-${quizId}-${idx + 1}`, quizId, targetVersionId, idx, exam.pointsPerQ || 100, exam.timePerQ || 15]
      );
    }

    return quizId;
  });

  return await getQuizById(savedQuizId, { includeCorrect: true, internal: true });
}

async function deleteQuiz(quizId, userOrUsername) {
  let lower = '';
  let ownerUserId = null;
  let userIsAdmin = false;

  if (userOrUsername && typeof userOrUsername === 'object') {
    lower = String(userOrUsername.username || '').toLowerCase();
    ownerUserId = userOrUsername.userId || userOrUsername.id || null;
    userIsAdmin = userOrUsername.role === 'admin';
  } else {
    lower = String(userOrUsername || '').toLowerCase();
    userIsAdmin = false;
  }

  if (!ownerUserId && lower) {
    const uRes = await pg.query(`SELECT id FROM users WHERE username_lower = $1 LIMIT 1`, [lower]);
    ownerUserId = uRes.rows[0]?.id || null;
  }

  // SOFT DELETE: Giữ nguyên lịch sử attempts, chỉ ẩn khỏi UI
  const res = await pg.query(
    `UPDATE quizzes 
     SET deleted_at = NOW(), status = 'archived' 
     WHERE id = $1 
       AND (owner_user_id = $2 OR LOWER(owner_id) = $3 OR LOWER(shared_by) = $3 OR $4 = true)
     RETURNING id`,
    [quizId, ownerUserId, lower, userIsAdmin]
  );
  return res.rowCount > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. ATTEMPTS & ANSWERS
// ═══════════════════════════════════════════════════════════════════════════

async function getUserAttempts(username) {
  const lower = String(username || '').toLowerCase();
  if (useSupabase()) {
    try {
      const { data, error } = await supabase
        .from('attempts')
        .select('*')
        .eq('user_id', lower)
        .order('created_at', { ascending: false });

      if (error || !data) return [];
      const out = [];
      for (const a of data) {
        const { data: ansList } = await supabase
          .from('attempt_answers')
          .select('*')
          .eq('attempt_id', a.id)
          .order('question_index', { ascending: true });

        out.push({
          id: a.id,
          pin: a.pin || '',
          roomTitle: a.room_title || '',
          examTitle: a.exam_title || '',
          score: a.score,
          correctCount: a.correct_count,
          totalQuestions: a.total_questions,
          ratioPct: a.ratio_pct,
          formattedTime: a.formatted_time,
          createdAt: Number(a.created_at),
          answersDetail: (ansList || []).map(ans => ({
            questionIndex: ans.question_index,
            userChoice: ans.user_choice,
            isCorrect: ans.is_correct,
            earned: ans.score_awarded,
            responseTimeMs: ans.response_time_ms,
            streak: ans.streak_after,
          }))
        });
      }
      return out;
    } catch (e) { return []; }
  }

  // PG Fallback
  const res = await pg.query(`SELECT * FROM attempts WHERE LOWER(user_id) = $1 ORDER BY created_at DESC`, [lower]);
  const out = [];
  for (const a of res.rows) {
    const ansRes = await pg.query(`SELECT * FROM attempt_answers WHERE attempt_id = $1 ORDER BY question_index ASC`, [a.id]);
    out.push({
      id: a.id,
      pin: a.pin || '',
      roomTitle: a.room_title || '',
      examTitle: a.exam_title || '',
      score: a.score,
      correctCount: a.correct_count,
      totalQuestions: a.total_questions,
      ratioPct: a.ratio_pct,
      formattedTime: a.formatted_time,
      createdAt: Number(a.created_at),
      answersDetail: ansRes.rows.map(ans => ({
        questionIndex: ans.question_index,
        userChoice: ans.user_choice,
        isCorrect: ans.is_correct,
        earned: ans.score_awarded,
        responseTimeMs: ans.response_time_ms,
        streak: ans.streak_after,
      }))
    });
  }
  return out;
}

async function saveAttempt(record) {
  const attemptId = record.id || `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = record.createdAt || record.finishedAt || Date.now();
  const user = String(record.username || record.userId || 'guest').toLowerCase();

  return await pg.withTransaction(async (client) => {
    const uRes = await client.query(`SELECT id FROM users WHERE username_lower = $1 LIMIT 1`, [user]);
    const accountUserId = Object.prototype.hasOwnProperty.call(record, 'accountUserId')
      ? record.accountUserId : (uRes.rows[0]?.id || null);

    await client.query(
      `INSERT INTO attempts (id, user_id, account_user_id, username_snapshot, quiz_id, game_session_id, pin, room_title, exam_title, score, max_score, correct_count, total_questions, ratio_pct, formatted_time, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE SET 
         score = EXCLUDED.score, 
         max_score = EXCLUDED.max_score,
         correct_count = EXCLUDED.correct_count,
         total_questions = EXCLUDED.total_questions,
         ratio_pct = EXCLUDED.ratio_pct,
         formatted_time = EXCLUDED.formatted_time`,
      [
        attemptId, user, accountUserId, user,
        record.quizId || null, record.gameSessionId || null,
        record.pin || '', record.roomTitle || '', record.examTitle || record.roomTitle || '',
        record.score || 0, record.maxScore || ((record.totalQuestions || 0) * 100),
        record.correctCount || 0, record.totalQuestions || 0, record.ratioPct || 0,
        record.formattedTime || new Date(now).toLocaleString('vi-VN'), now
      ]
    );

    const answers = record.answersDetail || record.details || [];
    for (let i = 0; i < answers.length; i++) {
      const ans = answers[i];
      const qIdx = ans.questionIndex !== undefined ? ans.questionIndex : i;
      let optionId = ans.selectedOptionId || null;

      // Validate option thuộc đúng question_version nếu có
      if (optionId && ans.questionVersionId) {
        const optCheck = await client.query(
          `SELECT id FROM question_options WHERE id = $1 AND question_version_id = $2 LIMIT 1`,
          [optionId, ans.questionVersionId]
        );
        if (optCheck.rows.length === 0) {
          optionId = null;
        }
      }

      await client.query(
        `INSERT INTO attempt_answers (attempt_id, question_index, question_version_id, selected_option_id, user_choice, is_correct, response_time_ms, score_awarded, streak_before, streak_after, answered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (attempt_id, question_index) DO NOTHING`,
        [
          attemptId, qIdx, ans.questionVersionId || null, optionId,
          ans.userChoice !== undefined ? ans.userChoice : -1,
          !!ans.isCorrect, ans.responseTimeMs || 0, ans.earned || ans.scoreAwarded || 0,
          ans.streakBefore || 0, ans.streakAfter || ans.streak || 0, now
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

  return await pg.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO game_sessions (id, host_id, room_code, room_title, status, capacity, total_players, started_at, ended_at, formatted_time, stats, created_at)
       VALUES ($1, $2, $3, $4, 'finished', $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET ended_at = EXCLUDED.ended_at, stats = EXCLUDED.stats`,
      [sessionId, host, sessionRecord.pin || '', sessionRecord.roomTitle || 'Phòng thi trực tuyến', sessionRecord.capacity || 40, candidates.length, sessionRecord.createdAt || (now - 60000), now, sessionRecord.formattedTime || new Date(now).toLocaleString('vi-VN'), JSON.stringify(stats), sessionRecord.createdAt || now]
    );
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      await client.query(
        `INSERT INTO game_players (id, game_session_id, nickname, avatar, final_score, rank,
          correct_count, wrong_count, joined_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET final_score = EXCLUDED.final_score,
           rank = EXCLUDED.rank, correct_count = EXCLUDED.correct_count,
           wrong_count = EXCLUDED.wrong_count, finished_at = EXCLUDED.finished_at`,
        [`gp-${crypto.createHash('sha256').update(sessionId + ':' + (c.id || i)).digest('hex')}`, sessionId, c.nick || 'Player', c.av || '01',
          c.score || 0, i + 1, c.correctCount || 0,
          (c.totalQuestions || 0) - (c.correctCount || 0), sessionRecord.createdAt || now, now]
      );
    }
    return { id: sessionId, ...sessionRecord };
  });
}

async function getHostedGameSessions(hostUsername) {
  const host = String(hostUsername || '').toLowerCase();
  if (useSupabase()) {
    try {
      const { data, error } = await supabase
        .from('game_sessions')
        .select('*')
        .eq('host_id', host)
        .order('ended_at', { ascending: false })
        .limit(20);

      if (error || !data) return [];
      return data.map(row => ({
        id: row.id,
        pin: row.room_code,
        roomTitle: row.room_title,
        createdAt: Number(row.created_at),
        finishedAt: Number(row.ended_at || row.created_at),
        formattedTime: row.formatted_time,
        stats: row.stats || {},
      }));
    } catch (e) { return []; }
  }

  // PG Fallback
  const res = await pg.query(`SELECT * FROM game_sessions WHERE LOWER(host_id) = $1 ORDER BY ended_at DESC LIMIT 20`, [host]);
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

async function formatQuizWithQuestionsPG(quizRow, includeCorrect = true) {
  if (!quizRow) return null;
  const res = await pg.query(
    `SELECT qq.order_index, qq.points, qq.time_limit,
            qv.id as version_id, qv.question_id, qv.version, qv.content, qv.explanation, qv.difficulty, qv.image_url
     FROM quiz_questions qq
     JOIN question_versions qv ON qv.id = qq.question_version_id
     WHERE qq.quiz_id = $1 ORDER BY qq.order_index ASC`,
    [quizRow.id]
  );
  const questions = [];
  for (const qRow of res.rows) {
    const optRes = await pg.query(
      `SELECT id, content, is_correct, order_index FROM question_options WHERE question_version_id = $1 ORDER BY order_index ASC`,
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
      explanation: includeCorrect ? (qRow.explanation || '') : '',
      difficulty: qRow.difficulty || 'medium',
      image: qRow.image_url || '',
      points: qRow.points || 100,
      timeLimit: qRow.time_limit || 15,
    };
    if (includeCorrect) qObj.correct = correctIndex;
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

module.exports = {
  supabase,
  useSupabase,
  findUserByUsername,
  createUser,
  updateUser,
  saveSession,
  getSession,
  deleteSession,
  deleteOtherSessions,
  getPublicQuizzes,
  getPrivateQuizzes,
  getQuizById,
  getPublicQuizById,
  incrementQuizCopiesIssued,
  saveQuiz,
  deleteQuiz,
  getUserAttempts,
  saveAttempt,
  saveHostedGameSession,
  getHostedGameSessions,
};
