// SQLite 데이터베이스 초기화 (better-sqlite3)
const path = require('path');
const Database = require('better-sqlite3');

// 프로젝트 루트의 chat.db 파일 사용 (없으면 자동 생성)
// NOTE: 테스트/스모크 실행 시 VIBE_TEST_DB로 임시 DB를 지정해 실제 DB와 격리한다.
const db = new Database(process.env.VIBE_TEST_DB || path.join(__dirname, 'chat.db'));

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
    display_name TEXT NULL,
    UNIQUE(room_id, nickname)
  )
`);

// ─── 등록 사용자 (users) ───
// admin이 직접 추가/수정. join 시 자동 등록하지 않음 (요구사항 4).
// 목록은 탈퇴(is_deleted=1) 제외 (일반 사용자용), 관리는 전체 조회 사용.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    nickname TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL
  )
`);

// 'admin' 사용자 시드 (없으면 생성, 있으면 유지)
try {
  db.prepare(
    `INSERT OR IGNORE INTO users (nickname, created_at, is_deleted, deleted_at)
     VALUES ('admin', ?, 0, NULL)`
  ).run(Date.now());
} catch (e) {
  console.error('admin 시드 실패:', e);
}

// ─── 안읽은 건수 (unread) ───
// 화면 메모리/localStorage는 기기(브라우저)별로 분리되므로 다른 PC에서 접속하면
// 안읽은 건수가 사라진다. 서버 DB를 단일 진실로 두고 여기에 영속화한다.
//   nickname : 소유자 (안 읽은 쪽)
//   scope    : 'dm' | 'room'
//   target   : dm이면 상대 닉네임, room이면 방번호(문자열)
// 읽음 처리(0건)는 행을 즉시 삭제하지 않고 count=0으로만 갱신한다.
// (주기 정리 여부는 보류 — 행이 적어 비용 문제 없음)
db.exec(`
  CREATE TABLE IF NOT EXISTS unread (
    nickname TEXT NOT NULL,
    scope TEXT NOT NULL,
    target TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (nickname, scope, target)
  )
`);

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_unread_nick ON unread(nickname, scope)`);
} catch (e) {
  console.error('unread 인덱스 생성 실패:', e);
}

const bumpUnreadStmt = db.prepare(
  `INSERT INTO unread (nickname, scope, target, count, updated_at) VALUES (?, ?, ?, 1, ?)
   ON CONFLICT(nickname, scope, target) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`
);
const setUnreadStmt = db.prepare(
  `INSERT INTO unread (nickname, scope, target, count, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(nickname, scope, target) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`
);
const getUnreadStmt = db.prepare(
  `SELECT scope, target, count FROM unread WHERE nickname = ? AND count > 0`
);
const clearUnreadStmt = db.prepare(
  `UPDATE unread SET count = 0, updated_at = ? WHERE nickname = ? AND scope = ? AND target = ?`
);

/** 안읽은 건수 1 증가 (받은 사람 기준) */
function bumpUnread(nickname, scope, target, timestamp) {
  if (!nickname || !scope || !target) return;
  try {
    bumpUnreadStmt.run(String(nickname), String(scope), String(target), timestamp);
  } catch (e) {
    console.error('안읽은 건수 증가 실패:', e);
  }
}

/** 안읽은 건수를 지정 값으로 설정 (0이면 읽음 처리) */
function setUnread(nickname, scope, target, count, timestamp) {
  if (!nickname || !scope || !target) return;
  try {
    setUnreadStmt.run(String(nickname), String(scope), String(target), Math.max(0, Math.floor(count)), timestamp);
  } catch (e) {
    console.error('안읽은 건수 설정 실패:', e);
  }
}

/**
 * 접속 시 내려줄 안읽은 건수 전체.
 * { dm: {상대: 건수}, room: {방번호: 건수} } 형태로 반환한다.
 */
function getUnreadMap(nickname) {
  const out = { dm: {}, room: {} };
  if (!nickname) return out;
  try {
    for (const row of getUnreadStmt.all(nickname)) {
      const count = Number(row.count) || 0;
      if (count <= 0) continue;
      if (row.scope === 'dm') out.dm[String(row.target)] = count;
      else if (row.scope === 'room') out.room[String(row.target)] = count;
    }
  } catch (e) {
    console.error('안읽은 건수 조회 실패:', e);
  }
  return out;
}

/** 읽음 처리 (해당 항목만 0으로) */
function clearUnread(nickname, scope, target, timestamp) {
  if (!nickname || !scope || !target) return;
  try {
    clearUnreadStmt.run(timestamp, String(nickname), String(scope), String(target));
  } catch (e) {
    console.error('안읽은 건수 읽음 처리 실패:', e);
  }
}

/**
 * 1:1 방에서 나를 제외한 상대 닉네임 (1:1이 아니면 null).
 * DM 채팅창과 1:1 방은 같은 대화를 보여주므로, 읽음 처리 시 양쪽 배지를 함께 정리할 때 쓴다.
 */
function getOneToOnePeer(roomId, nickname) {
  const members = getRoomMembers(roomId);
  if (members.length !== 2) return null;
  const me = String(nickname || '').trim();
  const other = members.find((m) => m !== me);
  return other || null;
}

/** 방 탈퇴/삭제 시 해당 사용자의 방 안읽은 건수도 정리 */
function clearUnreadForRoom(nickname, roomId, timestamp) {
  clearUnread(nickname, 'room', String(roomId), timestamp);
}

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

// ─── 사용자별 방 제목 (room_members.display_name) ───
// 1:1방은 각자 상대방 닉네임이 보이도록 per-user 저장.
// 그룹방은 NULL → rooms.name 폴백. 추후 "각자 제목 수정" API용 컬럼.
try {
  const mcols = db.prepare(`PRAGMA table_info(room_members)`).all();
  const hasDisplayName = mcols.some((c) => c.name === 'display_name');
  if (!hasDisplayName) {
    db.exec(`ALTER TABLE room_members ADD COLUMN display_name TEXT NULL`);
  }
} catch (e) {
  console.error('room_members.display_name 마이그레이션 실패:', e);
}

// 기존 1:1방 백필: 멤버 2명 + display_name NULL인 행만 상대 닉네임으로 채움
try {
  const targets = db.prepare(`
    SELECT m.room_id AS roomId, m.nickname AS nickname
    FROM room_members m
    INNER JOIN rooms r ON r.room_id = m.room_id
    WHERE r.is_deleted = 0 AND r.is_closed = 0
      AND m.display_name IS NULL
      AND (SELECT COUNT(*) FROM room_members m2 WHERE m2.room_id = m.room_id) = 2
  `).all();
  const otherStmt = db.prepare(
    `SELECT nickname FROM room_members WHERE room_id = ? AND nickname != ? LIMIT 1`
  );
  const fillStmt = db.prepare(
    `UPDATE room_members SET display_name = ? WHERE room_id = ? AND nickname = ? AND display_name IS NULL`
  );
  for (const t of targets) {
    try {
      const other = otherStmt.get(t.roomId, t.nickname);
      if (other && other.nickname) {
        fillStmt.run(other.nickname, t.roomId, t.nickname);
      }
    } catch { /* 행별 실패 무시 */ }
  }
  if (targets.length > 0) console.log(`1:1방 제목 백필: ${targets.length}행`);
} catch (e) {
  console.error('1:1방 제목 백필 실패:', e);
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

// 참여자 전체(방장 + 초대된 멤버) 이름을 오름차순으로 이어 붙인 기본 방 이름.
// 예) ['lee','sam','kim'] → "kim,lee,sam"
// 빈 값/중복은 걸러내고, 비교는 localeCompare로 한다(사용자 목록 정렬과 동일 기준).
function joinMemberNames(owner, members = []) {
  const names = [];
  const seen = new Set();
  for (const raw of [owner, ...(Array.isArray(members) ? members : [])]) {
    const nick = String(raw ?? '').trim();
    if (!nick || seen.has(nick)) continue;
    seen.add(nick);
    names.push(nick);
  }
  return names.sort((a, b) => a.localeCompare(b)).join(',');
}

function createRoom({ name, owner, timestamp, members = [] }) {
  // 초대 멤버를 함께 등록 (중복/방장 제외, 빈 문자열 제외)
  const seen = new Set([owner]);
  const invited = [];
  for (const raw of Array.isArray(members) ? members : []) {
    const nick = String(raw || '').trim();
    if (!nick || seen.has(nick)) continue;
    seen.add(nick);
    invited.push(nick);
  }
  // 방 이름 미전달 시 참여자 이름 자동 연결(오름차순, 쉼표)로 기본값을 만든다.
  const autoName = joinMemberNames(owner, invited);
  const info = db
    .prepare(`INSERT INTO rooms (name, owner, created_at) VALUES (?, ?, ?)`)
    .run(String(name ?? '').trim() || autoName, owner, timestamp);
  const roomId = Number(info.lastInsertRowid);
  // 표시제목(display_name) 규칙
  //   1:1(총 2명) : 각자 상대방 닉네임이 뜸 (기존 유지)
  //   3명 이상    : 모든 참여자 이름(오름차순 쉼표 연결)을 그대로 저장
  //                 → rooms.name 폴백 없이도 목록/창 제목이 바로 맞는다
  const isOneToOne = invited.length === 1;
  const ownerDisplay = isOneToOne ? invited[0] : autoName;
  db.prepare(`INSERT INTO room_members (room_id, nickname, joined_at, display_name) VALUES (?, ?, ?, ?)`)
    .run(roomId, owner, timestamp, ownerDisplay);
  let seq = 1;
  for (const nick of invited) {
    try {
      // 초대받은 멤버에게 보이는 제목 = 방장(상대) 닉네임 (1:1) / 참여자 전체 이름 (그룹)
      const memberDisplay = isOneToOne ? owner : autoName;
      db.prepare(
        `INSERT OR IGNORE INTO room_members (room_id, nickname, joined_at, display_name) VALUES (?, ?, ?, ?)`
      ).run(roomId, nick, timestamp + seq, memberDisplay);
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

// ─── 1:1 자동방: 활성(삭제/폐쇄 제외) + 멤버 정확히 2명(a,b)인 방 조회 ───
// DM 첫 전송 시점에 find-or-create 용. 그룹방(3명+)은 절대 매칭되지 않음.
function findActiveOneToOneRoom(nickA, nickB) {
  const a = String(nickA || '').trim();
  const b = String(nickB || '').trim();
  if (!a || !b || a === b) return null;
  try {
    const row = db
      .prepare(
        `SELECT m.room_id AS roomId
         FROM room_members m
         INNER JOIN rooms r ON r.room_id = m.room_id
         WHERE r.is_deleted = 0 AND r.is_closed = 0
           AND m.nickname IN (?, ?)
         GROUP BY m.room_id
         HAVING COUNT(*) = 2
            AND (SELECT COUNT(*) FROM room_members m2 WHERE m2.room_id = m.room_id) = 2
         ORDER BY m.room_id ASC
         LIMIT 1`
      )
      .get(a, b);
    return row ? Number(row.roomId) : null;
  } catch {
    return null;
  }
}

function addMember(roomId, nickname, timestamp) {
  db.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, nickname, joined_at, display_name) VALUES (?, ?, ?, NULL)`
  ).run(roomId, nickname, timestamp);
}

