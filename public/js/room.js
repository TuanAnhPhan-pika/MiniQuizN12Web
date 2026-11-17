/* ════════════════════════════════════════════
   DATA
   ════════════════════════════════════════════ */
let QUESTIONS = [
  { text: 'Con chó có mấy chân?', choices: ['3','2','4','5'], correct: 2 },
  { text: '2 + 2 = ?',            choices: ['2','5','4','8'], correct: 2 },
  { text: 'Con nào biết bay?',    choices: ['Heo','Chó','Cú','Bò'], correct: 2 }
];

const LETTERS        = ['A','B','C','D','E','F','G'];
const MAX_SCORE      = 100;
let TIMER_SECS       = 15;
const TICK_MS        = 250;

const params   = new URLSearchParams(location.search);
const PIN      = params.get('pin')  || '---';
const NICKNAME = params.get('nick') || 'Bạn';
const AVATAR   = params.get('av')   || '01';
let localPractice = false;
let EXAM_TITLE = 'Đề thi Toán & Logic';
let EXAM_ID = params.get('examId') || '';

// Load custom room questions if available
try {
  const roomPin = params.get('pin');
  const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
  if (roomPin && customRooms[roomPin] && Array.isArray(customRooms[roomPin].questions) && customRooms[roomPin].questions.length > 0) {
    QUESTIONS = customRooms[roomPin].questions;
    localPractice = roomPin.startsWith('TEST-') && customRooms[roomPin].isTest === true;
    if (customRooms[roomPin].title) {
      EXAM_TITLE = customRooms[roomPin].title;
    }
    if (customRooms[roomPin].id || customRooms[roomPin].examId) {
      EXAM_ID = customRooms[roomPin].id || customRooms[roomPin].examId;
    }
    if (customRooms[roomPin].timePerQ) {
      TIMER_SECS = customRooms[roomPin].timePerQ;
    }
  }
} catch(e) {}

// ID định danh thí sinh trong phiên thi đấu (Scope theo PIN phòng)
let myPlayerId = sessionStorage.getItem('mqc_my_player_id_' + PIN);
if (!myPlayerId) {
  myPlayerId = 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  sessionStorage.setItem('mqc_my_player_id_' + PIN, myPlayerId);
}
let myPlayerToken = sessionStorage.getItem('mqc_my_player_token_' + PIN) || '';

// Bảng xếp hạng thí sinh thực tế đồng bộ từ server
let liveLeaderboard = [
  { id: myPlayerId, name: NICKNAME, score: 0, isYou: true, av: AVATAR }
];

/* ════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════ */
let currentQ     = 0;
let totalScore   = 0;
let timerInterval = null;
let timerStartTimeout = null;
let autoNextTimeout = null;
let revealTimeout = null;
let playerStateInterval = null;
let isRevealing   = false;
let ticksElapsed  = 0;
let answered      = false;
let timedOutLocked = false;
let earnedThisQ   = 0;   // điểm tính từ lúc bấm — lưu lại khi timer vẫn chạy
let selectedChoice = -1;  // lưu lựa chọn của người chơi, chỉ hiển thị đúng/sai khi hết giờ
let selectedChoices = []; // mảng đáp án đã chọn cho câu nhiều đáp án
let serverClockOffset = 0;   // serverNow - Date.now() (UTC offset sync)
let questionDeadlineMs = 0;  // server UTC timestamp khi hết giờ câu hiện tại
let questionStartedAtMs = 0; // server UTC timestamp khi bắt đầu câu hiện tại
let localQuestionStartMs = 0;
let userAnswers   = [];   // lưu lịch sử làm bài chi tiết { questionIndex, questionType, userChoice, userChoices, correctChoices, isCorrect, earned }
let lastSortedRank = [];  // lưu bảng xếp hạng cuối cùng
let myFinalRank   = 1;

function getCorrectChoices(q) {
  if (!q) return [];
  const maxLen = Array.isArray(q.choices) ? q.choices.length : 10;
  if (Array.isArray(q.correctChoices) && q.correctChoices.length > 0) {
    return Array.from(new Set(q.correctChoices.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < maxLen))).sort((a, b) => a - b);
  }
  if (typeof q.correct === 'number' && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < maxLen) {
    return [q.correct];
  }
  return [];
}

function isMultiQuestion(q) {
  return Boolean(q && (q.isMultiple || getCorrectChoices(q).length > 1));
}

function syncServerClock(data) {
  if (!data || typeof data !== 'object') return;
  if (typeof data.serverNow === 'number' && data.serverNow > 0) {
    serverClockOffset = data.serverNow - Date.now();
  }
  if (Number(data.currentQ) === currentQ) {
    if (typeof data.questionDeadline === 'number' && data.questionDeadline > 0) {
      questionDeadlineMs = data.questionDeadline;
    }
    if (typeof data.questionStartedAt === 'number' && data.questionStartedAt > 0) {
      questionStartedAtMs = data.questionStartedAt;
    }
  }
}

