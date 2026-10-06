const fs = require('fs');
const path = require('path');
const { getPool, withTransaction, query } = require('./pool.js');

let supabase = null;
try {
  supabase = require('./supabase.js');
} catch (e) {}

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_EXAMS_FILE = path.join(DATA_DIR, 'public', 'exams.json');
const PRIVATE_DIR = path.join(DATA_DIR, 'private');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const AUTH_USERS_FILE = path.join(DATA_DIR, 'auth', 'users.json');

async function runMigration() {
  console.log('🚀 [Migration] Bắt đầu kiểm tra và cập nhật cấu trúc database...');

  // 1. Áp dụng schema SQL
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await query(schemaSql);
  }

  // 2. Di trú Users & Profiles
  await migrateUsersAndProfiles();

  // 3. Di trú Quizzes & Questions & Options & Versions
  await migrateQuizzesAndQuestions();

  // 4. Di trú Lịch sử làm bài (Attempts & Attempt Answers)
  await migrateAttempts();

  // 5. Di trú Phòng thi đã tổ chức (Game Sessions & Players)
  await migrateGameSessions();

  console.log('✅ [Migration] Hoàn tất quá trình nâng cấp và di trú dữ liệu!');
}

async function migrateUsersAndProfiles() {
  const usersToImport = [];

  // Lấy từ Supabase nếu có
  if (supabase && supabase.isConfigured()) {
    try {
      const { data } = await supabase.client.from('users').select('*');
      if (Array.isArray(data)) {
        data.forEach(u => usersToImport.push({
          username: u.username,
          username_lower: u.username_lower || u.username.toLowerCase(),
          display_name: u.display_name,
          password_hash: u.password_hash,
          salt: u.salt,
          created_at: Number(u.created_at || Date.now()),
          last_name_change_at: Number(u.last_name_change_at || 0),
          last_password_change_at: Number(u.last_password_change_at || 0),
        }));
      }
    } catch (e) {
      console.warn('[Migration] Không thể lấy users từ Supabase:', e.message);
    }
  }

  // Lấy thêm từ local file nếu có
  if (fs.existsSync(AUTH_USERS_FILE)) {
    try {
      const localUsers = JSON.parse(fs.readFileSync(AUTH_USERS_FILE, 'utf8') || '[]');
      if (Array.isArray(localUsers)) {
        localUsers.forEach(u => {
          if (!usersToImport.find(x => x.username_lower === u.usernameLower)) {
            usersToImport.push({
              username: u.username,
              username_lower: u.usernameLower || u.username.toLowerCase(),
              display_name: u.displayName,
              password_hash: u.passwordHash,
              salt: u.salt,
              created_at: Number(u.createdAt || Date.now()),
              last_name_change_at: Number(u.lastNameChangeAt || 0),
              last_password_change_at: Number(u.lastPasswordChangeAt || 0),
            });
          }
        });
      }
    } catch (e) {}
  }

  for (const u of usersToImport) {
    try {
      const res = await query(
        `INSERT INTO users (username, username_lower, display_name, password_hash, salt, created_at, last_name_change_at, last_password_change_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (username_lower) DO UPDATE 
         SET display_name = EXCLUDED.display_name,
             password_hash = EXCLUDED.password_hash,
             salt = EXCLUDED.salt
         RETURNING id`,
        [u.username, u.username_lower, u.display_name, u.password_hash, u.salt, u.created_at, u.last_name_change_at, u.last_password_change_at]
      );

      const userId = res.rows[0].id;
      // Đảm bảo bảng profiles có record tương ứng
      await query(
        `INSERT INTO profiles (user_id, username, display_name, role)
         VALUES ($1, $2, $3, 'teacher')
         ON CONFLICT DO NOTHING`,
        [userId, u.username, u.display_name]
      );
    } catch (err) {
      console.error('[Migration] Lỗi insert user:', u.username, err.message);
    }
  }
}

