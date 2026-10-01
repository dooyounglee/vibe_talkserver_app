// WebSocket 채팅 서버 생성
const WebSocket = require('ws');

// SQLite 데이터베이스 (메시지 저장)
const { saveMessage } = require('./db');

// 포트 8080에서 서버 실행
const wss = new WebSocket.Server({ port: 8080 });

// 클라이언트별 닉네임 저장 (WebSocket 인스턴스 -> 닉네임)
const clients = new Map();

// 모든 클라이언트에게 메시지 브로드캐스트
function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 현재 접속 중인 사용자 목록을 전체 클라이언트에게 전송
function broadcastUserList() {
  const userList = Array.from(clients.values());
  broadcast({
    type: "userlist",
    users: userList
  });
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
        const nickname = data.nickname;
        clients.set(ws, nickname);
        console.log(`${nickname} 닉네임으로 입장`);
        
        // 모든 클라이언트에게 입장 알림
        broadcast({
          type: 'system',
          text: `${nickname}님이 입장했습니다`
        });
        
        // 사용자 목록 업데이트 및 전송
        broadcastUserList();
      }
      
      // DM 메시지 처리: 1:1 메시지 전송
      else if (data.type === 'dm') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        
        const targetNickname = data.to;
        const text = data.text;
        
        // 대상 클라이언트 찾기
        let targetClient = null;
        for (const [client, nickname] of clients.entries()) {
          if (nickname === targetNickname) {
            targetClient = client;
            break;
          }
        }
        
        // 대상 클라이언트가 존재하는 경우
        if (targetClient) {
          // 대상 클라이언트에게 메시지 전송
          targetClient.send(JSON.stringify({
            type: "dm",
            from: senderNickname,
            to: targetNickname,
            text: text,
            timestamp: Date.now()
          }));
          
          // 보낸 사람에게도 동일한 메시지 전송
          ws.send(JSON.stringify({
            type: "dm",
            from: senderNickname,
            to: targetNickname,
            text: text,
            timestamp: Date.now()
          }));

          // DB에 메시지 저장 (1:1 채팅)
          saveMessage({
            roomType: 'dm',
            sender: senderNickname,
            receiver: targetNickname,
            text: text,
            timestamp: Date.now()
          });
        } 
        // 대상 클라이언트가 없는 경우
        else {
          // 보낸 사람에게 시스템 메시지 전송
          ws.send(JSON.stringify({
            type: "system",
            text: `${targetNickname}님은 접속 중이 아닙니다`
          }));
        }
      }
      
      // MESSAGE 메시지 처리: 채팅 브로드캐스트
      else if (data.type === 'message') {
        const senderNickname = clients.get(ws);
        if (!senderNickname) return;
        
        const messageData = {
          type: 'message',
          nickname: senderNickname,
          text: data.text,
          timestamp: Date.now()
        };
        
        // 모든 클라이언트에게 메시지 전송
        broadcast(messageData);
        console.log(`${senderNickname}: ${data.text}`);

        // DB에 메시지 저장 (전체 채팅)
        saveMessage({
          roomType: 'group',
          sender: senderNickname,
          receiver: null,
          text: data.text,
          timestamp: messageData.timestamp
        });
      }
    } catch (e) {
      console.error('메시지 파싱 오류:', e);
    }
  });
  
  // 클라이언트 연결 종료 시
  ws.on('close', () => {
    const nickname = clients.get(ws);
    if (nickname) {
      clients.delete(ws);
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