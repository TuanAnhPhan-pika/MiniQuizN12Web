const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIsolatedModule } = require('../helpers/test-server.js');

/**
 * Nạp module src/auth.js ở chế độ thuần (không kết nối DB thật hay mạng).
 * Tắt hoàn toàn DB thì toàn bộ Unit Test vẫn chạy độc lập.
 */
function createPureAuth() {
  const noopDb = {
    useSupabase: () => false,
    findUserByUsername: async () => { throw new Error('Unit test khong duoc goi DB'); },
    createUser: async () => { throw new Error('Unit test khong duoc goi DB'); },
    saveSession: async () => {},
    deleteSession: async () => {},
  };
  return loadIsolatedModule('src/auth.js', {
    './db/index.js': noopDb,
    './db/pool.js': { query: async () => { throw new Error('Unit test khong duoc goi DB'); } },
  });
}

test('TC-01 [Unit][Giá trị biên] validateUsername từ chối chuỗi 2 và 21 ký tự, chấp nhận 3 ký tự', () => {
  const auth = createPureAuth();

  const errTooShort = auth.validateUsername('ab');
  const errTooLong = auth.validateUsername('a'.repeat(21));
  const okMinBoundary = auth.validateUsername('abc');
  const okMaxBoundary = auth.validateUsername('a'.repeat(20));

  assert.equal(typeof errTooShort, 'string', 'Username 2 ký tự phải trả về thông báo lỗi');
  assert.match(errTooShort, /3-20/);
  assert.equal(typeof errTooLong, 'string', 'Username 21 ký tự phải trả về thông báo lỗi');
  assert.match(errTooLong, /3-20/);
  assert.equal(okMinBoundary, null, 'Username đúng biên dưới 3 ký tự phải hợp lệ');
  assert.equal(okMaxBoundary, null, 'Username đúng biên trên 20 ký tự phải hợp lệ');
});

test('TC-02 [Unit][Giá trị biên] validatePassword từ chối mật khẩu 5 ký tự, chấp nhận 6 ký tự', () => {
  const auth = createPureAuth();

  const err5 = auth.validatePassword('12345');
  const ok6 = auth.validatePassword('123456');

  assert.equal(typeof err5, 'string', 'Mật khẩu 5 ký tự phải bị từ chối');
  assert.match(err5, /6/);
  assert.equal(ok6, null, 'Mật khẩu đủ 6 ký tự phải hợp lệ');
});

test('TC-03 [Unit][Đoán lỗi] validatePassword từ chối mật khẩu toàn khoảng trắng, thiếu ký tự thật sau trim và >128 ký tự', () => {
  const auth = createPureAuth();

  for (const badPass of ['      ', '     a', 'a'.repeat(129)]) {
    const result = auth.validatePassword(badPass);
    assert.equal(
      typeof result,
      'string',
      `BUG-01: validatePassword phải từ chối "${badPass.slice(0, 12)}"`
    );
  }
  assert.equal(auth.validatePassword('a'.repeat(128)), null, 'Mật khẩu đúng biên trên 128 ký tự phải hợp lệ');
});

test('TC-04 [Unit][Chuyển trạng thái] Brute-force lock mở ở lần sai thứ 15 và khóa từ lần sai thứ 16', () => {
  const auth = createPureAuth();
  const ip = '10.0.0.99';

  for (let i = 1; i <= 15; i++) {
    auth.recordLoginFailure(ip);
  }
  const stateAt15 = auth.checkLoginLock(ip);
  assert.equal(stateAt15.locked, false, 'Sau 15 lần sai đầu tiên chưa được khóa IP');

  auth.recordLoginFailure(ip);
  const stateAt16 = auth.checkLoginLock(ip);
  assert.equal(stateAt16.locked, true, 'Từ lần sai thứ 16 trở đi phải khóa IP');
  assert.ok(stateAt16.waitSeconds >= 15, `Thời gian chờ khóa phải >= 15s (thực tế: ${stateAt16.waitSeconds})`);
});

test('TC-17 [Unit][Giá trị biên] validateDisplayName từ chối khoảng trắng/31 ký tự, chấp nhận biên 1 và 30 ký tự', () => {
  const auth = createPureAuth();

  assert.equal(typeof auth.validateDisplayName('   '), 'string', 'Tên chỉ gồm khoảng trắng phải bị từ chối');
  assert.equal(typeof auth.validateDisplayName('A'.repeat(31)), 'string', 'Tên 31 ký tự vượt biên trên phải bị từ chối');
  assert.equal(auth.validateDisplayName('A'), null, 'Tên 1 ký tự (biên dưới) phải hợp lệ');
  assert.equal(auth.validateDisplayName('A'.repeat(30)), null, 'Tên 30 ký tự (biên trên) phải hợp lệ');
});

test('TC-18 [Unit][Phân vùng tương đương] hashPassword & verifyPassword khớp đúng mật khẩu, phân biệt hoa thường và sinh salt ngẫu nhiên', () => {
  const auth = createPureAuth();

  const h1 = auth.hashPassword('Secret123!');
  const h2 = auth.hashPassword('Secret123!');

  assert.notEqual(h1.salt, h2.salt, 'Mỗi lần hash phải sinh salt ngẫu nhiên khác nhau');
  assert.notEqual(h1.hash, 'Secret123!', 'Hash không được trùng mật khẩu gốc');
  assert.equal(auth.verifyPassword('Secret123!', h1.salt, h1.hash), true, 'Mật khẩu đúng phải xác thực thành công');
  assert.equal(auth.verifyPassword('secret123!', h1.salt, h1.hash), false, 'Sai hoa/thường phải trả false');
  assert.equal(auth.verifyPassword('WrongPass!', h1.salt, h1.hash), false, 'Sai mật khẩu phải trả false');
});
