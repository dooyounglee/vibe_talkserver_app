// 스모크 테스트: 서버가 채팅창 열람 시 DB에서 최근 10건을 내려주는지 검증
// 임시 DB + 별도 포트로 격리한다 (실제 chat.db / 실행 중인 서버 무관)
// 신 규격: join { loginId }, dm_room_open { withUserNo }, room_create { memberNos }
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8115;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); console.log('PASS:', msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (loginId) => new Promise((resolve, reject) => {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', loginId, password: loginId })));
  ws.on('message', (raw) => { try { inbox.push(JSON.parse(String(raw))); } catch { /* 무시 */ } });
  ws.on('error', reject);
  const waitFor = (pred, timeout = 5000) => new Promise((res, rej) => {
    const found = inbox.find(pred);
    if (found) return res(found);
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) { clearInterval(iv); res(hit); }
      else if (Date.now() - start > timeout) { clearInterval(iv); rej(new Error('응답 타임아웃')); }
    }, 20);
  });
  resolve({
    ws, inbox, waitFor,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    ready: new Promise((res, rej) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (inbox.some((m) => m.type === 'join_ok') && inbox.some((m) => m.type === 'userlist')) { clearInterval(iv); res(); }
        else if (inbox.some((m) => m.type === 'join_failed')) { clearInterval(iv); rej(new Error(`${loginId} join_failed`)); }
        else if (Date.now() - start > 5000) { clearInterval(iv); rej(new Error(`${loginId} join 타임아웃`)); }
      }, 20);
    }),
  });
});

