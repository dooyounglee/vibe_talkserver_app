const path = require('path');
const fs = require('fs');
const os = require('os');

// 방 이름 자동 생성 규칙 테스트
//   1:1방(총 2명) → 서로의 이름이 뜸(상대 닉네임) / 3명 이상 → 참여자 이름 오름차순 쉼표 연결
//   DB에는 모든 참여자 이름이 room_members.display_name으로 들어간다
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-autoname-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');

const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const patched = src.replace(
  `new Database(path.join(__dirname, 'chat.db'))`,
  `new Database(process.env.VIBE_TEST_DB)`
);
const tmpDbPath = path.join(__dirname, '.db.autoname.tmp.js');
fs.writeFileSync(tmpDbPath, patched);
const d = require(tmpDbPath);

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
};
const now = Date.now();

// ── joinMemberNames: 오름차순 + 쉼표 연결, 빈 값/중복 제거 ──
assert(d.joinMemberNames('lee', ['sam', 'kim']) === 'kim,lee,sam', '오름차순 쉼표 연결');
assert(d.joinMemberNames('b', ['c', 'a']) === 'a,b,c', '단순 정렬 확인');
assert(d.joinMemberNames('lee', ['lee', '', '  ', 'sam']) === 'lee,sam', '중복/빈 값 제거');
assert(d.joinMemberNames('lee', [' sam ']) === 'lee,sam', '앞뒤 공백 제거');
assert(d.joinMemberNames('lee', []) === 'lee', '멤버 없으면 방장만');
assert(d.joinMemberNames('lee') === 'lee', 'members 인자 생략');

// ── 1:1방: 서로의 이름이 뜸 (기존 유지) ──
const r1 = d.createRoom({ name: '', owner: 'lee', timestamp: now, members: ['sam'] });
assert(d.getRoom(r1).name === 'lee,sam', '1:1 rooms.name 자동 생성');
assert(d.getMyRooms('lee')[0].displayName === 'sam', '1:1 방장 화면에는 상대 닉네임');
assert(d.getMyRooms('sam')[0].displayName === 'lee', '1:1 상대 화면에는 방장 닉네임');
assert(d.getRoomDisplayName(r1, 'lee') === 'sam', '1:1 display_name 저장값');

// ── 3명 이상: 참여자 전체 이름(오름차순 쉼표 연결)이 rooms.name/display_name ──
const r2 = d.createRoom({ name: '', owner: 'lee', timestamp: now + 100, members: ['sam', 'kim'] });
assert(d.getRoom(r2).name === 'kim,lee,sam', '그룹 rooms.name 자동 생성');
assert(d.getRoomMembers(r2).length === 3, '그룹 멤버 3명 등록');
for (const nick of ['lee', 'sam', 'kim']) {
  const info = d.getMyRooms(nick).find((r) => r.roomId === r2);
  assert(info && info.displayName === 'kim,lee,sam', `그룹 ${nick} 화면에 전체 참여자 이름`);
}

// ── DB에는 전체 이름이 그대로 들어간다(화면 축약은 클라이언트 responsibility) ──
const long = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'];
const r3 = d.createRoom({
  name: '', owner: long[0], timestamp: now + 200, members: long.slice(1),
});
const full = long.join(',');
assert(full.length > 20, '테스트 값이 실제로 20자를 넘는지 확인');
assert(d.getRoomDisplayName(r3, long[0]) === full, '긴 이름도 DB에는 20자 축약 없이 전체 저장');

// ── 전달된 이름이 있으면 그것을 유지 (DM 자동방 등 기존 호출부 호환) ──
const r4 = d.createRoom({ name: '1:1 a,b', owner: 'a', timestamp: now + 300, members: ['b'] });
assert(d.getRoom(r4).name === '1:1 a,b', '명시적 이름은 rooms.name에 보존');
assert(d.getMyRooms('a').find((r) => r.roomId === r4).displayName === 'b', '1:1 표시제목은 기존 규칙 유지');

// ── 멤버 목록에 방장/중복이 섞여도 이름이 중복되지 않는다 ──
const r5 = d.createRoom({ name: '', owner: 'lee', timestamp: now + 400, members: ['lee', 'kim', 'kim', 'sam'] });
assert(d.getRoom(r5).name === 'kim,lee,sam', '방장/중복 초대는 이름에서 제외');
assert(d.getRoomMembers(r5).length === 3, '중복 초대는 멤버로 중복 등록되지 않음');

console.log('\nALL AUTONAME TESTS PASSED');
try { fs.unlinkSync(tmpDbPath); } catch {}