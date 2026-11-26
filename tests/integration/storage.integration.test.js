const test = require('node:test');
const assert = require('node:assert/strict');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

async function registerUser(baseUrl, username) {
  const res = await apiRequest(baseUrl, 'POST', '/api/auth/register', {
    body: {
      username,
      displayName: `GV ${username}`,
      password: 'Password123',
      confirmPassword: 'Password123',
    },
  });
  assert.equal(res.status, 200);
  return res.cookieHeader;
}

test('TC-12 [Integration][Phân vùng tương đương] Lưu và đọc lại đề thi cá nhân hợp lệ (lưu thật xuống SQLite in-memory)', async () => {
  const ctx = await startIsolatedServer();
  try {
    const cookieA = await registerUser(ctx.baseUrl, 'teacher_a');

    const saveRes = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: cookieA,
      body: {
        exam: {
          title: 'Kiểm tra Chương 1',
          subject: 'Web',
          questions: [
            { text: 'HTML là viết tắt của gì?', choices: ['HyperText Markup Language', 'Home Tool'], correct: 0 },
            { text: 'Chọn các phương thức HTTP hợp lệ', choices: ['GET', 'POST', 'JUMP'], correctChoices: [0, 1] },
          ],
        },
      },
    });

    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.json.success, true);
    assert.ok(saveRes.json.exam.id);
    assert.equal(saveRes.json.exam.questions.length, 2);

    // Kiểm tra lại qua GET /api/storage/private
    const listRes = await apiRequest(ctx.baseUrl, 'GET', '/api/storage/private', { cookie: cookieA });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.exams.length, 1);
    assert.equal(listRes.json.exams[0].title, 'Kiểm tra Chương 1');
    assert.equal(listRes.json.exams[0].questions.length, 2);

    // Kiểm tra dữ liệu thực tế trong các bảng SQLite in-memory
    const dbQuiz = await ctx.sqlitePool.query('SELECT id, title, owner_id, status FROM quizzes WHERE id = $1', [saveRes.json.exam.id]);
    assert.equal(dbQuiz.rows.length, 1);
    assert.equal(dbQuiz.rows[0].owner_id, 'teacher_a');
    assert.equal(dbQuiz.rows[0].status, 'active');

    const dbVersions = await ctx.sqlitePool.query('SELECT COUNT(*) AS cnt FROM question_versions');
    assert.equal(Number(dbVersions.rows[0].cnt), 2, 'Phải tạo đúng 2 phiên bản câu hỏi trong bảng question_versions');
  } finally {
    await ctx.close();
  }
});

test('TC-13 [Integration][Bảng quyết định] Chặn truy cập khi chưa đăng nhập (401) và chặn user khác xóa đề của chủ sở hữu', async () => {
  const ctx = await startIsolatedServer();
  try {
    const cookieA = await registerUser(ctx.baseUrl, 'teacher_a');
    const cookieB = await registerUser(ctx.baseUrl, 'teacher_b');

    const saved = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: cookieA,
      body: {
        exam: {
          title: 'Đề bí mật của A',
          questions: [{ text: 'Câu 1', choices: ['A', 'B'], correct: 0 }],
        },
      },
    });
    const examId = saved.json.exam.id;

    // 1. Chưa đăng nhập gọi GET /api/storage/private
    const unauth = await apiRequest(ctx.baseUrl, 'GET', '/api/storage/private');
    assert.equal(unauth.status, 401, 'Chưa đăng nhập phải trả HTTP 401');
    assert.equal(unauth.json.success, false);

    // 2. teacher_b cố xóa đề của teacher_a
    const crossDelete = await apiRequest(ctx.baseUrl, 'DELETE', `/api/storage/private/${examId}`, {
      cookie: cookieB,
    });
    assert.equal(crossDelete.status, 200);
    assert.equal(crossDelete.json.success, false, 'teacher_b không được phép xóa đề của teacher_a');

    // Xác minh bản ghi trong DB vẫn nguyên vẹn
    const dbRow = await ctx.sqlitePool.query('SELECT status, deleted_at FROM quizzes WHERE id = $1', [examId]);
    assert.equal(dbRow.rows[0].status, 'active');
    assert.equal(dbRow.rows[0].deleted_at, null);
  } finally {
    await ctx.close();
  }
});

