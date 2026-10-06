// 사용자별 방 표시제목(display_name) 테스트
//   - 1:1방: 각자 상대 닉네임 / 그룹방: 참여자 이름 오름차순 연결
//   - 본인 제목 수정은 타인 목록에 영향 없음, 늦게 입장한 멤버는 rooms.name 폴백
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
// db.js는 로드 시점에 VIBE_TEST_DB를 우선 사용하므로 require 전에 지정한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-displayname-'));
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
  const leeNo = register('lee', 'lee');
  const samNo = register('sam', 'sam');
  const kimNo = register('kim', 'kim');
  const parkNo = register('park', 'park');
  const nickOf = { [leeNo]: 'lee', [samNo]: 'sam', [kimNo]: 'kim', [parkNo]: 'park' };

  // 1:1방: 각자 상대 닉네임이 displayName
  const r1 = d.createRoom({
    name: 'x', ownerNo: leeNo, timestamp: now, memberNos: [samNo],
    ownerNickname: 'lee', memberNicknames: nickOf,
  });
  assert(d.getMyRooms(leeNo)[0].displayName === 'sam', 'lee 목록에 sam 표시');
  assert(d.getMyRooms(samNo)[0].displayName === 'lee', 'sam 목록에 lee 표시');
  // rooms.name 원본 보존
  assert(d.getRoom(r1).name === 'x', 'rooms.name 원본 보존');

  // 그룹방: 모든 참여자 이름(오름차순 쉼표 연결)이 display_name에 저장됨
  const r2 = d.createRoom({
    name: '', ownerNo: leeNo, timestamp: now + 100, memberNos: [samNo, kimNo],
    ownerNickname: 'lee', memberNicknames: nickOf,
  });
  const g = d.getMyRooms(leeNo).find((r) => r.roomId === r2);
  assert(g && g.displayName === 'kim,lee,sam', '그룹방은 참여자 이름 연결이 표시제목');
  assert(d.getRoom(r2).name === 'kim,lee,sam', '그룹방 rooms.name도 자동 이름');
  assert(d.getMyRooms(samNo).find((r) => r.roomId === r2).displayName === 'kim,lee,sam', '초대자도 전체 이름 표시');
  assert(d.getRoomDisplayName(r2, kimNo) === 'kim,lee,sam', 'display_name에 전체 참여자 이름 저장');

  // 사용자별 제목 수정 밑작업 함수
  assert(d.setRoomDisplayName(r2, leeNo, 'my title') === true, 'setRoomDisplayName 성공');
  assert(d.getRoomDisplayName(r2, leeNo) === 'my title', 'getRoomDisplayName 조회');
  assert(d.getMyRooms(leeNo).find((r) => r.roomId === r2).displayName === 'my title', '수정 후 본인 목록 반영');
  assert(d.getMyRooms(samNo).find((r) => r.roomId === r2).displayName === 'kim,lee,sam', '타인 목록 영향 없음');

  // 늦게 입장한 멤버: NULL → name 폴백 (방 만들 당시의 자동 이름이 그대로 보임)
  d.addMember(r2, parkNo, now + 200);
  assert(d.getMyRooms(parkNo).find((r) => r.roomId === r2).displayName === 'kim,lee,sam', '늦게 입장 멤버는 name 폴백');

  console.log('\nALL DISPLAYNAME TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
