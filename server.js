// WebSocket 채팅 서버 생성
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SQLite 데이터베이스 (메시지/방 저장/조회) — user_no PK + login_id 체제
const {
  saveMessage,
  registerFile,
  getFile,
  attachFile,
  previewTextOf,
  createRoom,
  joinMemberNames,
  getRoom,
  isRoomActive,
  isMember,
  ensureOneToOneRoom,
  addMember,
  inviteMembers,
  removeMember,
  getRoomMembers,
  getRoomMemberNos,
  getEarliestMemberExcept,
  transferOwner,
  getMyRooms,
  setRoomDisplayName,
  softDeleteRoom,
  closeRoomIfEmpty,
  getRoomHistory,
  getRoomMessagesPage,
  getRoomMessagesAround,
  searchRoomMessages,
  getUserByNo,
  getUserByLoginId,
  upsertUser,
  renameUser,
  setUserProfileImage,
  isWithdrawnByNo,
  isRegisteredNo,
  getAllUsers,
  getAllUsersDetail,
  getAllDepts,
  upsertDept,
  bumpUnread,
  getUnreadMap,
  clearUnread,
  clearUnreadForRoom,
  markRead,
  getReadCursors,
  clearReadCursor,
  getLatestRoomMessageId,
  countUnreadForMessage,
  decorateUnreadCounts,
  isAdminNo,
  toUserNo,
} = require('./db');

// 포트 8080에서 서버 실행 (테스트 시 PORT로 재지정 가능)
// 같은 포트에서 HTTP(첨부파일 업로드/다운로드)와 WebSocket(채팅)을 함께 받는다.
const PORT = Number(process.env.PORT) || 8080;

// ─── 첨부파일 (HTTP) ───
//   POST /upload?name=<파일명>   본문 = 파일 바이트, Content-Type = 파일 MIME
//        → { fileId, name, size, mime }  (이후 room_message { fileId } 로 방에 첨부)
//   GET  /files/<fileId>[?download=1]  → 파일 바이트 (download=1 이면 attachment)
// fileId는 추측 불가능한 랜덤 키(128bit)라 URL 자체가 열람 권한 역할을 한다.
const UPLOAD_DIR = process.env.VIBE_UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const FILE_KEY_RE = /^[a-f0-9]{32}$/;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 파일명 정리: 경로 구분자/제어문자 제거, 최대 200자
function sanitizeFileName(raw) {
  const name = String(raw ?? '').replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 200);
  return name || 'file';
}

function handleUpload(req, res, url) {
  const name = sanitizeFileName(url.searchParams.get('name'));
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().slice(0, 100)
    || 'application/octet-stream';
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: 'too_large', maxBytes: MAX_UPLOAD_BYTES });
    req.resume();
    return;
  }
  const key = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(UPLOAD_DIR, key);
  const out = fs.createWriteStream(filePath);
  let size = 0;
  let failed = false;
  const fail = (status, error) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(filePath, { force: true }, () => {});
    sendJson(res, status, { error, maxBytes: MAX_UPLOAD_BYTES });
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      fail(413, 'too_large');
      req.unpipe(out);
      req.resume();
    }
  });
  req.on('error', () => fail(400, 'upload_failed'));
  out.on('error', () => fail(500, 'write_failed'));
  out.on('finish', () => {
    if (failed) return;
    if (size === 0) {
      fail(400, 'empty');
      return;
    }
    try {
      registerFile({ key, name, size, mime, timestamp: Date.now() });
    } catch (e) {
      console.error('첨부파일 등록 실패:', e);
      fail(500, 'register_failed');
      return;
    }
    console.log(`첨부파일 업로드 ${key} "${name}" (${size} bytes, ${mime})`);
    sendJson(res, 200, { fileId: key, name, size, mime });
  });
  req.pipe(out);
}

