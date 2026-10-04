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

// 그룹방: 모든 참여자 이름(오름차순 쉼표 연결)이 display_name에 저장됨
const r2 = d.createRoom({ name: '', owner: 'lee', timestamp: now + 100, members: ['sam', 'kim'] });
const g = d.getMyRooms('lee').find((r) => r.roomId === r2);
assert(g && g.displayName === 'kim,lee,sam', '그룹방은 참여자 이름 연결이 표시제목');
assert(d.getRoom(r2).name === 'kim,lee,sam', '그룹방 rooms.name도 자동 이름');
assert(d.getMyRooms('sam').find((r) => r.roomId === r2).displayName === 'kim,lee,sam', '초대자도 전체 이름 표시');
assert(d.getRoomDisplayName(r2, 'kim') === 'kim,lee,sam', 'display_name에 전체 참여자 이름 저장');

// 사용자별 제목 수정 밑작업 함수
assert(d.setRoomDisplayName(r2, 'lee', 'my title') === true, 'setRoomDisplayName 성공');
assert(d.getRoomDisplayName(r2, 'lee') === 'my title', 'getRoomDisplayName 조회');
assert(d.getMyRooms('lee').find((r) => r.roomId === r2).displayName === 'my title', '수정 후 본인 목록 반영');
assert(d.getMyRooms('sam').find((r) => r.roomId === r2).displayName === 'kim,lee,sam', '타인 목록 영향 없음');

// поздно 입장 멤버: NULL → name 폴백 (방 만들 당시의 자동 이름이 그대로 보임)
d.addMember(r2, 'park', now + 200);
assert(d.getMyRooms('park').find((r) => r.roomId === r2).displayName === 'kim,lee,sam', '늦게 입장 멤버는 name 폴백');

console.log('\nALL DISPLAYNAME TESTS PASSED');
try { fs.unlinkSync(tmpDbPath); } catch {}
