// WebSocket 채팅 서버 생성
const WebSocket = require('ws');

// SQLite 데이터베이스 (메시지/방 저장/조회)
const {
  db,
  saveMessage,
  createRoom,
  getRoom,
  isRoomActive,
  isMember,
  addMember,
  removeMember,
  getRoomMembers,
  getEarliestMemberExcept,
  transferOwner,
  getMyRooms,
  softDeleteRoom,
  closeRoomIfEmpty,
  getRoomHistory,
  upsertUser,
  withdrawUser,
  isWithdrawn,
  isRegistered,
  getAllUsers,
} = require('./db');

// 포트 8080에서 서버 실행
const wss = new WebSocket.Server({ port: 8080 });

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

// 등록된 전체 사용자 목록 + 현재 접속중 목록을 전체 클라이언트에게 전송
// users: DB 등록 사용자 전체 (탈퇴 제외), onlineUsers: 현재 접속중
function broadcastUserList() {
  const onlineUsers = Array.from(clients.values());
  const users = getAllUsers();
  broadcast({
    type: "userlist",
    users,
    onlineUsers,
  });
}

// 그룹 채팅 기록 조회 — 전체채팅 제거로 더 이상 사용하지 않음 (기존 DB 행은 보존)
// function getRecentGroupHistory() — deleted

// 특정 닉네임과 관련된 DM 기록을 상대방별로 그룹화해 반환
// 각 상대방마다 최근 limit개를 시간순 오름차순으로 정리
function getRecentDmHistories(nickname, limit = 50) {
  const rows = db.prepare(
    `SELECT sender, receiver, text, timestamp FROM messages
     WHERE room_type = 'dm' AND (sender = ? OR receiver = ?)
     ORDER BY timestamp ASC, id ASC`
  ).all(nickname, nickname);

  // 상대방 닉네임별로 메시지 그룹화
  const byUser = new Map();
  for (const row of rows) {
    const counterpart = row.sender === nickname ? row.receiver : row.sender;
    if (!byUser.has(counterpart)) {
      byUser.set(counterpart, []);
    }
    byUser.get(counterpart).push({
      nickname: row.sender,
      text: row.text,
      timestamp: row.timestamp
    });
  }

  // 상대방별 최근 limit개만 추출
  const histories = [];
  for (const [withUser, messages] of byUser.entries()) {
    histories.push({
      withUser: withUser,
      messages: messages.slice(-limit)
    });
  }
  return histories;
}

// 새로운 클라이언트 연결 시
wss.on('connection', (ws) => {
  console.log('새로운 클라이언트가 연결됨');

  // 클라이언트가 메시지를 받을 때
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // JOIN 메시지 처리: 닉네임 설정 및 입장 알림
      if (data.type === 'join') {
        const nickname = String(data.nickname || '').trim();
        if (!nickname) return;
        // 등록 사용자에 자동 등록 (탈퇴 상태면 복구)
        upsertUser(nickname, Date.now());
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

        // 내 방별 대화 기록 전송 (방금 접속한 클라이언트에게만)
        for (const r of myRooms) {
          ws.send(JSON.stringify({
            type: 'history_room',
            roomId: r.roomId,
            messages: getRoomHistory(r.roomId, 50)
          }));
        }

        // 이 닉네임과 관련된 DM 기록을 상대방별로 전송 (방금 접속한 클라이언트에게만)
        for (const history of getRecentDmHistories(nickname, 50)) {
          ws.send(JSON.stringify({
            type: 'history_dm',
            withUser: history.withUser,
            messages: history.messages
          }));
        }
      }
      
      // DM 메시지 처리: 1:1 메시지 전송 (오프라인 포함 — DB 저장 후 접속 시 history로 수신)
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
        saveMessage({
          roomType: 'dm',
          sender: senderNickname,
          receiver: targetNickname,
          text: text.slice(0, 2000),
          timestamp: now
        });

        // 대상 클라이언트 찾기
        let targetClient = null;
        for (const [client, nickname] of clients.entries()) {
          if (nickname === targetNickname) {
            targetClient = client;
            break;
          }
        }

        // 대상이 온라인이면 실시간 전송
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          targetClient.send(JSON.stringify({
            type: "dm",
            from: senderNickname,
            to: targetNickname,
            text: text.slice(0, 2000),
            timestamp: now
          }));
        }

        // 보낸 사람에게도 에코 (내 창에 표시용)
        ws.send(JSON.stringify({
          type: "dm",
          from: senderNickname,
          to: targetNickname,
          text: text.slice(0, 2000),
          timestamp: now
        }));

        // 대상이 오프라인이면 안내 (다음 접속 시 history_dm으로 수신됨)
        if (!targetClient) {
          ws.send(JSON.stringify({
            type: "system",
            text: `${targetNickname}님은 오프라인입니다. 메시지는 저장되어 다음 접속 시 전달됩니다`
          }));
        }
      }
      
      // MESSAGE 메시지 처리 — 전체채팅 제거로 더 이상 사용하지 않음
      // NOTE: 기존 'group' DB 행은 보존. 신규 'message' 타입은 무시한다.
      else if (data.type === 'message') {
        return;
      }
      // ─── 번호방: 생성 (초대 멤버 포함 가능) ───
      else if (data.type === 'room_create') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        const name = String(data.name || '').trim().slice(0, 30);
        if (!name) {
          ws.send(JSON.stringify({ type: 'system', text: '방 이름을 입력하세요.' }));
          return;
        }
        // 초대생성: members 배열(닉네임 목록)을 함께 받아 방 생성 시 멤버로 등록
        // 탈퇴한 사용자는 초대 대상에서 제외
        const rawMembers = Array.isArray(data.members) ? data.members : [];
        const members = rawMembers
          .map((m) => String(m || '').trim())
          .filter((m) => m && m !== senderNickname && !isWithdrawn(m))
          .slice(0, 50);
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
          type: 'history_room', roomId, messages: getRoomHistory(roomId, 50),
        }));
        ws.send(JSON.stringify({ type: 'my_rooms', rooms: getMyRooms(senderNickname) }));
        broadcastToRoom(roomId, {
          type: 'room_members', roomId, members: getRoomMembers(roomId),
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
        const payload = {
          type: 'room_message', roomId,
          from: senderNickname, text: text.slice(0, 2000), timestamp,
        };
        broadcastToRoom(roomId, payload);
        console.log(`#${roomId} ${senderNickname}: ${text}`);
        saveMessage({
          roomType: 'room', sender: senderNickname, receiver: null,
          text: payload.text, timestamp, roomId,
        });
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