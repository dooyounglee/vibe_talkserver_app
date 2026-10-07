// 방 이름 자동 생성 규칙 테스트
//   rooms.name = 참여자 전체 이름 오름차순 쉼표 연결 (생성 시점 스냅샷)
//   표시제목 = 나를 제외한 참여자 이름 (1:1이면 상대 닉네임) — display_name은 저장하지 않고(NULL) 매번 계산
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
// db.js는 로드 시점에 VIBE_TEST_DB를 우선 사용하므로 require 전에 지정한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-autoname-'));
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
  const nickOf = {};
  const noOf = {};
  const register = (loginId, nickname) => {
    const r = d.upsertUser({ loginId, nickname, phone: '010-0000-1234', timestamp: now, isDeleted: false });
    assert(r.ok, `사용자 등록: ${nickname}`);
    nickOf[r.user_no] = nickname;
    noOf[nickname] = r.user_no;
    return r.user_no;
  };
  // 닉네임 기준으로 방을 만드는 헬퍼 (user_no + 닉네임 스냅샷 전달)
  const mkRoom = (name, owner, timestamp, members = []) => d.createRoom({
    name,
    ownerNo: noOf[owner],
    timestamp,
    memberNos: members.map((m) => noOf[m]),
    ownerNickname: owner,
    memberNicknames: nickOf,
  });

  for (const nick of ['lee', 'sam', 'kim', 'a', 'b']) register(nick, nick);

  // ── joinMemberNames: 오름차순 + 쉼표 연결, 빈 값/중복 제거 ──
  assert(d.joinMemberNames('lee', ['sam', 'kim']) === 'kim,lee,sam', '오름차순 쉼표 연결');
  assert(d.joinMemberNames('b', ['c', 'a']) === 'a,b,c', '단순 정렬 확인');
  assert(d.joinMemberNames('lee', ['lee', '', '  ', 'sam']) === 'lee,sam', '중복/빈 값 제거');
  assert(d.joinMemberNames('lee', [' sam ']) === 'lee,sam', '앞뒤 공백 제거');
  assert(d.joinMemberNames('lee', []) === 'lee', '멤버 없으면 방장만');
  assert(d.joinMemberNames('lee') === 'lee', 'members 인자 생략');

  // ── 1:1방: 서로의 이름이 뜸 (기존 유지) ──
  const r1 = mkRoom('', 'lee', now, ['sam']);
  assert(d.getRoom(r1).name === 'lee,sam', '1:1 rooms.name 자동 생성');
  assert(d.getMyRooms(noOf.lee)[0].displayName === 'sam', '1:1 방장 화면에는 상대 닉네임');
  assert(d.getMyRooms(noOf.sam)[0].displayName === 'lee', '1:1 상대 화면에는 방장 닉네임');
  assert(d.getRoomDisplayName(r1, noOf.lee) === null, '1:1 display_name은 저장하지 않음(동적 계산)');

  // ── 3명 이상: rooms.name은 전체 이름, 표시제목은 나를 제외한 이름 ──
  const r2 = mkRoom('', 'lee', now + 100, ['sam', 'kim']);
  assert(d.getRoom(r2).name === 'kim,lee,sam', '그룹 rooms.name 자동 생성');
  assert(d.getRoomMembers(r2).length === 3, '그룹 멤버 3명 등록');
  for (const [nick, expected] of [['lee', 'kim,sam'], ['sam', 'kim,lee'], ['kim', 'lee,sam']]) {
    const info = d.getMyRooms(noOf[nick]).find((r) => r.roomId === r2);
    assert(info && info.displayName === expected, `그룹 ${nick} 화면에 나를 제외한 참여자 이름(${expected})`);
  }

  // ── 서버는 전체 이름을 그대로 내려준다(화면 축약은 클라이언트 responsibility) ──
  const long = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'];
  long.forEach((nick, i) => register(`long${i}`, nick));
  const r3 = mkRoom('', long[0], now + 200, long.slice(1));
  const full = long.slice(1).join(',');
  assert(full.length > 20, '테스트 값이 실제로 20자를 넘는지 확인');
  assert(d.getMyRooms(noOf[long[0]]).find((r) => r.roomId === r3).displayName === full, '긴 이름도 20자 축약 없이 전체 전달');

  // ── 전달된 이름이 있으면 그것을 유지 (DM 자동방 등 기존 호출부 호환) ──
  const r4 = mkRoom('1:1 a,b', 'a', now + 300, ['b']);
  assert(d.getRoom(r4).name === '1:1 a,b', '명시적 이름은 rooms.name에 보존');
  assert(d.getMyRooms(noOf.a).find((r) => r.roomId === r4).displayName === 'b', '1:1 표시제목은 기존 규칙 유지');

  // ── 멤버 목록에 방장/중복이 섞여도 이름이 중복되지 않는다 ──
  const r5 = mkRoom('', 'lee', now + 400, ['lee', 'kim', 'kim', 'sam']);
  assert(d.getRoom(r5).name === 'kim,lee,sam', '방장/중복 초대는 이름에서 제외');
  assert(d.getRoomMembers(r5).length === 3, '중복 초대는 멤버로 중복 등록되지 않음');

  console.log('\nALL AUTONAME TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
