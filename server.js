// WebSocket 채팅 서버 생성
const WebSocket = require('ws');

// SQLite 데이터베이스 (메시지/방 저장/조회)
const {
  saveMessage,
  createRoom,
  joinMemberNames,
  getRoom,
  isRoomActive,
  isMember,
  ensureOneToOneRoom,
  addMember,
  removeMember,
  getRoomMembers,
  getEarliestMemberExcept,
  transferOwner,
  getMyRooms,
  setRoomDisplayName,
  softDeleteRoom,
  closeRoomIfEmpty,
  getRoomHistory,
  getRecentRoomMessages,
  upsertUser,
  withdrawUser,
  isWithdrawn,
  isRegistered,
  getAllUsers,
  getAllUsersDetail,
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
} = require('./db');

// 포트 8080에서 서버 실행 (테스트 시 PORT로 재지정 가능)
const PORT = Number(process.env.PORT) || 8080;
const wss = new WebSocket.Server({ port: PORT });

// 클라이언트별 닉네임 저장 (WebSocket 인스턴스 -> 닉네임)
const clients = new Map();
// 소켓별 입장 방 집합 (발송 스코프용 캐시, 권한 판정은 항상 DB 기준)
const wsRooms = new Map();

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
function broadcastToRoom(roomId, message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    const nick = clients.get(client);
    if (!nick) return;
    if (!isMember(roomId, nick)) return;
    trackJoin(client, roomId);
    client.send(payload);
  });
}

/** read_ack 에 실어 보낼 참여자 목록 (room = 방 멤버) */
function readAckParticipants(scope, target) {
  const roomId = Number(target);
  if (!Number.isInteger(roomId)) return [];
  return getRoomMembers(roomId);
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
    const nick = clients.get(client);
    if (!nick || !isMember(roomId, nick)) return;
    client.send(payload);
  });
}

