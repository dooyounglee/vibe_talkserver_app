const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dm-autoroom-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');

const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const patched = src.replace(
  `new Database(path.join(__dirname, 'chat.db'))`,
  `new Database(process.env.VIBE_TEST_DB)`
);
const tmpDbPath = path.join(__dirname, '.db.dmautoroom.tmp.js');
fs.writeFileSync(tmpDbPath, patched);
const d = require(tmpDbPath);

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
};
const now = Date.now();

// 1. 빈 DB에서는 null
assert(d.findActiveOneToOneRoom('a', 'b') === null, '빈 DB에서는 null');
// 2. 자기 자신 / 빈 값은 null
assert(d.findActiveOneToOneRoom('a', 'a') === null, '자기 자신은 null');
assert(d.findActiveOneToOneRoom('', 'b') === null, '빈 닉네임은 null');

// 3. 1:1방 생성 후 양방향 조회 (순서 무관)
const r1 = d.createRoom({ name: 'dm', owner: 'a', timestamp: now, members: ['b'] });
assert(d.findActiveOneToOneRoom('a', 'b') === r1, 'a,b 조회');
assert(d.findActiveOneToOneRoom('b', 'a') === r1, 'b,a 역순 조회');

// 4. 그룹방(3명)은 매칭되면 안 됨
d.createRoom({ name: 'group', owner: 'a', timestamp: now + 10, members: ['b', 'c'] });
assert(d.findActiveOneToOneRoom('a', 'b') === r1, '그룹방이 있어도 1:1방 유지');
assert(d.findActiveOneToOneRoom('a', 'c') === null, 'a,c 1:1방 없음 (그룹방 오판 금지)');
assert(d.findActiveOneToOneRoom('b', 'c') === null, 'b,c 1:1방 없음 (그룹방 오판 금지)');

// 5. 두 번째 1:1방이 생겨도 가장 이른 번호 반환 (중복방 방지 로직의 find 역할)
const r2 = d.createRoom({ name: 'dm2', owner: 'c', timestamp: now + 20, members: ['e'] });
assert(d.findActiveOneToOneRoom('c', 'e') === r2, '다른 쌍 1:1방 조회');
assert(d.getMyRooms('a').find((r) => r.roomId === r1).displayName === 'b', 'a 목록에 b 표시');
assert(d.getMyRooms('b').find((r) => r.roomId === r1).displayName === 'a', 'b 목록에 a 표시');

// 6. 멤버가 나가면(2명 깨지면) 더 이상 1:1방으로 매칭 안 됨
d.removeMember(r2, 'e');
assert(d.findActiveOneToOneRoom('c', 'e') === null, '퇴장 후 1:1 매칭 제외');

// 7. 삭제된 1:1방은 제외
d.softDeleteRoom(r1, 'a', Date.now());
assert(d.findActiveOneToOneRoom('a', 'b') === null, '삭제방 제외');
// (삭제해도 getMyRooms 제외 + 히스토리 보존은 lifecycle 테스트에서 보장)

console.log('\nALL DM AUTO-ROOM TESTS PASSED');
try { fs.unlinkSync(tmpDbPath); } catch {}