/* ════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════ */
(function init() {
  /* Dark mode */
  (function () {
    const btn = document.getElementById('btn-dark');
    if (localStorage.getItem('mqc-dark') === '1') document.body.classList.add('dark');
    buildStars();
    if (btn) btn.addEventListener('click', function () {
      document.body.classList.toggle('dark');
      localStorage.setItem('mqc-dark', document.body.classList.contains('dark') ? '1' : '0');
    });
    function buildStars() {
      const el = document.getElementById('stars');
      if (!el) return;
      for (let i = 0; i < 60; i++) {
        const s = document.createElement('div');
        s.className = 'star';
        const size = Math.random() * 2.5 + 1;
        s.style.cssText = 'width:'+size+'px;height:'+size+'px;top:'+(Math.random()*90)+'%;left:'+(Math.random()*100)+'%;animation-delay:'+(Math.random()*3)+'s;animation-duration:'+(Math.random()*2+1.5)+'s';
        el.appendChild(s);
      }
    }
  })();

  /* Colorize title */
  const el = document.getElementById('app-title');
  el.innerHTML = [...'Mini Quiz Classroom'].map(ch =>
    ch === ' ' ? '<span class="space"> </span>' : '<span>' + ch + '</span>'
  ).join('');

  /* Check User Auth to update header */
  checkUserInRoom();

  /* Load questions & sync from server */
  syncRoomFromServer().then((isFinished) => {
    if (isFinished) {
      // Đã kết thúc đề thi hoặc vừa reload khi xem báo cáo: Khôi phục ngay báo cáo
      const savedScore = sessionStorage.getItem('mqc_total_score_' + PIN);
      if (savedScore !== null) totalScore = Number(savedScore);
      const savedAnswers = sessionStorage.getItem('mqc_user_answers_' + PIN);
      if (savedAnswers) {
        try { userAnswers = JSON.parse(savedAnswers); } catch(e) {}
      }
      const savedRank = Number(sessionStorage.getItem('mqc_final_rank_' + PIN)) || 1;
      showFinal([], savedRank).then(() => {
        if (sessionStorage.getItem('mqc_view_panel_' + PIN) === 'review') {
          showReview();
        }
      });
    } else {
      loadQuestion(currentQ);
    }
  });
})();

/* ════════════════════════════════════════════
   SYNC ROOM & LEADERBOARD FROM SERVER
   ════════════════════════════════════════════ */
async function syncRoomFromServer() {
  if (!PIN || PIN === '---') return false;
  let isFinished = (sessionStorage.getItem('mqc_room_finished_' + PIN) === '1');
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.room) {
        localPractice = false;
        if (Array.isArray(data.room.questions) && data.room.questions.length > 0) {
          QUESTIONS = data.room.questions;
        }
        if (data.room.title || data.room.name) {
          EXAM_TITLE = data.room.name || data.room.title;
        }
        if (data.room.examId || data.room.quizId) {
          EXAM_ID = data.room.examId || data.room.quizId;
        }
        const me = (data.room.players || []).find(player => player.id === myPlayerId);
        if (me) totalScore = Number(me.score) || 0;
        currentQ = Number(data.room.currentQ) || 0;
        isFinished = data.room.status === 'finished';
        if (data.room.timePerQ) {
          TIMER_SECS = Number(data.room.timePerQ) || 15;
        }
        syncServerClock(data.room);
        if (data.room.phase === 'finished' || data.room.status === 'finished') {
          isFinished = true;
        }
      }
    }
    if (PIN && PIN !== '---') {
      try {
        const existingToken = myPlayerToken || sessionStorage.getItem('mqc_my_player_token_' + PIN) || '';
        const jRes = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: myPlayerId, nick: NICKNAME, av: AVATAR, playerToken: existingToken })
        });
        if (jRes.ok) {
          const jData = await jRes.json();
          if (jData.player && jData.player.playerToken) {
            myPlayerToken = jData.player.playerToken;
            sessionStorage.setItem('mqc_my_player_token_' + PIN, myPlayerToken);
          }
          if (jData.player && jData.player.id) {
            myPlayerId = jData.player.id;
            sessionStorage.setItem('mqc_my_player_id_' + PIN, myPlayerId);
          }
        }
      } catch (e) {}
    }

    if (!isFinished) {
      // Đồng bộ thông tin thí sinh lên server
      await postAndFetchLeaderboard(0, 0);
    }
  } catch (err) {}
  return isFinished;
}

