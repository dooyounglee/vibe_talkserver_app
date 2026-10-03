const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recent-history-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');

const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
const patched = src.replace(
  `new Database(path.join(__dirname, 'chat.db'))`,
  `new Database(process.env.VIBE_TEST_DB)`
);
const tmpDbPath = path.join(__dirname, '.db.recenthistory.tmp.js');
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

// ─── 방 최근 N건 조회 ───
const roomId = dbm.createRoom({ name: '스터디', owner: 'alice', timestamp: now });
dbm.addMember(roomId, 'bob', now + 1);
for (let i = 0; i < 15; i++) {
  dbm.saveMessage({
    roomType: 'room',
    sender: i % 2 === 0 ? 'alice' : 'bob',
    text: `msg-${i}`,
    timestamp: now + 2 + i,
    roomId,
  });
}

const roomRecent = dbm.getRecentRoomMessages(roomId, 10);
assert(roomRecent.length === 10, '방 최근 조회는 10건만 반환');
assert(roomRecent[0].text === 'msg-5', '가장 오래된 것부터 시작 (msg-5)');
assert(roomRecent[9].text === 'msg-14', '최신 메시지로 끝남 (msg-14)');
assert(
  roomRecent.every((m, i) => i === 0 || roomRecent[i - 1].timestamp <= m.timestamp),
  '방 최근 조회는 시간순 오름차순'
);

const roomFew = dbm.getRoomHistory(roomId, 50);
assert(roomFew.length === 15, '기존 getRoomHistory는 전체(50 한도) 유지');

// limit 지정 시
assert(dbm.getRecentRoomMessages(roomId, 3).length === 3, '방 최근 조회 limit 지정 가능');
assert(dbm.getRecentRoomMessages(9999, 10).length === 0, '없는 방은 빈 배열');

// ─── 1:1 최근 N건 조회 ───
for (let i = 0; i < 14; i++) {
  dbm.saveMessage({
    roomType: 'dm',
    sender: i % 2 === 0 ? 'alice' : 'bob',
    receiver: i % 2 === 0 ? 'bob' : 'alice',
    text: `dm-${i}`,
    timestamp: now + 100 + i,
  });
}
// 무관한 제3자 DM (결과에 섞이면 안 됨)
dbm.saveMessage({
  roomType: 'dm',
  sender: 'alice',
  receiver: 'carol',
  text: 'dm-carol',
  timestamp: now + 200,
});

const dmRecent = dbm.getRecentDmMessages('alice', 'bob', 10);
assert(dmRecent.length === 10, '1:1 최근 조회는 10건만 반환');
assert(dmRecent[0].text === 'dm-4', '1:1은 가장 오래된 것부터 (dm-4)');
assert(dmRecent[9].text === 'dm-13', '1:1은 최신 메시지로 끝남 (dm-13)');
assert(
  dmRecent.every((m) => m.text !== 'dm-carol'),
  '제3자와의 DM은 결과에서 제외'
);
assert(
  dbm.getRecentDmMessages('bob', 'alice', 10)[0].text === 'dm-4',
  '역순 조회도 동일 결과 (양방향)'
);
assert(
  dbm.getRecentDmMessages('alice', 'bob', 3).length === 3,
  '1:1 최근 조회 limit 지정 가능'
);
assert(dbm.getRecentDmMessages('alice', 'carol', 10).length === 1, 'carol과의 DM 1건');
assert(dbm.getRecentDmMessages('alice', 'alice', 10).length === 0, '본인 자신은 빈 배열');
assert(dbm.getRecentDmMessages('', 'bob', 10).length === 0, '빈 닉네임은 빈 배열');

console.log('\nALL RECENT HISTORY TESTS PASSED');

try { fs.unlinkSync(tmpDbPath); } catch { /* 무시 */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
