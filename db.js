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

// 번호방용: rooms / room_members (없으면 자동 생성)
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    room_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL,
    deleted_by TEXT NULL,
    is_closed INTEGER NOT NULL DEFAULT 0,
    closed_at INTEGER NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL,
    nickname TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    UNIQUE(room_id, nickname)
  )
`);

// ─── 등록 사용자 (users) ───
// join 시 자동 등록, 탈퇴(is_deleted=1) 제외하고 목록에 노출
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    nickname TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL
  )
`);

// 기존 DB 마이그레이션: messages.room_id 컬럼 추가 (이미 있으면 무시)
try {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all();
  const hasRoomId = cols.some((c) => c.name === 'room_id');
  if (!hasRoomId) {
    db.exec(`ALTER TABLE messages ADD COLUMN room_id INTEGER NULL`);
  }
} catch (e) {
  console.error('messages.room_id 마이그레이션 실패:', e);
}

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, timestamp, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_members_nick ON room_members(nickname, room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id, nickname)`);
} catch (e) {
  console.error('인덱스 생성 실패:', e);
}

// 메시지 저장용 prepared statement
const insertMessageStmt = db.prepare(
  'INSERT INTO messages (room_type, sender, receiver, text, timestamp, room_id) VALUES (?, ?, ?, ?, ?, ?)'
);

// 메시지 저장 (roomType: "dm" | "room", receiver는 dm일 때만 값, roomId는 room일 때만 값)
// NOTE: 기존 'group' 행은 DB에 그대로 두지만 신규 저장은 하지 않는다.
function saveMessage({ roomType, sender, receiver = null, text, timestamp, roomId = null }) {
  return insertMessageStmt.run(roomType, sender, receiver, text, timestamp, roomId);
}

// ─── 번호방 CRUD ───

function createRoom({ name, owner, timestamp, members = [] }) {
  const info = db
    .prepare(`INSERT INTO rooms (name, owner, created_at) VALUES (?, ?, ?)`)
    .run(name, owner, timestamp);
  const roomId = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO room_members (room_id, nickname, joined_at) VALUES (?, ?, ?)`)
    .run(roomId, owner, timestamp);
  // 초대 멤버를 함께 등록 (중복/방장 제외, 빈 문자열 제외)
  const seen = new Set([owner]);
  let seq = 1;
  for (const raw of Array.isArray(members) ? members : []) {
    const nick = String(raw || '').trim();
    if (!nick || seen.has(nick)) continue;
    seen.add(nick);
    try {
      db.prepare(
        `INSERT OR IGNORE INTO room_members (room_id, nickname, joined_at) VALUES (?, ?, ?)`
      ).run(roomId, nick, timestamp + seq);
      seq += 1;
    } catch {
      // 무시 (개별 멤버 추가 실패가 방 생성을 막지 않음)
    }
  }
  return roomId;
}

function getRoom(roomId) {
  return db.prepare(`SELECT * FROM rooms WHERE room_id = ?`).get(roomId);
}

function isRoomActive(room) {
  return !!room && room.is_deleted === 0 && room.is_closed === 0;
}

function isMember(roomId, nickname) {
  const row = db
    .prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND nickname = ?`)
    .get(roomId, nickname);
  return !!row;
}

function addMember(roomId, nickname, timestamp) {
  db.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, nickname, joined_at) VALUES (?, ?, ?)`
  ).run(roomId, nickname, timestamp);
}

function removeMember(roomId, nickname) {
  db.prepare(`DELETE FROM room_members WHERE room_id = ? AND nickname = ?`).run(
    roomId,
    nickname
  );
}

function countMembers(roomId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM room_members WHERE room_id = ?`)
    .get(roomId);
  return row ? Number(row.cnt) : 0;
}

function getRoomMembers(roomId) {
  return db
    .prepare(
      `SELECT nickname FROM room_members WHERE room_id = ? ORDER BY joined_at ASC, rowid ASC`
    )
    .all(roomId)
    .map((r) => r.nickname);
}

function getEarliestMemberExcept(roomId, exceptNickname) {
  const row = db
    .prepare(
      `SELECT nickname FROM room_members WHERE room_id = ? AND nickname != ? ORDER BY joined_at ASC, rowid ASC LIMIT 1`
    )
    .get(roomId, exceptNickname);
  return row ? row.nickname : null;
}

function transferOwner(roomId, newOwner) {
  db.prepare(`UPDATE rooms SET owner = ? WHERE room_id = ?`).run(newOwner, roomId);
}

// 내가 속한 활성방 목록 (삭제/폐쇄 제외) + 인원수
function getMyRooms(nickname) {
  return db
    .prepare(
      `SELECT r.room_id AS roomId, r.name, r.owner,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.room_id) AS memberCount
       FROM rooms r
       INNER JOIN room_members m ON m.room_id = r.room_id AND m.nickname = ?
       WHERE r.is_deleted = 0 AND r.is_closed = 0
       ORDER BY r.room_id ASC`
    )
    .all(nickname);
}

function softDeleteRoom(roomId, deletedBy, timestamp) {
  db.prepare(
    `UPDATE rooms SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE room_id = ?`
  ).run(timestamp, deletedBy, roomId);
}

function closeRoomIfEmpty(roomId, timestamp) {
  if (countMembers(roomId) === 0) {
    db.prepare(`UPDATE rooms SET is_closed = 1, closed_at = ? WHERE room_id = ?`).run(
      timestamp,
      roomId
    );
    return true;
  }
  return false;
}

// 방 대화 기록 (오래된 → 최신 순)
function getRoomHistory(roomId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT sender, text, timestamp FROM messages
       WHERE room_type = 'room' AND room_id = ?
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`
    )
    .all(roomId, limit);
  return rows.reverse().map((row) => ({
    nickname: row.sender,
    text: row.text,
    timestamp: row.timestamp,
  }));
}

// ─── 등록 사용자 (users) ───
// join 시 자동 등록. 목록은 탈퇴(is_deleted=1) 제외.
function upsertUser(nickname, timestamp) {
  const nick = String(nickname || '').trim();
  if (!nick) return;
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  db.prepare(
    `INSERT INTO users (nickname, created_at, is_deleted, deleted_at)
     VALUES (?, ?, 0, NULL)
     ON CONFLICT(nickname) DO UPDATE SET is_deleted = 0, deleted_at = NULL`
  ).run(nick, ts);
}

function withdrawUser(nickname, timestamp) {
  const nick = String(nickname || '').trim();
  if (!nick) return;
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  db.prepare(
    `UPDATE users SET is_deleted = 1, deleted_at = ? WHERE nickname = ?`
  ).run(ts, nick);
}

function isWithdrawn(nickname) {
  const nick = String(nickname || '').trim();
  if (!nick) return false;
  const row = db
    .prepare(`SELECT is_deleted FROM users WHERE nickname = ?`)
    .get(nick);
  return !!row && Number(row.is_deleted) === 1;
}

function isRegistered(nickname) {
  const nick = String(nickname || '').trim();
  if (!nick) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM users WHERE nickname = ? AND is_deleted = 0`)
    .get(nick);
  return !!row;
}

// 등록된 전체 사용자 (탈퇴 제외, 닉네임 오름차순)
function getAllUsers() {
  return db
    .prepare(`SELECT nickname FROM users WHERE is_deleted = 0 ORDER BY nickname ASC`)
    .all()
    .map((r) => r.nickname);
}

module.exports = {
  db,
  saveMessage,
  createRoom,
  getRoom,
  isRoomActive,
  isMember,
  addMember,
  removeMember,
  countMembers,
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
};