async function postAndFetchLeaderboard(qIdx, score) {
  if (PIN && PIN !== '---') {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/score`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-player-token': myPlayerToken
        },
        body: JSON.stringify({
          id: myPlayerId,
          playerId: myPlayerId,
          playerToken: myPlayerToken,
          nick: NICKNAME,
          av: AVATAR,
          currentQ: qIdx
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.leaderboard) && data.leaderboard.length > 0) {
          return data.leaderboard.map(p => ({
            id: p.id,
            name: p.nick,
            score: Number(p.score) || 0,
            isYou: (p.id === myPlayerId || p.nick.toLowerCase() === NICKNAME.toLowerCase()),
            av: p.av || '01'
          }));
        }
      }
    } catch (err) {}
  }

  // Fallback từ localStorage nếu offline hoặc thi thử
  try {
    const key = `mqc_room_scores_${PIN}`;
    let local = JSON.parse(localStorage.getItem(key) || '[]');
    let me = local.find(p => p.id === myPlayerId || (p.name && p.name.toLowerCase() === NICKNAME.toLowerCase()));
    if (me) {
      me.score = Math.round(score);
      me.av = AVATAR;
    } else {
      local.push({ id: myPlayerId, name: NICKNAME, score: Math.round(score), isYou: true, av: AVATAR });
    }
    local.sort((a, b) => b.score - a.score);
    localStorage.setItem(key, JSON.stringify(local));
    return local;
  } catch(e) {}

  return [{ id: myPlayerId, name: NICKNAME, score: Math.round(score), isYou: true, av: AVATAR }];
}

/* ════════════════════════════════════════════
   USER AUTH IN ROOM
   ════════════════════════════════════════════ */
async function checkUserInRoom() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return;
    const user = await res.json();
    const area = document.getElementById('room-auth-area');
    if (area) {
      // Chuyển nút Đăng nhập / Đăng ký thành thông tin tên người dùng
      area.innerHTML = `
        <div class="user-chip" title="Người dùng hiện tại">
          <div class="user-chip-avatar">👨‍🏫</div>
          <span>${escapeHtml(user.displayName)}</span>
        </div>
      `;
    }

    // Đối với người dùng đã đăng nhập: chuyển các nút "Về trang chủ" sang dashboard.html
    document.querySelectorAll('.btn-home').forEach(btn => {
      btn.href = 'dashboard.html';
      btn.textContent = '← Về Bảng điều khiển';
    });
  } catch (e) {
    // Để nguyên nút đăng nhập vãng lai và link về index.html
  }

  // Dọn dẹp token định danh khi thí sinh rời phòng trở về trang chủ hoặc dashboard
  document.querySelectorAll('.btn-home').forEach(btn => {
    btn.addEventListener('click', () => {
      if (PIN) {
        sessionStorage.removeItem('mqc_my_player_token_' + PIN);
        sessionStorage.removeItem('mqc_my_player_id_' + PIN);
        sessionStorage.removeItem('mqc_my_player_token');
        sessionStorage.removeItem('mqc_my_player_id');
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ════════════════════════════════════════════
   QUESTION LOADER
   ════════════════════════════════════════════ */
function loadQuestion(idx, roomTiming = null) {
  if (revealTimeout) clearTimeout(revealTimeout);
  if (timerStartTimeout) clearTimeout(timerStartTimeout);
  if (autoNextTimeout) {
    clearTimeout(autoNextTimeout);
    autoNextTimeout = null;
  }
  if (playerStateInterval) {
    clearInterval(playerStateInterval);
    playerStateInterval = null;
  }
  isRevealing    = false;
  currentQ       = idx;
  answered       = false;
  timedOutLocked = false;
  ticksElapsed   = 0;
  earnedThisQ    = 0;
  selectedChoice = -1;
  selectedChoices = [];
  closedQuestionResult = null;
  localQuestionStartMs = Date.now();
  if (roomTiming) {
    syncServerClock(roomTiming);
  } else if (idx > 0) {
    questionDeadlineMs = 0;
    questionStartedAtMs = 0;
  }

  const q = QUESTIONS[idx] || {};
  const isMulti = isMultiQuestion(q);
  document.getElementById('question-meta').textContent = 'Câu ' + (idx+1) + ' / ' + QUESTIONS.length;
  document.getElementById('question-text').textContent = q.text || '';

  const hintEl = document.getElementById('question-type-hint');
  if (hintEl) hintEl.style.display = isMulti ? 'inline-block' : 'none';

  const submitMultiBtn = document.getElementById('btn-submit-multi');
  if (submitMultiBtn) {
    submitMultiBtn.style.display = isMulti ? 'block' : 'none';
    submitMultiBtn.disabled = true;
    submitMultiBtn.textContent = '✓ Xác nhận đáp án';
  }

  const choicesEl = document.getElementById('choices');
  choicesEl.innerHTML = '';
  (q.choices || []).forEach(function(text, i) {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.innerHTML = '<span class="letter">' + (LETTERS[i] || (i+1)) + '</span>' + escapeHtml(text);
    btn.addEventListener('click', function() {
      if (isMulti) toggleMultiChoice(i);
      else selectAnswer(i);
    });
    choicesEl.appendChild(btn);
  });

  document.getElementById('question-card').style.display = '';
  document.getElementById('result-panel').classList.remove('show');
  document.getElementById('final-panel').classList.remove('show');

  document.getElementById('total-score').textContent = Math.round(totalScore);
  startTimer();

  // Bắt đầu theo dõi trạng thái đồng bộ với chủ phòng
  startPlayerStateTracking();
}

function startPlayerStateTracking() {
  if (playerStateInterval) clearInterval(playerStateInterval);
  if (!PIN || PIN === '---' || localPractice) return;

  playerStateInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/state`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          syncServerClock(data);
          // Only server phase/status authorize result and navigation.
          if (data.status === 'finished') {
            clearInterval(playerStateInterval);
            playerStateInterval = null;
            if (autoNextTimeout) clearTimeout(autoNextTimeout);
            if (timerInterval) clearInterval(timerInterval);
            await syncRoomFromServer();
            showFinal(lastSortedRank, myFinalRank);
            return;
          }
          if (data.phase === 'question' && data.currentQ > currentQ) {
            loadQuestion(data.currentQ, data);
            return;
          }
          if (!isRevealing && data.phase === 'result' && data.currentQ === currentQ) {
            await revealAndShow();
          }
        }
      }
    } catch (e) {}
  }, 500);
}

/* ════════════════════════════════════════════
   TIMER
   ════════════════════════════════════════════ */
function getCurrentQuestionLimitSecs() {
  const q = QUESTIONS[currentQ] || {};
  return Number(q.timeLimit) || TIMER_SECS || 15;
}

function resetTimerBar() {
  const bar = document.getElementById('timer-bar');
  const secs = document.getElementById('timer-secs');
  const limitSecs = getCurrentQuestionLimitSecs();
  // Tắt transition để thanh lập tức tràn đầy 100%, không bị lấp dần từ từ
  bar.style.transition = 'none';
  bar.style.width = '100%';
  bar.classList.remove('warning', 'danger');
  secs.textContent = limitSecs;
  // Kích hoạt reflow để trình duyệt cập nhật ngay lập tức
  void bar.offsetWidth;
  // Bật lại transition cho hiệu ứng đếm ngược mượt mà
  bar.style.transition = 'width .25s linear, background .35s';
}

function lockQuestionInputsOnTimeout() {
  timedOutLocked = true;
  document.querySelectorAll('.choice-btn').forEach(b => { b.disabled = true; });
  const submitMultiBtn = document.getElementById('btn-submit-multi');
  if (submitMultiBtn) submitMultiBtn.disabled = true;
}

