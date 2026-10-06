try { require('dotenv').config(); } catch (e) {}
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const auth = require('./auth.js');
const db   = require('./db/index.js');
const { runMigration } = require('./db/migrate.js');
const roomsManager = require('./rooms/manager.js');

const ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3000;
const DEFAULT_APP_URL = 'https://mini-quiz-classroom-n12.ai.studio';

// Lấy địa chỉ IP mạng nội bộ (LAN) của máy chủ - ưu tiên card Wi-Fi thật, bỏ qua card VPN ảo
function getServerLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  
  for (const [name, list] of Object.entries(nets)) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('virtual') || lowerName.includes('vpn') || lowerName.includes('wireguard') || lowerName.includes('vethernet') || lowerName.includes('radmin') || lowerName.includes('hamachi')) {
      continue;
    }
    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.56.')) continue;
        if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan') || lowerName.includes('wireless')) {
          return net.address;
        }
        candidates.push({ name, ip: net.address });
      }
    }
  }

  const homeNet = candidates.find(c => c.ip.startsWith('192.168.'));
  if (homeNet) return homeNet.ip;
  if (candidates.length > 0) return candidates[0].ip;
  return '127.0.0.1';
}

function sortExamsByCode(exams) {
  return (exams || []).slice().sort((a, b) => {
    const codeA = String(a.code || '').trim();
    const codeB = String(b.code || '').trim();
    return codeA.localeCompare(codeB, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function canonicalizeQuestion(q) {
  if (!q) return '';
  const text = String(q.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const choices = (q.choices || []).map(c => String(c || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const correctText = choices[q.correct] || '';
  const sortedChoices = [...choices].sort().join('|');
  return `q:${text}#c:${correctText}#ch:${sortedChoices}`;
}

function getCanonicalExamString(exam) {
  if (!exam) return '';
  const title = String(exam.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const canonicalQuestions = (exam.questions || []).map(canonicalizeQuestion).sort();
  return `title:${title}\nquestions:\n${canonicalQuestions.join('\n')}`;
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const v0 = new Int32Array(b.length + 1);
  const v1 = new Int32Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = (a[i] === b[j]) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v0[b.length];
}

function calculateExamDiffPercent(parentExam, currentExam) {
  const s1 = getCanonicalExamString(parentExam);
  const s2 = getCanonicalExamString(currentExam);
  if (s1 === s2) return 0;
  const dist = levenshteinDistance(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen > 0 ? (dist / maxLen) * 100 : 0;
}

// MIME types cho static files
const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css':  'text/css;charset=utf-8',
  '.js':   'application/javascript;charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json;charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls':  'application/vnd.ms-excel',
  '.csv':  'text/csv;charset=utf-8',
  '.txt':  'text/plain;charset=utf-8',
};

// Đọc JSON body từ request
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2e6) { // 2MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = forwarded.split(',');
    if (parts.length > 0) {
      const first = parts[0].trim();
      if (first) return first;
    }
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function getRequestProto(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto && typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0].trim().toLowerCase();
  }
  return 'http';
}

function getRequestHost(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
}

// Lấy user đang đăng nhập từ token header hoặc cookie session; null nếu không hợp lệ
function getSessionUser(req) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token && req.headers['x-session-token']) {
    token = String(req.headers['x-session-token']).trim();
  }
  if (!token) {
    const cookies = auth.parseCookies(req.headers.cookie);
    token = cookies[auth.SESSION_COOKIE];
  }
  if (!token) return null;
  const session = auth.getSession(token);
  if (!session) return null;

  const user = auth.findUserByUsernameSync(session.username);
  const role = user?.role || (session.username.toLowerCase() === 'admin' ? 'admin' : 'teacher');

  return {
    username: session.username,
    token,
    userId: user?.id || null,
    role
  };
}

function isAdmin(sessionUser) {
  return !!sessionUser && (sessionUser.role === 'admin' || sessionUser.username?.toLowerCase() === 'admin');
}

function isRoomHost(sessionUser, room) {
  return !!sessionUser && !!room && (
    (sessionUser.username && room.hostUsername && sessionUser.username.toLowerCase() === room.hostUsername.toLowerCase()) ||
    isAdmin(sessionUser)
  );
}

function sendJSON(res, status, obj, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const proto = getRequestProto(req);
  const host = getRequestHost(req);
  const isSecure = proto === 'https';
  const parsedUrl = new URL(req.url, `${proto}://${host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS headers
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token, X-Player-Token');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ══════════════════════════════════════════════════════════
  // AUTH ENDPOINTS
  // ══════════════════════════════════════════════════════════

  // [GET] /api/auth/check-username
  if (method === 'GET' && pathname === '/api/auth/check-username') {
    const u = (parsedUrl.searchParams.get('u') || '').trim();
    if (!u) {
      sendJSON(res, 400, { exists: false, valid: false, message: 'Tài khoản không được rỗng.' });
      return;
    }
    const err = auth.validateUsername(u);
    if (err) {
      sendJSON(res, 200, { exists: false, valid: false, message: err });
      return;
    }
    let exists = !!(await auth.findUserByUsername(u));
    sendJSON(res, 200, {
      exists,
      valid: !exists,
      message: exists ? 'Tài khoản này đã được sử dụng!' : 'Tài khoản hợp lệ và có thể đăng ký.'
    });
    return;
  }

  // [POST] /api/auth/register
  if (method === 'POST' && pathname === '/api/auth/register') {
    try {
      const ip = getClientIp(req);
      const limit = auth.checkRegisterLimit(ip);
      if (!limit.allowed) {
        const waitMin = Math.ceil((limit.retryAt - Date.now()) / 60000);
        sendJSON(res, 429, { success: false, message: `Đã đăng ký quá nhiều lần từ mạng này. Vui lòng thử lại sau khoảng ${waitMin} phút.` });
        return;
      }

      const body = await readJsonBody(req);
      const { username, displayName, password, confirmPassword } = body;

      const usernameErr = auth.validateUsername(username);
      if (usernameErr) { sendJSON(res, 400, { success: false, message: usernameErr }); return; }
      const nameErr = auth.validateDisplayName(displayName);
      if (nameErr) { sendJSON(res, 400, { success: false, message: nameErr }); return; }
      const passErr = auth.validatePassword(password);
      if (passErr) { sendJSON(res, 400, { success: false, message: passErr }); return; }
      if (password !== confirmPassword) {
        sendJSON(res, 400, { success: false, message: 'Xác nhận mật khẩu không khớp.' });
        return;
      }
      const existing = await auth.findUserByUsername(username);
      if (existing) {
        sendJSON(res, 409, { success: false, message: 'Tài khoản đã tồn tại. Vui lòng chuyển sang tab Đăng nhập.' });
        return;
      }

      try {
        await auth.createUser({ username, displayName, password });
      } catch (createErr) {
        if (createErr.message && (createErr.message.includes('unique constraint') || createErr.message.includes('duplicate key'))) {
          sendJSON(res, 409, { success: false, message: 'Tài khoản này đã tồn tại. Vui lòng chuyển sang tab Đăng nhập!' });
          return;
        }
        throw createErr;
      }

      auth.recordRegister(ip);
      const token = auth.createSession(username);
      sendJSON(res, 200, {
        success: true,
        token,
        username,
        displayName: displayName.trim(),
        user: {
          username,
          displayName: displayName.trim(),
          role: 'teacher',
        }
      }, { 'Set-Cookie': auth.sessionCookieHeader(token, isSecure) });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // [POST] /api/auth/login
  if (method === 'POST' && pathname === '/api/auth/login') {
    try {
      const ip = getClientIp(req);
      const lock = auth.checkLoginLock(ip);
      if (lock.locked) {
        sendJSON(res, 429, { success: false, message: `Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${lock.waitSeconds} giây.` });
        return;
      }

      const body = await readJsonBody(req);
      const { username, password } = body;
      const user = await auth.findUserByUsername(username);

      if (!user) {
        const fail = auth.recordLoginFailure(ip);
        sendJSON(res, 401, { success: false, message: fail.warning || 'Tài khoản hoặc mật khẩu không chính xác.' });
        return;
      }

      const ok = auth.verifyPassword(password, user.salt, user.passwordHash);
      if (!ok) {
        const fail = auth.recordLoginFailure(ip);
        sendJSON(res, 401, { success: false, message: fail.warning || 'Tài khoản hoặc mật khẩu không chính xác.' });
        return;
      }

      auth.recordLoginSuccess(ip);
      const token = auth.createSession(user.username);
      sendJSON(res, 200, {
        success: true,
        token,
        username: user.username,
        displayName: user.displayName,
        user: {
          username: user.username,
          displayName: user.displayName,
          role: user.role || 'teacher',
          avatar: user.avatar || '01',
        }
      }, { 'Set-Cookie': auth.sessionCookieHeader(token, isSecure) });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // [POST] /api/auth/logout
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const sessionUser = getSessionUser(req);
    if (sessionUser && sessionUser.token) {
      auth.deleteSession(sessionUser.token);
    }
    sendJSON(res, 200, { success: true }, { 'Set-Cookie': auth.clearSessionCookieHeader(isSecure) });
    return;
  }

  // [GET] /api/auth/me
  if (method === 'GET' && pathname === '/api/auth/me') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { authenticated: false, success: false, user: null });
      return;
    }
    const user = await auth.findUserByUsername(sessionUser.username);
    if (!user) {
      auth.deleteSession(sessionUser.token);
      sendJSON(res, 401, { authenticated: false, success: false, user: null }, { 'Set-Cookie': auth.clearSessionCookieHeader(isSecure) });
      return;
    }
    const nameCooldown = auth.cooldownInfo(user.lastNameChangeAt, auth.NAME_CHANGE_COOLDOWN_MS);
    const passCooldown = auth.cooldownInfo(user.lastPasswordChangeAt, auth.PASSWORD_CHANGE_COOLDOWN_MS);
    sendJSON(res, 200, {
      authenticated: true,
      success: true,
      token: sessionUser.token,
      username: user.username,
      displayName: user.displayName,
      createdAt: user.createdAt,
      avatar: user.avatar || '01',
      role: user.role || 'teacher',
      nameCooldown,
      passCooldown,
      user: {
        username: user.username,
        displayName: user.displayName,
        createdAt: user.createdAt,
        avatar: user.avatar || '01',
        role: user.role || 'teacher',
        nameCooldown,
        passCooldown,
      }
    });
    return;
  }

  // [POST] /api/auth/change-profile
  if (method === 'POST' && pathname === '/api/auth/change-profile') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập.' });
      return;
    }
    const user = await auth.findUserByUsername(sessionUser.username);
    if (!user) {
      sendJSON(res, 401, { success: false, message: 'Tài khoản không tồn tại.' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const { newDisplayName, currentPassword, newPassword, confirmNewPassword } = body;
      const patch = {};
      const now = Date.now();

      if (newDisplayName !== undefined && newDisplayName !== null && newDisplayName.trim() !== user.displayName) {
        const nameErr = auth.validateDisplayName(newDisplayName);
        if (nameErr) { sendJSON(res, 400, { success: false, message: nameErr }); return; }
        const nameCd = auth.cooldownInfo(user.lastNameChangeAt, auth.NAME_CHANGE_COOLDOWN_MS);
        if (!nameCd.allowed) {
          const daysLeft = Math.ceil((nameCd.nextAllowedAt - now) / (24 * 60 * 60 * 1000));
          sendJSON(res, 429, { success: false, message: `Bạn chỉ có thể đổi tên hiển thị 1 lần mỗi 7 ngày. Vui lòng quay lại sau ${daysLeft} ngày.` });
          return;
        }
        patch.displayName = newDisplayName.trim();
        patch.lastNameChangeAt = now;
      }

      if (newPassword) {
        if (!currentPassword) {
          sendJSON(res, 400, { success: false, message: 'Vui lòng nhập mật khẩu hiện tại để đổi mật khẩu.' });
          return;
        }
        if (!auth.verifyPassword(currentPassword, user.salt, user.passwordHash)) {
          sendJSON(res, 400, { success: false, message: 'Mật khẩu hiện tại không chính xác.' });
          return;
        }
        const passErr = auth.validatePassword(newPassword);
        if (passErr) { sendJSON(res, 400, { success: false, message: passErr }); return; }
        if (newPassword !== confirmNewPassword) {
          sendJSON(res, 400, { success: false, message: 'Xác nhận mật khẩu mới không khớp.' });
          return;
        }
        const passCd = auth.cooldownInfo(user.lastPasswordChangeAt, auth.PASSWORD_CHANGE_COOLDOWN_MS);
        if (!passCd.allowed) {
          const daysLeft = Math.ceil((passCd.nextAllowedAt - now) / (24 * 60 * 60 * 1000));
          sendJSON(res, 429, { success: false, message: `Bạn chỉ có thể đổi mật khẩu 1 lần mỗi 7 ngày. Vui lòng quay lại sau ${daysLeft} ngày.` });
          return;
        }
        const { salt, hash } = auth.hashPassword(newPassword);
        patch.salt = salt;
        patch.passwordHash = hash;
        patch.lastPasswordChangeAt = now;
      }

      if (Object.keys(patch).length === 0) {
        sendJSON(res, 200, { success: true, message: 'Không có thay đổi nào.' });
        return;
      }

      const updated = await auth.updateUser(user.username, patch);
      if (patch.passwordHash) {
        auth.deleteOtherSessions(user.username, sessionUser.token);
      }

      sendJSON(res, 200, {
        success: true,
        displayName: updated.displayName,
        nameCooldown: auth.cooldownInfo(updated.lastNameChangeAt, auth.NAME_CHANGE_COOLDOWN_MS),
        passCooldown: auth.cooldownInfo(updated.lastPasswordChangeAt, auth.PASSWORD_CHANGE_COOLDOWN_MS),
        message: 'Cập nhật thông tin thành công!'
      });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // ══════════════════════════════════════════════════════════
  // USER HISTORY ENDPOINTS (attempts & attempt_answers)
  // ══════════════════════════════════════════════════════════

  // [GET] /api/history - Lấy danh sách lịch sử thi của user (Bắt buộc authenticated session)
  if (method === 'GET' && pathname === '/api/history') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Vui lòng đăng nhập để xem lịch sử làm bài.' });
      return;
    }
    try {
      const history = await db.getUserAttempts(sessionUser.username);
      sendJSON(res, 200, { success: true, history });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // [POST] /api/history - Ghi lại kết quả bài thi sau khi hoàn thành (Server-Authoritative Only)
  if (method === 'POST' && pathname === '/api/history') {
    try {
      const body = await readJsonBody(req);
      const sessionUser = getSessionUser(req);
      // BẢO MẬT: Guest không được phép khai username của account khác!
      const username = sessionUser ? sessionUser.username : 'guest';
      const pin = body.pin || '';

      let authoritativeRecord = null;

      // 1. Multiplayer: Tạo history từ server room state nếu phòng tồn tại
      const rawRoom = pin ? roomsManager.getRawRoom(pin) : null;
      if (rawRoom) {
        const playerId = body.playerId || body.id;
        const playerToken = body.playerToken || req.headers['x-player-token'];
        let player = null;
        if (playerId && playerToken) {
          player = roomsManager.verifyPlayer(rawRoom, playerId, playerToken);
        }
        if (!player && sessionUser) {
          player = (rawRoom.players || []).find(p => p.nick && p.nick.toLowerCase() === sessionUser.username.toLowerCase());
        }

        if (player) {
          const questions = rawRoom.questions || [];
          let serverScore = Number(player.score) || 0;
          let correctCount = 0;
          const answersDetail = [];

          for (let qIdx = 0; qIdx < questions.length; qIdx++) {
            const q = questions[qIdx];
            const ansRecord = rawRoom.answers && rawRoom.answers[qIdx] && rawRoom.answers[qIdx][player.id];
            const isCorrect = ansRecord ? !!ansRecord.isCorrect : false;
            if (isCorrect) correctCount++;
            answersDetail.push({
              questionIndex: qIdx,
              questionVersionId: q.versionId || null,
              userChoice: ansRecord ? ansRecord.choice : -1,
              isCorrect: isCorrect,
              earned: ansRecord ? ansRecord.scoreAwarded : 0,
              scoreAwarded: ansRecord ? ansRecord.scoreAwarded : 0,
              responseTimeMs: ansRecord ? ansRecord.responseTimeMs : 0,
              streakBefore: ansRecord ? ansRecord.streakBefore : 0,
              streakAfter: ansRecord ? ansRecord.streakAfter : 0,
            });
          }

          const totalQuestions = questions.length;
          const ratioPct = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;

          authoritativeRecord = {
            username,
            quizId: rawRoom.examId || null,
            pin: rawRoom.pin,
            roomTitle: rawRoom.title,
            examTitle: rawRoom.title,
            score: serverScore,
            maxScore: totalQuestions * 100,
            correctCount,
            wrongCount: totalQuestions - correctCount,
            totalQuestions,
            ratioPct,
            accuracyPct: ratioPct,
            formattedTime: new Date().toLocaleString('vi-VN'),
            details: answersDetail,
            answersDetail,
          };
        }
      }

      // 2. Solo Quiz / Custom Exam: Server tự chấm lại theo Database Quiz
      if (!authoritativeRecord) {
        const quizId = body.quizId || body.examId;
        let quiz = quizId ? await db.getQuizById(quizId, { includeCorrect: true, requestingUser: sessionUser }) : null;
        const incomingAnswers = Array.isArray(body.answersDetail) ? body.answersDetail : (Array.isArray(body.details) ? body.details : []);

        if (quiz && Array.isArray(quiz.questions) && quiz.questions.length > 0) {
          let calculatedScore = 0;
          let correctCount = 0;
          const totalQuestions = quiz.questions.length;
          const answersDetail = [];

          for (let i = 0; i < totalQuestions; i++) {
            const q = quiz.questions[i];
            const ans = incomingAnswers[i] || {};
            const userChoice = typeof ans.userChoice === 'number' ? ans.userChoice : (typeof ans.choice === 'number' ? ans.choice : -1);
            const isCorrect = (typeof q.correct === 'number' && userChoice === q.correct);
            const points = q.points || quiz.pointsPerQ || 100;
            const earned = isCorrect ? points : 0;
            if (isCorrect) correctCount++;
            calculatedScore += earned;

            answersDetail.push({
              questionIndex: i,
              questionVersionId: q.versionId || null,
              userChoice,
              isCorrect,
              earned,
              scoreAwarded: earned,
              responseTimeMs: Number(ans.responseTimeMs) || 0,
              streakBefore: Number(ans.streakBefore) || 0,
              streakAfter: Number(ans.streakAfter) || 0,
            });
          }

          const ratioPct = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
          authoritativeRecord = {
            username,
            quizId: quiz.id,
            pin: body.pin || '',
            roomTitle: body.roomTitle || quiz.title,
            examTitle: quiz.title,
            score: calculatedScore,
            maxScore: totalQuestions * 100,
            correctCount,
            wrongCount: totalQuestions - correctCount,
            totalQuestions,
            ratioPct,
            accuracyPct: ratioPct,
            formattedTime: new Date().toLocaleString('vi-VN'),
            details: answersDetail,
            answersDetail,
          };
        }
      }

      // Nếu không thể verify từ server room hoặc database quiz -> Từ chối kết quả không có kiểm chứng!
      if (!authoritativeRecord) {
        sendJSON(res, 400, {
          success: false,
          message: 'Không thể xác minh bài thi.'
        });
        return;
      }

      const saved = await db.saveAttempt(authoritativeRecord);
      sendJSON(res, 200, { success: true, historyItem: saved });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // [GET] /api/history/hosted - Lấy danh sách phòng thi đã tổ chức của chủ phòng (Bắt buộc authenticated session)
  if (method === 'GET' && pathname === '/api/history/hosted') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Vui lòng đăng nhập để xem lịch sử tổ chức phòng.' });
      return;
    }
    try {
      const rooms = await db.getHostedGameSessions(sessionUser.username);
      sendJSON(res, 200, { success: true, rooms });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // [POST] /api/history/hosted - Kết thúc và lưu trữ phòng thi từ server room state (Chỉ Host thật sự)
  if (method === 'POST' && pathname === '/api/history/hosted') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Yêu cầu đăng nhập tài khoản Host.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const pin = body.pin;
      if (!pin) {
        sendJSON(res, 400, { success: false, message: 'Thiếu mã PIN phòng thi.' });
        return;
      }
      const rawRoom = roomsManager.getRawRoom(pin);
      if (!rawRoom) {
        sendJSON(res, 404, { success: false, message: 'Phòng thi không tồn tại hoặc đã kết thúc.' });
        return;
      }
      const isHost = isRoomHost(sessionUser, rawRoom);
      if (!isHost) {
        sendJSON(res, 403, { success: false, message: 'Bạn không phải là host của phòng thi này.' });
        return;
      }
      const archiveResult = await roomsManager.finishAndArchiveRoom(pin);
      sendJSON(res, 200, { success: true, record: archiveResult ? archiveResult.stats : null });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // ══════════════════════════════════════════════════════════
  // STORAGE ENDPOINTS (quizzes, questions, versions, options)
  // ══════════════════════════════════════════════════════════

  // 1. [GET] /api/storage/private
  if (method === 'GET' && pathname === '/api/storage/private') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập. Vui lòng đăng nhập để xem kho đề thi cá nhân.' });
      return;
    }
    try {
      const exams = await db.getPrivateQuizzes(sessionUser.username);
      sendJSON(res, 200, { success: true, exams: sortExamsByCode(exams) });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // 2. [POST] /api/storage/private
  if (method === 'POST' && pathname === '/api/storage/private') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập. Vui lòng đăng nhập để lưu đề thi vào kho cá nhân.' });
      return;
    }
    try {
      const rawBody = await readJsonBody(req);
      const examData = (rawBody && rawBody.exam) ? rawBody.exam : rawBody;
      if (!examData || !examData.title) {
        sendJSON(res, 400, { success: false, message: 'Dữ liệu đề thi không hợp lệ!' });
        return;
      }
      const saved = await db.saveQuiz(examData, sessionUser.username, false);
      sendJSON(res, 200, { success: true, exam: saved });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // 3. [DELETE] /api/storage/private/:id
  if (method === 'DELETE' && pathname.startsWith('/api/storage/private/')) {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập.' });
      return;
    }
    const examId = pathname.replace('/api/storage/private/', '');
    try {
      const deleted = await db.deleteQuiz(examId, sessionUser.username);
      sendJSON(res, 200, { success: deleted });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // 4. [GET] /api/storage/public
  if (method === 'GET' && pathname === '/api/storage/public') {
    try {
      const exams = await db.getPublicQuizzes();
      sendJSON(res, 200, { success: true, exams: sortExamsByCode(exams) });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // 5. [POST] /api/storage/public/share
  if (method === 'POST' && pathname === '/api/storage/public/share') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập. Vui lòng đăng nhập để chia sẻ đề thi.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const incomingExam = body.exam || body;
      if (!incomingExam || !incomingExam.title) {
        sendJSON(res, 400, { success: false, message: 'Dữ liệu đề thi không hợp lệ!' });
        return;
      }

      const publicExams = await db.getPublicQuizzes();
      let parentCode = incomingExam.parentCode || incomingExam.code || '';
      let parentExam = publicExams.find(e => e.code === parentCode);

      if (parentExam) {
        const diffPercent = calculateExamDiffPercent(parentExam, incomingExam);
        if (diffPercent < 5) {
          sendJSON(res, 200, {
            success: true,
            isOriginal: true,
            diffPercent: Math.round(diffPercent * 10) / 10,
            shareCode: parentExam.code,
            exam: parentExam,
            message: `Nội dung giống ${100 - Math.round(diffPercent)}% đề gốc. Hệ thống dùng lại mã chia sẻ cũ!`
          });
          return;
        }
      }

      // Đề mới hoặc có chỉnh sửa trên 5%
      let baseCode = incomingExam.code ? incomingExam.code.replace(/^#/, '') : Math.random().toString(16).slice(2, 6);
      let newCode = `#${baseCode}`;
      if (publicExams.some(e => e.code === newCode)) {
        newCode = `#${baseCode}-${Date.now().toString().slice(-4)}`;
      }

      const sharedExam = {
        ...incomingExam,
        id: `exam-${Date.now()}`,
        code: newCode,
        isPublic: true,
        parentCode: parentCode,
        copiesIssued: 0,
        sharedBy: sessionUser.username,
        sharedAt: new Date().toISOString(),
      };

      const saved = await db.saveQuiz(sharedExam, sessionUser.username, true);
      sendJSON(res, 200, {
        success: true,
        isOriginal: false,
        shareCode: saved.code,
        exam: saved,
        message: 'Đã xuất bản đề thi lên kho công khai thành công!'
      });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // 6. [DELETE] /api/storage/public/:id - Chỉ cho phép chủ sở hữu thực hoặc admin xóa đề thi công khai
  if (method === 'DELETE' && pathname.startsWith('/api/storage/public/')) {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập.' });
      return;
    }
    const examId = pathname.replace('/api/storage/public/', '');
    try {
      const deleted = await db.deleteQuiz(examId, sessionUser);
      if (!deleted) {
        sendJSON(res, 403, { success: false, message: 'Bạn không có quyền xóa đề thi này hoặc đề thi không tồn tại.' });
        return;
      }
      sendJSON(res, 200, { success: true });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // 7. [POST] /api/storage/public/save-to-private
  if (method === 'POST' && pathname === '/api/storage/public/save-to-private') {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập. Vui lòng đăng nhập để lưu đề về máy.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const examId = body.id || body.examId;
      const targetExam = await db.getQuizById(examId, { includeCorrect: true, requestingUser: sessionUser });

      if (!targetExam) {
        sendJSON(res, 404, { success: false, message: 'Không tìm thấy đề thi hoặc đề thi không công khai!' });
        return;
      }

      // Tăng số bản sao phát hành của đề gốc
      targetExam.copiesIssued = (targetExam.copiesIssued || 0) + 1;
      await db.saveQuiz(targetExam, targetExam.ownerUsername || sessionUser.username, true);

      // Tạo bản sao cho Private Storage của giáo viên
      const newPrivateExam = {
        ...targetExam,
        id: `exam-${Date.now()}`,
        code: `#${Math.random().toString(16).slice(2, 6)}`,
        parentCode: targetExam.code,
        copiesIssued: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const saved = await db.saveQuiz(newPrivateExam, sessionUser.username, false);
      sendJSON(res, 200, {
        success: true,
        exam: saved,
        message: 'Đã lưu đề thi vào kho cá nhân thành công!'
      });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // ══════════════════════════════════════════════════════════
  // MULTIPLAYER ROOM ENDPOINTS
  // ══════════════════════════════════════════════════════════

  function requireRoomHost(req, pin) {
    const rawRoom = roomsManager.getRawRoom(pin);
    if (!rawRoom) {
      return { ok: false, status: 404, message: 'Phòng thi không tồn tại hoặc đã hết hạn!' };
    }
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return { ok: false, status: 401, message: 'Yêu cầu đăng nhập tài khoản Host.' };
    }
    if (!isRoomHost(sessionUser, rawRoom)) {
      return { ok: false, status: 403, message: 'Bạn không có quyền điều khiển phòng này.' };
    }
    return { ok: true, room: rawRoom, sessionUser };
  }

  // [POST] /api/rooms - Tạo phòng thi (Bắt buộc authenticated session)
  if (method === 'POST' && pathname === '/api/rooms') {
    try {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        sendJSON(res, 401, { success: false, message: 'Chưa đăng nhập. Vui lòng đăng nhập để tạo phòng thi.' });
        return;
      }
      const body = await readJsonBody(req);
      const hostUsername = sessionUser.username;

      let exam = body.exam || {};
      if (body.examId && (!exam.questions || exam.questions.length === 0)) {
        const found = await db.getQuizById(body.examId, { includeCorrect: true, requestingUser: sessionUser });
        if (!found) {
          sendJSON(res, 403, { success: false, message: 'Không tìm thấy đề thi hoặc bạn không có quyền sử dụng đề thi này!' });
          return;
        }
        exam = found;
      }

      const room = await roomsManager.createRoom({
        hostUsername,
        exam,
        capacity: Number(body.capacity) || 40,
        isLocked: !!body.isLocked,
        title: body.title || exam.title || 'Phòng thi trực tuyến'
      });

      sendJSON(res, 200, { success: true, room: roomsManager.getRoomForClient(room.pin, true), pin: room.pin });
      return;
    } catch (err) {
      sendJSON(res, 500, { success: false, message: err.message });
      return;
    }
  }

  // [GET] /api/rooms/:pin - Lấy dữ liệu phòng thi theo mã PIN
  if (method === 'GET' && pathname.startsWith('/api/rooms/')) {
    const cleanPath = pathname.replace('/api/rooms/', '');
    const parts = cleanPath.split('/');
    const pin = parts[0];
    const subAction = parts[1] || '';

    const sessionUser = getSessionUser(req);
    const rawRoom = roomsManager.getRawRoom(pin);
    if (!rawRoom) {
      sendJSON(res, 404, { success: false, message: 'Phòng thi không tồn tại hoặc đã hết hạn!' });
      return;
    }

    const isHost = isRoomHost(sessionUser, rawRoom);

    // Kiểm tra nhanh điều kiện vào phòng
    if (parsedUrl.searchParams.get('check') === '1') {
      if (rawRoom.isLocked) {
        sendJSON(res, 200, { success: false, locked: true, message: 'Phòng thi đang khóa, không thể vào' });
        return;
      }
      const currentCandidates = (rawRoom.players || []).filter(p => !p.isHost).length;
      if (currentCandidates >= rawRoom.capacity) {
        sendJSON(res, 200, { success: false, full: true, message: 'Phòng không còn chỗ trống' });
        return;
      }
      const safeRoom = roomsManager.getRoomForClient(pin, isHost);
      sendJSON(res, 200, { success: true, room: safeRoom });
      return;
    }

    // [GET] /api/rooms/:pin/status - BẢO MẬT: Tuyệt đối không leak playerToken!
    if (subAction === 'status') {
      let currentStatus = rawRoom.status || 'waiting';
      let remainingSec = 0;
      if (currentStatus === 'countdown') {
        const diffMs = (rawRoom.countdownEnd || 0) - Date.now();
        if (diffMs <= 0) {
          rawRoom.status = 'started';
          currentStatus = 'started';
        } else {
          remainingSec = Math.max(1, Math.ceil(diffMs / 1000));
        }
      }

      sendJSON(res, 200, {
        success: true,
        status: currentStatus,
        countdown: remainingSec,
        title: rawRoom.title,
        pin: rawRoom.pin,
        isLocked: !!rawRoom.isLocked,
        capacity: rawRoom.capacity,
        players: (rawRoom.players || []).map(p => roomsManager.sanitizePlayer(p)).filter(Boolean)
      });
      return;
    }

    // [GET] /api/rooms/:pin/leaderboard
    if (subAction === 'leaderboard') {
      const leaderboard = roomsManager.getLeaderboard(pin);
      sendJSON(res, 200, { success: true, leaderboard });
      return;
    }

    // [GET] /api/rooms/:pin/question-stats - Chỉ trả số lượng lựa chọn, KHÔNG trả đáp án đúng
    if (subAction === 'question-stats') {
      // Anti-cheat: khi đang trong phase question và room đang chạy, chỉ host được xem choicesCount realtime
      const isQuestionPhase = rawRoom.phase === 'question' && (rawRoom.status === 'started' || rawRoom.status === 'in_progress');
      if (isQuestionPhase && !isHost) {
        sendJSON(res, 403, { success: false, message: 'Chỉ host mới có quyền xem thống kê lựa chọn khi câu hỏi đang diễn ra.' });
        return;
      }

      const q = Number(parsedUrl.searchParams.get('q')) || 0;
      const question = (rawRoom.questions && rawRoom.questions[q]) || null;
      const choicesLen = (question && Array.isArray(question.choices)) ? question.choices.length : 4;
      const choicesCount = new Array(choicesLen).fill(0);
      const answersForQ = (rawRoom.answers && rawRoom.answers[q]) || {};

      const countedIds = new Set();
      Object.values(answersForQ).forEach(ans => {
        const idKey = ans.playerId || ans.nick;
        if (idKey && !countedIds.has(idKey)) {
          countedIds.add(idKey);
          if (typeof ans.choice === 'number' && ans.choice >= 0 && ans.choice < choicesLen) {
            choicesCount[ans.choice]++;
          }
        }
      });

      const totalCandidates = (rawRoom.players || []).filter(p => !p.isHost).length;
      sendJSON(res, 200, {
        success: true,
        q,
        choicesCount,
        totalAnswered: countedIds.size,
        totalCandidates,
        allAnswered: totalCandidates > 0 && countedIds.size >= totalCandidates
      });
      return;
    }

    // [GET] /api/rooms/:pin/state
    if (subAction === 'state') {
      const candidates = (rawRoom.players || []).filter(p => !p.isHost);
      const totalCandidates = candidates.length;
      const q = typeof rawRoom.currentQ === 'number' ? rawRoom.currentQ : 0;
      const currentAnswers = (rawRoom.answers && rawRoom.answers[q]) || {};
      const countedIds = new Set();
      Object.values(currentAnswers).forEach(ans => {
        const idKey = ans.playerId || ans.nick;
        if (idKey) countedIds.add(idKey);
      });
      const answeredCount = countedIds.size;

      sendJSON(res, 200, {
        success: true,
        status: rawRoom.status || 'waiting',
        currentQ: q,
        phase: rawRoom.phase || 'question',
        allAnswered: totalCandidates > 0 && answeredCount >= totalCandidates,
        totalAnswered: answeredCount,
        totalCandidates,
        totalQuestions: (rawRoom.questions || []).length,
        phaseStartedAt: rawRoom.phaseStartedAt || 0
      });
      return;
    }

    // [GET] /api/rooms/:pin/exam-stats - Chỉ Host hoặc phòng đã finished mới được xem
    if (subAction === 'exam-stats') {
      if (rawRoom.status !== 'finished' && !isHost) {
        sendJSON(res, 403, { success: false, message: 'Chỉ host mới có quyền xem thống kê khi phòng đang diễn ra.' });
        return;
      }
      const stats = roomsManager.calculateExamStats(rawRoom);
      sendJSON(res, 200, { success: true, stats });
      return;
    }

    // [GET] /api/rooms/:pin (Phục vụ thông tin phòng - bảo mật sanitized)
    const clientRoom = roomsManager.getRoomForClient(pin, isHost);
    sendJSON(res, 200, { success: true, room: clientRoom });
    return;
  }

  // [POST] /api/rooms/:pin/leave
  if (method === 'POST' && pathname.includes('/leave')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/leave$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const body = await readJsonBody(req);
    const sessionUser = getSessionUser(req);
    const rawRoom = roomsManager.getRawRoom(pin);
    const isHost = isRoomHost(sessionUser, rawRoom);
    const result = roomsManager.removePlayer(pin, {
      id: body.id || body.playerId,
      playerToken: body.playerToken || req.headers['x-player-token'],
      isHost: !!isHost,
    });
    if (!result.success) {
      sendJSON(res, 403, result);
      return;
    }
    sendJSON(res, 200, { success: true });
    return;
  }

  // [POST] /api/rooms/:pin/kick - Host kick thí sinh
  if (method === 'POST' && pathname.includes('/kick')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/kick$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const hostCheck = requireRoomHost(req, pin);
    if (!hostCheck.ok) {
      sendJSON(res, hostCheck.status, { success: false, message: hostCheck.message });
      return;
    }
    const body = await readJsonBody(req);
    const playerId = body.playerId || body.id;
    const result = roomsManager.removePlayer(pin, { id: playerId, isHost: true });
    sendJSON(res, 200, result);
    return;
  }

  // [POST] /api/rooms/:pin/join
  if (method === 'POST' && pathname.includes('/join')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const body = await readJsonBody(req);
    const sessionUser = getSessionUser(req);
    const rawRoom = roomsManager.getRawRoom(pin);
    const isHost = isRoomHost(sessionUser, rawRoom);

    const result = roomsManager.addPlayer(pin, {
      id: body.id,
      nick: body.nick || (sessionUser ? sessionUser.username : 'Thí sinh'),
      av: body.av || '01',
      playerToken: body.playerToken || req.headers['x-player-token'],
      isHost: !!isHost,
    });

    if (!result.success) {
      sendJSON(res, 200, result);
      return;
    }

    sendJSON(res, 200, {
      success: true,
      player: result.player,
      players: (rawRoom && rawRoom.players ? rawRoom.players.map(p => roomsManager.sanitizePlayer(p)).filter(Boolean) : []),
      room: result.room || roomsManager.getRoomForClient(pin, isHost),
      title: (result.room && result.room.title) || (rawRoom && rawRoom.title) || '',
      status: (result.room && result.room.status) || (rawRoom && rawRoom.status) || 'waiting'
    });
    return;
  }

  // [POST] /api/rooms/:pin/advance - Chỉ Host authenticated
  if (method === 'POST' && pathname.includes('/advance')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/advance$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const hostCheck = requireRoomHost(req, pin);
    if (!hostCheck.ok) {
      sendJSON(res, hostCheck.status, { success: false, message: hostCheck.message });
      return;
    }
    const body = await readJsonBody(req);
    const resAdv = roomsManager.advanceQuestion(pin, body.nextQ, body.phase);
    if (!resAdv.success) {
      sendJSON(res, 400, resAdv);
      return;
    }
    sendJSON(res, 200, { success: true });
    return;
  }

  // [POST] /api/rooms/:pin/answer - Server-authoritative answer checking & scoring
  if (method === 'POST' && pathname.includes('/answer')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/answer$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const body = await readJsonBody(req);
    const result = roomsManager.submitAnswer(pin, {
      playerId: body.id || body.playerId,
      playerToken: body.playerToken || req.headers['x-player-token'],
      nick: body.nick,
      qIdx: Number(body.qIdx) || 0,
      choice: Number(body.choice),
      responseTimeMs: Number(body.responseTimeMs) || 0
    });
    sendJSON(res, 200, result);
    return;
  }

  // [POST] /api/rooms/:pin/score - Cập nhật avatar/metadata và lấy leaderboard (không nhận score)
  if (method === 'POST' && pathname.includes('/score')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/score$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const body = await readJsonBody(req);
    const result = roomsManager.updatePlayerMetadata(pin, {
      playerId: body.id || body.playerId,
      playerToken: body.playerToken || req.headers['x-player-token'],
      av: body.av
    });
    sendJSON(res, 200, result);
    return;
  }

  // [POST] /api/rooms/:pin/lock - Chỉ Host authenticated
  if (method === 'POST' && pathname.includes('/lock')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/lock$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const hostCheck = requireRoomHost(req, pin);
    if (!hostCheck.ok) {
      sendJSON(res, hostCheck.status, { success: false, message: hostCheck.message });
      return;
    }
    const body = await readJsonBody(req);
    const isLocked = Boolean(body.isLocked);
    const resLock = roomsManager.setRoomLock(pin, isLocked);
    sendJSON(res, 200, { success: resLock.success, isLocked });
    return;
  }

  // [POST] /api/rooms/:pin/start - Chỉ Host authenticated
  if (method === 'POST' && pathname.includes('/start')) {
    const match = pathname.match(/^\/api\/rooms\/([^/]+)\/start$/);
    if (!match) { sendJSON(res, 400, { success: false, message: 'Đường dẫn không hợp lệ' }); return; }
    const pin = match[1];
    const hostCheck = requireRoomHost(req, pin);
    if (!hostCheck.ok) {
      sendJSON(res, hostCheck.status, { success: false, message: hostCheck.message });
      return;
    }
    const body = await readJsonBody(req);
    const resStart = roomsManager.startRoom(pin, Number(body.countdownSec) || 5);
    if (!resStart.success) {
      sendJSON(res, 400, resStart);
      return;
    }
    sendJSON(res, 200, { success: true });
    return;
  }

  // [DELETE] /api/rooms/:pin - Kết thúc và lưu trữ phòng thi vào PostgreSQL (Chỉ Host authenticated)
  if (method === 'DELETE' && pathname.startsWith('/api/rooms/')) {
    const pin = pathname.replace('/api/rooms/', '');
    const hostCheck = requireRoomHost(req, pin);
    if (!hostCheck.ok) {
      sendJSON(res, hostCheck.status, { success: false, message: hostCheck.message });
      return;
    }
    await roomsManager.finishAndArchiveRoom(pin);
    roomsManager.deleteRoom(pin);
    sendJSON(res, 200, { success: true, deleted: true });
    return;
  }

  // [GET] /api/server-info
  if (method === 'GET' && pathname === '/api/server-info') {
    const lanIp = getServerLanIp();
    const publicUrl = process.env.APP_URL || (host ? `${proto}://${host}` : DEFAULT_APP_URL);
    sendJSON(res, 200, {
      success: true,
      lanIp,
      port: PORT,
      lanUrl: `http://${lanIp}:${PORT}`,
      publicUrl
    });
    return;
  }

  // ══════════════════════════════════════════════════════════
  // STATIC FILE SERVING
  // ══════════════════════════════════════════════════════════

  if (pathname.startsWith('/pin=') || pathname.startsWith('/pin/')) {
    const rawPin = pathname.replace(/^\/pin[=/]/, '');
    res.writeHead(302, { Location: '/index.html?pin=' + encodeURIComponent(rawPin) });
    res.end();
    return;
  }

  const PROTECTED_PAGES = new Set(['/dashboard.html', '/create-exam.html', '/create-room.html']);
  if (PROTECTED_PAGES.has(pathname) && !getSessionUser(req)) {
    res.writeHead(302, { Location: '/index.html?needLogin=1&redirect=' + encodeURIComponent(pathname) });
    res.end();
    return;
  }

  const safePath = path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[\/\\])+/, '');
  const fp = path.join(STATIC_DIR, safePath);

  if (!fp.startsWith(STATIC_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(fp);
  if (ext === '.html') {
    try {
      let content = fs.readFileSync(fp, 'utf8');
      const lanIp = getServerLanIp();
      const publicUrl = process.env.APP_URL || (host ? `${proto}://${host}` : DEFAULT_APP_URL);
      const injectScript = `<script>
(function() {
  try {
    var _origFetch = window.fetch;
    Object.defineProperty(window, 'fetch', {
      get: function() { return _origFetch; },
      set: function(fn) { _origFetch = fn; },
      configurable: true,
      enumerable: true
    });
  } catch (e) {}
  window.addEventListener('error', function(e) {
    if (e && e.message && e.message.indexOf('fetch') !== -1 && e.message.indexOf('getter') !== -1) {
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e.preventDefault) e.preventDefault();
      return true;
    }
  }, true);
})();
window.__SERVER_LAN_URL__ = "http://${lanIp}:${PORT}";
window.__SERVER_LAN_IP__ = "${lanIp}";
window.__SERVER_PUBLIC_URL__ = "${publicUrl}";
</script>`;
      if (content.includes('<head>')) {
        content = content.replace('<head>', `<head>\n  ${injectScript}`);
      } else {
        content = content.replace('</head>', `${injectScript}</head>`);
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext],
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(content);
      return;
    } catch (e) {}
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(fp).pipe(res);
});

// Khởi chạy server và nạp cấu trúc Database
async function startServer() {
  try {
    await runMigration();
    await auth.initAuth();
    console.log('🚀 [Database] Khởi tạo hệ thống PostgreSQL thành công!');
  } catch (err) {
    console.error('Lỗi khởi tạo Database:', err.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    const lanIp = getServerLanIp();
    const publicUrl = process.env.APP_URL || DEFAULT_APP_URL;
    console.log(`Mini Quiz Classroom server running at:`);
    console.log(`- Local:    http://localhost:${PORT}`);
    console.log(`- LAN:      http://${lanIp}:${PORT}`);
    console.log(`- Cloud:    ${publicUrl}`);
    console.log(`- Database: PostgreSQL (Single Source of Truth)`);
  });
}

startServer();
