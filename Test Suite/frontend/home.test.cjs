const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../helpers/page.cjs');
for (const mode of ['success', 'limited', 'rejected', 'offline']) {
  test('home: login ' + mode, async t => {
    const p = await page(t, 'home', { '/api/auth/login': mode === 'offline' ? new Error('offline') : { success: mode === 'success', token: 'login-token', httpStatus: mode === 'limited' ? 429 : 200 } });
    const w = p.window, d = w.document;
    w.openLoginModal(); await p.tick(50);
    await w.handleLogin(); assert.equal(d.activeElement.id, 'login-user');
    d.getElementById('login-user').value = 'teacher'; await w.handleLogin(); assert.equal(d.activeElement.id, 'login-pass');
    d.getElementById('login-pass').value = 'password'; await w.handleLogin(); await p.settle();
    assert.equal(d.querySelector('#form-login .btn-join').disabled, false);
    if (mode === 'success') assert.equal(w.MQC_Auth.getToken(), 'login-token');
    else assert.equal(d.getElementById('error-login').classList.contains('show'), true);
    w.handleModalOverlayClick({ target: { id: 'other' } }); w.handleModalOverlayClick({ target: { id: 'login-modal' } });
    assert.equal(d.getElementById('login-modal').classList.contains('show'), false);
  });
}
for (const mode of ['success', 'limited', 'rejected', 'offline']) {
  test('home: register validation and ' + mode, async t => {
    const p = await page(t, 'home', { '/api/auth/register': mode === 'offline' ? new Error('offline') : { success: mode === 'success', token: 'registered', httpStatus: mode === 'limited' ? 429 : 200 } });
    const w = p.window, d = w.document;
    w.switchAuthTab('register');
    for (const [id, value] of [['reg-user', 'teacher'], ['reg-name', 'Teacher'], ['reg-pass', 'password'], ['reg-confirm', 'password']]) {
      await w.handleRegister(); assert.equal(d.getElementById('error-register').classList.contains('show'), true);
      d.getElementById(id).value = value;
    }
    await w.handleRegister(); await p.settle();
    assert.equal(d.getElementById('btn-submit-register').disabled, false);
    assert.ok(p.calls.some(c => c.url === '/api/auth/register'));
    if (mode === 'success') assert.equal(w.MQC_Auth.getToken(), 'registered');
  });
}
test('home: PIN masking, joining, avatars, authenticated header and logout', async t => {
  const p = await page(t, 'home'); const w = p.window, d = w.document;
  d.getElementById('pin-input').value = 'abc2465799';
  d.getElementById('pin-input').dispatchEvent(new w.Event('input'));
  assert.equal(d.getElementById('pin-input').value, '246-579');
  await w.handleJoin(); assert.ok(d.querySelectorAll('.av-btn').length > 0);
  w.selectAvatar('02'); assert.match(d.getElementById('avatar-preview').src, /02.png/);
  d.getElementById('nickname-input').value = ''; w.handleEnter();
  assert.equal(d.getElementById('error-nick').classList.contains('show'), true);
  w.renderHeaderAuth({ displayName: '<script>name</script>' });
  assert.equal(d.getElementById('header-auth-wrap').querySelector('script'), null);
  await w.logoutOnHome(); assert.equal(w.MQC_Auth.getToken(), '');
  assert.equal(d.getElementById('login-modal').classList.contains('show'), true);
});
for (const mode of ['locked', 'full', 'missing', 'offline']) {
  test('home: blocks room ' + mode, async t => {
    const p = await page(t, 'home', { '/api/rooms/246-579?check=1': mode === 'offline' ? new Error('offline') : { [mode]: true } });
    p.window.document.getElementById('pin-input').value = '246-579'; await p.window.handleJoin();
    assert.equal(p.window.document.getElementById('error-msg').classList.contains('show'), true);
  });
}
