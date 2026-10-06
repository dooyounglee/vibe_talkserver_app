// 스모크 테스트: 안읽은 건수의 서버 DB 영속화 검증
//  - DM/방 수신 시 안읽은 건수 증가 + unread_bump 실시간 신호
//  - 오프라인 중 도착한 메시지도 재접속(다른 PC 로그인 시나리오) 시 unread_state로 복원
//  - 채팅창을 열면 unread_clear로 읽음 처리되어 재접속 후 0으로 유지
// 임시 DB + 별도 포트로 격리한다 (실제 chat.db / 실행 중인 서버 무관)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-unread-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8111;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
  console.log('PASS:', msg);
};

const cleanup = () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (loginId) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', loginId }));
    });
    ws.on('message', (raw) => {
      try { inbox.push(JSON.parse(String(raw))); } catch { /* 무시 */ }
    });
    ws.on('error', reject);
    const waitFor = (pred, timeout = 5000) =>
      new Promise((res, rej) => {
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
          if (inbox.some((m) => m.type === 'join_ok')) { clearInterval(iv); res(); }
          else if (inbox.some((m) => m.type === 'join_failed')) { clearInterval(iv); rej(new Error(`${loginId} join_failed`)); }
          else if (Date.now() - start > 5000) { clearInterval(iv); rej(new Error(`${loginId} join 타임아웃`)); }
        }, 20);
      }),
    });
  });

// admin 으로 사용자 등록 후 user_no 를 돌려준다
const register = async (admin, loginId, nickname) => {
  admin.inbox.length = 0;
  admin.send({ type: 'user_upsert', loginId, nickname, isDeleted: false });
  const r = await admin.waitFor((m) => m.type === 'user_upsert_result');
  if (r.ok !== true) throw new Error(`사용자 등록 실패: ${loginId} (${r.reason})`);
  return r.user_no;
};


// 현재 안읽은 건수를 서버에서 새로 조회해 상태를 확인한다
const fetchUnread = async (client) => {
  client.inbox.length = 0;
  client.send({ type: 'unread_query' });
  const state = await client.waitFor((m) => m.type === 'unread_state');
  return state.unread;
};

(async () => {
  let a; let b;
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    a = await connect('admin');
    await a.ready;
    const rootNo = await register(a, 'root', 'root');
    b = await connect('root');
    await b.ready;
    await wait(300);

    // 1. 최초 접속 시 unread_state로 빈 상태가 전달된다
    let unread = await fetchUnread(b);
    assert(Object.keys(unread.room).length === 0, '처음엔 방 안읽은 건수 0');

    // 2. 방 생성 (admin + root + other = 3명 그룹방)
    // NOTE: 1:1은 별도 배지 없이 이 방 스코프 하나로 관리된다(2명 방을 만들면 1:1이 된다).
    // 그룹방으로 만들어 '내 채팅방' 배지 하나만 검증하면 충분하다.
    const otherNo = await register(a, 'other', 'other');
    a.inbox.length = 0;
    a.send({ type: 'room_create', memberNos: [rootNo, otherNo] });
    const created = await a.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;

    // 3. 방 메시지를 받으면 안읽은 건수 증가 + unread_bump 실시간 신호
    b.inbox.length = 0;
    a.send({ type: 'room_message', roomId, text: '첫 방 메시지' });
    const bump = await b.waitFor((m) => m.type === 'unread_bump' && m.scope === 'room');
    assert(String(bump.target) === String(roomId), 'unread_bump에 방 번호 포함');
    unread = await fetchUnread(b);
    assert(unread.room[String(roomId)] === 1, '방 안읽은 건수가 1로 누적');

    // 4. '사용자' 탭에서 연 1:1방도 같은 방 스코프로 배지가 오른다
    a.send({ type: 'dm_room_open', withUserNo: rootNo });
    const opened = await a.waitFor((m) => m.type === 'room_opened' && m.withUserNo === rootNo);
    const oneToOneRoomId = opened.roomId;
    assert(Number.isInteger(oneToOneRoomId), '1:1방 확보 후 방 번호 반환됨');
    a.send({ type: 'room_message', roomId: oneToOneRoomId, text: '첫 1:1 메시지' });
    await wait(400);
    unread = await fetchUnread(b);
    assert(unread.room[String(oneToOneRoomId)] === 1, '1:1방 안읽은 건수가 1로 누적');

    // 5. 오프라인 중 도착한 메시지도 재접속(다른 PC 로그인) 시 복원된다 — 핵심 요구사항
    b.close();
    await wait(400);
    a.send({ type: 'room_message', roomId, text: '오프라인 중 방 메시지' });
    a.send({ type: 'room_message', roomId: oneToOneRoomId, text: '오프라인 중 1:1 메시지' });
    await wait(500);

    b = await connect('root');
    await b.ready;
    await wait(400);
    unread = await fetchUnread(b);
    assert(unread.room[String(roomId)] === 2, '재접속 시 방 안읽은 건수 누적값 복원');
    assert(unread.room[String(oneToOneRoomId)] === 2, '재접속 시 1:1방 안읽은 건수 복원');

    // 6. 채팅창을 열면 unread_clear로 읽음 처리 → 재접속 후 0으로 유지된다
    b.send({ type: 'unread_clear', scope: 'room', target: String(roomId) });
    b.send({ type: 'unread_clear', scope: 'room', target: String(oneToOneRoomId) });
    await wait(400);
    unread = await fetchUnread(b);
    assert(!unread.room[String(roomId)], '읽음 처리 후 방 배지 0');
    b.close();
    await wait(400);
    b = await connect('root');
    await b.ready;
    await wait(400);
    unread = await fetchUnread(b);
    assert(!unread.room[String(roomId)], '읽음 처리한 방은 재접속 후에도 0');
    assert(!unread.room[String(oneToOneRoomId)], '읽음 처리한 1:1방은 재접속 후에도 0');

    // 7. 방을 나가면 해당 방 안읽은 건수가 정리된다
    a.send({ type: 'room_message', roomId, text: '나가기 전 다시 쌓임' });
    await wait(400);
    unread = await fetchUnread(b);
    assert(unread.room[String(roomId)] === 1, '나가기 전 안읽은 건수 재누적');
    b.send({ type: 'room_leave', roomId });
    await wait(500);
    unread = await fetchUnread(b);
    assert(!unread.room[String(roomId)], '방 나가면 안읽은 건수 정리됨');

    console.log('\nUNREAD PERSISTENCE SMOKE PASSED');
    a.close(); b.close();
    await wait(200);
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('테스트 오류:', e && e.message ? e.message : e);
    try { if (a) a.close(); } catch { /* 무시 */ }
    try { if (b) b.close(); } catch { /* 무시 */ }
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(1);
  }
})();