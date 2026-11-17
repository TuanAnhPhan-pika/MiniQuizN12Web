const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const plain = v => JSON.parse(JSON.stringify(v));
const ROOT = path.resolve(__dirname, '..');

function makeStorageArea() {
  const store = new Map();
  return {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(String(k), String(v)); },
    removeItem(k) { store.delete(String(k)); },
    clear() { store.clear(); },
    _dump() { return Object.fromEntries(store); },
  };
}

function makeDomHarness() {
  const elements = new Map();
  const docListeners = {};
  const winListeners = {};

  function makeElement(id = '') {
    const classes = new Set();
    const attrs = new Map();
    const elListeners = {};
    let htmlStr = '';
    const el = {
      id,
      tagName: 'DIV',
      value: '',
      get innerHTML() { return htmlStr; },
      set innerHTML(v) { htmlStr = String(v ?? ''); if (htmlStr === '') el.children.length = 0; },
      textContent: '',
      disabled: false,
      checked: false,
      style: { setProperty() {} },
      dataset: {},
      children: [],
      parentElement: null,
      className: '',
      classList: {
        add(...names) { names.forEach(n => classes.add(n)); el.className = Array.from(classes).join(' '); },
        remove(...names) { names.forEach(n => classes.delete(n)); el.className = Array.from(classes).join(' '); },
        toggle(n, force) {
          const on = force !== undefined ? Boolean(force) : !classes.has(n);
          if (on) classes.add(n);
          else classes.delete(n);
          el.className = Array.from(classes).join(' ');
          return on;
        },
        contains(n) { return classes.has(n); },
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(ev, fn) { (elListeners[ev] = elListeners[ev] || []).push(fn); },
      removeEventListener() {},
      dispatchEvent(ev) { (elListeners[ev.type] || []).forEach(fn => fn(ev)); },
      click() { (elListeners.click || []).forEach(fn => fn({ target: el, preventDefault() {} })); if (el.onclick) el.onclick(); },
      focus() {},
      scrollIntoView() {},
      closest() { return null; },
      querySelector() { return makeElement(''); },
      querySelectorAll(sel) {
      if (sel === '.choice-btn') return elements.get('choices')?.children || [];
      return [];
    },
      appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
      remove() {},
    };
    if (id) elements.set(id, el);
    return el;
  }

  const body = makeElement('__body__');
  const document = {
    body,
    documentElement: makeElement('__html__'),
    getElementById(id) { return elements.get(id) || makeElement(id); },
    querySelector(sel) {
      if (sel.startsWith('#')) return document.getElementById(sel.slice(1));
      return makeElement('');
    },
    querySelectorAll(sel) {
      if (sel === '.choice-btn') return elements.get('choices')?.children || [];
      return [];
    },
    createElement(tag) { const el = makeElement(''); el.tagName = tag.toUpperCase(); return el; },
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    removeEventListener() {},
  };

  return { elements, docListeners, winListeners, document, makeElement };
}

test('MQC_Storage isolates global, user, and room scopes, purges legacy keys, and cleans up scopes', () => {
  const filename = path.join(ROOT, 'public/js/storage.js');
  const localStorage = makeStorageArea();
  const sessionStorage = makeStorageArea();
  const win = { localStorage, sessionStorage };
  const context = { window: win, localStorage, sessionStorage, console };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const S = win.MQC_Storage;
  assert.ok(S);

  // User isolation (global + MQC_Storage scoped methods)
  const kAlice = win.getUserStorageKey('draft', 'Alice');
  const kBob = S.getUserKey('draft', 'bob');
  assert.notEqual(kAlice, kBob);
  S.setUser('draft', 'alice', { title: 'Đề Alice' });
  S.setUser('draft', 'bob', { title: 'Đề Bob' });
  assert.deepEqual(plain(S.getUser('draft', 'alice')), { title: 'Đề Alice' });
  assert.deepEqual(plain(S.getUser('draft', 'bob')), { title: 'Đề Bob' });

  // Room scoping in localStorage
  S.setRoom('playerToken', '123456', 'tok-1');
  S.setRoom('playerToken', '654321', 'tok-2');
  assert.equal(S.getRoom('playerToken', '123456'), 'tok-1');
  assert.equal(S.getRoom('playerToken', '654321'), 'tok-2');
  S.clearRoom('123456');
  assert.equal(S.getRoom('playerToken', '123456'), null);
  assert.equal(S.getRoom('playerToken', '654321'), 'tok-2');

  // Legacy purge & clearUser
  localStorage.setItem('mqc_custom_exams', 'legacy');
  localStorage.setItem('mqc_created_rooms', 'legacy2');
  S.purgeLegacyUnscopedKeys();
  assert.equal(localStorage.getItem('mqc_custom_exams'), null);
  assert.equal(localStorage.getItem('mqc_created_rooms'), null);

  S.clearUser('alice');
  assert.equal(S.getUser('draft', 'alice'), null);
  assert.deepEqual(plain(S.getUser('draft', 'bob')), { title: 'Đề Bob' });
});

test('MQC_Auth injects Bearer + x-session-token for all header types, tracks login/me/logout, and skips non-API paths', async () => {
  const filename = path.join(ROOT, 'public/js/auth-client.js');
  const localStorage = makeStorageArea();
  const sessionStorage = makeStorageArea();
  const fetchCalls = [];
  let nextPayload = { ok: true, token: 'tok-login-1', user: { username: 'alice' } };

  class MockHeaders {
    constructor(init = {}) {
      this._m = new Map();
      Object.entries(init).forEach(([k, v]) => this.set(k, v));
    }
    set(k, v) { this._m.set(k.toLowerCase(), String(v)); }
    get(k) { return this._m.get(k.toLowerCase()) ?? null; }
    has(k) { return this._m.has(k.toLowerCase()); }
    forEach(fn) { this._m.forEach((v, k) => fn(v, k)); }
  }

  const originalFetch = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      clone() { return this; },
      async json() { return nextPayload; },
    };
  };

  const win = {
    fetch: originalFetch,
    localStorage,
    sessionStorage,
    location: { origin: 'http://127.0.0.1:3000', href: 'http://127.0.0.1:3000/dashboard.html', pathname: '/dashboard.html', replace() {} },
  };
  const context = {
    window: win,
    localStorage,
    sessionStorage,
    Headers: MockHeaders,
    URL,
    fetch: originalFetch,
    document: { cookie: '' },
    console,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const Auth = win.MQC_Auth;
  assert.ok(Auth);

  // Login captures token
  await win.fetch('/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(Auth.getToken(), 'tok-login-1');

  // Injects into plain object, array pairs, and Headers instance
  await win.fetch('/api/exams', { headers: { 'X-Custom': '1' } });
  assert.equal(fetchCalls[1].init.headers.Authorization, 'Bearer tok-login-1');
  assert.equal(fetchCalls[1].init.headers['x-session-token'], 'tok-login-1');

  await win.fetch('/api/exams', { headers: [['X-Arr', '2']] });
  const hArr = fetchCalls[2].init.headers;
  assert.ok(Array.isArray(hArr) && hArr.some(([k, v]) => k === 'Authorization' && v === 'Bearer tok-login-1'));
  assert.ok(hArr.some(([k, v]) => k === 'x-session-token' && v === 'tok-login-1'));

  await win.fetch('/api/exams', { headers: new MockHeaders({ 'X-Inst': '3' }) });
  assert.equal(fetchCalls[3].init.headers.get('authorization'), 'Bearer tok-login-1');
  assert.equal(fetchCalls[3].init.headers.get('x-session-token'), 'tok-login-1');

  // Does not leak auth token to static pages
  await win.fetch('/index.html');
  assert.equal(Boolean(fetchCalls[4].init?.headers?.Authorization), false);

  // /api/auth/me updates token, /logout clears it
  nextPayload = { user: { username: 'alice' }, token: 'tok-refreshed-2' };
  await win.fetch('/api/auth/me');
  assert.equal(Auth.getToken(), 'tok-refreshed-2');

  nextPayload = { ok: true };
  await win.fetch('/api/auth/logout', { method: 'POST' });
  assert.equal(Auth.getToken(), '');
});

test('room.js multi-choice helpers, clock sync, scoring, ARIA checkboxes, XSS escaping, auto-rejoin & test cleanup', async () => {
  const filename = path.join(ROOT, 'public/js/room.js');
  const dom = makeDomHarness();
  const localStorage = makeStorageArea();
  const sessionStorage = makeStorageArea();
  const storageScope = new Map();
  const fetchCalls = [];
  let fetchHandler = async () => ({
    ok: true,
    status: 200,
    async json() { return { phase: 'waiting', players: [], currentQ: 0 }; },
  });

  const locationObj = {
    search: '?pin=123456&nick=Alice',
    pathname: '/room.html',
    href: 'http://127.0.0.1:3000/room.html?pin=123456&nick=Alice',
    replace() {},
  };

  const context = {
    window: null,
    document: dom.document,
    localStorage,
    sessionStorage,
    location: locationObj,
    history: { replaceState() {} },
    navigator: {},
    URLSearchParams,
    addEventListener(ev, fn) { (dom.winListeners[ev] = dom.winListeners[ev] || []).push(fn); },
    removeEventListener() {},
    MQC_Storage: {
      getRoom(_pin, k) { return storageScope.get(k) ?? null; },
      setRoom(_pin, k, v) { storageScope.set(k, v); },
      removeRoom(_pin, k) { storageScope.delete(k); },
      getUser() { return null; },
      setUser() {},
    },
    MQC_Auth: {
      async fetchMe() { return { user: { username: 'alice', displayName: 'Alice' } }; },
      getToken() { return 'tok-alice'; },
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return fetchHandler(url, init);
    },
    alert() {},
    confirm: () => true,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
    clearTimeout,
    setInterval: () => 99,
    clearInterval() {},
    Date,
    Math,
    JSON,
    console: { log() {}, warn() {}, error() {} },
  };
  const modRef = { exports: {} };
  const ctx2 = {
    ...context,
    module: modRef,
  };
  ctx2.window = ctx2;
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8') +
      '\nmodule.exports = { getVars: () => ({ QUESTIONS, currentQ, myPlayerId, myPlayerToken, historySaved, selectedChoices, serverClockOffset, localQuestionStartMs }), setVars: (p) => { if ("QUESTIONS" in p) QUESTIONS = p.QUESTIONS; if ("currentQ" in p) currentQ = p.currentQ; if ("myPlayerId" in p) myPlayerId = p.myPlayerId; if ("myPlayerToken" in p) myPlayerToken = p.myPlayerToken; if ("historySaved" in p) historySaved = p.historySaved; if ("answered" in p) answered = p.answered; if ("localQuestionStartMs" in p) localQuestionStartMs = p.localQuestionStartMs; } };',
    ctx2,
    { filename }
  );
  // Wait for initial async checkUserInRoom & syncRoomFromServer microtasks to flush
  await new Promise(r => setTimeout(r, 20));
  const hooks = modRef.exports;

  // Multi-choice helpers & scoring
  assert.deepEqual(plain(ctx2.getCorrectChoices({ isMultiple: true, correctChoices: [2, 0, 2] })), [0, 2]);
  assert.equal(ctx2.isMultiQuestion({ correctChoices: [0, 1] }), true);
  assert.equal(ctx2.isMultiQuestion({ correctChoices: [1] }), false);

  hooks.setVars({ localQuestionStartMs: Date.now() - 2000 });
  const pts = ctx2.calcScore();
  assert.ok(pts >= 50 && pts <= 100);

  // Clock skew compensation
  ctx2.syncServerClock({ serverNow: Date.now() + 30_000, currentQ: 0, questionDeadline: Date.now() + 50_000 });
  assert.ok(hooks.getVars().serverClockOffset > 25_000);

  // loadQuestion creates checkbox buttons inside #choices with ARIA attributes & escaped HTML
  hooks.setVars({
    QUESTIONS: [{
      text: 'Chọn 2 đáp án?',
      choices: ['<script>xss()</script>', 'Đúng 1', 'Đúng 2'],
      isMultiple: true,
      correctChoices: [1, 2],
    }],
    currentQ: 0,
    answered: false,
  });

  ctx2.loadQuestion(0);
  const choicesContainer = dom.elements.get('choices');
  assert.equal(choicesContainer.children.length, 3);
  assert.ok(choicesContainer.children[0].className.includes('choice-btn is-multi'));
  assert.equal(choicesContainer.children[0].getAttribute('role'), 'checkbox');
  assert.equal(choicesContainer.children[0].getAttribute('aria-checked'), 'false');
  assert.equal(choicesContainer.children[0].innerHTML.includes('<script>'), false);
  assert.ok(choicesContainer.children[0].innerHTML.includes('&lt;script&gt;xss()&lt;/script&gt;'));

  ctx2.toggleMultiChoice(1);
  assert.equal(choicesContainer.children[1].getAttribute('aria-checked'), 'true');
  assert.deepEqual(plain(hooks.getVars().selectedChoices), [1]);

  // auto-rejoin on unauthorized during selectAnswer on single-choice Q
  hooks.setVars({
    QUESTIONS: [{ text: 'Single', choices: ['A', 'B'], correct: 0 }],
    currentQ: 0,
    myPlayerId: 'p-old',
    myPlayerToken: 'old-tok',
    answered: false,
  });
  let answerStep = 0;
  fetchHandler = async url => {
    if (url.endsWith('/answer')) {
      answerStep++;
      if (answerStep === 1) {
        return { ok: false, status: 401, async json() { return { unauthorized: true }; } };
      }
      return { ok: true, status: 200, async json() { return { success: true }; } };
    }
    if (url.endsWith('/join')) {
      return { ok: true, status: 200, async json() { return { player: { id: 'p-old', playerToken: 'new-tok' } }; } };
    }
    return { ok: true, status: 200, async json() { return {}; } };
  };
  ctx2.selectAnswer(0);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(hooks.getVars().myPlayerToken, 'new-tok');
  assert.equal(answerStep, 2);

  // saveHistoryRecord resets historySaved=false when API returns !res.ok
  hooks.setVars({ historySaved: false });
  fetchHandler = async () => ({ ok: false, status: 500, async json() { return { error: 'DB fail' }; } });
  await ctx2.saveHistoryRecord([{ name: 'Alice', score: 100 }], 1);
  assert.equal(hooks.getVars().historySaved, false);

  // Separate context with isTest=1 verifies skip /api/history + cleanUpTestRoom removes mqc_custom_rooms[PIN]
  localStorage.setItem('mqc_custom_rooms', JSON.stringify({ 'TEST-9': { title: 'T' }, OTHER: { title: 'O' } }));
  const testModeCalls = [];
  const ctxTest = {
    ...context,
    location: { search: '?pin=TEST-9&nick=Tester&isTest=1', pathname: '/room.html', href: 'http://127.0.0.1:3000/room.html', replace() {} },
    fetch: async (url, init) => { testModeCalls.push({ url, init }); return { ok: true, status: 200, async json() { return {}; } }; },
    module: { exports: {} },
  };
  ctxTest.window = ctxTest;
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { getVars: () => ({ historySaved }) };',
    ctxTest,
    { filename }
  );
  await new Promise(r => setTimeout(r, 20));
  const beforeTestHistory = testModeCalls.filter(c => String(c.url).includes('/api/history')).length;
  await ctxTest.saveHistoryRecord([{ name: 'Tester', score: 100 }], 1);
  const afterTestHistory = testModeCalls.filter(c => String(c.url).includes('/api/history')).length;
  assert.equal(afterTestHistory, beforeTestHistory);
  assert.equal(ctxTest.module.exports.getVars().historySaved, true);
  const remainingRooms = JSON.parse(localStorage.getItem('mqc_custom_rooms'));
  assert.equal(Object.hasOwn(remainingRooms, 'TEST-9'), false);
  assert.equal(Object.hasOwn(remainingRooms, 'OTHER'), true);
});

