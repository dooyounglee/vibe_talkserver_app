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
      '접속 시 일괄 히스토리(history_room/history_dm) 미수신'
    );

    // 2. DM 15건 전송 → 채팅창 열람 시 최근 10건 수신
    for (let i = 0; i < 15; i++) {
      a.send({ type: 'dm', to: 'root', text: `dm-${i}` });
    }
    await wait(400);
    a.inbox.length = 0;
    a.send({ type: 'dm_history', withUser: 'root' });
    const dmHist = await a.waitFor((m) => m.type === 'history_dm');
    assert(dmHist.messages.length === 10, 'dm_history 응답이 10건');
    assert(dmHist.messages[0].text === 'dm-5', '가장 최근 10건의 시작점이 dm-5');
    assert(dmHist.messages[9].text === 'dm-14', '최신 dm-14로 끝남');
    assert(dmHist.withUser === 'root', 'withUser 반환');

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

    // 5. 1:1 자동방: dm_history는 방 히스토리를 소스로 (방에서 보낸 메시지 포함)
    a.inbox.length = 0;
    a.send({ type: 'dm', to: 'root', text: 'dm-extra' });
    const roomsMsg = await a.waitFor((m) => m.type === 'my_rooms');
    const oneToOne = roomsMsg.rooms.find(
      (r) => r.memberCount === 2 && r.name === '1:1 admin,root',
    );
    assert(oneToOne, 'DM으로 자동 생성된 1:1방 존재');
    a.send({ type: 'room_message', roomId: oneToOne.roomId, text: 'room-only-msg' });
    await wait(300);
    a.inbox.length = 0;
    a.send({ type: 'dm_history', withUser: 'root' });
    const roomSourced = await a.waitFor(
      (m) => m.type === 'history_dm' && m.withUser === 'root',
    );
    assert(
      roomSourced.messages.some((m) => m.text === 'room-only-msg'),
      'dm_history가 1:1방 히스토리(방에서 보낸 메시지 포함)로 응답'
    );

    // 6. 1:1방이 없는 사용자 쌍 → 빈 배열 (클라이언트는 empty 문구 표시)
    a.send({ type: 'user_upsert', nickname: 'stranger', isDeleted: false });
    await wait(200);
    a.inbox.length = 0;
    a.send({ type: 'dm_history', withUser: 'stranger' });
    const noRoom = await a.waitFor(
      (m) => m.type === 'history_dm' && m.withUser === 'stranger',
    );
    assert(
      Array.isArray(noRoom.messages) && noRoom.messages.length === 0,
      '1:1방이 없으면 빈 배열'
    );

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
