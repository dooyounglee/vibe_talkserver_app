// 사용자별 방 표시제목(display_name) 테스트
//   - 기본값: 나를 제외한 현재 멤버의 현재 닉네임 오름차순 연결 (1:1이면 상대 닉네임) — 매번 계산
//   - 입장/나가기/닉네임 변경이 바로 반영, 나만 남으면 '대화상대 없음'
//   - 본인 제목 수정은 타인 목록에 영향 없음, 빈 값으로 저장하면 기본값 복원
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
    const r = d.upsertUser({ loginId, nickname, phone: '010-0000-1234', timestamp: now, isDeleted: false });
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

  // 그룹방: 나를 제외한 참여자 이름(오름차순 쉼표 연결)이 표시제목, display_name은 비어 있음
  const r2 = d.createRoom({
    name: '', ownerNo: leeNo, timestamp: now + 100, memberNos: [samNo, kimNo],
    ownerNickname: 'lee', memberNicknames: nickOf,
  });
  const g = d.getMyRooms(leeNo).find((r) => r.roomId === r2);
  assert(g && g.displayName === 'kim,sam', '그룹방 방장(lee)은 나를 제외한 이름');
  assert(d.getRoom(r2).name === 'kim,lee,sam', '그룹방 rooms.name은 전체 이름 스냅샷');
  assert(d.getMyRooms(samNo).find((r) => r.roomId === r2).displayName === 'kim,lee', '초대받은 sam도 나를 제외한 이름');
  assert(d.getRoomDisplayName(r2, kimNo) === null, 'display_name은 저장하지 않음');

  // 사용자별 제목 수정 밑작업 함수
  assert(d.setRoomDisplayName(r2, leeNo, 'my title') === true, 'setRoomDisplayName 성공');
  assert(d.getRoomDisplayName(r2, leeNo) === 'my title', 'getRoomDisplayName 조회');
  assert(d.getMyRooms(leeNo).find((r) => r.roomId === r2).displayName === 'my title', '수정 후 본인 목록 반영');
  assert(d.getMyRooms(samNo).find((r) => r.roomId === r2).displayName === 'kim,lee', '타인 목록 영향 없음');

  // 늦게 입장한 멤버: 본인도 기존 멤버도 현재 멤버 기준으로 다시 계산된다
  d.addMember(r2, parkNo, now + 200);
  const titleOf = (no, rid) => d.getMyRooms(no).find((r) => r.roomId === rid).displayName;
  assert(titleOf(parkNo, r2) === 'kim,lee,sam', '늦게 입장한 park = 나를 제외한 현재 멤버');
  assert(titleOf(samNo, r2) === 'kim,lee,park', '기존 멤버(sam) 방제에 park 추가');
  assert(titleOf(leeNo, r2) === 'my title', '직접 지정한 제목은 멤버가 바뀌어도 유지');

  // 닉네임 변경 → 다른 멤버의 기본 방제에 바로 반영 (직접 지정한 제목은 그대로)
  assert(d.renameUser({ targetNo: kimNo, newNickname: 'kimchi', requesterNo: kimNo }).ok, 'kim 닉네임 변경');
  assert(titleOf(samNo, r2) === 'kimchi,lee,park', '닉네임 변경이 다른 멤버 방제에 반영');
  assert(titleOf(leeNo, r2) === 'my title', '직접 지정한 제목은 닉네임 변경에도 유지');

  // 빈 값으로 저장 → 기본 방제 복원
  assert(d.setRoomDisplayName(r2, leeNo, '  ') === true, '빈 제목 저장 = 기본값 복원');
  assert(d.getRoomDisplayName(r2, leeNo) === null, '복원 후 display_name은 NULL');
  assert(titleOf(leeNo, r2) === 'kimchi,park,sam', '복원 후 나를 제외한 현재 멤버 이름');

  // 나가기 → 남은 사람 방제에서 빠지고, 혼자 남으면 '대화상대 없음'
  d.removeMember(r2, parkNo);
  d.removeMember(r2, kimNo);
  assert(titleOf(samNo, r2) === 'lee', '나간 사람은 방제에서 빠짐');
  d.removeMember(r2, leeNo);
  assert(titleOf(samNo, r2) === '대화상대 없음', '혼자 남으면 대화상대 없음');

  console.log('\nALL DISPLAYNAME TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
