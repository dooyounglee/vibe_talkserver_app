// SQLite 데이터베이스 초기화 (better-sqlite3) — user_no PK + login_id 체제 (fresh)
const path = require('path');
const Database = require('better-sqlite3');

// 프로젝트 루트의 chat.db 파일 사용 (없으면 자동 생성)
// NOTE: 테스트/스모크 실행 시 VIBE_TEST_DB로 임시 DB를 지정해 실제 DB와 격리한다.
const db = new Database(process.env.VIBE_TEST_DB || path.join(__dirname, 'chat.db'));

// ─── 검증 규칙 ───
// login_id: 영문+숫자, 1~20자, 불변
// nickname: trim 후 1~20자, 전역 UNIQUE(탈퇴 포함), 변경 가능 + 중복 체크
const LOGIN_ID_RE = /^[A-Za-z0-9]{1,20}$/;
function isValidLoginId(v) {
  return typeof v === 'string' && LOGIN_ID_RE.test(v.trim());
}
function normalizeNickname(v) {
  const s = String(v ?? '').trim().slice(0, 20);
  return s;
}
function toUserNo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// admin 판정: user_no === 1 고정
function isAdminNo(userNo) {
  return Number(userNo) === 1;
}

// messages 테이블 (receiver 삭제, sender_no + sender_name 스냅샷)
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_type TEXT NOT NULL,
    sender_no INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    room_id INTEGER NULL
  )
`);

// 번호방용: rooms / room_members
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    room_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_no INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL,
    deleted_by INTEGER NULL,
    is_closed INTEGER NOT NULL DEFAULT 0,
    closed_at INTEGER NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL,
    user_no INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    display_name TEXT NULL,
    UNIQUE(room_id, user_no)
  )
`);

// ─── 등록 사용자 (users) ───
// user_no PK, login_id UNIQUE(불변/재사용 불가), nickname UNIQUE(탈퇴 포함 재사용 불가)
// phone / user_name: admin 관리 화면용 (이번 전환에서 선반영, NULL 허용)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_no INTEGER PRIMARY KEY AUTOINCREMENT,
    login_id TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL UNIQUE,
    phone TEXT NULL,
    user_name TEXT NULL,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL
  )
`);

// 'admin' 시드 (user_no=1 보장: 최초 INSERT)
try {
  db.prepare(
    `INSERT OR IGNORE INTO users (user_no, login_id, nickname, created_at, is_deleted, deleted_at)
     VALUES (1, 'admin', 'admin', ?, 0, NULL)`
  ).run(Date.now());
} catch (e) {
  console.error('admin 시드 실패:', e);
}

// ─── 안읽은 건수 (unread) ───
// 서버 DB를 단일 진실로 두고 여기에 영속화한다.
//   user_no  : 소유자 (안 읽은 쪽)
//   scope    : 'room'
//   target   : 방번호(문자열)
// 읽음 처리(0건)는 행을 즉시 삭제하지 않고 count=0으로만 갱신한다.
db.exec(`
  CREATE TABLE IF NOT EXISTS unread (
    user_no INTEGER NOT NULL,
    scope TEXT NOT NULL,
    target TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_no, scope, target)
  )
`);

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_unread_no ON unread(user_no, scope)`);
} catch (e) {
  console.error('unread 인덱스 생성 실패:', e);
}

const bumpUnreadStmt = db.prepare(
  `INSERT INTO unread (user_no, scope, target, count, updated_at) VALUES (?, ?, ?, 1, ?)
   ON CONFLICT(user_no, scope, target) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`
);
const setUnreadStmt = db.prepare(
  `INSERT INTO unread (user_no, scope, target, count, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_no, scope, target) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`
);
const getUnreadStmt = db.prepare(
  `SELECT scope, target, count FROM unread WHERE user_no = ? AND count > 0`
);
const clearUnreadStmt = db.prepare(
  `UPDATE unread SET count = 0, updated_at = ? WHERE user_no = ? AND scope = ? AND target = ?`
);

/** 안읽은 건수 1 증가 (받은 사람 기준) */
function bumpUnread(userNo, scope, target, timestamp) {
  const no = toUserNo(userNo);
  if (!no || !scope || !target) return;
  try {
    bumpUnreadStmt.run(no, String(scope), String(target), timestamp);
  } catch (e) {
    console.error('안읽은 건수 증가 실패:', e);
  }
}

