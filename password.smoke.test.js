// 로그인 비밀번호 + 비번변경(password_change) + 비번초기화(password_reset)
// + 첫 로그인 비밀번호 변경 강제 + 사용자 등록 전화번호 필수/형식 end-to-end 스모크
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

// join 결과(join_ok / join_failed / password_change_required)까지 기다린 클라이언트
const JOIN_RESULTS = ['join_ok', 'join_failed', 'password_change_required'];
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
  waitFor((m) => JOIN_RESULTS.includes(m.type))
    .then((m) => resolve({ ...client, result: m.type, joinMsg: m }))
    .catch(reject);
});

(async () => {
  const clients = [];
  const track = (c) => { clients.push(c); return c; };
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname, stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    // ─── 로그인 실패 문구 통일 ───
    const bad = track(await login('admin', 'wrong'));
    const ghost = track(await login('nobody', 'whatever'));
    assert(bad.result === 'join_failed' && bad.joinMsg.reason === 'invalid_credentials', '틀린 비밀번호 → invalid_credentials');
    assert(ghost.result === 'join_failed' && ghost.joinMsg.reason === 'invalid_credentials', '없는 아이디 → invalid_credentials');
    assert(bad.joinMsg.text === ghost.joinMsg.text && bad.joinMsg.text === '아이디 또는 비밀번호가 올바르지 않습니다.', '두 경우 문구 동일');
    assert(track(await login('admin', undefined)).result === 'join_failed', '비밀번호 없이 join하면 거부');

    // 기존 계정(admin)은 초기값이 세팅돼도 변경 강제 대상 아님
    const admin = track(await login('admin', 'admin'));
    assert(admin.result === 'join_ok', 'admin 초기 비밀번호 = admin, 강제 변경 없음');

    const ask = async (client, payload, resultType) => {
      client.inbox.length = 0;
      client.send(payload);
      return client.waitFor((m) => m.type === resultType);
    };
    const upsert = (payload) => ask(admin, { type: 'user_upsert', isDeleted: false, ...payload }, 'user_upsert_result');

    // ─── 전화번호 필수 + 형식 ───
    let r = await upsert({ loginId: 'hong', nickname: '홍길동' });
    assert(!r.ok && r.reason === 'phone_required', '전화번호 없으면 등록 거부');
    for (const bad of ['1234', '010-12a4-5678', '010--1234-5678', '1012345678', '010-1234-567', '010123456789']) {
      r = await upsert({ loginId: 'hong', nickname: '홍길동', phone: bad });
      assert(!r.ok && r.reason === 'invalid_phone', `잘못된 전화번호 거부: ${bad}`);
    }
    r = await upsert({ loginId: 'hong', nickname: '홍길동', phone: '01012345678' });
    assert(r.ok, 'hong 추가 (하이픈 없이)');
    const hongNo = r.user_no;
    const hongDetail = (await admin.waitFor((m) => m.type === 'userlist_detail')).usersDetail.find((u) => u.user_no === hongNo);
    assert(hongDetail.phone === '010-1234-5678', '전화번호는 하이픈 형식으로 저장');
    r = await upsert({ loginId: 'seoul', nickname: '서울', phone: '021234567' });
    assert(r.ok, '02 지역번호 9자리 허용');

    // ─── 신규 계정: 첫 로그인 시 변경 강제 ───
    assert(track(await login('hong', 'hong')).result === 'join_failed', 'hong: 아이디만으로는 로그인 불가');
    let hong = track(await login('hong', 'hong5678'));
    assert(hong.result === 'password_change_required', '신규 계정 첫 로그인 → password_change_required');
    // 변경 전에는 다른 기능 차단 (myUserNo 없음 → 무시)
    hong.send({ type: 'room_list' });
    hong.send({ type: 'password_reset' });
    await wait(300);
    assert(!hong.inbox.some((m) => m.type === 'my_rooms' || m.type === 'password_reset_result' || m.type === 'join_ok'), '변경 전에는 다른 요청 무시');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'hong5678' }, 'password_change_result');
    assert(!r.ok && r.reason === 'same_as_current', '초기화값 그대로는 변경 불가');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'hongpass1' }, 'password_change_result');
    assert(r.ok, '강제 변경 성공');
    await hong.waitFor((m) => m.type === 'join_ok');
    assert(true, '변경 직후 join_ok로 입장');
    assert((track(await login('hong', 'hongpass1'))).result === 'join_ok', '다음 로그인은 강제 없음');

    // ─── 초기화 후: 강제 변경 + 초기화 전 비밀번호 재사용 금지 ───
    hong = track(await login('hong', 'hongpass1'));
    r = await ask(hong, { type: 'password_reset' }, 'password_reset_result');
    assert(r.ok && r.self === true && r.password === 'hong5678', '본인 초기화 → hong5678');
    hong = track(await login('hong', 'hong5678'));
    assert(hong.result === 'password_change_required', '초기화 후 첫 로그인 → 변경 강제');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'hongpass1' }, 'password_change_result');
    assert(!r.ok && r.reason === 'same_as_previous', '초기화 전 비밀번호로는 변경 불가');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'hongpass2' }, 'password_change_result');
    assert(r.ok, '다른 비밀번호로 변경 성공');

    // admin이 연속 2번 초기화해도 '초기화 전 비밀번호'는 처음 값(hongpass2) 유지
    r = await ask(admin, { type: 'password_reset', targetUserNo: hongNo }, 'password_reset_result');
    assert(r.ok && r.self === false && r.password === undefined, 'admin이 hong 초기화 (값 미노출)');
    await ask(admin, { type: 'password_reset', targetUserNo: hongNo }, 'password_reset_result');
    hong = track(await login('hong', 'hong5678'));
    assert(hong.result === 'password_change_required', 'admin 초기화 후에도 변경 강제');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'hongpass2' }, 'password_change_result');
    assert(!r.ok && r.reason === 'same_as_previous', '두 번 초기화해도 초기화 전 비밀번호 재사용 불가');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hong5678', newPassword: 'hongpass1' }, 'password_change_result');
    assert(r.ok, '그 전전 비밀번호는 허용 (직전 1개만 금지)');

    // ─── 일반 변경 규칙 ───
    hong = track(await login('hong', 'hongpass1'));
    r = await ask(hong, { type: 'password_change', currentPassword: 'nope', newPassword: 'newpass99' }, 'password_change_result');
    assert(!r.ok && r.reason === 'wrong_current', '현재 비밀번호가 틀리면 변경 거부');
    r = await ask(hong, { type: 'password_change', currentPassword: 'hongpass1', newPassword: 'abcdefgh' }, 'password_change_result');
    assert(!r.ok && r.reason === 'invalid_new', '숫자 없는 비밀번호 거부');

    // 일반 사용자는 다른 계정 초기화 불가
    const seoul = track(await login('seoul', 'seoul4567'));
    assert(seoul.result === 'password_change_required', 'seoul 초기 비밀번호 = seoul4567');
    await ask(seoul, { type: 'password_change', currentPassword: 'seoul4567', newPassword: 'seoulpass1' }, 'password_change_result');
    await seoul.waitFor((m) => m.type === 'join_ok');
    r = await ask(seoul, { type: 'password_reset', targetUserNo: hongNo }, 'password_reset_result');
    assert(!r.ok && r.reason === 'forbidden', '일반 사용자는 다른 계정 초기화 불가');

    // ─── 첫 로그인 전 전화번호 수정 → 초기 비밀번호도 새 번호 기준 ───
    r = await upsert({ loginId: 'kim', nickname: '김철수', phone: '010-1111-2222' });
    assert(r.ok, 'kim 추가');
    r = await upsert({ loginId: 'kim', nickname: '김철수', phone: '010-1111-3333' });
    assert(r.ok, 'kim 전화번호 수정');
    assert(track(await login('kim', 'kim2222')).result === 'join_failed', '예전 번호 기준 초기 비밀번호는 무효');
    assert(track(await login('kim', 'kim3333')).result === 'password_change_required', '새 번호 기준 초기 비밀번호로 로그인');

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