// 사용자별 방 제목 조회 (없으면 NULL → 호출자가 rooms.name 폴백)
// 추후 "각자 제목 수정" API에서 사용
function getRoomDisplayName(roomId, nickname) {
  try {
    const row = db
      .prepare(`SELECT display_name FROM room_members WHERE room_id = ? AND nickname = ?`)
      .get(roomId, nickname);
    return row && row.display_name ? String(row.display_name) : null;
  } catch {
    return null;
  }
}

// 사용자별 방 제목 저장 (본인 행만 수정, 30자 제한)
// 추후 "각자 제목 수정" API에서 사용
function setRoomDisplayName(roomId, nickname, displayName) {
  const name = String(displayName || '').trim().slice(0, 30);
  if (!name) return false;
  try {
    const info = db
      .prepare(`UPDATE room_members SET display_name = ? WHERE room_id = ? AND nickname = ?`)
      .run(name, roomId, nickname);
    return Number(info.changes) > 0;
  } catch {
    return false;
  }
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

// 마지막 메시지 요약: 방별 가장 최근 1건 (내용/시간/발신자)
// row_number로 방마다 1행만 뽑아 LEFT JOIN 한다 (메시지 없는 방은 NULL)
// 정렬 기준은 timestamp DESC, id DESC — 히스토리 조회와 동일한 "최신" 판정
const lastMessageJoin = `
    LEFT JOIN (
      SELECT room_id, text, timestamp, sender FROM (
        SELECT room_id, text, timestamp, sender,
               ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY timestamp DESC, id DESC) AS rn
        FROM messages
        WHERE room_type = 'room' AND room_id IS NOT NULL
      ) WHERE rn = 1
    ) last_msg ON last_msg.room_id = r.room_id`;

// 내가 속한 활성방 목록 (삭제/폐쇄 제외) + 인원수 + 사용자별 표시제목 + 마지막 메시지
// displayName: room_members.display_name (1:1=상대닉네임/개별수정), NULL이면 rooms.name 폴백
// lastMessage/lastMessageAt/lastMessageSender: 마지막 메시지 요약 (없으면 null)
function getMyRooms(nickname) {
  let hasDisplayCol = true;
  try {
    const mcols = db.prepare(`PRAGMA table_info(room_members)`).all();
    hasDisplayCol = mcols.some((c) => c.name === 'display_name');
  } catch {
    hasDisplayCol = false;
  }
  const displayExpr = hasDisplayCol
    ? `COALESCE(m_self.display_name, r.name)`
    : `r.name`;
  const rows = db
    .prepare(
      `SELECT r.room_id AS roomId, r.name, r.owner, ${displayExpr} AS displayName,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.room_id) AS memberCount,
              last_msg.text AS lastMessage,
              last_msg.timestamp AS lastMessageAt,
              last_msg.sender AS lastMessageSender
       FROM rooms r
       INNER JOIN room_members m_self ON m_self.room_id = r.room_id AND m_self.nickname = ?
       ${lastMessageJoin}
       WHERE r.is_deleted = 0 AND r.is_closed = 0
       ORDER BY r.room_id ASC`
    )
    .all(nickname);
  // displayName이 NULL/빈문자면 name으로 폴백 (구버전/비정상 행 안전장치)
  return rows.map((r) => ({
    roomId: r.roomId,
    name: r.name,
    owner: r.owner,
    memberCount: r.memberCount,
    displayName: r.displayName && String(r.displayName).trim() !== '' ? String(r.displayName) : r.name,
    lastMessage: r.lastMessage == null ? null : String(r.lastMessage),
    lastMessageAt: r.lastMessageAt == null ? null : Number(r.lastMessageAt),
    lastMessageSender: r.lastMessageSender == null ? null : String(r.lastMessageSender),
  }));
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

// 채팅창 열람용: 방 최근 N건 (기본 10건, 오래된 → 최신 순)
function getRecentRoomMessages(roomId, limit = 10) {
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

// 채팅창 열람용: 두 사람 사이 1:1 최근 N건 (기본 10건, 오래된 → 최신 순)
function getRecentDmMessages(nickname, withUser, limit = 10) {
  const me = String(nickname || '').trim();
  const peer = String(withUser || '').trim();
  if (!me || !peer || me === peer) return [];
  const rows = db
    .prepare(
      `SELECT sender, text, timestamp FROM messages
       WHERE room_type = 'dm'
         AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`
    )
    .all(me, peer, peer, me, limit);
  return rows.reverse().map((row) => ({
    nickname: row.sender,
    text: row.text,
    timestamp: row.timestamp,
  }));
}

// ─── 등록 사용자 (users) ───
// admin이 직접 추가/수정. 목록은 탈퇴(is_deleted=1) 제외.
function upsertUser(nickname, timestamp, isDeleted = false) {
  const nick = String(nickname || '').trim();
  if (!nick) return;
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const deleted = isDeleted ? 1 : 0;
  if (deleted === 1) {
    db.prepare(
      `INSERT INTO users (nickname, created_at, is_deleted, deleted_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(nickname) DO UPDATE SET is_deleted = 1, deleted_at = excluded.deleted_at`
    ).run(nick, ts, ts);
  } else {
    db.prepare(
      `INSERT INTO users (nickname, created_at, is_deleted, deleted_at)
       VALUES (?, ?, 0, NULL)
       ON CONFLICT(nickname) DO UPDATE SET is_deleted = 0, deleted_at = NULL`
    ).run(nick, ts);
  }
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

// 관리용 전체 사용자 (탈퇴 포함, 탈퇴여부 함께 반환 — admin 전용 응답에 사용)
function getAllUsersDetail() {
  return db
    .prepare(`SELECT nickname, is_deleted FROM users ORDER BY nickname ASC`)
    .all()
    .map((r) => ({ nickname: r.nickname, isDeleted: Number(r.is_deleted) === 1 }));
}

module.exports = {
  db,
  saveMessage,
  createRoom,
  joinMemberNames,
  getRoom,
  isRoomActive,
  isMember,
  findActiveOneToOneRoom,
  addMember,
  removeMember,
  countMembers,
  getRoomMembers,
  getEarliestMemberExcept,
  transferOwner,
  getMyRooms,
  getRoomDisplayName,
  setRoomDisplayName,
  softDeleteRoom,
  closeRoomIfEmpty,
  getRoomHistory,
  getRecentRoomMessages,
  getRecentDmMessages,
  upsertUser,
  withdrawUser,
  isWithdrawn,
  isRegistered,
  getAllUsers,
  getAllUsersDetail,
  bumpUnread,
  setUnread,
  getUnreadMap,
  clearUnread,
  clearUnreadForRoom,
  getOneToOnePeer,
};
