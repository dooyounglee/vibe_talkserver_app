// 방 초대(invite) 테스트
//   1) 요구5: 초대받은 사람의 방 제목 기본값 = 전체 멤버 닉네임 나열값 (기존 멤버 display_name 불변)
//   2) 요구6: 초대받은 사람은 초대 시점(joined_at) 이후의 메시지만 조회
//   3) 중복/기존 멤버 초대는 추가되지 않는다
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
// db.js는 로드 시점에 VIBE_TEST_DB를 우선 사용하므로 require 전에 지정한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-invite-'));
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
    const r = d.upsertUser({ loginId, nickname, timestamp: now, isDeleted: false });
    assert(r.ok, `사용자 등록: ${nickname}`);
    return r.user_no;
  };
  const aliceNo = register('alice', 'alice');
  const bobNo = register('bob', 'bob');
  const carolNo = register('carol', 'carol');
  const nickOf = { [aliceNo]: 'alice', [bobNo]: 'bob', [carolNo]: 'carol' };

  // ─── 초대 전: alice + bob 그룹방 ───
  const roomId = d.createRoom({
    name: '',
    ownerNo: aliceNo,
    timestamp: now,
    memberNos: [bobNo],
    ownerNickname: 'alice',
    memberNicknames: nickOf,
  });
  assert(d.getRoom(roomId).name === 'alice,bob', '초대 전 rooms.name = alice,bob');

  ['pre-1', 'pre-2', 'pre-3'].forEach((text, i) => {
    d.saveMessage({
      roomType: 'room', senderNo: aliceNo, senderName: 'alice',
      text, timestamp: now + 10 + i, roomId,
    });
  });

  // ─── 초대: carol (중복 1건 + 이미 멤버 1건은 무시되어 신규 1명만 추가) ───
  const inviteAt = now + 100;
  const res = d.inviteMembers(roomId, [carolNo, carolNo, aliceNo], inviteAt);
  assert(res.added.length === 1 && res.added[0] === carolNo, '초대는 신규 대상만 추가(중복/기존 멤버 제외)');
  assert(d.isMember(roomId, carolNo), '초대받은 사람이 멤버로 등록됨');
  assert(res.memberNos.length === 3, '초대 후 멤버는 3명');

  // ─── 요구5: 초대받은 사람 제목 = 닉네임 나열값, 기존 멤버는 불변 ───
  assert(
    d.getRoomDisplayName(roomId, carolNo) === 'alice,bob,carol',
    '초대받은 사람 display_name = 전체 멤버 닉네임 나열값',
  );
  assert(d.getRoomDisplayName(roomId, aliceNo) === 'bob', '초대 전 멤버 display_name은 불변(1:1 규칙 alice→bob)');
  assert(d.getRoomDisplayName(roomId, bobNo) === 'alice', '초대 전 멤버 display_name은 불변(1:1 규칙 bob→alice)');
  const carolRoom = d.getMyRooms(carolNo).find((r) => r.roomId === roomId);
  assert(!!carolRoom && carolRoom.displayName === 'alice,bob,carol', 'carol의 내 채팅방 목록에 새 제목 반영');
  assert(carolRoom.lastMessage === null, '초대 이전 메시지는 목록 미리보기에도 보이지 않음');
  assert(
    d.getMyRooms(aliceNo).find((r) => r.roomId === roomId).lastMessage === 'pre-3',
    '기존 멤버의 목록 미리보기는 그대로',
  );

  // 초대 이후 메시지 2건
  ['post-1', 'post-2'].forEach((text, i) => {
    d.saveMessage({
      roomType: 'room', senderNo: bobNo, senderName: 'bob',
      text, timestamp: inviteAt + 1 + i, roomId,
    });
  });

  // ─── 요구6: 초대 시점 이후 메시지만 조회 ───
  const forCarol = d.getRecentRoomMessages(roomId, 10, carolNo);
  assert(forCarol.length === 2, '초대받은 사람은 메시지 2건(초대 시점 이후)만 조회');
  assert(
    forCarol.map((m) => m.text).join(',') === 'post-1,post-2',
    '초대 이전 메시지(pre-*)는 초대받은 사람에게 보이지 않음',
  );
  assert(d.getRecentRoomMessages(roomId, 10, aliceNo).length === 5, '기존 멤버는 전체 5건 조회');
  assert(d.getRecentRoomMessages(roomId, 10).length === 5, 'viewer 없으면 기존 동작 그대로 유지');
  assert(d.getRecentRoomMessages(roomId, 10, 999999).length === 0, '방 멤버가 아니면 조회되지 않음(누출 방지)');
  assert(
    d.getMyRooms(carolNo).find((r) => r.roomId === roomId).lastMessage === 'post-2',
    '초대 이후 메시지는 목록 미리보기에 표시',
  );

  // ─── 재초대: 이미 멤버는 추가되지 않고 joined_at도 밀리지 않는다 ───
  const again = d.inviteMembers(roomId, [carolNo], inviteAt + 50);
  const carolRow = d.getRoomMembers(roomId).find((m) => m.user_no === carolNo);
  assert(again.added.length === 0, '이미 멤버 재초대는 추가하지 않음');
  assert(carolRow.joined_at === inviteAt, '재초대가 joined_at을 밀지 않음(조회 기준점 유지)');
  assert(d.getRoomMembers(roomId).length === 3, '재초대로 인원이 늘지 않음');

  console.log('\nALL ROOM INVITE TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
