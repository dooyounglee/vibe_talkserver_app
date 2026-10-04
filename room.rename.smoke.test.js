// 스모크 테스트: 방제목 수정 (사용자별 적용) 검증
//  - room_rename 요청 → 고친 본인에게만 my_rooms 로 새 제목 반영
//  - 같은 방의 다른 멤버는 원래 제목 유지
//  - 1:1방/단체방 모두 동일하게 동작, 예외 입력은 거부
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rename-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8098;
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

// 요청을 보내고 갱신된 내 방 목록에서 해당 방 제목을 읽어온다.
const renameAndFetch = async (client, roomId, title) => {
  client.inbox.length = 0;
  client.send({ type: 'room_rename', roomId, title });
  const rooms = await client.waitFor((m) => m.type === 'my_rooms');
  const room = (rooms.rooms || []).find((r) => r.roomId === roomId);
  return room ? room.displayName : null;
};

// 목록을 다시 받아 해당 방의 제목을 돌려준다 (재조회 검증용)
const listTitleOf = async (client, roomId) => {
  client.inbox.length = 0;
  client.send({ type: 'room_list' });
  const rooms = await client.waitFor((m) => m.type === 'my_rooms');
  const room = (rooms.rooms || []).find((r) => r.roomId === roomId);
  return room ? room.displayName : null;
};

(async () => {
  let admin; let root; let other;
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    admin = await connect('admin');
    await admin.ready;
    admin.send({ type: 'user_upsert', nickname: 'root', isDeleted: false });
    await wait(200);
    admin.send({ type: 'user_upsert', nickname: 'other', isDeleted: false });
    await wait(200);
    root = await connect('root');
    await root.ready;
    other = await connect('other');
    await other.ready;
    await wait(300);

    // ─── 1. 단체방을 만들고 각자 제목을 바꾼다 ───
    admin.inbox.length = 0;
    admin.send({ type: 'room_create', members: ['root', 'other'] });
    const created = await admin.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    const autoName = (created.rooms.find((r) => r.roomId === roomId) || {}).displayName;
    assert(!!autoName, `단체방 생성됨 (자동 제목 "${autoName}")`);

    assert(await renameAndFetch(admin, roomId, 'admin의 제목') === 'admin의 제목',
      '단체방: 수정한 사람에게 새 제목 적용');
    assert(await renameAndFetch(root, roomId, 'root의 제목') === 'root의 제목',
      '같은 방의 다른 멤버도 자기 제목을 별도로 가짐');
    assert(await renameAndFetch(other, roomId, 'other의 제목') === 'other의 제목',
      '나머지 멤버도 각자 제목을 따로 관리');

    assert(await listTitleOf(admin, roomId) === 'admin의 제목', '재조회해도 admin 제목 유지');
    assert(await listTitleOf(root, roomId) === 'root의 제목', '재조회해도 root 제목 유지');
    assert(await listTitleOf(other, roomId) === 'other의 제목', '재조회해도 other 제목 유지');

    // ─── 2. 1:1방도 동일하게 수정된다 ───
    admin.inbox.length = 0;
    admin.send({ type: 'dm', to: 'root', text: '첫 DM' });
    await wait(700);
    admin.inbox.length = 0;
    admin.send({ type: 'room_list' });
    const afterDm = await admin.waitFor((m) => m.type === 'my_rooms');
    const oneToOne = afterDm.rooms.find((r) => r.memberCount === 2);
    assert(!!oneToOne, 'DM 후 1:1방 자동 생성됨');
    assert(await renameAndFetch(admin, oneToOne.roomId, 'my admin dm') === 'my admin dm',
      '1:1방도 방제목 수정 가능');
    assert(await listTitleOf(root, oneToOne.roomId) !== 'my admin dm',
      '1:1방도 상대방 제목에는 영향 없음');

    // ─── 3. 예외 처리 ───
    admin.inbox.length = 0;
    admin.send({ type: 'room_rename', roomId, title: '   ' });
    const emptyFail = await admin.waitFor((m) => m.type === 'room_rename_failed');
    assert(emptyFail.reason === 'empty_title', '빈 제목은 거부');

    admin.inbox.length = 0;
    admin.send({ type: 'room_rename', roomId: 99999, title: '없는 방' });
    const notFound = await admin.waitFor((m) => m.type === 'room_rename_failed');
    assert(notFound.reason === 'not_found', '없는 방은 거부');

    // 30자 초과 입력은 서버가 잘라서 저장한다 (저장 후 조회로 확인)
    const longTitle = '가'.repeat(40);
    const savedLong = await renameAndFetch(admin, roomId, longTitle);
    assert(savedLong.length === 30, `40자 입력은 30자로 잘림 (저장됨: ${savedLong.length}자)`);

    // 잘라 저장된 제목을 원래 자동 제목으로 되돌린다 (사용자별 관리 확인)
    assert(await renameAndFetch(admin, roomId, autoName) === autoName,
      '제목을 자동 이름으로 되돌릴 수 있음');

    console.log('\nROOM RENAME SMOKE PASSED');
    admin.close(); root.close(); other.close();
    await wait(200);
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('테스트 오류:', e && e.message ? e.message : e);
    try { if (admin) admin.close(); } catch { /* 무시 */ }
    try { if (root) root.close(); } catch { /* 무시 */ }
    try { if (other) other.close(); } catch { /* 무시 */ }
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(1);
  }
})();