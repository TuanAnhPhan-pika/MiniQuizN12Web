const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
  CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    username_lower TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_name_change_at INTEGER DEFAULT 0,
    last_password_change_at INTEGER DEFAULT 0
  );

  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar TEXT DEFAULT '01',
    bio TEXT DEFAULT '',
    role TEXT DEFAULT 'teacher',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE user_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    code TEXT UNIQUE,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE quizzes (
    id TEXT PRIMARY KEY,
    code TEXT,
    title TEXT,
    description TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    author TEXT DEFAULT '',
    time_per_q INTEGER DEFAULT 15,
    points_per_q INTEGER DEFAULT 100,
    is_public INTEGER DEFAULT 0,
    owner_id TEXT DEFAULT '',
    owner_user_id INTEGER,
    owner_username_snapshot TEXT,
    parent_code TEXT DEFAULT '',
    copies_issued INTEGER DEFAULT 0,
    shared_by TEXT DEFAULT '',
    shared_at TEXT DEFAULT '',
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    created_timestamp INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    deleted_at TEXT
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    owner_id TEXT DEFAULT 'system',
    owner_user_id INTEGER,
    owner_username_snapshot TEXT,
    subject_id INTEGER,
    topic_id INTEGER,
    status TEXT DEFAULT 'active',
    deleted_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE question_versions (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT,
    explanation TEXT DEFAULT '',
    difficulty TEXT DEFAULT 'medium',
    image_url TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(question_id, version)
  );

  CREATE TABLE question_options (
    id TEXT PRIMARY KEY,
    question_version_id TEXT NOT NULL,
    content TEXT,
    is_correct INTEGER DEFAULT 0,
    order_index INTEGER DEFAULT 0
  );

  CREATE TABLE quiz_questions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL,
    question_version_id TEXT NOT NULL,
    order_index INTEGER DEFAULT 0,
    points INTEGER DEFAULT 100,
    time_limit INTEGER DEFAULT 15,
    UNIQUE(quiz_id, order_index)
  );

  CREATE TABLE game_sessions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT,
    host_id TEXT,
    host_user_id INTEGER,
    host_username_snapshot TEXT,
    room_code TEXT,
    room_title TEXT,
    status TEXT DEFAULT 'waiting',
    capacity INTEGER DEFAULT 40,
    is_locked INTEGER DEFAULT 0,
    total_players INTEGER DEFAULT 0,
    started_at INTEGER,
    ended_at INTEGER,
    formatted_time TEXT DEFAULT '',
    stats TEXT DEFAULT '{}',
    deleted_at TEXT,
    created_at INTEGER
  );

  CREATE TABLE game_players (
    id TEXT PRIMARY KEY,
    game_session_id TEXT,
    user_id TEXT,
    account_user_id INTEGER,
    username_snapshot TEXT,
    nickname TEXT,
    avatar TEXT DEFAULT '01',
    final_score INTEGER DEFAULT 0,
    rank INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    wrong_count INTEGER DEFAULT 0,
    joined_at INTEGER,
    finished_at INTEGER
  );

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    account_user_id INTEGER,
    username_snapshot TEXT,
    username TEXT,
    quiz_id TEXT,
    quiz_title TEXT,
    game_session_id TEXT,
    pin TEXT DEFAULT '',
    room_title TEXT DEFAULT '',
    exam_title TEXT DEFAULT '',
    score INTEGER DEFAULT 0,
    max_score INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    wrong_count INTEGER DEFAULT 0,
    unanswered_count INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 0,
    ratio_pct INTEGER DEFAULT 0,
    total_time_ms INTEGER DEFAULT 0,
    mode TEXT,
    formatted_time TEXT DEFAULT '',
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER,
    rank INTEGER DEFAULT 1,
    total_players INTEGER DEFAULT 1,
    details TEXT
  );

  CREATE TABLE attempt_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id TEXT NOT NULL,
    question_version_id TEXT,
    question_index INTEGER NOT NULL,
    selected_option_id TEXT,
    user_choice INTEGER DEFAULT -1,
    is_correct INTEGER NOT NULL DEFAULT 0,
    response_time_ms INTEGER DEFAULT 0,
    score_awarded INTEGER DEFAULT 0,
    streak_before INTEGER DEFAULT 0,
    streak_after INTEGER DEFAULT 0,
    answered_at INTEGER,
    UNIQUE(attempt_id, question_index)
  );

  CREATE TABLE question_statistics (
    question_id TEXT PRIMARY KEY,
    total_attempts INTEGER DEFAULT 0,
    correct_attempts INTEGER DEFAULT 0,
    avg_response_time_ms INTEGER DEFAULT 0,
    accuracy_pct REAL DEFAULT 0,
    last_calculated_at INTEGER
  );

  CREATE TABLE user_topic_mastery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    topic_id INTEGER,
    subject TEXT NOT NULL,
    questions_attempted INTEGER DEFAULT 0,
    questions_correct INTEGER DEFAULT 0,
    mastery_score REAL DEFAULT 0,
    updated_at INTEGER,
    UNIQUE(user_id, subject, topic_id)
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    owner_id TEXT NOT NULL,
    owner_user_id INTEGER,
    title TEXT NOT NULL,
    file_path TEXT DEFAULT '',
    content_text TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE ai_generation_jobs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    account_user_id INTEGER,
    status TEXT DEFAULT 'pending',
    prompt TEXT DEFAULT '',
    result_data TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

