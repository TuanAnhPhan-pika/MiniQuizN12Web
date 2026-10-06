// Quản lý phòng thi Multiplayer (Room Manager Abstraction)
// Lưu trữ trạng thái realtime trong memory, sẵn sàng chuyển đổi sang Redis khi scale lớn.
// Persistent data được lưu tự động vào PostgreSQL: game_sessions & game_players.

const crypto = require('crypto');
const db = require('../db/index.js');

const ROOM_EXPIRE_MS = 4 * 60 * 60 * 1000; // 4 giờ
const activeRooms = new Map(); // pin -> room object

function generatePin() {
  const p1 = Math.floor(100 + Math.random() * 900);
  const p2 = Math.floor(100 + Math.random() * 900);
  return `${p1}-${p2}`;
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [pin, room] of activeRooms.entries()) {
    if (room.createdAt && (now - room.createdAt > ROOM_EXPIRE_MS)) {
      activeRooms.delete(pin);
    }
  }
}

// Chạy dọn dẹp phòng hết hạn mỗi 10 phút
setInterval(cleanupExpiredRooms, 10 * 60 * 1000);

async function createRoom({ hostUsername, exam, capacity = 40, isLocked = false, title = '' }) {
  cleanupExpiredRooms();
  let pin = generatePin();
  let attempts = 0;
  while (activeRooms.has(pin) && attempts < 10) {
    pin = generatePin();
    attempts++;
  }

  const now = Date.now();
  const roomTitle = title || exam.title || 'Phòng thi trực tuyến';
  const questions = (exam && Array.isArray(exam.questions)) ? exam.questions : [];
  const hostToken = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();

  const room = {
    sessionId,
    pin,
    examId: exam.id || null,
    title: roomTitle,
    capacity: Number(capacity) || 40,
    isLocked: !!isLocked,
    hostUsername: String(hostUsername || 'admin').toLowerCase(),
    hostToken,
    status: 'waiting', // waiting, countdown, started, finished
    phase: 'question',
    currentQ: 0,
    phaseStartedAt: now,
    countdownEnd: 0,
    createdAt: now,
    questions: questions,
    players: [
      {
        id: `host-${hostUsername}`,
        playerToken: hostToken,
        nick: hostUsername,
        av: '01',
        score: 0,
        currentQ: 0,
        isHost: true,
        accountUsername: hostUsername,
        joinedAt: now,
        lastUpdated: now,
      }
    ],
    answers: {}, // qIdx -> { [playerId]: record }
  };

  activeRooms.set(pin, room);
  return room;
}

function getRawRoom(pin) {
  cleanupExpiredRooms();
  return activeRooms.get(pin) || null;
}

/**
 * Helper sanitize thông tin người chơi:
 * TUYỆT ĐỐI KHÔNG để lộ playerToken, hostToken ra ngoài!
 */
function sanitizePlayer(player) {
  if (!player) return null;
  return {
    id: player.id,
    nick: player.nick,
    av: player.av || '01',
    score: Number(player.score) || 0,
    currentQ: Number(player.currentQ) || 0,
    streak: Number(player.streak) || 0,
    isHost: !!player.isHost,
    joinedAt: player.joinedAt,
    lastUpdated: player.lastUpdated,
  };
}

/**
 * So sánh token bảo mật chống timing-attack
 */
