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
    if (btn) {
      btn.addEventListener('click', function () {
        const isDark = document.body.classList.toggle('dark');
        localStorage.setItem('mqc-dark', isDark ? '1' : '0');
      });
    }
    function buildStars() {
      const el = document.getElementById('stars');
      if (!el) return;
      el.innerHTML = '';
      for (let i = 0; i < 60; i++) {
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

  /* ── PIN mask ── */
  const pinInput = document.getElementById('pin-input');
  if (pinInput) {
    pinInput.addEventListener('input', function () {
      let raw = this.value.replace(/[^0-9]/g, '').slice(0, 6);
      this.value = raw.length > 3 ? raw.slice(0, 3) + '-' + raw.slice(3) : raw;
      document.getElementById('error-msg')?.classList.remove('show');
      pinInput.style.borderColor = '';
    });
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleJoin(); });
  }

  /* ── Valid rooms & Realtime Server PIN check ── */
  let validatedPin = '';

  async function handleJoin() {
    const pin = pinInput.value.trim();
    if (!/^[0-9]{3}-[0-9]{3}$/.test(pin)) {
      document.getElementById('error-msg').textContent = '❌ Mã phòng sai hoặc không tồn tại';
      document.getElementById('error-msg').classList.add('show');
      pinInput.style.borderColor = '#D32F2F';
      return;
    }

    // 1. Kiểm tra trực tiếp qua Server API để các máy khác nhau đều kết nối được
    let isValid = false;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(pin)}?check=1`);
      if (res.ok) {
        const data = await res.json();
        if (data.locked) {
          document.getElementById('error-msg').textContent = '❌ Phòng thi đang khóa, không thể vào';
          document.getElementById('error-msg').classList.add('show');
          pinInput.style.borderColor = '#D32F2F';
          return;
        }
        if (data.full) {
          document.getElementById('error-msg').textContent = '❌ Phòng không còn chỗ trống';
          document.getElementById('error-msg').classList.add('show');
          pinInput.style.borderColor = '#D32F2F';
          return;
        }
        if (data.success && data.room) {
          isValid = true;
          const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
          customRooms[pin] = data.room;
          localStorage.setItem('mqc_custom_rooms', JSON.stringify(customRooms));
        }
      }
    } catch (err) {
      console.warn('Lỗi kết nối server, kiểm tra offline fallback:', err);
    }

    // 2. Fallback offline cho các phòng mẫu mặc định
    if (!isValid) {
      try {
        const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
        const room = customRooms[pin];
        if (room) {
          if (room.isLocked) {
            document.getElementById('error-msg').textContent = '❌ Phòng thi đang khóa, không thể vào';
            document.getElementById('error-msg').classList.add('show');
            pinInput.style.borderColor = '#D32F2F';
            return;
          }
          const waitingPlayers = JSON.parse(localStorage.getItem(`mqc_waiting_players_${pin}`) || '[]');
          const cap = Number(room.capacity) || 40;
          if (waitingPlayers.length >= cap) {
            document.getElementById('error-msg').textContent = '❌ Phòng không còn chỗ trống';
            document.getElementById('error-msg').classList.add('show');
            pinInput.style.borderColor = '#D32F2F';
            return;
          }
          isValid = true;
        }
      } catch(e) {}

      if (!isValid) {
        const DEFAULT_ROOMS = new Set(['363-636', '123-456', '000-000', '888-999', '777-888']);
        if (DEFAULT_ROOMS.has(pin)) {
          isValid = true;
        }
      }
    }

    if (!isValid) {
      document.getElementById('error-msg').textContent = '❌ Mã phòng sai hoặc không tồn tại';
      document.getElementById('error-msg').classList.add('show');
      pinInput.style.borderColor = '#D32F2F';
      return;
    }

    validatedPin = pin;
    document.getElementById('dash-view-main').style.display = 'none';
    document.getElementById('step-nick').style.display = 'flex';
    buildAvatarGrid();
    const nickInput = document.getElementById('nickname-input');
    if (nickInput) {
      const userLabel = document.getElementById('user-chip-label')?.textContent || '';
      const match = userLabel.match(/^([^(]+)/);
      if (match) nickInput.value = match[1].trim();
    }
    nickInput?.focus();
  }

  /* ── Quay lại lưới Dashboard từ màn hình chọn Avatar ── */
  function backToDashboardGrid() {
    document.getElementById('step-nick').style.display = 'none';
    document.getElementById('dash-view-main').style.display = 'grid';
    document.getElementById('pin-input').focus();
  }

  /* ── Avatar grid ── */
  const AVATARS = [
    '01','02','03','04','06','08','09','10','11','13','14','15',
    '17','18','19','20','21','22','23','24','26','27','28','29',
    '30','31','32','33','34','36','37','38','39','40','41','42'
  ];
  let selectedAvatar = AVATARS[0];

  function buildAvatarGrid() {
    const grid = document.getElementById('avatar-grid');
    grid.innerHTML = '';
    AVATARS.forEach(id => {
      const btn = document.createElement('button');
      btn.className = 'av-btn' + (id === selectedAvatar ? ' selected' : '');
      btn.dataset.id = id;
      const img = document.createElement('img');
      img.src = 'characters/' + id + '.png';
      img.alt = id;
      img.loading = 'lazy';
      btn.appendChild(img);
      btn.addEventListener('click', () => selectAvatar(id));
      grid.appendChild(btn);
    });
  }

  function selectAvatar(id) {
    selectedAvatar = id;
    const prev = document.getElementById('avatar-preview');
    prev.classList.remove('pop');
    void prev.offsetWidth;
    prev.classList.add('pop');
    prev.src = 'characters/' + id + '.png';
    document.querySelectorAll('.av-btn').forEach(b =>
      b.classList.toggle('selected', b.dataset.id === id)
    );
  }

  function handleEnter() {
    const nick = document.getElementById('nickname-input').value.trim();
    if (!nick) {
      document.getElementById('error-nick').classList.add('show');
      return;
    }
    const url = 'waiting-room-for-guests.html?pin=' + validatedPin
      + '&nick=' + encodeURIComponent(nick)
      + '&av=' + selectedAvatar;
    window.location.href = url;
  }

  document.getElementById('nickname-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleEnter();
  });
  document.getElementById('nickname-input')?.addEventListener('input', () => {
    document.getElementById('error-nick').classList.remove('show');
  });

  /* ── Action Handlers ── */
  function handleCreateExam() {
    window.location.href = 'create-exam.html';
  }

  function handleCreateRoom() {
    window.location.href = 'create-room.html';
  }

  /* ── Auth: gate trang, hiển thị user, đăng xuất, đổi tên/mật khẩu ── */
  (async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) { window.location.href = 'index.html?needLogin=1'; return; }
      const data = await res.json();
      if (!data.authenticated) { window.location.href = 'index.html?needLogin=1'; return; }
      if (data.token && window.MQC_Auth) {
        window.MQC_Auth.setToken(data.token);
      }
      const u = data.user || data;
      const dName = u.displayName || u.username || 'Thầy Cô';
      const uName = u.username || '';
      document.getElementById('user-chip-label').textContent = uName ? `${dName} (${uName})` : dName;
    } catch (err) {
      window.location.href = 'index.html?needLogin=1';
      return;
    }

    try {
      loadUserHistory();
      loadHostedRoomsHistory();

      // Tự động nhận mã PIN nếu mở từ quét QR
      const urlParams = new URLSearchParams(window.location.search);
      const pinParam = urlParams.get('pin');
      if (pinParam) {
        const pinEl = document.getElementById('pin-input');
        if (pinEl) {
          let raw = pinParam.replace(/[^0-9]/g, '').slice(0, 6);
          pinEl.value = raw.length > 3 ? raw.slice(0, 3) + '-' + raw.slice(3) : raw;
          handleJoin();
        }
      }
    } catch (err) {
      console.warn('Lỗi khởi tạo dữ liệu dashboard:', err);
    }
  })();

  /* ── Lịch sử thi đấu của User trong Dashboard ── */
  let userHistoryData = [];

  async function loadUserHistory() {
    try {
      const res = await fetch('/api/history', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      userHistoryData = data.history || [];
      renderHistoryList(userHistoryData);
    } catch (e) {
      console.warn('Lỗi tải lịch sử:', e);
    }
  }

  function renderHistoryList(list) {
    const countEl = document.getElementById('hist-count');
    const listEl = document.getElementById('hist-list');
    if (!listEl) return;
    countEl.textContent = list.length;

    if (!list || list.length === 0) {
      listEl.innerHTML = '<div class="history-empty">Bạn chưa làm bài thi nào</div>';
      return;
    }

    const rankIcons = ['🥇', '🥈', '🥉'];
    listEl.innerHTML = list.map((item, idx) => {
      const rankIcon = rankIcons[item.rank - 1] || ('#' + item.rank);
      const titleStr = item.roomTitle || ('Đề thi PIN: ' + item.pin);
      const timeStr = new Date(item.finishedAt).toLocaleDateString('vi-VN', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      return `
        <div class="history-item" onclick="openHistoryDetails(${idx})" title="Bấm để xem chi tiết bài làm: ${escapeHtml(titleStr)}">
          <div class="history-item-top">
            <span class="history-title-text" title="${escapeHtml(titleStr)}">${escapeHtml(titleStr)}</span>
            <span class="history-rank">${rankIcon}</span>
          </div>
          <div class="history-item-bottom">
            <span>${timeStr}</span>
            <span class="history-score">${item.score}đ (${item.correctCount}/${item.totalQuestions})</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function openHistoryDetails(idx) {
    const item = userHistoryData[idx];
    if (!item) return;

    const titleStr = item.roomTitle || ('Đề thi PIN: ' + item.pin);
    document.getElementById('hist-modal-title').textContent = `Chi tiết bài làm: ${titleStr}`;
    document.getElementById('hist-modal-meta').innerHTML = `
      <span>Điểm: <strong>${item.score}/${item.maxScore}</strong></span> • 
      <span>Đúng: <strong>${item.correctCount}/${item.totalQuestions}</strong> câu (${item.accuracyPct}%)</span> • 
      <span>Xếp hạng: <strong>#${item.rank}/${item.totalPlayers}</strong></span>
    `;

    const letters = ['A', 'B', 'C', 'D'];
    const detailsContainer = document.getElementById('hist-details-list');
    if (!item.details || item.details.length === 0) {
      detailsContainer.innerHTML = '<div class="history-empty">Bài làm này không có dữ liệu câu hỏi chi tiết.</div>';
    } else {
      detailsContainer.innerHTML = item.details.map((q, qIdx) => {
        const isCorrect = !!q.isCorrect;
        const badge = isCorrect 
          ? `<span class="detail-badge badge-corr">✓ Đúng (+${q.earned}đ)</span>`
          : (q.userChoice === -1 
              ? `<span class="detail-badge badge-wrg">⏰ Hết giờ (0đ)</span>`
              : `<span class="detail-badge badge-wrg">✗ Sai (0đ)</span>`);

        const choicesHtml = (q.choices || []).map((c, cIdx) => {
          const isUserPick = q.userChoice === cIdx;
          const isCorrChoice = q.correctChoice === cIdx;
          let pickClass = '';
          if (isUserPick && isCorrChoice) pickClass = 'user-pick is-correct';
          else if (isUserPick) pickClass = 'user-pick';
          else if (isCorrChoice) pickClass = 'is-correct';

          let icon = '';
          if (isUserPick && isCorrChoice) icon = ' (Lựa chọn của bạn ✓)';
          else if (isUserPick) icon = ' (Lựa chọn của bạn ✗)';
          else if (isCorrChoice) icon = ' (Đáp án đúng ✓)';

          return `<div class="detail-choice-row ${pickClass}">
            <strong>${letters[cIdx] || (cIdx+1)}.</strong> ${escapeHtml(c)} <span style="font-size:0.75rem; margin-left:auto;">${icon}</span>
          </div>`;
        }).join('');

        return `
          <div class="detail-q-card ${isCorrect ? 'q-correct' : 'q-wrong'}">
            <div class="detail-q-header">
              <span class="detail-q-title"><strong>Câu ${qIdx + 1}:</strong> ${escapeHtml(q.questionText)}</span>
              ${badge}
            </div>
            <div class="detail-choices">
              ${choicesHtml}
            </div>
          </div>
        `;
      }).join('');
    }

    document.getElementById('history-modal').classList.add('show');
  }

  function closeHistoryDetails() {
    document.getElementById('history-modal').classList.remove('show');
  }

  /* ── Lịch sử 20 phòng thi đã tổ chức gần nhất của User trong Dashboard ── */
  let hostedRoomsData = [];

  async function loadHostedRoomsHistory() {
    try {
      const res = await fetch('/api/history/hosted', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        hostedRoomsData = data.hostedRooms || [];
        renderHostedRoomsList(hostedRoomsData);
      }
    } catch (e) {
      console.warn('Lỗi tải lịch sử phòng tổ chức:', e);
    }
  }

  function renderHostedRoomsList(list) {
    const countEl = document.getElementById('hosted-count');
    const listEl = document.getElementById('hosted-list');
    if (!listEl) return;
    if (countEl) countEl.textContent = list ? list.length : 0;

    if (!list || list.length === 0) {
      listEl.innerHTML = '<div class="history-empty">Chưa có phòng thi nào</div>';
      return;
    }

    listEl.innerHTML = list.map((item, idx) => {
      const titleStr = item.roomTitle || ('Phòng thi PIN: ' + item.pin);
      const timeStr = item.formattedTime || new Date(item.finishedAt || item.createdAt).toLocaleDateString('vi-VN', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      const stats = item.stats || {};
      const candStr = (stats.totalCandidates != null ? stats.totalCandidates : 0) + ' thí sinh';
      const avgScoreStr = stats.avgScore != null ? ` • TB: ${stats.avgScore}đ` : '';

      return `
        <div class="history-item hosted-room-item" onclick="openHostedStatsModal(${idx})" title="Bấm để xem báo cáo thống kê: ${escapeHtml(titleStr)}">
          <div class="history-item-top">
            <span class="history-title-text" title="${escapeHtml(titleStr)}">${escapeHtml(titleStr)}</span>
            <span class="hosted-pin-pill">${item.pin}</span>
          </div>
          <div class="history-item-bottom">
            <span>${timeStr}</span>
            <span class="history-score">${candStr}${avgScoreStr}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function openHostedStatsModal(idx) {
    const item = hostedRoomsData[idx];
    if (!item) return;

    const stats = item.stats || {};
    const titleStr = item.roomTitle || ('Phòng thi PIN: ' + item.pin);
    const titleEl = document.getElementById('d-modal-title');
    const metaEl = document.getElementById('d-modal-meta');
    if (titleEl) titleEl.textContent = `Báo Cáo Thống Kê: ${titleStr}`;
    if (metaEl) metaEl.textContent = `Mã PIN: ${item.pin} • Thời gian: ${item.formattedTime || new Date(item.finishedAt || item.createdAt).toLocaleString('vi-VN')}`;

    // 1. 3 Thẻ số liệu tổng quan
    const candEl = document.getElementById('d-stat-candidates');
    const avgEl = document.getElementById('d-stat-avg-score');
    const maxEl = document.getElementById('d-stat-max-score');
    if (candEl) candEl.textContent = `${stats.totalCandidates || 0} / ${stats.capacity || 40}`;
    if (avgEl) avgEl.textContent = `${stats.avgScore || 0} / ${stats.maxPossibleScore || 0}`;
    if (maxEl) maxEl.textContent = `${stats.maxScore || 0} / ${stats.maxPossibleScore || 0}`;

    // 2. Bảng 1: Thống kê tỷ lệ theo từng câu hỏi
    const qTbody = document.getElementById('d-questions-tbody');
    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
    if (qTbody) {
      if (!stats.questionsStats || stats.questionsStats.length === 0) {
        qTbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:12px; color:var(--gray-text);">Không có dữ liệu câu hỏi chi tiết</td></tr>';
      } else {
        qTbody.innerHTML = stats.questionsStats.map(q => {
          let ratioClass = 'ratio-low';
          if (q.ratioPct >= 70) ratioClass = 'ratio-high';
          else if (q.ratioPct >= 50) ratioClass = 'ratio-mid';

          return `
            <tr>
              <td><strong>Câu ${q.qIdx}:</strong> ${escapeHtml(q.text)}</td>
              <td><span class="correct-ans-tag" style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:6px; font-weight:700;">${escapeHtml(q.correctText || ('Lựa chọn ' + (LETTERS[q.correctIndex] || (q.correctIndex + 1))))}</span></td>
              <td style="text-align: center; font-weight: 800;">${q.correctCount} / ${q.totalCount}</td>
              <td style="text-align: center;"><span class="ratio-pill ${ratioClass}" style="font-weight:800; padding:2px 8px; border-radius:10px;">${q.ratioPct}%</span></td>
            </tr>
          `;
        }).join('');
      }
    }

    // 3. Bảng 2: Ma trận kết quả chi tiết từng thí sinh
    const sortedCandidates = [...(stats.candidatesMatrix || [])].sort((a, b) => {
      return (b.ratioPct - a.ratioPct) || (b.score - a.score);
    });

    const numQuestions = (stats.questionsStats || []).length;
    const matrixTable = document.getElementById('d-matrix-table');
    if (matrixTable) {
      if (numQuestions > 4) {
        matrixTable.classList.add('has-horizontal-scroll');
      } else {
        matrixTable.classList.remove('has-horizontal-scroll');
      }
    }

    const theadTr = document.getElementById('d-matrix-thead-tr');
    if (theadTr) {
      const qHeaderCols = (stats.questionsStats || []).map(q => `<th class="matrix-q-col" style="text-align:center; min-width:60px;">Câu ${q.qIdx}</th>`).join('');
      theadTr.innerHTML = `
        <th class="sticky-col-player">Người chơi</th>
        ${qHeaderCols}
        <th class="sticky-col-score">Số điểm đạt được</th>
        <th class="sticky-col-ratio">Tỉ lệ (%)</th>
      `;
    }

    const matrixTbody = document.getElementById('d-matrix-tbody');
    if (matrixTbody) {
      if (sortedCandidates.length === 0) {
        matrixTbody.innerHTML = `<tr><td colspan="${numQuestions + 3}" style="text-align:center; padding:16px; color:var(--gray-text);">Chưa có thí sinh nào tham gia nộp bài</td></tr>`;
      } else {
        matrixTbody.innerHTML = sortedCandidates.map(cand => {
          const dotsCols = (cand.answersMap || []).map(isCorr => `
            <td class="matrix-q-col" style="text-align:center;">
              <span class="matrix-dot ${isCorr ? 'dot-correct' : 'dot-wrong'}" style="display:inline-block; font-size:1rem;" title="${isCorr ? 'Đúng' : 'Sai / Bỏ qua'}">
                ${isCorr ? '🟢' : '🔴'}
              </span>
            </td>
          `).join('');

          return `
            <tr>
              <td class="sticky-col-player">
                <div class="matrix-player-cell" style="display:flex; align-items:center; gap:8px;">
                  <img class="matrix-player-av" src="characters/${cand.av || '01'}.png" alt="" style="width:28px; height:28px; border-radius:50%;" />
                  <span style="font-weight:700;">${escapeHtml(cand.nick)}</span>
                </div>
              </td>
              ${dotsCols}
              <td class="sticky-col-score" style="font-weight:800; color:#0284c7;">
                <span class="matrix-score-val">${Math.round(cand.score || 0)} điểm</span>
              </td>
              <td class="sticky-col-ratio" style="font-weight:800; text-align:center;">
                <span class="matrix-ratio-val">${cand.ratioPct}%</span>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    const modal = document.getElementById('hosted-stats-modal');
    if (modal) modal.classList.add('show');
  }

  function closeHostedStatsModal() {
    const modal = document.getElementById('hosted-stats-modal');
    if (modal) modal.classList.remove('show');
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

  async function handleLogout(e) {
    if (e) e.preventDefault();
    if (window.MQC_Auth) {
      window.MQC_Auth.clearToken();
    }
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (err) {}
    window.location.href = 'index.html';
  }

  function openSettingsModal() {
    document.getElementById('settings-modal').classList.add('show');
    document.getElementById('settings-msg').classList.remove('show');
    document.getElementById('settings-current-pass').value = '';
    document.getElementById('settings-name').value = '';
    document.getElementById('settings-new-pass').value = '';
    document.getElementById('settings-confirm-pass').value = '';
  }
  function closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('show');
  }

  async function handleSaveSettings() {
    const currentPassword = document.getElementById('settings-current-pass').value;
    const newDisplayName = document.getElementById('settings-name').value.trim();
    const newPassword = document.getElementById('settings-new-pass').value;
    const confirmNewPassword = document.getElementById('settings-confirm-pass').value;
    const msg = document.getElementById('settings-msg');
    msg.classList.remove('show', 'warning');

    if (newPassword && newPassword !== confirmNewPassword) {
      msg.textContent = '❌ Xác nhận mật khẩu mới không khớp';
      msg.classList.add('show');
      return;
    }
    try {
      const res = await fetch('/api/auth/change-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ currentPassword, newDisplayName, newPassword, confirmNewPassword }),
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('user-chip-label').textContent = data.displayName + ' (' + data.username + ')';
        closeSettingsModal();
      } else {
        msg.textContent = (res.status === 429 ? '⚠️ ' : '❌ ') + (data.message || 'Cập nhật thất bại');
        msg.classList.toggle('warning', res.status === 429);
        msg.classList.add('show');
      }
    } catch (err) {
      msg.textContent = '❌ Không thể kết nối tới máy chủ.';
      msg.classList.add('show');
    }
  }