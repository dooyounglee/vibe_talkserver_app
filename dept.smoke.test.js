// 부서관리(dept_upsert) + 사용자 부서 지정 end-to-end 스모크
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dept-smoke-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8108;
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
    await admin.waitFor((m) => m.type === 'dept_list');
    assert(true, 'admin은 join 시 dept_list 수신');

    const deptUpsert = async (payload) => {
      admin.inbox.length = 0;
      admin.send({ type: 'dept_upsert', ...payload });
      return admin.waitFor((m) => m.type === 'dept_upsert_result');
    };
    const userUpsert = async (payload) => {
      admin.inbox.length = 0;
      admin.send({ type: 'user_upsert', isDeleted: false, ...payload });
      return admin.waitFor((m) => m.type === 'user_upsert_result');
    };
    const latestDepts = async () => (await admin.waitFor((m) => m.type === 'dept_list')).depts;

    // 등록
    const dev = await deptUpsert({ deptCode: 'D001', deptName: '개발팀', sortOrder: 2, isDeleted: false });
    assert(dev.ok === true && Number.isInteger(dev.deptNo), '부서 등록 개발팀');
    const sales = await deptUpsert({ deptCode: 'D002', deptName: '영업팀', sortOrder: 1, isDeleted: false });
    assert(sales.ok === true, '부서 등록 영업팀');
    let list = await latestDepts();
    assert(list.length === 2 && list[0].deptName === '영업팀', 'dept_list 정렬순서 반영');

    // 중복/검증
    assert((await deptUpsert({ deptCode: 'D001', deptName: 'x팀', sortOrder: 0 })).reason === 'code_taken', '코드 중복 거부');
    assert((await deptUpsert({ deptCode: 'D009', deptName: '개발팀', sortOrder: 0 })).reason === 'name_taken', '이름 중복 거부');
    assert((await deptUpsert({ deptCode: '한글', deptName: 'y팀', sortOrder: 0 })).reason === 'invalid_code', '코드 형식 거부');

    // 수정 (코드는 불변)
    const renamed = await deptUpsert({ deptNo: dev.deptNo, deptCode: 'ZZZ', deptName: '개발1팀', sortOrder: 3, isDeleted: false });
    assert(renamed.ok === true, '부서 수정');
    list = await latestDepts();
    const devRow = list.find((d) => d.deptNo === dev.deptNo);
    assert(devRow.deptName === '개발1팀' && devRow.deptCode === 'D001' && devRow.sortOrder === 3, '수정 반영 + 코드 불변');

    // 사용자에게 부서 지정
    const u = await userUpsert({ loginId: 'alice', nickname: 'alice', deptNo: dev.deptNo });
    assert(u.ok === true, '사용자 등록 + 부서 지정');
    const detail = await admin.waitFor((m) => m.type === 'userlist_detail');
    assert(detail.usersDetail.find((x) => x.loginId === 'alice').deptNo === dev.deptNo, 'userlist_detail에 deptNo 포함');
    list = await latestDepts();
    assert(list.find((d) => d.deptNo === dev.deptNo).memberCount === 1, '부서 인원수 갱신');

    // 소속 인원 있는 부서 미사용 차단
    const blocked = await deptUpsert({ deptNo: dev.deptNo, deptName: '개발1팀', sortOrder: 3, isDeleted: true });
    assert(blocked.ok === false && blocked.reason === 'has_members', '소속 인원 있으면 미사용 차단');

    // 인원 0명 부서 미사용 → 복구
    const off = await deptUpsert({ deptNo: sales.deptNo, deptName: '영업팀', sortOrder: 1, isDeleted: true });
    assert(off.ok === true, '인원 0명 부서 미사용 처리');
    list = await latestDepts();
    assert(list.find((d) => d.deptNo === sales.deptNo).isDeleted === true, '미사용 상태 반영');

    // 미사용 부서는 사용자에게 지정 불가
    const bad = await userUpsert({ loginId: 'bob', nickname: 'bob', deptNo: sales.deptNo });
    assert(bad.ok === false && bad.reason === 'invalid_dept', '미사용 부서 지정 거부');

    const on = await deptUpsert({ deptNo: sales.deptNo, deptName: '영업팀', sortOrder: 1, isDeleted: false });
    assert(on.ok === true, '미사용 부서 복구');
    assert((await userUpsert({ loginId: 'bob', nickname: 'bob', deptNo: sales.deptNo })).ok === true, '복구 후 지정 가능');

    // deptNo 생략 시 기존 부서 유지, null이면 해제
    await userUpsert({ loginId: 'bob', nickname: 'bob2' });
    let d2 = await admin.waitFor((m) => m.type === 'userlist_detail');
    assert(d2.usersDetail.find((x) => x.loginId === 'bob').deptNo === sales.deptNo, 'deptNo 생략 시 유지');
    await userUpsert({ loginId: 'bob', nickname: 'bob2', deptNo: null });
    d2 = await admin.waitFor((m) => m.type === 'userlist_detail');
    assert(d2.usersDetail.find((x) => x.loginId === 'bob').deptNo === null, 'deptNo null이면 해제');

    // 비admin은 부서 관리 불가 + dept_list 미수신
    const alice = await connect('alice'); clients.push(alice); await alice.ready;
    alice.send({ type: 'dept_upsert', deptCode: 'D100', deptName: '해킹팀', sortOrder: 0 });
    const sys = await alice.waitFor((m) => m.type === 'system' && /admin만/.test(m.text));
    assert(!!sys, '비admin dept_upsert 거부');
    assert(!alice.inbox.some((m) => m.type === 'dept_list' || m.type === 'dept_upsert_result'), '비admin은 dept_list 미수신');

    console.log('\nDEPT SMOKE PASSED');
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
