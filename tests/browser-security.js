const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
function load(file, overrides = {}, tail = '', env = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const context = { require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename), Buffer, URL,
    process: { env, exit() { throw new Error('Unexpected startup'); } },
    console, setInterval() {}, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, '') + tail, context, { filename });
  return context.module.exports;
}
(async () => {
  const rooms = load('src/rooms/manager.js', { '../db/index.js': { async saveHostedGameSession() {} } });
  const room = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [
    { text: 'Browser Q1', choices: ['Wrong A', 'Correct B'], correct: 1, explanation: 'Explanation B' },
    { text: 'Browser Q2', choices: ['Correct C', 'Wrong D'], correct: 0 },
  ] } });
  const players = ['a', 'b'].map(id => rooms.addPlayer(room.pin, { id, nick: id }).player);
  rooms.advanceQuestion(room.pin, 0, 'question');
  const env = {};
  const { server } = load('src/server.js', { dotenv: { config() {} }, './auth.js': {
    parseCookies: () => ({}), getSession: () => null }, './db/index.js': {}, './db/migrate.js': {},
    './rooms/manager.js': rooms }, '\nmodule.exports = { server };', env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  env.APP_URL = base;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
    const pages = [];
    for (const player of players) {
      const context = await browser.newContext();
      await context.addInitScript(({ pin, player }) => {
        sessionStorage.setItem('mqc_my_player_id_' + pin, player.id);
        sessionStorage.setItem('mqc_my_player_token_' + pin, player.playerToken);
      }, { pin: room.pin, player });
      const page = await context.newPage();
      page.on('pageerror', error => console.error('PAGE ERROR', error.message));
      await page.goto(`${base}/room.html?pin=${room.pin}&nick=${player.id}`);
      await page.waitForSelector('.choice-btn');
      pages.push(page);
    }
    await pages[0].locator('.choice-btn').nth(1).click();
    await pages[0].waitForFunction(() => document.getElementById('question-meta').textContent === '\u0110\u00e3 ghi nh\u1eadn \u0111\u00e1p \u00e1n');
    assert.equal(await pages[0].locator('.choice-btn.correct, .choice-btn.wrong, .choice-btn.reveal-correct').count(), 0);
    assert.equal(await pages[0].locator('#total-score').textContent(), '0');
    const hiddenBoard = await (await pages[1].request.get(`${base}/api/rooms/${room.pin}/leaderboard`)).json();
    assert.ok(hiddenBoard.leaderboard.every(player => player.score === 0 && player.streak === 0));
    const actualA = rooms.getRawRoom(room.pin).players.find(player => player.id === 'a');
    assert.ok(actualA.score > 0);
    assert.equal(actualA.streak, 1);
    assert.equal(await pages[0].locator('.choice-btn:enabled').count(), 0);
    assert.equal(await pages[1].locator('.choice-btn:enabled').count(), 2);
    assert.equal((await pages[1].request.get(`${base}/api/rooms/${room.pin}/result?q=0`)).status(), 403);
    await pages[0].evaluate(() => { ticksElapsed = TIMER_SECS * 2; });
    await pages[0].waitForTimeout(600);
    assert.equal(await pages[0].locator('.choice-btn.correct, .choice-btn.reveal-correct').count(), 0);
    // Even a stale cached question with its answer and an expired client timer cannot reveal.
    await pages[0].evaluate(() => { QUESTIONS[0].correct = 1; revealAndShow(); });
    assert.equal(await pages[0].locator('.choice-btn.correct, .choice-btn.reveal-correct').count(), 0);
    // All players answered is still not permission to reveal.
    await pages[1].locator('.choice-btn').nth(0).click();
    await pages[1].waitForFunction(() => document.getElementById('question-meta').textContent === '\u0110\u00e3 ghi nh\u1eadn \u0111\u00e1p \u00e1n');
    await pages[0].waitForTimeout(700);
    assert.equal(await pages[0].locator('.choice-btn.correct, .choice-btn.reveal-correct').count(), 0);
    assert.equal(await pages[0].locator('#total-score').textContent(), '0');
    assert.equal(await pages[1].locator('#total-score').textContent(), '0');
    const beforeResult = await (await pages[1].request.get(`${base}/api/rooms/${room.pin}/leaderboard`)).json();
    assert.ok(beforeResult.leaderboard.every(player => player.score === 0 && player.streak === 0));
    rooms.advanceQuestion(room.pin, 0, 'result');
    await pages[0].waitForSelector('.choice-btn.correct');
    await pages[1].waitForSelector('.choice-btn.reveal-correct');
    await pages[1].waitForSelector('.choice-btn.wrong');
    await pages[0].waitForSelector('#result-panel.show');
    assert.match(await pages[0].locator('#result-title').textContent(), /Explanation B/);
    assert.match(await pages[0].locator('#result-total').textContent(), /1$/);
    assert.equal(await pages[0].locator('#total-score').textContent(), String(actualA.score));
    await pages[1].waitForSelector('#result-panel.show');
    assert.equal(await pages[1].locator('#total-score').textContent(), '0');
    const board = await (await pages[1].request.get(`${base}/api/rooms/${room.pin}/leaderboard`)).json();
    assert.equal(board.leaderboard.find(player => player.id === 'a').score, actualA.score);
    assert.equal(board.leaderboard.find(player => player.id === 'a').streak, 1);
    assert.equal(board.leaderboard.find(player => player.id === 'b').streak, 0);
    const ownA = await (await pages[0].request.get(`${base}/api/rooms/${room.pin}/result?q=0&playerId=a`, { headers: { 'X-Player-Token': players[0].playerToken } })).json();
    assert.equal(ownA.playerResult.totalScore, actualA.score);
    assert.equal(ownA.playerResult.isCorrect, true);
    assert.equal((await pages[1].request.get(`${base}/api/rooms/${room.pin}/result?q=0&playerId=a`, { headers: { 'X-Player-Token': players[1].playerToken } })).status(), 403);
    rooms.advanceQuestion(room.pin, 1, 'question');
    for (const page of pages) {
      await page.waitForFunction(() => document.getElementById('question-text').textContent === 'Browser Q2');
      assert.equal(await page.locator('.choice-btn.correct, .choice-btn.wrong, .choice-btn.reveal-correct').count(), 0);
      assert.equal(await page.locator('.choice-btn:enabled').count(), 2);
    }
    await pages[0].locator('.choice-btn').nth(0).click();
    await pages[0].waitForFunction(() => document.getElementById('question-meta').textContent === '\u0110\u00e3 ghi nh\u1eadn \u0111\u00e1p \u00e1n');
    assert.equal(await pages[0].locator('#total-score').textContent(), String(ownA.playerResult.totalScore));
    const nextBoard = await (await pages[1].request.get(`${base}/api/rooms/${room.pin}/leaderboard`)).json();
    assert.equal(nextBoard.leaderboard.find(player => player.id === 'a').score, ownA.playerResult.totalScore);
    assert.equal(nextBoard.leaderboard.find(player => player.id === 'a').streak, 1);
    await rooms.finishAndArchiveRoom(room.pin);
    for (const page of pages) await page.waitForSelector('#final-panel.show');
    console.log('PASS: two-player browser submit/wait/result/next/finished; stale-cache/allAnswered gates and delayed score/streak visibility.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
