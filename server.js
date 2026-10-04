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
  findActiveOneToOneRoom,
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
  getOneToOnePeer,
  markRead,
  getReadCursors,
  clearReadCursor,
  getLatestRoomMessageId,
  getLatestDmMessageId,
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

/** read_ack 에 실어 보낼 참여자 목록 (room=방 멤버, dm=대화 키의 두 당사자) */
function readAckParticipants(scope, target) {
  if (scope === 'room') {
    const roomId = Number(target);
    if (!Number.isInteger(roomId)) return [];
    return getRoomMembers(roomId);
  }
  // dm: target 은 dmCursorTarget 정규화 키("A|B") — 그 두 사람이 곧 참여자다.
  return String(target || '').split('|').filter((n) => n && n.trim() !== '');
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
  if (scope === 'room') {
    const roomId = Number(target);
    if (!Number.isInteger(roomId)) return;
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      const nick = clients.get(client);
      if (!nick || !isMember(roomId, nick)) return;
      client.send(payload);
    });
    return;
  }
  // dm: 두 당사자에게만 (나와 상대 모두 내 메시지의 숫자가 바뀌므로 둘 다 알린다)
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (!clients.get(client)) return;
    client.send(payload);
  });
}

// 1:1 대화의 읽음 커서를 갱신하고, 1:1 자동방이 있으면 그쪽 커서도 함께 갱신한다.
// (DM창과 1:1방창은 같은 대화를 보여주므로 어느 창으로 읽어도 숫자가 같이 줄어야 한다)
function markDmRead(nickname, peer, timestamp) {
  markRead(nickname, 'dm', dmCursorTarget(nickname, peer), getLatestDmMessageId(nickname, peer), timestamp);
  const oneToOneRoomId = findActiveOneToOneRoom(nickname, peer);
  if (oneToOneRoomId) {
    markRead(nickname, 'room', String(oneToOneRoomId), getLatestRoomMessageId(oneToOneRoomId), timestamp);
  }
}