function translateSql(pgSql) {
  return String(pgSql || '')
    .replace(/::\s*(varchar|text|int|integer|bigint|boolean|jsonb|timestamptz)(\(\d+\))?/gi, '')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/(\b[a-zA-Z_][a-zA-Z0-9_.]*)->>'([^']+)'/g, "json_extract($1, '$.$2')")
    .replace(/=\s*ANY\(\s*\$(\d+)\s*\)/gi, 'IN (SELECT value FROM json_each(?$1))')
    .replace(/\$(\d+)/g, '?$1');
}

function normalizeParam(val) {
  if (val === undefined) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (Array.isArray(val)) return JSON.stringify(val);
  if (val && typeof val === 'object' && !Buffer.isBuffer(val) && !(val instanceof Uint8Array)) {
    return JSON.stringify(val);
  }
  return val;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const boolCol of ['is_correct', 'opt_is_correct', 'is_public', 'is_locked']) {
    if (Object.hasOwn(out, boolCol) && out[boolCol] !== null && out[boolCol] !== undefined) {
      out[boolCol] = Boolean(out[boolCol]);
    }
  }
  return out;
}

/**
 * Tạo cơ sở dữ liệu SQLite in-memory hoàn toàn cô lập,
 * cung cấp interface tương thích src/db/pool.js (query, withTransaction, getPool).
 */
function createSqliteTestDb({ skipSchema = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (!skipSchema) {
    sqlite.exec(SCHEMA_SQL);
  }

  let txDepth = 0;

  function executeQuery(sql, params = []) {
    const translated = translateSql(sql);
    const bound = (params || []).map(normalizeParam);
    const trimmed = translated.trim();
    const returnsRows = /^(SELECT|WITH)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed);

    try {
      const stmt = sqlite.prepare(translated);
      if (returnsRows) {
        const rows = stmt.all(...bound).map(normalizeRow);
        return { rows, rowCount: rows.length };
      }
      const info = stmt.run(...bound);
      return { rows: [], rowCount: Number(info.changes || 0) };
    } catch (err) {
      if (err.message && /UNIQUE constraint failed/i.test(err.message)) {
        const dupErr = new Error(`duplicate key value violates unique constraint: ${err.message}`);
        dupErr.code = '23505';
        throw dupErr;
      }
      throw err;
    }
  }

  const pool = {
    async query(sql, params = []) {
      return executeQuery(sql, params);
    },
    async withTransaction(fn) {
      const spName = `sp_${txDepth}`;
      if (txDepth === 0) {
        sqlite.exec('BEGIN');
      } else {
        sqlite.exec(`SAVEPOINT ${spName}`);
      }
      txDepth++;
      try {
        const client = {
          async query(sql, params = []) {
            return executeQuery(sql, params);
          },
        };
        const result = await fn(client);
        txDepth--;
        if (txDepth === 0) {
          sqlite.exec('COMMIT');
        } else {
          sqlite.exec(`RELEASE SAVEPOINT ${spName}`);
        }
        return result;
      } catch (err) {
        txDepth = Math.max(0, txDepth - 1);
        try {
          if (txDepth === 0) {
            sqlite.exec('ROLLBACK');
          } else {
            sqlite.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
            sqlite.exec(`RELEASE SAVEPOINT ${spName}`);
          }
        } catch (_) {}
        throw err;
      }
    },
    getPool() {
      return {
        async end() {},
      };
    },
    raw: sqlite,
    close() {
      try { sqlite.close(); } catch (_) {}
    },
  };

  return pool;
}

module.exports = { createSqliteTestDb, translateSql };
