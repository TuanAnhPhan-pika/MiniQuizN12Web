  /* Colorize title */
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
    btn.addEventListener('click', function () {
      const isDark = document.body.classList.toggle('dark');
      localStorage.setItem('mqc-dark', isDark ? '1' : '0');
    });
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

  /* PIN mask */
  const pinInput = document.getElementById('pin-input');
  pinInput.addEventListener('input', function () {
    let raw = this.value.replace(/[^0-9]/g, '').slice(0, 6);
    this.value = raw.length > 3 ? raw.slice(0, 3) + '-' + raw.slice(3) : raw;
    document.getElementById('error-msg').classList.remove('show');
    pinInput.style.borderColor = '';
  });
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleJoin(); });

  /* Valid rooms & Realtime Server PIN check */
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
          // Lưu vào storage máy này để sử dụng
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
    document.getElementById('step-pin').style.display = 'none';
    document.getElementById('step-nick').style.display = '';
    buildAvatarGrid();
    const nickInput = document.getElementById('nickname-input');
    if (currentUser && currentUser.displayName && !nickInput.value) {
      nickInput.value = currentUser.displayName;
    }
    nickInput.focus();
  }

  /* Avatar grid */
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

  /* ── Gọi khởi tạo khi trang nạp: check username realtime & tự động điền PIN từ mã QR ── */
  function autoFillPinFromQuery() {
    const urlParams = new URLSearchParams(window.location.search);
    const pinParam = urlParams.get('pin');
    if (pinParam) {
      const pinEl = document.getElementById('pin-input');
      if (pinEl) {
        let raw = pinParam.replace(/[^0-9]/g, '').slice(0, 6);
        pinEl.value = raw.length > 3 ? raw.slice(0, 3) + '-' + raw.slice(3) : raw;
        // Tự động kiểm tra mã phòng và chuyển đến bước chọn nhân vật
        handleJoin();
      }
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
      setupRealtimeUsernameCheck();
      autoFillPinFromQuery();
    });
  } else {
    setupRealtimeUsernameCheck();
    autoFillPinFromQuery();
  }

  /* ── Login/Register modal ── */
  function openLoginModal() {
    document.getElementById('login-modal').classList.add('show');
    switchAuthTab('login');
    document.getElementById('login-user').focus();
  }

  function closeLoginModal() {
    document.getElementById('login-modal').classList.remove('show');
  }

  function handleModalOverlayClick(e) {
    if (e.target.id === 'login-modal') closeLoginModal();
  }

  function switchAuthTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('tab-login').classList.toggle('active', isLogin);
    document.getElementById('tab-register').classList.toggle('active', !isLogin);
    document.getElementById('form-login').style.display = isLogin ? '' : 'none';
    document.getElementById('form-register').style.display = isLogin ? 'none' : '';
    hideAuthMessage('error-login');
    hideAuthMessage('error-register');
  }

  function showAuthMessage(id, text, isWarning) {
    const el = document.getElementById(id);
    el.textContent = (isWarning ? '⚠️ ' : '❌ ') + text;
    el.classList.toggle('warning', !!isWarning);
    el.classList.add('show');
  }
  function hideAuthMessage(id) {
    document.getElementById(id).classList.remove('show');
  }

  async function handleLogin() {
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    hideAuthMessage('error-login');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.success) {
        const urlParams = new URLSearchParams(window.location.search);
        const redirectUrl = urlParams.get('redirect') || 'dashboard.html';
        window.location.href = redirectUrl;
      } else {
        showAuthMessage('error-login', data.message || 'Tài khoản hoặc mật khẩu không đúng', res.status === 429);
      }
    } catch (err) {
      showAuthMessage('error-login', 'Không thể kết nối tới máy chủ.');
    }
  }

  /* ── Tự động nhận diện user đã đăng nhập & hiển thị nút Bảng điều khiển ── */
  let currentUser = null;
  (async function checkAuthOnHome() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        currentUser = data;
        const wrap = document.getElementById('header-auth-wrap');
        if (wrap) {
          wrap.innerHTML = `
            <a href="dashboard.html" class="btn-login" style="background:#0284c7; color:#fff; border:none; text-decoration:none; font-weight:800; display:inline-flex; align-items:center; gap:6px; padding:7px 16px; border-radius:10px; box-shadow:0 3px 8px rgba(2,132,199,0.3);">
              <span>📊 Bảng điều khiển</span>
            </a>
          `;
        }
      } else {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('needLogin') === '1') {
          openLoginModal();
          showAuthMessage('error-login', 'Vui lòng đăng nhập để truy cập Bảng điều khiển', true);
        }
      }
    } catch (e) {}
  })();

  async function handleRegister() {
    const username = document.getElementById('reg-user').value.trim();
    const displayName = document.getElementById('reg-name').value.trim();
    const password = document.getElementById('reg-pass').value;
    const confirmPassword = document.getElementById('reg-confirm').value;
    hideAuthMessage('error-register');

    if (!isUsernameValidForRegister) {
      const feedback = document.getElementById('reg-user-feedback').textContent;
      showAuthMessage('error-register', feedback || 'Vui lòng nhập tài khoản hợp lệ');
      return;
    }

    if (password !== confirmPassword) {
      showAuthMessage('error-register', 'Xác nhận mật khẩu không khớp');
      return;
    }
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, displayName, password, confirmPassword }),
      });
      const data = await res.json();
      if (data.success) {
        window.location.href = 'dashboard.html';
      } else {
        showAuthMessage('error-register', data.message || 'Đăng ký thất bại', res.status === 429);
      }
    } catch (err) {
      showAuthMessage('error-register', 'Không thể kết nối tới máy chủ.');
    }
  }

  /* ── Kiểm tra tài khoản thời gian thực khi đăng ký ── */
  let checkUsernameTimeout = null;
  let isUsernameValidForRegister = false;

  function setupRealtimeUsernameCheck() {
    const regUserInput = document.getElementById('reg-user');
    const feedback = document.getElementById('reg-user-feedback');
    const regSubmitBtn = document.getElementById('btn-submit-register');
    if (!regUserInput) return;

    regUserInput.addEventListener('input', function () {
      const val = this.value.trim();
      clearTimeout(checkUsernameTimeout);

      if (!val) {
        feedback.textContent = '';
        feedback.style.color = '';
        regUserInput.style.borderColor = '';
        isUsernameValidForRegister = false;
        return;
      }

      if (val.length < 3) {
        feedback.textContent = 'Tài khoản phải từ 3-20 ký tự';
        feedback.style.color = '#E65100';
        regUserInput.style.borderColor = '#FFB74D';
        isUsernameValidForRegister = false;
        return;
      }

      // Debounce 300ms gọi API
      checkUsernameTimeout = setTimeout(async () => {
        try {
          const res = await fetch('/api/auth/check-username?u=' + encodeURIComponent(val));
          const data = await res.json();
          if (data.exists) {
            feedback.textContent = '⚠️ ' + data.message;
            feedback.style.color = '#D32F2F';
            regUserInput.style.borderColor = '#D32F2F';
            isUsernameValidForRegister = false;
          } else if (!data.valid) {
            feedback.textContent = '⚠️ ' + data.message;
            feedback.style.color = '#E65100';
            regUserInput.style.borderColor = '#FFB74D';
            isUsernameValidForRegister = false;
          } else {
            feedback.textContent = '✓ ' + data.message;
            feedback.style.color = '#2E7D32';
            regUserInput.style.borderColor = '#4CAF50';
            isUsernameValidForRegister = true;
          }
        } catch (e) {
          feedback.textContent = '';
        }
      }, 300);
    });
  }

  function setupModalListeners() {
    document.getElementById('login-pass')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('login-user')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('login-pass')?.focus();
    });
    document.getElementById('reg-confirm')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleRegister();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupModalListeners);
  } else {
    setupModalListeners();
  }