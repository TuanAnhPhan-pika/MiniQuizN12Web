const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIsolatedModule } = require('../helpers/test-server.js');

/**
 * Nạp src/rooms/manager.js độc lập hoàn toàn với DB thật (stub lưu trữ bất đồng bộ).
 */
function createPureRoomManager() {
  return loadIsolatedModule('src/rooms/manager.js', {
    '../db/index.js': {
      createWaitingGameSession: async () => {},
      saveHostedGameSession: async () => {},
    },
  });
}

const SAMPLE_EXAM = {
  id: 'exam-unit-1',
  title: 'Đề Unit Test',
  questions: [
    {
      id: 'q1',
      text: '2 + 2 = ?',
      choices: ['3', '4', '5', '6'],
      correct: 1,
      points: 100,
      timeLimit: 20,
    },
  ],
};

test('TC-07 [Unit][Phân vùng tương đương] getCorrectChoices chuẩn hóa câu nhiều đáp án và lọc chỉ số ngoài biên', () => {
  const rm = createPureRoomManager();
  const question = {
    text: 'Chọn số chẵn',
    choices: ['2', '3', '4', '5'],
    correctChoices: [2, 0, 2, 99, -1],
  };

  assert.deepEqual(Array.from(rm.getCorrectChoices(question)), [0, 2]);
  assert.equal(rm.isMultiChoiceQuestion(question), true);
});

test('TC-08 [Unit][Giá trị biên] addPlayer từ chối thí sinh vượt sức chứa phòng (capacity = 1)', async () => {
  const rm = createPureRoomManager();
  const room = await rm.createRoom({
    hostUsername: 'host_unit',
    exam: SAMPLE_EXAM,
    capacity: 1,
    isLocked: false,
    title: 'Phòng biên 1 người',
  });

  const first = rm.addPlayer(room.pin, { nick: 'An' });
  assert.equal(first.success, true, 'Thí sinh đầu tiên phải tham gia thành công');
  assert.ok(first.player.playerToken, 'Thí sinh đầu tiên phải nhận được playerToken');

  const second = rm.addPlayer(room.pin, { nick: 'Bình' });
  assert.equal(second.success, false, 'Thí sinh thứ 2 khi phòng đầy phải bị từ chối');
  assert.equal(second.full, true, 'Phải trả cờ full: true');
  const candidates = rm.getRawRoom(room.pin).players.filter(p => !p.isHost);
  assert.equal(candidates.length, 1, 'Danh sách phòng vẫn chỉ được giữ 1 thí sinh');
});

test('TC-09 [Unit][Bảng quyết định] submitAnswer chặn lựa chọn vượt biên, chấm đúng 1 lần và chống nộp trùng', async () => {
  const rm = createPureRoomManager();
  const room = await rm.createRoom({
    hostUsername: 'host_unit',
    exam: SAMPLE_EXAM,
    capacity: 5,
    title: 'Phòng chấm điểm',
  });
  const joined = rm.addPlayer(room.pin, { nick: 'Chi' });
  rm.startRoom(room.pin, 1);

  // Lần 1: vượt biên trên (chỉ có 4 đáp án 0..3, gửi 4)
  const outOfRange = rm.submitAnswer(room.pin, {
    playerId: joined.player.id,
    playerToken: joined.player.playerToken,
    qIdx: 0,
    choice: 4,
  });
  assert.equal(outOfRange.success, false);
  assert.equal(outOfRange.invalidChoice, true);

  // Lần 2: đáp án đúng (1)
  const accepted = rm.submitAnswer(room.pin, {
    playerId: joined.player.id,
    playerToken: joined.player.playerToken,
    qIdx: 0,
    choice: 1,
  });
  assert.equal(accepted.success, true);
  assert.equal(accepted.answerAccepted, true);
  // Kiểm tra điểm qua góc nhìn Host (isHost=true) vì trong phase 'question' hệ thống ẩn điểm tạm với thí sinh
  const scoreAfterFirst = rm.getLeaderboard(room.pin, true)[0].score;
  assert.ok(scoreAfterFirst > 0, `Điểm sau khi trả lời đúng phải > 0 (thực tế: ${scoreAfterFirst})`);

  // Lần 3: nộp trùng cùng câu 0
  const dup = rm.submitAnswer(room.pin, {
    playerId: joined.player.id,
    playerToken: joined.player.playerToken,
    qIdx: 0,
    choice: 1,
  });
  assert.equal(dup.success, false);
  assert.equal(dup.duplicate, true);
  assert.equal(rm.getLeaderboard(room.pin, true)[0].score, scoreAfterFirst, 'Nộp trùng không được cộng thêm điểm');
});