/** 안읽은 건수를 지정 값으로 설정 (0이면 읽음 처리) */
function setUnread(userNo, scope, target, count, timestamp) {
  const no = toUserNo(userNo);
  if (!no || !scope || !target) return;
  try {
    setUnreadStmt.run(no, String(scope), String(target), Math.max(0, Math.floor(count)), timestamp);
  } catch (e) {
    console.error('안읽은 건수 설정 실패:', e);
  }
}

/**
 * 접속 시 내려줄 안읽은 건수 전체.
 * { room: {방번호: 건수} } 형태로 반환한다.
 */
function getUnreadMap(userNo) {
  const out = { room: {} };
  const no = toUserNo(userNo);
  if (!no) return out;
  try {
    for (const row of getUnreadStmt.all(no)) {
      const count = Number(row.count) || 0;
      if (count <= 0) continue;
      if (row.scope === 'room') out.room[String(row.target)] = count;
    }
  } catch (e) {
    console.error('안읽은 건수 조회 실패:', e);
  }
  return out;
}

/** 읽음 처리 (해당 항목만 0으로) */
function clearUnread(userNo, scope, target, timestamp) {
  const no = toUserNo(userNo);
  if (!no || !scope || !target) return;
  try {
    clearUnreadStmt.run(timestamp, no, String(scope), String(target));
  } catch (e) {
    console.error('안읽은 건수 읽음 처리 실패:', e);
  }
}

/** 방 탈퇴/삭제 시 해당 사용자의 방 안읽은 건수도 정리 */
function clearUnreadForRoom(userNo, roomId, timestamp) {
  clearUnread(userNo, 'room', String(roomId), timestamp);
}

// ─── 읽음 커서 (카톡식 메시지별 '안 읽은 사람 수' 표시의 단일 진실) ───
// 기존 unread 테이블은 "내가 안 읽은 받은 메시지 수"를 세는 목록 배지용이고,
// 여기는 "상대가 내 메시지를 읽었는지"를 추적한다. 두 기능은 목적이 달라 따로 둔다.
//
// 메시지마다 읽음 여부 행을 만들지 않고, 각 사용자가 "이 대화에서 어디까지 읽었는지"
// 커서 하나만 저장한다. messages.id 는 단조 증가하므로
//   커서 < 메시지id  →  그 사용자는 아직 그 메시지를 안 읽었다
// 로 판정할 수 있다. (메시지별 플래그보다 행 수가 훨씬 적다)
// 화면 메모리로는 로그아웃/다른 PC 접속 시 숫자가 사라지므로 DB에 영속화한다.
//   user_no  : 읽은 사람
//   scope    : 'room'
//   target   : 방번호(문자열)
//              (unread 테이블과 동일 규약)
db.exec(`
  CREATE TABLE IF NOT EXISTS read_cursor (
    user_no INTEGER NOT NULL,
    scope TEXT NOT NULL,
    target TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_no, scope, target)
  )
`);

const upsertReadCursorStmt = db.prepare(
  `INSERT INTO read_cursor (user_no, scope, target, last_read_id, updated_at) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_no, scope, target) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`
);
const getReadCursorsStmt = db.prepare(
  `SELECT user_no, last_read_id FROM read_cursor WHERE scope = ? AND target = ?`
);
const deleteReadCursorStmt = db.prepare(
  `DELETE FROM read_cursor WHERE user_no = ? AND scope = ? AND target = ?`
);

/** 읽음 커서 전진 (뒤로 가지 않도록 max 로 감산 — 과거 메시지 요청이 뒤로 밀어내지 않게) */
function markRead(userNo, scope, target, lastReadId, timestamp) {
  const no = toUserNo(userNo);
  if (!no || !scope || !target) return;
  try {
    upsertReadCursorStmt.run(
      no,
      String(scope),
      String(target),
      Math.max(0, Math.floor(Number(lastReadId) || 0)),
      timestamp,
    );
  } catch (e) {
    console.error('읽음 커서 갱신 실패:', e);
  }
}

/** 해당 대화의 모든 참여자 읽음 커서 → { user_no: lastReadId } */
function getReadCursors(scope, target) {
  const out = {};
  if (!scope || !target) return out;
  try {
    for (const row of getReadCursorsStmt.all(String(scope), String(target))) {
      out[String(Number(row.user_no))] = Number(row.last_read_id) || 0;
    }
  } catch (e) {
    console.error('읽음 커서 조회 실패:', e);
  }
  return out;
}