function startTimer() {
  clearInterval(timerInterval);
  if (timerStartTimeout) {
    clearTimeout(timerStartTimeout);
    timerStartTimeout = null;
  }

  const limitSecs = getCurrentQuestionLimitSecs();
  const limitMs = limitSecs * 1000;
  // Đặt thanh thời gian đầy mặc định ngay lập tức
  resetTimerBar();

  // Đếm ngược sẽ bắt đầu sau 0.25 giây (250ms) delay cho local fallback
  timerStartTimeout = setTimeout(function() {
    const fallbackStartMs = Date.now();
    timerInterval = setInterval(function() {
      ticksElapsed++;
      let remainingMs;
      if (PIN && PIN !== '---' && !localPractice && questionDeadlineMs > 0) {
        const estServerNow = Date.now() + serverClockOffset;
        remainingMs = Math.min(limitMs, Math.max(0, questionDeadlineMs - estServerNow));
      } else {
        remainingMs = Math.max(0, limitMs - (Date.now() - fallbackStartMs));
      }
      const secsLeft = remainingMs / 1000;
      updateTimerUI(secsLeft, limitSecs);

      if (remainingMs <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        // Timer hết trên client -> khóa chọn đáp án ngay lập tức (server vẫn có 2s ân hạn cho request đang gửi)
        if (!PIN || PIN === '---' || localPractice) {
          lockQuestionInputsOnTimeout();
          revealAndShow();
        } else {
          lockQuestionInputsOnTimeout();
        }
      }
    }, TICK_MS);
  }, 250);
}

function updateTimerUI(secsLeft, limitSecs) {
  const totalSecs = limitSecs || getCurrentQuestionLimitSecs();
  const bar  = document.getElementById('timer-bar');
  const secs = document.getElementById('timer-secs');
  const pct  = Math.max(0, Math.min(100, (secsLeft / totalSecs) * 100));
  bar.style.width = pct + '%';
  secs.textContent = Math.max(0, Math.ceil(secsLeft));
  bar.classList.remove('warning','danger');
  if (pct <= 30) bar.classList.add('danger');
  else if (pct <= 60) bar.classList.add('warning');
}

/* ════════════════════════════════════════════
   ANSWER SELECTION
   ════════════════════════════════════════════ */
let closedQuestionResult = null;
let resultFetchPending = false;

function getElapsedResponseMs() {
  if (PIN && PIN !== '---' && !localPractice && questionStartedAtMs > 0) {
    return Math.max(0, Math.round((Date.now() + serverClockOffset) - questionStartedAtMs));
  }
  return Math.max(0, Date.now() - localQuestionStartMs);
}

async function postAnswerToServer(payload, submittedQ) {
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-player-token': payload.playerToken || myPlayerToken
      },
      body: JSON.stringify(payload)
    });
    const res = await r.json();
    if (res && res.success && currentQ === submittedQ) {
      document.getElementById('question-meta').textContent = 'Đã ghi nhận đáp án';
      return;
    }
    if (res && res.timedOut && currentQ === submittedQ) {
      answered = false;
      lockQuestionInputsOnTimeout();
      document.getElementById('question-meta').textContent = '⏰ Đã hết thời gian trả lời câu hỏi!';
      return;
    }
    if (res && res.unauthorized) {
      const jRes = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: myPlayerId, nick: NICKNAME, av: AVATAR, playerToken: myPlayerToken })
      });
      if (jRes.ok) {
        const jData = await jRes.json();
        if (jData.player?.playerToken) {
          myPlayerToken = jData.player.playerToken;
          sessionStorage.setItem('mqc_my_player_token_' + PIN, myPlayerToken);
          payload.playerToken = myPlayerToken;
          const retryR = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-player-token': myPlayerToken },
            body: JSON.stringify(payload)
          });
          const retryRes = await retryR.json();
          if (retryRes && retryRes.success && currentQ === submittedQ) {
            document.getElementById('question-meta').textContent = 'Đã ghi nhận đáp án';
          } else if (retryRes && retryRes.timedOut && currentQ === submittedQ) {
            answered = false;
            lockQuestionInputsOnTimeout();
            document.getElementById('question-meta').textContent = '⏰ Đã hết thời gian trả lời câu hỏi!';
          }
        }
      }
    }
  } catch (e) {}
}

function toggleMultiChoice(choiceIdx) {
  if (answered || timedOutLocked) return;
  const idxPos = selectedChoices.indexOf(choiceIdx);
  const btns = document.querySelectorAll('.choice-btn');
  if (idxPos >= 0) {
    selectedChoices.splice(idxPos, 1);
    if (btns[choiceIdx]) btns[choiceIdx].classList.remove('selected');
  } else {
    selectedChoices.push(choiceIdx);
    selectedChoices.sort((a, b) => a - b);
    if (btns[choiceIdx]) btns[choiceIdx].classList.add('selected');
  }
  const submitMultiBtn = document.getElementById('btn-submit-multi');
  if (submitMultiBtn) {
    submitMultiBtn.disabled = selectedChoices.length === 0;
  }
}

function submitMultiAnswer() {
  if (answered || timedOutLocked || selectedChoices.length === 0) return;
  answered = true;
  selectedChoice = selectedChoices[0] ?? -1;

  earnedThisQ = 0;
  const submittedQ = currentQ;
  const q = QUESTIONS[currentQ] || {};
  if (localPractice || !PIN || PIN === '---') {
    const corr = getCorrectChoices(q);
    const isCorr = corr.length > 0 &&
      selectedChoices.length === corr.length &&
      selectedChoices.every((val, i) => val === corr[i]);
    earnedThisQ = isCorr ? calcScore() : 0;
  }

  document.querySelectorAll('.choice-btn').forEach(b => { b.disabled = true; });
  const submitMultiBtn = document.getElementById('btn-submit-multi');
  if (submitMultiBtn) {
    submitMultiBtn.disabled = true;
    submitMultiBtn.textContent = '✓ Đã gửi đáp án';
  }

  if (PIN && PIN !== '---') {
    const payload = {
      id: myPlayerId,
      playerId: myPlayerId,
      playerToken: myPlayerToken,
      nick: NICKNAME,
      qIdx: currentQ,
      choices: [...selectedChoices],
      responseTimeMs: getElapsedResponseMs()
    };
    postAnswerToServer(payload, submittedQ);
  }
}

function selectAnswer(choiceIdx) {
  if (answered || timedOutLocked) return;
  answered = true;
  selectedChoice = choiceIdx;
  selectedChoices = [choiceIdx];

  earnedThisQ = 0;
  const submittedQ = currentQ;
  if (localPractice || !PIN || PIN === '---') earnedThisQ = calcScore();

  /* Chỉ highlight lựa chọn, không hiện đúng/sai cho đến khi hết giờ */
  const btns = document.querySelectorAll('.choice-btn');
  btns.forEach(function(b) { b.disabled = true; });
  if (btns[choiceIdx]) btns[choiceIdx].classList.add('selected');

  // Gửi lựa chọn đáp án thời gian thực lên máy chủ để chủ phòng theo dõi và xác thực điểm
  if (PIN && PIN !== '---') {
    const payload = {
      id: myPlayerId,
      playerId: myPlayerId,
      playerToken: myPlayerToken,
      nick: NICKNAME,
      qIdx: currentQ,
      choice: choiceIdx,
      responseTimeMs: getElapsedResponseMs()
    };
    postAnswerToServer(payload, submittedQ);
  }

  /* Timer vẫn tiếp tục chạy — người chơi phải đợi hết giờ */
  /* Không gọi showResult ở đây */
}

function calcScore() {
  const limitMs = getCurrentQuestionLimitSecs() * 1000;
  const elapsedMs = Math.min(limitMs, Math.max(0, Date.now() - localQuestionStartMs));
  const speedFactor = Math.max(0.5, 1 - (elapsedMs / (limitMs * 2)));
  return Math.round(MAX_SCORE * speedFactor);
}

