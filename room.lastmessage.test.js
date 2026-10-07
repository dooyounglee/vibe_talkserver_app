// 채팅방 목록의 마지막 메시지 요약(getMyRooms.lastMessage/lastMessageAt/lastMessageSender/lastMessageNo) 검증
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
// db.js는 로드 시점에 VIBE_TEST_DB를 우선 사용하므로 require 전에 지정한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-lastmessage-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');
const d = require('./db');

const cleanup = () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
};
const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); cleanup(); process.exit(1); }
  console.log('PASS:', msg);
};

try {
  const now = Date.now();
  const register = (loginId, nickname) => {
    const r = d.upsertUser({ loginId, nickname, phone: '010-0000-1234', timestamp: now, isDeleted: false });
    assert(r.ok, `사용자 등록: ${nickname}`);
    return r.user_no;
  };
  const aliceNo = register('alice', 'alice');
  const bobNo = register('bob', 'bob');
  const carolNo = register('carol', 'carol');
  const nickOf = { [aliceNo]: 'alice', [bobNo]: 'bob', [carolNo]: 'carol' };
  const noOf = { alice: aliceNo, bob: bobNo, carol: carolNo };
  const mkRoom = (name, timestamp, memberNos = []) => d.createRoom({
    name, ownerNo: aliceNo, timestamp, memberNos, ownerNickname: 'alice', memberNicknames: nickOf,
  });
  const say = (sender, text, timestamp, roomId) => d.saveMessage({
    roomType: 'room', senderNo: noOf[sender], senderName: sender, text, timestamp, roomId,
  });
  const aliceRoom = (roomId) => d.getMyRooms(aliceNo).find((r) => r.roomId === roomId);

  // 1. 메시지가 없는 방 → 마지막 메시지 필드는 전부 null
  const emptyRoom = mkRoom('빈방', now);
  const emptyInfo = aliceRoom(emptyRoom);
  assert(emptyInfo.lastMessage === null, '메시지 없는 방의 lastMessage는 null');
  assert(emptyInfo.lastMessageAt === null, '메시지 없는 방의 lastMessageAt은 null');
  assert(emptyInfo.lastMessageSender === null, '메시지 없는 방의 lastMessageSender는 null');
  assert(emptyInfo.lastMessageNo === null, '메시지 없는 방의 lastMessageNo는 null');

  // 2. 여러 방이 있어도 각 방의 마지막 메시지가 정확히 매칭된다
  const roomA = mkRoom('A방', now + 1, [bobNo]);
  const roomB = mkRoom('B방', now + 2, [carolNo]);
  say('alice', 'a-1', now + 10, roomA);
  say('bob', 'a-2', now + 20, roomA);
  say('alice', 'a-3', now + 30, roomA);
  say('carol', 'b-1', now + 40, roomB);

  const infoA = aliceRoom(roomA);
  const infoB = aliceRoom(roomB);
  assert(infoA.lastMessage === 'a-3', 'A방 마지막 메시지는 최신 건');
  assert(infoA.lastMessageAt === now + 30, 'A방 마지막 메시지 시각 일치');
  assert(infoA.lastMessageSender === 'alice', 'A방 마지막 발신자 일치');
  assert(infoA.lastMessageNo === aliceNo, 'A방 마지막 발신자 번호 일치');
  assert(infoB.lastMessage === 'b-1', 'B방 마지막 메시지는 최신 건');
  assert(infoB.lastMessageAt === now + 40, 'B방 마지막 메시지 시각 일치');
  assert(infoB.lastMessageSender === 'carol', 'B방 마지막 발신자 일치');
  assert(infoB.lastMessageNo === carolNo, 'B방 마지막 발신자 번호 일치');

  // 3. 같은 방의 메시지는 타 방 결과에 섞이지 않는다
  assert(
    d.getMyRooms(aliceNo)
      .filter((r) => r.roomId !== roomB)
      .every((r) => !String(r.lastMessage ?? '').startsWith('b-')),
    '타 방 메시지가 섞이지 않음'
  );

  // 4. timestamp 동률이면 최신 id(id DESC) 우선 — 히스토리 정렬과 동일 기준
  const tie1 = mkRoom('동률', now + 3);
  say('alice', 'tie-old', now + 50, tie1);
  say('bob', 'tie-new', now + 50, tie1);
  const tieInfo = aliceRoom(tie1);
  assert(tieInfo.lastMessage === 'tie-new', 'timestamp 동률이면 나중 저장(id DESC)이 최신');
  assert(tieInfo.lastMessageSender === 'bob', '동률 판정의 발신자 일치');

  // 5. 1:1방 메시지도 목록에 반영 — 1:1은 방 하나로만 표현된다
  const dmRoom = mkRoom('1:1 alice,bob', now + 4, [bobNo]);
  say('bob', 'dm-in-room', now + 70, dmRoom);
  const dmInfo = aliceRoom(dmRoom);
  assert(dmInfo.lastMessage === 'dm-in-room', '1:1방 마지막 메시지는 방 메시지 기준');
  assert(dmInfo.lastMessageSender === 'bob', '1:1방 발신자 일치');

  // 6. 메시지가 아직 없는 1:1방은 lastMessage가 null이다.
  //    (클라이언트가 목록에서 숨길지 판단하는 근거)
  const emptyOneToOne = mkRoom('1:1 alice,carol', now + 5, [carolNo]);
  const emptyOneToOneInfo = aliceRoom(emptyOneToOne);
  assert(emptyOneToOneInfo.lastMessage === null, '메시지 없는 1:1방은 lastMessage가 null');
  assert(emptyOneToOneInfo.lastMessageAt === null, '메시지 없는 1:1방은 lastMessageAt가 null');

  // 7. room_id가 다른 방의 메시지는 섞이지 않는다
  assert(aliceRoom(emptyRoom).lastMessage === null, '다른 방의 메시지가 합쳐지지 않음');

  // 8. 발신자 이름은 발송 시점 스냅샷 — 이후 닉변해도 목록 미리보기는 그대로
  const renamed = d.renameUser({ targetNo: bobNo, newNickname: 'bobby', requesterNo: bobNo });
  assert(renamed.ok, 'bob 닉네임 변경');
  assert(aliceRoom(dmRoom).lastMessageSender === 'bob', '닉변 후에도 마지막 발신자 이름은 스냅샷 유지');

  // 9. 삭제/폐쇄된 방은 목록과 함께 사라진다
  d.softDeleteRoom(roomA, aliceNo, now + 80);
  assert(
    !d.getMyRooms(aliceNo).some((r) => r.roomId === roomA),
    '삭제된 방은 목록 제외 (마지막 메시지 유무와 무관)'
  );

  console.log('\nALL ROOM LAST MESSAGE TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