/** 특정 사용자의 읽음 커서 삭제 (방 탈퇴 시 — 재입장하면 최신 위치로 다시 잡는다) */
function clearReadCursor(userNo, scope, target) {
  const no = toUserNo(userNo);
  if (!no || !scope || !target) return;
  try {
    deleteReadCursorStmt.run(no, String(scope), String(target));
  } catch (e) {
    console.error('읽음 커서 삭제 실패:', e);
  }
}

// 방에서 읽음 처리 시 "여기까지 읽었다" 기준이 되는 최신 메시지 id
function getLatestRoomMessageId(roomId) {
  try {
    const row = db
      .prepare(`SELECT MAX(id) AS id FROM messages WHERE room_type = 'room' AND room_id = ?`)
      .get(roomId);
    return row && row.id ? Number(row.id) : 0;
  } catch {
    return 0;
  }
}

// 1:1은 두 사용자의 방이다. 1:1 "창"이라는 별도 개념이 없으므로
// 읽음 커서도 방 스코프 하나로만 관리한다.

/**
 * 한 메시지를 아직 안 읽은 사람 수 (카톡의 '1' / '4' 숫자).
 * 발신자 자신은 세지 않고, participants(현재 대화 참여자) 중
 * 커서가 메시지 id 보다 작은 사람만 센다.
 *
 * '지금 보고 있는 사람(열람자)'를 별도로 빼지 않는 것이 핵심이다.
 * 읽음 커서(focus)가 그 역할을 대신한다.
 *   - focus 상태: 클라이언트가 unread_clear 를 보내 커서가 이미 앞으로 이동해 있어
 *                  '나'는 자동으로 집계에서 빠진다.
 *   - blur 상태 : 커서가 뒤처져 그대로 집계된다. (안 읽었으니 세는 게 맞다)
 *   예) 3명 방에서 A 발신 → B 의 채팅창은 blur, C 미열람
 *       A 화면 '2', B 화면도 '2' → B 가 focus 하면 양쪽 '1'
 */
function countUnreadForMessage(cursors, participants, senderNo, messageId) {
  const sender = toUserNo(senderNo);
  const id = Number(messageId) || 0;
  if (!id) return 0;
  let count = 0;
  for (const raw of Array.isArray(participants) ? participants : []) {
    const no = toUserNo(typeof raw === 'object' && raw !== null ? raw.user_no ?? raw.userNo : raw);
    if (!no || no === sender) continue;
    const readId = Number(cursors[String(no)]) || 0;
    if (readId < id) count += 1;
  }
  return count;
}

/**
 * 메시지 배열에 안 읽은 사람 수(unreadCount)를 붙여 돌려준다.
 * messages 항목은 { id, user_no, text, timestamp } 형태여야 한다.
 */