/* Multiplayer reveal requires an accepted result response from the server. */
async function revealAndShow() {
  if (isRevealing || resultFetchPending) return;
  if (PIN && PIN !== '---' && !localPractice) {
    const requestedQ = currentQ;
    resultFetchPending = true;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/result?q=${requestedQ}&playerId=${encodeURIComponent(myPlayerId)}`, {
        headers: { 'X-Player-Token': myPlayerToken }
      });
      if (!response.ok) return;
      const result = await response.json();
      if (!result.success || requestedQ !== currentQ) return;
      if (!result.playerResult) return;
      closedQuestionResult = result;
      selectedChoice = result.playerResult.choice;
      if (Array.isArray(result.playerResult.choices) && result.playerResult.choices.length > 0) {
        selectedChoices = result.playerResult.choices.slice();
      } else if (selectedChoice >= 0) {
        selectedChoices = [selectedChoice];
      } else {
        selectedChoices = [];
      }
      answered = selectedChoices.length > 0 || selectedChoice >= 0;
      earnedThisQ = result.playerResult.scoreEarned;
      totalScore = result.playerResult.totalScore;
    } catch (e) { return; }
    finally { resultFetchPending = false; }
  }

  isRevealing = true;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  const q = QUESTIONS[currentQ] || {};
  const btns = document.querySelectorAll('.choice-btn');
  btns.forEach(function(b) {
    b.disabled = true;
    b.classList.remove('selected');
  });
  const submitMultiBtn = document.getElementById('btn-submit-multi');
  if (submitMultiBtn) submitMultiBtn.disabled = true;

  const isMulti = Boolean((closedQuestionResult && closedQuestionResult.isMultiple) || isMultiQuestion(q));
  const correctList = closedQuestionResult
    ? (Array.isArray(closedQuestionResult.correctChoices) && closedQuestionResult.correctChoices.length > 0
        ? closedQuestionResult.correctChoices
        : (closedQuestionResult.correctChoice >= 0 ? [closedQuestionResult.correctChoice] : []))
    : ((!PIN || PIN === '---' || localPractice) ? getCorrectChoices(q) : []);
  const userList = isMulti
    ? selectedChoices.slice()
    : (selectedChoice >= 0 ? [selectedChoice] : []);

  if (!answered || userList.length === 0) {
    /* Chưa bấm — hết giờ */
    answered = true;
    earnedThisQ = 0;
    correctList.forEach(idx => {
      if (idx >= 0 && btns[idx]) btns[idx].classList.add('reveal-correct');
    });
    userAnswers.push({
      questionIndex: currentQ,
      questionType: isMulti ? 'multiple' : 'single',
      userChoice: -1,
      userChoices: [],
      correctChoices: correctList,
      isCorrect: false,
      earned: 0
    });
  } else {
    /* Đã bấm — giờ mới hiển thị đúng / sai */
    const isCorr = closedQuestionResult
      ? !!closedQuestionResult.playerResult.isCorrect
      : (isMulti
          ? (correctList.length > 0 && userList.length === correctList.length && userList.every((v, idx) => v === correctList[idx]))
          : (userList[0] === correctList[0]));

    for (let i = 0; i < btns.length; i++) {
      const picked = userList.includes(i);
      const isRight = correctList.includes(i);
      if (picked && isRight) btns[i].classList.add('correct');
      else if (picked && !isRight) btns[i].classList.add('wrong');
      else if (!picked && isRight) btns[i].classList.add('reveal-correct');
    }

    userAnswers.push({
      questionIndex: currentQ,
      questionType: isMulti ? 'multiple' : 'single',
      userChoice: userList[0] ?? -1,
      userChoices: userList,
      correctChoices: correctList,
      isCorrect: isCorr,
      earned: earnedThisQ
    });
  }

  // Đợi 1.2s để người chơi thấy rõ kết quả đúng/sai trước khi hiện bảng xếp hạng
  revealTimeout = setTimeout(function() {
    // Reset thanh thời gian đầy 100% trước khi chuyển cảnh
    resetTimerBar();
    showResult(earnedThisQ);
  }, 1200);
}

/* ════════════════════════════════════════════
   RESULT PANEL & BẢNG XẾP HẠNG THỰC TẾ ĐỒNG BỘ
   ════════════════════════════════════════════ */
async function showResult(earned) {
  if (!closedQuestionResult) totalScore += earned;

  // Gửi điểm số mới nhất và nhận BXH thời gian thực của tất cả thí sinh
  let sorted = await postAndFetchLeaderboard(currentQ, totalScore);

  let youIdx = sorted.findIndex(p => p.isYou);
  if (youIdx < 0) {
    sorted.push({ id: myPlayerId, name: NICKNAME, score: totalScore, isYou: true, av: AVATAR });
    sorted.sort((a, b) => b.score - a.score);
    youIdx = sorted.findIndex(p => p.isYou);
  }
  const yourRank = youIdx + 1;
  const isLast   = currentQ === QUESTIONS.length - 1;

  /* Result info */
  const lastAns = userAnswers[userAnswers.length - 1];
  const hadSelection = (selectedChoices && selectedChoices.length > 0) || selectedChoice >= 0;
  const wasCorrect = closedQuestionResult
    ? !!closedQuestionResult.playerResult.isCorrect
    : !!(lastAns && lastAns.isCorrect);
  document.getElementById('result-title').textContent =
    wasCorrect ? '✅ Đúng rồi!' : (hadSelection ? '❌ Sai mất rồi!' : '⏰ Hết giờ!');
  if (closedQuestionResult && closedQuestionResult.explanation) {
    document.getElementById('result-title').textContent += ' ' + closedQuestionResult.explanation;
  }
  document.getElementById('result-score-earned').innerHTML =
    '+' + Math.round(earned);
  document.getElementById('result-total').textContent =
    'Tổng điểm của bạn: ' + Math.round(totalScore);
  if (closedQuestionResult) {
    document.getElementById('result-total').textContent += ' · Chuỗi đúng: ' + closedQuestionResult.playerResult.streak;
  }
  document.getElementById('total-score').textContent = Math.round(totalScore);

  /* Render live podium & rows */
  renderLeaderboardUI(sorted);

  document.getElementById('question-card').style.display = 'none';
  document.getElementById('result-panel').classList.add('show');

  // Lắng nghe cập nhật realtime điểm các thí sinh khác nếu họ nộp bài trong thời gian chờ
  let pollCount = 0;
  const pollTimer = setInterval(async () => {
    pollCount++;
    if (pollCount > 4) {
      clearInterval(pollTimer);
      return;
    }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/leaderboard`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.leaderboard)) {
          const fresh = data.leaderboard.map(p => ({
            id: p.id,
            name: p.nick,
            score: Number(p.score) || 0,
            isYou: (p.id === myPlayerId || p.nick.toLowerCase() === NICKNAME.toLowerCase()),
            av: p.av || '01'
          }));
          renderLeaderboardUI(fresh);
        }
      }
    } catch(e) {}
  }, 1000);

  isRevealing = true;
  lastSortedRank = sorted;
  myFinalRank = yourRank;

  // Thí sinh trong phòng thi có chủ phòng: CHỜ bảng xếp hạng đếm ngược xong hoặc chủ phòng chọn Next thủ công
  const isRealRoomWithHost = (PIN && PIN !== '---' && !localPractice);
  if (isRealRoomWithHost) {
    startPlayerStateTracking();
  } else {
    /* Chế độ thi thử đơn: Tự động chuyển câu sau 4 giây */
    autoNextTimeout = setTimeout(function() {
      clearInterval(pollTimer);
      if (isLast) {
        showFinal(sorted, yourRank);
      } else {
        nextQuestion();
      }
    }, 4000);
  }
}

function renderLeaderboardUI(sorted) {
  renderPodium(sorted);

  const rowsEl = document.getElementById('leaderboard-rows');
  const rest   = sorted.slice(3);
  rowsEl.innerHTML = rest.map(function(p, i) {
    const avatarSrc = 'characters/' + (p.av || '01') + '.png';
    const nameClass = p.isYou ? 'lb-name you' : 'lb-name';
    return '<div class="lb-row">'
      + '<div class="lb-rank">' + (i+4) + '</div>'
      + '<img class="lb-avatar" src="' + avatarSrc + '" alt="' + escapeHtml(p.name) + '" />'
      + '<div class="' + nameClass + '">' + escapeHtml(p.name) + '</div>'
      + '<div class="lb-score">' + Math.round(p.score) + '</div>'
      + '</div>';
  }).join('');
}

/* ════════════════════════════════════════════
   PODIUM ANIMATION
   ════════════════════════════════════════════ */
