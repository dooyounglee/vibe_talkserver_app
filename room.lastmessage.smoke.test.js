// 스모크 테스트: '내 채팅방' 목록의 마지막 메시지/시간 반영 검증
//  - my_rooms 응답에 lastMessage/lastMessageAt/lastMessageSender 포함
//  - 방 메시지 저장 시 room_last_message 브로드캐스트 수신
// 임시 DB + 별도 포트로 격리한다 (실제 chat.db / 실행 중인 서버 무관)
// 신 규격: join { loginId }, room_create { memberNos } (user_no 기준)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-lastmsg-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8113;
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
        if (inbox.some((m) => m.type === 'join_ok') && inbox.some((m) => m.type === 'my_rooms')) { clearInterval(iv); res(); }
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
    const rootNo = await register('root', 'root');

    let b = await connect('root'); clients.push(b); await b.ready;
    assert(!b.inbox.some((m) => m.type === 'join_failed'), 'root 사용자 입장 성공');

    // 1. 방 생성 직후(메시지 없음) → 마지막 메시지 필드가 null
    a.inbox.length = 0;
    a.send({ type: 'room_create', memberNos: [rootNo] });
    const created = await a.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    const freshRoom = created.rooms.find((r) => r.roomId === roomId);
    assert(freshRoom.lastMessage === null, '생성 직후 my_rooms의 lastMessage는 null');
    assert(freshRoom.lastMessageAt === null, '생성 직후 my_rooms의 lastMessageAt은 null');

    // 2. 방에 메시지를 보내면 멤버의 목록 갱신 응답에 마지막 메시지 요약이 포함된다
    a.send({ type: 'room_message', roomId, text: '첫 메시지' });
    await wait(300);
    b.inbox.length = 0;
    b.send({ type: 'room_list' });
    const refreshed = await b.waitFor((m) => m.type === 'my_rooms');
    const bRoom = refreshed.rooms.find((r) => r.roomId === roomId);
    assert(bRoom.lastMessage === '첫 메시지', 'room_list 응답에 마지막 메시지 포함');
    assert(typeof bRoom.lastMessageAt === 'number', '마지막 메시지 시각(number) 포함');
    assert(bRoom.lastMessageSender === 'admin', '마지막 발신자 포함');
    assert(bRoom.lastMessageNo === 1, '마지막 발신자 user_no 포함');

    // 3. 방 멤버에게 room_last_message 실시간 신호가 도착한다
    b.inbox.length = 0;
    a.send({ type: 'room_message', roomId, text: '두 번째 메시지' });
    const lastMsg = await b.waitFor((m) => m.type === 'room_last_message');
    assert(lastMsg.roomId === roomId, 'room_last_message에 방 번호 포함');
    assert(lastMsg.text === '두 번째 메시지', 'room_last_message에 최신 내용 포함');
    assert(lastMsg.from === 'admin', 'room_last_message에 발신자 포함');
    assert(lastMsg.from_no === 1, 'room_last_message에 발신자 user_no 포함');
    assert(typeof lastMsg.timestamp === 'number', 'room_last_message에 시각 포함');

    // 4. 발신자 본인에게도 동일 신호가 회신된다 (내 목록 즉시 반영)
    a.inbox.length = 0;
    a.send({ type: 'room_message', roomId, text: '내 메시지' });
    const selfLast = await a.waitFor((m) => m.type === 'room_last_message');
    assert(selfLast.text === '내 메시지', '발신자에게도 room_last_message 회신');

    // 5. 방 멤버가 아니면 신호를 받지 않는다 (누출 방지)
    await register('outsider', 'outsider');
    const c = await connect('outsider'); clients.push(c); await c.ready;
    await wait(200);
    c.inbox.length = 0;
    a.send({ type: 'room_message', roomId, text: '비밀 메시지' });
    await wait(400);
    assert(
      !c.inbox.some((m) => m.type === 'room_last_message' || m.type === 'room_message'),
      '비멤버는 방 메시지 신호를 받지 않음'
    );
    c.close();

    // 6. 오프라인 상태의 멤버는 재접속 시 DB 기준 최신 메시지로 복원된다
    b.close();
    await wait(300);
    a.send({ type: 'room_message', roomId, text: '오프라인 중 메시지' });
    await wait(300);
    b = await connect('root'); clients.push(b); await b.ready;
    const rejoin = b.inbox.filter((m) => m.type === 'my_rooms').pop();
    const offlineRoom = rejoin.rooms.find((r) => r.roomId === roomId);
    assert(offlineRoom.lastMessage === '오프라인 중 메시지', '재접속 시 마지막 메시지 복원');

    console.log('\nROOM LAST MESSAGE SMOKE PASSED');
    for (const cl of clients) { try { cl.close(); } catch { /* 무시 */ } }
    await wait(200);
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e && e.message ? e.message : e);
    for (const cl of clients) { try { cl.close(); } catch { /* 무시 */ } }
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(1);
  }
})();
