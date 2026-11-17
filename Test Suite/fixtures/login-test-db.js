// CLI chuẩn bị, đặt lại và kiểm tra dữ liệu thử PostgreSQL cho chức năng Đăng nhập.
// Cách dùng:
//   node Test Suite/fixtures/login-test-db.js seed
//   node Test Suite/fixtures/login-test-db.js reset
//   node Test Suite/fixtures/login-test-db.js inspect
try { require('dotenv').config(); } catch (e) {}

const fs = require('node:fs');
const path = require('node:path');
const { getPool, query, withTransaction } = require('../../src/db/pool.js');
const auth = require('../../src/auth.js');

const TEST_USER = {
  username: 'student_demo',
  displayName: 'Sinh viên Demo',
  password: process.env.TEST_DEMO_PASSWORD || 'Pass123456!',
  role: 'student',
};

async function ensureSchema() {
  const schemaPath = path.resolve(__dirname, '../../src/db/migrations/001_initial_schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);
}

async function seed() {
  await ensureSchema();
  const { salt, hash } = auth.hashPassword(TEST_USER.password);
  const now = Date.now();
  const lower = TEST_USER.username.toLowerCase();

  await withTransaction(async (client) => {
    const uRes = await client.query(
      `INSERT INTO users (username, username_lower, display_name, password_hash, salt, created_at, last_name_change_at, last_password_change_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
       ON CONFLICT (username_lower) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             password_hash = EXCLUDED.password_hash,
             salt = EXCLUDED.salt
       RETURNING id, username, display_name`,
      [TEST_USER.username, lower, TEST_USER.displayName, hash, salt, now]
    );
    const user = uRes.rows[0];
    await client.query(
      `INSERT INTO profiles (user_id, username, display_name, avatar, role)
       VALUES ($1, $2, $3, '01', $4)
       ON CONFLICT (username) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             display_name = EXCLUDED.display_name,
             role = EXCLUDED.role`,
      [user.id, user.username, user.display_name, TEST_USER.role]
    );
    await client.query(`DELETE FROM user_sessions WHERE LOWER(username) = $1`, [lower]);
  });

  console.log(`Seeded test account: ${TEST_USER.username} (password from TEST_DEMO_PASSWORD or default demo value)`);
  await inspect();
}

async function reset() {
  const lower = TEST_USER.username.toLowerCase();
  const del = await query(`DELETE FROM user_sessions WHERE LOWER(username) = $1`, [lower]);
  console.log(`Reset test sessions for ${TEST_USER.username}: deleted ${del.rowCount || 0} row(s).`);
  await inspect();
}

async function inspect() {
  const lower = TEST_USER.username.toLowerCase();
  const usersRes = await query(
    `SELECT u.id, u.username, u.display_name, p.role
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.username_lower = $1`,
    [lower]
  );
  const sessRes = await query(
    `SELECT LEFT(token, 12) || '...' AS token_prefix, username, created_at, expires_at
     FROM user_sessions
     WHERE LOWER(username) = $1
     ORDER BY created_at DESC`,
    [lower]
  );
  console.log('users:', JSON.stringify(usersRes.rows, null, 2));
  console.log('user_sessions count:', sessRes.rowCount);
  console.log('user_sessions rows:', JSON.stringify(sessRes.rows, null, 2));
}

async function main() {
  const cmd = process.argv[2] || 'inspect';
  if (!process.env.DATABASE_URL && !process.env.PGHOST && !process.env.SQL_HOST) {
    console.error('Missing DATABASE_URL / PGHOST / SQL_HOST in .env or environment.');
    process.exitCode = 1;
    return;
  }
  try {
    if (cmd === 'seed') await seed();
    else if (cmd === 'reset') await reset();
    else if (cmd === 'inspect') await inspect();
    else {
      console.error(`Unknown command: ${cmd}. Use seed | reset | inspect.`);
      process.exitCode = 1;
    }
  } finally {
    await getPool().end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Database helper failed:', err.message);
  process.exitCode = 1;
});
