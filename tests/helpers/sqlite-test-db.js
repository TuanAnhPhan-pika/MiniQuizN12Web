const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
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
    role TEXT DEFAULT 'teacher'
  );

  CREATE TABLE user_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE quizzes (
    id TEXT PRIMARY KEY,
    code TEXT,
    title TEXT,
    description TEXT,
    subject TEXT,
    author TEXT,
    time_per_q INTEGER DEFAULT 15,
    points_per_q INTEGER DEFAULT 100,
    is_public INTEGER DEFAULT 0,
    owner_id TEXT,
    owner_user_id INTEGER,
    owner_username_snapshot TEXT,
    parent_code TEXT,
    copies_issued INTEGER DEFAULT 0,
    shared_by TEXT,
    shared_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    created_timestamp INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    deleted_at TEXT
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    owner_user_id INTEGER,
    owner_username_snapshot TEXT
  );

  CREATE TABLE question_versions (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT,
    explanation TEXT,
    difficulty TEXT,
    image_url TEXT
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
    time_limit INTEGER DEFAULT 15
  );

  CREATE TABLE game_sessions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT,
    host_id TEXT,
    room_code TEXT,
    room_title TEXT,
    status TEXT,
    capacity INTEGER DEFAULT 40,
    is_locked INTEGER DEFAULT 0,
    total_players INTEGER DEFAULT 0,
    started_at INTEGER,
    ended_at INTEGER,
    formatted_time TEXT,
    stats TEXT,
    created_at INTEGER
  );

  CREATE TABLE game_players (
    id TEXT PRIMARY KEY,
    game_session_id TEXT,
    nickname TEXT,
    avatar TEXT,
    final_score INTEGER DEFAULT 0,
    rank INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    wrong_count INTEGER DEFAULT 0,
    joined_at INTEGER,
    finished_at INTEGER
  );

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    username TEXT,
    quiz_id TEXT,
    quiz_title TEXT,
    score INTEGER DEFAULT 0,
    total_questions INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    mode TEXT,
    pin TEXT,
    formatted_time TEXT,
    created_at INTEGER
  );
`;

function translateSql(pgSql) {
  return pgSql
    .replace(/::\s*(varchar|text|int|integer|bigint|boolean|jsonb|timestamptz)/gi, '')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\$(\d+)/g, '?$1');
}

function normalizeParam(val) {
  if (val === undefined) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  return val;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (Object.hasOwn(out, 'is_correct')) out.is_correct = Boolean(out.is_correct);
  if (Object.hasOwn(out, 'is_public')) out.is_public = Boolean(out.is_public);
  if (Object.hasOwn(out, 'is_locked')) out.is_locked = Boolean(out.is_locked);
  return out;
}

/**
 * Tạo cơ sở dữ liệu SQLite in-memory hoàn toàn cô lập,
 * cung cấp interface tương thích src/db/pool.js (query, withTransaction, getPool).
 */
function createSqliteTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);

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
      sqlite.exec('BEGIN');
      try {
        const client = {
          async query(sql, params = []) {
            return executeQuery(sql, params);
          },
        };
        const result = await fn(client);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        try { sqlite.exec('ROLLBACK'); } catch (_) {}
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

module.exports = { createSqliteTestDb };
