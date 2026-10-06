// Module xác thực: user store, session, rate-limiting chống spam.
// Source of truth: PostgreSQL / Supabase
const crypto = require('crypto');
const db = require('./db/index.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * DAY_MS;
const NAME_CHANGE_COOLDOWN_MS = 7 * DAY_MS;
const PASSWORD_CHANGE_COOLDOWN_MS = 7 * DAY_MS;

const LOGIN_FREE_ATTEMPTS = 15;      // 15 lần sai đầu không bị chặn
const LOGIN_BASE_WAIT_MS = 15 * 1000; // lần sai kế tiếp chờ 15s
const LOGIN_MAX_WAIT_MS = DAY_MS;     // cap thời gian chờ ở 24h
const LOGIN_WINDOW_MS = DAY_MS;       // cửa sổ đếm lỗi reset sau 1 ngày

const REGISTER_LIMIT = 50;            // tối đa 50 tài khoản / giờ
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // mỗi giờ / IP

// In-memory cache synced with PostgreSQL
const memoryUsers = new Map(); // username_lower -> user
const memorySessions = new Map(); // token -> session
const loginAttempts = new Map(); // ip -> attempt object
const registerAttempts = new Map(); // ip -> [timestamp]

// ── Khởi tạo nạp dữ liệu từ Database (Supabase / PostgreSQL) ──
let isInitialized = false;
async function initAuth() {
  if (isInitialized) return;
  try {
    if (db.useSupabase && db.useSupabase()) {
      const { data: usersList } = await db.supabase.from('users').select('*');
      const { data: profsList } = await db.supabase.from('profiles').select('*');
      const profMap = new Map((profsList || []).map(p => [p.username, p]));

      (usersList || []).forEach(r => {
        const prof = profMap.get(r.username) || {};
        memoryUsers.set(r.username_lower, {
          id: r.id,
          username: r.username,
          usernameLower: r.username_lower,
          displayName: r.display_name,
          passwordHash: r.password_hash,
          salt: r.salt,
          createdAt: Number(r.created_at),
          lastNameChangeAt: Number(r.last_name_change_at || 0),
          lastPasswordChangeAt: Number(r.last_password_change_at || 0),
          avatar: prof.avatar || '01',
          bio: prof.bio || '',
          role: prof.role || 'teacher',
        });
      });

      const { data: sessList } = await db.supabase
        .from('user_sessions')
        .select('*')
        .gt('expires_at', Date.now());

      (sessList || []).forEach(r => {
        memorySessions.set(r.token, {
          username: r.username,
          createdAt: Number(r.created_at),
          expiresAt: Number(r.expires_at),
        });
      });

      isInitialized = true;
      console.log(`🔐 [Auth] Đã nạp ${memoryUsers.size} người dùng và ${memorySessions.size} phiên làm việc từ Supabase!`);
      return;
    }

    const { query } = require('./db/pool.js');
    // Nạp users từ PostgreSQL
    const uRes = await query(
      `SELECT u.id, u.username, u.username_lower, u.display_name, u.password_hash, u.salt,
              u.created_at, u.last_name_change_at, u.last_password_change_at,
              p.avatar, p.bio, p.role
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id`
    );
    uRes.rows.forEach(r => {
      memoryUsers.set(r.username_lower, {
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
      });
    });

    const sRes = await query(
      `SELECT token, username, created_at, expires_at FROM user_sessions WHERE expires_at > $1`,
      [Date.now()]
    );
    sRes.rows.forEach(r => {
      memorySessions.set(r.token, {
        username: r.username,
        createdAt: Number(r.created_at),
        expiresAt: Number(r.expires_at),
      });
    });

    isInitialized = true;
    console.log(`🔐 [Auth] Đã nạp ${memoryUsers.size} người dùng và ${memorySessions.size} phiên làm việc từ PostgreSQL!`);
  } catch (err) {
    console.error('Lỗi nạp Auth từ Database:', err.message);
    throw err;
  }
}

// ── Password hashing (scrypt, stdlib) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHashHex) {
  const hash = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHashHex, 'hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

// ── Users ──
function getUsers() {
  return Array.from(memoryUsers.values());
}

async function findUserByUsername(username) {
  const lower = String(username || '').toLowerCase();
  if (memoryUsers.has(lower)) {
    return memoryUsers.get(lower);
  }
  try {
    const fromDb = await db.findUserByUsername(username);
    if (fromDb) {
      memoryUsers.set(lower, fromDb);
      return fromDb;
    }
  } catch (err) {
    console.error('Lỗi truy vấn user từ DB:', err.message);
  }
  return null;
}

function findUserByUsernameSync(username) {
  const lower = String(username || '').toLowerCase();
  return memoryUsers.get(lower) || null;
}

function validateUsername(username) {
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) {
    return 'Tài khoản phải dài 3-20 ký tự, chỉ gồm chữ, số và gạch dưới.';
  }
  return null;
}

function validateDisplayName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed.length > 30) {
    return 'Tên hiển thị không được để trống và tối đa 30 ký tự.';
  }
  return null;
}

function validatePassword(password) {
  if (!password || password.length < 6) {
    return 'Mật khẩu phải có ít nhất 6 ký tự.';
  }
  return null;
}

async function createUser({ username, displayName, password }) {
  const { salt, hash } = hashPassword(password);
  const user = await db.createUser({
    username,
    displayName,
    passwordHash: hash,
    salt,
  });

  memoryUsers.set(user.usernameLower, user);
  return user;
}

async function updateUser(username, patch) {
  const updated = await db.updateUser(username, patch);
  if (updated) {
    memoryUsers.set(updated.usernameLower, updated);
  }
  return updated;
}