async function migrateQuizzesAndQuestions() {
  const existingQuizzesRes = await query(`SELECT COUNT(*) FROM quizzes`);
  const count = parseInt(existingQuizzesRes.rows[0].count, 10);
  if (count > 0) {
    // Đã có dữ liệu quizzes, kiểm tra xem có cần bổ sung đề mẫu không
    return;
  }

  console.log('[Migration] Bắt đầu nạp danh sách đề thi vào cấu trúc Quizzes & Questions mới...');
  const examsToImport = [];

  // Lấy từ Supabase exams
  if (supabase && supabase.isConfigured()) {
    try {
      const { data } = await supabase.client.from('exams').select('*');
      if (Array.isArray(data)) {
        data.forEach(r => examsToImport.push({
          id: r.id,
          code: r.code,
          title: r.title,
          subject: r.subject || '',
          author: r.author || '',
          timePerQ: r.time_per_q || 15,
          pointsPerQ: r.points_per_q || 100,
          desc: r.description || '',
          questions: typeof r.questions === 'string' ? JSON.parse(r.questions) : (r.questions || []),
          isPublic: !!r.is_public,
          owner: r.owner_username || 'system',
          parentCode: r.parent_code || '',
          copiesIssued: r.copies_issued || 0,
          sharedBy: r.shared_by || '',
          sharedAt: r.shared_at || '',
          createdAt: r.created_at || '',
          updatedAt: r.updated_at || '',
          createdTimestamp: Number(r.created_timestamp || Date.now()),
        }));
      }
    } catch (e) {
      console.warn('[Migration] Không thể lấy exams từ Supabase:', e.message);
    }
  }

  // Lấy thêm từ data/public/exams.json
  if (fs.existsSync(PUBLIC_EXAMS_FILE)) {
    try {
      const publicExams = JSON.parse(fs.readFileSync(PUBLIC_EXAMS_FILE, 'utf8') || '[]');
      if (Array.isArray(publicExams)) {
        publicExams.forEach(e => {
          if (!examsToImport.find(x => x.id === e.id)) {
            examsToImport.push({
              id: e.id,
              code: e.code,
              title: e.title,
              subject: e.subject || '',
              author: e.author || '',
              timePerQ: e.timePerQ || 15,
              pointsPerQ: e.pointsPerQ || 100,
              desc: e.desc || e.description || '',
              questions: e.questions || [],
              isPublic: true,
              owner: 'system',
              parentCode: e.parentCode || '',
              copiesIssued: e.copiesIssued || 0,
              sharedBy: e.sharedBy || '',
              sharedAt: e.sharedAt || '',
              createdAt: e.createdAt || '',
              updatedAt: e.updatedAt || '',
              createdTimestamp: Date.now(),
            });
          }
        });
      }
    } catch (e) {}
  }

  // Lấy thêm từ data/private/*.json
  if (fs.existsSync(PRIVATE_DIR)) {
    try {
      const files = fs.readdirSync(PRIVATE_DIR);
      files.forEach(f => {
        if (f.endsWith('.json')) {
          try {
            const owner = f.replace('.json', '');
            const privExams = JSON.parse(fs.readFileSync(path.join(PRIVATE_DIR, f), 'utf8') || '[]');
            if (Array.isArray(privExams)) {
              privExams.forEach(e => {
                if (!examsToImport.find(x => x.id === e.id)) {
                  examsToImport.push({
                    id: e.id,
                    code: e.code,
                    title: e.title,
                    subject: e.subject || '',
                    author: e.author || '',
                    timePerQ: e.timePerQ || 15,
                    pointsPerQ: e.pointsPerQ || 100,
                    desc: e.desc || e.description || '',
                    questions: e.questions || [],
                    isPublic: false,
                    owner: owner,
                    parentCode: e.parentCode || '',
                    copiesIssued: e.copiesIssued || 0,
                    sharedBy: e.sharedBy || '',
                    sharedAt: e.sharedAt || '',
                    createdAt: e.createdAt || '',
                    updatedAt: e.updatedAt || '',
                    createdTimestamp: Date.now(),
                  });
                }
              });
            }
          } catch (err) {}
        }
      });
    } catch (e) {}
  }

  // Lưu từng đề thi theo chuẩn mới: Quizzes -> Questions -> Question_Versions -> Question_Options -> Quiz_Questions
  for (const ex of examsToImport) {
    try {
      await withTransaction(async (client) => {
        // 1. Insert Quiz
        await client.query(
          `INSERT INTO quizzes (id, code, title, description, subject, author, time_per_q, points_per_q, is_public, owner_id, parent_code, copies_issued, shared_by, shared_at, created_at, updated_at, created_timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             subject = EXCLUDED.subject,
             is_public = EXCLUDED.is_public`,
          [
            ex.id,
            ex.code,
            ex.title,
            ex.desc,
            ex.subject,
            ex.author,
            ex.timePerQ,
            ex.pointsPerQ,
            ex.isPublic,
            ex.owner,
            ex.parentCode,
            ex.copiesIssued,
            ex.sharedBy,
            ex.sharedAt,
            ex.createdAt,
            ex.updatedAt,
            ex.createdTimestamp
          ]
        );

        // 2. Xóa các quiz_questions cũ nếu có để re-map sạch sẽ
        await client.query(`DELETE FROM quiz_questions WHERE quiz_id = $1`, [ex.id]);

        // 3. Tách từng câu hỏi vào Question Bank
        const qs = Array.isArray(ex.questions) ? ex.questions : [];
        for (let idx = 0; idx < qs.length; idx++) {
          const q = qs[idx];
          const questionId = q.id || `q-${ex.id}-${idx + 1}`;
          const version = 1;
          const versionId = `${questionId}-v${version}`;

          // Insert questions
          await client.query(
            `INSERT INTO questions (id, owner_id)
             VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [questionId, ex.owner]
          );

          // Insert question_versions
          await client.query(
            `INSERT INTO question_versions (id, question_id, version, content, explanation, difficulty, image_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO NOTHING`,
            [versionId, questionId, version, q.text || '', q.explanation || '', q.difficulty || 'medium', q.image || '']
          );

          // Insert options
          await client.query(`DELETE FROM question_options WHERE question_version_id = $1`, [versionId]);
          const choices = Array.isArray(q.choices) ? q.choices : [];
          for (let cIdx = 0; cIdx < choices.length; cIdx++) {
            const optId = `${versionId}-opt-${cIdx}`;
            const isCorrect = (q.correct === cIdx);
            await client.query(
              `INSERT INTO question_options (id, question_version_id, content, is_correct, order_index)
               VALUES ($1, $2, $3, $4, $5)`,
              [optId, versionId, String(choices[cIdx]), isCorrect, cIdx]
            );
          }

          // Link Quiz <-> Question Version
          const qqId = `qq-${ex.id}-${idx + 1}`;
          await client.query(
            `INSERT INTO quiz_questions (id, quiz_id, question_version_id, order_index, points, time_limit)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (quiz_id, order_index) DO UPDATE
             SET question_version_id = EXCLUDED.question_version_id`,
            [qqId, ex.id, versionId, idx, ex.pointsPerQ || 100, ex.timePerQ || 15]
          );
        }
      });
    } catch (err) {
      console.error('[Migration] Lỗi migrate quiz:', ex.id, err.message);
    }
  }
  console.log(`[Migration] Đã di trú xong ${examsToImport.length} đề thi sang mô hình chuẩn hóa!`);
}

async function migrateAttempts() {
  const existingAttemptsRes = await query(`SELECT COUNT(*) FROM attempts`);
  if (parseInt(existingAttemptsRes.rows[0].count, 10) > 0) return;

  console.log('[Migration] Bắt đầu nạp lịch sử làm bài (Attempts & Answers)...');
  const attemptsToImport = [];

  // Lấy từ Supabase user_history
  if (supabase && supabase.isConfigured()) {
    try {
      const { data } = await supabase.client.from('user_history').select('*');
      if (Array.isArray(data)) {
        data.forEach(r => attemptsToImport.push({
          id: r.id,
          username: r.username,
          pin: r.pin || '',
          roomTitle: r.room_title || '',
          examTitle: r.exam_title || '',
          score: r.score || 0,
          correctCount: r.correct_count || 0,
          totalQuestions: r.total_questions || 0,
          ratioPct: r.ratio_pct || 0,
          formattedTime: r.formatted_time || '',
          createdAt: Number(r.created_at || Date.now()),
          answersDetail: typeof r.answers_detail === 'string' ? JSON.parse(r.answers_detail) : (r.answers_detail || [])
        }));
      }
    } catch (e) {}
  }

  // Lấy thêm từ data/history/user_*/history.json
  if (fs.existsSync(HISTORY_DIR)) {
    try {
      const dirs = fs.readdirSync(HISTORY_DIR);
      dirs.forEach(d => {
        if (d.startsWith('user_')) {
          const userFile = path.join(HISTORY_DIR, d, 'history.json');
          if (fs.existsSync(userFile)) {
            try {
              const list = JSON.parse(fs.readFileSync(userFile, 'utf8') || '[]');
              if (Array.isArray(list)) {
                const uname = d.replace('user_', '');
                list.forEach(item => {
                  if (!attemptsToImport.find(x => x.id === item.id)) {
                    attemptsToImport.push({
                      id: item.id,
                      username: uname,
                      pin: item.pin || '',
                      roomTitle: item.roomTitle || '',
                      examTitle: item.examTitle || '',
                      score: item.score || 0,
                      correctCount: item.correctCount || 0,
                      totalQuestions: item.totalQuestions || 0,
                      ratioPct: item.ratioPct || 0,
                      formattedTime: item.formattedTime || '',
                      createdAt: Number(item.createdAt || Date.now()),
                      answersDetail: item.answersDetail || []
                    });
                  }
                });
              }
            } catch (err) {}
          }
        }
      });
    } catch (e) {}
  }

  for (const a of attemptsToImport) {
    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO attempts (id, user_id, pin, room_title, exam_title, score, correct_count, total_questions, ratio_pct, formatted_time, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [a.id, a.username, a.pin, a.roomTitle, a.examTitle, a.score, a.correctCount, a.totalQuestions, a.ratioPct, a.formattedTime, a.createdAt]
        );

        if (Array.isArray(a.answersDetail)) {
          for (let i = 0; i < a.answersDetail.length; i++) {
            const ans = a.answersDetail[i];
            await client.query(
              `INSERT INTO attempt_answers (attempt_id, question_index, user_choice, is_correct, score_awarded)
               VALUES ($1, $2, $3, $4, $5)`,
              [a.id, ans.questionIndex !== undefined ? ans.questionIndex : i, ans.userChoice !== undefined ? ans.userChoice : -1, !!ans.isCorrect, Number(ans.earned || 0)]
            );
          }
        }
      });
    } catch (err) {
      console.error('[Migration] Lỗi migrate attempt:', a.id, err.message);
    }
  }
}

async function migrateGameSessions() {
  const existingRoomsRes = await query(`SELECT COUNT(*) FROM game_sessions`);
  if (parseInt(existingRoomsRes.rows[0].count, 10) > 0) return;

  console.log('[Migration] Bắt đầu nạp danh sách phòng thi đã tổ chức (Game Sessions)...');
  const roomsToImport = [];

  if (supabase && supabase.isConfigured()) {
    try {
      const { data } = await supabase.client.from('hosted_rooms').select('*');
      if (Array.isArray(data)) {
        data.forEach(r => roomsToImport.push({
          id: r.id,
          pin: r.pin,
          hostUsername: r.host_username,
          roomTitle: r.room_title,
          createdAt: Number(r.created_at || Date.now()),
          finishedAt: Number(r.finished_at || Date.now()),
          formattedTime: r.formatted_time || '',
          stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : (r.stats || {})
        }));
      }
    } catch (e) {}
  }

  for (const r of roomsToImport) {
    try {
      await withTransaction(async (client) => {
        const candidates = (r.stats && r.stats.candidatesMatrix) || [];
        await client.query(
          `INSERT INTO game_sessions (id, host_id, room_code, room_title, status, total_players, started_at, ended_at, formatted_time, stats, created_at)
           VALUES ($1, $2, $3, $4, 'finished', $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.hostUsername, r.pin, r.roomTitle, candidates.length, r.createdAt, r.finishedAt, r.formattedTime, JSON.stringify(r.stats), r.createdAt]
        );

        for (const c of candidates) {
          const playerId = c.id || `p-${r.id}-${Math.random().toString(36).slice(2, 6)}`;
          await client.query(
            `INSERT INTO game_players (id, game_session_id, nickname, avatar, final_score, correct_count, wrong_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO NOTHING`,
            [playerId, r.id, c.nick || 'Thí sinh', c.av || '01', c.score || 0, c.correctCount || 0, (c.totalQuestions || 0) - (c.correctCount || 0)]
          );
        }
      });
    } catch (err) {
      console.error('[Migration] Lỗi migrate game session:', r.id, err.message);
    }
  }
}

module.exports = {
  runMigration,
};