function decorateUnreadCounts(scope, target, messages, participants) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return list;
  const cursors = getReadCursors(scope, target);
  return list.map((m) => ({
    ...m,
    msgId: Number(m.id) || 0,
    unreadCount: countUnreadForMessage(cursors, participants, m.user_no, m.id),
  }));
}

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, timestamp, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_members_no ON room_members(user_no, room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id, user_no)`);
} catch (e) {
  console.error('인덱스 생성 실패:', e);
}

// 메시지 저장용 prepared statement (sender_no + sender_name 스냅샷)
const insertMessageStmt = db.prepare(
  'INSERT INTO messages (room_type, sender_no, sender_name, text, timestamp, room_id) VALUES (?, ?, ?, ?, ?, ?)'
);

// 메시지 저장 (roomType: "room", roomId는 방번호)
// sender_name은 발송 시점 nickname 스냅샷 — 이후 닉변해도 UPDATE하지 않는다.
function saveMessage({ roomType, senderNo, senderName, text, timestamp, roomId = null }) {
  const no = toUserNo(senderNo);
  if (!no) throw new Error('senderNo required');
  return insertMessageStmt.run(roomType, no, String(senderName ?? ''), text, timestamp, roomId);
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

function createRoom({ name, ownerNo, timestamp, memberNos = [], ownerNickname = '', memberNicknames = {} }) {
  // 초대 멤버를 함께 등록 (중복/방장 제외)
  const owner = toUserNo(ownerNo);
  if (!owner) throw new Error('ownerNo required');
  const seen = new Set([owner]);
  const invited = [];
  for (const raw of Array.isArray(memberNos) ? memberNos : []) {
    const no = toUserNo(raw);
    if (!no || seen.has(no)) continue;
    seen.add(no);
    invited.push(no);
  }
  // 방 이름: 닉네임 스냅샷 기준 자동 연결 (이후 닉변해도 불변)
  const nickOf = (no) => {
    if (memberNicknames && memberNicknames[String(no)] != null) return String(memberNicknames[String(no)]);
    if (Number(no) === Number(owner)) return String(ownerNickname || '');
    return '';
  };
  const autoName = joinMemberNames(nickOf(owner), invited.map(nickOf));
  const info = db
    .prepare(`INSERT INTO rooms (name, owner_no, created_at) VALUES (?, ?, ?)`)
    .run(String(name ?? '').trim() || autoName, owner, timestamp);
  const roomId = Number(info.lastInsertRowid);
  // 표시제목(display_name) 규칙 — 생성 시점 스냅샷, 이후 닉변해도 갱신 안 함
  const isOneToOne = invited.length === 1;
  const ownerDisplay = isOneToOne ? nickOf(invited[0]) : autoName;
  db.prepare(`INSERT INTO room_members (room_id, user_no, joined_at, display_name) VALUES (?, ?, ?, ?)`)
    .run(roomId, owner, timestamp, ownerDisplay);
  let seq = 1;
  for (const no of invited) {
    try {
      const memberDisplay = isOneToOne ? nickOf(owner) : autoName;
      db.prepare(
        `INSERT OR IGNORE INTO room_members (room_id, user_no, joined_at, display_name) VALUES (?, ?, ?, ?)`
      ).run(roomId, no, timestamp + seq, memberDisplay);
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

function isMember(roomId, userNo) {
  const no = toUserNo(userNo);
  if (!no) return false;
  const row = db
    .prepare(`SELECT 1 FROM room_members WHERE room_id = ? AND user_no = ?`)
    .get(roomId, no);
  return !!row;
}

// ─── 1:1 방: 활성(삭제/폐쇄 제외) + 멤버 정확히 2명(a,b)인 방 조회 ───
// 그룹방(3명+)은 절대 매칭되지 않음.
function findActiveOneToOneRoom(noA, noB) {
  const a = toUserNo(noA);
  const b = toUserNo(noB);
  if (!a || !b || a === b) return null;
  try {
    const row = db
      .prepare(
        `SELECT m.room_id AS roomId
         FROM room_members m
         INNER JOIN rooms r ON r.room_id = m.room_id
         WHERE r.is_deleted = 0 AND r.is_closed = 0
           AND m.user_no IN (?, ?)
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

/**
 * 1:1 대화용 방을 "있다면 그대로, 없으면 생성"하고 방번호를 돌려준다.
 */
function ensureOneToOneRoom(noA, noB, timestamp, nicknames = {}) {
  const a = toUserNo(noA);
  const b = toUserNo(noB);
  if (!a || !b || a === b) return null;
  const found = findActiveOneToOneRoom(a, b);
  if (found) return found;
  const nameOf = (no) => (nicknames[String(no)] != null ? String(nicknames[String(no)]) : '');
  return createRoom({
    name: `1:1 ${nameOf(a)},${nameOf(b)}`,
    ownerNo: a,
    timestamp: Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now(),
    memberNos: [b],
    ownerNickname: nameOf(a),
    memberNicknames: nicknames,
  });
}

