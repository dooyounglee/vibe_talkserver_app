// room_invite 핸들러 end-to-end 스모크
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { TEST_PHONE, sendJoin } = require('./smoke.auth');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-invite-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8107;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); console.log('PASS:', msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (loginId) => new Promise((resolve, reject) => {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  ws.on('open', () => sendJoin(ws, loginId));
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
        if (inbox.some((m) => m.type === 'join_ok')) { clearInterval(iv); res(); }
        else if (inbox.some((m) => m.type === 'join_failed')) { clearInterval(iv); rej(new Error('join_failed')); }
        else if (Date.now() - start > 5000) { clearInterval(iv); rej(new Error('join 타임아웃')); }
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

    const admin = await connect('admin'); clients.push(admin); await admin.ready;

    const register = async (loginId, nickname) => {
      admin.inbox.length = 0;
      admin.send({ type: 'user_upsert', phone: TEST_PHONE, loginId, nickname, isDeleted: false });
      const r = await admin.waitFor((m) => m.type === 'user_upsert_result');
      assert(r.ok === true, `사용자 등록 ${nickname}`);
      return r.user_no;
    };
    const aliceNo = await register('alice', 'alice');
    const bobNo = await register('bob', 'bob');
    const carolNo = await register('carol', 'carol');

    const alice = await connect('alice'); clients.push(alice); await alice.ready;
    const bob = await connect('bob'); clients.push(bob); await bob.ready;
    const carol = await connect('carol'); clients.push(carol); await carol.ready;

    // 방 생성 (alice + bob)
    alice.send({ type: 'room_create', memberNos: [bobNo] });
    const created = await alice.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    assert(Number.isInteger(roomId), '방 생성됨');

    // 초대 전 메시지 2건
    alice.send({ type: 'room_message', roomId, text: 'pre-1' });
    alice.send({ type: 'room_message', roomId, text: 'pre-2' });
    await wait(400);

    // ─── 초대 ───
    carol.inbox.length = 0;
    alice.inbox.length = 0;
    alice.send({ type: 'room_invite', roomId, memberNos: [carolNo, carolNo, aliceNo] });
    await wait(600);

    const carolHist = carol.inbox.find((m) => m.type === 'history_room' && m.roomId === roomId);
    assert(!!carolHist, '초대받은 사람에게 history_room 전송');
    assert(Array.isArray(carolHist.messages) && carolHist.messages.length === 0,
      '초대 시점 이전 메시지는 전달되지 않음');

    const carolRooms = carol.inbox.filter((m) => m.type === 'my_rooms').pop();
    const carolRoom = carolRooms && carolRooms.rooms.find((r) => r.roomId === roomId);
    assert(!!carolRoom, '초대받은 사람 목록에 방 노출');
    assert(carolRoom.displayName === 'alice,bob,carol', '초대받은 사람 제목 = 닉네임 나열값');

    const membersMsg = alice.inbox.find((m) => m.type === 'room_members' && m.roomId === roomId);
    assert(!!membersMsg && membersMsg.members.length === 3, 'room_members 갱신(3명)');

    const aliceRooms = alice.inbox.filter((m) => m.type === 'my_rooms').pop();
    assert(!!aliceRooms, '초대한 사람에게 my_rooms 갱신');

    // 초대 이후 메시지 → carol에게 보인다
    alice.send({ type: 'room_message', roomId, text: 'post-1' });
    await wait(400);
    carol.inbox.length = 0;
    carol.send({ type: 'room_history', roomId });
    const histAfter = await carol.waitFor((m) => m.type === 'history_room' && m.roomId === roomId);
    assert(histAfter.messages.length === 1 && histAfter.messages[0].text === 'post-1',
      '초대받은 사람은 초대 이후 메시지만 조회');

    alice.inbox.length = 0;
    alice.send({ type: 'room_history', roomId });
    const histAlice = await alice.waitFor((m) => m.type === 'history_room' && m.roomId === roomId);
    assert(histAlice.messages.length === 3, '기존 멤버는 전체 메시지 조회');

    // 이미 멤버 재초대 → 대상 0명 실패 응답
    alice.inbox.length = 0;
    alice.send({ type: 'room_invite', roomId, memberNos: [carolNo] });
    const failed = await alice.waitFor((m) => m.type === 'room_invite_failed');
    assert(failed.reason === 'no_targets', '이미 멤버 재초대는 no_targets 실패');

    // 비멤버는 초대할 수 없다
    admin.inbox.length = 0;
    admin.send({ type: 'room_invite', roomId, memberNos: [bobNo] });
    const notMember = await admin.waitFor((m) => m.type === 'room_invite_failed');
    assert(notMember.reason === 'not_member', '방 멤버가 아니면 초대 불가');

    console.log('\nROOM INVITE SMOKE PASSED');
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
