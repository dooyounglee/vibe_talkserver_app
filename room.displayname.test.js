const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-displayname-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');

const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const patched = src.replace(
  `new Database(path.join(__dirname, 'chat.db'))`,
  `new Database(process.env.VIBE_TEST_DB)`
);
const tmpDbPath = path.join(__dirname, '.db.displayname.tmp.js');
fs.writeFileSync(tmpDbPath, patched);
const d = require(tmpDbPath);

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
};
const now = Date.now();

// 1:1방: 각자 상대 닉네임이 displayName
const r1 = d.createRoom({ name: 'x', owner: 'lee', timestamp: now, members: ['sam'] });
assert(d.getMyRooms('lee')[0].displayName === 'sam', 'lee 목록에 sam 표시');
assert(d.getMyRooms('sam')[0].displayName === 'lee', 'sam 목록에 lee 표시');
// rooms.name 원본 보존
assert(d.getRoom(r1).name === 'x', 'rooms.name 원본 보존');

// 그룹방: displayName == name 폴백
const r2 = d.createRoom({ name: 'group', owner: 'lee', timestamp: now + 100, members: ['sam', 'kim'] });
const g = d.getMyRooms('lee').find((r) => r.roomId === r2);
assert(g && g.displayName === 'group', '그룹방은 rooms.name 폴백');

// 사용자별 제목 수정 밑작업 함수
assert(d.setRoomDisplayName(r2, 'lee', 'my title') === true, 'setRoomDisplayName 성공');
assert(d.getRoomDisplayName(r2, 'lee') === 'my title', 'getRoomDisplayName 조회');
assert(d.getMyRooms('lee').find((r) => r.roomId === r2).displayName === 'my title', '수정 후 본인 목록 반영');
assert(d.getMyRooms('sam').find((r) => r.roomId === r2).displayName === 'group', '타인 목록 영향 없음');

// поздно 입장 멤버: NULL → name 폴백
d.addMember(r2, 'park', now + 200);
assert(d.getMyRooms('park').find((r) => r.roomId === r2).displayName === 'group', '늦게 입장 멤버는 name 폴백');

console.log('\nALL DISPLAYNAME TESTS PASSED');
try { fs.unlinkSync(tmpDbPath); } catch {}