// 등록된 전체 사용자 목록 + 현재 접속중 목록을 전체 클라이언트에게 전송
// users: DB 등록 사용자 전체 (탈퇴 제외), onlineUsers: 현재 접속중
// admin 접속자에게는 탈퇴 포함 상세(usersDetail)도 개별 전송
function broadcastUserList() {
  const onlineUsers = Array.from(clients.values());
  const users = getAllUsers();
  broadcast({
    type: "userlist",
    users,
    onlineUsers,
  });
  // admin에게는 전체(탈퇴 포함) 상세 목록 추가 전송
  try {
    const detail = getAllUsersDetail();
    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (clients.get(client) !== 'admin') return;
      client.send(JSON.stringify({ type: 'userlist_detail', usersDetail: detail }));
    });
  } catch (e) {
    console.error('admin 상세 목록 전송 실패:', e);
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
      
      // JOIN 메시지 처리: 닉네임 설정 및 입장 알림
      // NOTE: 접속 시 자동 upsert 제거 — 등록된 사용자만 입장 가능 (admin이 사전 등록)
      if (data.type === 'join') {
        const nickname = String(data.nickname || '').trim();
        if (!nickname) return;
        // 미등록/탈퇴 사용자는 입장 거부
        if (isWithdrawn(nickname)) {
          ws.send(JSON.stringify({ type: 'join_failed', reason: 'withdrawn', text: `${nickname}님은 탈퇴한 사용자입니다` }));
          return;
        }
        if (!isRegistered(nickname)) {
          ws.send(JSON.stringify({ type: 'join_failed', reason: 'not_registered', text: `${nickname}님은 등록된 사용자가 아닙니다. 관리자에게 문의하세요` }));
          return;
        }
        clients.set(ws, nickname);
        console.log(`${nickname} 닉네임으로 입장`);

        // 이 소켓이 속한 방 캐시 복원 (재접속 시 내방 복원용, 멤버십은 DB 유지)
        trackClear(ws);
        const myRooms = getMyRooms(nickname);
        for (const r of myRooms) trackJoin(ws, r.roomId);

        // 모든 클라이언트에게 입장 알림
        broadcast({
          type: 'system',
          text: `${nickname}님이 입장했습니다`
        });

        // 사용자 목록 업데이트 및 전송
        broadcastUserList();

        // 내 방 목록 전송 (삭제/폐쇄 제외)
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: myRooms }));

        // 안읽은 건수 복원 (서버 DB 기준 — 다른 PC에서 로그인해도 그대로 유지된다)
        ws.send(JSON.stringify({ type: 'unread_state', unread: getUnreadMap(nickname) }));

        // NOTE: 접속 시 전체 방/DM 히스토리 일괄 푸시 제거.
        // 채팅창이 열릴 때마다(room_history / dm_history 요청) DB에서 최근 10건을 조회해 준다.

        // admin 접속 시 관리용 전체 목록(탈퇴 포함)도 전송
        if (nickname === 'admin') {
          ws.send(JSON.stringify({ type: 'userlist_detail', usersDetail: getAllUsersDetail() }));
        }
      }

      // ─── 사용자 관리: 추가/수정 (admin 전용) ───
      // nickname + 탈퇴여부(isDeleted)를 입력받아 upsert
      else if (data.type === 'user_upsert') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        if (senderNickname !== 'admin') {
          ws.send(JSON.stringify({ type: 'system', text: '사용자 관리는 admin만 할 수 있습니다.' }));
          return;
        }
        const nickname = String(data.nickname || '').trim().slice(0, 20);
        if (!nickname) {
          ws.send(JSON.stringify({ type: 'user_upsert_result', ok: false, reason: 'empty', text: '닉네임을 입력하세요.' }));
          return;
        }
        const isDeleted = data.isDeleted === true || data.is_deleted === 1 || data.isDeleted === 1;
        upsertUser(nickname, Date.now(), isDeleted);
        console.log(`사용자 upsert by admin: ${nickname} (탈퇴=${isDeleted ? 'Y' : 'N'})`);
        ws.send(JSON.stringify({ type: 'user_upsert_result', ok: true, nickname, isDeleted }));
        broadcastUserList();
      }
      
      // ─── 1:1 대화방 확보: '사용자' 탭에서 상대를 눌러 1:1 창을 열 때 ───
      // 1:1은 "멤버 2명 방" 하나로만 표현한다(별도 DM 개념 없음).
      // 이미 있는 방이면 번호를 그대로, 없으면 새로 만들어 돌려준다.
      // 방은 처음 열 때 만들어지며, 메시지 0개인 1:1방은 목록에서 숨겨지므로
      // 사용자에게 "빈 방"이 보이지 않는다.
      else if (data.type === 'dm_room_open') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;

        const targetNickname = String(data.withUser || '').trim();
        if (!targetNickname || targetNickname === senderNickname) return;
        // 탈퇴한 사용자와는 대화 불가
        if (isWithdrawn(senderNickname) || isWithdrawn(targetNickname)) {
          ws.send(JSON.stringify({
            type: "system",
            text: `탈퇴한 사용자와는 대화할 수 없습니다`,
          }));
          return;
        }
        // 수신자가 등록된 사용자가 아니면 차단
        if (!isRegistered(targetNickname)) {
          ws.send(JSON.stringify({
            type: "system",
            text: `${targetNickname}님은 등록된 사용자가 아닙니다`,
          }));
          return;
        }

        let roomId = null;
        try {
          // Node 이벤트루프 동기 구간에서 check→insert를 연속 수행해
          // 양쪽 동시 클릭에 의한 중복방 생성을 1차 방지한다.
          roomId = ensureOneToOneRoom(senderNickname, targetNickname, Date.now());
          if (roomId) {
            trackJoin(ws, roomId);
            console.log(`1:1방 #${roomId} 확보 (${senderNickname} ↔ ${targetNickname})`);
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
        ws.send(JSON.stringify({ type: 'room_opened', withUser: targetNickname, roomId }));
        // 양쪽 방 목록을 최신으로 맞춘다 (새로 만들어졌을 수 있으므로 상대도 갱신)
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
        for (const [client, nick] of clients.entries()) {
          if (nick !== targetNickname) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(nick) }));
          break;
        }
      }

      // MESSAGE 메시지 처리 — 전체채팅 제거로 더 이상 사용하지 않음
      // NOTE: 기존 'group' DB 행은 보존. 신규 'message' 타입은 무시한다.
      else if (data.type === 'message') {
        return;
      }

      // ─── 채팅창 열람: 번호방 최근 10건 조회 (창이 열릴 때마다 요청) ───
      else if (data.type === 'room_history') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        // 존재하지 않는 방/멤버가 아닌 방은 빈 히스토리로 응답 (누출 방지)
        if (!room || !isMember(roomId, senderNickname)) {
          ws.send(JSON.stringify({ type: 'history_room', roomId, messages: [] }));
          return;
        }
        ws.send(JSON.stringify({
          type: 'history_room',
          roomId,
          // members 를 같이 보내 방을 연 클라이언트가 즉시 참여자 목록을 갖게 한다.
          // (이 목록이 없으면 이후 read_ack 로 숫자를 재계산할 때 0으로 잘못 계산된다)
          members: getRoomMembers(roomId),
          messages: decorateUnreadCounts(
            'room',
            String(roomId),
            getRecentRoomMessages(roomId, 10),
            getRoomMembers(roomId),
          ),
        }));
      }

      // ─── 번호방: 생성 (초대 멤버 포함 가능) ───
      else if (data.type === 'room_create') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        // 초대생성: members 배열(닉네임 목록)을 함께 받아 방 생성 시 멤버로 등록
        // 탈퇴한 사용자는 초대 대상에서 제외
        const rawMembers = Array.isArray(data.members) ? data.members : [];
        const members = rawMembers
          .map((m) => String(m || '').trim())
          .filter((m) => m && m !== senderNickname && !isWithdrawn(m))
          .slice(0, 50);
        // 방 이름은 직접 입력받지 않는다(클라이언트 input 제거).
        // 실제 멤버(탈퇴자·중복 제외) 기준으로 "이름 오름차순 쉼표 연결"을 만들어
        // rooms.name과 room_members.display_name에 동일하게 넣는다.
        // 구버전 클라이언트가 이름을 보내는 경우에만 그 값을 폴백으로 쓴다.
        const legacyName = String(data.name || '').trim().slice(0, 30);
        const name = joinMemberNames(senderNickname, members) || legacyName;
        if (!name) {
          ws.send(JSON.stringify({ type: 'system', text: '방을 만들지 못했습니다.' }));
          return;
        }
        const now = Date.now();
        const roomId = createRoom({ name, owner: senderNickname, timestamp: now, members });
        trackJoin(ws, roomId);
        console.log(`방 생성 #${roomId} "${name}" by ${senderNickname} (초대 ${members.length}명)`);
        ws.send(JSON.stringify({
          type: 'room_created',
          roomId,
          rooms: getMyRooms(senderNickname),
        }));
        ws.send(JSON.stringify({ type: 'history_room', roomId, messages: [] }));
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMembers(roomId),
        });
        // 초대받은 온라인 멤버에게 내 방 목록 + 빈 히스토리 즉시 푸시
        // (다음 join/재접속 때까지 기다리지 않고 바로 목록에 뜨게 함)
        if (members.length > 0) {
          wss.clients.forEach((client) => {
            if (client === ws) return;
            if (client.readyState !== WebSocket.OPEN) return;
            const nick = clients.get(client);
            if (!nick || !members.includes(nick)) return;
            trackJoin(client, roomId);
            client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(nick) }));
            client.send(JSON.stringify({ type: 'history_room', roomId, messages: [] }));
            client.send(JSON.stringify({
              type: 'room_members', roomId, members: getRoomMembers(roomId),
            }));
          });
        }
      }
      // ─── 번호방: 입장 ───
      else if (data.type === 'room_join') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
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
        if (!isMember(roomId, senderNickname)) {
          addMember(roomId, senderNickname, Date.now());
          broadcastToRoom(roomId, {
            type: 'system', roomId,
            text: `${senderNickname}님이 #${roomId} 방에 입장했습니다`,
          });
        }
        trackJoin(ws, roomId);
        ws.send(JSON.stringify({
          type: 'history_room',
          roomId,
          // members 를 같이 보내 방을 연 클라이언트가 즉시 참여자 목록을 갖게 한다.
          // (이 목록이 없으면 이후 read_ack 로 숫자를 재계산할 때 0으로 잘못 계산된다)
          members: getRoomMembers(roomId),
          messages: decorateUnreadCounts(
            'room',
            String(roomId),
            getRecentRoomMessages(roomId, 10),
            getRoomMembers(roomId),
          ),
        }));
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMembers(roomId),
        });
      }
      // ─── 번호방: 방제목 수정 (사용자별 — 고친 사람에게만 적용) ───
      // 제목은 room_members.display_name(방×멤버 행)에 저장되므로 같은 방의 다른
      // 멤버는 그대로 본다. 서버도 "요청한 본인 행"만 고치게 하여 1:1방/단체방 모두
      // 별도 구분 없이 같은 방식으로 동작한다.
      else if (data.type === 'room_rename') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
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
        if (!isMember(roomId, senderNickname)) {
          ws.send(JSON.stringify({
            type: 'room_rename_failed', roomId, reason: 'not_member',
          }));
          return;
        }
        const ok = setRoomDisplayName(roomId, senderNickname, title);
        if (!ok) {
          ws.send(JSON.stringify({
            type: 'room_rename_failed', roomId, reason: 'update_failed',
          }));
          return;
        }
        console.log(`방 #${roomId} 제목 변경 by ${senderNickname} → "${title}"`);
        // 수정한 본인에게만 새 목록을 내려준다 (다른 멤버 제목은 그대로여서 무의미).
        // 같은 닉네임의 다른 소켓(같은 PC의 여러 탭 등)도 함께 갱신한다.
        wss.clients.forEach((client) => {
          if (clients.get(client) !== senderNickname) return;
          if (client.readyState !== WebSocket.OPEN) return;
          client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
        });
      }

      // ─── 번호방: 나가기 (잔류자 유지, 마지막 퇴장 시 폐쇄) ───
      else if (data.type === 'room_leave') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        if (!room || !isMember(roomId, senderNickname)) return;
        const wasOwner = room.owner === senderNickname;
        removeMember(roomId, senderNickname);
        trackLeave(ws, roomId);
        // 나간 방의 안읽은 건수는 의미가 없으므로 정리한다.
        // (다시 입장하면 0부터 다시 쌓인다)
        clearUnreadForRoom(senderNickname, roomId, Date.now());
        if (wasOwner) {
          const next = getEarliestMemberExcept(roomId, senderNickname);
          if (next) transferOwner(roomId, next);
        }
        const closed = closeRoomIfEmpty(roomId, Date.now());
        if (closed) {
          ws.send(JSON.stringify({ type: 'room_closed', roomId, reason: 'closed' }));
          ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
          return;
        }
        broadcastToRoom(roomId, {
          type: 'system', roomId,
          text: `${senderNickname}님이 #${roomId} 방에서 나갔습니다`,
        });
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMembers(roomId),
        });
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
      }

      // ─── 번호방: 삭제 (방장만, soft delete — DB 보존) ───
      else if (data.type === 'room_delete') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const room = getRoom(roomId);
        if (!room) return;
        if (room.is_deleted === 1) return;
        if (room.owner !== senderNickname) {
          ws.send(JSON.stringify({ type: 'system', text: `방 #${roomId} 삭제는 방장만 할 수 있습니다.` }));
          return;
        }
        softDeleteRoom(roomId, senderNickname, Date.now());
        console.log(`방 #${roomId} 삭제 by ${senderNickname} (DB 보존)`);
        wss.clients.forEach((client) => {
          const nick = clients.get(client);
          if (!nick || !isMember(roomId, nick)) return;
          trackLeave(client, roomId);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'room_closed', roomId, reason: 'deleted' }));
            client.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(nick) }));
          }
        });
      }

      // ─── 번호방: 메시지 (멤버 + 활성방만) ───
      else if (data.type === 'room_message') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const roomId = Number(data.roomId);
        if (!Number.isInteger(roomId)) return;
        const text = String(data.text || '').trim();
        if (!text) return;
        const room = getRoom(roomId);
        if (!isRoomActive(room)) return;
        if (!isMember(roomId, senderNickname)) return;
        const timestamp = Date.now();
        const roomMembers = getRoomMembers(roomId);
        const payload = {
          type: 'room_message', roomId,
          from: senderNickname, text: text.slice(0, 2000), timestamp,
        };
        console.log(`#${roomId} ${senderNickname}: ${text}`);
        const savedRoom = saveMessage({
          roomType: 'room', sender: senderNickname, receiver: null,
          text: payload.text, timestamp, roomId,
        });
        // 저장된 행 id + 읽지 않은 멤버 수를 붙인다.
        // 발신자 본인 화면에서 카톡식 숫자로 표시되고, 상대가 읽으면 나중에 감소한다.
        const roomMsgId = Number(savedRoom?.lastInsertRowid || 0);
        payload.msgId = roomMsgId;
        // 발신자 본인 화면에서 카톡식 숫자로 표시되고, 상대가 읽으면 나중에 감소한다.
        // blur 상태인 수신자는 커서가 뒤처져 그대로 집계되고, focus 하면 0 이 된다.
        payload.unreadCount = countUnreadForMessage(
          getReadCursors('room', String(roomId)),
          roomMembers,
          senderNickname,
          roomMsgId,
        );
        broadcastToRoom(roomId, payload);
        // '내 채팅방' 목록의 마지막 메시지/시간 실시간 갱신용 (DB 재조회 없이 가볍게 반영)
        broadcastToRoom(roomId, {
          type: 'room_last_message', roomId,
          from: senderNickname, text: payload.text, timestamp,
        });

        // 방 멤버(발신자 제외) 안읽은 건수 +1.
        // 온라인 멤버에게는 갱신 신호를 보내 배지가 바로 반영되게 하고,
        // 오프라인 멤버는 DB에 누적되었다가 다음 접속 시 복원된다.
        for (const member of roomMembers) {
          if (member === senderNickname) continue;
          bumpUnread(member, 'room', String(roomId), timestamp);
        }
        for (const [client, nick] of clients.entries()) {
          if (nick === senderNickname) continue;
          if (!isMember(roomId, nick)) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          client.send(JSON.stringify({
            type: 'unread_bump', scope: 'room', target: String(roomId),
          }));
        }
      }

      // ─── 안읽은 건수: 읽음 처리 ───
      // 채팅창을 열거나 메시지를 읽으면 클라이언트가 이 신호를 보낸다.
      // 서버 DB에서 0으로 갱신하므로 다른 PC/브라우저로 로그인해도 반영된다.
      // 동시에 읽음 커서(read_cursor)도 전진시켜, 카톡식 메시지별 '1' 숫자를 갱신한다.
      // 1:1도 이 방 스코프 하나로 처리한다(1:1 = 멤버 2명 방).
      else if (data.type === 'unread_clear') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const roomId = Number(data.target);
        if (!Number.isInteger(roomId)) return;
        // 멤버인 경우만 읽음 처리 (권한 판정은 DB 기준)
        if (!isMember(roomId, senderNickname)) return;
        const now = Date.now();
        clearUnread(senderNickname, 'room', String(roomId), now);
        // 읽음 커서를 이 방의 최신 메시지까지 전진 → 내 메시지 옆 숫자가 0 으로 내려간다
        markRead(senderNickname, 'room', String(roomId), getLatestRoomMessageId(roomId), now);
        broadcastReadAck('room', String(roomId));
      }

      // ─── 안읽은 건수: 현재 상태 재조회 ───
      // 목록 갱신 없이 배지만 다시 받고 싶을 때 사용 (읽음 처리 후 확인 등)
      else if (data.type === 'unread_query') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        ws.send(JSON.stringify({ type: 'unread_state', unread: getUnreadMap(senderNickname) }));
      }

      // ─── 번호방: 내 목록 새로고침 ───
      else if (data.type === 'room_list') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
      }
    } catch (e) {
      console.error('메시지 파싱 오류:', e);
    }
  });
  
  // 클라이언트 연결 종료 시 (멤버십 유지 — 재접속 시 내방 복원)
  ws.on('close', () => {
    const nickname = clients.get(ws);
    if (nickname) {
      clients.delete(ws);
      trackClear(ws);
      console.log(`${nickname} 연결 종료`);
      
      // 모든 클라이언트에게 퇴장 알림
      broadcast({
        type: 'system',
        text: `${nickname}님이 퇴장했습니다`
      });
      
      // 사용자 목록 업데이트 및 전송
      broadcastUserList();
    }
  });
});