test('create-exam.js search ranking, copy canonicalization/similarity %, and showSimpleConfirm modal + Escape key', async () => {
  const filename = path.join(ROOT, 'public/js/create-exam.js');
  const dom = makeDomHarness();
  const localStorage = makeStorageArea();
  const sessionStorage = makeStorageArea();

  const modRef = { exports: {} };
  const context = {
    window: null,
    document: dom.document,
    localStorage,
    sessionStorage,
    location: { search: '', pathname: '/create-exam.html', href: 'http://127.0.0.1:3000/create-exam.html' },
    URLSearchParams,
    addEventListener(ev, fn) { (dom.winListeners[ev] = dom.winListeners[ev] || []).push(fn); },
    removeEventListener() {},
    MQC_Storage: {
      getUser() { return null; },
      setUser() {},
      removeUser() {},
    },
    MQC_Auth: {
      async fetchMe() { return { user: { username: 'alice', displayName: 'Alice' } }; },
      getToken() { return 'tok-alice'; },
    },
    fetch: async () => ({ ok: true, status: 200, async json() { return []; } }),
    alert() {},
    confirm: () => true,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    Date,
    Math,
    JSON,
    console: { log() {}, warn() {}, error() {} },
    module: modRef,
  };
  context.window = context;

  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8') +
      '\nmodule.exports = { normalizeSavedExamSearchKey, scoreSavedExamSearchMatch, canonicalizeQuestion, getCanonicalExamString, levenshteinDistance, calculateExamDiffPercent, showSimpleConfirm, resolveSimpleConfirm };',
    context,
    { filename }
  );

  // Vietnamese accent-folded search ranking by title
  assert.equal(context.normalizeSavedExamSearchKey('  Đề Lịch   Sử Lớp 12  '), 'de lich su lop 12');
  const exactScore = context.scoreSavedExamSearchMatch({ title: 'Toán Giải Tích' }, 'toan giai tich');
  const prefixScore = context.scoreSavedExamSearchMatch({ title: 'Toán Giải Tích 12' }, 'toan giai tich');
  const subScore = context.scoreSavedExamSearchMatch({ title: 'Đề Toán Giải Tích' }, 'giai tich');
  const multiTokScore = context.scoreSavedExamSearchMatch({ title: 'Giải đề toán tích phân' }, 'toan giai');
  const missScore = context.scoreSavedExamSearchMatch({ title: 'Sinh học' }, 'vat ly');
  assert.equal(exactScore, 1000);
  assert.ok(prefixScore > subScore && subScore > multiTokScore && multiTokScore > 0);
  assert.equal(missScore, 0);

  // Canonicalization & copy diff % (expects exam objects { title, questions })
  const baseQ = [
    { text: 'Thủ đô Việt Nam?', choices: ['Hà Nội', 'Huế'], correct: 0 },
    { text: 'Số nguyên tố chẵn?', choices: ['2', '4'], correct: 0 },
  ];
  const parentExam = { title: 'Đề Gốc', questions: baseQ };
  assert.equal(context.calculateExamDiffPercent(parentExam, parentExam), 0);
  const editedExam = {
    title: 'Đề Hoàn Toàn Mới',
    questions: [
      { text: 'Thủ đô nước ta là thành phố nào?', choices: ['Hà Nội', 'Đà Nẵng'], correct: 0 },
      { text: 'Phép tính 2 + 3 cho kết quả bằng bao nhiêu?', choices: ['4', '5'], correct: 1 },
    ],
  };
  assert.ok(context.calculateExamDiffPercent(parentExam, editedExam) > 20);

  // showSimpleConfirm resolves true on confirm and false on Escape key
  const modal = dom.elements.get('simple-confirm-modal') || dom.document.getElementById('simple-confirm-modal');
  const pOk = context.showSimpleConfirm('Bạn chắc chứ?', 'Đồng ý');
  assert.equal(modal.classList.contains('show'), true);
  context.resolveSimpleConfirm(true);
  assert.equal(await pOk, true);
  assert.equal(modal.classList.contains('show'), false);

  const pEsc = context.showSimpleConfirm('Nhấn ESC');
  assert.equal(modal.classList.contains('show'), true);
  (dom.docListeners.keydown || []).forEach(fn => fn({ key: 'Escape' }));
  assert.equal(await pEsc, false);
  assert.equal(modal.classList.contains('show'), false);
});