function handleDownload(req, res, key, url) {
  const file = FILE_KEY_RE.test(key) ? getFile(key) : null;
  const filePath = file ? path.join(UPLOAD_DIR, file.key) : null;
  if (!file || !fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
  res.writeHead(200, {
    'Content-Type': file.mime,
    'Content-Length': file.size,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  // 클라이언트(vite dev / tauri webview)는 다른 origin이므로 CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/upload') {
    handleUpload(req, res, url);
    return;
  }
  const m = url.pathname.match(/^\/files\/([^/]+)$/);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    handleDownload(req, res, m[1], url);
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
});

const wss = new WebSocket.Server({ server });
server.listen(PORT);

// 클라이언트별 user_no 저장 (WebSocket 인스턴스 -> user_no)
const clients = new Map();
// 소켓별 입장 방 집합 (발송 스코프용 캐시, 권한 판정은 항상 DB 기준)
const wsRooms = new Map();

// ─── 내 상태 전파 (status_set): user_no → 상태 ───
// 접속 중인 사용자의 기본값은 online. 드롭다운 변경(status_set)으로 바뀌고,
// 접속 해제 시 offline으로 확정되며, 재접속(join) 시 다시 기본값 online이 된다.
const statusOverrides = new Map();
const MY_STATUSES = new Set(['online', 'offline', 'meeting', 'busy', 'away']);

// user_no의 현재 상태: 직접 지정된 값이 있으면 그대로, 없으면 접속 여부로 online/offline 판단
function statusOfUser(no) {
  const n = Number(no);
  const override = statusOverrides.get(n);
  if (override) return override;
  for (const v of clients.values()) {
    if (Number(v) === n) return 'online';
  }
  return 'offline';
}

// 등록된 전체 사용자별 상태맵 (userlist에 userStatuses로 실어 보낸다)
function buildUserStatuses() {
  const statuses = {};
  for (const u of getAllUsers()) {
    const no = Number(u.user_no);
    if (Number.isInteger(no) && no > 0) statuses[no] = statusOfUser(no);
  }
  return statuses;
}

function myUserNo(ws) {
  return toUserNo(clients.get(ws));
}
function myProfile(ws) {
  const no = myUserNo(ws);
  return no ? getUserByNo(no) : null;
}

function trackJoin(ws, roomId) {
  if (!wsRooms.has(ws)) wsRooms.set(ws, new Set());
  wsRooms.get(ws).add(roomId);
}

function trackLeave(ws, roomId) {
  const set = wsRooms.get(ws);
  if (set) set.delete(roomId);
}

function trackClear(ws) {
  wsRooms.delete(ws);
}

// 모든 클라이언트에게 메시지 브로드캐스트
function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 특정 방 멤버에게만 메시지 발송 (권한 판정은 항상 DB 기준)
// 채팅창 히스토리 한 페이지 (msgId 커서) + 안 읽은 수 장식
// opts: { beforeId, afterId, limit } — 생략 시 최신 페이지
const HISTORY_PAGE_SIZE = 30;
// 채팅창 메시지 검색어 최대 길이
const SEARCH_KEYWORD_MAX = 50;
function buildRoomHistoryPage(roomId, viewerNo, opts = {}) {
  const page = getRoomMessagesPage(roomId, viewerNo, { limit: HISTORY_PAGE_SIZE, ...opts });
  return {
    hasMore: page.hasMore,
    messages: decorateUnreadCounts('room', String(roomId), page.messages, getRoomMemberNos(roomId)),
  };
}

function broadcastToRoom(roomId, message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    const no = myUserNo(client);
    if (!no) return;
    if (!isMember(roomId, no)) return;
    trackJoin(client, roomId);
    client.send(payload);
  });
}

/** read_ack 에 실어 보낼 참여자 목록 (room = 방 멤버 user_no) */
function readAckParticipants(scope, target) {
  const roomId = Number(target);
  if (!Number.isInteger(roomId)) return [];
  return getRoomMemberNos(roomId);
}

// ─── 읽음 변경 알림 (카톡의 '1' 숫자가 실시간으로 줄어드는 동작) ───
// 누군가 대화를 읽으면 그 대화의 모든 참여자에게 알려 준다.
// 각 클라이언트는 자신이 보낸 메시지의 숫자만 다시 계산해 갱신한다.
function broadcastReadAck(scope, target) {
  // 최신 커서 맵을 함께 실어 보내면 클라이언트가 재요청 없이 숫자를 갱신할 수 있다.
  // members(참여자)도 함께 실어 보낸다 — 클라이언트가 "아직 안 읽은 사람 수"를
  // 계산하려면 '몇 명인지'(참여자 목록)와 '누가 어디까지 읽었는지'(cursors) 둘 다 필요하고,
  // 둘 중 하나가 비면 숫자가 0으로 잘못 계산되어 한 번에 사라진다.
  const payload = JSON.stringify({
    type: 'read_ack',
    scope,
    target: String(target),
    cursors: getReadCursors(scope, String(target)),
    members: readAckParticipants(scope, String(target)),
  });
  const roomId = Number(target);
  if (!Number.isInteger(roomId)) return;
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    const no = myUserNo(client);
    if (!no || !isMember(roomId, no)) return;
    client.send(payload);
  });
}

// 등록된 전체 사용자 목록 + 현재 접속중 목록 + 사용자별 상태를 전체 클라이언트에게 전송
// users: [{user_no, nickname}], onlineUsers: [user_no], userStatuses: {user_no: status}
// admin 접속자에게는 탈퇴 포함 상세(usersDetail)도 개별 전송
function broadcastUserList() {
  const onlineUsers = Array.from(clients.values()).map((v) => Number(v)).filter((n) => Number.isInteger(n));
  const users = getAllUsers();
  broadcast({
    type: "userlist",
    users,
    onlineUsers,
    userStatuses: buildUserStatuses(),
  });
  // admin에게는 전체(탈퇴 포함) 상세 목록 추가 전송
  try {
    const detail = getAllUsersDetail();
    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (!isAdminNo(myUserNo(client))) return;
      client.send(JSON.stringify({ type: 'userlist_detail', usersDetail: detail }));
    });
  } catch (e) {
    console.error('admin 상세 목록 전송 실패:', e);
  }
}

// 부서 목록(미사용 포함 + 인원수)은 admin에게만 전송
function sendDeptList(client) {
  if (client.readyState !== WebSocket.OPEN) return;
  if (!isAdminNo(myUserNo(client))) return;
  client.send(JSON.stringify({ type: 'dept_list', depts: getAllDepts() }));
}
function broadcastDeptList() {
  try {
    wss.clients.forEach(sendDeptList);
  } catch (e) {
    console.error('부서 목록 전송 실패:', e);
  }
}

