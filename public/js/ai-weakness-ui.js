(function () {
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function reset(containerEl, btnEl) {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = 'Tạo tóm tắt điểm yếu';
    }
    if (containerEl) {
      containerEl.innerHTML = '<div class="ai-weakness-empty">Bấm <strong>Tạo tóm tắt điểm yếu</strong> để AI tổng hợp các câu hỏi lớp dễ sai và gợi ý nội dung ôn tập.</div>';
    }
  }

  function renderAnalysis(containerEl, analysis, cached) {
    if (!containerEl || !analysis) return;
    const weakList = Array.isArray(analysis.weakQuestions) ? analysis.weakQuestions : [];
    const actions = Array.isArray(analysis.teachingActions) ? analysis.teachingActions : [];

    const weakHtml = weakList.length > 0
      ? weakList.map(item => {
          const pct = Math.round(Number(item.accuracyPct) || 0);
          const pctTone = pct < 50 ? 'tone-low' : (pct < 70 ? 'tone-mid' : 'tone-ok');
          return `
            <div class="ai-weak-item ${pctTone}">
              <div class="ai-weak-item-top">
                <span class="ai-weak-qtitle">Câu ${Number(item.qIdx) || 1}: ${escapeHtml(item.topicOrSkill)}</span>
                <span class="ai-weak-pct ${pctTone}">${pct}% đúng</span>
              </div>
              <div class="ai-weak-mistake">${escapeHtml(item.likelyMistake)}</div>
            </div>
          `;
        }).join('')
      : '<div class="ai-weak-mistake">Chưa ghi nhận câu hỏi nào có tỷ lệ sai đáng kể.</div>';

    const actionsHtml = actions.length > 0
      ? `<ul class="ai-actions-list">${actions.map(act => `<li>${escapeHtml(act)}</li>`).join('')}</ul>`
      : '';

    const cacheNote = cached ? ' · Đã tải từ bản lưu' : '';

    containerEl.innerHTML = `
      <div class="ai-weakness-result">
        <div class="ai-weakness-overview">
          <div class="ai-sub-label">Tổng quan lớp học${cacheNote}</div>
          <p class="ai-summary-text">${escapeHtml(analysis.overallSummary)}</p>
        </div>
        <div class="ai-weakness-columns">
          <div class="ai-weak-col">
            <div class="ai-sub-label">Câu hỏi cần chú ý nhất</div>
            <div class="ai-weak-list">${weakHtml}</div>
          </div>
          <div class="ai-weak-col">
            <div class="ai-sub-label">Gợi ý ôn tập buổi tới</div>
            ${actionsHtml}
          </div>
        </div>
      </div>
    `;
  }

  async function analyze({ containerEl, btnEl, pin = '', sessionId = '', roomTitle = '', stats = null }) {
    if (!containerEl || !btnEl || btnEl.disabled) return;
    if (!stats || !Array.isArray(stats.questionsStats) || stats.questionsStats.length === 0) {
      containerEl.innerHTML = '<div class="ai-weakness-error">Chưa có dữ liệu thống kê câu hỏi để phân tích.</div>';
      return;
    }

    btnEl.disabled = true;
    btnEl.textContent = 'Đang phân tích...';
    containerEl.innerHTML = '<div class="ai-weakness-loading">Đang tổng hợp tỷ lệ đúng sai theo từng câu hỏi...</div>';

    try {
      const res = await fetch('/api/ai/analyze-weakness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin, sessionId, roomTitle, stats }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success || !data.analysis) {
        containerEl.innerHTML = `<div class="ai-weakness-error">${escapeHtml(data.message || 'Không thể phân tích điểm yếu lúc này. Vui lòng thử lại.')}</div>`;
        btnEl.disabled = false;
        btnEl.textContent = 'Thử phân tích lại';
        return;
      }

      renderAnalysis(containerEl, data.analysis, !!data.cached);
      btnEl.disabled = false;
      btnEl.textContent = 'Cập nhật phân tích';
    } catch (err) {
      containerEl.innerHTML = '<div class="ai-weakness-error">Không thể kết nối tới máy chủ để phân tích.</div>';
      btnEl.disabled = false;
      btnEl.textContent = 'Thử phân tích lại';
    }
  }

  window.AiWeaknessUI = {
    reset,
    analyze,
    renderAnalysis,
  };
})();
