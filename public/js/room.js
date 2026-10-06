/* ════════════════════════════════════════════
   DATA
   ════════════════════════════════════════════ */
let QUESTIONS = [
  { text: 'Con chó có mấy chân?', choices: ['3','2','4','5'], correct: 2 },
  { text: '2 + 2 = ?',            choices: ['2','5','4','8'], correct: 2 },
  { text: 'Con nào biết bay?',    choices: ['Heo','Chó','Cú','Bò'], correct: 2 }
];

const LETTERS        = ['A','B','C','D'];
const MAX_SCORE      = 100;
let TIMER_SECS       = 15;
const TICK_MS        = 500;

const params   = new URLSearchParams(location.search);
const PIN      = params.get('pin')  || '---';
const NICKNAME = params.get('nick') || 'Bạn';
const AVATAR   = params.get('av')   || '01';
let EXAM_TITLE = 'Đề thi Toán & Logic';

// Load custom room questions if available
try {
  const roomPin = params.get('pin');
  const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
  if (roomPin && customRooms[roomPin] && Array.isArray(customRooms[roomPin].questions) && customRooms[roomPin].questions.length > 0) {
    QUESTIONS = customRooms[roomPin].questions;
    if (customRooms[roomPin].title) {
      EXAM_TITLE = customRooms[roomPin].title;
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
let playerStateInterval = null;
let isRevealing   = false;
let ticksElapsed  = 0;
let answered      = false;
let earnedThisQ   = 0;   // điểm tính từ lúc bấm — lưu lại khi timer vẫn chạy
let selectedChoice = -1;  // lưu lựa chọn của người chơi, chỉ hiển thị đúng/sai khi hết giờ
let userAnswers   = [];   // lưu lịch sử làm bài chi tiết { questionIndex, userChoice, isCorrect, earned, timeSpent }
let lastSortedRank = [];  // lưu bảng xếp hạng cuối cùng
let myFinalRank   = 1;

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
        if (Array.isArray(data.room.questions) && data.room.questions.length > 0) {
          QUESTIONS = data.room.questions;
        }
        if (data.room.title || data.room.name) {
          EXAM_TITLE = data.room.name || data.room.title;
        }
        if (data.room.timePerQ) {
          TIMER_SECS = Number(data.room.timePerQ) || 15;
        }
        if (data.room.phase === 'finished' || data.room.status === 'finished') {
          isFinished = true;
        }
      }
    }
    if (!myPlayerToken && PIN && PIN !== '---') {
      try {
        const existingToken = sessionStorage.getItem('mqc_my_player_token_' + PIN) || '';
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
function loadQuestion(idx) {
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
  ticksElapsed   = 0;
  earnedThisQ    = 0;
  selectedChoice = -1;

  const q = QUESTIONS[idx];
  document.getElementById('question-meta').textContent = 'Câu ' + (idx+1) + ' / ' + QUESTIONS.length;
  document.getElementById('question-text').textContent = q.text;

  const choicesEl = document.getElementById('choices');
  choicesEl.innerHTML = '';
  q.choices.forEach(function(text, i) {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.innerHTML = '<span class="letter">' + LETTERS[i] + '</span>' + text;
    btn.addEventListener('click', function() { selectAnswer(i); });
    choicesEl.appendChild(btn);
  });

  document.getElementById('question-card').style.display = '';
  document.getElementById('result-panel').classList.remove('show');
  document.getElementById('final-panel').classList.remove('show');

  startTimer();

  // Bắt đầu theo dõi trạng thái đồng bộ với chủ phòng
  startPlayerStateTracking(idx);
}

function startPlayerStateTracking(qIdx) {
  if (playerStateInterval) clearInterval(playerStateInterval);
  if (!PIN || PIN === '---' || params.get('isTest') === '1') return;

  playerStateInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/state`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          // 1. Khi đang trong lúc làm bài: Nếu chủ phòng chuyển sang phase leaderboard hoặc toàn bộ đã trả lời
          if (!isRevealing && (data.phase === 'leaderboard' || (data.allAnswered && data.totalCandidates > 0))) {
            clearInterval(playerStateInterval);
            playerStateInterval = null;
            if (timerInterval) clearInterval(timerInterval);
            revealAndShow();
            return;
          }

          // 2. Khi đang ở bảng xếp hạng: Nếu chủ phòng bấm chuyển sang câu tiếp theo
          if (isRevealing && data.phase === 'question' && typeof data.currentQ === 'number' && data.currentQ > currentQ) {
            clearInterval(playerStateInterval);
            playerStateInterval = null;
            if (autoNextTimeout) clearTimeout(autoNextTimeout);
            isRevealing = false;
            loadQuestion(data.currentQ);
            return;
          }

          // 3. Nếu chủ phòng kết thúc đề thi
          if (isRevealing && data.phase === 'finished') {
            clearInterval(playerStateInterval);
            playerStateInterval = null;
            if (autoNextTimeout) clearTimeout(autoNextTimeout);
            showFinal(lastSortedRank, myFinalRank);
            return;
          }
        }
      }
    } catch (e) {}
  }, 500);
}

/* ════════════════════════════════════════════
   TIMER
   ════════════════════════════════════════════ */
function resetTimerBar() {
  const bar = document.getElementById('timer-bar');
  const secs = document.getElementById('timer-secs');
  // Tắt transition để thanh lập tức tràn đầy 100%, không bị lấp dần từ từ
  bar.style.transition = 'none';
  bar.style.width = '100%';
  bar.classList.remove('warning', 'danger');
  secs.textContent = TIMER_SECS;
  // Kích hoạt reflow để trình duyệt cập nhật ngay lập tức
  void bar.offsetWidth;
  // Bật lại transition cho hiệu ứng đếm ngược mượt mà
  bar.style.transition = 'width .5s linear, background .5s';
}

function startTimer() {
  clearInterval(timerInterval);
  if (timerStartTimeout) {
    clearTimeout(timerStartTimeout);
    timerStartTimeout = null;
  }

  // Đặt thanh thời gian đầy mặc định ngay lập tức
  resetTimerBar();

  // Đếm ngược sẽ bắt đầu sau 0.25 giây (250ms) delay
  timerStartTimeout = setTimeout(function() {
    timerInterval = setInterval(function() {
      ticksElapsed++;
      const secsLeft = Math.max(0, TIMER_SECS - ticksElapsed * (TICK_MS / 1000));
      updateTimerUI(secsLeft);

      if (ticksElapsed >= TIMER_SECS * (1000 / TICK_MS)) {
        clearInterval(timerInterval);
        // Timer hết — nếu chưa ai bấm: 0 điểm; nếu đã bấm: dùng earnedThisQ đã lưu
        revealAndShow();
      }
    }, TICK_MS);
  }, 250);
}

function updateTimerUI(secsLeft) {
  const bar  = document.getElementById('timer-bar');
  const secs = document.getElementById('timer-secs');
  const pct  = (secsLeft / TIMER_SECS) * 100;
  bar.style.width = pct + '%';
  secs.textContent = Math.ceil(secsLeft);
  bar.classList.remove('warning','danger');
  if (pct <= 30) bar.classList.add('danger');
  else if (pct <= 60) bar.classList.add('warning');
}

/* ════════════════════════════════════════════
   ANSWER SELECTION
   ════════════════════════════════════════════ */
let serverAnswerResult = null;

function selectAnswer(choiceIdx) {
  if (answered) return;
  answered = true;
  selectedChoice = choiceIdx;
  serverAnswerResult = null;

  const q      = QUESTIONS[currentQ];
  const earned = calcScore();
  earnedThisQ  = (q && q.correct !== undefined && choiceIdx === q.correct) ? earned : earned;

  /* Chỉ highlight lựa chọn, không hiện đúng/sai cho đến khi hết giờ */
  const btns = document.querySelectorAll('.choice-btn');
  btns.forEach(function(b) { b.disabled = true; });
  btns[choiceIdx].classList.add('selected');

  // Gửi lựa chọn đáp án thời gian thực lên máy chủ để chủ phòng theo dõi và xác thực điểm
  if (PIN && PIN !== '---') {
    fetch(`/api/rooms/${encodeURIComponent(PIN)}/answer`, {
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
        qIdx: currentQ,
        choice: choiceIdx,
        responseTimeMs: Math.round(ticksElapsed * 25)
      })
    })
    .then(r => r.json())
    .then(res => {
      if (res && res.success) {
        serverAnswerResult = res;
        if (typeof res.scoreEarned === 'number') {
          earnedThisQ = res.scoreEarned;
        }
      }
    })
    .catch(() => {});
  }

  /* Timer vẫn tiếp tục chạy — người chơi phải đợi hết giờ */
  /* Không gọi showResult ở đây */
}

function calcScore() {
  return Math.max(0, MAX_SCORE - ticksElapsed * 2.5);
}

/* Gọi khi timer hết hoặc khi toàn bộ thí sinh đã nộp bài — hiển thị đúng/sai rồi chuyển kết quả */
function revealAndShow() {
  if (isRevealing) return;
  isRevealing = true;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  const q = QUESTIONS[currentQ] || {};
  const btns = document.querySelectorAll('.choice-btn');
  btns.forEach(function(b) { b.disabled = true; });

  const correctIndex = (serverAnswerResult && serverAnswerResult.correctChoice !== undefined && serverAnswerResult.correctChoice >= 0)
    ? serverAnswerResult.correctChoice
    : (q.correct !== undefined ? q.correct : -1);

  if (!answered) {
    /* Chưa bấm — hết giờ */
    answered = true;
    earnedThisQ = 0;
    if (correctIndex >= 0 && btns[correctIndex]) {
      btns[correctIndex].classList.add('reveal-correct');
    }
    userAnswers.push({
      questionIndex: currentQ,
      userChoice: -1,
      isCorrect: false,
      earned: 0
    });
  } else {
    /* Đã bấm — giờ mới hiển thị đúng / sai */
    if (btns[selectedChoice]) btns[selectedChoice].classList.remove('selected');
    const isCorr = (serverAnswerResult && serverAnswerResult.isCorrect !== undefined)
      ? serverAnswerResult.isCorrect
      : (selectedChoice === correctIndex);

    if (isCorr) {
      if (btns[selectedChoice]) btns[selectedChoice].classList.add('correct');
    } else {
      if (btns[selectedChoice]) btns[selectedChoice].classList.add('wrong');
      if (correctIndex >= 0 && btns[correctIndex]) btns[correctIndex].classList.add('reveal-correct');
    }

    if (serverAnswerResult && typeof serverAnswerResult.scoreEarned === 'number') {
      earnedThisQ = serverAnswerResult.scoreEarned;
    }

    userAnswers.push({
      questionIndex: currentQ,
      userChoice: selectedChoice,
      isCorrect: isCorr,
      earned: earnedThisQ
    });
  }

  // Đợi 1.2s để người chơi thấy rõ kết quả đúng/sai trước khi hiện bảng xếp hạng
  setTimeout(function() {
    // Reset thanh thời gian đầy 100% trước khi chuyển cảnh
    resetTimerBar();
    showResult(earnedThisQ);
  }, 1200);
}

/* ════════════════════════════════════════════
   RESULT PANEL & BẢNG XẾP HẠNG THỰC TẾ ĐỒNG BỘ
   ════════════════════════════════════════════ */
async function showResult(earned) {
  totalScore += earned;

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
  const wasCorrect = earned > 0;
  document.getElementById('result-title').textContent =
    wasCorrect ? '✅ Đúng rồi!' : (earnedThisQ === 0 && answered ? '❌ Sai mất rồi!' : '⏰ Hết giờ!');
  document.getElementById('result-score-earned').innerHTML =
    '+' + Math.round(earned);
  document.getElementById('result-total').textContent =
    'Tổng điểm của bạn: ' + Math.round(totalScore);
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
  const isRealRoomWithHost = (PIN && PIN !== '---' && params.get('isTest') !== '1');
  if (isRealRoomWithHost) {
    startPlayerStateTracking(currentQ);
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
          if (idx >= 0) yourRank = idx + 1;
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
    const ans = userAnswers[i] || { userChoice: -1, isCorrect: false, earned: 0 };
    return {
      questionText: q.text,
      choices: q.choices,
      userChoice: ans.userChoice,
      correctChoice: q.correct,
      isCorrect: !!ans.isCorrect,
      earned: Math.round(ans.earned || 0)
    };
  });

  const payload = {
    pin: PIN,
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
    await fetch('/api/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-player-token': myPlayerToken
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
  } catch (err) {
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
    const ans = userAnswers[i] || { userChoice: -1, isCorrect: false, earned: 0 };
    const isCorr = ans.isCorrect;
    const statusBadge = isCorr
      ? '<span class="badge badge-correct">✓ Đúng (+' + Math.round(ans.earned) + 'đ)</span>'
      : (ans.userChoice === -1
          ? '<span class="badge badge-wrong">⏰ Hết giờ (0đ)</span>'
          : '<span class="badge badge-wrong">✗ Sai (0đ)</span>');

    const userText = ans.userChoice >= 0
      ? LETTERS[ans.userChoice] + '. ' + q.choices[ans.userChoice]
      : 'Không chọn';

    const correctText = LETTERS[q.correct] + '. ' + q.choices[q.correct];

    return '<div class="review-question-card ' + (isCorr ? 'card-correct' : 'card-wrong') + '">'
      + '<div class="rq-header">'
      + '  <span class="rq-num">Câu ' + (i+1) + ':</span>'
      + '  <span class="rq-title">' + q.text + '</span>'
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