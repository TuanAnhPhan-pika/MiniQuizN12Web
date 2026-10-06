  /* ── Colorize title ── */
  document.getElementById('app-title').innerHTML =
    [...'Mini Quiz Classroom'].map(ch =>
      ch === ' ' ? '<span class="space"> </span>' : '<span>' + ch + '</span>'
    ).join('');

  /* ── Dark mode ── */
  (function () {
    const btn = document.getElementById('btn-dark');
    const saved = localStorage.getItem('mqc-dark');
    if (saved === '1') document.body.classList.add('dark');
    buildStars();
    if (btn) btn.addEventListener('click', function () {
      const isDark = document.body.classList.toggle('dark');
      localStorage.setItem('mqc-dark', isDark ? '1' : '0');
    });
    function buildStars() {
      const el = document.getElementById('stars');
      if (!el) return;
      el.innerHTML = '';
      for (let i = 0; i < 50; i++) {
        const s = document.createElement('div');
        s.className = 'star';
        const size = Math.random() * 2.5 + 1;
        s.style.cssText = [
          'width:' + size + 'px',
          'height:' + size + 'px',
          'top:' + (Math.random() * 90) + '%',
          'left:' + (Math.random() * 100) + '%',
          'animation-delay:' + (Math.random() * 3) + 's',
          'animation-duration:' + (Math.random() * 2 + 1.5) + 's',
        ].join(';');
        el.appendChild(s);
      }
    }
  })();

  /* ── URL Params & Room State ── */
  const params = new URLSearchParams(location.search);
  const PIN = (params.get('pin') || '').trim();

  if (!PIN) {
    alert('Mã PIN không hợp lệ!');
    window.location.href = 'create-room.html';
  }

  document.getElementById('room-pin').textContent = `PIN: ${PIN}`;

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  let QUESTIONS = [];
  let EXAM_TITLE = 'Phòng thi trực tuyến';
  let TIMER_SECS = 15;
  const TICK_MS = 500;

  let currentQ = 0;
  let timerInterval = null;
  let ticksElapsed = 0;
  let qStatsInterval = null;
  let lbCountdownInterval = null;
  let lbAutoNextTimeout = null;
  let currentRoom = null;

  /* Helper Escape HTML */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ── 1. TẢI DỮ LIỆU ĐỀ THI TỪ SERVER & LOCAL CACHE ── */
  async function initMonitor() {
    let isFinished = (sessionStorage.getItem('mqc_monitor_finished_' + PIN) === '1');

    // Đọc local cache phòng thi
    try {
      const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
      if (customRooms[PIN]) {
        currentRoom = customRooms[PIN];
        if (Array.isArray(currentRoom.questions) && currentRoom.questions.length > 0) {
          QUESTIONS = currentRoom.questions;
        }
        if (currentRoom.name || currentRoom.title) {
          EXAM_TITLE = currentRoom.name || currentRoom.title;
        }
        if (currentRoom.timePerQ) {
          TIMER_SECS = Number(currentRoom.timePerQ);
        }
      }
    } catch(e) {}

    // Tải từ Server
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.room) {
          currentRoom = data.room;
          if (Array.isArray(data.room.questions) && data.room.questions.length > 0) {
            QUESTIONS = data.room.questions;
          }
          if (data.room.name || data.room.title) {
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
    } catch(err) {}

    // Cập nhật tiêu đề phòng
    document.getElementById('room-title').textContent = EXAM_TITLE;

    if (!QUESTIONS || QUESTIONS.length === 0) {
      alert('Không tìm thấy câu hỏi trong phòng thi!');
      window.location.href = 'create-room.html';
      return;
    }

    // Nếu vừa reload khi đang xem báo cáo thống kê hoặc đề thi đã hoàn thành
    if (isFinished) {
      showFinalStatistics();
      return;
    }

    loadQuestion(0);
  }

  /* ── 2. NẠP VÀ HIỂN THỊ CÂU HỎI HIỆN TẠI (CỠ LỚN) ── */
  function loadQuestion(idx) {
    currentQ = idx;
    ticksElapsed = 0;

    if (lbCountdownInterval) clearInterval(lbCountdownInterval);
    if (lbAutoNextTimeout) clearTimeout(lbAutoNextTimeout);

    // Đồng bộ trạng thái bắt đầu câu hỏi lên máy chủ
    if (PIN && PIN !== '---') {
      fetch(`/api/rooms/${encodeURIComponent(PIN)}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextQ: idx, phase: 'question' })
      }).catch(() => {});
    }

    const q = QUESTIONS[idx];
    document.getElementById('q-counter').textContent = `Câu ${idx + 1} / ${QUESTIONS.length}`;
    document.getElementById('q-text').textContent = q.text;

    // Render danh sách lựa chọn lớn (chưa lộ đáp án đúng)
    const grid = document.getElementById('choices-grid');
    grid.innerHTML = (q.choices || []).map((text, i) => `
      <div class="monitor-choice-item" id="choice-item-${i}">
        <div class="choice-live-fill" id="choice-fill-${i}"></div>
        <div class="choice-left-content">
          <span class="choice-letter">${LETTERS[i] || (i + 1)}</span>
          <span class="choice-answer-text">${escapeHtml(text)}</span>
        </div>
        <div class="choice-stats-badge" id="choice-badge-${i}">
          👥 0 (0%)
        </div>
      </div>
    `).join('');

    // Hiển thị khung câu hỏi, ẩn BXH và Thống kê
    document.getElementById('question-card').style.display = 'flex';
    document.getElementById('timer-wrapper').style.display = 'flex';
    document.getElementById('leaderboard-panel').classList.remove('show');
    document.getElementById('final-stats-panel').classList.remove('show');

    // Khởi động thanh thời gian đếm ngược
    startMonitorTimer();

    // Bắt đầu theo dõi số lượng thí sinh chọn đáp án realtime
    startLiveStatsTracking(idx);
  }

  /* ── 3. THANH THỜI GIAN ĐẾM NGƯỢC ── */
  function resetTimerBar() {
    const bar = document.getElementById('timer-bar');
    const secs = document.getElementById('timer-secs');
    bar.style.transition = 'none';
    bar.style.width = '100%';
    bar.classList.remove('warning', 'danger');
    secs.textContent = TIMER_SECS;
    void bar.offsetWidth;
    bar.style.transition = 'width 0.5s linear, background 0.5s';
  }

  function startMonitorTimer() {
    clearInterval(timerInterval);
    resetTimerBar();

    timerInterval = setInterval(() => {
      ticksElapsed++;
      const secsLeft = Math.max(0, TIMER_SECS - ticksElapsed * (TICK_MS / 1000));
      updateTimerUI(secsLeft);

      if (ticksElapsed >= TIMER_SECS * (1000 / TICK_MS)) {
        clearInterval(timerInterval);
        handleTimeUp();
      }
    }, TICK_MS);
  }

  function updateTimerUI(secsLeft) {
    const bar = document.getElementById('timer-bar');
    const secs = document.getElementById('timer-secs');
    const pct = (secsLeft / TIMER_SECS) * 100;
    bar.style.width = pct + '%';
    secs.textContent = Math.ceil(secsLeft);
    bar.classList.remove('warning', 'danger');
    if (pct <= 30) bar.classList.add('danger');
    else if (pct <= 60) bar.classList.add('warning');
  }

  /* ── 4. THEO DÕI THỜI GIAN THỰC SỐ LƯỢNG THÍ SINH CHỌN TỪNG ĐÁP ÁN ── */
  function startLiveStatsTracking(qIdx) {
    if (qStatsInterval) clearInterval(qStatsInterval);

    async function fetchStats() {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/question-stats?q=${qIdx}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            updateChoiceStatsUI(data.choicesCount || [], data.totalAnswered || 0, data.totalCandidates || 0);

            // KIỂM TRA ĐIỀU KIỆN: Toàn bộ người chơi đã gửi tín hiệu chọn đáp án!
            if (data.allAnswered && data.totalCandidates > 0) {
              if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
              }
              if (qStatsInterval) {
                clearInterval(qStatsInterval);
                qStatsInterval = null;
              }
              handleTimeUp();
            }
          }
        }
      } catch (err) {}
    }

    fetchStats();
    qStatsInterval = setInterval(fetchStats, 600);
  }

  function updateChoiceStatsUI(choicesCount, totalAnswered, totalCandidates) {
    document.getElementById('live-responder-badge').textContent =
      `👥 Đã trả lời: ${totalAnswered} / ${totalCandidates} thí sinh`;

    choicesCount.forEach((count, i) => {
      const badge = document.getElementById(`choice-badge-${i}`);
      const fill = document.getElementById(`choice-fill-${i}`);
      if (badge && fill) {
        const pct = totalAnswered > 0 ? Math.round((count / totalAnswered) * 100) : 0;
        badge.textContent = `👥 ${count} (${pct}%)`;
        fill.style.width = `${pct}%`;
      }
    });
  }

  /* ── 5. KHI HẾT GIỜ / TOÀN BỘ ĐÃ TRẢ LỜI: LỘ ĐÁP ÁN ĐÚNG SAU ĐÓ HIỆN BXH ── */
  function handleTimeUp() {
    if (qStatsInterval) {
      clearInterval(qStatsInterval);
      qStatsInterval = null;
    }
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    const q = QUESTIONS[currentQ];
    const correctIdx = q.correct;

    // Lộ đáp án đúng sau khi hết giờ hoặc toàn bộ thí sinh đã trả lời
    const correctEl = document.getElementById(`choice-item-${correctIdx}`);
    if (correctEl) {
      correctEl.classList.add('reveal-correct');
      const badge = document.getElementById(`choice-badge-${correctIdx}`);
      if (badge) {
        badge.innerHTML = `✓ Đáp án đúng (${badge.textContent.trim()})`;
      }
    }

    // Sau 1.5s nhìn đáp án chính xác thì hiển thị Bảng xếp hạng
    setTimeout(() => {
      showLeaderboardPanel();
    }, 1500);
  }

  /* ── 6. BẢNG XẾP HẠNG HIỂN THỊ TRONG 4 GIÂY KÈM NÚT SANG CÂU TIẾP THEO ── */
  async function showLeaderboardPanel() {
    document.getElementById('question-card').style.display = 'none';
    document.getElementById('timer-wrapper').style.display = 'none';
    const lbPanel = document.getElementById('leaderboard-panel');
    lbPanel.classList.add('show');

    // Đồng bộ trạng thái: Vào phase bảng xếp hạng cho tất cả thí sinh
    if (PIN && PIN !== '---') {
      fetch(`/api/rooms/${encodeURIComponent(PIN)}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextQ: currentQ, phase: 'result' })
      }).catch(() => {});
    }

    const isLast = (currentQ === QUESTIONS.length - 1);
    document.getElementById('lb-heading-title').textContent =
      `Bảng xếp hạng sau Câu ${currentQ + 1}`;

    const nextBtn = document.getElementById('btn-next-now');
    nextBtn.innerHTML = isLast ? '<span>Xem thống kê kết quả ➔</span>' : '<span>Sang câu tiếp theo ➔</span>';

    // Lấy BXH mới nhất từ máy chủ
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/leaderboard`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.leaderboard)) {
          renderPodiumAndRows(data.leaderboard);
        }
      }
    } catch (err) {}

    // Thiết lập đồng hồ đếm ngược 4 giây
    let remainSec = 4;
    const countdownEl = document.getElementById('lb-countdown-indicator');
    countdownEl.textContent = `⏱️ Tự chuyển sau: ${remainSec}s`;

    if (lbCountdownInterval) clearInterval(lbCountdownInterval);
    lbCountdownInterval = setInterval(() => {
      remainSec--;
      if (remainSec > 0) {
        countdownEl.textContent = `⏱️ Tự chuyển sau: ${remainSec}s`;
      } else {
        clearInterval(lbCountdownInterval);
      }
    }, 1000);

    // Tự động chuyển sau 4 giây nếu chủ phòng không bấm thủ công
    if (lbAutoNextTimeout) clearTimeout(lbAutoNextTimeout);
    lbAutoNextTimeout = setTimeout(() => {
      handleHostNextNow();
    }, 4000);
  }

  function renderPodiumAndRows(leaderboard) {
    const sorted = [...leaderboard].sort((a, b) => (b.score || 0) - (a.score || 0));
    const top3 = sorted.slice(0, 3);
    const maxScore = (top3[0] && top3[0].score > 0) ? top3[0].score : 1;
    const MAX_BAR_H = 110;

    const order = [top3[1], top3[0], top3[2]];
    const ids = [2, 1, 3];

    order.forEach((p, i) => {
      const rank = ids[i];
      const slot = document.getElementById(`pod-${rank}`);
      if (!slot) return;

      if (!p) {
        slot.style.visibility = 'hidden';
        return;
      }
      slot.style.visibility = 'visible';

      document.getElementById(`pod-av-${rank}`).src = `characters/${p.av || '01'}.png`;
      document.getElementById(`pod-name-${rank}`).textContent = p.nick;
      document.getElementById(`pod-score-${rank}`).textContent = Math.round(p.score || 0);

      const targetH = maxScore > 0 ? Math.round((p.score / maxScore) * MAX_BAR_H) : 20;
      const bar = document.getElementById(`pod-bar-${rank}`);
      bar.style.height = '0px';
      setTimeout(() => {
        bar.style.height = `${Math.max(targetH, 20)}px`;
      }, rank === 1 ? 0 : rank === 2 ? 120 : 240);
    });

    // Rows hạng 4+
    const rowsWrap = document.getElementById('lb-rows');
    const rest = sorted.slice(3);
    if (rest.length === 0) {
      rowsWrap.innerHTML = '';
    } else {
      rowsWrap.innerHTML = rest.map((p, i) => `
        <div class="m-lb-row">
          <div class="m-lb-rank">#${i + 4}</div>
          <img class="m-lb-avatar" src="characters/${p.av || '01'}.png" alt="${escapeHtml(p.nick)}" />
          <div class="m-lb-name">${escapeHtml(p.nick)}</div>
          <div class="m-lb-score">${Math.round(p.score || 0)} điểm</div>
        </div>
      `).join('');
    }
  }

  /* ── 7. CHỦ PHÒNG BẤM CHUYỂN CÂU HOẶC TỰ ĐỘNG CHUYỂN SAU 4S ── */
  async function handleHostNextNow() {
    if (lbCountdownInterval) clearInterval(lbCountdownInterval);
    if (lbAutoNextTimeout) clearTimeout(lbAutoNextTimeout);

    if (currentQ < QUESTIONS.length - 1) {
      const nextQ = currentQ + 1;
      // Thông báo cho máy chủ chuyển câu hỏi để tất cả thí sinh cùng chuyển
      if (PIN && PIN !== '---') {
        try {
          await fetch(`/api/rooms/${encodeURIComponent(PIN)}/advance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nextQ: nextQ, phase: 'question' })
          });
        } catch (e) {}
      }
      loadQuestion(nextQ);
    } else {
      // Thông báo kết thúc đề thi
      if (PIN && PIN !== '---') {
        try {
          await fetch('/api/history/hosted', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: PIN })
          });
        } catch (e) {}
      }
      showFinalStatistics();
    }
  }

  /* ── 8. KẾT THÚC ĐỀ THI: HIỂN THỊ BẢNG SỐ LIỆU THỐNG KÊ TOÀN DIỆN ── */
  async function showFinalStatistics() {
    if (PIN && PIN !== '---') {
      try {
        sessionStorage.setItem('mqc_monitor_finished_' + PIN, '1');
      } catch(e) {}
    }

    document.getElementById('question-card').style.display = 'none';
    document.getElementById('timer-wrapper').style.display = 'none';
    document.getElementById('leaderboard-panel').classList.remove('show');

    const statsPanel = document.getElementById('final-stats-panel');
    statsPanel.classList.add('show');
    document.getElementById('stats-exam-name').textContent = `${EXAM_TITLE} (${QUESTIONS.length} câu hỏi)`;

    // Lấy dữ liệu thống kê từ API server
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/exam-stats`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.stats) {
          renderStatsUI(data.stats);
          return;
        }
      }
    } catch(err) {}

    // Fallback nếu chạy local
    renderFallbackStats();
  }

  function renderStatsUI(stats) {
    // 1. 3 Thẻ số liệu tổng quan (chỉ giữ số liệu chính, loại bỏ dòng phụ)
    document.getElementById('stat-candidates').textContent = `${stats.totalCandidates} / ${stats.capacity}`;
    document.getElementById('stat-avg-score').textContent = `${stats.avgScore} / ${stats.maxPossibleScore}`;
    document.getElementById('stat-max-score').textContent = `${stats.maxScore} / ${stats.maxPossibleScore}`;

    // 2. Bảng 1: Thống kê tỷ lệ theo từng câu hỏi (kéo cuộn dọc nếu > 5 câu hỏi)
    const qTbody = document.getElementById('questions-stats-tbody');
    qTbody.innerHTML = (stats.questionsStats || []).map(q => {
      let ratioClass = 'ratio-low';
      if (q.ratioPct >= 70) ratioClass = 'ratio-high';
      else if (q.ratioPct >= 50) ratioClass = 'ratio-mid';

      return `
        <tr>
          <td><strong>Câu ${q.qIdx}:</strong> ${escapeHtml(q.text)}</td>
          <td><span class="correct-ans-tag">${escapeHtml(q.correctText || ('Lựa chọn ' + LETTERS[q.correctIndex]))}</span></td>
          <td style="text-align: center; font-weight: 800;">${q.correctCount} / ${q.totalCount}</td>
          <td style="text-align: center;"><span class="ratio-pill ${ratioClass}">${q.ratioPct}%</span></td>
        </tr>
      `;
    }).join('');

    // 3. Bảng 2: Ma trận kết quả chi tiết từng thí sinh
    // - Sắp xếp thí sinh theo tỉ lệ đúng giảm dần (nếu bằng thì theo điểm số giảm dần)
    const sortedCandidates = [...(stats.candidatesMatrix || [])].sort((a, b) => {
      return (b.ratioPct - a.ratioPct) || (b.score - a.score);
    });

    const numQuestions = (stats.questionsStats || []).length;
    const matrixTable = document.getElementById('matrix-table');
    // Nếu đề có nhiều hơn 4 câu hỏi -> kích hoạt kéo ngang các cột câu hỏi
    if (numQuestions > 4) {
      matrixTable.classList.add('has-horizontal-scroll');
    } else {
      matrixTable.classList.remove('has-horizontal-scroll');
    }

    const theadTr = document.getElementById('matrix-thead-tr');
    // Tạo tiêu đề các cột câu hỏi 1, 2, 3...
    const qHeaderCols = (stats.questionsStats || []).map(q => `<th class="matrix-q-col">Câu ${q.qIdx}</th>`).join('');
    theadTr.innerHTML = `
      <th class="sticky-col-player">Người chơi</th>
      ${qHeaderCols}
      <th class="sticky-col-score">Số điểm đạt được</th>
      <th class="sticky-col-ratio">Tỉ lệ (%)</th>
    `;

    const matrixTbody = document.getElementById('matrix-tbody');
    matrixTbody.innerHTML = sortedCandidates.map(cand => {
      const dotsCols = (cand.answersMap || []).map(isCorr => `
        <td class="matrix-q-col">
          <span class="matrix-dot ${isCorr ? 'dot-correct' : 'dot-wrong'}" title="${isCorr ? 'Đúng' : 'Sai / Bỏ qua'}">
            ${isCorr ? '✓' : '✕'}
          </span>
        </td>
      `).join('');

      return `
        <tr>
          <td class="sticky-col-player">
            <div class="matrix-player-cell">
              <img class="matrix-player-av" src="characters/${cand.av || '01'}.png" alt="" />
              <span>${escapeHtml(cand.nick)}</span>
            </div>
          </td>
          ${dotsCols}
          <td class="sticky-col-score">
            <span class="matrix-score-val">${Math.round(cand.score || 0)} điểm</span>
          </td>
          <td class="sticky-col-ratio">
            <span class="matrix-ratio-val">${cand.ratioPct}%</span>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderFallbackStats() {
    document.getElementById('stat-candidates').textContent = `0 / 40`;
    document.getElementById('stat-avg-score').textContent = `0 / ${QUESTIONS.length * 100}`;
    document.getElementById('stat-max-score').textContent = `0 / ${QUESTIONS.length * 100}`;
  }

  // Khởi chạy khi load trang
  initMonitor();