test('TC-14 [Integration][Giá trị biên] Từ chối lưu đề thi có tiêu đề chỉ gồm khoảng trắng và 0 câu hỏi', async () => {
  const ctx = await startIsolatedServer();
  try {
    const cookieA = await registerUser(ctx.baseUrl, 'teacher_a');

    const badSave = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: cookieA,
      body: {
        exam: {
          title: '   ',
          questions: [],
        },
      },
    });

    assert.equal(
      badSave.status,
      400,
      `BUG-02: POST /api/storage/private trả HTTP ${badSave.status} (chấp nhận lưu đề tiêu đề khoảng trắng "   " và 0 câu hỏi)`
    );
    assert.equal(badSave.json.success, false);

    const countRes = await ctx.sqlitePool.query('SELECT COUNT(*) AS cnt FROM quizzes');
    assert.equal(Number(countRes.rows[0].cnt), 0, 'Không được lưu bản ghi không hợp lệ vào bảng quizzes');
  } finally {
    await ctx.close();
  }
});

test('TC-24 [Integration][Chuyển trạng thái] Chủ sở hữu cập nhật câu hỏi (tạo version v2 bất biến) và tự xóa đề (soft delete)', async () => {
  const ctx = await startIsolatedServer();
  try {
    const cookieA = await registerUser(ctx.baseUrl, 'teacher_ver');

    // 1. Tạo đề v1
    const created = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: cookieA,
      body: {
        exam: {
          title: 'Đề Version 1',
          questions: [{ id: 'q-ver-1', text: 'Nội dung gốc v1', choices: ['A', 'B'], correct: 0 }],
        },
      },
    });
    assert.equal(created.status, 200);
    const examId = created.json.exam.id;

    // 2. Cập nhật nội dung câu hỏi -> phải sinh question_versions v2 và giữ nguyên v1
    const updated = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', {
      cookie: cookieA,
      body: {
        exam: {
          id: examId,
          title: 'Đề Version 2',
          questions: [{ id: 'q-ver-1', text: 'Nội dung đã sửa v2', choices: ['A', 'B'], correct: 1 }],
        },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.exam.title, 'Đề Version 2');

    const verRows = await ctx.sqlitePool.query(
      'SELECT version, content FROM question_versions WHERE question_id = $1 ORDER BY version ASC',
      ['q-ver-1']
    );
    assert.equal(verRows.rows.length, 2, 'Phải bảo toàn cả v1 và tạo thêm v2 (question versioning bất biến)');
    assert.equal(verRows.rows[0].content, 'Nội dung gốc v1');
    assert.equal(verRows.rows[1].content, 'Nội dung đã sửa v2');

    // 3. Chủ sở hữu tự xóa đề (soft delete)
    const del = await apiRequest(ctx.baseUrl, 'DELETE', `/api/storage/private/${examId}`, { cookie: cookieA });
    assert.equal(del.status, 200);
    assert.equal(del.json.success, true);

    const listAfter = await apiRequest(ctx.baseUrl, 'GET', '/api/storage/private', { cookie: cookieA });
    assert.equal(listAfter.json.exams.length, 0, 'Đề đã xóa không được hiển thị trong danh sách cá nhân nữa');

    const dbQuiz = await ctx.sqlitePool.query('SELECT status, deleted_at FROM quizzes WHERE id = $1', [examId]);
    assert.equal(dbQuiz.rows[0].status, 'archived', 'Soft delete phải chuyển status sang archived');
    assert.notEqual(dbQuiz.rows[0].deleted_at, null, 'Soft delete phải ghi nhận thời điểm deleted_at');
  } finally {
    await ctx.close();
  }
});