function safeCompareTokens(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Trả về thông tin phòng đã được sanitize bảo mật:
 * 1. KHÔNG gửi `correct` hoặc `is_correct` xuống client thí sinh trước khi bài thi kết thúc!
 * 2. KHÔNG BAO GIỜ để lộ `playerToken` của bất kỳ người chơi nào trong danh sách players!
 */
function getRoomForClient(pin, isHost = false) {
  const room = getRawRoom(pin);
  if (!room) return null;

  // Sanitize danh sách players: bảo mật tuyệt đối playerToken
  const sanitizedPlayers = (room.players || []).map(p => sanitizePlayer(p)).filter(Boolean);

  if (isHost) {
    return {
      sessionId: room.sessionId,
      pin: room.pin,
      examId: room.examId,
      title: room.title,
      capacity: room.capacity,
      isLocked: room.isLocked,
      hostUsername: room.hostUsername,
      status: room.status,
      phase: room.phase,
      currentQ: room.currentQ,
      phaseStartedAt: room.phaseStartedAt,
      countdownEnd: room.countdownEnd,
      createdAt: room.createdAt,
      players: sanitizedPlayers,
      questions: room.questions,
    };
  }

  // Sanitize cho thí sinh: ẩn đáp án đúng
  const sanitizedQuestions = (room.questions || []).map(q => ({
    id: q.id,
    versionId: q.versionId,
    text: q.text,
    choices: q.choices,
    explanation: room.status === 'finished' ? (q.explanation || '') : '',
    image: q.image || '',
    points: q.points || 100,
    timeLimit: q.timeLimit || 15,
    ...(room.status === 'finished' ? { correct: q.correct } : {})
  }));

  return {
    sessionId: room.sessionId,
    pin: room.pin,
    examId: room.examId,
    title: room.title,
    capacity: room.capacity,
    isLocked: room.isLocked,
    hostUsername: room.hostUsername,
    status: room.status,
    phase: room.phase,
    currentQ: room.currentQ,
    phaseStartedAt: room.phaseStartedAt,
    countdownEnd: room.countdownEnd,
    createdAt: room.createdAt,
    players: sanitizedPlayers,
    questions: sanitizedQuestions,
  };
}

function verifyPlayer(room, playerId, playerToken) {
  if (!room || !playerId || !playerToken) return null;
  const player = (room.players || []).find(p => p.id === playerId);
  if (!player || !player.playerToken) return null;
  if (!safeCompareTokens(player.playerToken, playerToken)) {
    return null;
  }
  return player;
}

function addPlayer(pin, { id, nick, av = '01', playerToken, isHost = false, accountUserId = null, accountUsername = null }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng thi không tồn tại' };

  if (room.isLocked && !isHost) {
    return { success: false, locked: true, message: 'Phòng thi đang bị khóa' };
  }

  const candidates = (room.players || []).filter(p => !p.isHost);
  if (!isHost && candidates.length >= room.capacity) {
    return { success: false, full: true, message: 'Phòng đã đạt giới hạn người tham gia' };
  }

  const now = Date.now();
  const nickClean = (nick || 'Thí sinh').trim().slice(0, 25);
  const nickLower = nickClean.toLowerCase();

  const existingByNick = room.players.find(p => !p.isHost && p.nick.toLowerCase() === nickLower);
  const existingById = id ? room.players.find(p => !p.isHost && p.id === id) : null;
  const existing = existingById || existingByNick;

  if (existing) {
    // Reconnect case: bắt buộc phải có playerToken và khớp token cũ
    if (!playerToken || !safeCompareTokens(existing.playerToken, playerToken)) {
      return { success: false, message: 'Nickname này đã có người sử dụng trong phòng!' };
    }
    // Reconnect thành công: cập nhật thời gian, không overwrite ID bằng ID mới lạ
    existing.lastUpdated = now;
    if (av) existing.av = av;
    if (accountUserId) existing.accountUserId = accountUserId;
    if (accountUsername) existing.accountUsername = accountUsername;

    return {
      success: true,
      player: {
        id: existing.id,
        nick: existing.nick,
        av: existing.av,
        playerToken: existing.playerToken,
      },
      room: getRoomForClient(pin, isHost)
    };
  }

  // Thí sinh mới: sinh playerToken ngẫu nhiên
  const newToken = crypto.randomBytes(32).toString('hex');
  const newPlayer = {
    id: id || `p-${now}-${Math.random().toString(36).slice(2, 6)}`,
    playerToken: newToken,
    nick: nickClean,
    av: av || '01',
    score: 0,
    currentQ: 0,
    streak: 0,
    maxStreak: 0,
    isHost: !!isHost,
    accountUserId: accountUserId || null,
    accountUsername: accountUsername || null,
    joinedAt: now,
    lastUpdated: now,
  };
  room.players.push(newPlayer);

  return {
    success: true,
    player: {
      id: newPlayer.id,
      nick: newPlayer.nick,
      av: newPlayer.av,
      playerToken: newPlayer.playerToken, // Chỉ trả token bí mật này về cho đúng người vừa join
    },
    room: getRoomForClient(pin, isHost)
  };
}

function removePlayer(pin, { id, playerToken, isHost = false }) {
  const room = getRawRoom(pin);
  if (!room || !id) return { success: false, message: 'Phòng không tồn tại hoặc thiếu id' };

  // Xác thực quyền rời phòng: thí sinh chỉ được rời chính mình với token hợp lệ
  if (!isHost) {
    const verified = verifyPlayer(room, id, playerToken);
    if (!verified) {
      return { success: false, message: 'Không có quyền thao tác' };
    }
  }

  room.players = (room.players || []).filter(p => {
    if (p.isHost) return true;
    if (id && p.id === id) return false;
    return true;
  });

  return { success: true };
}

function setRoomLock(pin, isLocked) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng không tồn tại' };
  room.isLocked = Boolean(isLocked);
  return { success: true, isLocked: room.isLocked };
}

