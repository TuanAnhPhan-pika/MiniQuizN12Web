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
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigration() {
  console.log('🚀 [Migration System] Bắt đầu kiểm tra và thực thi migrations...');

  // 1. Tạo bảng theo dõi migration nếu chưa có
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // 2. Đọc danh sách migration đã chạy
  const appliedRes = await query(`SELECT id FROM schema_migrations ORDER BY id ASC`);
  const appliedSet = new Set(appliedRes.rows.map(r => r.id));

  // 3. Quét thư mục migrations và chạy các file chưa được áp dụng
  if (fs.existsSync(MIGRATIONS_DIR)) {
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (!appliedSet.has(file)) {
        console.log(`📦 [Migration] Đang áp dụng migration: ${file}...`);
        const sqlPath = path.join(MIGRATIONS_DIR, file);
        const sqlContent = fs.readFileSync(sqlPath, 'utf8');

        await withTransaction(async (client) => {
          await client.query(sqlContent);
          await client.query(
            `INSERT INTO schema_migrations (id, applied_at) VALUES ($1, NOW())`,
            [file]
          );
        });
        console.log(`✅ [Migration] Đã áp dụng thành công: ${file}`);
        appliedSet.add(file);
      }
    }
  }

  // 4. Legacy Data Import: CHỈ chạy một lần duy nhất nếu database hoàn toàn trống
  // Kiểm tra nếu bảng quizzes chưa có bản ghi nào thì mới import dữ liệu ban đầu
  const countRes = await query(`SELECT COUNT(*) as count FROM quizzes`);
  const quizCount = parseInt(countRes.rows[0]?.count || '0', 10);

  if (quizCount === 0 || process.env.RUN_LEGACY_IMPORT === '1') {
    console.log('📥 [Migration] Phát hiện Database trống hoặc cờ RUN_LEGACY_IMPORT=1, tiến hành nạp dữ liệu ban đầu...');
    await migrateUsersAndProfiles();
    await migrateQuizzesAndQuestions();
    await migrateAttempts();
    await migrateGameSessions();
    console.log('✅ [Migration] Đã nạp xong dữ liệu ban đầu!');
  } else {
    console.log(`⚡ [Migration] Database đã có ${quizCount} đề thi, bỏ qua bước import legacy để tăng tốc khởi động.`);
  }

  console.log('🎉 [Migration System] Hệ thống cơ sở dữ liệu đã sẵn sàng!');
}

async function migrateUsersAndProfiles() {
  const usersToImport = [];

  if (supabase && supabase.isConfigured && supabase.isConfigured()) {
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
      await query(
        `INSERT INTO profiles (user_id, username, display_name, role)
         VALUES ($1, $2, $3, 'teacher')
         ON CONFLICT (username) DO NOTHING`,
        [userId, u.username, u.display_name]
      );
    } catch (e) {
      console.error('[Migration] Lỗi import user:', u.username, e.message);
    }
  }
}

