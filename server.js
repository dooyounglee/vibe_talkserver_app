// WebSocket 채팅 서버 생성
const WebSocket = require('ws');

// 포트 8080에서 서버 실행
const wss = new WebSocket.Server({ port: 8080 });

// 클라이언트별 닉네임 저장
const clients = new Map();

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
    }
  });
});

// 모든 클라이언트에게 메시지 브로드캐스트
function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}