// ─── 1:1 읽음 커서의 대화 키 정규화 ───
// read_cursor 는 (읽은 사람, scope, target) 을 키로 쓰므로, 1:1에서 target 을
// "상대 닉네임"으로 두면 A→B 커서와 B→A 커서가 서로 다른 행으로 흩어져
// "안 읽은 사람 수"를 셀 때 한쪽만 조회되게 된다.
// 그래서 1:1은 두 닉네임을 정렬해 합친 키를 사용한다.
//   A가 (A,B) 대화에서 읽음 → target = "A|B"
//   B가 같은 대화에서 읽음 → target = "A|B"  (같은 행!)
// 그러면 getReadCursors('dm', 'A|B') 한 번으로 양쪽 커서를 함께 얻는다.
// (unread 테이블은 '내가 안 읽은 수'라 흩어져도 상관없었으므로 규약이 다르다)
function dmCursorTarget(a, b) {
  return [String(a || ''), String(b || '')].sort().join('|');
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
      
      // DM 메시지 처리: 1:1 메시지 전송 (오프라인 포함 — DB 저장 후 채팅창 열람 시 history로 수신)
      else if (data.type === 'dm') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        
        const targetNickname = String(data.to || '').trim();
        const text = String(data.text || '').trim();
        if (!targetNickname || !text) return;
        // 탈퇴한 사용자와는 DM 불가
        if (isWithdrawn(senderNickname) || isWithdrawn(targetNickname)) {
          ws.send(JSON.stringify({
            type: "system",
            text: `탈퇴한 사용자와는 대화할 수 없습니다`
          }));
          return;
        }
        // 수신자가 등록된 사용자가 아니면 차단
        if (!isRegistered(targetNickname)) {
          ws.send(JSON.stringify({
            type: "system",
            text: `${targetNickname}님은 등록된 사용자가 아닙니다`
          }));
          return;
        }

        const now = Date.now();
        // DB에 메시지 저장 (1:1 채팅, 오프라인 포함)
        // 저장된 행 id 를 기억해 둔다 → 발신자 화면에 붙일 '안 읽은 사람 수' 계산에 쓴다.
        const savedDm = saveMessage({
          roomType: 'dm',
          sender: senderNickname,
          receiver: targetNickname,
          text: text.slice(0, 2000),
          timestamp: now
        });
        const dmMsgId = Number(savedDm?.lastInsertRowid || 0);
        // 1:1 대화 참여자 = 나 + 상대.
        const dmParticipants = [senderNickname, targetNickname];
        // 방금 보낸 메시지는 상대가 아직 못 읽었으므로 카톡과 같이 '1' 로 시작한다.
        // (수신자가 지금 focus 중이면 unread_clear 로 커서가 이미 앞서 있으므로 0 이 된다)
        const dmUnreadCount = countUnreadForMessage(
          getReadCursors('dm', dmCursorTarget(senderNickname, targetNickname)),
          dmParticipants,
          senderNickname,
          dmMsgId,
        );

        // 대상 클라이언트 찾기
        let targetClient = null;
        for (const [client, nickname] of clients.entries()) {
          if (nickname === targetNickname) {
            targetClient = client;
            break;
          }
        }

        // ─── 1:1 자동방: DM 저장 직후 활성 1:1방(멤버 정확히 2명)을 확보 ───
        // 없으면 자동 생성해 양쪽 my_rooms에 띄운다. 단체방(방 만들기)은 별도 유지.
        // 방 history에도 이 메시지를 심어 방을 열면 대화가 이어지도록 한다.
        // (DM창 자동팝업은 그대로, room_message를 쏘지 않으므로 방 창 자동팝업 없음)
        let dmRoomId = null;
        try {
          // Node 이벤트루프 동기 구간에서 check→insert를 연속 수행해
          // 양쪽 동시 첫메시지에 의한 중복방 생성을 1차 방지한다.
          dmRoomId = findActiveOneToOneRoom(senderNickname, targetNickname);
          if (!dmRoomId) {
            dmRoomId = createRoom({
              name: `1:1 ${senderNickname},${targetNickname}`,
              owner: senderNickname,
              timestamp: now,
              members: [targetNickname],
            });
          }
          if (dmRoomId) {
            saveMessage({
              roomType: 'room',
              sender: senderNickname,
              receiver: null,
              text: text.slice(0, 2000),
              timestamp: now,
              roomId: dmRoomId,
            });
          }
        } catch (e) {
          console.error('1:1 자동방 생성 실패:', e);
          dmRoomId = null;
        }

        // 수신자 안읽은 건수 +1 (온라인/오프라인 무관하게 DB에 쌓인다)
        // 오프라인 중 온 메시지도 누적되어 다음 접속(다른 PC 포함) 시 배지로 표시된다.
        bumpUnread(targetNickname, 'dm', senderNickname, now);

        // DM은 1:1 방에도 저장되므로, 같은 내용에 대해 '내 채팅방' 쪽 배지도 함께 올린다.
        // (두 탭이 같은 대화를 보여주므로 어느 탭에서 열어도 읽음이 일관되게 처리된다)
        if (dmRoomId) {
          bumpUnread(targetNickname, 'room', String(dmRoomId), now);
        }

        // 대상이 온라인이면 실시간 전송
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          targetClient.send(JSON.stringify({
            type: "dm",
            from: senderNickname,
            to: targetNickname,
            text: text.slice(0, 2000),
            timestamp: now,
            dmRoomId,
            // 읽음 숫자 계산용 id (수신자 화면에서는 안 쓰지만 히스토리와 동일한 형태를 유지)
            msgId: dmMsgId,
            unreadCount: dmUnreadCount,
          }));
          // 안읽은 배지 실시간 반영 (DB 값은 위에서 이미 증가시켜 두었다)
          targetClient.send(JSON.stringify({
            type: 'unread_bump', scope: 'dm', target: senderNickname,
          }));
          // '내 채팅방' 탭의 1:1 방 배지도 함께 갱신
          if (dmRoomId) {
            targetClient.send(JSON.stringify({
              type: 'unread_bump', scope: 'room', target: String(dmRoomId),
            }));
          }
          // 자동방 목록/히스토리도 조용히 갱신 (방 창 자동팝업 없음)
          if (dmRoomId) {
            try {
              const peerHistory = getRecentRoomMessages(dmRoomId, 10);
              const peerMembers = getRoomMembers(dmRoomId);
              targetClient.send(JSON.stringify({
                type: 'my_rooms', rooms: getMyRooms(targetNickname),
              }));
              targetClient.send(JSON.stringify({
                type: 'history_room', roomId: dmRoomId,
                messages: decorateUnreadCounts(
                  'room',
                  String(dmRoomId),
                  peerHistory,
                  peerMembers,
                ),
              }));
              targetClient.send(JSON.stringify({
                type: 'room_members', roomId: dmRoomId, members: peerMembers,
              }));
            } catch (e) {
              console.error('1:1 자동방 목록 반영 실패(수신자):', e);
            }
          }
        }

        // 보낸 사람에게도 에코 (내 창에 표시용)
        // unreadCount 를 붙이는 것이 핵심 — 내 메시지 옆에 카톡식 숫자가 뜬다.
        ws.send(JSON.stringify({
          type: "dm",
          from: senderNickname,
          to: targetNickname,
          text: text.slice(0, 2000),
          timestamp: now,
          dmRoomId,
          msgId: dmMsgId,
          unreadCount: dmUnreadCount,
        }));

        // 자동방이 확보됐으면 발신자 방 목록/히스토리도 조용히 갱신
        // (room_message를 쏘지 않으므로 방 창 자동팝업 없음 — DM창 팝업만 유지)
        // 오프라인 수신자는 다음 join 때 getMyRooms()+history_room으로 자동 복원됨
        if (dmRoomId) {
          try {
            const selfHistory = getRecentRoomMessages(dmRoomId, 10);
            const selfMembers = getRoomMembers(dmRoomId);
            ws.send(JSON.stringify({
              type: 'my_rooms', rooms: getMyRooms(senderNickname),
            }));
            ws.send(JSON.stringify({
              type: 'history_room', roomId: dmRoomId,
              messages: decorateUnreadCounts(
                'room',
                String(dmRoomId),
                selfHistory,
                selfMembers,
              ),
            }));
            ws.send(JSON.stringify({
              type: 'room_members', roomId: dmRoomId, members: selfMembers,
            }));
          } catch (e) {
            console.error('1:1 자동방 목록 반영 실패(발신자):', e);
          }
        }

        // 대상이 오프라인이면 안내 (상대가 채팅창을 열 때 history_dm으로 수신됨)
        if (!targetClient) {
          ws.send(JSON.stringify({
            type: "system",
            text: `${targetNickname}님은 오프라인입니다. 메시지는 저장되어 채팅창을 열 때 확인할 수 있습니다`
          }));
        }
      }
      
      // MESSAGE 메시지 처리 — 전체채팅 제거로 더 이상 사용하지 않음
      // NOTE: 기존 'group' DB 행은 보존. 신규 'message' 타입은 무시한다.
      else if (data.type === 'message') {
        return;
      }

      // ─── 채팅창 열람: 1:1 최근 10건 조회 (창이 열릴 때마다 요청) ───
      else if (data.type === 'dm_history') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const withUser = String(data.withUser || '').trim();
        if (!withUser) return;
        // 1:1방이 있으면 그 방의 히스토리로 응답 (방 창에서 보낸 메시지 포함).
        // 방이 없으면 빈 배열 → 클라이언트는 "아직 대화가 없습니다"를 표시한다.
        let messages = [];
        let oneToOneRoomId = null;
        try {
          oneToOneRoomId = findActiveOneToOneRoom(senderNickname, withUser);
          if (oneToOneRoomId) messages = getRecentRoomMessages(oneToOneRoomId, 10);
        } catch (e) {
          console.error('1:1 방 히스토리 조회 실패:', e);
        }
        // DM창은 1:1 "방"의 메시지를 보여주므로 읽음 숫자도 그 방 스코프로 계산한다.
        // (markDmRead 가 DM/방 커서를 함께 갱신하므로 어느 창으로 읽어도 숫자가 같이 줄어든다)
        if (oneToOneRoomId) {
          messages = decorateUnreadCounts(
            'room',
            String(oneToOneRoomId),
            messages,
            getRoomMembers(oneToOneRoomId),
          );
        }
        ws.send(JSON.stringify({
          type: 'history_dm',
          withUser,
          messages,
        }));
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
      else if (data.type === 'unread_clear') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const target = String(data.target ?? '').trim();
        if (!target) return;
        if (data.scope === 'room') {
          const roomId = Number(target);
          if (!Number.isInteger(roomId)) return;
          // 멤버인 경우만 읽음 처리 (권한 판정은 DB 기준)
          if (!isMember(roomId, senderNickname)) return;
          const now = Date.now();
          clearUnread(senderNickname, 'room', String(roomId), now);
          // 읽음 커서를 이 방의 최신 메시지까지 전진 → 내 메시지 옆 숫자가 0 으로 내려간다
          markRead(senderNickname, 'room', String(roomId), getLatestRoomMessageId(roomId), now);
          broadcastReadAck('room', String(roomId));
          // 1:1 방을 열면 '사용자' 탭의 DM 배지도 함께 지운다 (같은 대화)
          const oneToOnePeer = getOneToOnePeer(roomId, senderNickname);
          if (oneToOnePeer) {
            clearUnread(senderNickname, 'dm', oneToOnePeer, Date.now());
            // DM 쪽 커서도 함께 갱신 (DM창에서 본 숫자도 같이 줄게)
            markRead(senderNickname, 'dm', dmCursorTarget(senderNickname, oneToOnePeer), getLatestDmMessageId(senderNickname, oneToOnePeer), Date.now());
            broadcastReadAck('dm', dmCursorTarget(senderNickname, oneToOnePeer));
          }
        } else {
          // DM 읽음: '사용자' 탭 배지와, 같은 대화를 보여주는 1:1 방 배지를 함께 지운다.
          // (한쪽 탭에서만 열어도 양쪽 모두 읽음 상태가 되어야 배지가 어긋나지 않는다)
          const now = Date.now();
          clearUnread(senderNickname, 'dm', target, now);
          markDmRead(senderNickname, target, now);
          broadcastReadAck('dm', dmCursorTarget(senderNickname, target));
          const oneToOneRoomId = findActiveOneToOneRoom(senderNickname, target);
          if (oneToOneRoomId) {
            clearUnread(senderNickname, 'room', String(oneToOneRoomId), now);
            // 1:1 방으로 표시 중인 창에도 같은 변화가 반영되어야 하므로 방 스코프도 알린다.
            broadcastReadAck('room', String(oneToOneRoomId));
          }
        }
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