function startRoom(pin, countdownSec = 5) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng không tồn tại' };
  if (room.status !== 'waiting' && room.status !== 'countdown') {
    return { success: false, message: 'Phòng thi không ở trạng thái có thể bắt đầu' };
  }
  const sec = Math.max(1, Math.min(60, Number(countdownSec) || 5));
  room.status = 'countdown';
  room.countdownEnd = Date.now() + (sec * 1000);
  room.currentQ = 0;
  room.phase = 'question';
  room.phaseStartedAt = room.countdownEnd;
  return { success: true };
}

function advanceQuestion(pin, nextQIndex, phase = 'question') {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng không tồn tại' };
  const validPhases = ['question', 'result'];
  const targetPhase = validPhases.includes(phase) ? phase : 'question';
  const qNum = Number(nextQIndex);
  const totalQuestions = (room.questions || []).length;
  if (!Number.isInteger(qNum) || qNum < 0 || (totalQuestions > 0 && qNum >= totalQuestions)) {
    return { success: false, message: 'Chỉ số câu hỏi không hợp lệ' };
  }
  room.currentQ = qNum;
  room.phase = targetPhase;
  room.phaseStartedAt = Date.now();
  if (room.status !== 'started') room.status = 'started';
  return { success: true };
}

/**
 * Xử lý nộp câu trả lời từ thí sinh với logic Server-authoritative:
 * 1. Chống submit duplicate: một player chỉ nộp 1 lần cho 1 câu hỏi.
 * 2. Xác thực Player Authorization qua playerToken bí mật.
 * 3. Kiểm tra trạng thái phòng: status='started', phase='question', qIdx===room.currentQ.
 * 4. Không tin responseTimeMs từ client: Server tự đo đạc và clamp vào [0, timeLimit*1000].
 * 5. Validate choice: phải là số nguyên nằm trong dải [0, question.choices.length - 1].
 * 6. Tính điểm độc quyền ở backend.
 */
