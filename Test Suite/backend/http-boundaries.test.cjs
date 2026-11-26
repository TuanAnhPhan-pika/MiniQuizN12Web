const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServerHarness } = require('../helpers/http.cjs');
async function request(h, path, body, token = 'alice', method) {
  const res = await fetch(h.base + path, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
test('HTTP: database failures return controlled errors on storage and history routes', async t => {
  const h = await makeServerHarness(t);
  for (const method of ['getPrivateQuizzes', 'getPublicQuizzes', 'saveQuiz', 'deleteQuiz', 'getUserAttempts', 'getHostedGameSessions']) {
    h.db[method] = async () => { throw new Error('database unavailable'); };
  }
  for (const [path, body, method] of [
    ['/api/storage/private'], ['/api/storage/public'], ['/api/history'], ['/api/history/hosted'],
    ['/api/storage/private', { title: 'Quiz', questions: [{ text: 'Q1', choices: ['A', 'B'], correct: 0 }] }], ['/api/storage/private/exam1', undefined, 'DELETE'],
  ]) {
    const res = await request(h, path, body, 'alice', method);
    assert.equal(res.status, 500, path); assert.equal(res.body.success, false);
  }
});
test('HTTP: invalid room payloads and unknown rooms are rejected', async t => {
  const h = await makeServerHarness(t);
  for (const body of [null, [], 'text', 123, {}, { name: ' ' }, { name: 'Room', examId: 'unknown' }]) {
    const res = await request(h, '/api/rooms', body);
    assert.equal(res.status, body && body.examId ? 403 : 400);
  }
  const fallback = await request(h, '/api/rooms', { name: 'Room', examId: 'unknown', questions: [{ text: 'Q', choices: ['A', 'B'], correct: 0 }] });
  assert.equal(fallback.status, 200); assert.equal(fallback.body.room.questions.length, 1);
  assert.equal((await request(h, '/api/history/hosted', {})).status, 400);
  assert.equal((await request(h, '/api/history/hosted', { pin: 'missing' })).status, 404);
  assert.equal((await request(h, '/api/rooms/missing', undefined, 'alice', 'DELETE')).status, 404);
});
test('HTTP: question statistics deduplicate legacy answers and filter invalid choices', async t => {
  const h = await makeServerHarness(t);
  const room = await h.rooms.createRoom({ pin: '246-579', hostUsername: 'alice', exam: { questions: [{ choices: ['A', 'B'], correct: 0 }] } });
  room.answers = { 0: {
    one: { playerId: 'p1', choices: [0, 1, -1, 2, 0.5] }, duplicate: { playerId: 'p1', choices: [0] },
    legacy: { nick: 'Legacy', choice: 1 }, missing: {}, empty: { playerId: 'empty' },
  } };
  let res = await request(h, '/api/rooms/246-579/question-stats?q=0');
  assert.equal(res.status, 200); assert.deepEqual(res.body.choicesCount, [1, 2]); assert.equal(res.body.totalAnswered, 3);
  res = await request(h, '/api/rooms/246-579/question-stats?q=999'); assert.equal(res.body.choicesCount.length, 4);
  room.status = 'countdown'; room.countdownEnd = Date.now() - 1;
  res = await request(h, '/api/rooms/246-579/status'); assert.equal(res.body.status, 'started');
  room.status = 'countdown'; room.countdownEnd = Date.now() + 10000;
  res = await request(h, '/api/rooms/246-579/status'); assert.ok(res.body.countdown > 0);
  room.status = null; room.players = undefined;
  res = await request(h, '/api/rooms/246-579/status'); assert.equal(res.body.status, 'waiting'); assert.deepEqual(res.body.players, []);
  res = await request(h, '/api/rooms/246-579/state'); assert.equal(res.status, 200);
});
