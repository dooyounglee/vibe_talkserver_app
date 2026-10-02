const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-room-test-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');

// db.js는 __dirname/chat.db를 직접 쓰므로, 테스트에서는 모듈 소스를 읽어
// DB 경로만 임시 경로로 바꾼 복사본을 "서버 폴더 안"에 둔다.
// (Temp 폴더에 두면 better-sqlite3 모듈 해석이 안 되므로 같은 폴더에 둔다.)
const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const patched = src.replace(
  `new Database(path.join(__dirname, 'chat.db'))`,
  `new Database(process.env.VIBE_TEST_DB)`
);
const tmpDbPath = path.join(__dirname, '.db.roomtest.tmp.js');
fs.writeFileSync(tmpDbPath, patched);
const dbm = require(tmpDbPath);

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
};

const now = Date.now();

// 1. 방 생성 → 방번호 발급 + 생성자가 owner+멤버
const roomId = dbm.createRoom({ name: '스터디', owner: 'alice', timestamp: now });
assert(Number.isInteger(roomId) && roomId >= 1, `방 생성 시 번호 발급 (#${roomId})`);
assert(dbm.isMember(roomId, 'alice'), '생성자가 멤버로 등록됨');
assert(dbm.getRoom(roomId).owner === 'alice', '생성자가 방장');

// 2. 내 방 목록 — 생성자에게 보임
let aliceRooms = dbm.getMyRooms('alice');
assert(aliceRooms.length === 1 && aliceRooms[0].roomId === roomId, '생성자의 my_rooms에 표시');

// 3. 번호로 입장 — bob 입장 후 잔류자 2명
dbm.addMember(roomId, 'bob', now + 1);
assert(dbm.isMember(roomId, 'bob'), 'bob 입장');
assert(dbm.countMembers(roomId) === 2, '입장 후 2명');
assert(dbm.getMyRooms('bob').length === 1, 'bob의 my_rooms에도 표시');

// 4. 방 메시지 저장/조회
dbm.saveMessage({ roomType: 'room', sender: 'alice', text: '안녕', timestamp: now + 2, roomId });
dbm.saveMessage({ roomType: 'room', sender: 'bob', text: '하이', timestamp: now + 3, roomId });
const hist = dbm.getRoomHistory(roomId, 50);
assert(hist.length === 2 && hist[0].nickname === 'alice' && hist[1].text === '하이', '방 히스토리 시간순 조회');

// 5. 일부 퇴장 — bob이 나가도 alice는 계속 이용 (방 유지)
dbm.removeMember(roomId, 'bob');
assert(dbm.countMembers(roomId) === 1, 'bob 퇴장 후 1명 잔류');
assert(dbm.isRoomActive(dbm.getRoom(roomId)), '잔류자 있으면 방 활성 유지');
assert(dbm.getMyRooms('alice').length === 1, '잔류자 목록 유지');
assert(dbm.getMyRooms('bob').length === 0, '퇴장자 목록에서 제거');

// 6. 방장 퇴장 시 owner 승계 — alice 퇴장 전 carol 입장, 승계 확인
dbm.addMember(roomId, 'carol', now + 4);
const next = dbm.getEarliestMemberExcept(roomId, 'alice');
assert(next === 'carol', '방장 퇴장 시 잔류자 중 가장 이른 멤버 승계 대상');
dbm.removeMember(roomId, 'alice');
dbm.transferOwner(roomId, next);
assert(dbm.getRoom(roomId).owner === 'carol', '방장 승계 완료');
assert(dbm.isRoomActive(dbm.getRoom(roomId)), '잔류자 있으면 방 유지');

// 7. 마지막 1인 퇴장 시 폐쇄 — carol 퇴장 → is_closed=1
dbm.removeMember(roomId, 'carol');
const closed = dbm.closeRoomIfEmpty(roomId, Date.now());
assert(closed === true, '마지막 퇴장 시 폐쇄 처리');
assert(dbm.isRoomActive(dbm.getRoom(roomId)) === false, '폐쇄방은 비활성');
assert(dbm.getMyRooms('carol').length === 0, '폐쇄방은 my_rooms 제외');

// 8. 폐쇄방 재입장 불가 (서버 room_join 가드와 동일 조건)
const closedRoom = dbm.getRoom(roomId);
assert(!(closedRoom.is_deleted === 0 && closedRoom.is_closed === 0), '폐쇄방 join 거부 조건 만족');

// 9. 삭제해도 DB 보존 — 새 방 만들어 soft delete
const roomId2 = dbm.createRoom({ name: '동호회', owner: 'dave', timestamp: now + 10 });
dbm.addMember(roomId2, 'erin', now + 11);
dbm.saveMessage({ roomType: 'room', sender: 'dave', text: '환영', timestamp: now + 12, roomId: roomId2 });
dbm.softDeleteRoom(roomId2, 'dave', Date.now());
const del = dbm.getRoom(roomId2);
assert(del.is_deleted === 1 && del.deleted_by === 'dave', 'soft delete 플래그 기록');
assert(dbm.getMyRooms('dave').length === 0, '삭제방은 목록 제외');
assert(dbm.getRoomHistory(roomId2, 50).length === 1, '삭제 후에도 메시지 DB 보존');

console.log('\nALL ROOM LIFECYCLE TESTS PASSED');

// 임시 파일 정리
try {
  fs.unlinkSync(tmpDbPath);
} catch { /* 무시 */ }