function submitAnswer(pin, { playerId, playerToken, qIdx, choice }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng thi không tồn tại' };

  // 1. Xác thực danh tính thí sinh qua token
  const player = verifyPlayer(room, playerId, playerToken);
  if (!player) {
    return { success: false, unauthorized: true, message: 'Thí sinh không hợp lệ hoặc token không đúng!' };
  }

  // 2. Kiểm tra trạng thái phòng thi và câu hỏi
  if (room.status !== 'started') {
    return { success: false, rejected: true, message: 'Phòng thi chưa bắt đầu hoặc đã kết thúc!' };
  }

  if (room.phase !== 'question') {
    return { success: false, rejected: true, message: 'Hiện không ở giai đoạn trả lời câu hỏi!' };
  }

  if (Number(qIdx) !== Number(room.currentQ)) {
    return { success: false, rejected: true, message: `Câu hỏi ${qIdx + 1} không khớp với câu đang mở (${room.currentQ + 1})!` };
  }

  const question = (room.questions && room.questions[qIdx]) || null;
  if (!question || !Array.isArray(question.choices)) {
    return { success: false, message: 'Dữ liệu câu hỏi không hợp lệ!' };
  }

  // 3. Validate đáp án choice
  const choiceNum = Number(choice);
  if (!Number.isInteger(choiceNum) || choiceNum < 0 || choiceNum >= question.choices.length) {
    return { success: false, invalidChoice: true, message: 'Lựa chọn đáp án nằm ngoài phạm vi câu hỏi!' };
  }

  // 4. Chống nộp trùng lặp (Anti-duplicate submission)
  room.answers = room.answers || {};
  room.answers[qIdx] = room.answers[qIdx] || {};

  if (room.answers[qIdx][player.id]) {
    return { success: false, duplicate: true, message: 'Bạn đã nộp đáp án cho câu này rồi!' };
  }

  // 5. Server tự tính responseTimeMs chuẩn xác
  const now = Date.now();
  const rawElapsed = now - (room.phaseStartedAt || now);
  const timeLimitMs = (question.timeLimit || 15) * 1000;
  const serverResponseTimeMs = Math.max(0, Math.min(rawElapsed, timeLimitMs));

  // 6. Chấm điểm server-authoritative
  const correctChoice = question.correct;
  const isCorrect = (typeof question.correct === 'number') ? (question.correct === choiceNum) : false;

  let scoreAwarded = 0;
  const streakBefore = player.streak || 0;
  let streakAfter = 0;

  if (isCorrect) {
    streakAfter = streakBefore + 1;
    player.streak = streakAfter;
    if (streakAfter > (player.maxStreak || 0)) {
      player.maxStreak = streakAfter;
    }

    const basePoints = question.points || 100;
    const timeElapsedSec = serverResponseTimeMs / 1000;
    const timeLimitSec = question.timeLimit || 15;
    const speedFactor = Math.max(0.5, 1 - (timeElapsedSec / (timeLimitSec * 2)));
    const streakBonus = Math.min(50, (streakAfter - 1) * 10);
    scoreAwarded = Math.round((basePoints * speedFactor) + streakBonus);

    player.score = (player.score || 0) + scoreAwarded;
  } else {
    player.streak = 0;
    streakAfter = 0;
    scoreAwarded = 0;
  }

  player.currentQ = qIdx;
  player.lastUpdated = now;

  const record = {
    playerId: player.id,
    nick: player.nick,
    choice: choiceNum,
    isCorrect,
    scoreAwarded,
    responseTimeMs: serverResponseTimeMs,
    streakBefore,
    streakAfter,
    answeredAt: now,
  };

  room.answers[qIdx][player.id] = record;

  return {
    success: true,
    qIdx,
    choice: choiceNum,
    isCorrect,
    correctChoice,
    scoreEarned: scoreAwarded,
    newTotalScore: player.score,
    streak: streakAfter,
  };
}

/**
 * Cập nhật Metadata hiển thị (Avatar, UI State).
 * TUYỆT ĐỐI KHÔNG NHẬN `score`, `streak` TỪ CLIENT!
 */
function updatePlayerMetadata(pin, { playerId, playerToken, av }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng không tồn tại' };

  const player = verifyPlayer(room, playerId, playerToken);
  if (!player) {
    return { success: false, unauthorized: true, message: 'Không thể xác thực thí sinh' };
  }

  if (av) player.av = av;
  player.lastUpdated = Date.now();

  return {
    success: true,
    player: {
      id: player.id,
      nick: player.nick,
      av: player.av,
      score: player.score,
    },
    leaderboard: getLeaderboard(pin)
  };
}

function getLeaderboard(pin) {
  const room = getRawRoom(pin);
  if (!room) return [];

  return (room.players || [])
    .filter(p => !p.isHost)
    .map(p => ({
      id: p.id,
      nick: p.nick,
      av: p.av || '01',
      score: Number(p.score) || 0,
      currentQ: Number(p.currentQ) || 0,
      streak: p.streak || 0,
      lastUpdated: p.lastUpdated || 0,
    }))
    .sort((a, b) => (b.score - a.score) || (a.lastUpdated - b.lastUpdated));
}

