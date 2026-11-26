const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startIsolatedServer, apiRequest } = require('../helpers/test-server.js');

function sendRawHttpRequest(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(rawRequest);
    });
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function assertNoSecretsLeaked(payload, contextName) {
  const raw = JSON.stringify(payload);
  for (const forbidden of ['playerToken', 'hostToken', 'passwordHash', 'password_hash', '"salt"', '"correct"', '"correctChoices"']) {
    assert.equal(
      raw.includes(forbidden),
      false,
      `[${contextName}] Lộ trường nhạy cảm ${forbidden} trong phản hồi JSON!`
    );
  }
}

test('SEC-01 [XSS & Path Traversal & URI Encoding] Chống Reflected XSS qua Host/X-Forwarded-Host & APP_URL, chống Path Traversal và chống lỗi 500 khi URL sai mã hóa %ZZ', async () => {
  const ctx = await startIsolatedServer({
    extraEnv: { APP_URL: 'https://quiz.example/</script><script>window.__APP_URL_XSS__=1;</script>' },
  });
  try {
    // 1a. Regression: X-Forwarded-Host chứa payload XSS/ký tự lạ không được gây lỗi 500 ERR_INVALID_URL và không được chèn vào <script>
    const xssHost = 'evil.example";</script><script>window.__XSS_PWNED__=1;</script><x a="';
    const htmlRes = await apiRequest(ctx.baseUrl, 'GET', '/index.html', {
      headers: {
        'X-Forwarded-Host': xssHost,
        'X-Forwarded-Proto': 'javascript',
      },
    });
    assert.equal(htmlRes.status, 200);
    assert.equal(
      htmlRes.text.includes('window.__XSS_PWNED__=1'),
      false,
      'Header X-Forwarded-Host độc hại phải bị loại bỏ, không được lọt vào HTML'
    );
    // 1b. Regression: Ngay cả khi biến cấu hình APP_URL chứa </script>, bộ escape JSON vẫn mã hóa \u003c an toàn
    assert.equal(
      htmlRes.text.includes('</script><script>window.__APP_URL_XSS__=1;'),
      false,
      'Không được phép phá vỡ thẻ <script> trong khối cấu hình server'
    );
    assert.match(htmlRes.text, /\\u003c\/script>/i, 'Chuỗi </script> trong cấu hình bơm vào phải được escape an toàn');

    // 2. Chống Path Traversal qua socket HTTP thô (không bị fetch chuẩn hóa đường dẫn trước khi gửi)
    const traversalTargets = [
      '/../package.json',
      '/..%2fpackage.json',
      '/..%5cpackage.json',
      '/%2e%2e/%2e%2e/src/server.js',
      '/css/../../src/auth.js',
      '/js', // Thư mục bên trong public/ cũng phải trả 404 thay vì lỗi đọc file
    ];
    for (const target of traversalTargets) {
      const rawResp = await sendRawHttpRequest(
        ctx.port,
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${ctx.port}\r\nConnection: close\r\n\r\n`
      );
      assert.match(rawResp, /^HTTP\/1\.1 404 /, `Đường dẫn leo thang ${target} phải bị chặn HTTP 404`);
      assert.equal(rawResp.includes('"devDependencies"'), false);
      assert.equal(rawResp.includes('scryptSync'), false);
    }

    // 3. Regression: Chuỗi phần trăm không hợp lệ (%E0%A4%A) ở bất kỳ route nào (kể cả khi đã đăng nhập) phải trả 400 thay vì 500 URIError
    const uriUser = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: { username: 'uri_tester', displayName: 'URI Tester', password: 'Password123!', confirmPassword: 'Password123!' },
    });
    const authHeaderLine = `Authorization: Bearer ${uriUser.json.token}\r\n`;

    for (const [method, badUrl] of [
      ['GET', '/%E0%A4%A'],
      ['GET', '/api/rooms/%E0%A4%A'],
      ['POST', '/api/rooms/%E0%A4%A/join'],
      ['POST', '/api/rooms/%E0%A4%A/answer'],
      ['DELETE', '/api/storage/private/%E0%A4%A'],
      ['DELETE', '/api/storage/public/%E0%A4%A'],
      ['DELETE', '/api/rooms/%E0%A4%A'],
    ]) {
      const rawResp = await sendRawHttpRequest(
        ctx.port,
        `${method} ${badUrl} HTTP/1.1\r\nHost: 127.0.0.1:${ctx.port}\r\n${authHeaderLine}Content-Length: 2\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}`
      );
      assert.match(rawResp, /^HTTP\/1\.1 400 /, `${method} ${badUrl} phải trả HTTP 400 thay vì crash 500`);
    }
  } finally {
    await ctx.close();
  }
});

test('SEC-02 [CORS Whitelist, Payload Limits 413, Malformed JSON 400 & Malformed Cookies] Bảo vệ biên giao thức HTTP', async () => {
  const ctx = await startIsolatedServer();
  try {
    // 1. Origin giả mạo bị chặn 403 trên mọi method thay đổi trạng thái & preflight OPTIONS
    for (const evilOrigin of ['https://attacker.evil.com', 'https://ai.studio.evil.com', 'http://evil-localhost.com']) {
      const preflight = await apiRequest(ctx.baseUrl, 'OPTIONS', '/api/rooms', {
        headers: { Origin: evilOrigin },
      });
      assert.equal(preflight.status, 403, `OPTIONS từ ${evilOrigin} phải bị chặn 403`);

      const postEvil = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/login', {
        headers: { Origin: evilOrigin },
        body: { username: 'abc', password: '123456' },
      });
      assert.equal(postEvil.status, 403, `POST từ ${evilOrigin} phải bị chặn 403`);
    }

    // Origin hợp lệ trong whitelist được cấp CORS header và OPTIONS trả 204
    const validPreflight = await apiRequest(ctx.baseUrl, 'OPTIONS', '/api/rooms', {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(validPreflight.status, 204);
    assert.equal(validPreflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    // 2. JSON hỏng cú pháp và Cookie sai mã hóa URI không bao giờ làm sập server
    const badJson = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      rawBody: '{"username": "broken_json"',
      headers: { 'Content-Type': 'application/json', Cookie: 'mqc_session=%E0%A4%A; broken=%ZZ' },
    });
    assert.equal(badJson.status, 400);

    // 3. Payload vượt giới hạn 2MB trả đúng HTTP 413 Payload Too Large
    const over2Mb = JSON.stringify({ pad: 'X'.repeat(2_050_000) });
    const tooLarge = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/login', {
      rawBody: over2Mb,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await ctx.close();
  }
});

test('SEC-03 [Type-Confusion Fuzzing, Choice/QIdx Coercion, SQL Injection & Zero-Leakage Audit] Chống ép kiểu ngầm, chống lỗi 500 và bảo mật đáp án/token', async () => {
  const ctx = await startIsolatedServer();
  try {
    // 1. Fuzzing kiểu dữ liệu lệch chuẩn trên /register, /login, /change-profile, /storage/private, /rooms -> TUYỆT ĐỐI KHÔNG CÓ HTTP 500!
    const regFuzzPayloads = [
      [],
      null,
      { username: ['admin_arr'], displayName: 'Valid', password: 'Password123', confirmPassword: 'Password123' },
      { username: 'valid_u1', displayName: ['ArrayName'], password: 'Password123', confirmPassword: 'Password123' },
      { username: 'valid_u2', displayName: 'Valid', password: [1, 2, 3, 4, 5, 6], confirmPassword: [1, 2, 3, 4, 5, 6] },
      { username: 'valid_u3', displayName: 'Valid', password: { length: 10 }, confirmPassword: { length: 10 } },
    ];
    for (const fuzz of regFuzzPayloads) {
      const r = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', { body: fuzz });
      assert.notEqual(r.status, 500, `Register fuzz ${JSON.stringify(fuzz)} không được gây lỗi 500`);
      assert.equal(r.status, 400);
    }

    // Đăng ký tài khoản hợp lệ để fuzz các API cần đăng nhập
    const reg = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/register', {
      body: { username: 'sec_host', displayName: 'Sec Host', password: 'Password123!', confirmPassword: 'Password123!' },
    });
    assert.equal(reg.status, 200);
    const cookie = reg.cookieHeader;

    for (const profileFuzz of [
      { newDisplayName: 12345 },
      { newDisplayName: ['Hack'] },
      { newPassword: 123456, currentPassword: 'Password123!' },
      { newPassword: '      ', confirmNewPassword: '      ', currentPassword: 'Password123!' },
      { newPassword: 'ValidNewPass!', confirmNewPassword: 'ValidNewPass!', currentPassword: ['not-a-string'] },
    ]) {
      const r = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/change-profile', { cookie, body: profileFuzz });
      assert.equal(r.status, 400, `change-profile fuzz ${JSON.stringify(profileFuzz)} phải trả HTTP 400`);
    }

    for (const storageFuzz of [
      [],
      { title: 99999, questions: [] },
      { title: ['ArrayTitle'], questions: [] },
      { title: 'Valid Title', questions: 'not-an-array' },
      { exam: { title: '   \t\n  ', questions: [] } },
    ]) {
      const r = await apiRequest(ctx.baseUrl, 'POST', '/api/storage/private', { cookie, body: storageFuzz });
      assert.equal(r.status, 400, `storage/private fuzz ${JSON.stringify(storageFuzz)} phải trả HTTP 400`);
    }

    // 2. Regression ép kiểu choice & qIdx trên POST /api/rooms/:pin/answer:
    // Gửi choice = null / "" / false / [] KHÔNG ĐƯỢC bị Number(...) biến thành đáp án 0!
    const roomRes = await apiRequest(ctx.baseUrl, 'POST', '/api/rooms', {
      cookie,
      body: {
        title: 'Phòng Kiểm Tra Bảo Mật',
        questions: [{ text: 'Đáp án 0 là đúng!', choices: ['Đúng (0)', 'Sai (1)', 'Sai (2)'], correct: 0 }],
      },
    });
    const pin = roomRes.json.pin;

    // Join bằng nick kiểu số/mảng không được gây lỗi 500
    const joinNumericNick = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/join`, {
      body: { nick: 987654, av: '02' },
    });
    assert.equal(joinNumericNick.status, 200);
    assert.equal(joinNumericNick.json.success, true);
    const player = joinNumericNick.json.player;

    await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/start`, { cookie, body: { countdownSec: 1 } });

    for (const bogusChoice of [null, '', '   ', false, true, [], {}]) {
      const ans = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
        body: { playerId: player.id, playerToken: player.playerToken, qIdx: 0, choice: bogusChoice },
      });
      assert.equal(ans.status, 200);
      assert.equal(ans.json.success, false, `choice=${JSON.stringify(bogusChoice)} phải bị từ chối thay vì ép kiểu thành 0`);
      assert.equal(ans.json.invalidChoice, true);
    }

    for (const bogusQIdx of [null, '', 'abc', false, [], -1, 99]) {
      const ans = await apiRequest(ctx.baseUrl, 'POST', `/api/rooms/${pin}/answer`, {
        body: { playerId: player.id, playerToken: player.playerToken, qIdx: bogusQIdx, choice: 0 },
      });
      assert.equal(ans.json.success, false, `qIdx=${JSON.stringify(bogusQIdx)} phải bị từ chối`);
    }

    // 3. Kiểm tra không rò rỉ đáp án hoặc token trên mọi endpoint công khai của phòng đang diễn ra
    for (const sub of ['', '/status', '/state', '/leaderboard', '/question-stats?q=0']) {
      const guestView = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${pin}${sub}`);
      assert.equal(guestView.status, 200);
      assertNoSecretsLeaked(guestView.json, `GET /api/rooms/${pin}${sub}`);
    }

    // 4. SQL Injection Payloads hoàn toàn vô hại trên truy vấn tham số hóa
    const sqli = `' OR '1'='1'; DROP TABLE users; --`;
    const sqliLogin = await apiRequest(ctx.baseUrl, 'POST', '/api/auth/login', {
      body: { username: sqli, password: sqli },
    });
    assert.equal(sqliLogin.status, 401);
    const sqliRoom = await apiRequest(ctx.baseUrl, 'GET', `/api/rooms/${encodeURIComponent(sqli)}`);
    assert.equal(sqliRoom.status, 404);

    const usersStillIntact = await ctx.sqlitePool.query('SELECT COUNT(*) AS cnt FROM users');
    assert.equal(Number(usersStillIntact.rows[0].cnt), 1, 'Bảng users phải hoàn toàn nguyên vẹn trước mọi payload SQLi');
  } finally {
    await ctx.close();
  }
});
