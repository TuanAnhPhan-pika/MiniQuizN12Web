const fs = require('node:fs');
const path = require('node:path');
const { browser } = require('./browser.cjs');
const { root } = require('./load.cjs');
const { VirtualConsole } = require('jsdom');
async function page(t, name, overrides = {}, options = {}) {
  const b = browser(fs.readFileSync(path.join(root, 'public', (name === 'home' ? 'index' : name) + '.html'), 'utf8'), {
    url: options.url || 'https://quiz.test/' + name + '.html?pin=246-579&nick=Student&av=01', virtualConsole: new VirtualConsole(),
  });
  t.after(() => b.close()); const w = b.window;
  const calls = [], alerts = [], timers = new Map(); let timerId = 0;
  w.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms, repeat: false }); return timerId; };
  w.setInterval = (fn, ms) => { timers.set(++timerId, { fn, ms, repeat: true }); return timerId; };
  w.clearTimeout = w.clearInterval = id => timers.delete(id);
  w.alert = value => alerts.push(value); w.confirm = () => false;
  w.document.execCommand = () => true;
  w.QRCode = class { static CorrectLevel = { H: 2 }; clear() {} makeCode() {} };
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const question = { id: 'q1', text: '1 + 1?', choices: ['2', '3'], correct: 0, timeLimit: 15 };
  const room = { pin: '246-579', name: 'Test Room', title: 'Test Room', hostUsername: 'teacher', capacity: 40,
    questions: [question], players: [{ id: 'host', nick: 'Host', isHost: true }, { id: 'student', nick: 'Student', score: 100 }], status: 'waiting', phase: 'question', timePerQ: 15 };
  const routes = {
    '/api/auth/me': { authenticated: true, token: 'test-token', username: 'teacher', displayName: 'Teacher', user: { username: 'teacher', displayName: 'Teacher', role: 'teacher' } },
    '/api/server-info': { publicUrl: 'https://quiz.test' },
    '/api/storage/private': { success: true, exams: [{ id: 'exam1', title: 'Test Quiz', questions: [question] }] },
    '/api/storage/public': { exams: [] }, '/api/history': { history: [] }, '/api/history/hosted': { rooms: [], history: [] },
    '/api/rooms/246-579': { success: true, room },
    '/api/rooms/246-579?check=1': { success: true, room },
    '/api/rooms/246-579/join': { success: true, title: room.title, players: room.players, player: { id: 'student', playerToken: 'test-player-token' }, status: 'waiting' },
    '/api/rooms/246-579/question-stats?q=0': { success: true, totalAnswered: 0, totalCandidates: 1, choicesCount: [0, 0] },
    '/api/rooms/246-579/status': { success: true, players: room.players, status: 'waiting', title: room.title },
    '/api/rooms/246-579/leaderboard': { success: true, leaderboard: [{ id: 'student', nick: 'Student', score: 100 }] },
    ...overrides,
  };
  w.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    const value = routes[String(url)];
    if (value instanceof Error) throw value;
    const body = typeof value === 'function' ? await value(init) : value ?? { success: true };
    return { ok: !body.httpStatus || body.httpStatus < 400, status: body.httpStatus || 200, json: async () => body };
  };
  b.run('public/js/storage.js'); b.run('public/js/auth-client.js'); b.run('public/js/ai-weakness-ui.js');
  for (const [key, value] of Object.entries(options.localStorage || {})) w.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(options.sessionStorage || {})) w.sessionStorage.setItem(key, value);
  b.run('public/js/' + name + '.js');
  async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
  await settle();
  return { ...b, calls, alerts, routes, room, settle, async tick(ms) {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) {
      if (!timer.repeat) timers.delete(id);
      await timer.fn();
    }
    await settle();
  } };
}
module.exports = { page };