function calculateExamStats(room) {
  const candidates = (room.players || []).filter(p => !p.isHost);
  const totalQuestions = (room.questions || []).length;
  const maxPossibleScore = totalQuestions * 100;
  const scores = candidates.map(c => Number(c.score) || 0);
  const avgScore = candidates.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / candidates.length) : 0;
  const maxScore = candidates.length > 0 ? Math.max(...scores) : 0;
  const topCandidate = candidates.find(c => (Number(c.score) || 0) === maxScore);

  const questionsStats = (room.questions || []).map((q, qIdx) => {
    const answersForQ = (room.answers && room.answers[qIdx]) || {};
    const countedIds = new Set();
    let correctCount = 0;
    Object.values(answersForQ).forEach(ans => {
      const idKey = ans.playerId;
      if (idKey && !countedIds.has(idKey)) {
        countedIds.add(idKey);
        if (ans.isCorrect) correctCount++;
      }
    });
    const totalCount = candidates.length;
    const ratioPct = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
    return {
      qIdx: qIdx + 1,
      text: q.text || ('Câu ' + (qIdx + 1)),
      correctIndex: q.correct,
      correctText: (q.choices && q.choices[q.correct] !== undefined) ? q.choices[q.correct] : '',
      correctCount,
      totalCount,
      ratioPct,
    };
  });

  const candidatesMatrix = candidates.map(c => {
    const answersMap = [];
    let correctCount = 0;
    for (let qIdx = 0; qIdx < totalQuestions; qIdx++) {
      const ans = room.answers && room.answers[qIdx] && room.answers[qIdx][c.id];
      const isCorrect = ans ? !!ans.isCorrect : false;
      if (isCorrect) correctCount++;
      answersMap.push(isCorrect);
    }
    const ratioPct = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
    return {
      id: c.id,
      nick: c.nick,
      av: c.av || '01',
      score: Number(c.score) || 0,
      answersMap,
      correctCount,
      totalQuestions,
      ratioPct,
    };
  });

  candidatesMatrix.sort((a, b) => b.score - a.score);

  return {
    totalCandidates: candidates.length,
    capacity: Number(room.capacity) || 40,
    avgScore,
    maxScore,
    maxPossibleScore,
    topCandidateNick: topCandidate ? topCandidate.nick : '',
    questionsStats,
    candidatesMatrix,
  };
}

/**
 * Kết thúc phòng thi và lưu trữ dài hạn vào PostgreSQL
 */
async function finishAndArchiveRoom(pin) {
  const room = getRawRoom(pin);
  if (!room) return null;

  room.status = 'finished';
  const stats = calculateExamStats(room);

  // Chỉ lưu trữ vào database 1 lần duy nhất, tránh duplicate game session
  if (room.isArchived) {
    return { room, stats };
  }
  room.isArchived = true;

  const now = Date.now();
  const sessionRecord = {
    id: room.sessionId || `hosted-${room.pin}-${now}`,
    pin: room.pin,
    quizId: room.examId,
    roomTitle: room.title,
    capacity: room.capacity,
    createdAt: room.createdAt,
    finishedAt: now,
    formattedTime: new Date(now).toLocaleString('vi-VN'),
    stats: stats,
  };

  try {
    await db.saveHostedGameSession(room.hostUsername, sessionRecord);
    console.log(`💾 [Multiplayer] Đã lưu phòng thi ${room.pin} vào PostgreSQL game_sessions & game_players!`);
  } catch (err) {
    console.error('Lỗi lưu game session vào PostgreSQL:', err.message);
  }

  return { room, stats };
}

function deleteRoom(pin) {
  return activeRooms.delete(pin);
}

module.exports = {
  createRoom,
  getRawRoom,
  getRoomForClient,
  sanitizePlayer,
  verifyPlayer,
  addPlayer,
  removePlayer,
  setRoomLock,
  startRoom,
  advanceQuestion,
  submitAnswer,
  updatePlayerMetadata,
  updatePlayerScore: updatePlayerMetadata, // Alias backwards-compatible
  getLeaderboard,
  calculateExamStats,
  finishAndArchiveRoom,
  deleteRoom,
};
