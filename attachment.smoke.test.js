// 스모크 테스트: 첨부파일 업로드(HTTP) → room_message { fileId } → 방 멤버 수신/히스토리/다운로드
// 임시 DB + 임시 업로드 폴더 + 별도 포트로 격리한다 (실제 chat.db / uploads / 실행 중인 서버 무관)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-attach-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const UPLOAD_DIR = path.join(tmpDir, 'uploads');
const SMOKE_PORT = 8131;
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

    const a = await connect('admin'); clients.push(a); await a.ready;
    a.send({ type: 'user_upsert', loginId: 'root', nickname: 'root', isDeleted: false });
    const reg = await a.waitFor((m) => m.type === 'user_upsert_result');
    const rootNo = reg.user_no;
    const b = await connect('root'); clients.push(b); await b.ready;

    a.send({ type: 'dm_room_open', withUserNo: rootNo });
    const { roomId } = await a.waitFor((m) => m.type === 'room_opened');

    // 1. 업로드: 한글 파일명 + 이미지 MIME
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const up = await upload('스크린샷 1.png', 'image/png', png);
    assert(up.status === 200 && /^[a-f0-9]{32}$/.test(up.body.fileId), '업로드 성공 + fileId 발급');
    assert(up.body.name === '스크린샷 1.png' && up.body.size === png.length && up.body.mime === 'image/png', '업로드 메타 (이름/크기/MIME)');

    // 2. 파일 메시지 전송 → 양쪽 room_message 에 file 포함
    a.inbox.length = 0; b.inbox.length = 0;
    a.send({ type: 'room_message', roomId, fileId: up.body.fileId });
    const got = await b.waitFor((m) => m.type === 'room_message' && m.roomId === roomId);
    assert(got.file && got.file.id === up.body.fileId && got.file.mime === 'image/png', '상대가 첨부 메시지 수신');
    assert(got.text === '스크린샷 1.png', '첨부 메시지 text 는 파일명');
    const last = await b.waitFor((m) => m.type === 'room_last_message' && m.roomId === roomId);
    assert(last.text === '사진', '목록 미리보기는 "사진"');

    // 3. 같은 fileId 재사용 불가
    a.inbox.length = 0;
    a.send({ type: 'room_message', roomId, fileId: up.body.fileId });
    const rejected = await a.waitFor((m) => m.type === 'system' && m.roomId === roomId);
    assert(/첨부파일/.test(rejected.text), '이미 첨부된 fileId 재사용 거부');

    // 4. 히스토리에 file 포함
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId });
    const hist = await a.waitFor((m) => m.type === 'history_room' && m.roomId === roomId);
    assert(hist.messages.length === 1 && hist.messages[0].file?.id === up.body.fileId, '히스토리에 첨부 정보 포함');

    // 5. 다운로드: 바이트 일치 + Content-Disposition
    const dl = await fetch(`${HTTP_URL}/files/${up.body.fileId}?download=1`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert(dl.status === 200 && bytes.equals(png), '다운로드 바이트 일치');
    assert(/^attachment;/.test(dl.headers.get('content-disposition') || ''), 'download=1 이면 attachment');
    assert(dl.headers.get('access-control-allow-origin') === '*', 'CORS 허용');
    const inline = await fetch(`${HTTP_URL}/files/${up.body.fileId}`);
    assert(/^inline;/.test(inline.headers.get('content-disposition') || ''), '기본은 inline (이미지 미리보기)');
    const missing = await fetch(`${HTTP_URL}/files/${'0'.repeat(32)}`);
    assert(missing.status === 404, '없는 파일은 404');
    const traversal = await fetch(`${HTTP_URL}/files/..%2Fsmoke.db`);
    assert(traversal.status === 404, '잘못된 키(경로 탈출 시도)는 404');

    // 6. 일반 파일 → 미리보기 "파일: 이름"
    const doc = await upload('보고서.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test'));
    b.inbox.length = 0;
    a.send({ type: 'room_message', roomId, fileId: doc.body.fileId });
    const lastDoc = await b.waitFor((m) => m.type === 'room_last_message' && m.roomId === roomId);
    assert(lastDoc.text === '파일: 보고서.pdf', '일반 파일 미리보기는 "파일: 이름"');
    b.inbox.length = 0;
    b.send({ type: 'room_list' });
    const rooms = await b.waitFor((m) => m.type === 'my_rooms');
    assert(rooms.rooms.find((r) => r.roomId === roomId)?.lastMessage === '파일: 보고서.pdf', 'my_rooms 미리보기도 "파일: 이름"');

    // 7. 크기 제한 (20MB 초과 → 413)
    const big = await upload('big.bin', 'application/octet-stream', Buffer.alloc(20 * 1024 * 1024 + 1));
    assert(big.status === 413 && big.body.error === 'too_large', '20MB 초과 업로드 거부');

    // 8. 빈 파일 거부
    const empty = await upload('empty.txt', 'text/plain', Buffer.alloc(0));
    assert(empty.status === 400, '빈 파일 거부');

    console.log('\n첨부파일 스모크 테스트 모두 통과');
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
