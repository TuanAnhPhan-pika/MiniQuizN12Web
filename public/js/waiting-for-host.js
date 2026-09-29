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

  /* ── URL Params & Room State ── */
  const params = new URLSearchParams(location.search);
  const PIN = (params.get('pin') || '').trim();

  if (!PIN) {
    alert('Mã PIN không hợp lệ!');
    window.location.href = 'create-room.html';
  }

  document.getElementById('pin-display').textContent = PIN;

  let currentRoom = null;
  let previousMemberIds = new Set();
  let isFirstLoad = true;
  let isRoomLocked = false;
  let roomCapacity = 40;
  let pollInterval = null;
  let countdownTimer = null;
  let isStarting = false;

  /* ── Escape HTML Helper ── */
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
        btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => { btn.innerHTML = oldHtml; }, 1500);
      }
      showToast('Đã sao chép đường dẫn tham gia phòng thi!', 'info');
    }).catch((err) => {
      console.error('Lỗi sao chép:', err);
      showToast('Không thể sao chép liên kết!', 'leave');
    });
  }

  /* ── TOAST THÔNG BÁO IN / OUT NHANH CHÓNG ── */
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `host-toast-item ${type}`;
    let icon = '📢';
    if (type === 'join') icon = '✨';
    if (type === 'leave') icon = '👋';

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(40px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  /* ── TẠO MÃ QR LỚN CHO CHIẾU MÀN HÌNH ── */
  async function setupLargeQRCode() {
    const qrBox = document.getElementById('qr-box');
    qrBox.innerHTML = '';

    // Mã QR trỏ đến domain hiện tại (Cloud Run / AI Studio / Local) kèm mã PIN nhập sẵn
    const baseUrl = window.__SERVER_PUBLIC_URL__ || window.location.origin;
    const joinUrl = `${baseUrl}/index.html?pin=${encodeURIComponent(PIN)}`;

    try {
      new QRCode(qrBox, {
        text: joinUrl,
        width: 440,
        height: 440,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (err) {
      console.error('Lỗi tạo mã QR:', err);
      qrBox.innerHTML = '<div style="color:red; font-weight:700;">Không thể sinh mã QR</div>';
    }
  }

  /* ── RENDER DANH SÁCH THÀNH VIÊN (KHÔNG TÍNH CHỦ PHÒNG) ── */
  function renderMembers(players) {
    const grid = document.getElementById('members-grid');
    const countEl = document.getElementById('count-curr');
    const maxEl = document.getElementById('count-max');

    // Lọc loại bỏ chủ phòng (không tính chủ phòng theo yêu cầu đề bài)
    const members = (players || []).filter(p => !p.isHost);

    countEl.textContent = members.length;
    maxEl.textContent = roomCapacity;

    // Phát hiện thành viên In / Out nhanh chóng
    const currentMemberIds = new Set(members.map(m => m.id || m.nick));

    if (!isFirstLoad) {
      // Thành viên mới vào
      members.forEach(m => {
        const key = m.id || m.nick;
        if (!previousMemberIds.has(key)) {
          showToast(`Thí sinh "${m.nick}" vừa tham gia phòng`, 'join');
        }
      });

      // Thành viên vừa rời phòng
      previousMemberIds.forEach(oldKey => {
        if (!currentMemberIds.has(oldKey)) {
          showToast(`Một thí sinh vừa rời phòng`, 'leave');
        }
      });
    }

    previousMemberIds = currentMemberIds;
    isFirstLoad = false;

    if (members.length === 0) {
      grid.innerHTML = `
        <div class="host-empty-members">
          <div class="host-empty-icon">⏳</div>
          <div class="host-empty-text">Chưa có thí sinh nào tham gia ...</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = members.map((m, index) => {
      const avId = m.av || '01';
      return `
        <div class="host-member-card" title="${escapeHtml(m.nick)}">
          <span class="host-member-order">#${index + 1}</span>
          <div class="host-member-avatar-ring">
            <img class="host-member-avatar-img" src="characters/${avId}.png" alt="${escapeHtml(m.nick)}" />
          </div>
          <div class="host-member-name">${escapeHtml(m.nick)}</div>
        </div>
      `;
    }).join('');
  }

  /* ── ĐỒNG BỘ TRẠNG THÁI KHÓA PHÒNG ── */
  function updateLockUI(locked) {
    isRoomLocked = !!locked;
    const btn = document.getElementById('btn-toggle-lock');
    const icon = document.getElementById('lock-icon');
    const text = document.getElementById('lock-text');

    if (isRoomLocked) {
      btn.classList.add('is-locked');
      icon.textContent = '🔒';
      text.textContent = 'Đang khóa';
      btn.title = 'Phòng đang khóa - Bấm để mở lại tiếp nhận thí sinh';
    } else {
      btn.classList.remove('is-locked');
      icon.textContent = '🔓';
      text.textContent = 'Đang mở';
      btn.title = 'Phòng đang mở - Bấm để khóa phòng ngăn người lạ vào';
    }
  }

  async function handleToggleLock() {
    const nextState = !isRoomLocked;
    updateLockUI(nextState);

    // Gửi cập nhật trạng thái lên server
    try {
      await fetch(`/api/rooms/${encodeURIComponent(PIN)}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isLocked: nextState })
      });
      showToast(nextState ? 'Đã khóa phòng thi thành công' : 'Đã mở phòng thi tiếp nhận thí sinh', 'info');
    } catch (e) {}
  }

  /* ── TẢI THÔNG TIN PHÒNG BAN ĐẦU & BẬT POLLING REALTIME ── */
  async function loadRoomDetails() {
    // 1. Đọc từ local cache nếu có (kiểm tra cả mqc_custom_rooms và mqc_created_rooms)
    try {
      const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
      const createdRooms = JSON.parse(localStorage.getItem('mqc_created_rooms') || '[]');
      const foundCreated = createdRooms.find(r => r.pin === PIN);
      currentRoom = customRooms[PIN] || foundCreated || null;
      if (currentRoom) {
        document.getElementById('room-name-display').textContent = currentRoom.name || currentRoom.title || 'Phòng thi trực tuyến';
        if (currentRoom.capacity) roomCapacity = Number(currentRoom.capacity);
        updateLockUI(currentRoom.isLocked);
      }
    } catch (e) {}

    // 2. Lấy dữ liệu đầy đủ từ Server (nếu server vừa restart thì tự động khôi phục lại phòng)
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.room) {
          currentRoom = data.room;
          document.getElementById('room-name-display').textContent = currentRoom.name || currentRoom.title || 'Phòng thi trực tuyến';
          if (currentRoom.capacity) roomCapacity = Number(currentRoom.capacity);
          updateLockUI(currentRoom.isLocked);
          renderMembers(currentRoom.players || []);
        }
      } else if (res.status === 404 && currentRoom) {
        // Tự động khôi phục đăng ký phòng lên server
        await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentRoom)
        });
      }
    } catch (err) {}

    // 3. Khởi chạy Polling realtime mỗi 1000ms
    startRealtimePolling();
  }

  /* ── POLLING ĐỒNG BỘ THỜI GIAN THỰC (1000ms) ── */
  function startRealtimePolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(PIN)}/status`);
        if (res.status === 404) {
          if (currentRoom) {
            await fetch('/api/rooms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(currentRoom)
            });
            return;
          }
          // Phòng đã bị xóa
          clearInterval(pollInterval);
          alert('Phòng thi này đã bị xóa hoặc hết hạn!');
          window.location.href = 'create-room.html';
          return;
        }

        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            if (data.title && !document.getElementById('room-name-display').textContent) {
              document.getElementById('room-name-display').textContent = data.title;
            }
            if (data.capacity) roomCapacity = Number(data.capacity);
            updateLockUI(data.isLocked);
            renderMembers(data.players || []);

            // Nếu phòng đang ở trạng thái đếm ngược mà máy chủ kích hoạt
            if (data.status === 'countdown' && !isStarting) {
              startCountdownProcess(data.countdown || 5);
            }
          }
        }
      } catch (e) {}
    }, 1000);
  }

  /* ── XỬ LÝ: CHỦ PHÒNG BẤM "BẮT ĐẦU NGAY" ── */
  async function handleHostStart() {
    if (isStarting) return;

    // Lấy số thí sinh hiện tại
    const count = previousMemberIds.size;
    if (count === 0) {
      const proceed = confirm('Phòng thi hiện chưa có thí sinh nào tham gia.\n\nBạn có chắc chắn muốn BẮT ĐẦU đếm ngược để trải nghiệm/kiểm tra không?');
      if (!proceed) return;
    }

    const btn = document.getElementById('btn-start-now');
    btn.disabled = true;
    btn.style.opacity = '0.7';

    // Ngay lập tức chuyển phòng về trạng thái khóa
    updateLockUI(true);
    try {
      const customRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms') || '{}');
      if (customRooms[PIN]) {
        customRooms[PIN].isLocked = true;
        localStorage.setItem('mqc_custom_rooms', JSON.stringify(customRooms));
      }
      const createdRooms = JSON.parse(localStorage.getItem('mqc_created_rooms') || '[]');
      const r = createdRooms.find(x => x.pin === PIN);
      if (r) {
        r.isLocked = true;
        localStorage.setItem('mqc_created_rooms', JSON.stringify(createdRooms));
      }
    } catch (e) {}

    // 1. Gửi request bắt đầu lên Server (kèm thời gian đếm ngược 5s)
    try {
      await fetch(`/api/rooms/${encodeURIComponent(PIN)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countdown: 5 })
      });
    } catch (err) {
      console.warn('Lỗi gọi API /start:', err);
    }

    // 2. Ghi trạng thái countdown vào localStorage để đồng bộ tức thời các tab
    try {
      localStorage.setItem(`mqc_room_status_${PIN}`, 'countdown');
    } catch (e) {}

    // 3. Khởi động màn hình đếm ngược 5 giây
    startCountdownProcess(5);
  }

  /* ── MÀN HÌNH ĐẾM NGƯỢC 5 4 3 2 1 TRÊN NỀN XÁM MỜ ── */
  function startCountdownProcess(initialSec = 5) {
    if (isStarting) return;
    isStarting = true;

    if (pollInterval) clearInterval(pollInterval);

    const overlay = document.getElementById('countdown-overlay');
    const numEl = document.getElementById('countdown-num');

    overlay.classList.add('show');

    let remain = initialSec;
    numEl.textContent = remain;

    if (countdownTimer) clearInterval(countdownTimer);

    countdownTimer = setInterval(() => {
      remain--;
      if (remain > 0) {
        numEl.textContent = remain;
        // Kích hoạt lại animation số nhảy
        numEl.style.animation = 'none';
        void numEl.offsetWidth; // trigger reflow
        numEl.style.animation = 'countNumberPop 0.9s cubic-bezier(0.34, 1.56, 0.64, 1)';
      } else {
        clearInterval(countdownTimer);
        numEl.textContent = 'GO!';
        numEl.style.fontSize = '8rem';

        // Sau khi đếm ngược kết thúc: Đưa chủ phòng đến room quan sát
        setTimeout(() => {
          window.location.href = `host-monitor.html?pin=${encodeURIComponent(PIN)}`;
        }, 600);
      }
    }, 1000);
  }

  /* ── RỜI PHÒNG ── */
  function handleExitRoom() {
    if (confirm('Bạn có chắc muốn rời khỏi phòng chờ của Chủ phòng? (Phòng vẫn sẽ được lưu giữ trên hệ thống)')) {
      window.location.href = 'create-room.html';
    }
  }

  // Khởi chạy khi load trang
  setupLargeQRCode();
  loadRoomDetails();