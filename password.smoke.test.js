// 로그인 비밀번호 + 비번변경(password_change) + 비번초기화(password_reset) end-to-end 스모크
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-password-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8112;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); console.log('PASS:', msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// join 결과(join_ok / join_failed)까지 기다린 클라이언트
const login = (loginId, password) => new Promise((resolve, reject) => {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', loginId, password })));
  ws.on('message', (raw) => { try { inbox.push(JSON.parse(String(raw))); } catch { /* 무시 */ } });
  ws.on('error', reject);
  const waitFor = (pred, timeout = 5000) => new Promise((res, rej) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) { clearInterval(iv); res(hit); }
      else if (Date.now() - start > timeout) { clearInterval(iv); rej(new Error('응답 타임아웃')); }
    }, 20);
  });
  const client = { ws, inbox, waitFor, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
  waitFor((m) => m.type === 'join_ok' || m.type === 'join_failed')
    .then((m) => resolve({ ...client, joined: m.type === 'join_ok', joinMsg: m }))
    .catch(reject);
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

    // admin 초기 비밀번호 = 아이디 (전화번호 없음)
    const bad = await login('admin', 'wrong'); clients.push(bad);
    assert(!bad.joined && bad.joinMsg.reason === 'wrong_password', '틀린 비밀번호는 join_failed(wrong_password)');
    const noPw = await login('admin', undefined); clients.push(noPw);
    assert(!noPw.joined, '비밀번호 없이 join하면 거부');
    const admin = await login('admin', 'admin'); clients.push(admin);
    assert(admin.joined, 'admin 초기 비밀번호 = admin');

    const ask = async (client, payload, resultType) => {
      client.inbox.length = 0;
      client.send(payload);
      return client.waitFor((m) => m.type === resultType);
    };

    // 신규 사용자 초기 비밀번호 = 아이디 + 전화번호 숫자 뒤 4자리
    let r = await ask(admin, { type: 'user_upsert', loginId: 'hong', nickname: '홍길동', phone: '010-1234-5678', isDeleted: false }, 'user_upsert_result');
    assert(r.ok, 'hong 추가');
    const hongNo = r.user_no;
    r = await ask(admin, { type: 'user_upsert', loginId: 'kim', nickname: '김철수', phone: '12', isDeleted: false }, 'user_upsert_result');
    assert(r.ok, 'kim 추가 (전화번호 4자리 미만)');

    assert(!(await login('hong', 'hong')).joined, 'hong: 아이디만으로는 로그인 불가');
    const hong = await login('hong', 'hong5678'); clients.push(hong);
    assert(hong.joined, 'hong 초기 비밀번호 = hong5678');
    const kim = await login('kim', 'kim'); clients.push(kim);
    assert(kim.joined, 'kim 초기 비밀번호 = kim (전화번호 숫자 4자리 미만)');

    // 비번변경: 현재 비밀번호 확인 + 8자 이상 영문·숫자
    r = await ask(hong, { type: 'password_change', currentPassword: 'nope', newPassword: 'newpass99' }, 'password_change_result');
    assert(!r.ok && r.reason === 'wrong_current', '현재 비밀번호가 틀리면 변경 거부');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'short1' }, 'password_change_result');
    assert(!r.ok && r.reason === 'invalid_new', '8자 미만 거부');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'abcdefgh' }, 'password_change_result');
    assert(!r.ok && r.reason === 'invalid_new', '숫자 없는 비밀번호 거부');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'newpass99' }, 'password_change_result');
    assert(r.ok, '비번변경 성공');
    assert(!(await login('hong', 'hong5678')).joined, '변경 후 예전 비밀번호로 로그인 불가');
    assert((await login('hong', 'newpass99')).joined, '변경 후 새 비밀번호로 로그인');

    // 본인 비번초기화: 새 비밀번호 값을 본인에게만 돌려준다
    r = await ask(hong, { type: 'password_reset' }, 'password_reset_result');
    assert(r.ok && r.self === true && r.password === 'hong5678', '본인 초기화 → hong5678');
    assert((await login('hong', 'hong5678')).joined, '초기화 후 아이디+전화번호 뒤4자리로 로그인');

    // 일반 사용자는 다른 계정 초기화 불가
    r = await ask(kim, { type: 'password_reset', targetUserNo: hongNo }, 'password_reset_result');
    assert(!r.ok && r.reason === 'forbidden', '일반 사용자는 다른 계정 초기화 불가');

    // admin은 다른 계정 초기화 가능 (비밀번호 값은 돌려주지 않음)
    await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'another12' }, 'password_change_result');
    r = await ask(admin, { type: 'password_reset', targetUserNo: hongNo }, 'password_reset_result');
    assert(r.ok && r.self === false && r.password === undefined, 'admin이 hong 초기화 (값 미노출)');
    assert((await login('hong', 'hong5678')).joined, 'admin 초기화 후 hong5678로 로그인');

    console.log('\n모든 비밀번호 스모크 테스트 통과');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* 무시 */ } }
    if (server) server.kill();
    await wait(300);
    cleanup();
    process.exit(process.exitCode || 0);
  }
})();