function renderPodium(sorted) {
  const MAX_BAR_H = 110;   // px height cho người số 1
  const top3      = sorted.slice(0, 3);
  const maxScore  = (top3[0] && top3[0].score > 0) ? top3[0].score : 1;

  // Order: 2nd | 1st | 3rd  (podium layout)
  const order = [top3[1], top3[0], top3[2]];
  const ids   = [2, 1, 3];
  const barClasses = ['bar-red', 'bar-gold', 'bar-green'];

  order.forEach(function(p, i) {
    const rank = ids[i];
    const slotEl = document.getElementById('pod-' + rank);
    if (!slotEl) return;

    if (!p) {
      slotEl.style.visibility = 'hidden';
      return;
    }
    slotEl.style.visibility = 'visible';

    const avatarSrc = 'characters/' + (p.av || '01') + '.png';
    document.getElementById('pod-av-' + rank).src = avatarSrc;
    document.getElementById('pod-name-' + rank).textContent = p.name;
    document.getElementById('pod-score-' + rank).textContent = Math.round(p.score);

    /* Animate bar height */
    const targetH = maxScore > 0 ? Math.round((p.score / maxScore) * MAX_BAR_H) : 20;
    const bar = document.getElementById('pod-bar-' + rank);
    bar.style.height = '0px';
    // Stagger: 1st animates first, then 2nd, then 3rd
    const delay = rank === 1 ? 0 : rank === 2 ? 120 : 240;
    setTimeout(function() {
      bar.style.height = Math.max(targetH, 20) + 'px';
    }, delay);
  });
}

/* ════════════════════════════════════════════
   NAVIGATION
   ════════════════════════════════════════════ */
function nextQuestion() {
  currentQ++;
  if (currentQ < QUESTIONS.length) {
    loadQuestion(currentQ);
  }
}

