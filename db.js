// SQLite 데이터베이스 초기화 (better-sqlite3)
const path = require('path');
const Database = require('better-sqlite3');

// 프로젝트 루트의 chat.db 파일 사용 (없으면 자동 생성)
const db = new Database(path.join(__dirname, 'chat.db'));

// messages 테이블 생성 (없으면 자동 생성)
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_type TEXT NOT NULL,
    sender TEXT NOT NULL,
    receiver TEXT,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )
`);

// 메시지 저장용 prepared statement
const insertMessageStmt = db.prepare(
  'INSERT INTO messages (room_type, sender, receiver, text, timestamp) VALUES (?, ?, ?, ?, ?)'
);

// 메시지 저장 (roomType: "group" | "dm", receiver는 dm일 때만 값, group이면 null)
function saveMessage({ roomType, sender, receiver = null, text, timestamp }) {
  return insertMessageStmt.run(roomType, sender, receiver, text, timestamp);
}

module.exports = { db, saveMessage };
