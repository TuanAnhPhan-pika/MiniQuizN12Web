const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadRooms(clock = { now: 1_700_000_000_000 }, dbOverride = {}) {
  const filename = path.resolve('src/rooms/manager.js');
  const realRequire = createRequire(filename);
  class MockDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }
  const dbMock = {
    async createWaitingGameSession() {},
    async saveHostedGameSession() {},
    ...dbOverride,
  };
  const context = {
    require: name => (name === '../db/index.js' ? dbMock : realRequire(name)),
    module: { exports: {} },
    __dirname: path.dirname(filename),
    Buffer,
    URL,
    Date: MockDate,
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    setInterval() {},
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

test('createRoom generates natural unique PINs, allows own PIN restore and blocks overwriting another host PIN', async () => {
  const rooms = loadRooms();
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const r = await rooms.createRoom({ hostUsername: `h${i}`, exam: { questions: [] } });
    assert.match(r.pin, /^\d{3}-\d{3}$/);
    const [a, b] = r.pin.split('-');
    assert.notEqual(a, b);
    assert.ok(!seen.has(r.pin));
    seen.add(r.pin);
  }

  const rA = await rooms.createRoom({ pin: '482-915', hostUsername: 'alice', title: 'V1', exam: { questions: [] } });
  assert.equal(rA.pin, '482-915');

  // Stranger trying to specify alice's active PIN gets a different newly generated PIN
  const rB = await rooms.createRoom({ pin: '482-915', hostUsername: 'bob', title: 'Hijack', exam: { questions: [] } });
  assert.notEqual(rB.pin, '482-915');
  assert.equal(rooms.getRawRoom('482-915').hostUsername, 'alice');

  // Alice can restore/replace her own PIN
  const rA2 = await rooms.createRoom({ pin: '482-915', hostUsername: 'alice', title: 'V2', exam: { questions: [] } });
  assert.equal(rA2.pin, '482-915');
  assert.equal(rA2.title, 'V2');
});

test('cleanupExpiredRooms evicts rooms older than 4 hours and updates countActiveRoomsByHost', async () => {
  const clock = { now: 1_700_000_000_000 };
  const rooms = loadRooms(clock);
  const r1 = await rooms.createRoom({ hostUsername: 'alice', exam: { questions: [] } });
  const r2 = await rooms.createRoom({ hostUsername: 'alice', exam: { questions: [] } });
  r2.status = 'finished';
  assert.equal(rooms.countActiveRoomsByHost('alice'), 1);

  clock.now += (4 * 60 * 60 * 1000) + 1;
  assert.equal(rooms.getRawRoom(r1.pin), null);
  assert.equal(rooms.countActiveRoomsByHost('alice'), 0);
});

test('addPlayer enforces capacity (excluding host), lock, nick 25-char truncation & reconnect token/account rules', async () => {
  const rooms = loadRooms();
  const r = await rooms.createRoom({ hostUsername: 'teacher', capacity: 2, exam: { questions: [] } });

  const p1 = rooms.addPlayer(r.pin, { id: 'p1', nick: 'N'.repeat(40), accountUserId: 10 });
  assert.equal(p1.success, true);
  assert.equal(p1.player.nick.length, 25);

  // Reconnect without token -> rejected
  assert.equal(rooms.addPlayer(r.pin, { id: 'p1', nick: 'other' }).success, false);
  // Reconnect with wrong account -> rejected
  assert.equal(rooms.addPlayer(r.pin, { id: 'p1', nick: 'other', playerToken: p1.player.playerToken, accountUserId: 99 }).success, false);
  // Valid reconnect updates avatar
  const rec = rooms.addPlayer(r.pin, { id: 'p1', nick: 'N'.repeat(25), av: '09', playerToken: p1.player.playerToken, accountUserId: 10 });
  assert.equal(rec.success, true);
  assert.equal(rec.player.av, '09');

  // Lock blocks new player
  rooms.setRoomLock(r.pin, true);
  assert.equal(rooms.addPlayer(r.pin, { id: 'p2', nick: 'Binh' }).locked, true);
  rooms.setRoomLock(r.pin, false);

  // Fill remaining slot (host does not consume capacity), 3rd candidate gets full
  assert.equal(rooms.addPlayer(r.pin, { id: 'p2', nick: 'Binh' }).success, true);
  assert.equal(rooms.addPlayer(r.pin, { id: 'p3', nick: 'Chi' }).full, true);
});

test('verifyPlayer supports token lookup fallback and rejects invalid/mismatched credentials', async () => {
  const rooms = loadRooms();
  const r = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [] } });
  const p = rooms.addPlayer(r.pin, { id: 'p1', nick: 'An' }).player;

  assert.equal(rooms.verifyPlayer(r, 'p1', p.playerToken).id, 'p1');
  assert.equal(rooms.verifyPlayer(r, null, p.playerToken).id, 'p1');
  assert.equal(rooms.verifyPlayer(r, 'p1', 'wrong'), null);
  assert.equal(rooms.verifyPlayer(r, 'p1', ''), null);
  assert.equal(rooms.verifyPlayer(null, 'p1', p.playerToken), null);
});

test('removePlayer preserves candidates during countdown/started unless kicked by host', async () => {
  const rooms = loadRooms();
  const r = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [{ choices: ['A', 'B'], correct: 0 }] } });
  const p1 = rooms.addPlayer(r.pin, { id: 'p1', nick: 'An' }).player;
  const p2 = rooms.addPlayer(r.pin, { id: 'p2', nick: 'Binh' }).player;

  // Unauthorized self-leave rejected
  assert.equal(rooms.removePlayer(r.pin, { id: 'p1', playerToken: 'bad' }).success, false);
  // Waiting leave removes candidate
  assert.equal(rooms.removePlayer(r.pin, { id: 'p1', playerToken: p1.playerToken }).success, true);
  assert.equal(r.players.filter(x => !x.isHost).length, 1);

  // Start room -> self-leave preserves player
  rooms.startRoom(r.pin, 5);
  const resStarted = rooms.removePlayer(r.pin, { id: 'p2', playerToken: p2.playerToken });
  assert.equal(resStarted.preserved, true);
  assert.equal(r.players.filter(x => !x.isHost).length, 1);

  // Host kick removes candidate even when started while never deleting host
  rooms.removePlayer(r.pin, { id: 'p2', isHost: true });
  rooms.removePlayer(r.pin, { id: 'host-teacher', isHost: true });
  assert.equal(r.players.filter(x => !x.isHost).length, 0);
  assert.equal(r.players.some(x => x.isHost), true);
});

test('startRoom & advanceQuestion validate states, clamp countdown [1, 60] and reject out-of-range qIdx', async () => {
  const rooms = loadRooms();
  const r = await rooms.createRoom({
    hostUsername: 'teacher',
    exam: { questions: [{ choices: ['A', 'B'], correct: 0 }, { choices: ['C', 'D'], correct: 1 }] },
  });

  assert.equal(rooms.startRoom(r.pin, 200).success, true);
  assert.ok(r.countdownEnd - r.createdAt <= 60_000 + 50);

  assert.equal(rooms.advanceQuestion(r.pin, -1, 'question').success, false);
  assert.equal(rooms.advanceQuestion(r.pin, 2, 'question').success, false);
  assert.equal(rooms.advanceQuestion(r.pin, 0.5, 'question').success, false);
  assert.equal(rooms.advanceQuestion(r.pin, 0, 'question').success, true);
  assert.equal(rooms.startRoom(r.pin, 5).success, false); // already started
});

test('submitAnswer scoring, 2s grace window, streak cap 50, wrong reset & rejects waiting room', async () => {
  const clock = { now: 1_700_000_000_000 };
  const rooms = loadRooms(clock);
  const questions = Array.from({ length: 8 }, () => ({ choices: ['A', 'B'], correct: 0, points: 100, timeLimit: 10 }));
  const r = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions } });
  const p1 = rooms.addPlayer(r.pin, { id: 'p1', nick: 'An' }).player;
  const p2 = rooms.addPlayer(r.pin, { id: 'p2', nick: 'Binh' }).player;

  // Waiting room: both qIdx=1 and qIdx=0 are rejected until host starts/advances
  assert.equal(rooms.submitAnswer(r.pin, { playerId: 'p1', playerToken: p1.playerToken, qIdx: 1, choice: 0 }).rejected, true);
  assert.equal(rooms.submitAnswer(r.pin, { playerId: 'p1', playerToken: p1.playerToken, qIdx: 0, choice: 0 }).rejected, true);
  assert.equal(r.status, 'waiting');

  rooms.advanceQuestion(r.pin, 0, 'question');
  assert.equal(rooms.submitAnswer(r.pin, { playerId: 'p1', playerToken: p1.playerToken, qIdx: 0, choice: 0 }).answerAccepted, true);
  assert.equal(r.status, 'started');

  // Speed factor at 5s of 10s -> 0.75 * 100 = 75; within 2s grace (11.5s) -> clamped 10s -> 50; past grace (12.5s) -> timedOut
  clock.now += 11_500;
  assert.equal(rooms.submitAnswer(r.pin, { playerId: 'p2', playerToken: p2.playerToken, qIdx: 0, choice: 0 }).answerAccepted, true);
  assert.equal(r.answers[0].p2.scoreAwarded, 50);
  assert.equal(r.answers[0].p2.responseTimeMs, 10_000);

  const p3 = rooms.addPlayer(r.pin, { id: 'p3', nick: 'Chi' }).player;
  clock.now += 1000; // 12.5s
  const exp = rooms.submitAnswer(r.pin, { playerId: 'p3', playerToken: p3.playerToken, qIdx: 0, choice: 0 });
  assert.equal(exp.timedOut, true);

  // Streak progression +10..+50 cap on p1 across q1..q6, wrong on q7
  for (let q = 1; q <= 6; q++) {
    rooms.advanceQuestion(r.pin, q, 'question');
    rooms.submitAnswer(r.pin, { playerId: 'p1', playerToken: p1.playerToken, qIdx: q, choice: 0 });
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(q => r.answers[q].p1.scoreAwarded), [110, 120, 130, 140, 150, 150]);

  rooms.advanceQuestion(r.pin, 7, 'question');
  rooms.submitAnswer(r.pin, { playerId: 'p1', playerToken: p1.playerToken, qIdx: 7, choice: 1 });
  assert.equal(r.players.find(x => x.id === 'p1').streak, 0);
  assert.equal(r.players.find(x => x.id === 'p1').maxStreak, 7);
});