// 그룹 채팅 기록 조회 — 전체채팅 제거로 더 이상 사용하지 않음 (기존 DB 행은 보존)
// function getRecentGroupHistory() — deleted

// 접속 시 DM 기록 일괄 전송도 제거 — 채팅창 열람 시 dm_history 요청으로 대체

// 새로운 클라이언트 연결 시
wss.on('connection', (ws) => {
  console.log('새로운 클라이언트가 연결됨');

  // 클라이언트가 메시지를 받을 때
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // JOIN 메시지 처리: login_id로 입장, 내부는 user_no, 화면은 nickname
      if (data.type === 'join') {
        const loginId = String(data.loginId ?? data.login_id ?? data.id ?? '').trim();
        if (!loginId) {
          ws.send(JSON.stringify({ type: 'join_failed', reason: 'empty', text: '아이디를 입력하세요.' }));
          return;
        }
        const user = getUserByLoginId(loginId);
        if (!user) {
          ws.send(JSON.stringify({ type: 'join_failed', reason: 'not_registered', text: '등록된 사용자가 아닙니다. 관리자에게 문의하세요' }));
          return;
        }
        if (user.isDeleted) {
          ws.send(JSON.stringify({ type: 'join_failed', reason: 'withdrawn', text: '탈퇴한 사용자입니다' }));
          return;
        }
        clients.set(ws, user.user_no);
        // 재접속 시 상태 기본값은 online (이전 접속에서 남은 override 제거)
        statusOverrides.delete(Number(user.user_no));
        console.log(`user_no=${user.user_no}(${user.nickname}) 입장`);

        trackClear(ws);
        const myRooms = getMyRooms(user.user_no);
        for (const r of myRooms) trackJoin(ws, r.roomId);

        // 개인 응답을 먼저 보낸다 — join_ok를 userlist보다 먼저 보내야
        // 클라이언트가 myUserNo를 설정한 상태에서 사용자 목록을 처리할 수 있다.
        // (join_ok에 표시용 닉네임 포함 — 클라는 user_no를 키로, nickname을 표시로 쓴다)
        ws.send(JSON.stringify({ type: 'join_ok', user_no: user.user_no, loginId: user.loginId, nickname: user.nickname, profileImage: user.profileImage }));
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: myRooms }));
        ws.send(JSON.stringify({ type: 'unread_state', unread: getUnreadMap(user.user_no) }));
        if (isAdminNo(user.user_no)) {
          ws.send(JSON.stringify({ type: 'userlist_detail', usersDetail: getAllUsersDetail() }));
          sendDeptList(ws);
        }

        // 이후 브로드캐스트 — 입장 인사 + 사용자 목록 갱신
        broadcast({ type: 'system', text: `${user.nickname}님이 입장했습니다` });
        broadcastUserList();
      }

      // ─── 내 상태 전파: 드롭다운에서 고른 상태를 전체에 알린다 ───
      else if (data.type === 'status_set') {
        const me = myUserNo(ws);
        if (!me) return;
        const status = String(data.status ?? '');
        if (!MY_STATUSES.has(status)) return;
        statusOverrides.set(me, status);
        broadcastUserList();
      }

      // ─── 사용자 관리: 추가/수정 (admin=user_no 1 전용) ───
      // login_id(불변) + nickname + phone + user_name + 탈퇴여부
      else if (data.type === 'user_upsert') {
        const me = myUserNo(ws);
        if (!me) return;
        if (!isAdminNo(me)) {
          ws.send(JSON.stringify({ type: 'system', text: '사용자 관리는 admin만 할 수 있습니다.' }));
          return;
        }
        const result = upsertUser({
          loginId: data.loginId ?? data.login_id ?? data.id,
          nickname: data.nickname,
          phone: data.phone ?? null,
          userName: data.userName ?? data.user_name ?? null,
          timestamp: Date.now(),
          isDeleted: data.isDeleted === true || data.is_deleted === 1 || data.isDeleted === 1,
          deptNo: data.deptNo,
        });
        if (!result.ok) {
          const texts = {
            invalid_login_id: '아이디는 영문+숫자, 최대 20자입니다.',
            invalid_nickname: '닉네임을 입력하세요. (최대 20자)',
            login_id_taken: '이미 사용 중인 아이디입니다. (탈퇴 포함)',
            nickname_taken: '이미 사용 중인 닉네임입니다. (탈퇴 포함)',
            admin_protected: 'admin은 변경할 수 없습니다.',
            invalid_dept: '사용 중인 부서만 선택할 수 있습니다.',
          };
          ws.send(JSON.stringify({ type: 'user_upsert_result', ok: false, reason: result.reason, text: texts[result.reason] || '사용자 저장에 실패했습니다' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'user_upsert_result', ok: true, user_no: result.user_no }));
        broadcastUserList();
        broadcastDeptList(); // 부서별 인원수 갱신
      }

      // ─── 부서 관리: 추가/수정/미사용 (admin 전용) ───
      else if (data.type === 'dept_upsert') {
        const me = myUserNo(ws);
        if (!me) return;
        if (!isAdminNo(me)) {
          ws.send(JSON.stringify({ type: 'system', text: '부서 관리는 admin만 할 수 있습니다.' }));
          return;
        }
        const result = upsertDept({
          deptNo: data.deptNo,
          deptCode: data.deptCode,
          deptName: data.deptName,
          sortOrder: data.sortOrder,
          isDeleted: data.isDeleted === true,
          timestamp: Date.now(),
        });
        if (!result.ok) {
          const texts = {
            invalid_code: '부서코드는 영문/숫자/_/-, 최대 20자입니다.',
            invalid_name: '부서명을 입력하세요. (최대 30자)',
            invalid_sort: '정렬순서는 정수로 입력하세요.',
            code_taken: '이미 사용 중인 부서코드입니다. (미사용 포함)',
            name_taken: '이미 사용 중인 부서명입니다. (미사용 포함)',
            has_members: `소속 사용자 ${result.memberCount ?? ''}명이 있어 미사용 처리할 수 없습니다.`,
            not_found: '부서를 찾을 수 없습니다.',
          };
          ws.send(JSON.stringify({ type: 'dept_upsert_result', ok: false, reason: result.reason, text: texts[result.reason] || '부서 저장에 실패했습니다' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'dept_upsert_result', ok: true, deptNo: result.deptNo }));
        broadcastDeptList();
      }

      // ─── 닉네임 변경 (본인 + admin) ───
      else if (data.type === 'user_rename') {
        const me = myUserNo(ws);
        if (!me) return;
        const result = renameUser({
          targetNo: data.targetUserNo ?? data.user_no ?? data.targetNo ?? me,
          newNickname: data.newNickname ?? data.nickname,
          requesterNo: me,
        });
        if (!result.ok) {
          const texts = {
            invalid_user: '대상 사용자가 올바르지 않습니다.',
            invalid_nickname: '닉네임을 입력하세요. (최대 20자)',
            forbidden: '본인의 닉네임만 변경할 수 있습니다.',
            admin_protected: 'admin 닉네임은 변경할 수 없습니다.',
            not_found: '사용자를 찾을 수 없습니다.',
            nickname_taken: '이미 사용 중인 닉네임입니다. (탈퇴 포함)',
          };
          ws.send(JSON.stringify({ type: 'user_rename_result', ok: false, reason: result.reason, text: texts[result.reason] || '닉네임 변경에 실패했습니다' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'user_rename_result', ok: true, user_no: result.user_no }));
        broadcastUserList();
        // 본인 표시 갱신용
        const updated = getUserByNo(result.user_no);
        for (const [client, no] of clients.entries()) {
          if (Number(no) !== Number(result.user_no)) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(JSON.stringify({ type: 'my_profile', user_no: updated.user_no, loginId: updated.loginId, nickname: updated.nickname, profileImage: updated.profileImage }));
          client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(updated.user_no) }));
        }
      }
      
      // ─── 프로필 이미지 변경/초기화 (본인) ───
      // { fileId } = POST /upload 로 올린 이미지 파일 키, { fileId: null } = 기본 이미지로 초기화
      else if (data.type === 'profile_image_set') {
        const me = myUserNo(ws);
        if (!me) return;
        const raw = data.fileId ?? null;
        const fileKey = raw == null || raw === '' ? null : String(raw);
        if (fileKey != null && !FILE_KEY_RE.test(fileKey)) {
          ws.send(JSON.stringify({ type: 'profile_image_result', ok: false, reason: 'not_found', text: '이미지를 찾을 수 없습니다.' }));
          return;
        }
        const result = setUserProfileImage(me, fileKey);
        if (!result.ok) {
          const texts = {
            invalid_user: '로그인이 필요합니다.',
            not_found: '이미지를 찾을 수 없습니다.',
            not_image: '이미지 파일만 등록할 수 있습니다.',
          };
          ws.send(JSON.stringify({ type: 'profile_image_result', ok: false, reason: result.reason, text: texts[result.reason] || '프로필 이미지 변경에 실패했습니다' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'profile_image_result', ok: true }));
        // 같은 계정으로 접속한 모든 소켓에 내 프로필 갱신
        const updated = getUserByNo(me);
        for (const [client, no] of clients.entries()) {
          if (Number(no) !== Number(me)) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(JSON.stringify({ type: 'my_profile', user_no: updated.user_no, loginId: updated.loginId, nickname: updated.nickname, profileImage: updated.profileImage }));
        }
      }

      // ─── 1:1 대화방 확보: '사용자' 탭에서 상대를 눌러 1:1 창을 열 때 ───
      // 1:1은 "멤버 2명 방" 하나로만 표현한다(별도 DM 개념 없음).
      // 신 규격: { withUserNo } — user_no 기준
      else if (data.type === 'dm_room_open') {
        const me = myUserNo(ws);
        if (!me) return;
        const my = getUserByNo(me);
        if (!my || my.isDeleted) return;

        const peerNo = toUserNo(data.withUserNo ?? data.with_no ?? data.peerNo ?? data.peer_no ?? data.withUser ?? data.with);
        if (!peerNo || peerNo === me) return;
        const peer = getUserByNo(peerNo);
        if (!peer || peer.isDeleted) {
          ws.send(JSON.stringify({
            type: "system",
            text: `대화 상대가 유효하지 않습니다`,
          }));
          return;
        }

        let roomId = null;
        try {
          roomId = ensureOneToOneRoom(me, peerNo, Date.now(), {
            [String(me)]: my.nickname,
            [String(peerNo)]: peer.nickname,
          });
          if (roomId) {
            trackJoin(ws, roomId);
            console.log(`1:1방 #${roomId} 확보 (user_no ${me} ↔ ${peerNo})`);
          }
        } catch (e) {
          console.error('1:1방 확보 실패:', e);
          roomId = null;
        }
        if (!roomId) {
          ws.send(JSON.stringify({ type: "system", text: "1:1 대화를 열 수 없습니다." }));
          return;
        }

        // 요청한 사람에게 방 번호를 돌려준다 (클라이언트가 이 창을 연다)
        ws.send(JSON.stringify({ type: 'room_opened', withUserNo: peerNo, withUser: peer.nickname, roomId }));
        // 양쪽 방 목록을 최신으로 맞춘다 (새로 만들어졌을 수 있으므로 상대도 갱신)
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(me) }));
        for (const [client, no] of clients.entries()) {
          if (Number(no) !== peerNo) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(no) }));
          break;
        }
      }

      // MESSAGE 메시지 처리 — 전체채팅 제거로 더 이상 사용하지 않음
      // NOTE: 기존 'group' DB 행은 보존. 신규 'message' 타입은 무시한다.
      else if (data.type === 'message') {
        return;
      }

      // ─── 채팅창 열람: 번호방 최근 한 페이지 조회 (창이 열릴 때마다 요청) ───
      else if (data.type === 'room_history') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        // 존재하지 않는 방/멤버가 아닌 방은 빈 히스토리로 응답 (누출 방지)
        if (!room || !isMember(roomId, me)) {
          ws.send(JSON.stringify({ type: 'history_room', roomId, messages: [], hasMore: false }));
          return;
        }
        ws.send(JSON.stringify({
          type: 'history_room',
          roomId,
          members: getRoomMemberNos(roomId),
          memberProfiles: getRoomMembers(roomId),
          ...buildRoomHistoryPage(roomId, me),
        }));
      }

      // ─── 채팅창 이전 대화 더보기: beforeId(가장 오래된 msgId)보다 이전 한 페이지 ───
      else if (data.type === 'room_history_older') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        const beforeId = Number(data.beforeId);
        if (!Number.isInteger(roomId) || !Number.isInteger(beforeId) || beforeId <= 0) return;
        const room = getRoom(roomId);
        if (!room || !isMember(roomId, me)) {
          ws.send(JSON.stringify({ type: 'history_room_older', roomId, beforeId, messages: [], hasMore: false }));
          return;
        }
        ws.send(JSON.stringify({
          type: 'history_room_older',
          roomId,
          beforeId,
          ...buildRoomHistoryPage(roomId, me, { beforeId, limit: data.limit }),
        }));
      }

      // ─── 채팅창 메시지 검색: 본문 포함 검색 → 매칭 msgId 목록 (최신 → 과거) ───
      else if (data.type === 'room_search') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const keyword = String(data.keyword ?? '').trim();
        const room = getRoom(roomId);
        if (!room || !isMember(roomId, me) || keyword === '' || keyword.length > SEARCH_KEYWORD_MAX) {
          ws.send(JSON.stringify({ type: 'room_search_result', roomId, keyword, ids: [], truncated: false }));
          return;
        }
        ws.send(JSON.stringify({
          type: 'room_search_result',
          roomId,
          keyword,
          ...searchRoomMessages(roomId, me, keyword),
        }));
      }

      // ─── 검색 결과 점프: msgId 를 가운데 둔 한 페이지 ───
      else if (data.type === 'room_history_around') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        const msgId = Number(data.msgId);
        if (!Number.isInteger(roomId) || !Number.isInteger(msgId) || msgId <= 0) return;
        const room = getRoom(roomId);
        if (!room || !isMember(roomId, me)) {
          ws.send(JSON.stringify({ type: 'history_room_around', roomId, msgId, messages: [], hasMore: false, hasNewer: false }));
          return;
        }
        const page = getRoomMessagesAround(roomId, me, msgId);
        ws.send(JSON.stringify({
          type: 'history_room_around',
          roomId,
          msgId,
          hasMore: page.hasMore,
          hasNewer: page.hasNewer,
          messages: decorateUnreadCounts('room', String(roomId), page.messages, getRoomMemberNos(roomId)),
        }));
      }

      // ─── 점프 후 아래로 스크롤: afterId(가장 최근 msgId)보다 이후 한 페이지 ───
      else if (data.type === 'room_history_newer') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        const afterId = Number(data.afterId);
        if (!Number.isInteger(roomId) || !Number.isInteger(afterId) || afterId <= 0) return;
        const room = getRoom(roomId);
        if (!room || !isMember(roomId, me)) {
          ws.send(JSON.stringify({ type: 'history_room_newer', roomId, afterId, messages: [], hasNewer: false }));
          return;
        }
        const page = buildRoomHistoryPage(roomId, me, { afterId, limit: data.limit });
        ws.send(JSON.stringify({
          type: 'history_room_newer',
          roomId,
          afterId,
          messages: page.messages,
          hasNewer: page.hasMore,
        }));
      }

      // ─── 번호방: 생성 (초대 멤버 포함 가능) ───
      // 신 규격: { memberNos: number[] } — user_no 기준
      else if (data.type === 'room_create') {
        const me = myUserNo(ws);
        if (!me) return;
        const my = getUserByNo(me);
        if (!my) return;
        const rawMembers = Array.isArray(data.memberNos)
          ? data.memberNos
          : Array.isArray(data.members) ? data.members : [];
        const memberNos = [];
        for (const raw of rawMembers) {
          const no = toUserNo(typeof raw === 'object' && raw !== null ? raw.user_no ?? raw.userNo : raw);
          if (!no || no === me || memberNos.includes(no)) continue;
          if (!isRegisteredNo(no)) continue;
          memberNos.push(no);
          if (memberNos.length >= 50) break;
        }
        // 초대 멤버(본인 제외, 등록 사용자) 0명이면 방을 만들지 않는다 — 클라이언트 가드와 동일 규칙
        if (memberNos.length === 0) {
          ws.send(JSON.stringify({ type: 'system', text: '초대할 사용자를 1명 이상 선택하세요.' }));
          return;
        }
        // 방 이름은 직접 입력받지 않는다. 실제 멤버 기준 스냅샷으로 생성.
        const legacyName = String(data.name || '').trim().slice(0, 30);
        const nickMap = {};
        for (const u of getAllUsersDetail()) nickMap[String(u.user_no)] = u.nickname;
        const ownerNick = my.nickname;
        const invitedNicks = memberNos.map((no) => nickMap[String(no)] || '');
        const name = joinMemberNames(ownerNick, invitedNicks) || legacyName;
        if (!name) {
          ws.send(JSON.stringify({ type: 'system', text: '방을 만들지 못했습니다.' }));
          return;
        }
        const now = Date.now();
        const roomId = createRoom({
          name, ownerNo: me, timestamp: now, memberNos,
          ownerNickname: ownerNick, memberNicknames: nickMap,
        });
        trackJoin(ws, roomId);
        console.log(`방 생성 #${roomId} "${name}" by user_no=${me} (초대 ${memberNos.length}명)`);
        ws.send(JSON.stringify({
          type: 'room_created',
          roomId,
          rooms: getMyRooms(me),
        }));
        ws.send(JSON.stringify({ type: 'history_room', roomId, messages: [] }));
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMemberNos(roomId), memberProfiles: getRoomMembers(roomId),
        });
        // 초대받은 온라인 멤버에게 내 방 목록 + 빈 히스토리 즉시 푸시
        if (memberNos.length > 0) {
          wss.clients.forEach((client) => {
            if (client === ws) return;
            if (client.readyState !== WebSocket.OPEN) return;
            const no = myUserNo(client);
            if (!no || !memberNos.includes(no)) return;
            trackJoin(client, roomId);
            client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(no) }));
            client.send(JSON.stringify({ type: 'history_room', roomId, messages: [] }));
            client.send(JSON.stringify({
              type: 'room_members', roomId, members: getRoomMemberNos(roomId), memberProfiles: getRoomMembers(roomId),
            }));
          });
        }
      }
      // ─── 번호방: 초대 (운영 중인 방에 멤버 추가) ───
      // 초대자는 반드시 방 멤버여야 하고, 대상은 등록된(탈퇴 아닌) 사용자만 가능하다.
      // db.inviteMembers()가 멤버 추가 + 초대받은 멤버의 display_name(닉네임 나열 제목)을 저장한다.
      // 초대받은 사람이 오프라인이어도 DB만 갱신되면 재접속 시 my_rooms로 노출된다.
      else if (data.type === 'room_invite') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        const failInvite = (reason) => {
          ws.send(JSON.stringify({ type: 'room_invite_failed', roomId, reason }));
        };
        if (!room || room.is_deleted === 1 || room.is_closed === 1) {
          failInvite('not_found');
          return;
        }
        if (!isMember(roomId, me)) {
          failInvite('not_member');
          return;
        }
        const rawMembers = Array.isArray(data.memberNos)
          ? data.memberNos
          : Array.isArray(data.members) ? data.members : [];
        const memberNos = [];
        for (const raw of rawMembers) {
          const no = toUserNo(typeof raw === 'object' && raw !== null ? raw.user_no ?? raw.userNo : raw);
          if (!no || no === me || memberNos.includes(no)) continue;
          if (!isRegisteredNo(no)) continue;   // 미등록/탈퇴자는 초대 대상에서 제외
          if (isMember(roomId, no)) continue;  // 이미 멤버는 중복 초대 제외
          memberNos.push(no);
          if (memberNos.length >= 50) break;
        }
        if (memberNos.length === 0) {
          failInvite('no_targets');
          return;
        }
        const { added } = inviteMembers(roomId, memberNos, Date.now());
        console.log(`방 #${roomId} 초대 by user_no=${me} → [${added.join(', ')}]`);

        // 방 멤버 전체(초대자 포함): 갱신된 내 방 목록 + 멤버 목록 전달
        const roomMemberNos = getRoomMemberNos(roomId);
        const memberProfiles = getRoomMembers(roomId);
        wss.clients.forEach((client) => {
          if (client.readyState !== WebSocket.OPEN) return;
          const no = myUserNo(client);
          if (!no) return;
          if (roomMemberNos.includes(no)) {
            client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(no) }));
            client.send(JSON.stringify({
              type: 'room_members', roomId, members: roomMemberNos, memberProfiles,
            }));
          }
          // 초대받은 사람: 초대 시점 이후의 메시지만 담긴 히스토리로 덮어쓴다 (요구사항 6)
          if (added.includes(no)) {
            trackJoin(client, roomId);
            client.send(JSON.stringify({
              type: 'history_room',
              roomId,
              members: roomMemberNos,
              memberProfiles,
              ...buildRoomHistoryPage(roomId, no),
            }));
          }
        });
      }

      // ─── 번호방: 입장 ───
      else if (data.type === 'room_join') {
        const me = myUserNo(ws);
        if (!me) return;
        const my = getUserByNo(me);
        if (!my) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'room_join_failed', roomId, reason: 'not_found' }));
          return;
        }
        if (room.is_deleted === 1) {
          ws.send(JSON.stringify({ type: 'room_join_failed', roomId, reason: 'deleted' }));
          return;
        }
        if (room.is_closed === 1) {
          ws.send(JSON.stringify({ type: 'room_join_failed', roomId, reason: 'closed' }));
          return;
        }
        if (!isMember(roomId, me)) {
          addMember(roomId, me, Date.now());
          broadcastToRoom(roomId, {
            type: 'system', roomId,
            text: `${my.nickname}님이 #${roomId} 방에 입장했습니다`,
          });
        }
        trackJoin(ws, roomId);
        ws.send(JSON.stringify({
          type: 'history_room',
          roomId,
          members: getRoomMemberNos(roomId),
          memberProfiles: getRoomMembers(roomId),
          ...buildRoomHistoryPage(roomId, me),
        }));
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(me) }));
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMemberNos(roomId), memberProfiles: getRoomMembers(roomId),
        });
      }
      // ─── 번호방: 방제목 수정 (사용자별 — 고친 사람에게만 적용) ───
      // 제목은 room_members.display_name(방×멤버 행)에 저장되므로 같은 방의 다른
      // 멤버는 그대로 본다. 서버도 "요청한 본인 행"만 고치게 하여 1:1방/단체방 모두
      // 별도 구분 없이 같은 방식으로 동작한다.
      else if (data.type === 'room_rename') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const title = String(data.title || '').trim();
        if (!title) {
          ws.send(JSON.stringify({
            type: 'room_rename_failed', roomId, reason: 'empty_title',
          }));
          return;
        }
        const room = getRoom(roomId);
        if (!room || room.is_deleted === 1 || room.is_closed === 1) {
          ws.send(JSON.stringify({
            type: 'room_rename_failed', roomId, reason: 'not_found',
          }));
          return;
        }
        // 멤버만 수정 가능 (권한 판정은 DB 기준)
        if (!isMember(roomId, me)) {
          ws.send(JSON.stringify({
            type: 'room_rename_failed', roomId, reason: 'not_member',
          }));
          return;
        }
        const ok = setRoomDisplayName(roomId, me, title);
        if (!ok) {
          ws.send(JSON.stringify({
            type: 'room_rename_failed', roomId, reason: 'update_failed',
          }));
          return;
        }
        console.log(`방 #${roomId} 제목 변경 by user_no=${me} → "${title}"`);
        wss.clients.forEach((client) => {
          if (Number(myUserNo(client)) !== me) return;
          if (client.readyState !== WebSocket.OPEN) return;
          client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(me) }));
        });
      }

      // ─── 번호방: 나가기 (잔류자 유지, 마지막 퇴장 시 폐쇄) ───
      else if (data.type === 'room_leave') {
        const me = myUserNo(ws);
        if (!me) return;
        const my = getUserByNo(me);
        if (!my) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        if (!room || !isMember(roomId, me)) return;
        const wasOwner = Number(room.owner_no) === me;
        removeMember(roomId, me);
        trackLeave(ws, roomId);
        clearUnreadForRoom(me, roomId, Date.now());
        clearReadCursor(me, 'room', String(roomId), Date.now());
        if (wasOwner) {
          const next = getEarliestMemberExcept(roomId, me);
          if (next) transferOwner(roomId, next);
        }
        const closed = closeRoomIfEmpty(roomId, Date.now());
        if (closed) {
          ws.send(JSON.stringify({ type: 'room_closed', roomId, reason: 'closed' }));
          ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(me) }));
          return;
        }
        broadcastToRoom(roomId, {
          type: 'system', roomId,
          text: `${my.nickname}님이 #${roomId} 방에서 나갔습니다`,
        });
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMemberNos(roomId), memberProfiles: getRoomMembers(roomId),
        });
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(me) }));
      }

      // ─── 번호방: 삭제 (방장만, soft delete — DB 보존) ───
      else if (data.type === 'room_delete') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        if (!room) return;
        if (room.is_deleted === 1) return;
        if (Number(room.owner_no) !== me) {
          ws.send(JSON.stringify({ type: 'system', text: `방 #${roomId} 삭제는 방장만 할 수 있습니다.` }));
          return;
        }
        softDeleteRoom(roomId, me, Date.now());
        console.log(`방 #${roomId} 삭제 by user_no=${me} (DB 보존)`);
        wss.clients.forEach((client) => {
          const no = myUserNo(client);
          if (!no || !isMember(roomId, no)) return;
          trackLeave(client, roomId);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'room_closed', roomId, reason: 'deleted' }));
            client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(no) }));
          }
        });
      }

      // ─── 번호방: 메시지 (멤버 + 활성방만) ───
      else if (data.type === 'room_message') {
        const me = myUserNo(ws);
        if (!me) return;
        const my = getUserByNo(me);
        if (!my) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        // 첨부파일 메시지: 업로드로 받은 fileId(아직 어느 메시지에도 붙지 않은 것)만 허용
        let file = null;
        if (data.fileId != null) {
          const found = getFile(data.fileId);
          if (!found || found.msgId != null) {
            ws.send(JSON.stringify({ type: 'system', roomId, text: '첨부파일을 찾을 수 없습니다. 다시 첨부해 주세요.' }));
            return;
          }
          file = found;
        }
        const text = file ? file.name : String(data.text || '').trim();
        if (!text) return;
        const room = getRoom(roomId);
        if (!isRoomActive(room)) return;
        if (!isMember(roomId, me)) return;
        const timestamp = Date.now();
        const roomMemberNos = getRoomMemberNos(roomId);
        const payload = {
          type: 'room_message', roomId,
          from_no: me, from: my.nickname, text: text.slice(0, 2000), timestamp,
        };
        if (file) payload.file = { id: file.key, name: file.name, size: file.size, mime: file.mime };
        console.log(`#${roomId} user_no=${me}(${my.nickname}): ${file ? `[첨부] ${text}` : text}`);
        const savedRoom = saveMessage({
          roomType: 'room', senderNo: me, senderName: my.nickname,
          text: payload.text, timestamp, roomId, file,
        });
        if (file) attachFile(file.key, Number(savedRoom?.lastInsertRowid || 0));
        // 저장된 행 id + 읽지 않은 멤버 수를 붙인다.
        // 발신자 본인 화면에서 카톡식 숫자로 표시되고, 상대가 읽으면 나중에 감소한다.
        const roomMsgId = Number(savedRoom?.lastInsertRowid || 0);
        payload.msgId = roomMsgId;
        payload.unreadCount = countUnreadForMessage(
          getReadCursors('room', String(roomId)),
          roomMemberNos,
          me,
          roomMsgId,
        );
        broadcastToRoom(roomId, payload);
        // '내 채팅방' 목록의 마지막 메시지/시간 실시간 갱신용 (DB 재조회 없이 가볍게 반영)
        broadcastToRoom(roomId, {
          type: 'room_last_message', roomId,
          from_no: me, from: my.nickname, text: previewTextOf(payload.text, file ? file.mime : null), timestamp,
        });

        // 방 멤버(발신자 제외) 안읽은 건수 +1.
        for (const memberNo of roomMemberNos) {
          if (memberNo === me) continue;
          bumpUnread(memberNo, 'room', String(roomId), timestamp);
        }
        for (const [client, no] of clients.entries()) {
          if (Number(no) === me) continue;
          if (!isMember(roomId, no)) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(JSON.stringify({
            type: 'unread_bump', scope: 'room', target: String(roomId),
          }));
        }
      }

      // ─── 안읽은 건수: 읽음 처리 ───
      else if (data.type === 'unread_clear') {
        const me = myUserNo(ws);
        if (!me) return;
        const roomId = Number(data.target);
        if (!Number.isInteger(roomId)) return;
        // 멤버인 경우만 읽음 처리 (권한 판정은 DB 기준)
        if (!isMember(roomId, me)) return;
        const now = Date.now();
        clearUnread(me, 'room', String(roomId), now);
        markRead(me, 'room', String(roomId), getLatestRoomMessageId(roomId), now);
        broadcastReadAck('room', String(roomId));
      }

      // ─── 안읽은 건수: 현재 상태 재조회 ───
      else if (data.type === 'unread_query') {
        const me = myUserNo(ws);
        if (!me) return;
        ws.send(JSON.stringify({ type: 'unread_state', unread: getUnreadMap(me) }));
      }

      // ─── 번호방: 내 목록 새로고침 ───
      else if (data.type === 'room_list') {
        const me = myUserNo(ws);
        if (!me) return;
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(me) }));
      }
    } catch (e) {
      console.error('메시지 파싱 오류:', e);
    }
  });
  
  // 클라이언트 연결 종료 시 (멤버십 유지 — 재접속 시 내방 복원)
  ws.on('close', () => {
    const no = myUserNo(ws);
    if (no) {
      clients.delete(ws);
      // 접속 해제 시 해당 사용자 상태를 offline으로 확정한다 (재접속 시 기본값은 online).
      // clients에서 먼저 지운 뒤 확정해야 방송되는 onlineUsers/userStatuses가 모두 offline을 가리킨다.
      statusOverrides.set(Number(no), 'offline');
      trackClear(ws);
      const left = getUserByNo(no);
      console.log(`user_no=${no} 연결 종료`);

      // 모든 클라이언트에게 퇴장 알림
      broadcast({
        type: 'system',
        text: `${left ? left.nickname : `user_no=${no}`}님이 퇴장했습니다`
      });

      // 사용자 목록 업데이트 및 전송
      broadcastUserList();
    }
  });
});