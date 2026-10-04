// 스모크 테스트: 카톡식 읽음 표시 (메시지별 '안 읽은 사람 수')
//  - 1:1: 보낸 메시지에 '1' → 상대가 읽으면 사라짐 → 발신자 재접속 후에도 유지/소멸
//  - 단체: 3명 방에서 보낸 메시지에 '2' → 한 명 읽으면 '1' → 나머지 읽으면 사라짐
//  - read_cursor 가 DB에 영속되므로 로그아웃/재접속 후에도 숫자가 유지된다
// 임시 DB + 별도 포트로 격리한다 (실제 chat.db / 실행 중인 서버 무관)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-readreceipt-'));
const SMOKE_DB = path.join(tmpDir, 'smoke.db');
const SMOKE_PORT = 8099;
const WS_URL = `ws://localhost:${SMOKE_PORT}`;

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    cleanup();
    process.exit(1);
  }
  console.log('PASS:', msg);
};

const cleanup = () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = (nickname) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', nickname }));
    });
    ws.on('message', (raw) => {
      try { inbox.push(JSON.parse(String(raw))); } catch { /* 무시 */ }
    });
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

// 특정 텍스트 메시지의 unreadCount 를 히스토리에서 찾는다
const findUnread = (history, text) => {
  const hit = (history?.messages ?? []).find((m) => m.text === text);
  return hit ? Number(hit.unreadCount) : null;
};

// 채팅창을 연 것처럼 읽음 처리 (클라이언트가 focus 할 때 보내는 신호와 동일)
const markRead = (client, scope, target) => {
  client.send({ type: 'unread_clear', scope, target: String(target) });
};

// 히스토리를 다시 받아와 현재 숫자를 확인한다
const fetchDmHistory = async (client, withUser) => {
  client.inbox.length = 0;
  client.send({ type: 'dm_history', withUser });
  return client.waitFor((m) => m.type === 'history_dm');
};
const fetchRoomHistory = async (client, roomId) => {
  client.inbox.length = 0;
  client.send({ type: 'room_history', roomId });
  return client.waitFor((m) => m.type === 'history_room' && m.roomId === roomId);
};

