  /* ── Current User: xác thực qua session cookie, không tin client tự khai ── */
  let CURRENT_USER = '';
  let CURRENT_DISPLAY_NAME = '';
  async function checkAuthAndGetUser() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) { window.location.href = 'index.html?needLogin=1'; return false; }
      const data = await res.json();
      if (!data.authenticated) { window.location.href = 'index.html?needLogin=1'; return false; }
      if (data.token && window.MQC_Auth) {
        window.MQC_Auth.setToken(data.token);
      }
      CURRENT_USER = data.username;
      CURRENT_DISPLAY_NAME = data.displayName || data.username;
      return true;
    } catch (err) {
      window.location.href = 'index.html?needLogin=1';
      return false;
    }
  }

  /* ── Colorize title ── */
  document.getElementById('app-title').innerHTML =
    [...'Mini Quiz Classroom'].map(ch =>
      ch === ' ' ? '<span class="space"> </span>' : '<span>' + ch + '</span>'
    ).join('');

  /* ── Dark mode ── */
  (function () {
    const btn = document.getElementById('btn-dark');
    if (localStorage.getItem('mqc-dark') === '1') document.body.classList.add('dark');
    buildStars();
    btn?.addEventListener('click', function () {
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

  /* ── PRESET LIBRARY EXAMS (Fallback) ── */
  const FALLBACK_PUBLIC_EXAMS = [
    {
      id: 'public-1',
      code: '#e1a9',
      title: 'Đề khởi động lớp học (Mặc định)',
      subject: 'Khởi động',
      author: 'Hệ thống Mini Quiz',
      timePerQ: 15,
      pointsPerQ: 100,
      copiesIssued: 0,
      desc: 'Bộ 3 câu hỏi vui nhộn khởi động đầu giờ học để kích hoạt tư duy và sự hào hứng của học sinh.',
      questions: [
        { text: 'Con chó có mấy chân?', choices: ['3', '2', '4', '5'], correct: 2 },
        { text: '2 + 2 = ?', choices: ['2', '5', '4', '8'], correct: 2 },
        { text: 'Con nào biết bay?', choices: ['Heo', 'Chó', 'Cú', 'Bò'], correct: 2 }
      ]
    },
    {
      id: 'public-2',
      code: '#5b8d',
      title: 'Đố vui Khoa học & Vũ trụ',
      subject: 'Khoa học tự nhiên',
      author: 'Hệ thống Mini Quiz',
      timePerQ: 15,
      pointsPerQ: 100,
      copiesIssued: 0,
      desc: 'Khám phá kiến thức tự nhiên, hệ mặt trời và thế giới sinh vật quanh ta với các câu hỏi tương tác sinh động.',
      questions: [
        { text: 'Hành tinh nào gần Mặt Trời nhất trong Hệ Mặt Trời?', choices: ['Sao Kim', 'Sao Thủy', 'Trái Đất', 'Sao Hỏa'], correct: 1 },
        { text: 'Khí nào chiếm tỉ lệ cao nhất trong khí quyển Trái Đất?', choices: ['Oxy', 'Cacbonic', 'Nitơ', 'Hydro'], correct: 2 },
        { text: 'Loài chim nào có khả năng bơi lội giỏi nhưng không biết bay?', choices: ['Đà điểu', 'Chim cánh cụt', 'Vẹt', 'Hải âu'], correct: 1 },
        { text: 'Chất lỏng nào chiếm khoảng 70% bề mặt Trái Đất?', choices: ['Dầu mỏ', 'Nước', 'Dung nham', 'Cồn'], correct: 1 }
      ]
    },
    {
      id: 'public-3',
      code: '#9f1c',
      title: 'Toán học & Tư duy logic nhanh',
      subject: 'Toán học',
      author: 'Hệ thống Mini Quiz',
      timePerQ: 20,
      pointsPerQ: 100,
      copiesIssued: 0,
      desc: 'Rèn luyện khả năng tính nhẩm nhanh và tư duy hình học, quy luật số học cho học sinh.',
      questions: [
        { text: 'Kết quả của phép tính: 15 x 4 + 10 là bao nhiêu?', choices: ['60', '70', '50', '80'], correct: 1 },
        { text: 'Số tiếp theo trong dãy số quy luật: 2, 4, 8, 16, ? là:', choices: ['24', '30', '32', '36'], correct: 2 },
        { text: 'Tổng số đo 3 góc trong một tam giác bằng bao nhiêu độ?', choices: ['90°', '180°', '270°', '360°'], correct: 1 },
        { text: 'Một hình vuông có cạnh 6cm. Diện tích của hình vuông đó là:', choices: ['24 cm²', '30 cm²', '36 cm²', '40 cm²'], correct: 2 }
      ]
    },
    {
      id: 'public-4',
      code: '#3c6e',
      title: 'Tiếng Anh giao tiếp & Từ vựng cơ bản',
      subject: 'Tiếng Anh',
      author: 'Hệ thống Mini Quiz',
      timePerQ: 15,
      pointsPerQ: 100,
      copiesIssued: 0,
      desc: 'Kiểm tra vốn từ vựng thông dụng, phản xạ đối đáp và ngữ pháp cơ bản cho học sinh.',
      questions: [
        { text: 'What is the opposite of "Hot"?', choices: ['Warm', 'Cold', 'Cool', 'Dry'], correct: 1 },
        { text: 'Choose the correct word: "She ___ to school every day."', choices: ['go', 'goes', 'going', 'went'], correct: 1 },
        { text: 'Which animal is known as "Man\\\'s best friend"?', choices: ['Cat', 'Dog', 'Horse', 'Rabbit'], correct: 1 },
        { text: 'How many days are there in a week?', choices: ['5', '6', '7', '8'], correct: 2 }
      ]
    }
  ];

  /* ── STATE ── */
  let currentQuestions = [];
  let editingQuestionIndex = -1; // -1: adding new
  let currentEditingExamId = null; // ID của đề thi đang được nạp để chỉnh sửa
  let publicExamsCache = []; // Cache danh sách đề thi từ Public Storage

  /* ── INIT ── */
  window.addEventListener('DOMContentLoaded', async () => {
    // 1. Kích hoạt ngay tab đang đứng lập tức (không đợi mạng)
    const hashTab = (location.hash || '').replace('#', '').trim();
    const savedTab = sessionStorage.getItem('mqc_active_exam_tab');
    const validTabs = ['create', 'import', 'library', 'share'];
    const activeTab = validTabs.includes(hashTab) 
      ? hashTab 
      : (validTabs.includes(savedTab) ? savedTab : 'create');

    if (activeTab !== 'create') {
      switchTab(activeTab, false);
    }

    // 2. Khởi tạo kéo thả cho Import dropzone
    const dropzone = document.getElementById('exam-dropzone');
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('dragover');
        });
      });
      dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer ? e.dataTransfer.files : null;
        if (files && files.length > 0) {
          handleImportFileInput(files);
        }
      });
    }

    // 3. Kiểm tra đăng nhập trước tiên để xác định đúng tài khoản
    if (!(await checkAuthAndGetUser())) return;

    // 4. Đồng bộ Private Storage từ server (DB là Source of Truth)
    await syncPrivateStorageFromServer();

    // 5. Khởi tạo form trắng mặc định (không trỏ vào đề nào)
    loadDraftOrInit();
    renderSavedExamsList();
    if (activeTab === 'library') {
      await renderLibraryTab();
    } else {
      renderLibraryTab().catch(() => {});
    }
    renderShareTab();
  });

  function getUserStorageKey(baseKey, username) {
    return `${baseKey}_${String(username || CURRENT_USER || 'anonymous').toLowerCase()}`;
  }

  let memoryUserExams = null;

  function getExamsStorageKey() {
    return getUserStorageKey('mqc_custom_exams', CURRENT_USER);
  }

  function getSavedExams() {
    if (memoryUserExams !== null) return memoryUserExams;
    try {
      const key = getExamsStorageKey();
      memoryUserExams = JSON.parse(localStorage.getItem(key) || '[]');
      return memoryUserExams;
    } catch(e) {
      return [];
    }
  }

  function setSavedExams(exams) {
    memoryUserExams = Array.isArray(exams) ? exams : [];
    try {
      const key = getExamsStorageKey();
      localStorage.setItem(key, JSON.stringify(memoryUserExams));
      localStorage.removeItem('mqc_custom_exams'); // Dọn dẹp key cũ không có scope
    } catch(e) {}
  }

  /* ── Đồng bộ Private Storage từ server (DB là source of truth) ── */
  async function syncPrivateStorageFromServer() {
    try {
      const res = await fetch('/api/storage/private', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.exams)) {
          setSavedExams(data.exams);
          renderSavedExamsList();
        }
      }
    } catch (e) {
      console.warn('Không thể kết nối tới server private storage, dùng cache cục bộ:', e);
    }
  }

  function loadDraftOrInit() {
    let saved = getSavedExams();
    let modified = false;

    saved.forEach(e => {
      if (!e.code) {
        e.code = generateExamCode();
        modified = true;
      }
      if (e.pin) {
        delete e.pin;
        modified = true;
      }
    });

    if (modified) {
      setSavedExams(saved);
    }

    // Mặc định ở trạng thái trắng, không trỏ vào bất kỳ đề thi nào
    currentEditingExamId = null;
    currentQuestions = [];
    document.getElementById('exam-title').value = '';
    document.getElementById('exam-subject').value = '';
    cancelEditQuestion();
    renderQuestionsList();
    renderSavedExamsList();
  }

  /* ── TAB SWITCHING ── */
  function switchTab(tabName, updateStorage = true) {
    const tabs = ['create', 'import', 'library', 'share'];
    if (!tabs.includes(tabName)) tabName = 'create';
    tabs.forEach(t => {
      document.getElementById('tab-btn-' + t).classList.toggle('active', t === tabName);
      document.getElementById('tab-' + t).classList.toggle('active', t === tabName);
    });

    if (updateStorage) {
      sessionStorage.setItem('mqc_active_exam_tab', tabName);
      try {
        history.replaceState(null, '', '#' + tabName);
      } catch (e) {}
    }

    if (tabName === 'library') renderLibraryTab();
    if (tabName === 'share') renderShareTab();
  }

  /* ── QUESTION EDITOR LOGIC ── */
  function updateCorrectChoiceHighlight() {
    const radios = document.querySelectorAll('input[name="correct-answer"]');
    radios.forEach((r, idx) => {
      const row = document.getElementById('choice-row-' + idx);
      if (row) row.classList.toggle('is-correct', r.checked);
    });
  }

  function handleSaveQuestion() {
    const text = document.getElementById('q-text').value.trim();
    if (!text) {
      showToast('⚠️ Vui lòng nhập nội dung câu hỏi!');
      document.getElementById('q-text').focus();
      return;
    }

    const choices = [
      document.getElementById('choice-input-0').value.trim(),
      document.getElementById('choice-input-1').value.trim(),
      document.getElementById('choice-input-2').value.trim(),
      document.getElementById('choice-input-3').value.trim()
    ];

    for (let i = 0; i < 4; i++) {
      if (!choices[i]) {
        showToast('⚠️ Vui lòng nhập nội dung cho đáp án ' + ['A', 'B', 'C', 'D'][i] + '!');
        document.getElementById('choice-input-' + i).focus();
        return;
      }
    }

    const radios = document.querySelectorAll('input[name="correct-answer"]');
    let correctIdx = 0;
    radios.forEach((r, idx) => {
      if (r.checked) correctIdx = idx;
    });

    const qData = { text, choices, correct: correctIdx };

    if (editingQuestionIndex >= 0) {
      currentQuestions[editingQuestionIndex] = qData;
      showToast('✅ Đã cập nhật câu hỏi!');
      cancelEditQuestion();
    } else {
      currentQuestions.push(qData);
      showToast('✅ Đã thêm câu hỏi vào đề!');
      resetQuestionForm();
    }

    renderQuestionsList();
  }

  function editQuestion(idx) {
    editingQuestionIndex = idx;
    const q = currentQuestions[idx];

    document.getElementById('q-form-heading').textContent = '✏️ Chỉnh sửa câu hỏi ' + (idx + 1);
    document.getElementById('q-text').value = q.text;

    q.choices.forEach((c, i) => {
      document.getElementById('choice-input-' + i).value = c;
    });

    const radios = document.querySelectorAll('input[name="correct-answer"]');
    if (radios[q.correct]) radios[q.correct].checked = true;
    updateCorrectChoiceHighlight();

    document.getElementById('btn-save-q').textContent = '💾 Lưu cập nhật câu hỏi';
    document.getElementById('btn-cancel-q').classList.add('show');
    document.getElementById('q-text').focus();
  }

  function cancelEditQuestion() {
    editingQuestionIndex = -1;
    document.getElementById('q-form-heading').textContent = '➕ Thêm câu hỏi mới';
    document.getElementById('btn-save-q').textContent = '➕ Thêm câu hỏi vào đề';
    document.getElementById('btn-cancel-q').classList.remove('show');
    resetQuestionForm();
  }

  function deleteQuestion(idx) {
    if (confirm('Bạn có chắc muốn xóa câu hỏi ' + (idx + 1) + '?')) {
      currentQuestions.splice(idx, 1);
      if (editingQuestionIndex === idx) cancelEditQuestion();
      renderQuestionsList();
      showToast('🗑️ Đã xóa câu hỏi!');
    }
  }

  function resetQuestionForm() {
    document.getElementById('q-text').value = '';
    for (let i = 0; i < 4; i++) {
      document.getElementById('choice-input-' + i).value = '';
    }
    const radios = document.querySelectorAll('input[name="correct-answer"]');
    if (radios[0]) radios[0].checked = true;
    updateCorrectChoiceHighlight();
  }

  function renderQuestionsList() {
    const listEl = document.getElementById('questions-list');
    document.getElementById('q-count-badge').textContent = currentQuestions.length + ' câu hỏi';

    if (currentQuestions.length === 0) {
      listEl.innerHTML = '<div class="empty-questions-hint">Chưa có câu hỏi nào trong đề thi.<br>Hãy điền nội dung ở cột bên trái và bấm <b>"+ Thêm câu hỏi vào đề"</b>.</div>';
      return;
    }

    const LETTERS = ['A', 'B', 'C', 'D'];
    listEl.innerHTML = currentQuestions.map((q, idx) => {
      return '<div class="q-item-card">'
        + '<div class="q-item-top">'
        + '  <div class="q-item-title">Câu ' + (idx + 1) + ': ' + escapeHtml(q.text) + '</div>'
        + '  <div class="q-item-actions">'
        + '    <button class="btn-q-icon" onclick="editQuestion(' + idx + ')" title="Chỉnh sửa">✏️</button>'
        + '    <button class="btn-q-icon" onclick="deleteQuestion(' + idx + ')" title="Xóa">🗑️</button>'
        + '  </div>'
        + '</div>'
        + '<div class="q-item-choices">'
        + q.choices.map((c, ci) => {
            const corrClass = ci === q.correct ? 'correct' : '';
            const tick = ci === q.correct ? '✓' : '';
            return '<div class="q-item-choice ' + corrClass + '"><b>' + LETTERS[ci] + '.</b> ' + escapeHtml(c) + ' ' + tick + '</div>';
          }).join('')
        + '</div>'
        + '</div>';
    }).join('');
  }

  /* ── THÊM ĐỀ THI MỚI (TẠO ĐỀ TRẮNG VÀ ĐƯA VÀO TRẠNG THÁI SỬA) ── */
  function handleAddNewExam() {
    const newExam = {
      id: 'exam-' + Date.now(),
      code: generateExamCode(),
      title: 'Đề thi mới',
      subject: '',
      timePerQ: 15,
      pointsPerQ: 100,
      questions: [],
      createdAt: new Date().toLocaleDateString('vi-VN')
    };

    saveExamToStorage(newExam);
    loadExamForEditing(newExam.id);

    const titleInput = document.getElementById('exam-title');
    if (titleInput) {
      titleInput.focus();
      titleInput.select();
    }

    const editorCard = document.querySelector('.editor-card');
    if (editorCard) {
      editorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    showToast('✨ Đã tạo đề thi trắng mới! Bạn có thể đặt tên và bắt đầu thêm câu hỏi.');
  }

  /* ── LOAD EXAM FOR EDITING ── */
  function loadExamForEditing(examId) {
    const exams = getSavedExams();
    const exam = exams.find(e => e.id === examId);
    if (!exam) return;

    currentEditingExamId = exam.id;

    document.getElementById('exam-title').value = exam.title;
    document.getElementById('exam-subject').value = exam.subject || '';
    document.getElementById('exam-time').value = exam.timePerQ || 15;
    document.getElementById('exam-points').value = exam.pointsPerQ || 100;

    currentQuestions = JSON.parse(JSON.stringify(exam.questions || []));
    renderQuestionsList();

    if (currentQuestions.length > 0) {
      editQuestion(0);
    } else {
      cancelEditQuestion();
    }

    renderSavedExamsList();
    showToast('✏️ Đang sửa đề: "' + exam.title + '" (Câu 1)');
  }

  /* ── RENDER SAVED EXAMS LIST (PRIVATE STORAGE) ── */
  function renderSavedExamsList() {
    const listEl = document.getElementById('saved-exams-list');
    const badgeEl = document.getElementById('saved-exams-count-badge');
    const exams = getSavedExams();

    if (badgeEl) badgeEl.textContent = exams.length + ' đề thi';
    if (!listEl) return;

    if (exams.length === 0) {
      listEl.innerHTML = '<div style="color: var(--gray-text); font-size: 0.85rem; padding: 18px 0; text-align: center;">Chưa có đề thi nào trong Private Storage.<br>Soạn đề và bấm <b>"Lưu đề thi"</b> hoặc lưu từ Ngân hàng đề.</div>';
      return;
    }

    listEl.innerHTML = exams.map(exam => {
      const isEditing = (exam.id === currentEditingExamId);
      const qCount = exam.questions ? exam.questions.length : 0;
      const code = exam.code || '#00000000';
      const editingBadge = isEditing ? '<span class="badge-editing">Đang sửa</span>' : '';

      return '<div class="saved-exam-item ' + (isEditing ? 'active-editing' : '') + '" id="saved-exam-' + exam.id + '">'
        + '<div class="saved-exam-main">'
        + '  <div class="saved-exam-title">'
        + '    <span>' + escapeHtml(exam.title) + '</span>'
        + '    <span class="exam-code-tag">(' + escapeHtml(code) + ')</span>'
        + '    ' + editingBadge
        + '  </div>'
        + '  <div class="saved-exam-meta">'
        + '    Môn: <b>' + escapeHtml(exam.subject || 'Tổng hợp') + '</b> • <b>' + qCount + ' câu hỏi</b> • ' + (exam.timePerQ || 15) + 's/câu'
        + '  </div>'
        + '</div>'
        + '<div class="saved-exam-actions">'
        + '  <button class="btn-exam-action room" onclick="handleCreateRoomForExam(\'' + exam.id + '\', event)" title="Tạo phòng thi ngay với đề này">🚀 Tạo phòng</button>'
        + '  <button class="btn-exam-action edit" onclick="loadExamForEditing(\'' + exam.id + '\')" title="Chỉnh sửa đề thi này">✏️ Sửa</button>'
        + '  <button class="btn-exam-action delete" onclick="deleteExamFromEditor(\'' + exam.id + '\')" title="Xóa đề thi này">🗑️</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  async function handleCreateRoomForExam(examId, event) {
    if (event) event.stopPropagation();
    const exams = getSavedExams();
    const exam = exams.find(e => e.id === examId);
    if (!exam) return;

    if (!exam.questions || exam.questions.length === 0) {
      showToast('⚠️ Đề thi này chưa có câu hỏi để tạo phòng!');
      return;
    }

    sessionStorage.setItem('mqc_assigned_exam', JSON.stringify(exam));
    try {
      await saveExamToStorage(exam);
    } catch(e) {}
    window.location.href = 'create-room.html?examId=' + encodeURIComponent(exam.id);
  }

  function deleteExamFromEditor(examId) {
    if (confirm('Bạn có chắc muốn xóa đề thi này khỏi Private Storage?')) {
      deleteSavedExam(examId);
      if (currentEditingExamId === examId) {
        currentEditingExamId = null;
      }
      renderSavedExamsList();
      renderShareTab();
      showToast('🗑️ Đã xóa đề thi khỏi kho cá nhân!');
    }
  }

  /* ── SAVE EXAM TO PRIVATE STORAGE ── */
  function handleSaveExam(showNotification = true) {
    const title = document.getElementById('exam-title').value.trim();
    if (!title) {
      showToast('⚠️ Vui lòng nhập tên đề thi!');
      document.getElementById('exam-title').focus();
      return null;
    }

    if (currentQuestions.length === 0) {
      showToast('⚠️ Đề thi cần có ít nhất 1 câu hỏi!');
      return null;
    }

    let exams = getSavedExams();
    let exam;

    if (currentEditingExamId) {
      const idx = exams.findIndex(e => e.id === currentEditingExamId);
      if (idx >= 0) {
        exam = exams[idx];
        exam.title = title;
        exam.subject = document.getElementById('exam-subject').value.trim() || 'Tổng hợp';
        exam.timePerQ = parseInt(document.getElementById('exam-time').value) || 15;
        exam.pointsPerQ = parseInt(document.getElementById('exam-points').value) || 100;
        exam.questions = currentQuestions;
        exam.updatedAt = new Date().toLocaleDateString('vi-VN');
        if (!exam.code) exam.code = generateExamCode();
        delete exam.pin;
      }
    }

    if (!exam) {
      exam = {
        id: 'exam-' + Date.now(),
        code: generateExamCode(),
        title,
        subject: document.getElementById('exam-subject').value.trim() || 'Tổng hợp',
        timePerQ: parseInt(document.getElementById('exam-time').value) || 15,
        pointsPerQ: parseInt(document.getElementById('exam-points').value) || 100,
        questions: currentQuestions,
        createdAt: new Date().toLocaleDateString('vi-VN')
      };
      currentEditingExamId = exam.id;
    }

    saveExamToStorage(exam);
    renderSavedExamsList();
    renderShareTab();
    if (showNotification) {
      showToast('✅ Đã lưu vào Private Storage (Tài khoản: ' + CURRENT_USER + ')!');
    }
    return exam;
  }



  /* ── CHUYỂN SANG GIAO DIỆN TẠO PHÒNG VỚI ĐỀ HIỆN TẠI ── */
  async function handleCreateRoomFromCurrent() {
    if (currentQuestions.length === 0) {
      showToast('⚠️ Cần ít nhất 1 câu hỏi để tạo phòng thi!');
      return;
    }

    const title = document.getElementById('exam-title').value.trim();
    if (!title) {
      showToast('⚠️ Vui lòng nhập tên đề thi trước khi tạo phòng!');
      document.getElementById('exam-title').focus();
      return;
    }

    const exam = handleSaveExam(false);
    if (!exam) return;

    // Lưu đề thi vào sessionStorage để trang create-room nạp tức thì
    sessionStorage.setItem('mqc_assigned_exam', JSON.stringify(exam));

    showToast('🚀 Đang chuyển sang giao diện tạo phòng thi...');

    try {
      await saveExamToStorage(exam);
    } catch (e) {}

    window.location.href = 'create-room.html?examId=' + encodeURIComponent(exam.id);
  }

  function handleClearAll() {
    if (confirm('Bạn có chắc muốn xóa toàn bộ câu hỏi của đề thi đang sửa để soạn lại?')) {
      currentQuestions = [];
      cancelEditQuestion();
      renderQuestionsList();
      renderSavedExamsList();
      showToast('🗑️ Đã xóa toàn bộ câu hỏi (đề thi vẫn đang ở trạng thái sửa)!');
    }
  }

  /* ════════════════════════════════════════════
     TAB IMPORT: LOGIC XỬ LÝ NHẬP ĐỀ THI TỰ ĐỘNG
     ════════════════════════════════════════════ */
  let currentImportedQuestions = [];
  let currentImportMode = 'file';

  function switchImportMode(mode) {
    currentImportMode = mode;
    const btnFile = document.getElementById('btn-mode-file');
    const btnText = document.getElementById('btn-mode-text');
    const panelFile = document.getElementById('import-mode-file-panel');
    const panelText = document.getElementById('import-mode-text-panel');
    if (btnFile) btnFile.classList.toggle('active', mode === 'file');
    if (btnText) btnText.classList.toggle('active', mode === 'text');
    if (panelFile) panelFile.style.display = mode === 'file' ? 'block' : 'none';
    if (panelText) panelText.style.display = mode === 'text' ? 'block' : 'none';
  }

  async function handleImportFileInput(files) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const loadingEl = document.getElementById('import-loading');
    const loadingText = document.getElementById('import-loading-text');
    if (loadingEl) {
      loadingText.textContent = 'Đang phân tích tập tin "' + file.name + '"...';
      loadingEl.style.display = 'flex';
    }

    try {
      if (typeof ExamImporter === 'undefined') {
        throw new Error('Mô-đun ExamImporter chưa được tải!');
      }
      const result = await ExamImporter.parseFile(file);
      if (loadingEl) loadingEl.style.display = 'none';

      if (result.error) {
        showToast('❌ ' + result.error);
        return;
      }
      if (!result.questions || result.questions.length === 0) {
        showToast('⚠️ Không tìm thấy câu hỏi trắc nghiệm hợp lệ trong tập tin!');
        return;
      }

      currentImportedQuestions = result.questions;
      const titleInput = document.getElementById('import-exam-title');
      const subjectInput = document.getElementById('import-exam-subject');
      const defaultTitle = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
      if (titleInput) titleInput.value = result.title || defaultTitle || ('Đề thi nhập ' + new Date().toLocaleDateString('vi-VN'));
      if (subjectInput) subjectInput.value = result.subject || 'Tổng hợp';

      renderImportPreview();
      showToast('🎉 Đã nhận diện thành công ' + result.questions.length + ' câu hỏi!');
    } catch (err) {
      if (loadingEl) loadingEl.style.display = 'none';
      console.error('Lỗi nhập file:', err);
      showToast('❌ Lỗi khi đọc file: ' + (err.message || 'Không thể xử lý'));
    }
  }

  async function handleImportPastedText() {
    const rawText = document.getElementById('import-raw-text')?.value || '';
    if (!rawText.trim()) {
      showToast('⚠️ Vui lòng dán nội dung đề thi vào khung văn bản!');
      return;
    }

    const loadingEl = document.getElementById('import-loading');
    const loadingText = document.getElementById('import-loading-text');
    if (loadingEl) {
      loadingText.textContent = 'Đang phân tích cú pháp câu hỏi trắc nghiệm...';
      loadingEl.style.display = 'flex';
    }

    try {
      const result = ExamImporter.parseVnText(rawText);
      if (loadingEl) loadingEl.style.display = 'none';

      if (!result.questions || result.questions.length === 0) {
        showToast('⚠️ Không nhận diện được câu hỏi trắc nghiệm nào từ văn bản!');
        return;
      }

      currentImportedQuestions = result.questions;
      const titleInput = document.getElementById('import-exam-title');
      const subjectInput = document.getElementById('import-exam-subject');
      if (titleInput) titleInput.value = result.title || ('Đề trắc nghiệm ' + new Date().toLocaleDateString('vi-VN'));
      if (subjectInput) subjectInput.value = result.subject || 'Tổng hợp';

      renderImportPreview();
      showToast('🎉 Đã nhận diện thành công ' + result.questions.length + ' câu hỏi!');
    } catch (err) {
      if (loadingEl) loadingEl.style.display = 'none';
      showToast('❌ Lỗi phân tích văn bản: ' + (err.message || 'Không rõ lỗi'));
    }
  }

  function renderImportPreview() {
    const container = document.getElementById('import-questions-list');
    const badge = document.getElementById('import-q-count-badge');
    const section = document.getElementById('import-preview-section');
    if (!container || !section) return;

    if (!currentImportedQuestions || currentImportedQuestions.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'flex';
    if (badge) badge.textContent = currentImportedQuestions.length + ' câu hỏi';

    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

    container.innerHTML = currentImportedQuestions.map((q, qIdx) => {
      const choicesHtml = (q.choices || []).map((ch, cIdx) => {
        const isCorrect = (cIdx === q.correct);
        const letter = letters[cIdx] || String(cIdx + 1);
        return '<button type="button" class="import-choice-btn ' + (isCorrect ? 'correct' : '') + '" onclick="setImportQuestionCorrect(' + qIdx + ', ' + cIdx + ')" title="Bấm để chọn đáp án này là đúng">'
          + '<span class="import-choice-tag">' + letter + '.</span>'
          + '<span class="import-choice-val">' + escapeHtml(ch) + '</span>'
          + (isCorrect ? '<span class="import-choice-check">✓ Đúng</span>' : '')
          + '</button>';
      }).join('');

      return '<div class="import-q-card" id="import-q-' + qIdx + '">'
        + '<div class="import-q-header">'
        + '  <span class="import-q-number">Câu ' + (qIdx + 1) + ':</span>'
        + '  <button type="button" class="btn-import-q-delete" onclick="deleteImportQuestion(' + qIdx + ')" title="Xóa câu hỏi này">🗑️</button>'
        + '</div>'
        + '<input type="text" class="import-q-text-input" value="' + escapeHtml(q.text) + '" onchange="updateImportQuestionText(' + qIdx + ', this.value)" placeholder="Nội dung câu hỏi..." />'
        + '<div class="import-choices-grid">'
        + choicesHtml
        + '</div>'
        + '</div>';
    }).join('');

    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateImportQuestionText(qIdx, val) {
    if (currentImportedQuestions[qIdx]) {
      currentImportedQuestions[qIdx].text = val.trim();
    }
  }

  function setImportQuestionCorrect(qIdx, cIdx) {
    if (currentImportedQuestions[qIdx]) {
      currentImportedQuestions[qIdx].correct = cIdx;
      renderImportPreview();
    }
  }

  function deleteImportQuestion(qIdx) {
    if (qIdx >= 0 && qIdx < currentImportedQuestions.length) {
      currentImportedQuestions.splice(qIdx, 1);
      renderImportPreview();
      showToast('🗑️ Đã xóa câu hỏi!');
    }
  }

  function resetImportPreview() {
    currentImportedQuestions = [];
    const section = document.getElementById('import-preview-section');
    if (section) section.style.display = 'none';
    const fileInput = document.getElementById('import-file-input');
    if (fileInput) fileInput.value = '';
    const rawText = document.getElementById('import-raw-text');
    if (rawText) rawText.value = '';
  }

  function buildImportedExamObject() {
    const title = (document.getElementById('import-exam-title')?.value || '').trim();
    if (!title) {
      showToast('⚠️ Vui lòng nhập tên đề thi!');
      document.getElementById('import-exam-title')?.focus();
      return null;
    }
    if (!currentImportedQuestions || currentImportedQuestions.length === 0) {
      showToast('⚠️ Đề thi cần có ít nhất 1 câu hỏi!');
      return null;
    }

    for (let i = 0; i < currentImportedQuestions.length; i++) {
      const q = currentImportedQuestions[i];
      if (!q.text || !q.text.trim()) {
        showToast('⚠️ Câu ' + (i + 1) + ' chưa có nội dung câu hỏi!');
        return null;
      }
      if (!q.choices || q.choices.length < 2) {
        showToast('⚠️ Câu ' + (i + 1) + ' cần có ít nhất 2 đáp án!');
        return null;
      }
      if (typeof q.correct !== 'number' || q.correct < 0 || q.correct >= q.choices.length) {
        showToast('⚠️ Câu ' + (i + 1) + ' chưa có đáp án đúng được chọn!');
        return null;
      }
    }

    const subject = (document.getElementById('import-exam-subject')?.value || '').trim() || 'Tổng hợp';
    const timePerQ = parseInt(document.getElementById('import-exam-time')?.value) || 15;
    const pointsPerQ = parseInt(document.getElementById('import-exam-points')?.value) || 100;

    return {
      id: 'exam-' + Date.now(),
      code: generateExamCode(),
      title: title,
      subject: subject,
      timePerQ: timePerQ,
      pointsPerQ: pointsPerQ,
      questions: JSON.parse(JSON.stringify(currentImportedQuestions)),
      createdAt: new Date().toLocaleDateString('vi-VN')
    };
  }

  async function handleCreateRoomFromImported() {
    const exam = buildImportedExamObject();
    if (!exam) return;

    sessionStorage.setItem('mqc_assigned_exam', JSON.stringify(exam));
    showToast('🚀 Đang chuyển sang giao diện tạo phòng thi...');
    try {
      await saveExamToStorage(exam);
    } catch (e) {}
    window.location.href = 'create-room.html?examId=' + encodeURIComponent(exam.id);
  }

  async function handleSaveImportedExam() {
    const exam = buildImportedExamObject();
    if (!exam) return;

    try {
      await saveExamToStorage(exam);
      renderSavedExamsList();
      renderShareTab();
      showToast('✅ Đã lưu đề "' + exam.title + '" vào kho cá nhân!');
    } catch (err) {
      showToast('⚠️ Lỗi khi lưu đề thi!');
    }
  }

  function handleApplyImportToEditor() {
    const exam = buildImportedExamObject();
    if (!exam) return;

    currentEditingExamId = null;
    currentQuestions = JSON.parse(JSON.stringify(exam.questions));
    document.getElementById('exam-title').value = exam.title;
    document.getElementById('exam-subject').value = exam.subject;
    document.getElementById('exam-time').value = exam.timePerQ;
    document.getElementById('exam-points').value = exam.pointsPerQ;
    cancelEditQuestion();
    renderQuestionsList();
    renderSavedExamsList();

    switchTab('create');
    showToast('✏️ Đã nạp ' + currentQuestions.length + ' câu hỏi vào bảng soạn thảo thủ công!');
  }

  /* ── TAB 3: CHỌN ĐỀ TỪ NGÂN HÀNG (PUBLIC STORAGE) ── */
  let currentLibPage = 1;
  let currentLibSubjectFilter = '';
  const LIB_PAGE_SIZE = 9;
  let libSearchDebounceTimer = null;

  async function renderLibraryTab(fetchNew = true) {
    const grid = document.getElementById('library-grid');
    if (!grid) return;

    if (fetchNew || !publicExamsCache || publicExamsCache.length === 0) {
      let publicExams = FALLBACK_PUBLIC_EXAMS;
      try {
        const res = await fetch('/api/storage/public');
        if (res.ok) {
          const data = await res.json();
          if (data.success && Array.isArray(data.exams) && data.exams.length > 0) {
            publicExams = data.exams;
          }
        }
      } catch (e) {
        console.warn('Dùng cache đề thi public:', e);
      }
      publicExamsCache = sortExamsByCode(publicExams);
    } else {
      publicExamsCache = sortExamsByCode(publicExamsCache);
    }

    // 1. Trích xuất danh sách môn học duy nhất
    const uniqueSubjects = [];
    (publicExamsCache || []).forEach(e => {
      const s = (e.subject || '').trim();
      if (s && !uniqueSubjects.some(item => item.toLowerCase() === s.toLowerCase())) {
        uniqueSubjects.push(s);
      }
    });

    // 2. Nạp gợi ý datalist và các nhãn chọn nhanh
    const datalistEl = document.getElementById('lib-subject-suggestions');
    if (datalistEl) {
      datalistEl.innerHTML = uniqueSubjects.map(s => '<option value="' + escapeHtml(s) + '"></option>').join('');
    }

    const quickTagsEl = document.getElementById('lib-quick-tags');
    if (quickTagsEl) {
      const isAll = !currentLibSubjectFilter;
      let tagsHtml = '<button class="lib-tag-btn ' + (isAll ? 'active' : '') + '" onclick="filterLibBySubject(\'\')">Tất cả</button>';
      tagsHtml += uniqueSubjects.map(s => {
        const isActive = currentLibSubjectFilter.toLowerCase() === s.toLowerCase();
        return '<button class="lib-tag-btn ' + (isActive ? 'active' : '') + '" onclick="filterLibBySubject(\'' + escapeHtml(s) + '\')">' + escapeHtml(s) + '</button>';
      }).join('');
      quickTagsEl.innerHTML = tagsHtml;
    }

    const clearBtn = document.getElementById('btn-clear-lib-search');
    if (clearBtn) {
      clearBtn.style.display = currentLibSubjectFilter ? 'block' : 'none';
    }

    // 3. Lọc danh sách đề thi theo từ khóa môn học, tên đề thi hoặc mã định danh
    let filteredExams = publicExamsCache || [];
    if (currentLibSubjectFilter) {
      const term = currentLibSubjectFilter.toLowerCase().trim();
      const cleanTerm = term.startsWith('#') ? term.substring(1) : term;
      filteredExams = (publicExamsCache || []).filter(e => {
        const subj = (e.subject || '').toLowerCase();
        const title = (e.title || '').toLowerCase();
        const code = (e.code || '').toLowerCase();
        const cleanCode = code.startsWith('#') ? code.substring(1) : code;
        const matchCode = code.includes(term) || (cleanTerm && cleanCode.includes(cleanTerm));
        return subj.includes(term) || title.includes(term) || matchCode;
      });
    }

    // 4. Tính toán phân trang (9 đề / trang)
    const totalItems = filteredExams.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / LIB_PAGE_SIZE));
    if (currentLibPage > totalPages) currentLibPage = totalPages;
    if (currentLibPage < 1) currentLibPage = 1;

    const startIndex = (currentLibPage - 1) * LIB_PAGE_SIZE;
    const pageExams = filteredExams.slice(startIndex, startIndex + LIB_PAGE_SIZE);

    // 5. Render danh sách đề thi của trang hiện tại
    if (pageExams.length === 0) {
      grid.innerHTML = '<div class="library-empty-state">'
        + '<div class="empty-icon">🔍</div>'
        + '<div class="empty-title">Không tìm thấy đề thi phù hợp</div>'
        + '<p class="empty-desc">Không có đề thi nào thuộc môn học "<b>' + escapeHtml(currentLibSubjectFilter) + '</b>". Hãy thử chọn môn học khác hoặc xóa bộ lọc.</p>'
        + '<button class="btn-reset-filter" onclick="clearLibSubjectFilter()">↺ Xem tất cả đề thi</button>'
        + '</div>';
    } else {
      grid.innerHTML = pageExams.map(exam => {
        const authorText = exam.author ? '• Tác giả: <b>' + escapeHtml(exam.author) + '</b>' : '';
        return '<div class="library-card" onclick="openQuickViewModal(\'' + exam.id + '\')" title="Nháy chuột để xem nhanh nội dung đề thi">'
          + '<div class="lib-badge-row">'
          + '  <span class="lib-subject">' + escapeHtml(exam.subject) + '</span>'
          + '  <span class="lib-count"><span class="exam-code-tag">(' + escapeHtml(exam.code) + ')</span> • ' + exam.questions.length + ' câu • ' + exam.timePerQ + 's/câu</span>'
          + '</div>'
          + '<h3 class="lib-title">' + escapeHtml(exam.title) + '</h3>'
          + '<p class="lib-desc">' + escapeHtml(exam.desc || 'Bộ câu hỏi chuẩn hóa trong Ngân hàng đề công khai.') + ' <br><small style="color:var(--gray-text);">' + authorText + '</small></p>'
          + '<div class="lib-actions" onclick="event.stopPropagation()">'
          + '  <button class="btn-lib-save" onclick="savePublicExamToPrivate(\'' + exam.id + '\')" title="Lưu bản sao bộ đề này vào kho cá nhân của bạn">💾 Lưu</button>'
          + '  <button class="btn-lib-edit" onclick="saveAndEditPublicExam(\'' + exam.id + '\')" title="Lưu đề vào kho cá nhân và nạp ngay vào bảng soạn thảo">✏️ Lưu và chỉnh sửa ngay</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    // 6. Render thanh phân trang: dãy 1 > 2 > 3 ... và ô nhập trang
    renderLibraryPagination(totalPages);
  }

  /* Tạo thanh phân trang kiểu chuỗi nút 1 > 2 > 3 ... và ô nhảy trang */
  function renderLibraryPagination(totalPages) {
    const pagEl = document.getElementById('library-pagination');
    if (!pagEl) return;

    if (totalPages <= 1) {
      pagEl.style.display = 'none';
      return;
    }
    pagEl.style.display = 'flex';

    // Tạo danh sách các số trang cần hiển thị
    const pageItems = [];
    if (totalPages <= 7) {
      for (let p = 1; p <= totalPages; p++) pageItems.push(p);
    } else {
      pageItems.push(1);
      if (currentLibPage > 4) pageItems.push('...');

      const start = Math.max(2, currentLibPage - 1);
      const end = Math.min(totalPages - 1, currentLibPage + 1);
      for (let p = start; p <= end; p++) {
        if (!pageItems.includes(p)) pageItems.push(p);
      }

      if (currentLibPage < totalPages - 3) pageItems.push('...');
      if (!pageItems.includes(totalPages)) pageItems.push(totalPages);
    }

    let chainHtml = '';
    pageItems.forEach((item, idx) => {
      if (idx > 0) {
        chainHtml += '<span class="pag-arrow-sep">&gt;</span>';
      }
      if (item === '...') {
        chainHtml += '<span class="pag-dots">...</span>';
      } else {
        const isActive = item === currentLibPage;
        chainHtml += '<button class="pag-btn ' + (isActive ? 'active' : '') + '" onclick="changeLibPage(' + item + ')">' + item + '</button>';
      }
    });

    pagEl.innerHTML = '<div class="pag-pages-chain">'
      + '<button class="pag-btn" ' + (currentLibPage === 1 ? 'disabled' : '') + ' onclick="changeLibPage(' + (currentLibPage - 1) + ')" title="Trang trước">‹ Trước</button>'
      + chainHtml
      + '<button class="pag-btn" ' + (currentLibPage === totalPages ? 'disabled' : '') + ' onclick="changeLibPage(' + (currentLibPage + 1) + ')" title="Trang sau">Sau ›</button>'
      + '</div>'
      + '<div class="pag-jump-wrap">'
      + '  <span>Đến trang:</span>'
      + '  <input type="number" class="pag-jump-input" id="lib-jump-input" min="1" max="' + totalPages + '" value="' + currentLibPage + '" onkeydown="if(event.key===\'Enter\') jumpLibPage(' + totalPages + ')" />'
      + '  <button class="btn-pag-jump" onclick="jumpLibPage(' + totalPages + ')">Đi</button>'
      + '</div>';
  }

  function changeLibPage(page) {
    currentLibPage = page;
    renderLibraryTab(false);
    const filterPanel = document.querySelector('.library-filter-panel');
    if (filterPanel) {
      filterPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function jumpLibPage(totalPages) {
    const input = document.getElementById('lib-jump-input');
    if (!input) return;
    let val = parseInt(input.value);
    if (isNaN(val)) return;
    if (val < 1) val = 1;
    if (val > totalPages) val = totalPages;
    changeLibPage(val);
  }

  function handleLibSearchInput() {
    clearTimeout(libSearchDebounceTimer);
    libSearchDebounceTimer = setTimeout(() => {
      const input = document.getElementById('lib-search-subject');
      currentLibSubjectFilter = input ? input.value.trim() : '';
      currentLibPage = 1;
      renderLibraryTab(false);
    }, 250);
  }

  function filterLibBySubject(subject) {
    currentLibSubjectFilter = subject;
    const input = document.getElementById('lib-search-subject');
    if (input) input.value = subject;
    currentLibPage = 1;
    renderLibraryTab(false);
  }

  function clearLibSubjectFilter() {
    filterLibBySubject('');
  }

  /* Lưu đề thi từ Public Storage vào Private Storage của user */
  async function savePublicExamToPrivate(examId, showNotification = true) {
    const publicExam = publicExamsCache.find(e => e.id === examId) || FALLBACK_PUBLIC_EXAMS.find(e => e.id === examId);
    if (!publicExam) {
      showToast('⚠️ Không tìm thấy đề thi!');
      return null;
    }

    try {
      const res = await fetch('/api/storage/public/save-to-private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ examId })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.exam) {
          let exams = getSavedExams();
          exams.unshift(data.exam);
          setSavedExams(exams);
          renderSavedExamsList();
          if (showNotification) showToast('✅ Đã lưu đề "' + data.exam.title + '" vào kho cá nhân của bạn!');
          return data.exam;
        }
      }
    } catch (e) {
      console.warn('Lỗi gọi API save-to-private, thực hiện lưu cục bộ:', e);
    }

    // Fallback lưu cục bộ nếu server chưa phản hồi
    const cloned = JSON.parse(JSON.stringify(publicExam));
    cloned.id = 'exam-' + Date.now();
    const nextCopy = (publicExam.copiesIssued || 0) + 1;
    publicExam.copiesIssued = nextCopy;
    cloned.code = `${publicExam.code}-${nextCopy}`;
    cloned.parentCode = publicExam.code;
    cloned.createdAt = new Date().toLocaleDateString('vi-VN');
    delete cloned.pin;
    delete cloned.copiesIssued;

    saveExamToStorage(cloned);
    renderSavedExamsList();
    if (showNotification) showToast('✅ Đã lưu đề "' + cloned.title + '" (' + cloned.code + ') vào kho cá nhân của bạn!');
    return cloned;
  }

  /* Lưu đề thi vào kho cá nhân và nạp ngay vào bảng soạn thảo */
  async function saveAndEditPublicExam(examId) {
    const savedExam = await savePublicExamToPrivate(examId, false);
    if (savedExam) {
      closeQuickViewModal();
      loadExamForEditing(savedExam.id);
      switchTab('create');
      showToast('✏️ Đã lưu và nạp đề "' + savedExam.title + '" vào bảng soạn thảo!');
    }
  }

  /* ── MODAL XEM NHANH ĐỀ THI ── */
  function openQuickViewModal(examId, source = 'auto') {
    let exam = null;
    if (source === 'private') {
      exam = getSavedExams().find(e => e.id === examId);
    } else if (source === 'public') {
      exam = (publicExamsCache || []).find(e => e.id === examId || e.code === examId);
    }
    if (!exam) {
      exam = (publicExamsCache || []).find(e => e.id === examId || e.code === examId)
        || getSavedExams().find(e => e.id === examId);
    }
    if (!exam) return;

    document.getElementById('qv-modal-title').textContent = exam.title;

    const authorText = exam.author ? 'Tác giả: ' + escapeHtml(exam.author) : (exam.sharedBy ? 'Người chia sẻ: ' + escapeHtml(exam.sharedBy) : 'Kho đề cá nhân');
    const qCount = exam.questions ? exam.questions.length : 0;
    document.getElementById('qv-modal-meta').innerHTML = `
      <span class="qv-meta-tag">${escapeHtml(exam.subject || 'Tổng hợp')}</span> • 
      <span>Mã đề: <strong>${escapeHtml(exam.code || '#---')}</strong></span> • 
      <span><strong>${qCount}</strong> câu hỏi</span> • 
      <span><strong>${exam.timePerQ || 15}s</strong>/câu</span> • 
      <span style="color:var(--gray-text);">${authorText}</span>
    `;

    const letters = ['A', 'B', 'C', 'D'];
    const listEl = document.getElementById('qv-questions-list');
    listEl.innerHTML = (exam.questions || []).map((q, i) => {
      const choicesHtml = (q.choices || []).map((choice, cIdx) => {
        const isCorrect = q.correct === cIdx;
        return `<div class="qv-choice-item ${isCorrect ? 'is-correct' : ''}">
          <span class="qv-choice-letter">${letters[cIdx] || (cIdx+1)}.</span>
          <span class="qv-choice-text">${escapeHtml(choice)}</span>
          ${isCorrect ? '<span class="qv-correct-badge">✓ Đáp án đúng</span>' : ''}
        </div>`;
      }).join('');

      return `<div class="qv-q-card">
        <div class="qv-q-header">
          <span class="qv-q-num">Câu ${i + 1}:</span>
          <span class="qv-q-text">${escapeHtml(q.text)}</span>
        </div>
        <div class="qv-choices-grid">
          ${choicesHtml}
        </div>
      </div>`;
    }).join('');

    // Nút thao tác ở dưới modal:
    const isInPrivate = getSavedExams().some(e => e.id === exam.id || (exam.code && e.code === exam.code));
    let actionsHtml = '';
    if (isInPrivate) {
      actionsHtml = `
        <button class="btn-lib-room" onclick="handleCreateRoomForExam('${exam.id}', event)" style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); color:#fff; border:none; padding:8px 16px; border-radius:8px; font-weight:700; cursor:pointer;">🚀 Tạo phòng thi ngay</button>
        <button class="btn-lib-edit" onclick="loadExamForEditing('${exam.id}'); switchTab('create'); closeQuickViewModal();">✏️ Chỉnh sửa đề này</button>
      `;
    } else {
      actionsHtml = `
        <button class="btn-lib-room" onclick="handleCreateRoomFromPublic('${exam.id}')" style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); color:#fff; border:none; padding:8px 16px; border-radius:8px; font-weight:700; cursor:pointer;">🚀 Tạo phòng thi ngay</button>
        <button class="btn-lib-save" onclick="savePublicExamToPrivate('${exam.id}'); closeQuickViewModal();">💾 Lưu vào đề cá nhân</button>
        <button class="btn-lib-edit" onclick="saveAndEditPublicExam('${exam.id}')">✏️ Lưu và chỉnh sửa ngay</button>
      `;
    }
    document.getElementById('qv-modal-actions').innerHTML = actionsHtml;

    document.getElementById('quickview-modal').classList.add('show');
  }

  async function handleCreateRoomFromPublic(examId) {
    const pub = (publicExamsCache || []).find(e => e.id === examId || e.code === examId) || FALLBACK_PUBLIC_EXAMS.find(e => e.id === examId);
    if (!pub) return;
    const cloned = JSON.parse(JSON.stringify(pub));
    cloned.id = 'exam-' + Date.now();
    cloned.code = generateExamCode();
    delete cloned.author;
    cloned.sourceParentId = pub.id;
    cloned.createdAt = new Date().toLocaleDateString('vi-VN');
    
    sessionStorage.setItem('mqc_assigned_exam', JSON.stringify(cloned));
    try {
      await saveExamToStorage(cloned);
    } catch(e) {}
    window.location.href = 'create-room.html?examId=' + encodeURIComponent(cloned.id);
  }

  function closeQuickViewModal() {
    const modal = document.getElementById('quickview-modal');
    if (modal) modal.classList.remove('show');
  }

  /* ── TAB 3: CHIA SẺ ĐỀ THI CỦA BẠN (SHARE) ── */
  async function renderShareTab() {
    const unsharedListEl = document.getElementById('unshared-list');
    const sharedListEl = document.getElementById('shared-list');
    const unsharedBadge = document.getElementById('unshared-count-badge');
    const sharedBadge = document.getElementById('shared-count-badge');
    if (!unsharedListEl || !sharedListEl) return;

    // Đảm bảo có cache public exams mới nhất
    if (!publicExamsCache || publicExamsCache.length === 0) {
      try {
        const res = await fetch('/api/storage/public');
        if (res.ok) {
          const data = await res.json();
          if (data.success && Array.isArray(data.exams)) publicExamsCache = data.exams;
        }
      } catch (e) {}
    }

    const userExams = getSavedExams();
    const myUsername = (CURRENT_USER || '').toLowerCase();

    // 1. Danh sách đề đã chia sẻ lên ngân hàng (được chia sẻ bởi user này)
    const sharedExams = (publicExamsCache || []).filter(e => {
      const sharedBy = (e.sharedBy || '').toLowerCase();
      return sharedBy === myUsername;
    });

    // 2. Danh sách đề chưa chia sẻ (trong Private nhưng chưa đưa lên Public)
    const unsharedExams = userExams.filter(exam => {
      return !sharedExams.some(se => (se.code && se.code === exam.code) || se.id === exam.id);
    });

    // Cập nhật số lượng badge
    if (unsharedBadge) unsharedBadge.textContent = unsharedExams.length + ' đề thi';
    if (sharedBadge) sharedBadge.textContent = sharedExams.length + ' đề thi';

    // Render danh sách đề chưa chia sẻ
    if (unsharedExams.length === 0) {
      unsharedListEl.innerHTML = '<div class="share-empty-box">Tất cả đề thi trong kho cá nhân của bạn đã được chia sẻ lên Ngân hàng.</div>';
    } else {
      unsharedListEl.innerHTML = unsharedExams.map(exam => {
        const code = exam.code || '#00000000';
        const qCount = exam.questions ? exam.questions.length : 0;
        return '<div class="share-item-row" onclick="openQuickViewModal(\'' + exam.id + '\', \'private\')" title="Nháy chuột để xem trước đề thi">'
          + '<div class="share-item-info">'
          + '  <div class="share-item-title">'
          + '    <span>' + escapeHtml(exam.title) + '</span>'
          + '    <span class="exam-code-tag">(' + escapeHtml(code) + ')</span>'
          + '  </div>'
          + '  <div class="share-item-meta">Môn: ' + escapeHtml(exam.subject || 'Tổng hợp') + ' • ' + qCount + ' câu hỏi • ' + (exam.timePerQ || 15) + 's/câu</div>'
          + '</div>'
          + '<div class="share-buttons-row" onclick="event.stopPropagation()">'
          + '  <button class="btn-share-publish" onclick="openShareModal(\'' + exam.id + '\')" title="Chia sẻ đề thi này lên Ngân hàng đề công khai">🌐 Chia sẻ đề này</button>'
          + '  <button class="btn-share-delete" onclick="deleteSavedExam(\'' + exam.id + '\')" title="Xóa đề thi khỏi kho cá nhân">🗑️</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }

    // Render danh sách đề đã chia sẻ (xếp ở dưới cùng)
    if (sharedExams.length === 0) {
      sharedListEl.innerHTML = '<div class="share-empty-box">Bạn chưa chia sẻ đề thi nào lên Ngân hàng công khai.</div>';
    } else {
      sharedListEl.innerHTML = sharedExams.map(exam => {
        const code = exam.code || '#00000000';
        const qCount = exam.questions ? exam.questions.length : 0;
        const sharedAt = exam.sharedAt || 'Gần đây';
        return '<div class="share-item-row is-shared" onclick="openQuickViewModal(\'' + exam.id + '\', \'public\')" title="Nháy chuột để xem trước đề thi">'
          + '<div class="share-item-info">'
          + '  <div class="share-item-title">'
          + '    <span>' + escapeHtml(exam.title) + '</span>'
          + '    <span class="exam-code-tag">(' + escapeHtml(code) + ')</span>'
          + '    <span class="badge-shared-live">✓ Đang trên Ngân hàng</span>'
          + '  </div>'
          + '  <div class="share-item-meta">Môn: ' + escapeHtml(exam.subject || 'Tổng hợp') + ' • ' + qCount + ' câu hỏi • Chia sẻ ngày: ' + escapeHtml(sharedAt) + '</div>'
          + '</div>'
          + '<div class="share-buttons-row" onclick="event.stopPropagation()">'
          + '  <button class="btn-share-unshare" onclick="unshareExamFromPublic(\'' + exam.id + '\')" title="Gỡ đề này khỏi Ngân hàng đề công khai">🗑️ Gỡ đề khỏi ngân hàng</button>'
          + '  <button class="btn-share-save" onclick="saveExamFromPublicToPrivate(\'' + exam.id + '\')" title="Lưu lại đề từ Ngân hàng về kho cá nhân">💾 Lưu lại</button>'
          + '</div>'
          + '</div>';
      }).join('');
    }
  }

  /* ── MODAL CHIA SẺ ĐỀ THI & NHẬP MÔ TẢ ── */
  let currentSharingExamId = null;
  let warningTargetExamId = null;

  function showShareWarningModal(exam, parentExam, parentCode) {
    warningTargetExamId = exam.id;
    const msgEl = document.getElementById('share-warning-msg');
    if (msgEl) {
      msgEl.innerHTML = 'Đề thi này là bản sao của "<b>' + escapeHtml(parentExam.title) + '</b>" (<span class="exam-code-tag">' + escapeHtml(parentCode) + '</span>).<br><br>Bạn cần <b>chỉnh sửa nội dung khác biệt ít nhất 10%</b> so với bản gốc mới có thể chia sẻ lên Ngân hàng đề!';
    }
    const modal = document.getElementById('share-warning-modal');
    if (modal) modal.classList.add('show');
  }

  function closeShareWarningModal() {
    const modal = document.getElementById('share-warning-modal');
    if (modal) modal.classList.remove('show');
    warningTargetExamId = null;
  }

  function handleWarningEditNow() {
    if (warningTargetExamId) {
      const targetId = warningTargetExamId;
      closeShareWarningModal();
      loadExamForEditing(targetId);
      switchTab('create');
      showToast('✏️ Đã nạp đề vào bảng soạn thảo! Hãy chỉnh sửa ít nhất 10% nội dung để có thể chia sẻ.');
    }
  }

  function openShareModal(examId) {
    const userExams = getSavedExams();
    const exam = userExams.find(e => e.id === examId);
    if (!exam) return;

    // Kiểm tra đề có hậu tố -N (bản sao tải từ ngân hàng)
    const examCode = String(exam.code || '').trim();
    const lastDashIdx = examCode.lastIndexOf('-');
    if (lastDashIdx !== -1) {
      const parentCode = examCode.substring(0, lastDashIdx);
      const parentExam = (publicExamsCache || []).find(e => e.code === parentCode);
      if (parentExam) {
        const diffPercent = calculateExamDiffPercent(parentExam, exam);
        if (diffPercent < 10) {
          showShareWarningModal(exam, parentExam, parentCode);
          return;
        }
      }
    }

    currentSharingExamId = examId;

    const qCount = exam.questions ? exam.questions.length : 0;
    const authorName = CURRENT_DISPLAY_NAME || CURRENT_USER || 'Giáo viên';
    document.getElementById('share-modal-exam-info').innerHTML = `
      <div class="share-modal-title">
        <span>${escapeHtml(exam.title)}</span>
        <span class="exam-code-tag">(${escapeHtml(exam.code || '#---')})</span>
      </div>
      <div class="share-modal-meta">
        Môn học: <b>${escapeHtml(exam.subject || 'Tổng hợp')}</b> • <b>${qCount} câu hỏi</b> • ${exam.timePerQ || 15}s/câu
      </div>
    `;

    document.getElementById('share-author-display').value = authorName;
    document.getElementById('share-desc-input').value = exam.desc || '';

    document.getElementById('share-modal').classList.add('show');
    setTimeout(() => {
      document.getElementById('share-desc-input')?.focus();
    }, 150);
  }

  function closeShareModal() {
    const modal = document.getElementById('share-modal');
    if (modal) modal.classList.remove('show');
    currentSharingExamId = null;
  }

  async function confirmShareExam() {
    if (!currentSharingExamId) return;
    const userExams = getSavedExams();
    const exam = userExams.find(e => e.id === currentSharingExamId);
    if (!exam) return;

    const descInput = document.getElementById('share-desc-input');
    const desc = descInput ? descInput.value.trim() : '';

    const authorName = CURRENT_DISPLAY_NAME || CURRENT_USER || 'Giáo viên';
    exam.desc = desc;
    exam.author = authorName;

    // Lưu lại mô tả vào kho cá nhân
    saveExamToStorage(exam);

    try {
      const res = await fetch('/api/storage/public/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ exam })
      });
      if (res.ok) {
        closeShareModal();
        showToast('🌐 Đã chia sẻ đề "' + exam.title + '" lên Ngân hàng đề công khai!');
        await renderLibraryTab(true);
        renderShareTab();
        return;
      } else {
        const errData = await res.json().catch(() => ({}));
        const msg = errData.message || 'Không thể chia sẻ đề thi lên máy chủ.';
        closeShareModal();
        const examCode = String(exam.code || '').trim();
        const lastDashIdx = examCode.lastIndexOf('-');
        const parentCode = lastDashIdx !== -1 ? examCode.substring(0, lastDashIdx) : '';
        const parentExam = parentCode ? (publicExamsCache || []).find(e => e.code === parentCode) : null;
        if (parentExam) {
          showShareWarningModal(exam, parentExam, parentCode);
        } else {
          showToast('⚠️ ' + msg);
        }
        return;
      }
    } catch (e) {
      console.warn('Lỗi chia sẻ lên server:', e);
    }
    showToast('⚠️ Không thể chia sẻ đề thi lên máy chủ.');
  }

  /* Gỡ đề thi khỏi Ngân hàng đề công khai */
  async function unshareExamFromPublic(examId) {
    if (!confirm('Bạn có chắc muốn gỡ đề thi này khỏi Ngân hàng đề công khai?')) return;
    try {
      const res = await fetch('/api/storage/public/' + encodeURIComponent(examId), {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      const data = await res.json();
      if (data.success) {
        showToast('🗑️ Đã gỡ đề thi khỏi Ngân hàng đề công khai!');
        publicExamsCache = (publicExamsCache || []).filter(e => e.id !== examId && e.code !== examId);
        await renderLibraryTab(true);
        renderShareTab();
        return;
      } else {
        showToast('⚠️ ' + (data.message || 'Không thể gỡ đề thi!'));
      }
    } catch (err) {
      showToast('⚠️ Lỗi kết nối tới máy chủ.');
    }
  }

  /* Lưu lại đề từ Ngân hàng về Private Storage */
  async function saveExamFromPublicToPrivate(examId) {
    await savePublicExamToPrivate(examId, true);
    renderShareTab();
    renderSavedExamsList();
  }

  function deleteSavedExam(examId) {
    if (confirm('Bạn có chắc muốn xóa đề thi đã lưu này khỏi Private Storage?')) {
      let exams = getSavedExams();
      exams = exams.filter(e => e.id !== examId);
      setSavedExams(exams);

      fetch('/api/storage/private/' + encodeURIComponent(examId), {
        method: 'DELETE',
        credentials: 'same-origin'
      }).catch(() => {});

      if (currentEditingExamId === examId) {
        currentEditingExamId = null;
      }
      renderSavedExamsList();
      renderShareTab();
      showToast('🗑️ Đã xóa đề thi khỏi kho cá nhân!');
    }
  }

  /* ── STORAGE HELPERS ── */
  function sortExamsByCode(exams) {
    return (exams || []).slice().sort((a, b) => {
      const codeA = String(a.code || '').trim();
      const codeB = String(b.code || '').trim();
      return codeA.localeCompare(codeB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  function canonicalizeQuestion(q) {
    if (!q) return '';
    const text = String(q.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const choices = (q.choices || []).map(c => String(c || '').trim().toLowerCase().replace(/\s+/g, ' '));
    const correctText = choices[q.correct] || '';
    const sortedChoices = [...choices].sort().join('|');
    return `q:${text}#c:${correctText}#ch:${sortedChoices}`;
  }

  function getCanonicalExamString(exam) {
    if (!exam) return '';
    const title = String(exam.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const canonicalQuestions = (exam.questions || []).map(canonicalizeQuestion).sort();
    return `title:${title}\nquestions:\n${canonicalQuestions.join('\n')}`;
  }

  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const v0 = new Int32Array(b.length + 1);
    const v1 = new Int32Array(b.length + 1);
    for (let i = 0; i <= b.length; i++) v0[i] = i;
    for (let i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < b.length; j++) {
        const cost = (a[i] === b[j]) ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
    }
    return v0[b.length];
  }

  function calculateExamDiffPercent(parentExam, currentExam) {
    const s1 = getCanonicalExamString(parentExam);
    const s2 = getCanonicalExamString(currentExam);
    if (s1 === s2) return 0;
    const dist = levenshteinDistance(s1, s2);
    const maxLen = Math.max(s1.length, s2.length);
    return maxLen > 0 ? (dist / maxLen) * 100 : 0;
  }

  async function saveExamToStorage(exam) {
    if (!exam.code) exam.code = generateExamCode();
    delete exam.pin;

    let exams = getSavedExams();
    const idx = exams.findIndex(e => e.id === exam.id);
    if (idx >= 0) {
      exams[idx] = exam;
    } else {
      exams.unshift(exam);
    }
    setSavedExams(exams);

    // Gọi API lưu lên server Private Storage
    try {
      const res = await fetch('/api/storage/private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ exam })
      });
      return await res.json();
    } catch (err) {
      console.warn('Lỗi lưu server:', err);
      return null;
    }
  }

  function generateExamCode() {
    const chars = '0123456789abcdef';
    let hex = '';
    for (let i = 0; i < 4; i++) {
      hex += chars[Math.floor(Math.random() * chars.length)];
    }
    return '#' + hex;
  }

  function generateRandomPin() {
    const part1 = Math.floor(100 + Math.random() * 900);
    const part2 = Math.floor(100 + Math.random() * 900);
    return part1 + '-' + part2;
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }