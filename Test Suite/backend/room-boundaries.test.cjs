const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load.cjs');
async function setup(db = {}) {
  const api = load('src/rooms/manager.js', { '../db/index.js': { createWaitingGameSession: async () => {}, saveHostedGameSession: async () => {}, ...db } });
  const room = await api.createRoom({ pin: '246-579', hostUsername: 'teacher', exam: { id: 'e', questions: [{ choices: ['A', 'B'], correct: 0 }] } });
  const joined = api.addPlayer(room.pin, { id: 'player', nick: 'Student', av: '', accountUserId: 1 });
  return { api, room, player: joined.player };
}
test('room: missing-room operations return failure without affecting active rooms', async () => {
  const { api } = await setup();
  for (const result of [api.addPlayer('missing', {}), api.removePlayer('missing', {}), api.setRoomLock('missing', true),
    api.startRoom('missing'), api.advanceQuestion('missing', 0), api.submitAnswer('missing', {}), api.updatePlayerMetadata('missing', {})]) assert.equal(result.success, false);
  assert.equal(api.getRoomForClient('missing'), null); assert.equal(api.getLeaderboard('missing').length, 0);
  assert.equal(await api.finishAndArchiveRoom('missing'), null); assert.equal(api.sanitizePlayer(null), null);
  assert.equal(api.verifyPlayer(null, 'x', 'token'), null);
});
for (const question of [null, {}, { correct: -1 }, { correct: 0.5 }, { correct: 1 }, { choices: ['A'], correct: 1 },
  { correctChoices: [-1, 99, 'bad'], choices: ['A'], correct: 0 }, { correctChoices: [1, 0, 1] }]) {
  test('room: correct answer normalization ' + JSON.stringify(question), async () => {
    const { api } = await setup(); const result = api.getCorrectChoices(question);
    assert.ok(result.every(n => Number.isInteger(n) && n >= 0));
    assert.equal(new Set(result).size, result.length);
    if (!question) assert.equal(api.isMultiChoiceQuestion(question), false);
  });
}
test('room: validates tokens, preserves account binding and missing avatars on reconnect', async () => {
  const { api, room, player } = await setup();
  for (const token of ['', 123, 'short', 'x'.repeat(player.playerToken.length)]) assert.equal(api.verifyPlayer(room, player.id, token), null);
  assert.equal(api.verifyPlayer(room, 'unknown', player.playerToken).id, player.id);
  assert.equal(api.verifyPlayer({ players: [{ id: 'x' }] }, 'x', 'token'), null);
  const reconnect = api.addPlayer(room.pin, { nick: 'other', playerToken: player.playerToken, av: null });
  assert.equal(reconnect.success, true); assert.equal(reconnect.player.av, '01');
  assert.equal(api.addPlayer(room.pin, { id: player.id, nick: 'Student', playerToken: player.playerToken, accountUserId: 2 }).success, false);
  assert.equal(api.removePlayer(room.pin, { id: 'unknown', playerToken: 'bad' }).success, false);
  assert.equal(api.removePlayer(room.pin, {}).success, false);
  assert.equal(api.updatePlayerMetadata(room.pin, { playerId: 'unknown', playerToken: 'bad' }).unauthorized, true);
  room.phase = 'result'; assert.equal(api.updatePlayerMetadata(room.pin, { playerId: player.id, playerToken: player.playerToken }).player.score, 0);
});
for (const mode of ['finished', 'result', 'wrong-question', 'missing-question', 'invalid-choices', 'empty-multi', 'bad-multi', 'bad-single', 'no-answer-key', 'countdown', 'legacy-timing']) {
  test('room: submission guards ' + mode, async () => {
    const { api, room, player } = await setup(); room.status = 'started';
    let qIdx = 0, choice = 0, choices;
    if (mode === 'finished') room.status = 'finished';
    if (mode === 'result') room.phase = 'result';
    if (mode === 'wrong-question') qIdx = 1;
    if (mode === 'missing-question') room.questions = [];
    if (mode === 'invalid-choices') room.questions = [{}];
    if (mode === 'empty-multi') choices = [];
    if (mode === 'bad-multi') choices = [0, 0.5, -1, 99];
    if (mode === 'bad-single') choice = 'invalid';
    if (mode === 'no-answer-key') room.questions[0].correct = undefined;
    if (mode === 'countdown') { room.status = 'countdown'; room.phaseStartedAt = 0; room.questionStartedAt = 0; }
    if (mode === 'legacy-timing') { room.answers = null; room.scoreSnapshots = null; room.questionStartedAt = 0; room.phaseStartedAt = 0; }
    const result = api.submitAnswer(room.pin, { playerId: player.id, playerToken: player.playerToken, qIdx, choice, choices });
    assert.equal(result.success, ['no-answer-key', 'countdown', 'legacy-timing'].includes(mode));
    if (mode === 'no-answer-key') assert.equal(room.players.find(p => p.id === player.id).score, 0);
  });
}
test('room: failed replacement restores prior room and failed new room releases reservation', async () => {
  let fail = false;
  const { api, room } = await setup({ createWaitingGameSession: async () => { if (fail) throw new Error('database unavailable'); } });
  fail = true;
  await assert.rejects(api.createRoom({ pin: room.pin, hostUsername: 'teacher', exam: {} }), /database unavailable/);
  assert.equal(api.getRawRoom(room.pin), room);
  await assert.rejects(api.createRoom({ pin: '345-678', hostUsername: 'teacher', exam: {} }), /database unavailable/);
  assert.equal(api.getRawRoom('345-678'), null);
});
test('room: sparse legacy players and empty statistics have stable defaults', async () => {
  const { api, room } = await setup();
  room.players = [{ id: 'a', nick: 'A' }, { id: 'b', nick: 'B' }]; room.questions = [{ correct: 0 }, { isMultiple: true }];
  room.phase = 'result'; room.answers = { 0: { a: { playerId: 'a', isCorrect: true }, duplicate: { playerId: 'a', isCorrect: true }, invalid: {} } };
  let stats = api.calculateExamStats(room);
  assert.equal(stats.questionsStats[0].correctCount, 1); assert.equal(stats.totalCandidates, 2);
  assert.equal(api.getLeaderboard(room.pin).length, 2);
  room.players = undefined; room.questions = undefined; room.answers = undefined;
  stats = api.calculateExamStats(room); assert.equal(stats.questionsStats.length, 0);
  assert.equal(api.getRoomForClient(room.pin).questions.length, 0);
});