async function showFinal(sorted, yourRank) {
  if (revealTimeout) clearTimeout(revealTimeout);
  if (timerStartTimeout) clearTimeout(timerStartTimeout);
  // Lấy lại BXH cuối cùng mới nhất một lần nữa
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/leaderboard`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.leaderboard)) {
        const fresh = data.leaderboard.map(p => ({
          id: p.id,
          name: p.nick,
          score: Number(p.score) || 0,
          isYou: (p.id === myPlayerId || p.nick.toLowerCase() === NICKNAME.toLowerCase()),
          av: p.av || '01'
        }));
        if (fresh.length > 0) {
          sorted = fresh;
          const idx = sorted.findIndex(p => p.isYou);
          if (idx >= 0) { yourRank = idx + 1; totalScore = sorted[idx].score; }
        }
      }
    }
  } catch(e) {}

  if (!sorted || sorted.length === 0) {
    sorted = [{
      id: myPlayerId,
      name: NICKNAME,
      score: totalScore,
      isYou: true,
      av: AVATAR
    }];
    yourRank = 1;
  }

  lastSortedRank = sorted;
  myFinalRank = yourRank;

  // Lưu trạng thái hoàn thành vào sessionStorage để reload không bị mất báo cáo
  if (PIN && PIN !== '---') {
    try {
      sessionStorage.setItem('mqc_room_finished_' + PIN, '1');
      sessionStorage.setItem('mqc_total_score_' + PIN, totalScore);
      sessionStorage.setItem('mqc_final_rank_' + PIN, yourRank);
      sessionStorage.setItem('mqc_user_answers_' + PIN, JSON.stringify(userAnswers));
    } catch(e) {}
  }

  document.getElementById('question-card').style.display = 'none';
  document.getElementById('result-panel').classList.remove('show');
  document.getElementById('review-panel').classList.remove('show');
  const trophies = ['🥇','🥈','🥉','🎖️'];
  document.getElementById('final-trophy').textContent = trophies[Math.min(yourRank-1, 3)];
  document.getElementById('final-score').textContent  = Math.round(totalScore) + ' điểm';
  document.getElementById('final-rank').textContent   =
    'Xếp hạng ' + yourRank + ' / ' + sorted.length + ' thí sinh';
  document.getElementById('final-panel').classList.add('show');

  // Gửi lưu kết quả thi vào lịch sử user nếu đã đăng nhập
  saveHistoryRecord(sorted, yourRank);
}

/* ════════════════════════════════════════════
   SAVE HISTORY LOGIC
   ════════════════════════════════════════════ */
let historySaved = false;

function cleanUpTestRoom() {
  if (params.get('isTest') === '1' && PIN) {
    try {
      const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
      if (customRooms[PIN]) {
        delete customRooms[PIN];
        localStorage.setItem('mqc_custom_rooms', JSON.stringify(customRooms));
      }
    } catch(e) {}
  }
}
window.addEventListener('beforeunload', cleanUpTestRoom);

async function saveHistoryRecord(sorted, yourRank) {
  if (historySaved) return;
  historySaved = true;

  // Nếu là phòng thi thử -> không lưu vào lịch sử và dọn dẹp phòng
  if (params.get('isTest') === '1') {
    cleanUpTestRoom();
    return;
  }

  const totalQ = QUESTIONS.length;
  let correctCount = 0;
  userAnswers.forEach(function(ans) {
    if (ans.isCorrect) correctCount++;
  });
  const accuracyPct = Math.round((correctCount / totalQ) * 100);

  const details = QUESTIONS.map(function(q, i) {
    const ans = userAnswers[i] || { userChoice: -1, userChoices: [], isCorrect: false, earned: 0 };
    const correctList = (Array.isArray(ans.correctChoices) && ans.correctChoices.length > 0)
      ? ans.correctChoices
      : getCorrectChoices(q);
    const isMulti = Boolean(ans.questionType === 'multiple' || isMultiQuestion(q) || correctList.length > 1);
    const uChoices = Array.isArray(ans.userChoices) && ans.userChoices.length > 0
      ? ans.userChoices
      : (typeof ans.userChoice === 'number' && ans.userChoice >= 0 ? [ans.userChoice] : []);
    return {
      questionText: q.text,
      questionType: isMulti ? 'multiple' : 'single',
      choices: q.choices,
      userChoice: typeof ans.userChoice === 'number' ? ans.userChoice : (uChoices[0] ?? -1),
      ...(isMulti ? { userChoices: uChoices, correctChoices: correctList } : {}),
      correctChoice: correctList[0] ?? q.correct,
      isCorrect: !!ans.isCorrect,
      earned: Math.round(ans.earned || 0)
    };
  });

  const payload = {
    pin: PIN,
    quizId: (typeof EXAM_ID !== 'undefined' && EXAM_ID) ? EXAM_ID : (params.get('examId') || ''),
    examId: (typeof EXAM_ID !== 'undefined' && EXAM_ID) ? EXAM_ID : (params.get('examId') || ''),
    playerId: myPlayerId,
    playerToken: myPlayerToken,
    roomTitle: EXAM_TITLE,
    score: Math.round(totalScore),
    maxScore: totalQ * 100,
    correctCount: correctCount,
    totalQuestions: totalQ,
    rank: yourRank,
    totalPlayers: sorted.length,
    accuracyPct: accuracyPct,
    details: details
  };

  try {
    const response = await fetch('/api/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-player-token': myPlayerToken
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error('History save failed: HTTP ' + response.status);
  } catch (err) {
    historySaved = false;
    console.warn('Lưu lịch sử không thành công:', err);
  }
}

/* ════════════════════════════════════════════
   REVIEW & STATS LOGIC
   ════════════════════════════════════════════ */
function showReview() {
  if (PIN && PIN !== '---') {
    try {
      sessionStorage.setItem('mqc_view_panel_' + PIN, 'review');
    } catch(e) {}
  }
  document.getElementById('final-panel').classList.remove('show');
  document.getElementById('review-panel').classList.add('show');

  // 1. Top 3
  const top3 = lastSortedRank.slice(0, 3);
  const top3El = document.getElementById('review-top3-list');
  const medals = ['🥇', '🥈', '🥉'];
  top3El.innerHTML = top3.map(function(p, i) {
    const isYouClass = p.isYou ? 'you' : '';
    const avatarSrc = 'characters/' + (p.av || '01') + '.png';
    return '<div class="top3-item ' + isYouClass + '">'
      + '<span class="top3-medal">' + medals[i] + '</span>'
      + '<img class="top3-av" src="' + avatarSrc + '" alt=""/>'
      + '<span class="top3-name">' + escapeHtml(p.name) + (p.isYou ? ' (Bạn)' : '') + '</span>'
      + '<span class="top3-score">' + Math.round(p.score) + ' điểm</span>'
      + '</div>';
  }).join('');

  // 2. Personal rank & score
  document.getElementById('review-my-rank').textContent = '#' + myFinalRank;
  document.getElementById('review-my-score').textContent = Math.round(totalScore) + ' điểm';

  // 3. Accuracy Pie Chart
  const totalQ = QUESTIONS.length;
  let correctCount = 0;
  userAnswers.forEach(function(ans) {
    if (ans.isCorrect) correctCount++;
  });
  const wrongCount = totalQ - correctCount;
  const accuracyPct = Math.round((correctCount / totalQ) * 100);

  document.getElementById('stat-correct-count').textContent = correctCount + ' câu';
  document.getElementById('stat-wrong-count').textContent = wrongCount + ' câu';
  document.getElementById('stat-accuracy-rate').textContent = accuracyPct + '%';

  // Vẽ biểu đồ tròn bằng conic-gradient
  const pie = document.getElementById('pie-chart');
  pie.style.background = 'conic-gradient(#4CAF50 0% ' + accuracyPct + '%, #EF5350 ' + accuracyPct + '% 100%)';
  pie.setAttribute('title', accuracyPct + '% đúng');

  // 4. Detail Questions List (kéo riêng)
  const listEl = document.getElementById('review-questions-scroll');
  listEl.innerHTML = QUESTIONS.map(function(q, i) {
    const ans = userAnswers[i] || { userChoice: -1, userChoices: [], isCorrect: false, earned: 0 };
    const isCorr = ans.isCorrect;
    const uChoices = Array.isArray(ans.userChoices) && ans.userChoices.length > 0
      ? ans.userChoices
      : (typeof ans.userChoice === 'number' && ans.userChoice >= 0 ? [ans.userChoice] : []);
    const correctList = (Array.isArray(ans.correctChoices) && ans.correctChoices.length > 0)
      ? ans.correctChoices
      : getCorrectChoices(q);

    const statusBadge = isCorr
      ? '<span class="badge badge-correct">✓ Đúng (+' + Math.round(ans.earned) + 'đ)</span>'
      : (uChoices.length === 0
          ? '<span class="badge badge-wrong">⏰ Hết giờ (0đ)</span>'
          : '<span class="badge badge-wrong">✗ Sai (0đ)</span>');

    const userText = uChoices.length > 0
      ? uChoices.map(idx => (LETTERS[idx] || (idx + 1)) + '. ' + escapeHtml((q.choices && q.choices[idx]) || '')).join(', ')
      : 'Không chọn';

    const correctText = correctList.length > 0
      ? correctList.map(idx => (LETTERS[idx] || (idx + 1)) + '. ' + escapeHtml((q.choices && q.choices[idx]) || '')).join(', ')
      : 'Không xác định';

    return '<div class="review-question-card ' + (isCorr ? 'card-correct' : 'card-wrong') + '">'
      + '<div class="rq-header">'
      + '  <span class="rq-num">Câu ' + (i+1) + ':</span>'
      + '  <span class="rq-title">' + escapeHtml(q.text) + '</span>'
      + '  ' + statusBadge
      + '</div>'
      + '<div class="rq-body">'
      + '  <div class="rq-line">Lựa chọn của bạn: <b class="' + (isCorr ? 'text-correct' : 'text-wrong') + '">' + userText + '</b></div>'
      + '  <div class="rq-line">Đáp án đúng: <b class="text-correct">' + correctText + '</b></div>'
      + '</div>'
      + '</div>';
  }).join('');
}

function backToFinal() {
  document.getElementById('review-panel').classList.remove('show');
  document.getElementById('final-panel').classList.add('show');
}