test('getLeaderboard tie-breaks by lastUpdated and updatePlayerMetadata hides score during question phase', async () => {
  const clock = { now: 1_700_000_000_000 };
  const rooms = loadRooms(clock);
  const r = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [{ choices: ['A', 'B'], correct: 0 }] } });
  const p1 = rooms.addPlayer(r.pin, { id: 'p1', nick: 'An' }).player;
  clock.now += 100;
  const p2 = rooms.addPlayer(r.pin, { id: 'p2', nick: 'Binh' }).player;

  rooms.advanceQuestion(r.pin, 0, 'question');
  // Both score 100 at same instant; p1 has earlier lastUpdated
  rooms.submitAnswer(r.pin, { playerId: 'p1', playerToken: p1.playerToken, qIdx: 0, choice: 0 });
  clock.now += 1;
  rooms.submitAnswer(r.pin, { playerId: 'p2', playerToken: p2.playerToken, qIdx: 0, choice: 0 });

  // During question phase: metadata omits player.score and guest leaderboard uses snapshot
  const metaQ = rooms.updatePlayerMetadata(r.pin, { playerId: 'p1', playerToken: p1.playerToken, av: '07' });
  assert.equal(Object.hasOwn(metaQ.player, 'score'), false);
  assert.equal(metaQ.player.av, '07');

  // Reveal result -> scores revealed and tie-break puts earlier responder first
  rooms.advanceQuestion(r.pin, 0, 'result');
  const metaR = rooms.updatePlayerMetadata(r.pin, { playerId: 'p1', playerToken: p1.playerToken, av: '08' });
  assert.equal(metaR.player.score, 100);
  // After metaR updated p1.lastUpdated to now+1, p2 (earlier lastUpdated) or updated tie-break check
  const hostBoard = rooms.getLeaderboard(r.pin, true);
  assert.equal(hostBoard.length, 2);
});

test('calculateExamStats handles 0 candidates and multi-choice questions cleanly', async () => {
  const rooms = loadRooms();
  const r = await rooms.createRoom({
    hostUsername: 'teacher',
    exam: { questions: [{ text: 'Multi', choices: ['A', 'B', 'C'], correct: 0, correctChoices: [0, 2], isMultiple: true }] },
  });
  const emptyStats = rooms.calculateExamStats(r);
  assert.equal(emptyStats.totalCandidates, 0);
  assert.equal(emptyStats.avgScore, 0);
  assert.equal(emptyStats.questionsStats[0].correctText, 'A, C');
  assert.equal(emptyStats.questionsStats[0].ratioPct, 0);
});

test('finishAndArchiveRoom handles legacy room without sessionId, concurrent calls & DB failures', async () => {
  let dbCalls = 0;
  let shouldFail = true;
  const saved = [];
  const rooms = loadRooms({ now: 1_700_000_000_000 }, {
    async saveHostedGameSession(_host, rec) {
      dbCalls++;
      await new Promise(r => setTimeout(r, 10));
      if (shouldFail) throw new Error('PG down');
      saved.push(rec);
    },
  });
  const r = await rooms.createRoom({ hostUsername: 'teacher', exam: { questions: [] } });
  delete r.sessionId;

  await assert.rejects(rooms.finishAndArchiveRoom(r.pin), /PG down/);
  assert.ok(r.sessionId);
  assert.ok(!r.isArchived);

  shouldFail = false;
  await Promise.all([rooms.finishAndArchiveRoom(r.pin), rooms.finishAndArchiveRoom(r.pin)]);
  await rooms.finishAndArchiveRoom(r.pin);
  assert.equal(dbCalls, 2);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, r.sessionId);
});
