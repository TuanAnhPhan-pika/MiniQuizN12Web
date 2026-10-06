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

  const room = {
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
 * Trả về thông tin phòng đã được sanitize bảo mật:
 * 1. KHÔNG gửi `correct` hoặc `is_correct` xuống client thí sinh trước khi bài thi kết thúc!
 * 2. KHÔNG BAO GIỜ để lộ `playerToken` của bất kỳ người chơi nào trong danh sách players!
 */
function getRoomForClient(pin, isHost = false) {
  const room = getRawRoom(pin);
  if (!room) return null;

  // Sanitize danh sách players: bảo mật tuyệt đối playerToken
  const sanitizedPlayers = (room.players || []).map(p => ({
    id: p.id,
    nick: p.nick,
    av: p.av,
    score: Number(p.score) || 0,
    currentQ: Number(p.currentQ) || 0,
    streak: Number(p.streak) || 0,
    isHost: !!p.isHost,
    joinedAt: p.joinedAt,
    lastUpdated: p.lastUpdated,
  }));

  if (isHost) {
    return {
      ...room,
      players: sanitizedPlayers,
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
  if (!room || !playerId) return null;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return null;
  // Nếu thí sinh có token, bắt buộc phải khớp token bí mật
  if (player.playerToken && playerToken && player.playerToken === playerToken) {
    return player;
  }
  // Host bypass nếu là host
  if (player.isHost && player.playerToken === playerToken) {
    return player;
  }
  return null;
}

function addPlayer(pin, { id, nick, av = '01', playerToken, isHost = false }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng thi không tồn tại' };

  if (room.isLocked && !isHost) {
    return { success: false, locked: true, message: 'Phòng thi đang bị khóa' };
  }

  const candidates = room.players.filter(p => !p.isHost);
  if (!isHost && candidates.length >= room.capacity) {
    return { success: false, full: true, message: 'Phòng đã đạt giới hạn người tham gia' };
  }

  const now = Date.now();
  let player = room.players.find(p => (id && p.id === id) || (p.nick.toLowerCase() === (nick || '').toLowerCase()));

  if (player) {
    // Nếu player đã tồn tại trong phòng và token hợp lệ, cho phép reconnect
    if (playerToken && player.playerToken && player.playerToken !== playerToken) {
      return { success: false, message: 'Nickname này đã có người sử dụng trong phòng!' };
    }
    player.lastUpdated = now;
    player.av = av;
    if (id) player.id = id;
    if (!player.playerToken) {
      player.playerToken = playerToken || crypto.randomBytes(32).toString('hex');
    }
  } else {
    const newToken = playerToken || crypto.randomBytes(32).toString('hex');
    player = {
      id: id || `p-${now}-${Math.random().toString(36).slice(2, 6)}`,
      playerToken: newToken,
      nick: (nick || 'Thí sinh').slice(0, 25),
      av: av,
      score: 0,
      currentQ: 0,
      streak: 0,
      maxStreak: 0,
      isHost: !!isHost,
      joinedAt: now,
      lastUpdated: now,
    };
    room.players.push(player);
  }

  return {
    success: true,
    player: {
      id: player.id,
      nick: player.nick,
      av: player.av,
      playerToken: player.playerToken, // Chỉ trả token bí mật này về cho đúng người vừa join
    },
    room: getRoomForClient(pin, isHost)
  };
}

function removePlayer(pin, { id, playerToken, isHost = false }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false };

  // Xác thực quyền rời phòng: chỉ rời được chính mình trừ khi là Host
  const player = room.players.find(p => p.id === id);
  if (player && !isHost) {
    if (player.playerToken && playerToken && player.playerToken !== playerToken) {
      return { success: false, message: 'Không có quyền thao tác' };
    }
  }

  room.players = room.players.filter(p => {
    if (p.isHost) return true;
    if (id && p.id === id) return false;
    return true;
  });

  return { success: true };
}

function setRoomLock(pin, isLocked) {
  const room = getRawRoom(pin);
  if (!room) return false;
  room.isLocked = !!isLocked;
  return true;
}

function startRoom(pin, countdownSec = 5) {
  const room = getRawRoom(pin);
  if (!room) return false;
  room.status = 'countdown';
  room.countdownEnd = Date.now() + (countdownSec * 1000);
  room.currentQ = 0;
  room.phase = 'question';
  room.phaseStartedAt = room.countdownEnd;
  return true;
}

function advanceQuestion(pin, nextQIndex, phase = 'question') {
  const room = getRawRoom(pin);
  if (!room) return false;
  room.currentQ = nextQIndex;
  room.phase = phase;
  room.phaseStartedAt = Date.now();
  if (room.status !== 'started') room.status = 'started';
  return true;
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
  const now = Date.now();

  const sessionRecord = {
    id: `hosted-${room.pin}-${now}`,
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
