// 1:1 자동방(findActiveOneToOneRoom / ensureOneToOneRoom) 테스트
//   - 활성 + 멤버 정확히 2명인 방만 1:1방으로 매칭 (그룹방 오판 금지)
//   - 퇴장/삭제된 방은 매칭 제외
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
// db.js는 로드 시점에 VIBE_TEST_DB를 우선 사용하므로 require 전에 지정한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dm-autoroom-'));
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
  const aNo = register('a', 'a');
  const bNo = register('b', 'b');
  const cNo = register('c', 'c');
  const eNo = register('e', 'e');
  const nickOf = { [aNo]: 'a', [bNo]: 'b', [cNo]: 'c', [eNo]: 'e' };

  // 1. 빈 DB에서는 null
  assert(d.findActiveOneToOneRoom(aNo, bNo) === null, '빈 DB에서는 null');
  // 2. 자기 자신 / 빈 값은 null
  assert(d.findActiveOneToOneRoom(aNo, aNo) === null, '자기 자신은 null');
  assert(d.findActiveOneToOneRoom('', bNo) === null, '빈 사용자 번호는 null');
  assert(d.findActiveOneToOneRoom(null, bNo) === null, 'null 사용자 번호는 null');

  // 3. 1:1방 생성 후 양방향 조회 (순서 무관)
  const r1 = d.createRoom({
    name: 'dm', ownerNo: aNo, timestamp: now, memberNos: [bNo],
    ownerNickname: 'a', memberNicknames: nickOf,
  });
  assert(d.findActiveOneToOneRoom(aNo, bNo) === r1, 'a,b 조회');
  assert(d.findActiveOneToOneRoom(bNo, aNo) === r1, 'b,a 역순 조회');
  assert(d.ensureOneToOneRoom(bNo, aNo, now + 1, nickOf) === r1, 'ensureOneToOneRoom은 기존 1:1방 재사용');

  // 4. 그룹방(3명)은 매칭되면 안 됨
  d.createRoom({
    name: 'group', ownerNo: aNo, timestamp: now + 10, memberNos: [bNo, cNo],
    ownerNickname: 'a', memberNicknames: nickOf,
  });
  assert(d.findActiveOneToOneRoom(aNo, bNo) === r1, '그룹방이 있어도 1:1방 유지');
  assert(d.findActiveOneToOneRoom(aNo, cNo) === null, 'a,c 1:1방 없음 (그룹방 오판 금지)');
  assert(d.findActiveOneToOneRoom(bNo, cNo) === null, 'b,c 1:1방 없음 (그룹방 오판 금지)');

  // 5. 다른 쌍의 1:1방 조회 + 목록 표시제목은 상대 닉네임
  const r2 = d.createRoom({
    name: 'dm2', ownerNo: cNo, timestamp: now + 20, memberNos: [eNo],
    ownerNickname: 'c', memberNicknames: nickOf,
  });
  assert(d.findActiveOneToOneRoom(cNo, eNo) === r2, '다른 쌍 1:1방 조회');
  assert(d.getMyRooms(aNo).find((r) => r.roomId === r1).displayName === 'b', 'a 목록에 b 표시');
  assert(d.getMyRooms(bNo).find((r) => r.roomId === r1).displayName === 'a', 'b 목록에 a 표시');

  // 6. 멤버가 나가면(2명 깨지면) 더 이상 1:1방으로 매칭 안 됨
  d.removeMember(r2, eNo);
  assert(d.findActiveOneToOneRoom(cNo, eNo) === null, '퇴장 후 1:1 매칭 제외');

  // 7. 삭제된 1:1방은 제외
  d.softDeleteRoom(r1, aNo, Date.now());
  assert(d.findActiveOneToOneRoom(aNo, bNo) === null, '삭제방 제외');
  // (삭제해도 getMyRooms 제외 + 히스토리 보존은 lifecycle 테스트에서 보장)

  // 8. 삭제 후 ensureOneToOneRoom은 새 1:1방을 만든다
  const r3 = d.ensureOneToOneRoom(aNo, bNo, now + 30, nickOf);
  assert(Number.isInteger(r3) && r3 !== r1, '삭제 후 ensureOneToOneRoom은 새 방 생성');
  assert(d.findActiveOneToOneRoom(bNo, aNo) === r3, '새 1:1방 매칭');

  console.log('\nALL DM AUTO-ROOM TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
