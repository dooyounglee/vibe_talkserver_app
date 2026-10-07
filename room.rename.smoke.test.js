// 스모크 테스트: 방제목 수정 (사용자별 적용) 검증
//  - room_rename 요청 → 고친 본인에게만 my_rooms 로 새 제목 반영
//  - 같은 방의 다른 멤버는 원래 제목 유지
//  - 1:1방/단체방 모두 동일하게 동작, 예외 입력은 거부
// 신 규격: join { loginId }, room_create { memberNos }, dm_room_open { withUserNo }
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rename-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8114;
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
  const clients = [];
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname, stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    const admin = await connect('admin'); clients.push(admin); await admin.ready;

    const register = async (loginId, nickname) => {
      admin.inbox.length = 0;
      admin.send({ type: 'user_upsert', loginId, nickname, isDeleted: false });
      const r = await admin.waitFor((m) => m.type === 'user_upsert_result');
      assert(r.ok === true, `사용자 등록 ${nickname}`);
      return r.user_no;
    };
    const rootNo = await register('root', 'root');
    const otherNo = await register('other', 'other');

    const root = await connect('root'); clients.push(root); await root.ready;
    const other = await connect('other'); clients.push(other); await other.ready;
    await wait(300);

    // ─── 1. 단체방을 만들고 각자 제목을 바꾼다 ───
    admin.inbox.length = 0;
    admin.send({ type: 'room_create', memberNos: [rootNo, otherNo] });
    const created = await admin.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    const autoName = (created.rooms.find((r) => r.roomId === roomId) || {}).displayName;
    assert(autoName === 'admin,other,root', `단체방 생성됨 (자동 제목 "${autoName}")`);

    assert(await renameAndFetch(admin, roomId, 'admin의 제목') === 'admin의 제목',
      '단체방: 수정한 사람에게 새 제목 적용');
    assert(await renameAndFetch(root, roomId, 'root의 제목') === 'root의 제목',
      '같은 방의 다른 멤버도 자기 제목을 별도로 가짐');
    assert(await renameAndFetch(other, roomId, 'other의 제목') === 'other의 제목',
      '나머지 멤버도 각자 제목을 따로 관리');

    assert(await listTitleOf(admin, roomId) === 'admin의 제목', '재조회해도 admin 제목 유지');
    assert(await listTitleOf(root, roomId) === 'root의 제목', '재조회해도 root 제목 유지');
    assert(await listTitleOf(other, roomId) === 'other의 제목', '재조회해도 other 제목 유지');

    // 제목 변경은 본인에게만 my_rooms 로 통지된다 (다른 멤버에게 푸시 없음)
    root.inbox.length = 0;
    await renameAndFetch(admin, roomId, 'admin의 제목2');
    await wait(200);
    assert(!root.inbox.some((m) => m.type === 'my_rooms'), '다른 멤버에게는 my_rooms 갱신이 가지 않음');

    // ─── 2. 1:1방도 동일하게 수정된다 ───
    admin.inbox.length = 0;
    admin.send({ type: 'dm_room_open', withUserNo: rootNo });
    const opened = await admin.waitFor((m) => m.type === 'room_opened' && m.withUserNo === rootNo);
    const oneToOneRoomId = opened.roomId;
    assert(Number.isInteger(oneToOneRoomId), '1:1방 확보 후 방 번호 반환됨');
    assert(opened.withUser === 'root', 'room_opened에 상대 닉네임 포함');
    admin.inbox.length = 0;
    admin.send({ type: 'room_list' });
    const afterOpen = await admin.waitFor((m) => m.type === 'my_rooms');
    const oneToOne = afterOpen.rooms.find((r) => r.roomId === oneToOneRoomId);
    assert(!!oneToOne, '1:1방이 내 목록에 포함됨');
    assert(await renameAndFetch(admin, oneToOneRoomId, 'my admin dm') === 'my admin dm',
      '1:1방도 방제목 수정 가능');
    assert(await listTitleOf(root, oneToOneRoomId) === 'admin',
      '1:1방도 상대방 제목에는 영향 없음 (상대 닉네임 유지)');

    // ─── 3. 예외 처리 ───
    admin.inbox.length = 0;
    admin.send({ type: 'room_rename', roomId, title: '   ' });
    const emptyFail = await admin.waitFor((m) => m.type === 'room_rename_failed');
    assert(emptyFail.reason === 'empty_title', '빈 제목은 거부');

    admin.inbox.length = 0;
    admin.send({ type: 'room_rename', roomId: 99999, title: '없는 방' });
    const notFound = await admin.waitFor((m) => m.type === 'room_rename_failed');
    assert(notFound.reason === 'not_found', '없는 방은 거부');

    // 비멤버는 수정할 수 없다
    await register('outsider', 'outsider');
    const outsider = await connect('outsider'); clients.push(outsider); await outsider.ready;
    outsider.inbox.length = 0;
    outsider.send({ type: 'room_rename', roomId, title: '침입' });
    const notMember = await outsider.waitFor((m) => m.type === 'room_rename_failed');
    assert(notMember.reason === 'not_member', '비멤버는 제목 수정 불가');

    // 30자 초과 입력은 서버가 잘라서 저장한다 (저장 후 조회로 확인)
    const longTitle = '가'.repeat(40);
    const savedLong = await renameAndFetch(admin, roomId, longTitle);
    assert(savedLong.length === 30, `40자 입력은 30자로 잘림 (저장됨: ${savedLong.length}자)`);

    // 잘라 저장된 제목을 원래 자동 제목으로 되돌린다 (사용자별 관리 확인)
    assert(await renameAndFetch(admin, roomId, autoName) === autoName,
      '제목을 자동 이름으로 되돌릴 수 있음');

    console.log('\nROOM RENAME SMOKE PASSED');
    for (const c of clients) c.close();
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