(async () => {
  let a; let b; let c;
  let server;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: 'ignore',
      env: { ...process.env, VIBE_TEST_DB: SMOKE_DB, PORT: String(SMOKE_PORT) },
    });
    await wait(1000);

    a = await connect('admin');
    await a.ready;
    a.send({ type: 'user_upsert', nickname: 'root', isDeleted: false });
    a.send({ type: 'user_upsert', nickname: 'other', isDeleted: false });
    await wait(300);
    b = await connect('root');
    c = await connect('other');
    await Promise.all([b.ready, c.ready]);
    await wait(300);

    // ─── 1:1 읽음 표시 ───
    // 1. admin 이 root 에게 보냄 → 상대(root)가 안 읽었으므로 admin 화면에 '1'
    a.send({ type: 'dm', to: 'root', text: 'dm-1' });
    await wait(300);
    let hist = await fetchDmHistory(a, 'root');
    assert(findUnread(hist, 'dm-1') === 1, '1:1 보낸 메시지에 안읽음 1 표시');

    // 2. root 가 읽음 처리 → admin 화면 숫자 사라짐 (카톡: 읽으면 '1' 이 없어진다)
    markRead(b, 'dm', 'admin');
    await wait(300);
    hist = await fetchDmHistory(a, 'root');
    assert(findUnread(hist, 'dm-1') === 0, '1:1 상대가 읽으면 숫자 사라짐');

    // 3. root 가 보냄 → admin 이 안 읽었으므로 root 화면에 '1'
    b.send({ type: 'dm', to: 'admin', text: 'dm-2' });
    await wait(300);
    hist = await fetchDmHistory(b, 'admin');
    assert(findUnread(hist, 'dm-2') === 1, '1:1 반대 방향도 안읽음 1 표시');

    // 4. 재접속해도 유지 (DB 영속) — admin 이 아직 안 읽었으므로 '1' 이 살아있어야 한다
    a.close();
    await wait(300);
    a = await connect('admin');
    await a.ready;
    await wait(300);
    hist = await fetchDmHistory(a, 'root');
    assert(findUnread(hist, 'dm-2') === 1, '재접속 후에도 안읽음 숫자 유지 (1:1)');

    // ─── 단체 읽음 표시 ───
    // 5. 3명 그룹방 생성 (admin + root + other)
    a.send({ type: 'room_create', members: ['root', 'other'] });
    const created = await a.waitFor((m) => m.type === 'room_created');
    const roomId = created.roomId;
    b.send({ type: 'room_join', roomId });
    c.send({ type: 'room_join', roomId });
    await wait(400);

    // 6. admin 이 보냄 → 나머지 2명(root, other)이 안 읽었으므로 '2'
    a.send({ type: 'room_message', roomId, text: 'room-1' });
    await wait(300);
    let roomHist = await fetchRoomHistory(a, roomId);
    assert(findUnread(roomHist, 'room-1') === 2, '단체: 3명 방 → 안읽음 2 표시');

    // 7. root 만 읽음 → '1' 로 감소 (카톡: 한 명 확인하면 하나 줄어든다)
    markRead(b, 'room', roomId);
    await wait(300);
    roomHist = await fetchRoomHistory(a, roomId);
    assert(findUnread(roomHist, 'room-1') === 1, '단체: 한 명 읽으면 2 → 1 로 감소');

    // 8. other 도 읽음 → 숫자 완전 소멸
    markRead(c, 'room', roomId);
    await wait(300);
    roomHist = await fetchRoomHistory(a, roomId);
    assert(findUnread(roomHist, 'room-1') === 0, '단체: 전원 읽으면 숫자 사라짐');

    // 9. 읽지 않은 채로 발신자가 재접속 → 숫자가 DB 값 그대로 복원돼야 한다
    a.send({ type: 'room_message', roomId, text: 'room-2' });
    await wait(300);
    a.close();
    await wait(300);
    a = await connect('admin');
    await a.ready;
    await wait(300);
    roomHist = await fetchRoomHistory(a, roomId);
    assert(findUnread(roomHist, 'room-2') === 2, '단체: 재접속 후에도 안읽음 2 유지');

    // 10. 실시간 read_ack 이 발신자에게 도착하는지 (카톡의 실시간 감소 동작)
    markRead(b, 'room', roomId);
    const ack = await a.waitFor(
      (m) => m.type === 'read_ack' && m.scope === 'room' && String(m.target) === String(roomId),
    );
    assert(!!ack && Number(ack.cursors?.root) > 0, '읽음 시 read_ack 실시간 전송 (커서 포함)');

    // 10-1. read_ack 가 클라이언트 재계산에 필요한 값(참여자 + msgId)을 모두 실어 보내는지
    //       이게 없으면 화면 숫자가 '한 명 읽음 → 0' 으로 한 번에 사라진다 (회귀 방지)
    assert(
      Array.isArray(ack.members) && ack.members.includes('admin')
        && ack.members.includes('root') && ack.members.includes('other'),
      'read_ack 에 참여자 목록(members)이 포함됨 — 숫자 재계산에 필수',
    );

    // ─── 실시간 감소: 클라이언트가 실제로 숫자를 "하나씩" 줄이는지 ───
    // 새 메시지를 보내고, 히스토리(msgId 확보) → root 읽음 → other 읽음 순으로 진행한다.
    a.send({ type: 'room_message', roomId, text: 'room-3' });
    await wait(400);
    a.inbox.length = 0;
    a.send({ type: 'room_history', roomId });
    const histAck = await a.waitFor((m) => m.type === 'history_room' && m.roomId === roomId);
    const msg3 = (histAck.messages ?? []).find((m) => m.text === 'room-3');
    assert(
      typeof msg3?.msgId === 'number' && msg3.msgId > 0,
      'room_history 메시지에 msgId 포함 — 숫자 재계산에 필수',
    );
    assert(
      Array.isArray(histAck.members) && histAck.members.length === 3,
      'room_history 에 참여자 목록(members)이 포함됨',
    );
    // 클라이언트 재계산 규칙(useChatSocket.ts countUnread)을 그대로 적용한다.
    // id 를 모르면 null(=계산 불가, 기존 값 유지)을 돌려야 한다.
    // 0 을 돌리면 "한 번에 사라짐" 버그가 되므로 회귀 검증의 핵심이다.
    const clientCount = (cursors, members, sender, msgId) => {
      if (!msgId) return null;
      let n = 0;
      for (const nick of members || []) {
        if (!nick || nick === sender) continue;
        if ((cursors?.[nick] ?? 0) < msgId) n += 1;
      }
      return n;
    };

    // (1) root 만 읽음 → 2 → 1 로 하나씩 감소해야 한다
    markRead(b, 'room', roomId);
    const ack2 = await a.waitFor(
      (m) => m.type === 'read_ack' && m.scope === 'room'
        && Number(m.cursors?.root || 0) >= msg3.msgId
        && Number(m.cursors?.other || 0) < msg3.msgId,
    );
    assert(
      clientCount(ack2.cursors, ack2.members, 'admin', msg3.msgId) === 1,
      '실시간 감소: root 읽음 → 2 에서 1 로 하나만 감소 (한 번에 사라지지 않음)',
    );

    // (2) other 도 읽음 → 0 으로 소멸
    markRead(c, 'room', roomId);
    const ack3 = await a.waitFor(
      (m) => m.type === 'read_ack' && m.scope === 'room'
        && Number(m.cursors?.other || 0) >= msg3.msgId,
    );
    assert(
      clientCount(ack3.cursors, ack3.members, 'admin', msg3.msgId) === 0,
      '실시간 감소: other 까지 읽음 → 숫자 소멸',
    );

    // (3) 읽지 않은 채로 발신자가 재접속 → 히스토리에서도 2 로 복원되어야 한다
    a.send({ type: 'room_message', roomId, text: 'room-4' });
    await wait(300);
    a.close();
    await wait(300);
    a = await connect('admin');
    await a.ready;
    await wait(300);
    roomHist = await fetchRoomHistory(a, roomId);
    assert(findUnread(roomHist, 'room-4') === 2, '단체: 재접속 후에도 안읽음 2 유지');

    // 11. 내가 읽은 뒤에는 상대 메시지도 숫자 0 으로 계산된다 (오버카운트 없음)
    // root 만 room-4 까지 읽으면 → other 입장에서 아직 안 읽은 사람은 other 뿐이므로 1
    markRead(b, 'room', roomId);
    await wait(400);
    roomHist = await fetchRoomHistory(c, roomId);
    assert(findUnread(roomHist, 'room-4') === 1, '상대 입장에서 미열람 메시지는 1 로 계산');

    console.log('\nREAD RECEIPT SMOKE PASSED');
    a.close(); b.close(); c.close();
    await wait(200);
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e && e.message ? e.message : e);
    try { a && a.close(); b && b.close(); c && c.close(); } catch { /* 무시 */ }
    try { if (server) server.kill(); } catch { /* 무시 */ }
    await wait(400);
    cleanup();
    process.exit(1);
  }
})();
