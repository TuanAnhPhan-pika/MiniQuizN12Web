// Quản lý phòng thi Multiplayer (Room Manager Abstraction)
// Lưu trữ trạng thái realtime trong memory, sẵn sàng chuyển đổi sang Redis khi scale lớn.
// Persistent data được lưu tự động vào PostgreSQL: game_sessions & game_players.

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

  const room = {
    pin,
    examId: exam.id || null,
    title: roomTitle,
    capacity: Number(capacity) || 40,
    isLocked: !!isLocked,
    hostUsername: String(hostUsername || 'admin').toLowerCase(),
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
 * KHÔNG gửi `correct` hoặc `is_correct` xuống client thí sinh trước khi trả lời!
 */
function getRoomForClient(pin, isHost = false) {
  const room = getRawRoom(pin);
  if (!room) return null;

  if (isHost) {
    return room;
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
    // Chỉ kèm correct nếu bài thi đã hoàn thành hoặc host cho phép reveal
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
    players: room.players,
    questions: sanitizedQuestions,
  };
}

function addPlayer(pin, { id, nick, av = '01', isHost = false }) {
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
  let player = room.players.find(p => (id && p.id === id) || (p.nick.toLowerCase() === nick.toLowerCase()));
  if (player) {
    player.lastUpdated = now;
    player.av = av;
    if (id) player.id = id;
  } else {
    player = {
      id: id || `p-${now}-${Math.random().toString(36).slice(2, 6)}`,
      nick: nick.slice(0, 25),
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

  return { success: true, player, room };
}

function removePlayer(pin, { id, nick }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false };

  room.players = room.players.filter(p => {
    if (p.isHost) return true;
    if (id && p.id === id) return false;
    if (nick && p.nick.toLowerCase() === nick.toLowerCase()) return false;
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
 * Xử lý nộp câu trả lời từ thí sinh với logic xác thực Server-authoritative:
 * Backend kiểm tra tính đúng/sai, tính điểm số, tính streak và speed bonus.
 */
function submitAnswer(pin, { playerId, nick, qIdx, choice, responseTimeMs = 0 }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng thi không tồn tại' };

  room.answers = room.answers || {};
  room.answers[qIdx] = room.answers[qIdx] || {};

  const question = (room.questions && room.questions[qIdx]) || null;
  const correctChoice = question ? question.correct : -1;
  const isCorrect = (question && typeof question.correct === 'number') ? (question.correct === choice) : false;

  // Tìm player để cập nhật score và streak
  const player = room.players.find(p => (playerId && p.id === playerId) || (p.nick.toLowerCase() === (nick || '').toLowerCase()));
  
  let scoreAwarded = 0;
  let streakBefore = 0;
  let streakAfter = 0;

  if (player) {
    streakBefore = player.streak || 0;
    if (isCorrect) {
      streakAfter = streakBefore + 1;
      player.streak = streakAfter;
      if (streakAfter > (player.maxStreak || 0)) {
        player.maxStreak = streakAfter;
      }

      // Tính điểm với hệ số thời gian (Speed Bonus) và Streak bonus
      // Base points: 100
      const basePoints = question.points || 100;
      const timeElapsedSec = Math.max(0, responseTimeMs / 1000);
      const timeLimit = question.timeLimit || 15;
      const speedFactor = Math.max(0.5, 1 - (timeElapsedSec / (timeLimit * 2)));
      const streakBonus = Math.min(50, (streakAfter - 1) * 10); // thưởng tối đa 50đ nếu chuỗi dài
      scoreAwarded = Math.round((basePoints * speedFactor) + streakBonus);

      player.score = (player.score || 0) + scoreAwarded;
    } else {
      streakAfter = 0;
      player.streak = 0;
      scoreAwarded = 0;
    }
    player.currentQ = qIdx;
    player.lastUpdated = Date.now();
  }

  const record = {
    playerId: playerId || (player ? player.id : ''),
    nick: nick || (player ? player.nick : 'Thí sinh'),
    choice,
    isCorrect,
    scoreAwarded,
    responseTimeMs,
    streakBefore,
    streakAfter,
    answeredAt: Date.now(),
  };

  const idKey = record.playerId || record.nick;
  if (idKey) {
    room.answers[qIdx][idKey] = record;
  }

  return {
    success: true,
    qIdx,
    choice,
    isCorrect,
    correctChoice,
    scoreEarned: scoreAwarded,
    newTotalScore: player ? player.score : 0,
    streak: streakAfter,
  };
}

/**
 * Cập nhật điểm của player (được gọi từ client nếu client muốn đồng bộ điểm)
 */
function updatePlayerScore(pin, { playerId, nick, av, score, currentQ }) {
  const room = getRawRoom(pin);
  if (!room) return { success: false, message: 'Phòng không tồn tại' };

  const now = Date.now();
  let player = room.players.find(p => (playerId && p.id === playerId) || (p.nick.toLowerCase() === (nick || '').toLowerCase() && !p.isHost));
  if (player) {
    // Nếu điểm từ backend đã tính thì giữ giá trị lớn hơn để bảo toàn công bằng
    if (score !== undefined) player.score = Math.max(player.score || 0, Number(score) || 0);
    if (currentQ !== undefined) player.currentQ = Number(currentQ) || 0;
    if (av) player.av = av;
    player.lastUpdated = now;
  } else {
    player = {
      id: playerId || `p-${now}-${Math.random().toString(36).slice(2, 6)}`,
      nick: (nick || 'Thí sinh').slice(0, 25),
      av: av || '01',
      score: Number(score) || 0,
      currentQ: Number(currentQ) || 0,
      streak: 0,
      maxStreak: 0,
      isHost: false,
      joinedAt: now,
      lastUpdated: now,
    };
    room.players.push(player);
  }

  const leaderboard = getLeaderboard(pin);
  return { success: true, player, leaderboard };
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
      const idKey = ans.playerId || ans.nick;
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
      const ans = room.answers && room.answers[qIdx] && (room.answers[qIdx][c.id] || room.answers[qIdx][c.nick]);
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
  addPlayer,
  removePlayer,
  setRoomLock,
  startRoom,
  advanceQuestion,
  submitAnswer,
  updatePlayerScore,
  getLeaderboard,
  calculateExamStats,
  finishAndArchiveRoom,
  deleteRoom,
};
