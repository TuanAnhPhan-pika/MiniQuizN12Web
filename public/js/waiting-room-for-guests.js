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

  /* ── URL Params ── */
  const params = new URLSearchParams(location.search);
  const PIN = params.get('pin') || '---';
  const NICKNAME = params.get('nick') || 'Bạn';
  const AVATAR = params.get('av') || '01';
  const ROLE = params.get('role') || 'guest'; // 'host' hoặc 'guest'
  const isHost = (ROLE === 'host');

  // ID duy nhất cho người chơi trong phiên này
  let myPlayerId = sessionStorage.getItem('mqc_my_player_id');
  if (!myPlayerId) {
    myPlayerId = 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    sessionStorage.setItem('mqc_my_player_id', myPlayerId);
  }

  /* ── Hiển thị thông tin ban đầu ── */
  document.getElementById('pin-display').textContent = PIN;

  document.getElementById('guest-status-box').style.display = 'flex';
  document.getElementById('btn-leave-room').href = 'index.html';
  document.getElementById('btn-leave-room').textContent = '✕ Thoát phòng';

  /* ── Helper: Escape HTML ── */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ── SAO CHÉP ĐƯỜNG DẪN THAM GIA PHÒNG THI ── */
  function copyPinCode() {
    const baseUrl = window.__SERVER_PUBLIC_URL__ || window.location.origin;
    const joinUrl = `${baseUrl}/index.html?pin=${encodeURIComponent(PIN)}`;

    const copyText = (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          document.body.removeChild(textarea);
          resolve();
        } catch (e) {
          document.body.removeChild(textarea);
          reject(e);
        }
      });
    };

    copyText(joinUrl).then(() => {
      const btn = document.getElementById('btn-copy-pin');
      if (btn) {
        const oldHtml = btn.innerHTML;
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => { btn.innerHTML = oldHtml; }, 1500);
      }
      if (typeof showToast === 'function') {
        showToast('Đã sao chép đường dẫn tham gia phòng thi!');
      }
    }).catch(() => {});
  }

  /* ── RENDER DANH SÁCH NGƯỜI CHƠI ── */
  function renderPlayers(players) {
    const grid = document.getElementById('players-grid');
    const badge = document.getElementById('players-count-badge');
    badge.textContent = `${players.length} người`;

    if (!players || players.length === 0) {
      grid.innerHTML = '<div class="empty-players-hint">Chưa có người chơi nào tham gia</div>';
      return;
    }

    grid.innerHTML = players.map(p => {
      const isYou = (p.id === myPlayerId) || (!p.id && p.nick === NICKNAME && p.isHost === isHost);
      const isPlayerHost = !!p.isHost;
      const avId = p.av || '01';

      return `
        <div class="player-slot-card ${isYou ? 'is-you' : ''}">
          <div class="player-avatar-ring">
            <img class="player-avatar-img" src="characters/${avId}.png" alt="${escapeHtml(p.nick)}" />
          </div>
          <div class="player-slot-name" title="${escapeHtml(p.nick)}">
            ${escapeHtml(p.nick)}
          </div>
          ${isPlayerHost ? '<span class="badge-host">👑 Chủ phòng</span>' : (isYou ? '<span class="badge-you">Bạn</span>' : '')}
        </div>
      `;
    }).join('');
  }

  /* ── THAM GIA VÀO PHÒNG (JOIN API) ── */
  let currentPlayers = [];
  let pollInterval = null;

  async function joinWaitingRoom() {
    // 1. Lấy thông tin phòng từ customRooms nếu có sẵn
    try {
      const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
      if (customRooms[PIN] && customRooms[PIN].title) {
        document.getElementById('room-title-display').textContent = customRooms[PIN].title;
      }
    } catch (e) {}

    // 2. Gửi request tham gia lên server
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: myPlayerId,
          nick: NICKNAME,
          av: AVATAR,
          isHost: isHost
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (data.player && data.player.playerToken) {
            sessionStorage.setItem('mqc_my_player_token_' + PIN, data.player.playerToken);
            sessionStorage.setItem('mqc_my_player_token', data.player.playerToken);
          }
          if (data.player && data.player.id) {
            myPlayerId = data.player.id;
            sessionStorage.setItem('mqc_my_player_id', myPlayerId);
          }
          if (data.title) {
            document.getElementById('room-title-display').textContent = data.title;
          }
          currentPlayers = data.players || (data.room && data.room.players) || [];
          renderPlayers(currentPlayers);
          syncLocalRoomState(currentPlayers, data.status);
        }
      } else {
        // Nếu server trả về 404 (chưa có phòng trên server, fallback dùng local)
        fallbackLocalJoin();
      }
    } catch (err) {
      fallbackLocalJoin();
    }

    // 3. Bắt đầu polling đồng bộ định kỳ mỗi 1.2s
    startPollingStatus();
  }

  /* Fallback nếu chạy local/offline */
  function fallbackLocalJoin() {
    const key = `mqc_waiting_players_${PIN}`;
    let players = [];
    try {
      players = JSON.parse(localStorage.getItem(key) || '[]');
    } catch (e) {}

    const myEntry = { id: myPlayerId, nick: NICKNAME, av: AVATAR, isHost };
    const idx = players.findIndex(p => p.id === myPlayerId || (p.nick === NICKNAME && p.isHost === isHost));
    if (idx >= 0) {
      players[idx] = myEntry;
    } else {
      players.push(myEntry);
    }
    localStorage.setItem(key, JSON.stringify(players));
    currentPlayers = players;
    renderPlayers(currentPlayers);
  }

  function syncLocalRoomState(players, status) {
    try {
      localStorage.setItem(`mqc_waiting_players_${PIN}`, JSON.stringify(players));
      if (status) {
        localStorage.setItem(`mqc_room_status_${PIN}`, status);
      }
    } catch (e) {}
  }

  /* ── POLLING ĐỒNG BỘ TRẠNG THÁI PHÒNG ── */
  function startPollingStatus() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      // 1. Kiểm tra trạng thái từ server
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/status`);
        if (res.status === 404) {
          // Phòng thi đã bị chủ phòng xóa hoặc hết hạn!
          handleRoomCancelled();
          return;
        }

        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            if (data.title) {
              document.getElementById('room-title-display').textContent = data.title;
            }
            if (Array.isArray(data.players)) {
              currentPlayers = data.players;
              renderPlayers(currentPlayers);
              syncLocalRoomState(currentPlayers, data.status);
            }

            // NẾU CHỦ PHÒNG ĐÃ BẮT ĐẦU THI -> ĐẾM NGƯỢC 5S VÀ CHUYỂN VÀO PHÒNG LÀM BÀI!
            if (data.status === 'countdown') {
              startGuestCountdown(data.countdown || 5);
              return;
            }
            if (data.status === 'started') {
              startGuestCountdown(0);
              return;
            }
            return;
          }
        }
      } catch (e) {}

      // 2. Fallback kiểm tra từ localStorage
      try {
        const localStatus = localStorage.getItem(`mqc_room_status_${PIN}`);
        if (localStatus === 'cancelled') {
          handleRoomCancelled();
          return;
        }
        if (localStatus === 'countdown') {
          startGuestCountdown(5);
          return;
        }
        if (localStatus === 'started') {
          startGuestCountdown(0);
          return;
        }
        const localPlayers = JSON.parse(localStorage.getItem(`mqc_waiting_players_${PIN}`) || '[]');
        if (localPlayers.length > 0) {
          renderPlayers(localPlayers);
        }
      } catch (err) {}
    }, 1200);
  }

  // Lắng nghe storage event (cho phép các tab khác nhau trên cùng máy phản ứng ngay lập tức khi host bấm start hoặc hủy phòng)
  window.addEventListener('storage', function(e) {
    if (e.key === `mqc_room_status_${PIN}`) {
      if (e.newValue === 'countdown') startGuestCountdown(5);
      if (e.newValue === 'started') startGuestCountdown(0);
      if (e.newValue === 'cancelled') handleRoomCancelled();
    }
    if (e.key === `mqc_waiting_players_${PIN}`) {
      try {
        const updated = JSON.parse(e.newValue || '[]');
        renderPlayers(updated);
      } catch (err) {}
    }
  });

  /* ── XỬ LÝ KHI CHỦ PHÒNG HỦY PHÒNG THI ── */
  let roomCancelledNotified = false;
  function handleRoomCancelled() {
    if (roomCancelledNotified) return;
    roomCancelledNotified = true;
    if (pollInterval) clearInterval(pollInterval);

    // Dọn dẹp session người chơi
    sessionStorage.removeItem('mqc_my_player_id');

    const modal = document.getElementById('cancelled-modal');
    if (modal) {
      modal.classList.add('show');
    } else {
      alert('Phòng thi đã bị hủy');
      confirmExitAfterCancelled();
    }
  }

  function confirmExitAfterCancelled() {
    const target = loggedInUser ? 'dashboard.html' : 'index.html';
    window.location.href = target;
  }

  /* ── NGƯỜI CHƠI BẤM THOÁT PHÒNG ── */
  async function handleLeaveWaitingRoom() {
    const btn = document.getElementById('btn-leave-room');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Đang thoát...';
    }
    if (pollInterval) clearInterval(pollInterval);

    // 1. Gửi request báo lên server để xóa khỏi danh sách phòng chờ
    try {
      await fetch(`/api/rooms/${encodeURIComponent(PIN)}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: myPlayerId, nick: NICKNAME })
      });
    } catch (err) {}

    // 2. Cập nhật localStorage cục bộ
    try {
      const key = `mqc_waiting_players_${PIN}`;
      let players = JSON.parse(localStorage.getItem(key) || '[]');
      players = players.filter(p => p.id !== myPlayerId && p.nick !== NICKNAME);
      localStorage.setItem(key, JSON.stringify(players));
    } catch (e) {}

    sessionStorage.removeItem('mqc_my_player_id');

    // 3. Chuyển hướng người dùng
    const target = loggedInUser ? 'dashboard.html' : 'index.html';
    window.location.href = target;
  }

  // Tự động giải phóng chỗ khi tắt tab hoặc rời trang
  window.addEventListener('pagehide', function() {
    if (PIN && myPlayerId) {
      const payload = JSON.stringify({ id: myPlayerId, nick: NICKNAME });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(`/api/rooms/${encodeURIComponent(PIN)}/leave`, payload);
      }
    }
  });

  /* ── ĐẾM NGƯỢC 5 4 3 2 1 TRÊN NỀN XÁM MỜ VÀ CHUYỂN VÀO PHÒNG LÀM BÀI ── */
  let guestCountdownActive = false;
  let guestCountdownTimer = null;

  function startGuestCountdown(initialSec = 5) {
    if (redirected || guestCountdownActive) return;
    guestCountdownActive = true;
    if (pollInterval) clearInterval(pollInterval);

    if (initialSec <= 0) {
      goToExamRoom();
      return;
    }

    const overlay = document.getElementById('countdown-overlay');
    const numEl = document.getElementById('countdown-num');
    if (overlay) overlay.classList.add('show');

    let remain = initialSec;
    if (numEl) numEl.textContent = remain;

    if (guestCountdownTimer) clearInterval(guestCountdownTimer);
    guestCountdownTimer = setInterval(() => {
      remain--;
      if (remain > 0) {
        if (numEl) {
          numEl.textContent = remain;
          numEl.style.animation = 'none';
          void numEl.offsetWidth; // reflow
          numEl.style.animation = 'countNumberPop 0.9s cubic-bezier(0.34, 1.56, 0.64, 1)';
        }
      } else {
        clearInterval(guestCountdownTimer);
        if (numEl) {
          numEl.textContent = 'GO!';
          numEl.style.fontSize = '8rem';
        }
        setTimeout(() => {
          goToExamRoom();
        }, 600);
      }
    }, 1000);
  }

  /* ── CHUYỂN HƯỚNG VÀO PHÒNG THI KHI CHỦ PHÒNG BẮT ĐẦU ── */
  let redirected = false;
  function goToExamRoom() {
    if (redirected) return;
    redirected = true;
    if (pollInterval) clearInterval(pollInterval);
    if (guestCountdownTimer) clearInterval(guestCountdownTimer);

    // Chuyển khách đến phòng làm bài room.html
    const targetUrl = `room.html?pin=${encodeURIComponent(PIN)}&nick=${encodeURIComponent(NICKNAME)}&av=${encodeURIComponent(AVATAR)}`;
    window.location.href = targetUrl;
  }

  /* ── Check Auth: Người đã đăng nhập thoát phòng sẽ về dashboard ── */
  let loggedInUser = null;
  async function checkAuthAndAdjustLeaveButton() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.success) {
          loggedInUser = data;
          // Hiển thị chip tài khoản trên Header
          const headerRight = document.querySelector('.header-right');
          if (headerRight && !document.getElementById('header-user-chip')) {
            const chipHtml = `
              <div class="user-chip" id="header-user-chip" title="${escapeHtml(data.displayName)} (${escapeHtml(data.username)})" style="display:inline-flex; align-items:center; gap:8px; background:#eff6ff; border:1.5px solid #bfdbfe; padding:5px 12px; border-radius:20px; font-size:0.88rem; font-weight:700; color:#1d4ed8; margin-right:6px;">
                <span>👨‍🏫</span>
                <span>${escapeHtml(data.displayName)}</span>
              </div>
            `;
            headerRight.insertAdjacentHTML('afterbegin', chipHtml);
          }
        }
      }
    } catch (err) {
      // Khách chưa đăng nhập -> giữ nguyên link về index.html
    }
  }

  // Khởi động khi vào trang
  window.addEventListener('DOMContentLoaded', () => {
    checkAuthAndAdjustLeaveButton();
    joinWaitingRoom();
  });