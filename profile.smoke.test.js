// 스모크 테스트: 프로필 이미지 등록(profile_image_set) → my_profile 갱신 → 재접속 join_ok 유지 → 초기화
// 임시 DB + 임시 업로드 폴더 + 별도 포트로 격리한다 (실제 chat.db / uploads / 실행 중인 서버 무관)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-profile-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const UPLOAD_DIR = path.join(tmpDir, 'uploads');
const SMOKE_PORT = 8137;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;
const HTTP_URL = `http://localhost:${SMOKE_PORT}`;

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
    ready: waitFor((m) => m.type === 'join_ok'),
  });
});

const upload = async (name, mime, bytes) => {
  const res = await fetch(`${HTTP_URL}/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': mime }, body: bytes,
  });
  return { status: res.status, body: await res.json() };
};
(async () => {
  const clients = [];
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname, stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, VIBE_UPLOAD_DIR: UPLOAD_DIR, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    const a = await connect('admin'); clients.push(a);
    const joined = await a.ready;
    assert(joined.profileImage === null, '처음에는 프로필 이미지 없음(기본 이미지)');

    // 1. 이미지 업로드 → 프로필 등록 → my_profile 로 갱신
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const up = await upload('me.png', 'image/png', png);
    a.inbox.length = 0;
    a.send({ type: 'profile_image_set', fileId: up.body.fileId });
    const ok = await a.waitFor((m) => m.type === 'profile_image_result');
    assert(ok.ok === true, '프로필 이미지 등록 성공');
    const prof = await a.waitFor((m) => m.type === 'my_profile');
    assert(prof.profileImage && prof.profileImage.id === up.body.fileId && prof.profileImage.mime === 'image/png', 'my_profile 에 새 이미지');

    // 2. 재접속해도 유지
    const a2 = await connect('admin'); clients.push(a2);
    const rejoined = await a2.ready;
    assert(rejoined.profileImage && rejoined.profileImage.id === up.body.fileId, '재접속 join_ok 에 프로필 이미지 유지');

    // 3. 이미지가 아닌 파일 / 없는 키 거부
    const txt = await upload('a.txt', 'text/plain', Buffer.from('hi'));
    a.inbox.length = 0;
    a.send({ type: 'profile_image_set', fileId: txt.body.fileId });
    const notImg = await a.waitFor((m) => m.type === 'profile_image_result');
    assert(notImg.ok === false && notImg.reason === 'not_image', '이미지 아닌 파일 거부');
    a.inbox.length = 0;
    a.send({ type: 'profile_image_set', fileId: '0'.repeat(32) });
    const missing = await a.waitFor((m) => m.type === 'profile_image_result');
    assert(missing.ok === false && missing.reason === 'not_found', '없는 파일 거부');

    // 4. 초기화 → 다른 소켓(같은 계정)에도 my_profile(null)
    a.inbox.length = 0; a2.inbox.length = 0;
    a.send({ type: 'profile_image_set', fileId: null });
    const reset = await a.waitFor((m) => m.type === 'profile_image_result');
    assert(reset.ok === true, '초기화 성공');
    const other = await a2.waitFor((m) => m.type === 'my_profile');
    assert(other.profileImage === null, '같은 계정 다른 소켓도 기본 이미지로 갱신');

    console.log('\n프로필 이미지 스모크 테스트 모두 통과');
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
