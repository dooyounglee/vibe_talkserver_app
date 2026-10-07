// 채팅창 열람용 최근 N건 조회(getRecentRoomMessages) 테스트
//   - 방/1:1방 모두 최근 N건을 오래된 → 최신 순으로 반환
//   - 다른 방의 메시지는 섞이지 않음
const path = require('path');
const fs = require('fs');
const os = require('os');

// 테스트용 임시 DB로 격리 (실제 chat.db 건드리지 않음)
// db.js는 로드 시점에 VIBE_TEST_DB를 우선 사용하므로 require 전에 지정한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recent-history-'));
process.env.VIBE_TEST_DB = path.join(tmpDir, 'test.db');
const dbm = require('./db');

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
    const r = dbm.upsertUser({ loginId, nickname, phone: '010-0000-1234', timestamp: now, isDeleted: false });
    assert(r.ok, `사용자 등록: ${nickname}`);
    return r.user_no;
  };
  const aliceNo = register('alice', 'alice');
  const bobNo = register('bob', 'bob');
  const carolNo = register('carol', 'carol');
  const nickOf = { [aliceNo]: 'alice', [bobNo]: 'bob', [carolNo]: 'carol' };

  // ─── 방 최근 N건 조회 ───
  const roomId = dbm.createRoom({ name: '스터디', ownerNo: aliceNo, timestamp: now, ownerNickname: 'alice' });
  dbm.addMember(roomId, bobNo, now + 1);
  for (let i = 0; i < 15; i++) {
    const even = i % 2 === 0;
    dbm.saveMessage({
      roomType: 'room',
      senderNo: even ? aliceNo : bobNo,
      senderName: even ? 'alice' : 'bob',
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
  assert(
    roomRecent[9].user_no === aliceNo && roomRecent[9].nickname === 'alice',
    '발신자 번호/닉네임 스냅샷 반환'
  );

  const roomFew = dbm.getRoomHistory(roomId, 50);
  assert(roomFew.length === 15, '기존 getRoomHistory는 전체(50 한도) 유지');

  // limit 지정 시
  assert(dbm.getRecentRoomMessages(roomId, 3).length === 3, '방 최근 조회 limit 지정 가능');
  assert(dbm.getRecentRoomMessages(9999, 10).length === 0, '없는 방은 빈 배열');

  // ─── 1:1 최근 N건 조회 ───
  // 1:1은 "멤버 2명 방"으로만 표현하므로 getRecentRoomMessages 로 조회한다.
  const dmRoom = dbm.createRoom({
    name: '1:1 alice,bob', ownerNo: aliceNo, timestamp: now + 100, memberNos: [bobNo],
    ownerNickname: 'alice', memberNicknames: nickOf,
  });
  for (let i = 0; i < 14; i++) {
    const even = i % 2 === 0;
    dbm.saveMessage({
      roomType: 'room',
      senderNo: even ? aliceNo : bobNo,
      senderName: even ? 'alice' : 'bob',
      text: `dm-${i}`,
      timestamp: now + 100 + i,
      roomId: dmRoom,
    });
  }
  // 무관한 제3자 방 (결과에 섞이면 안 됨)
  const carolRoom = dbm.createRoom({
    name: '1:1 alice,carol', ownerNo: aliceNo, timestamp: now + 200, memberNos: [carolNo],
    ownerNickname: 'alice', memberNicknames: nickOf,
  });
  dbm.saveMessage({
    roomType: 'room',
    senderNo: aliceNo,
    senderName: 'alice',
    text: 'dm-carol',
    timestamp: now + 300,
    roomId: carolRoom,
  });

  const dmRecent = dbm.getRecentRoomMessages(dmRoom, 10);
  assert(dmRecent.length === 10, '1:1 최근 조회는 10건만 반환');
  assert(dmRecent[0].text === 'dm-4', '1:1은 가장 오래된 것부터 (dm-4)');
  assert(dmRecent[9].text === 'dm-13', '1:1은 최신 메시지로 끝남 (dm-13)');
  assert(
    dmRecent.every((m) => m.text !== 'dm-carol'),
    '다른 방의 메시지는 결과에서 제외'
  );
  assert(
    dbm.getRecentRoomMessages(dmRoom, 3).length === 3,
    '1:1 최근 조회 limit 지정 가능'
  );
  assert(dbm.getRecentRoomMessages(carolRoom, 10).length === 1, '다른 1:1방은 1건');
  assert(dbm.getRecentRoomMessages(9999, 10).length === 0, '없는 방은 빈 배열');

  // ─── 커서 페이징 (getRoomMessagesPage) ───
  // roomId 방: msg-0 ~ msg-14 (15건)
  const latest = dbm.getRoomMessagesPage(roomId, null, { limit: 6 });
  assert(latest.messages.length === 6 && latest.messages[5].text === 'msg-14', '최신 페이지 6건, msg-14로 끝남');
  assert(latest.hasMore === true, '최신 페이지 이후 이전 대화 있음');
  const p2 = dbm.getRoomMessagesPage(roomId, null, { beforeId: latest.messages[0].id, limit: 6 });
  assert(p2.messages[0].text === 'msg-3' && p2.messages[5].text === 'msg-8', '이전 페이지 msg-3 ~ msg-8');
  assert(p2.hasMore === true, '아직 더 이전 대화 있음');
  const p3 = dbm.getRoomMessagesPage(roomId, null, { beforeId: p2.messages[0].id, limit: 6 });
  assert(p3.messages.length === 3 && p3.messages[0].text === 'msg-0', '마지막 페이지는 남은 3건');
  assert(p3.hasMore === false, '마지막 페이지는 hasMore=false');
  const seen = [...p3.messages, ...p2.messages, ...latest.messages].map((m) => m.text);
  assert(
    seen.length === 15 && new Set(seen).size === 15 && seen.every((t, i) => t === `msg-${i}`),
    '페이지를 이어 붙이면 빠짐/중복 없이 전체 순서 일치'
  );
  const fwd = dbm.getRoomMessagesPage(roomId, null, { afterId: p3.messages[2].id, limit: 4 });
  assert(fwd.messages[0].text === 'msg-3' && fwd.messages[3].text === 'msg-6', 'afterId: 이후 4건 (오래된 → 최신)');
  assert(fwd.hasMore === true, 'afterId: 더 이후 대화 있음');
  assert(dbm.getRoomMessagesPage(roomId, null, { limit: 999 }).messages.length === 15, 'limit 상한(50) 내에서 전체');

  // 초대 시점(joined_at) 이전 메시지는 페이징으로도 볼 수 없다
  dbm.addMember(roomId, carolNo, now + 2 + 10); // msg-10(timestamp now+12) 부터 볼 수 있음
  const carolLatest = dbm.getRoomMessagesPage(roomId, carolNo, { limit: 3 });
  assert(carolLatest.messages[2].text === 'msg-14' && carolLatest.hasMore === true, '초대된 사용자 최신 페이지');
  const carolOlder = dbm.getRoomMessagesPage(roomId, carolNo, { beforeId: carolLatest.messages[0].id, limit: 10 });
  assert(
    carolOlder.messages.length === 2 && carolOlder.messages[0].text === 'msg-10' && carolOlder.hasMore === false,
    '초대 이전 메시지(msg-0 ~ msg-9)는 이전 페이지에서도 제외'
  );

  // ─── 메시지 검색 (searchRoomMessages) ───
  const textOfId = Object.fromEntries(
    dbm.getRoomMessagesPage(roomId, null, { limit: 50 }).messages.map((m) => [m.id, m.text])
  );
  const hit = dbm.searchRoomMessages(roomId, null, 'msg-1');
  assert(
    hit.ids.map((id) => textOfId[id]).join(',') === 'msg-14,msg-13,msg-12,msg-11,msg-10,msg-1',
    '검색: 포함 매칭, 최신 → 과거 순'
  );
  assert(hit.truncated === false, '검색: 상한 미만이면 truncated=false');
  assert(dbm.searchRoomMessages(roomId, null, 'MSG-14').ids.length === 1, '검색: 영문 대소문자 무시');
  assert(dbm.searchRoomMessages(roomId, null, '%').ids.length === 0, '검색: % 는 와일드카드가 아닌 문자');
  assert(dbm.searchRoomMessages(roomId, null, '_').ids.length === 0, '검색: _ 는 와일드카드가 아닌 문자');
  assert(dbm.searchRoomMessages(roomId, null, '   ').ids.length === 0, '검색: 빈 검색어는 결과 없음');
  assert(dbm.searchRoomMessages(roomId, null, 'msg', 4).truncated === true, '검색: 상한 초과 시 truncated=true');
  assert(dbm.searchRoomMessages(dmRoom, null, 'msg-1').ids.length === 0, '검색: 다른 방 메시지는 제외');
  assert(
    dbm.searchRoomMessages(roomId, carolNo, 'msg-1').ids.map((id) => textOfId[id]).join(',') ===
      'msg-14,msg-13,msg-12,msg-11,msg-10',
    '검색: 초대 이전 메시지(msg-1)는 제외'
  );

  // ─── 검색 결과 점프 (getRoomMessagesAround) ───
  const id7 = Number(Object.keys(textOfId).find((id) => textOfId[id] === 'msg-7'));
  const around = dbm.getRoomMessagesAround(roomId, null, id7, 2);
  assert(
    around.messages.map((m) => m.text).join(',') === 'msg-5,msg-6,msg-7,msg-8,msg-9',
    '점프: 대상 앞뒤 2건씩 (오래된 → 최신)'
  );
  assert(around.hasMore === true && around.hasNewer === true, '점프: 앞뒤로 더 있음');
  const id14 = Number(Object.keys(textOfId).find((id) => textOfId[id] === 'msg-14'));
  assert(dbm.getRoomMessagesAround(roomId, null, id14, 2).hasNewer === false, '점프: 최신 메시지면 hasNewer=false');

  console.log('\nALL RECENT HISTORY TESTS PASSED');
  cleanup();
} catch (e) {
  console.error('FAIL:', e && e.message ? e.message : e);
  cleanup();
  process.exit(1);
}