function addMember(roomId, userNo, timestamp) {
  const no = toUserNo(userNo);
  if (!no) return;
  db.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, user_no, joined_at, display_name) VALUES (?, ?, ?, NULL)`
  ).run(roomId, no, timestamp);
}

// ─── 초대: 운영 중인 방에 멤버 추가 ───
// 초대받은 멤버의 display_name에는 "전체 멤버 닉네임을 오름차순으로 이어 붙인 값"을 저장한다.
// (초대받은 사람에게 적용될 채팅방 제목 기본값. 기존 멤버의 display_name은 건드리지 않는다)
// 반환: { added: 이번에 새로 들어온 user_no[], memberNos: 초대 후 전체 멤버 user_no[] }
function inviteMembers(roomId, userNos, timestamp) {
  const rid = Number(roomId);
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const added = [];
  if (!Number.isInteger(rid) || rid <= 0) return { added, memberNos: [] };
  const seen = new Set();
  let seq = 0;
  for (const raw of Array.isArray(userNos) ? userNos : []) {
    const no = toUserNo(raw);
    if (!no || seen.has(no)) continue;
    seen.add(no);
    if (isMember(rid, no)) continue; // 이미 멤버 → 중복 초대 제외
    addMember(rid, no, ts + seq); // joined_at = 초대 시점 (이후 메시지만 보는 기준점)
    seq += 1;
    added.push(no);
  }
  if (added.length > 0) {
    // 전체 멤버 닉네임 나열값을 "초대받은 멤버"의 제목 기본값으로만 저장한다.
    const nicks = getRoomMembers(rid).map((m) => m.nickname);
    const title = joinMemberNames('', nicks); // 빈 값/중복 제거 + localeCompare 오름차순 연결
    for (const no of added) {
      db.prepare(
        `UPDATE room_members SET display_name = ? WHERE room_id = ? AND user_no = ?`
      ).run(title, rid, no);
    }
  }
  return { added, memberNos: getRoomMemberNos(rid) };
}

// 사용자별 방 제목 조회 (없으면 NULL → 호출자가 rooms.name 폴백)
function getRoomDisplayName(roomId, userNo) {
  try {
    const no = toUserNo(userNo);
    if (!no) return null;
    const row = db
      .prepare(`SELECT display_name FROM room_members WHERE room_id = ? AND user_no = ?`)
      .get(roomId, no);
    return row && row.display_name ? String(row.display_name) : null;
  } catch {
    return null;
  }
}

// 사용자별 방 제목 저장 (본인 행만 수정, 30자 제한)
function setRoomDisplayName(roomId, userNo, displayName) {
  const name = String(displayName || '').trim().slice(0, 30);
  const no = toUserNo(userNo);
  if (!name || !no) return false;
  try {
    const info = db
      .prepare(`UPDATE room_members SET display_name = ? WHERE room_id = ? AND user_no = ?`)
      .run(name, roomId, no);
    return Number(info.changes) > 0;
  } catch {
    return false;
  }
}

function removeMember(roomId, userNo) {
  const no = toUserNo(userNo);
  if (!no) return;
  db.prepare(`DELETE FROM room_members WHERE room_id = ? AND user_no = ?`).run(
    roomId,
    no
  );
}

function countMembers(roomId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM room_members WHERE room_id = ?`)
    .get(roomId);
  return row ? Number(row.cnt) : 0;
}

// 방 멤버: [{user_no, nickname(현재), joined_at}] — 표시는 JOIN resolve, 방제는 display_name 스냅샷 유지
function getRoomMembers(roomId) {
  return db
    .prepare(
      `SELECT m.user_no AS user_no, u.nickname AS nickname, m.joined_at AS joined_at
       FROM room_members m
       LEFT JOIN users u ON u.user_no = m.user_no
       WHERE m.room_id = ? ORDER BY m.joined_at ASC, m.rowid ASC`
    )
    .all(roomId)
    .map((r) => ({ user_no: Number(r.user_no), nickname: r.nickname != null ? String(r.nickname) : '', joined_at: Number(r.joined_at) || 0 }));
}

// 멤버 user_no만 필요할 때 (읽음 계산 등)
function getRoomMemberNos(roomId) {
  return getRoomMembers(roomId).map((m) => m.user_no);
}

function getEarliestMemberExcept(roomId, exceptNo) {
  const no = toUserNo(exceptNo);
  const row = db
    .prepare(
      `SELECT user_no FROM room_members WHERE room_id = ? AND (? IS NULL OR user_no != ?) ORDER BY joined_at ASC, rowid ASC LIMIT 1`
    )
    .get(roomId, no, no);
  return row ? Number(row.user_no) : null;
}

function transferOwner(roomId, newOwnerNo) {
  const no = toUserNo(newOwnerNo);
  if (!no) return;
  db.prepare(`UPDATE rooms SET owner_no = ? WHERE room_id = ?`).run(no, roomId);
}

// 마지막 메시지 요약: 방별 가장 최근 1건 (내용/시간/발신자 스냅샷)
const lastMessageJoin = `
    LEFT JOIN (
      SELECT room_id, text, timestamp, sender_no, sender_name FROM (
        SELECT room_id, text, timestamp, sender_no, sender_name,
               ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY timestamp DESC, id DESC) AS rn
        FROM messages
        WHERE room_type = 'room' AND room_id IS NOT NULL
      ) WHERE rn = 1
    ) last_msg ON last_msg.room_id = r.room_id`;

// 내가 속한 활성방 목록 (삭제/폐쇄 제외) + 인원수 + 사용자별 표시제목 + 마지막 메시지
// displayName: room_members.display_name 스냅샷 (닉변해도 불변), NULL이면 rooms.name 폴백
function getMyRooms(userNo) {
  const no = toUserNo(userNo);
  if (!no) return [];
  const rows = db
    .prepare(
      `SELECT r.room_id AS roomId, r.name, r.owner_no AS owner_no, u.nickname AS ownerNickname,
              COALESCE(m_self.display_name, r.name) AS displayName,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.room_id) AS memberCount,
              last_msg.text AS lastMessage,
              last_msg.timestamp AS lastMessageAt,
              last_msg.sender_no AS lastMessageNo,
              last_msg.sender_name AS lastMessageSender
       FROM rooms r
       INNER JOIN room_members m_self ON m_self.room_id = r.room_id AND m_self.user_no = ?
       LEFT JOIN users u ON u.user_no = r.owner_no
       ${lastMessageJoin}
       WHERE r.is_deleted = 0 AND r.is_closed = 0
       ORDER BY r.room_id ASC`
    )
    .all(no);
  return rows.map((r) => ({
    roomId: r.roomId,
    name: r.name,
    owner_no: Number(r.owner_no),
    owner: r.ownerNickname != null ? String(r.ownerNickname) : '',
    memberCount: r.memberCount,
    displayName: r.displayName && String(r.displayName).trim() !== '' ? String(r.displayName) : r.name,
    lastMessage: r.lastMessage == null ? null : String(r.lastMessage),
    lastMessageAt: r.lastMessageAt == null ? null : Number(r.lastMessageAt),
    lastMessageNo: r.lastMessageNo == null ? null : Number(r.lastMessageNo),
    lastMessageSender: r.lastMessageSender == null ? null : String(r.lastMessageSender),
  }));
}