function cooldownInfo(lastChangeAt, cooldownMs) {
  const now = Date.now();
  const nextAllowedAt = (lastChangeAt || 0) + cooldownMs;
  if (lastChangeAt && now < nextAllowedAt) {
    return { allowed: false, nextAllowedAt };
  }
  return { allowed: true, nextAllowedAt: 0 };
}

// ── Sessions (PostgreSQL + Memory cache) ──
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const sess = { username, createdAt: now, expiresAt };
  
  memorySessions.set(token, sess);
  
  // Lưu bất đồng bộ vào PostgreSQL
  db.saveSession(token, username, expiresAt).catch(err => {
    console.error('Lỗi lưu session vào PostgreSQL:', err.message);
  });

  return token;
}

function getSession(token) {
  if (!token) return null;
  const sess = memorySessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    memorySessions.delete(token);
    db.deleteSession(token).catch(() => {});
    return null;
  }
  return sess;
}

function deleteSession(token) {
  if (memorySessions.has(token)) {
    memorySessions.delete(token);
    db.deleteSession(token).catch(() => {});
  }
}

function deleteOtherSessions(username, exceptToken) {
  const lower = username.toLowerCase();
  for (const [token, sess] of memorySessions.entries()) {
    if (token !== exceptToken && sess.username.toLowerCase() === lower) {
      memorySessions.delete(token);
    }
  }
  db.deleteOtherSessions(username, exceptToken).catch(() => {});
}

// ── Cookie helpers ──
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

const SESSION_COOKIE = 'mqc_session';

function sessionCookieHeader(token, isSecure) {
  if (isSecure) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=None; Secure; Partitioned; Max-Age=${SESSION_TTL_MS / 1000}`;
  }
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearSessionCookieHeader(isSecure) {
  return [
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=None; Secure; Partitioned; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ];
}

// ── Rate-limiting chống spam đăng nhập (theo IP) ──
function checkLoginLock(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { locked: false };
  const now = Date.now();
  if (now - entry.firstFailAt > LOGIN_WINDOW_MS) return { locked: false };
  if (entry.lockUntil && now < entry.lockUntil) {
    return { locked: true, waitSeconds: Math.ceil((entry.lockUntil - now) / 1000) };
  }
  return { locked: false };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstFailAt > LOGIN_WINDOW_MS) {
    entry = { count: 0, firstFailAt: now, lockUntil: 0 };
  }
  entry.count += 1;
  let warning = null;
  if (entry.count > LOGIN_FREE_ATTEMPTS) {
    const overBy = entry.count - LOGIN_FREE_ATTEMPTS;
    const waitMs = Math.min(LOGIN_BASE_WAIT_MS * Math.pow(2, overBy - 1), LOGIN_MAX_WAIT_MS);
    entry.lockUntil = now + waitMs;
  } else {
    const remaining = LOGIN_FREE_ATTEMPTS - entry.count;
    if (remaining <= 2) warning = `Sai mật khẩu. Còn ${remaining} lần thử trước khi bị tạm khóa.`;
  }
  loginAttempts.set(ip, entry);
  return {
    locked: !!entry.lockUntil,
    waitSeconds: entry.lockUntil ? Math.ceil((entry.lockUntil - now) / 1000) : 0,
    warning,
  };
}

function recordLoginSuccess(ip) {
  if (loginAttempts.has(ip)) {
    loginAttempts.delete(ip);
  }
}

// ── Chống spam đăng ký (theo IP) ──
function checkRegisterLimit(ip) {
  const now = Date.now();
  const list = (registerAttempts.get(ip) || []).filter(t => now - t < REGISTER_WINDOW_MS);
  registerAttempts.set(ip, list);
  if (list.length >= REGISTER_LIMIT) {
    return { allowed: false, retryAt: list[0] + REGISTER_WINDOW_MS };
  }
  return { allowed: true };
}

function recordRegister(ip) {
  const now = Date.now();
  const list = (registerAttempts.get(ip) || []).filter(t => now - t < REGISTER_WINDOW_MS);
  list.push(now);
  registerAttempts.set(ip, list);
}

function upsertUser(user) {
  if (!user || !user.username) return null;
  const lower = (user.usernameLower || user.username).toLowerCase();
  const normalized = {
    id: user.id,
    username: user.username,
    usernameLower: lower,
    displayName: user.displayName || user.username,
    passwordHash: user.passwordHash,
    salt: user.salt,
    createdAt: user.createdAt || Date.now(),
    lastNameChangeAt: user.lastNameChangeAt || 0,
    lastPasswordChangeAt: user.lastPasswordChangeAt || 0,
    avatar: user.avatar || '01',
    role: user.role || 'teacher',
  };
  memoryUsers.set(lower, normalized);
  return normalized;
}

module.exports = {
  initAuth,
  SESSION_COOKIE,
  NAME_CHANGE_COOLDOWN_MS,
  PASSWORD_CHANGE_COOLDOWN_MS,
  hashPassword,
  verifyPassword,
  findUserByUsername,
  findUserByUsernameSync,
  createUser,
  updateUser,
  getUsers,
  upsertUser,
  cooldownInfo,
  validateUsername,
  validateDisplayName,
  validatePassword,
  createSession,
  getSession,
  deleteSession,
  deleteOtherSessions,
  parseCookies,
  sessionCookieHeader,
  clearSessionCookieHeader,
  checkLoginLock,
  recordLoginFailure,
  recordLoginSuccess,
  checkRegisterLimit,
  recordRegister,
};
