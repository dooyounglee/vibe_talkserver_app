// 스모크 테스트: 서버가 채팅창 열람 시 DB에서 최근 10건을 내려주는지 검증
// 실행 전/후 chat.db를 백업·복원한다 (실데이터 보존)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// 스모크 전용 임시 DB + 포트 (실제 chat.db / 실행 중인 서버와 격리)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8099;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    cleanup();
    process.exit(1);
  }
  console.log('PASS:', msg);
};

const cleanup = () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (nickname) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', nickname }));
    });
    ws.on('message', (raw) => {
      try { inbox.push(JSON.parse(String(raw))); } catch { /* 무시 */ }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`${nickname} 연결 타임아웃`)), 5000);
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
      ready: new Promise((res) => {
        const iv = setInterval(() => {
          if (inbox.some((m) => m.type === 'userlist')) { clearInterval(iv); res(); }
        }, 20);
      }),
    });
  });

(async () => {
  let a; let b;
  let server;
  try {
    // 스모크 전용 서버 실행 (임시 DB + 별도 포트)
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    a = await connect('admin');
    b = await connect('root');
    await Promise.all([a.ready, b.ready]);
    await wait(300);
    if (b.inbox.some((m) => m.type === 'join_failed')) {
      // 미등록 사용자면 admin이 등록 후 재접속
      b.close();
      a.send({ type: 'user_upsert', nickname: 'root', isDeleted: false });
      await wait(200);
      b = await connect('root');
      await b.ready;
      await wait(300);
    }
    assert(
      !b.inbox.some((m) => m.type === 'join_failed'),
      'root 사용자 입장 성공'
    );

    // 1. 접속 시 일괄 히스토리가 오지 않음을 확인
    assert(
      !a.inbox.some((m) => m.type === 'history_room' || m.type === 'history_dm'),
      '접속 시 일괄 히스토리 미수신'
    );

    // 2. '사용자' 탭에서 1:1 창을 열면 방이 확보되고, 그 방으로 recent 10건이 조회된다
    a.send({ type: 'dm_room_open', withUser: 'root' });
    const opened = await a.waitFor((m) => m.type === 'room_opened' && m.withUser === 'root');
    const dmRoomId = opened.roomId;
    assert(Number.isInteger(dmRoomId), '1:1방 확보 후 방 번호 반환됨');
    for (let i = 0; i < 15; i++) {
      a.send({ type: 'room_message', roomId: dmRoomId, text: `dm-${i}` });
    }
    await wait(400);
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId: dmRoomId });
    const dmHist = await a.waitFor((m) => m.type === 'history_room' && m.roomId === dmRoomId);
    assert(dmHist.messages.length === 10, '1:1방 최근 10건 응답');
    assert(dmHist.messages[0].text === 'dm-5', '가장 최근 10건의 시작점이 dm-5');
    assert(dmHist.messages[9].text === 'dm-14', '최신 dm-14로 끝남');

    // 3. 번호방 생성 + 메시지 15건 → room_history로 최근 10건
    a.send({ type: 'room_create', name: '스모크방' });
    const created = await a.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    b.send({ type: 'room_join', roomId });
    await wait(200);
    for (let i = 0; i < 15; i++) {
      a.send({ type: 'room_message', roomId, text: `room-${i}` });
    }
    await wait(400);
    b.inbox.length = 0;
    b.send({ type: 'room_history', roomId });
    const roomHist = await b.waitFor((m) => m.type === 'history_room');
    assert(roomHist.messages.length === 10, 'room_history 응답이 10건');
    assert(roomHist.messages[0].text === 'room-5', '가장 최근 10건의 시작점이 room-5');
    assert(roomHist.messages[9].text === 'room-14', '최신 room-14로 끝남');

    // 4. 멤버가 아니면 빈 히스토리 (누출 방지)
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId: 999999 });
    const missing = await a.waitFor((m) => m.type === 'history_room' && m.roomId === 999999);
    assert(Array.isArray(missing.messages) && missing.messages.length === 0, '없는 방은 빈 히스토리');

    // 5. 1:1방은 한 번 확보되면 같은 방이 재사용된다 (중복방 생성 방지)
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUser: 'root' });
    const reopened = await a.waitFor((m) => m.type === 'room_opened' && m.withUser === 'root');
    assert(reopened.roomId === dmRoomId, '같은 상대는 같은 1:1방을 재사용');
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
    a.send({ type: 'user_upsert', nickname: 'stranger', isDeleted: false });
    await wait(200);
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUser: 'stranger' });
    const fresh = await a.waitFor((m) => m.type === 'room_opened' && m.withUser === 'stranger');
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

    // 7. 미등록 사용자에게는 방을 만들지 않는다
    a.inbox.length = 0;
    a.send({ type: 'dm_room_open', withUser: 'ghost' });
    const denied = await a.waitFor((m) => m.type === 'system');
    assert(String(denied.text).includes('ghost'), '미등록 사용자에는 방 생성 거부');

    console.log('\nSMOKE TEST PASSED');
    a.close(); b.close();
    await wait(200);
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e && e.message ? e.message : e);
    try { a && a.close(); b && b.close(); } catch { /* 무시 */ }
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(1);
  }
})();