function softDeleteRoom(roomId, deletedByNo, timestamp) {
  const no = toUserNo(deletedByNo);
  db.prepare(
    `UPDATE rooms SET is_deleted = 1, deleted_at = ?, deleted_by = ? WHERE room_id = ?`
  ).run(timestamp, no, roomId);
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
// NOTE: 읽음 표시(unreadCount) 계산을 위해 messages.id 도 함께 돌려준다.
// nickname은 sender_name 스냅샷 그대로 (과거 닉 유지).
function getRoomHistory(roomId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT id, sender_no, sender_name, text, timestamp FROM messages
       WHERE room_type = 'room' AND room_id = ?
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`
    )
    .all(roomId, limit);
  return rows.reverse().map((row) => ({
    id: Number(row.id),
    user_no: Number(row.sender_no),
    nickname: String(row.sender_name ?? ''),
    text: row.text,
    timestamp: row.timestamp,
  }));
}

// 채팅창 열람용: 방 최근 N건 (기본 10건, 오래된 → 최신 순)
// viewerNo를 주면 "초대받은 시점(room_members.joined_at) 이후"의 메시지만 돌려준다.
// 두 컬럼 모두 epoch ms라 비교를 그대로 쓸 수 있다. (초대받은 사람은 그 이전 대화를 볼 수 없다)
function getRecentRoomMessages(roomId, limit = 10, viewerNo = null) {
  const viewer = toUserNo(viewerNo);
  const rows = viewer
    ? db
        .prepare(
          `SELECT id, sender_no, sender_name, text, timestamp FROM messages
           WHERE room_type = 'room' AND room_id = ?
             AND timestamp >= (SELECT joined_at FROM room_members WHERE room_id = ? AND user_no = ?)
           ORDER BY timestamp DESC, id DESC
           LIMIT ?`
        )
        .all(roomId, roomId, viewer, limit)
    : db
        .prepare(
          `SELECT id, sender_no, sender_name, text, timestamp FROM messages
           WHERE room_type = 'room' AND room_id = ?
           ORDER BY timestamp DESC, id DESC
           LIMIT ?`
        )
        .all(roomId, limit);
  return rows.reverse().map((row) => ({
    id: Number(row.id),
    user_no: Number(row.sender_no),
    nickname: String(row.sender_name ?? ''),
    text: row.text,
    timestamp: row.timestamp,
  }));
}

// ─── 등록 사용자 (users) ───
// admin(user_no=1)이 직접 추가/수정. join 시 자동 등록하지 않음.
// login_id: 불변/전역UNIQUE(탈퇴 포함 재사용 불가)
// nickname: 전역UNIQUE(탈퇴 포함 재사용 불가), 본인+admin 변경 가능
// phone/user_name: admin 관리 화면용 확장 컬럼 (NULL 허용, 이번 전환 선반영)
function getUserByNo(userNo) {
  const no = toUserNo(userNo);
  if (!no) return null;
  const row = db
    .prepare(`SELECT user_no, login_id, nickname, phone, user_name, is_deleted FROM users WHERE user_no = ?`)
    .get(no);
  if (!row) return null;
  return {
    user_no: Number(row.user_no),
    loginId: String(row.login_id ?? ''),
    nickname: String(row.nickname ?? ''),
    phone: row.phone == null ? null : String(row.phone),
    userName: row.user_name == null ? null : String(row.user_name),
    isDeleted: Number(row.is_deleted) === 1,
  };
}

function getUserByLoginId(loginId) {
  const id = String(loginId ?? '').trim();
  if (!isValidLoginId(id)) return null;
  const row = db
    .prepare(`SELECT user_no, login_id, nickname, phone, user_name, is_deleted FROM users WHERE login_id = ?`)
    .get(id);
  if (!row) return null;
  return {
    user_no: Number(row.user_no),
    loginId: String(row.login_id ?? ''),
    nickname: String(row.nickname ?? ''),
    phone: row.phone == null ? null : String(row.phone),
    userName: row.user_name == null ? null : String(row.user_name),
    isDeleted: Number(row.is_deleted) === 1,
  };
}

function isLoginIdTaken(loginId, exceptNo = null) {
  const id = String(loginId ?? '').trim();
  if (!id) return false;
  const ex = toUserNo(exceptNo);
  const row = db.prepare(`SELECT user_no FROM users WHERE login_id = ?`).get(id);
  if (!row) return false;
  if (ex && Number(row.user_no) === ex) return false;
  return true;
}

function isNicknameTaken(nickname, exceptNo = null) {
  const nick = normalizeNickname(nickname);
  if (!nick) return false;
  const ex = toUserNo(exceptNo);
  const row = db.prepare(`SELECT user_no FROM users WHERE nickname = ?`).get(nick);
  if (!row) return false;
  if (ex && Number(row.user_no) === ex) return false;
  return true;
}

// admin 전용 upsert: login_id 기준 신규/복구/수정. login_id 자체는 변경 불가.
function upsertUser({ loginId, nickname, phone = null, userName = null, timestamp, isDeleted = false }) {
  const id = String(loginId ?? '').trim();
  const nick = normalizeNickname(nickname);
  if (!isValidLoginId(id)) return { ok: false, reason: 'invalid_login_id' };
  if (!nick) return { ok: false, reason: 'invalid_nickname' };
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const deleted = isDeleted ? 1 : 0;
  const existing = getUserByLoginId(id);
  const phoneVal = phone == null || String(phone).trim() === '' ? null : String(phone).trim().slice(0, 30);
  const nameVal = userName == null || String(userName).trim() === '' ? null : String(userName).trim().slice(0, 30);
  if (!existing) {
    if (isNicknameTaken(nick)) return { ok: false, reason: 'nickname_taken' };
    try {
      const info = db.prepare(
        `INSERT INTO users (login_id, nickname, phone, user_name, created_at, is_deleted, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, nick, phoneVal, nameVal, ts, deleted, deleted === 1 ? ts : null);
      return { ok: true, user_no: Number(info.lastInsertRowid) };
    } catch (e) {
      if (isLoginIdTaken(id)) return { ok: false, reason: 'login_id_taken' };
      return { ok: false, reason: 'nickname_taken' };
    }
  }
  if (isNicknameTaken(nick, existing.user_no)) return { ok: false, reason: 'nickname_taken' };
  if (existing.user_no === 1 && deleted === 1) return { ok: false, reason: 'admin_protected' };
  db.prepare(
    `UPDATE users SET nickname = ?, phone = ?, user_name = ?, is_deleted = ?, deleted_at = ? WHERE user_no = ?`
  ).run(nick, phoneVal, nameVal, deleted, deleted === 1 ? ts : null, existing.user_no);
  return { ok: true, user_no: existing.user_no };
}

