// DM과 1:1 방이 같은 대화를 가리키므로 두 배지가 함께 오르고 함께 사라지는지 검증한다.
// ('사용자' 탭에서 채팅하면 '내 채팅방' 탭에도 안읽은 건수가 떠야 한다)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dmroom-unread-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8097;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); cleanup(); process.exit(1); }
  console.log('PASS:', msg);
};
const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (nickname) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', nickname })));
    ws.on('message', (raw) => { try { inbox.push(JSON.parse(String(raw))); } catch { /* 무시 */ } });
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
    a.send({ type: 'user_upsert', nickname: 'root', isDeleted: false });
    await wait(200);
    b = await connect('root');
    await b.ready;
    await wait(300);

    // 1. DM을 받으면 '사용자' 탭 배지와 '내 채팅방' 1:1 방 배지가 함께 오른다
    b.inbox.length = 0;
    a.send({ type: 'dm', to: 'root', text: '첫 DM' });
    await b.waitFor((m) => m.type === 'unread_bump' && m.scope === 'dm');
    const roomBump = await b.waitFor((m) => m.type === 'unread_bump' && m.scope === 'room');
    assert(!!roomBump, 'DM 수신 시 1:1 방 배지도 함께 증가');
    await wait(300);

    let unread = await fetchUnread(b);
    assert(unread.dm.admin === 1, "'사용자' 탭 DM 안읽은 건수 1");
    const roomKeys = Object.keys(unread.room);
    assert(roomKeys.length === 1 && unread.room[roomKeys[0]] === 1,
      "'내 채팅방' 1:1 방 안읽은 건수도 1로 표시");
    const dmRoomId = roomKeys[0];

    // 2. 다시 DM을 받으면 양쪽 모두 2로 누적된다
    a.send({ type: 'dm', to: 'root', text: '두 번째 DM' });
    await wait(500);
    unread = await fetchUnread(b);
    assert(unread.dm.admin === 2, 'DM 안읽은 건수 누적 2');
    assert(unread.room[dmRoomId] === 2, '1:1 방 안읽은 건수 누적 2');

    // 3. '사용자' 탭에서 읽음 처리하면 1:1 방 배지도 함께 0이 된다
    b.send({ type: 'unread_clear', scope: 'dm', target: 'admin' });
    await wait(500);
    unread = await fetchUnread(b);
    assert(!unread.dm.admin, 'DM 읽음 처리됨');
    assert(!unread.room[dmRoomId], "'사용자' 탭에서 읽으면 1:1 방 배지도 함께 0");

    // 4. 반대쪽 — '내 채팅방'에서 읽음 처리해도 DM 배지가 함께 0이 된다
    a.send({ type: 'dm', to: 'root', text: '세 번째 DM' });
    await wait(500);
    unread = await fetchUnread(b);
    assert(unread.dm.admin === 1 && unread.room[dmRoomId] === 1, '다시 양쪽 1로 복구');
    b.send({ type: 'unread_clear', scope: 'room', target: String(dmRoomId) });
    await wait(500);
    unread = await fetchUnread(b);
    assert(!unread.room[dmRoomId], "'내 채팅방'에서 읽으면 방 배지 0");
    assert(!unread.dm.admin, "'내 채팅방'에서 읽으면 DM 배지도 함께 0");

    console.log('\nDM/ROOM UNREAD SYNC SMOKE PASSED');
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