test('public/*.html asset references exist on disk and contain required UI DOM IDs without javascript: links', () => {
  const pubDir = path.join(ROOT, 'public');
  const htmlFiles = fs.readdirSync(pubDir).filter(f => f.endsWith('.html'));
  assert.ok(htmlFiles.length >= 5);

  let combinedHtml = '';
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(pubDir, file), 'utf8');
    combinedHtml += `\n<!-- ${file} -->\n${html}`;
    assert.equal(/href\s*=\s*["']\s*javascript:/i.test(html), false, `${file} must not contain javascript: href`);

    for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const ref = m[1].split('?')[0].split('#')[0];
      if (!ref || ref.startsWith('http') || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('#')) continue;
      const diskPath = path.join(pubDir, ref.replace(/^\/+/, ''));
      assert.equal(fs.existsSync(diskPath), true, `${file} references missing local asset: ${ref}`);
    }
  }

  for (const requiredId of [
    'simple-confirm-modal',
    'saved-exam-search-input',
    'btn-submit-multi',
    'hm-ai-weakness-body',
    'dash-ai-weakness-body',
    'btn-open-ai-gen',
    'share-warning-modal',
  ]) {
    assert.ok(
      combinedHtml.includes(`id="${requiredId}"`) || combinedHtml.includes(`id='${requiredId}'`),
      `Missing expected DOM id #${requiredId} across public/*.html`
    );
  }
});
