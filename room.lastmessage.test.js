// 채팅방 목록의 마지막 메시지 요약(getMyRooms.lastMessage/lastMessageAt/lastMessageSender) 검증
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-lastmessage-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');

const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const patched = src.replace(
  `new Database(path.join(__dirname, 'chat.db'))`,
  `new Database(process.env.VIBE_TEST_DB)`
);
const tmpDbPath = path.join(__dirname, '.db.lastmessage.tmp.js');
fs.writeFileSync(tmpDbPath, patched);
const d = require(tmpDbPath);

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
};

const now = Date.now();

// 1. 메시지가 없는 방 → 마지막 메시지 필드는 전부 null
const emptyRoom = d.createRoom({ name: '빈방', owner: 'alice', timestamp: now });
const emptyInfo = d.getMyRooms('alice').find((r) => r.roomId === emptyRoom);
assert(emptyInfo.lastMessage === null, '메시지 없는 방의 lastMessage는 null');
assert(emptyInfo.lastMessageAt === null, '메시지 없는 방의 lastMessageAt은 null');
assert(emptyInfo.lastMessageSender === null, '메시지 없는 방의 lastMessageSender는 null');

// 2. 여러 방이 있어도 각 방의 마지막 메시지가 정확히 매칭된다
const roomA = d.createRoom({ name: 'A방', owner: 'alice', timestamp: now + 1, members: ['bob'] });
const roomB = d.createRoom({ name: 'B방', owner: 'alice', timestamp: now + 2, members: ['carol'] });
d.saveMessage({ roomType: 'room', sender: 'alice', text: 'a-1', timestamp: now + 10, roomId: roomA });
d.saveMessage({ roomType: 'room', sender: 'bob', text: 'a-2', timestamp: now + 20, roomId: roomA });
d.saveMessage({ roomType: 'room', sender: 'alice', text: 'a-3', timestamp: now + 30, roomId: roomA });
d.saveMessage({ roomType: 'room', sender: 'carol', text: 'b-1', timestamp: now + 40, roomId: roomB });

let infoA = d.getMyRooms('alice').find((r) => r.roomId === roomA);
let infoB = d.getMyRooms('alice').find((r) => r.roomId === roomB);
assert(infoA.lastMessage === 'a-3', 'A방 마지막 메시지는 최신 건');
assert(infoA.lastMessageAt === now + 30, 'A방 마지막 메시지 시각 일치');
assert(infoA.lastMessageSender === 'alice', 'A방 마지막 발신자 일치');
assert(infoB.lastMessage === 'b-1', 'B방 마지막 메시지는 최신 건');
assert(infoB.lastMessageAt === now + 40, 'B방 마지막 메시지 시각 일치');
assert(infoB.lastMessageSender === 'carol', 'B방 마지막 발신자 일치');

// 3. 같은 방의 메시지는 타 방 결과에 섞이지 않는다
assert(
  d.getMyRooms('alice')
    .filter((r) => r.roomId !== roomB)
    .every((r) => !String(r.lastMessage ?? '').startsWith('b-')),
  '타 방 메시지가 섞이지 않음'
);

// 4. timestamp 동률이면 최신 id(id DESC) 우선 — 히스토리 정렬과 동일 기준
const tie1 = d.createRoom({ name: '동률', owner: 'alice', timestamp: now + 3 });
d.saveMessage({ roomType: 'room', sender: 'alice', text: 'tie-old', timestamp: now + 50, roomId: tie1 });
d.saveMessage({ roomType: 'room', sender: 'bob', text: 'tie-new', timestamp: now + 50, roomId: tie1 });
const tieInfo = d.getMyRooms('alice').find((r) => r.roomId === tie1);
assert(tieInfo.lastMessage === 'tie-new', 'timestamp 동률이면 나중 저장(id DESC)이 최신');
assert(tieInfo.lastMessageSender === 'bob', '동률 판정의 발신자 일치');

// 5. DM(1:1 자동방) 메시지도 목록에 반영 — DM은 방 메시지로도 저장된다
const dmRoom = d.createRoom({ name: '1:1 alice,bob', owner: 'alice', timestamp: now + 4, members: ['bob'] });
d.saveMessage({ roomType: 'dm', sender: 'bob', text: 'dm-only', timestamp: now + 60, receiver: 'alice' });
d.saveMessage({ roomType: 'room', sender: 'bob', text: 'dm-in-room', timestamp: now + 70, roomId: dmRoom });
const dmInfo = d.getMyRooms('alice').find((r) => r.roomId === dmRoom);
assert(dmInfo.lastMessage === 'dm-in-room', '1:1방 마지막 메시지는 방 메시지 기준');
assert(dmInfo.lastMessageSender === 'bob', '1:1방 발신자 일치');

// 6. room_type이 다른 행(room_id=null 등)은 후보에서 제외
const other = d.getMyRooms('alice').find((r) => r.roomId === emptyRoom);
assert(other.lastMessage === null, 'room_id가 null인 DM 행은 다른 방에 합쳐지지 않음');

// 7. 삭제/폐쇄된 방은 목록과 함께 사라진다
d.softDeleteRoom(roomA, 'alice', now + 80);
assert(
  !d.getMyRooms('alice').some((r) => r.roomId === roomA),
  '삭제된 방은 목록 제외 (마지막 메시지 유무와 무관)'
);

console.log('\nALL ROOM LAST MESSAGE TESTS PASSED');

try { fs.unlinkSync(tmpDbPath); } catch { /* 무시 */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }