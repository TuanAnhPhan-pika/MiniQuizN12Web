const test = require('node:test');
const assert = require('node:assert/strict');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

test('TC-05 [Integration][Phân vùng tương đương] Đăng ký và đăng nhập thành công, lưu vào DB SQLite in-memory và không lộ hash', async () => {
  const ctx = await startIsolatedServer();
  try {
    const reg = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'gv_test01',
        displayName: 'Giáo viên A',
        password: 'Pass1234',
        confirmPassword: 'Pass1234',
      },
    });

    assert.equal(reg.status, 200);
    assert.equal(reg.json.success, true);
    assert.equal(reg.json.username, 'gv_test01');
    assert.equal(reg.json.displayName, 'Giáo viên A');
    assert.ok(reg.setCookies.some(c => c.includes('mqc_session=')), 'Register phải set session cookie');
    assert.equal(reg.json.passwordHash, undefined, 'Response tuyệt đối không được lộ passwordHash');
    assert.equal(reg.json.salt, undefined, 'Response tuyệt đối không được lộ salt');

    // Kiểm tra bản ghi thật trong DB SQLite in-memory
    const dbCheck = await ctx.sqlitePool.query(
      'SELECT username, display_name, password_hash, salt FROM users WHERE username_lower = $1',
      ['gv_test01']
    );
    assert.equal(dbCheck.rows.length, 1, 'Bảng users phải có đúng 1 bản ghi gv_test01');
    assert.equal(dbCheck.rows[0].display_name, 'Giáo viên A');
    assert.notEqual(dbCheck.rows[0].password_hash, 'Pass1234', 'Mật khẩu lưu DB phải đã được hash');

    // Đăng nhập lại với tài khoản vừa tạo
    const login = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/login', {
      body: { username: 'gv_test01', password: 'Pass1234' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.success, true);
    assert.equal(login.json.user.displayName, 'Giáo viên A');
    assert.equal(login.json.user.passwordHash, undefined);
    assert.ok(login.setCookies.some(c => c.includes('mqc_session=')), 'Login phải set session cookie');
  } finally {
    await ctx.close();
  }
});

test('TC-06 [Integration][Phân vùng tương đương - Luồng lỗi] Từ chối đăng ký trùng tài khoản (409) và đăng nhập sai mật khẩu (401)', async () => {
  const ctx = await startIsolatedServer();
  try {
    // Tiền điều kiện: tạo sẵn user gv_dup trong DB test cô lập
    await ctx.auth.createUser({
      username: 'gv_dup',
      displayName: 'Giáo viên Trùng',
      password: 'Pass1234',
    });

    const dupReg = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'gv_dup',
        displayName: 'Người khác',
        password: 'Pass1234',
        confirmPassword: 'Pass1234',
      },
    });
    assert.equal(dupReg.status, 409, 'Đăng ký trùng username phải trả HTTP 409');
    assert.equal(dupReg.json.success, false);

    const countRes = await ctx.sqlitePool.query('SELECT COUNT(*) AS cnt FROM users WHERE username_lower = $1', ['gv_dup']);
    assert.equal(Number(countRes.rows[0].cnt), 1, 'DB không được tạo thêm dòng trùng lặp');

    const badLogin = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/login', {
      body: { username: 'gv_dup', password: 'SaiMatKhau' },
    });
    assert.equal(badLogin.status, 401, 'Đăng nhập sai mật khẩu phải trả HTTP 401');
    assert.equal(badLogin.json.success, false);
    assert.equal(badLogin.json.token, undefined, 'Đăng nhập sai không được cấp token');
    assert.equal(badLogin.json.passwordHash, undefined);
  } finally {
    await ctx.close();
  }
});

test('TC-22 [Integration][Chuyển trạng thái] Đăng xuất (POST /api/auth/logout) thu hồi phiên và cookie cũ bị từ chối 401 ở /api/auth/me', async () => {
  const ctx = await startIsolatedServer();
  try {
    const reg = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'gv_logout',
        displayName: 'GV Đăng Xuất',
        password: 'Password123',
        confirmPassword: 'Password123',
      },
    });
    assert.equal(reg.status, 200);
    const cookie = reg.cookieHeader;

    const meBefore = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/me', { cookie });
    assert.equal(meBefore.status, 200);
    assert.equal(meBefore.json.authenticated, true);
    assert.equal(meBefore.json.username, 'gv_logout');

    const logout = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/logout', { cookie });
    assert.equal(logout.status, 200);
    assert.equal(logout.json.success, true);

    const meAfter = await apiRequest(ctx.baseUrl, 'GET', '/api/auth/me', { cookie });
    assert.equal(meAfter.status, 401, 'Sau khi đăng xuất, cookie cũ gọi /api/auth/me phải trả HTTP 401');
    assert.equal(meAfter.json.authenticated, false);
  } finally {
    await ctx.close();
  }
});