test('TC-19 [Unit][Bảng quyết định] submitAnswer chấm câu nhiều đáp án All-or-Nothing (thiếu đáp án = 0 điểm, đủ không kể thứ tự = cộng điểm)', async () => {
  const rm = createPureRoomManager();
  const multiExam = {
    id: 'exam-multi',
    title: 'Đề nhiều đáp án',
    questions: [
      {
        id: 'qm1',
        text: 'Chọn các số chẵn',
        choices: ['2', '3', '4', '5'],
        isMultiple: true,
        correctChoices: [0, 2],
        points: 100,
        timeLimit: 20,
      },
    ],
  };

  const room = await rm.createRoom({ hostUsername: 'host_m', exam: multiExam, capacity: 5, title: 'Phòng Multi' });
  const pPartial = rm.addPlayer(room.pin, { nick: 'ThieuDapAn' });
  const pFull = rm.addPlayer(room.pin, { nick: 'DuDapAn' });
  rm.startRoom(room.pin, 1);

  // Chọn thiếu [0] -> phải tính sai (0 điểm)
  const resPartial = rm.submitAnswer(room.pin, {
    playerId: pPartial.player.id,
    playerToken: pPartial.player.playerToken,
    qIdx: 0,
    choices: [0],
  });
  assert.equal(resPartial.success, true);

  // Chọn đủ nhưng ngược thứ tự [2, 0] -> phải tính đúng (> 0 điểm)
  const resFull = rm.submitAnswer(room.pin, {
    playerId: pFull.player.id,
    playerToken: pFull.player.playerToken,
    qIdx: 0,
    choices: [2, 0],
  });
  assert.equal(resFull.success, true);

  const lb = rm.getLeaderboard(room.pin, true);
  const fullEntry = lb.find(p => p.nick === 'DuDapAn');
  const partialEntry = lb.find(p => p.nick === 'ThieuDapAn');
  assert.ok(fullEntry.score > 0, 'Chọn đủ đáp án đúng (kể cả khác thứ tự) phải được cộng điểm');
  assert.equal(partialEntry.score, 0, 'Chọn thiếu đáp án theo luật All-or-Nothing phải được 0 điểm');
});

test('TC-20 [Unit][Chuyển trạng thái] Khóa phòng chặn thí sinh mới và chặn giả mạo trùng nickname không có playerToken', async () => {
  const rm = createPureRoomManager();
  const room = await rm.createRoom({ hostUsername: 'host_lock', exam: SAMPLE_EXAM, capacity: 5, title: 'Phòng Khóa' });

  const p1 = rm.addPlayer(room.pin, { nick: 'Minh' });
  assert.equal(p1.success, true);

  // Thí sinh khác cố dùng trùng nickname mà không có token cũ -> bị từ chối
  const spoof = rm.addPlayer(room.pin, { nick: 'minh' });
  assert.equal(spoof.success, false, 'Trùng nickname không có token hợp lệ phải bị từ chối');

  // Host khóa phòng -> thí sinh mới bị chặn với locked: true
  rm.setRoomLock(room.pin, true);
  const blocked = rm.addPlayer(room.pin, { nick: 'Trang' });
  assert.equal(blocked.success, false);
  assert.equal(blocked.locked, true, 'Phòng đang khóa phải trả cờ locked: true');
});

test('TC-21 [Unit][Đoán lỗi] createRoom chuẩn hóa sức chứa âm/vượt 500 và submitAnswer chặn phòng đang waiting ở tầng lõi', async () => {
  const rm = createPureRoomManager();
  const room = await rm.createRoom({
    hostUsername: 'host_neg',
    exam: SAMPLE_EXAM,
    capacity: -5,
    title: 'Phòng sức chứa âm',
  });

  assert.ok(
    room.capacity >= 1,
    `BUG-04: createRoom chấp nhận và lưu capacity âm (${room.capacity}) thay vì từ chối hoặc chuẩn hóa >= 1`
  );
  const capped = await rm.createRoom({ hostUsername: 'host_cap', exam: SAMPLE_EXAM, capacity: 999, title: 'Phòng vượt ngưỡng' });
  assert.equal(capped.capacity, 500, 'Sức chứa vượt 500 ở tầng lõi phải được giới hạn ở 500');

  const p = rm.addPlayer(room.pin, { nick: 'Waiter' }).player;
  const early = rm.submitAnswer(room.pin, { playerId: p.id, playerToken: p.playerToken, qIdx: 0, choice: 1 });
  assert.equal(early.success, false);
  assert.equal(early.rejected, true);
  assert.equal(rm.getRawRoom(room.pin).status, 'waiting', 'Gọi thẳng submitAnswer khi phòng waiting không được tự start phòng');
});
