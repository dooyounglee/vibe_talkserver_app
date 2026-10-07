// 방 이름 자동 생성 규칙 스모크 테스트 (클라이언트 → 서버 → DB → 응답 왕복 검증)
//   1:1방(총 2명) → 서로의 이름이 뜸 / 3명 이상 → 참여자 이름 오름차순 쉼표 연결
//   방 이름을 보내지 않아도 서버가 같은 규칙으로 rooms.name/display_name을 채운다
// 신 규격: join { loginId }, room_create { memberNos } (user_no 기준)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-autoname-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8112;
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

// 방 만들고 응답(room_created + 갱신된 my_rooms)을 돌려주는 헬퍼
const createRoom = async (client, memberNos, extra = {}) => {
  client.inbox.length = 0;
  client.send({ type: 'room_create', memberNos, ...extra });
  const created = await client.waitFor((m) => m.type === 'room_created');
  const room = created.rooms.find((r) => r.roomId === created.roomId);
  return { created, room };
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

    const register = async (loginId, nickname, isDeleted = false) => {
      admin.inbox.length = 0;
      admin.send({ type: 'user_upsert', loginId, nickname, isDeleted });
      const r = await admin.waitFor((m) => m.type === 'user_upsert_result');
      assert(r.ok === true, `사용자 ${isDeleted ? '탈퇴 처리' : '등록'} ${nickname}`);
      return r.user_no;
    };
    const leeNo = await register('lee', 'lee');
    const samNo = await register('sam', 'sam');
    const kimNo = await register('kim', 'kim');
    const parkNo = await register('park', 'park');
    // park는 탈퇴 처리 → 초대 대상에서 자동 제외되어야 한다
    await register('park', 'park', true);

    const lee = await connect('lee'); clients.push(lee); await lee.ready;
    await wait(300);

    // 1. 1:1방: 이름을 아예 안 보내도 생성되고, 각자 상대 닉네임이 뜬다
    const one = await createRoom(lee, [samNo]);
    assert(!!one.created.roomId, '1:1방 생성됨(방 이름 미전달)');
    assert(one.room.name === 'lee,sam', '1:1 rooms.name = 참여자 이름 오름차순 연결');
    assert(one.room.displayName === 'sam', '1:1 방장 화면에는 상대 닉네임');
    assert(one.room.memberCount === 2, '1:1방 인원수는 2');

    const sam = await connect('sam'); clients.push(sam); await sam.ready;
    const samRoom = sam.inbox.filter((m) => m.type === 'my_rooms').pop().rooms[0];
    assert(samRoom.displayName === 'lee', '1:1 상대 화면에는 방장 닉네임');

    // 2. 3명 이상: 참여자 이름 전체(오름차순 쉼표 연결)가 rooms.name/display_name
    const group = await createRoom(lee, [samNo, kimNo]);
    assert(group.room.name === 'kim,lee,sam', '그룹 rooms.name = 이름 오름차순 쉼표 연결');
    assert(group.room.displayName === 'kim,lee,sam', '그룹 표시제목에 모든 참여자 이름');
    assert(group.room.memberCount === 3, '그룹 인원수는 3');

    const kim = await connect('kim'); clients.push(kim); await kim.ready;
    const kimRooms = kim.inbox.filter((m) => m.type === 'my_rooms').pop().rooms;
    const kimGroup = kimRooms.find((r) => r.roomId === group.created.roomId);
    assert(kimGroup && kimGroup.displayName === 'kim,lee,sam', '초대받은 쪽도 전체 참여자 이름 표시');

    // 3. 탈퇴자는 초대 대상에서 제외 → 이름에도 남지 않는다
    const withWithdrawn = await createRoom(lee, [samNo, parkNo]);
    assert(withWithdrawn.room.name === 'lee,sam', '탈퇴자는 멤버/이름에서 제외');
    assert(withWithdrawn.room.memberCount === 2, '탈퇴자는 초대 인원에서 제외');

    // 4. 구버전 클라이언트가 이름을 보내도 같은 규칙값이 진실이다
    const legacy = await createRoom(lee, [kimNo], { name: '옛날이름' });
    assert(legacy.room.name === 'kim,lee', '클라이언트 전달 이름은 무시하고 규칙값 사용');
    assert(legacy.room.displayName === 'kim', '1:1 표시제목은 상대 닉네임 유지');

    // 5. 멤버 0명 방 생성 요청은 서버가 거부한다 (본인/미등록/탈퇴 번호만 보낸 경우도 0명으로 취급)
    for (const memberNos of [[], [leeNo], [99999], [parkNo]]) {
      lee.inbox.length = 0;
      lee.send({ type: 'room_create', memberNos });
      const rejected = await lee.waitFor((m) => m.type === 'system' && /1명 이상/.test(m.text));
      await wait(200);
      assert(!!rejected && !lee.inbox.some((m) => m.type === 'room_created'),
        `멤버 ${JSON.stringify(memberNos)} 방 생성 요청은 거부`);
    }

    console.log('\nROOM AUTONAME SMOKE PASSED');
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