// 닉네임 변경: 본인 또는 admin(user_no=1). 스냅샷은 건드리지 않음.
function renameUser({ targetNo, newNickname, requesterNo }) {
  const target = toUserNo(targetNo);
  const requester = toUserNo(requesterNo);
  const nick = normalizeNickname(newNickname);
  if (!target || !requester) return { ok: false, reason: 'invalid_user' };
  if (!nick) return { ok: false, reason: 'invalid_nickname' };
  if (requester !== 1 && requester !== target) return { ok: false, reason: 'forbidden' };
  if (target === 1) return { ok: false, reason: 'admin_protected' };
  const row = getUserByNo(target);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.nickname === nick) return { ok: true, user_no: target };
  if (isNicknameTaken(nick, target)) return { ok: false, reason: 'nickname_taken' };
  db.prepare(`UPDATE users SET nickname = ? WHERE user_no = ?`).run(nick, target);
  return { ok: true, user_no: target };
}

function withdrawUser(userNo, timestamp) {
  const no = toUserNo(userNo);
  if (!no || no === 1) return;
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  db.prepare(`UPDATE users SET is_deleted = 1, deleted_at = ? WHERE user_no = ?`).run(ts, no);
}

function isWithdrawnByNo(userNo) {
  const no = toUserNo(userNo);
  if (!no) return false;
  const row = db.prepare(`SELECT is_deleted FROM users WHERE user_no = ?`).get(no);
  return !!row && Number(row.is_deleted) === 1;
}

function isRegisteredNo(userNo) {
  const no = toUserNo(userNo);
  if (!no) return false;
  const row = db.prepare(`SELECT 1 AS ok FROM users WHERE user_no = ? AND is_deleted = 0`).get(no);
  return !!row;
}

function getAllUsers() {
  return db
    .prepare(`SELECT user_no, nickname FROM users WHERE is_deleted = 0 ORDER BY nickname ASC`)
    .all()
    .map((r) => ({ user_no: Number(r.user_no), nickname: String(r.nickname) }));
}

function getAllUsersDetail() {
  return db
    .prepare(`SELECT user_no, login_id, nickname, phone, user_name, is_deleted FROM users ORDER BY nickname ASC`)
    .all()
    .map((r) => ({
      user_no: Number(r.user_no),
      loginId: String(r.login_id ?? ''),
      nickname: String(r.nickname ?? ''),
      phone: r.phone == null ? null : String(r.phone),
      userName: r.user_name == null ? null : String(r.user_name),
      isDeleted: Number(r.is_deleted) === 1,
    }));
}

module.exports = {
  db,
  isValidLoginId,
  normalizeNickname,
  toUserNo,
  isAdminNo,
  saveMessage,
  createRoom,
  joinMemberNames,
  getRoom,
  isRoomActive,
  isMember,
  findActiveOneToOneRoom,
  ensureOneToOneRoom,
  addMember,
  inviteMembers,
  removeMember,
  countMembers,
  getRoomMembers,
  getRoomMemberNos,
  getEarliestMemberExcept,
  transferOwner,
  getMyRooms,
  getRoomDisplayName,
  setRoomDisplayName,
  softDeleteRoom,
  closeRoomIfEmpty,
  getRoomHistory,
  getRecentRoomMessages,
  getUserByNo,
  getUserByLoginId,
  isLoginIdTaken,
  isNicknameTaken,
  upsertUser,
  renameUser,
  withdrawUser,
  isWithdrawnByNo,
  isRegisteredNo,
  getAllUsers,
  getAllUsersDetail,
  bumpUnread,
  setUnread,
  getUnreadMap,
  clearUnread,
  clearUnreadForRoom,
  // 읽음 커서 (메시지별 '안 읽은 사람 수' 표시)
  markRead,
  getReadCursors,
  clearReadCursor,
  getLatestRoomMessageId,
  countUnreadForMessage,
  decorateUnreadCounts,
};
