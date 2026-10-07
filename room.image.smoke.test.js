// 스모크 테스트: 채팅방 이미지
//   1:1방 = 목록(my_rooms)에 상대 프로필 사진(peerImage), 상대가 사진을 바꾸면 목록 갱신
//   단체방 = room_image_set 으로 등록/변경/초기화 → 방제목처럼 바꾼 사람에게만 적용 (다른 멤버는 기본 이미지 유지)
//   1:1방/비멤버/이미지 아닌 파일은 거부
// 임시 DB + 임시 업로드 폴더 + 별도 포트로 격리한다 (실제 chat.db / uploads / 실행 중인 서버 무관)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { TEST_PHONE, sendJoin } = require('./smoke.auth');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-roomimg-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const UPLOAD_DIR = path.join(tmpDir, 'uploads');
const SMOKE_PORT = 8139;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;
const HTTP_URL = `http://localhost:${SMOKE_PORT}`;

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
    ready: waitFor((m) => m.type === 'join_ok'),
  });
});

const upload = async (name, mime, bytes) => {
  const res = await fetch(`${HTTP_URL}/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': mime }, body: bytes,
  });
  return { status: res.status, body: await res.json() };
};

const roomOf = (msg, roomId) => (msg.rooms || []).find((r) => r.roomId === roomId);

(async () => {
  const clients = [];
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname, stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, VIBE_UPLOAD_DIR: UPLOAD_DIR, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    const admin = await connect('admin'); clients.push(admin); await admin.ready;
    const register = async (loginId) => {
      admin.inbox.length = 0;
      admin.send({ type: 'user_upsert', phone: TEST_PHONE, loginId, nickname: loginId, isDeleted: false });
      const r = await admin.waitFor((m) => m.type === 'user_upsert_result');
      assert(r.ok === true, `사용자 등록 ${loginId}`);
      return r.user_no;
    };
    const bobNo = await register('bob');
    const carolNo = await register('carol');
    await register('alice');

    const alice = await connect('alice'); clients.push(alice); await alice.ready;
    const bob = await connect('bob'); clients.push(bob); await bob.ready;
    const carol = await connect('carol'); clients.push(carol); await carol.ready;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    // ─── 1:1방: 상대 프로필 사진 ───
    alice.send({ type: 'room_create', memberNos: [bobNo] });
    const dm = await alice.waitFor((m) => m.type === 'room_created');
    const dmId = dm.roomId;
    const dmInfo = roomOf(dm, dmId);
    assert(dmInfo && dmInfo.peerImage === null && dmInfo.roomImage === null, '1:1방 기본: 이미지 없음(기본 이미지)');

    const bobPic = await upload('bob.png', 'image/png', png);
    alice.inbox.length = 0;
    bob.send({ type: 'profile_image_set', fileId: bobPic.body.fileId });
    const aliceList = await alice.waitFor((m) => m.type === 'my_rooms' && roomOf(m, dmId)?.peerImage);
    assert(roomOf(aliceList, dmId).peerImage.id === bobPic.body.fileId, '상대가 프로필을 바꾸면 내 목록의 1:1방 이미지 갱신');

    alice.inbox.length = 0;
    alice.send({ type: 'room_image_set', roomId: dmId, fileId: bobPic.body.fileId });
    const dmReject = await alice.waitFor((m) => m.type === 'room_image_result');
    assert(dmReject.ok === false && dmReject.reason === 'not_group', '1:1방은 방 이미지 변경 거부');

    // ─── 단체방: 등록 / 변경 / 초기화 ───
    alice.inbox.length = 0;
    alice.send({ type: 'room_create', memberNos: [bobNo, carolNo] });
    const group = await alice.waitFor((m) => m.type === 'room_created' && roomOf(m, m.roomId)?.memberCount === 3);
    const gid = group.roomId;
    assert(roomOf(group, gid).roomImage === null && roomOf(group, gid).peerImage === null, '단체방 기본: 이미지 없음(기본 이미지)');

    const pic1 = await upload('room1.png', 'image/png', png);
    bob.inbox.length = 0; carol.inbox.length = 0; alice.inbox.length = 0;
    alice.send({ type: 'room_image_set', roomId: gid, fileId: pic1.body.fileId });
    const set1 = await alice.waitFor((m) => m.type === 'room_image_result');
    assert(set1.ok === true && set1.roomId === gid, '단체방 이미지 등록 성공');
    const aliceList1 = await alice.waitFor((m) => m.type === 'my_rooms' && roomOf(m, gid)?.roomImage);
    assert(roomOf(aliceList1, gid).roomImage.id === pic1.body.fileId, '내 목록에 방 이미지 반영');
    await wait(300);
    assert(!carol.inbox.some((m) => m.type === 'my_rooms'), '다른 멤버에게는 목록 갱신을 보내지 않음');
    carol.send({ type: 'room_list' });
    const carolList = await carol.waitFor((m) => m.type === 'my_rooms');
    assert(roomOf(carolList, gid).roomImage === null, '다른 멤버는 기본 이미지 그대로 (나에게만 적용)');

    const pic2 = await upload('room2.png', 'image/png', png);
    bob.inbox.length = 0; alice.inbox.length = 0;
    bob.send({ type: 'room_image_set', roomId: gid, fileId: pic2.body.fileId });
    await bob.waitFor((m) => m.type === 'my_rooms' && roomOf(m, gid)?.roomImage?.id === pic2.body.fileId);
    alice.send({ type: 'room_list' });
    const aliceList2 = await alice.waitFor((m) => m.type === 'my_rooms');
    assert(roomOf(aliceList2, gid).roomImage.id === pic1.body.fileId, '다른 멤버가 바꿔도 내 이미지는 그대로');

    const txt = await upload('a.txt', 'text/plain', Buffer.from('hi'));
    bob.inbox.length = 0;
    bob.send({ type: 'room_image_set', roomId: gid, fileId: txt.body.fileId });
    const notImg = await bob.waitFor((m) => m.type === 'room_image_result');
    assert(notImg.ok === false && notImg.reason === 'not_image', '이미지 아닌 파일 거부');

    admin.inbox.length = 0;
    admin.send({ type: 'room_image_set', roomId: gid, fileId: null });
    const notMember = await admin.waitFor((m) => m.type === 'room_image_result');
    assert(notMember.ok === false && notMember.reason === 'not_member', '비멤버 거부');

    alice.inbox.length = 0;
    alice.send({ type: 'room_image_set', roomId: gid, fileId: null });
    const reset = await alice.waitFor((m) => m.type === 'room_image_result');
    assert(reset.ok === true, '방 이미지 초기화 성공');
    const aliceList3 = await alice.waitFor((m) => m.type === 'my_rooms' && roomOf(m, gid) && roomOf(m, gid).roomImage === null);
    assert(!!aliceList3, '초기화 후 내 목록은 기본 이미지');
    bob.inbox.length = 0;
    bob.send({ type: 'room_list' });
    const bobList = await bob.waitFor((m) => m.type === 'my_rooms');
    assert(roomOf(bobList, gid).roomImage.id === pic2.body.fileId, '내가 초기화해도 다른 멤버 이미지는 그대로');

    console.log('\n채팅방 이미지 스모크 테스트 모두 통과');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* 무시 */ } }
    if (server) server.kill();
    await wait(300);
    cleanup();
  }
})();