(async () => {
  const clients = [];
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname, stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    const a = await connect('admin'); clients.push(a); await a.ready;

    const register = async (loginId, nickname) => {
      a.inbox.length = 0;
      a.send({ type: 'user_upsert', loginId, nickname, isDeleted: false });
      const r = await a.waitFor((m) => m.type === 'user_upsert_result');
      assert(r.ok === true, `사용자 등록 ${nickname}`);
      return r.user_no;
    };

    // 미등록 사용자는 입장 거부
    const ghostClient = await connect('ghost'); clients.push(ghostClient);
    let ghostRejected = false;
    try { await ghostClient.ready; } catch (e) { ghostRejected = /join_failed/.test(String(e.message)); }
    assert(ghostRejected, '미등록 사용자는 join_failed');

    const rootNo = await register('root', 'root');
    const b = await connect('root'); clients.push(b); await b.ready;
    assert(!b.inbox.some((m) => m.type === 'join_failed'), 'root 사용자 입장 성공');

    // 1. 접속 시 일괄 히스토리가 오지 않음을 확인
    assert(
      !b.inbox.some((m) => m.type === 'history_room' || m.type === 'history_dm'),
      '접속 시 일괄 히스토리 미수신'
    );

    // 2. '사용자' 탭에서 1:1 창을 열면 방이 확보되고, 그 방으로 recent 10건이 조회된다
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUserNo: rootNo });
    const opened = await a.waitFor((m) => m.type === 'room_opened' && m.withUserNo === rootNo);
    const dmRoomId = opened.roomId;
    assert(Number.isInteger(dmRoomId), '1:1방 확보 후 방 번호 반환됨');
    assert(opened.withUser === 'root', 'room_opened에 상대 닉네임 포함');
    for (let i = 0; i < 15; i++) {
      a.send({ type: 'room_message', roomId: dmRoomId, text: `dm-${i}` });
    }
    await wait(400);
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId: dmRoomId });
    const dmHist = await a.waitFor((m) => m.type === 'history_room' && m.roomId === dmRoomId);
    assert(dmHist.messages.length === 15, '1:1방 히스토리: 한 페이지(30) 이하면 전부 응답');
    assert(dmHist.messages[0].text === 'dm-0', '가장 오래된 dm-0부터 시작');
    assert(dmHist.messages[14].text === 'dm-14', '최신 dm-14로 끝남');
    assert(dmHist.hasMore === false, '더 이전 대화 없음(hasMore=false)');

    // 상대(root)도 같은 1:1방 히스토리를 본다
    b.inbox.length = 0;
    b.send({ type: 'room_history', roomId: dmRoomId });
    const dmHistB = await b.waitFor((m) => m.type === 'history_room' && m.roomId === dmRoomId);
    assert(dmHistB.messages.length === 15 && dmHistB.messages[14].text === 'dm-14', '상대도 1:1방 히스토리 조회');

    // 3. 번호방 생성 + 메시지 40건 → room_history로 최근 30건, room_history_older로 나머지 10건
    a.inbox.length = 0;
    a.send({ type: 'room_create', memberNos: [rootNo] });
    const created = await a.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    b.send({ type: 'room_join', roomId });
    await wait(200);
    for (let i = 0; i < 40; i++) {
      a.send({ type: 'room_message', roomId, text: `room-${i}` });
    }
    await wait(400);
    b.inbox.length = 0;
    b.send({ type: 'room_history', roomId });
    const roomHist = await b.waitFor((m) => m.type === 'history_room' && m.roomId === roomId);
    assert(roomHist.messages.length === 30, 'room_history 응답이 30건');
    assert(roomHist.messages[0].text === 'room-10', '가장 최근 30건의 시작점이 room-10');
    assert(roomHist.messages[29].text === 'room-39', '최신 room-39로 끝남');
    assert(roomHist.hasMore === true, '이전 대화 있음(hasMore=true)');

    // 3-1. 이전 대화 더보기: 가장 오래된 msgId 이전 페이지
    b.inbox.length = 0;
    const oldestId = roomHist.messages[0].msgId;
    b.send({ type: 'room_history_older', roomId, beforeId: oldestId });
    const older = await b.waitFor((m) => m.type === 'history_room_older' && m.roomId === roomId);
    assert(older.beforeId === oldestId, 'history_room_older에 요청한 beforeId 포함');
    assert(older.messages.length === 10, '이전 페이지는 남은 10건');
    assert(older.messages[0].text === 'room-0' && older.messages[9].text === 'room-9', '이전 페이지 room-0 ~ room-9 (오래된 → 최신)');
    assert(older.messages.every((m) => m.msgId < oldestId), '이전 페이지는 모두 beforeId보다 작은 msgId');
    assert(older.hasMore === false, '더 이전 대화 없음(hasMore=false)');

    // 3-2. limit 지정
    b.inbox.length = 0;
    b.send({ type: 'room_history_older', roomId, beforeId: oldestId, limit: 4 });
    const olderSmall = await b.waitFor((m) => m.type === 'history_room_older' && m.roomId === roomId);
    assert(olderSmall.messages.length === 4 && olderSmall.messages[3].text === 'room-9', 'limit 지정 시 그 개수만');
    assert(olderSmall.hasMore === true, 'limit 이후 남은 대화 있음(hasMore=true)');

    // 4. 멤버가 아니면 빈 히스토리 (누출 방지)
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId: 999999 });
    const missing = await a.waitFor((m) => m.type === 'history_room' && m.roomId === 999999);
    assert(Array.isArray(missing.messages) && missing.messages.length === 0, '없는 방은 빈 히스토리');
    a.inbox.length = 0;
    a.send({ type: 'room_history_older', roomId: 999999, beforeId: 100 });
    const missingOlder = await a.waitFor((m) => m.type === 'history_room_older' && m.roomId === 999999);
    assert(missingOlder.messages.length === 0 && missingOlder.hasMore === false, '없는 방은 이전 대화도 빈 응답');

    // 5. 1:1방은 한 번 확보되면 같은 방이 재사용된다 (중복방 생성 방지)
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUserNo: rootNo });
    const reopened = await a.waitFor((m) => m.type === 'room_opened' && m.withUserNo === rootNo);
    assert(reopened.roomId === dmRoomId, '같은 상대는 같은 1:1방을 재사용');
    // 상대 쪽에서 열어도 같은 방
    b.inbox.length = 0;
    b.send({ type: 'dm_room_open', withUserNo: 1 });
    const reverse = await b.waitFor((m) => m.type === 'room_opened' && m.withUserNo === 1);
    assert(reverse.roomId === dmRoomId, '상대 쪽에서 열어도 같은 1:1방');
    a.send({ type: 'room_message', roomId: dmRoomId, text: 'room-only-msg' });
    await wait(300);
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId: dmRoomId });
    const roomSourced = await a.waitFor(
      (m) => m.type === 'history_room' && m.roomId === dmRoomId,
    );
    assert(
      roomSourced.messages.some((m) => m.text === 'room-only-msg'),
      '1:1방 히스토리에 방에서 보낸 메시지가 포함'
    );

    // 6. 아직 대화하지 않은 상대는 새 방이 만들어진다
    const strangerNo = await register('stranger', 'stranger');
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUserNo: strangerNo });
    const fresh = await a.waitFor((m) => m.type === 'room_opened' && m.withUserNo === strangerNo);
    assert(
      Number.isInteger(fresh.roomId) && fresh.roomId !== dmRoomId,
      '첫 대화 상대를 누르면 새 1:1방 생성'
    );
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId: fresh.roomId });
    const noMsg = await a.waitFor(
      (m) => m.type === 'history_room' && m.roomId === fresh.roomId,
    );
    assert(
      Array.isArray(noMsg.messages) && noMsg.messages.length === 0,
      '메시지 0개인 새 1:1방은 빈 히스토리'
    );

    // 7. 미등록 사용자(user_no)에게는 방을 만들지 않는다
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUserNo: 99999 });
    const denied = await a.waitFor((m) => m.type === 'system');
    assert(String(denied.text).includes('유효하지 않습니다'), '미등록 사용자에는 방 생성 거부');
    assert(!a.inbox.some((m) => m.type === 'room_opened'), '미등록 사용자에게 room_opened 미발송');

    console.log('\nSMOKE TEST PASSED');
    for (const c of clients) { try { c.close(); } catch { /* 무시 */ } }
    await wait(200);
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e && e.message ? e.message : e);
    for (const c of clients) { try { c.close(); } catch { /* 무시 */ } }
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(1);
  }
})();