async function migrateQuizzesAndQuestions() {
  const quizzesToImport = [];

  if (supabase && supabase.isConfigured && supabase.isConfigured()) {
    try {
      const { data } = await supabase.client.from('quizzes').select('*');
      if (Array.isArray(data)) {
        quizzesToImport.push(...data);
      }
    } catch (e) {
      console.warn('[Migration] Không thể lấy quizzes từ Supabase:', e.message);
    }
  }

  if (fs.existsSync(PUBLIC_EXAMS_FILE)) {
    try {
      const publicExams = JSON.parse(fs.readFileSync(PUBLIC_EXAMS_FILE, 'utf8') || '[]');
      if (Array.isArray(publicExams)) {
        publicExams.forEach(pe => {
          if (!quizzesToImport.find(x => x.id === pe.id || x.code === pe.code)) {
            quizzesToImport.push({ ...pe, is_public: true, owner_id: 'system' });
          }
        });
      }
    } catch (e) {}
  }

  if (fs.existsSync(PRIVATE_DIR)) {
    try {
      const userFolders = fs.readdirSync(PRIVATE_DIR);
      for (const uName of userFolders) {
        const uPath = path.join(PRIVATE_DIR, uName);
        if (fs.statSync(uPath).isDirectory()) {
          const files = fs.readdirSync(uPath).filter(f => f.endsWith('.json'));
          for (const f of files) {
            try {
              const ex = JSON.parse(fs.readFileSync(path.join(uPath, f), 'utf8'));
              if (ex && ex.id && !quizzesToImport.find(x => x.id === ex.id)) {
                quizzesToImport.push({ ...ex, is_public: false, owner_id: uName.toLowerCase() });
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  for (const q of quizzesToImport) {
    try {
      const quizId = q.id || `exam-${Date.now()}`;
      const code = q.code || `#${Math.random().toString(16).slice(2, 6)}`;
      const now = Date.now();
      const owner = (q.owner_id || q.ownerUsername || 'system').toLowerCase();

      // Tra cứu owner_user_id
      const uRes = await query(`SELECT id FROM users WHERE username_lower = $1 LIMIT 1`, [owner]);
      const ownerUserId = uRes.rows[0]?.id || null;

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO quizzes (id, code, title, description, subject, author, time_per_q, points_per_q, is_public, owner_id, owner_user_id, owner_username_snapshot, parent_code, copies_issued, shared_by, shared_at, created_at, updated_at, created_timestamp, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'active')
           ON CONFLICT (id) DO UPDATE 
           SET title = EXCLUDED.title,
               is_public = EXCLUDED.is_public,
               owner_user_id = COALESCE(EXCLUDED.owner_user_id, quizzes.owner_user_id)`,
          [
            quizId, code, q.title || 'Đề thi', q.desc || q.description || '',
            q.subject || '', q.author || '', q.timePerQ || q.time_per_q || 15,
            q.pointsPerQ || q.points_per_q || 100, !!q.is_public, owner,
            ownerUserId, owner,
            q.parentCode || q.parent_code || '', q.copiesIssued || q.copies_issued || 0,
            q.sharedBy || q.shared_by || '', q.sharedAt || q.shared_at || '',
            q.createdAt || q.created_at || new Date().toISOString(),
            q.updatedAt || q.updated_at || new Date().toISOString(),
            Number(q.createdTimestamp || q.created_timestamp || now)
          ]
        );

        const questions = Array.isArray(q.questions) ? q.questions : [];
        for (let idx = 0; idx < questions.length; idx++) {
          const quest = questions[idx];
          const questionId = quest.id || `q-${quizId}-${idx + 1}`;
          const versionId = quest.versionId || `${questionId}-v1`;

          await client.query(
            `INSERT INTO questions (id, owner_id, owner_user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET owner_user_id = COALESCE(EXCLUDED.owner_user_id, questions.owner_user_id)`,
            [questionId, owner, ownerUserId]
          );

          await client.query(
            `INSERT INTO question_versions (id, question_id, version, content, explanation, difficulty, image_url)
             VALUES ($1, $2, 1, $3, $4, 'medium', $5)
             ON CONFLICT (id) DO NOTHING`,
            [versionId, questionId, quest.text || '', quest.explanation || '', quest.image || '']
          );

          const choices = Array.isArray(quest.choices) ? quest.choices : [];
          for (let cIdx = 0; cIdx < choices.length; cIdx++) {
            await client.query(
              `INSERT INTO question_options (id, question_version_id, content, is_correct, order_index)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (id) DO NOTHING`,
              [`${versionId}-opt-${cIdx}`, versionId, String(choices[cIdx]), (quest.correct === cIdx), cIdx]
            );
          }

          await client.query(
            `INSERT INTO quiz_questions (id, quiz_id, question_version_id, order_index, points, time_limit)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (quiz_id, order_index) DO NOTHING`,
            [`qq-${quizId}-${idx + 1}`, quizId, versionId, idx, quest.points || 100, quest.timeLimit || 15]
          );
        }
      });
    } catch (e) {
      console.error('[Migration] Lỗi migrate quiz:', q.title, e.message);
    }
  }
}

async function migrateAttempts() {
  if (!fs.existsSync(HISTORY_DIR)) return;
  try {
    const userFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    for (const file of userFiles) {
      const username = file.replace('.json', '').toLowerCase();
      const uRes = await query(`SELECT id FROM users WHERE username_lower = $1 LIMIT 1`, [username]);
      const accountUserId = uRes.rows[0]?.id || null;

      const attemptsList = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8') || '[]');
      if (Array.isArray(attemptsList)) {
        for (const a of attemptsList) {
          try {
            const attemptId = a.id || `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await query(
              `INSERT INTO attempts (id, user_id, account_user_id, username_snapshot, pin, room_title, exam_title, score, max_score, correct_count, total_questions, ratio_pct, formatted_time, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
               ON CONFLICT (id) DO UPDATE SET account_user_id = COALESCE(EXCLUDED.account_user_id, attempts.account_user_id)`,
              [
                attemptId, username, accountUserId, username, a.pin || '', a.roomTitle || '',
                a.examTitle || '', a.score || 0, a.maxScore || 0, a.correctCount || 0,
                a.totalQuestions || 0, a.ratioPct || 0, a.formattedTime || '',
                Number(a.createdAt || Date.now())
              ]
            );
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
}

async function migrateGameSessions() {
  // Hoàn tất
}

module.exports = {
  runMigration,
};
