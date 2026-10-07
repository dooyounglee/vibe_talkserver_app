// SQLite 데이터베이스 초기화 (better-sqlite3) — user_no PK + login_id 체제 (fresh)
const path = require('path');
const crypto = require('crypto');
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

// ─── 부서 (departments) ───
// admin 설정 화면에서 관리. 삭제 대신 is_deleted(미사용) 처리.
// dept_code / dept_name 은 미사용 포함 전역 UNIQUE.
db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    dept_no INTEGER PRIMARY KEY AUTOINCREMENT,
    dept_code TEXT NOT NULL UNIQUE,
    dept_name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NULL
  )
`);

// 기존 chat.db 호환: users.dept_no 컬럼 추가 (이미 있으면 무시)
try {
  db.exec(`ALTER TABLE users ADD COLUMN dept_no INTEGER NULL`);
} catch {
  /* duplicate column — 이미 추가됨 */
}

// 기존 chat.db 호환: users.profile_file_key 컬럼 추가 (프로필 이미지 = files.file_key, NULL이면 기본 이미지)
try {
  db.exec(`ALTER TABLE users ADD COLUMN profile_file_key TEXT NULL`);
} catch {
  /* duplicate column — 이미 추가됨 */
}

// 기존 chat.db 호환: users.password_hash 컬럼 추가 (scrypt 해시, 평문 저장 안 함)
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT NULL`);
} catch {
  /* duplicate column — 이미 추가됨 */
}
// must_change_password: 1이면 다음 로그인 때 비밀번호 변경 강제 (신규 등록 / 초기화 직후)
// prev_password_hash: 초기화 직전 비밀번호 — 강제 변경 시 이 값으로 되돌리지 못하게 한다
for (const col of ['must_change_password INTEGER NOT NULL DEFAULT 0', 'prev_password_hash TEXT NULL']) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
  } catch {
    /* duplicate column — 이미 추가됨 */
  }
}

// ─── 첨부파일 ───
// 업로드(HTTP POST /upload)된 파일 등록부. file_key는 추측 불가능한 랜덤 키이며
// 다운로드 URL(/files/:key)에 그대로 쓰인다. 메시지에 첨부되면 msg_id가 채워진다.
// 실제 바이트는 uploads/<file_key> 에 저장한다.
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    file_key TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_mime TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL,
    msg_id INTEGER NULL
  )
`);
// 기존 chat.db 호환: messages 첨부 컬럼 추가 (이미 있으면 무시)
for (const col of ['file_key TEXT NULL', 'file_name TEXT NULL', 'file_size INTEGER NULL', 'file_mime TEXT NULL']) {
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN ${col}`);
  } catch {
    /* duplicate column — 이미 추가됨 */
  }
}

// 'admin' 시드 (user_no=1 보장: 최초 INSERT)
try {
  db.prepare(
    `INSERT OR IGNORE INTO users (user_no, login_id, nickname, created_at, is_deleted, deleted_at)
     VALUES (1, 'admin', 'admin', ?, 0, NULL)`
  ).run(Date.now());
} catch (e) {
  console.error('admin 시드 실패:', e);
}

// ─── 비밀번호 ───
// 저장: scrypt$<salt hex>$<hash hex>. 초기값/초기화값 = 아이디 + 전화번호 숫자 뒤 4자리
// (전화번호 숫자가 4자리 미만이면 아이디만).
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPasswordHash(plain, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(plain ?? ''), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
// 전화번호: 0으로 시작, 숫자 9~11자리, 하이픈 선택(쓰면 자리까지 맞아야 함) (02 지역번호는 9~10자리, 그 외 10~11자리)
// 유효하면 하이픈 형식(010-1234-5678 / 02-123-4567)으로 맞춰 돌려주고, 아니면 null
function normalizePhone(v) {
  const raw = String(v ?? '').trim();
  // 하이픈을 쓰면 위치까지 맞아야 한다 (010-1234-5678 / 02-123-4567)
  if (!/^\d+$/.test(raw) && !/^0\d{1,2}-\d{3,4}-\d{4}$/.test(raw)) return null;
  const digits = raw.replace(/-/g, '');
  const area = digits.startsWith('02') ? 2 : 3;
  const ok = area === 2 ? /^02\d{7,8}$/.test(digits) : /^0\d{9,10}$/.test(digits);
  if (!ok) return null;
  return `${digits.slice(0, area)}-${digits.slice(area, -4)}-${digits.slice(-4)}`;
}
function defaultPasswordOf(loginId, phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return String(loginId ?? '') + (digits.length >= 4 ? digits.slice(-4) : '');
}
// 비밀번호가 없는 기존 사용자(admin 포함)는 초기값으로 채운다 (변경 강제 대상 아님)
try {
  const rows = db.prepare(`SELECT user_no, login_id, phone FROM users WHERE password_hash IS NULL`).all();
  const upd = db.prepare(`UPDATE users SET password_hash = ? WHERE user_no = ?`);
  db.transaction(() => {
    for (const r of rows) upd.run(hashPassword(defaultPasswordOf(r.login_id, r.phone)), r.user_no);
  })();
} catch (e) {
  console.error('비밀번호 초기값 설정 실패:', e);
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
  // 커서 페이징(id < ? / id > ?) 전용
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_members_no ON room_members(user_no, room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id, user_no)`);
} catch (e) {
  console.error('인덱스 생성 실패:', e);
}

// 메시지 저장용 prepared statement (sender_no + sender_name 스냅샷)
const insertMessageStmt = db.prepare(
  `INSERT INTO messages (room_type, sender_no, sender_name, text, timestamp, room_id, file_key, file_name, file_size, file_mime)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// 메시지 저장 (roomType: "room", roomId는 방번호)
// sender_name은 발송 시점 nickname 스냅샷 — 이후 닉변해도 UPDATE하지 않는다.
// file: 첨부파일 메시지면 { key, name, size, mime } (text에는 파일명을 넣어 검색/미리보기에 쓴다)
function saveMessage({ roomType, senderNo, senderName, text, timestamp, roomId = null, file = null }) {
  const no = toUserNo(senderNo);
  if (!no) throw new Error('senderNo required');
  return insertMessageStmt.run(
    roomType, no, String(senderName ?? ''), text, timestamp, roomId,
    file ? file.key : null, file ? file.name : null, file ? file.size : null, file ? file.mime : null,
  );
}

// ─── 첨부파일 등록부 ───
function registerFile({ key, name, size, mime, timestamp }) {
  db.prepare(
    `INSERT INTO files (file_key, file_name, file_size, file_mime, uploaded_at) VALUES (?, ?, ?, ?, ?)`
  ).run(key, name, size, mime, timestamp);
}

function getFile(key) {
  const row = db.prepare(`SELECT * FROM files WHERE file_key = ?`).get(String(key ?? ''));
  if (!row) return null;
  return {
    key: row.file_key,
    name: row.file_name,
    size: Number(row.file_size),
    mime: row.file_mime,
    msgId: row.msg_id == null ? null : Number(row.msg_id),
  };
}

function attachFile(key, msgId) {
  db.prepare(`UPDATE files SET msg_id = ? WHERE file_key = ?`).run(msgId, key);
}

// 메시지 행의 첨부 컬럼 → 클라이언트 전송용 { id, name, size, mime } (없으면 undefined)
function fileOfRow(row) {
  if (!row || !row.file_key) return undefined;
  return {
    id: String(row.file_key),
    name: String(row.file_name ?? ''),
    size: Number(row.file_size) || 0,
    mime: String(row.file_mime ?? 'application/octet-stream'),
  };
}

// 목록 미리보기용 문구: 이미지면 '사진', 그 외 파일이면 '파일: 이름'
function previewTextOf(text, mime) {
  if (mime == null) return text;
  return String(mime).startsWith('image/') ? '사진' : `파일: ${text}`;
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

// 방 멤버: [{user_no, nickname(현재), joined_at, profileImage}] — 표시는 JOIN resolve, 방제는 display_name 스냅샷 유지
// profileImage: 채팅창에서 상대 메시지 옆 프로필 사진 표시용 (없으면 null = 기본 이미지)
function getRoomMembers(roomId) {
  return db
    .prepare(
      `SELECT m.user_no AS user_no, u.nickname AS nickname, m.joined_at AS joined_at, u.profile_file_key AS profile_file_key
       FROM room_members m
       LEFT JOIN users u ON u.user_no = m.user_no
       WHERE m.room_id = ? ORDER BY m.joined_at ASC, m.rowid ASC`
    )
    .all(roomId)
    .map((r) => ({
      user_no: Number(r.user_no),
      nickname: r.nickname != null ? String(r.nickname) : '',
      joined_at: Number(r.joined_at) || 0,
      profileImage: profileImageOf(r.profile_file_key),
    }));
}

// 멤버 user_no만 필요할 때 (읽음 계산 등)
function getRoomMemberNos(roomId) {
  return db
    .prepare(`SELECT user_no FROM room_members WHERE room_id = ? ORDER BY joined_at ASC, rowid ASC`)
    .all(roomId)
    .map((r) => Number(r.user_no));
}

// 이 사용자가 속한 방 번호 목록 (프로필 변경 시 같은 방 멤버에게 갱신을 알릴 때)
function getRoomIdsOfUser(userNo) {
  const no = toUserNo(userNo);
  if (!no) return [];
  return db
    .prepare(`SELECT room_id FROM room_members WHERE user_no = ?`)
    .all(no)
    .map((r) => Number(r.room_id));
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
      SELECT room_id, text, timestamp, sender_no, sender_name, file_mime FROM (
        SELECT room_id, text, timestamp, sender_no, sender_name, file_mime,
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
              last_msg.file_mime AS lastMessageMime,
              last_msg.timestamp AS lastMessageAt,
              last_msg.sender_no AS lastMessageNo,
              last_msg.sender_name AS lastMessageSender
       FROM rooms r
       INNER JOIN room_members m_self ON m_self.room_id = r.room_id AND m_self.user_no = ?
       LEFT JOIN users u ON u.user_no = r.owner_no
       ${lastMessageJoin}
         AND last_msg.timestamp >= m_self.joined_at -- 초대 시점 이전 메시지는 미리보기에서도 제외
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
    lastMessage: r.lastMessage == null ? null : previewTextOf(String(r.lastMessage), r.lastMessageMime),
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
      `SELECT id, sender_no, sender_name, text, timestamp, file_key, file_name, file_size, file_mime FROM messages
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
    file: fileOfRow(row),
  }));
}

// 채팅창 열람용 페이지 조회 (msgId 커서 기반, 결과는 항상 오래된 → 최신 순)
//   - beforeId: 그 id보다 이전 메시지 limit건 (위로 스크롤 시 "이전 대화 더보기")
//   - afterId : 그 id보다 이후 메시지 limit건 (검색 결과 점프 후 아래로 스크롤용)
//   - 둘 다 없으면 최신 limit건
// viewerNo를 주면 "초대받은 시점(room_members.joined_at) 이후"의 메시지만 돌려준다.
// messages.id는 AUTOINCREMENT로 단조 증가하므로 id 순서 = 저장 순서다.
// limit+1건을 읽어 hasMore(해당 방향으로 더 있는지)를 판정한다.
const MAX_PAGE_LIMIT = 50;
function getRoomMessagesPage(roomId, viewerNo = null, { beforeId = null, afterId = null, limit = 30 } = {}) {
  const viewer = toUserNo(viewerNo);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), MAX_PAGE_LIMIT);
  const before = toUserNo(beforeId);
  const after = before ? null : toUserNo(afterId);

  const where = [`room_type = 'room'`, `room_id = ?`];
  const params = [roomId];
  if (viewer) {
    where.push(`timestamp >= (SELECT joined_at FROM room_members WHERE room_id = ? AND user_no = ?)`);
    params.push(roomId, viewer);
  }
  if (before) { where.push(`id < ?`); params.push(before); }
  if (after) { where.push(`id > ?`); params.push(after); }
  const order = after ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `SELECT id, sender_no, sender_name, text, timestamp, file_key, file_name, file_size, file_mime FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY id ${order}
       LIMIT ?`
    )
    .all(...params, size + 1);
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  if (!after) page.reverse();
  return {
    hasMore,
    messages: page.map((row) => ({
      id: Number(row.id),
      user_no: Number(row.sender_no),
      nickname: String(row.sender_name ?? ''),
      text: row.text,
      timestamp: row.timestamp,
      file: fileOfRow(row),
    })),
  };
}

// 검색 결과 점프용: targetId 를 가운데 둔 한 페이지 (오래된 → 최신 순)
//   이전쪽 half+1건(대상 포함) + 이후쪽 half건. hasMore=더 이전, hasNewer=더 이후가 있는지.
function getRoomMessagesAround(roomId, viewerNo, targetId, half = 15) {
  const target = toUserNo(targetId);
  if (!target) return { messages: [], hasMore: false, hasNewer: false };
  const older = getRoomMessagesPage(roomId, viewerNo, { beforeId: target + 1, limit: half + 1 });
  const newer = getRoomMessagesPage(roomId, viewerNo, { afterId: target, limit: half });
  return {
    messages: [...older.messages, ...newer.messages],
    hasMore: older.hasMore,
    hasNewer: newer.hasMore,
  };
}

// 채팅창 메시지 검색: 본문에 keyword 가 포함된 메시지 id 목록 (최신 → 과거 순)
// viewerNo 를 주면 getRoomMessagesPage 와 같이 초대받은 시점 이후만 검색한다.
// limit 건을 넘으면 truncated=true.
const SEARCH_MAX_RESULTS = 300;
function searchRoomMessages(roomId, viewerNo, keyword, limit = SEARCH_MAX_RESULTS) {
  const kw = String(keyword ?? '').trim();
  if (kw === '') return { ids: [], truncated: false };
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || SEARCH_MAX_RESULTS, 1), SEARCH_MAX_RESULTS);
  const viewer = toUserNo(viewerNo);
  const pattern = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const where = [`room_type = 'room'`, `room_id = ?`, `text LIKE ? ESCAPE '\\'`];
  const params = [roomId, pattern];
  if (viewer) {
    where.push(`timestamp >= (SELECT joined_at FROM room_members WHERE room_id = ? AND user_no = ?)`);
    params.push(roomId, viewer);
  }
  const rows = db
    .prepare(
      `SELECT id FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...params, size + 1);
  return {
    ids: rows.slice(0, size).map((row) => Number(row.id)),
    truncated: rows.length > size,
  };
}

// 채팅창 열람용: 방 최근 N건 (오래된 → 최신 순) — getRoomMessagesPage의 최신 페이지
function getRecentRoomMessages(roomId, limit = 10, viewerNo = null) {
  return getRoomMessagesPage(roomId, viewerNo, { limit }).messages;
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
    .prepare(`SELECT user_no, login_id, nickname, phone, user_name, is_deleted, profile_file_key FROM users WHERE user_no = ?`)
    .get(no);
  if (!row) return null;
  return {
    user_no: Number(row.user_no),
    loginId: String(row.login_id ?? ''),
    nickname: String(row.nickname ?? ''),
    phone: row.phone == null ? null : String(row.phone),
    userName: row.user_name == null ? null : String(row.user_name),
    isDeleted: Number(row.is_deleted) === 1,
    profileImage: profileImageOf(row.profile_file_key),
  };
}

function getUserByLoginId(loginId) {
  const id = String(loginId ?? '').trim();
  if (!isValidLoginId(id)) return null;
  const row = db
    .prepare(`SELECT user_no, login_id, nickname, phone, user_name, is_deleted, profile_file_key FROM users WHERE login_id = ?`)
    .get(id);
  if (!row) return null;
  return {
    user_no: Number(row.user_no),
    loginId: String(row.login_id ?? ''),
    nickname: String(row.nickname ?? ''),
    phone: row.phone == null ? null : String(row.phone),
    userName: row.user_name == null ? null : String(row.user_name),
    isDeleted: Number(row.is_deleted) === 1,
    profileImage: profileImageOf(row.profile_file_key),
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
// deptNo: undefined → 기존 값 유지, null → 부서 없음, 숫자 → 사용 중인 부서만 허용
function upsertUser({ loginId, nickname, phone = null, userName = null, timestamp, isDeleted = false, deptNo }) {
  const id = String(loginId ?? '').trim();
  const nick = normalizeNickname(nickname);
  if (!isValidLoginId(id)) return { ok: false, reason: 'invalid_login_id' };
  if (!nick) return { ok: false, reason: 'invalid_nickname' };
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const deleted = isDeleted ? 1 : 0;
  const existing = getUserByLoginId(id);
  if (phone == null || String(phone).trim() === '') return { ok: false, reason: 'phone_required' };
  const phoneVal = normalizePhone(phone);
  if (!phoneVal) return { ok: false, reason: 'invalid_phone' };
  const nameVal = userName == null || String(userName).trim() === '' ? null : String(userName).trim().slice(0, 30);
  const currentDept = existing ? getUserDeptNo(existing.user_no) : null;
  let deptVal = currentDept;
  if (deptNo !== undefined) {
    deptVal = deptNo == null || deptNo === '' ? null : toUserNo(deptNo);
    if (deptNo != null && deptNo !== '' && !deptVal) return { ok: false, reason: 'invalid_dept' };
    // 미사용 부서는 신규 지정 불가 (기존 소속을 그대로 둔 탈퇴 사용자만 예외)
    if (deptVal && !isDeptActive(deptVal) && !(deptVal === currentDept && deleted === 1)) {
      return { ok: false, reason: 'invalid_dept' };
    }
  }
  if (!existing) {
    if (isNicknameTaken(nick)) return { ok: false, reason: 'nickname_taken' };
    try {
      const info = db.prepare(
        `INSERT INTO users (login_id, nickname, phone, user_name, created_at, is_deleted, deleted_at, dept_no, password_hash, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(id, nick, phoneVal, nameVal, ts, deleted, deleted === 1 ? ts : null, deptVal, hashPassword(defaultPasswordOf(id, phoneVal)));
      return { ok: true, user_no: Number(info.lastInsertRowid) };
    } catch (e) {
      if (isLoginIdTaken(id)) return { ok: false, reason: 'login_id_taken' };
      return { ok: false, reason: 'nickname_taken' };
    }
  }
  if (isNicknameTaken(nick, existing.user_no)) return { ok: false, reason: 'nickname_taken' };
  if (existing.user_no === 1 && deleted === 1) return { ok: false, reason: 'admin_protected' };
  db.prepare(
    `UPDATE users SET nickname = ?, phone = ?, user_name = ?, is_deleted = ?, deleted_at = ?, dept_no = ? WHERE user_no = ?`
  ).run(nick, phoneVal, nameVal, deleted, deleted === 1 ? ts : null, deptVal, existing.user_no);
  // 아직 초기 비밀번호(변경 강제 상태)인데 전화번호가 바뀌면 초기 비밀번호도 새 번호 기준으로 맞춘다
  if (phoneVal !== existing.phone && mustChangePassword(existing.user_no)) {
    db.prepare(`UPDATE users SET password_hash = ? WHERE user_no = ?`)
      .run(hashPassword(defaultPasswordOf(id, phoneVal)), existing.user_no);
  }
  return { ok: true, user_no: existing.user_no };
}

function getUserDeptNo(userNo) {
  const row = db.prepare(`SELECT dept_no FROM users WHERE user_no = ?`).get(userNo);
  return row && row.dept_no != null ? Number(row.dept_no) : null;
}

// ─── 부서 (departments) ───
const DEPT_CODE_RE = /^[A-Za-z0-9_-]{1,20}$/;

function isDeptActive(deptNo) {
  const no = toUserNo(deptNo);
  if (!no) return false;
  const row = db.prepare(`SELECT 1 AS ok FROM departments WHERE dept_no = ? AND is_deleted = 0`).get(no);
  return !!row;
}

// 미사용 포함 전체 + 활성 소속 인원 수 (정렬순서 → 부서명)
function getAllDepts() {
  return db
    .prepare(
      `SELECT d.dept_no, d.dept_code, d.dept_name, d.sort_order, d.is_deleted,
              COUNT(u.user_no) AS member_count
         FROM departments d
         LEFT JOIN users u ON u.dept_no = d.dept_no AND u.is_deleted = 0
        GROUP BY d.dept_no
        ORDER BY d.sort_order ASC, d.dept_name ASC`
    )
    .all()
    .map((r) => ({
      deptNo: Number(r.dept_no),
      deptCode: String(r.dept_code),
      deptName: String(r.dept_name),
      sortOrder: Number(r.sort_order),
      isDeleted: Number(r.is_deleted) === 1,
      memberCount: Number(r.member_count),
    }));
}

// admin 전용 upsert: deptNo 없으면 신규, 있으면 수정. dept_code 는 수정 불가.
function upsertDept({ deptNo, deptCode, deptName, sortOrder = 0, isDeleted = false, timestamp }) {
  const name = String(deptName ?? '').trim().slice(0, 30);
  if (!name) return { ok: false, reason: 'invalid_name' };
  const order = Number(sortOrder ?? 0);
  if (!Number.isInteger(order)) return { ok: false, reason: 'invalid_sort' };
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const deleted = isDeleted ? 1 : 0;
  const nameTaken = (exceptNo) => {
    const row = db.prepare(`SELECT dept_no FROM departments WHERE dept_name = ?`).get(name);
    return !!row && Number(row.dept_no) !== exceptNo;
  };

  const no = toUserNo(deptNo);
  if (!no) {
    const code = String(deptCode ?? '').trim();
    if (!DEPT_CODE_RE.test(code)) return { ok: false, reason: 'invalid_code' };
    if (db.prepare(`SELECT 1 FROM departments WHERE dept_code = ?`).get(code)) return { ok: false, reason: 'code_taken' };
    if (nameTaken(null)) return { ok: false, reason: 'name_taken' };
    const info = db.prepare(
      `INSERT INTO departments (dept_code, dept_name, sort_order, created_at, is_deleted, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(code, name, order, ts, deleted, deleted === 1 ? ts : null);
    return { ok: true, deptNo: Number(info.lastInsertRowid) };
  }

  const existing = db.prepare(`SELECT dept_no, is_deleted, deleted_at FROM departments WHERE dept_no = ?`).get(no);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (nameTaken(no)) return { ok: false, reason: 'name_taken' };
  if (deleted === 1) {
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE dept_no = ? AND is_deleted = 0`).get(no).c;
    if (cnt > 0) return { ok: false, reason: 'has_members', memberCount: Number(cnt) };
  }
  // 미사용 상태 유지 시 deleted_at 보존
  const deletedAt = deleted === 1 ? (Number(existing.is_deleted) === 1 ? existing.deleted_at : ts) : null;
  db.prepare(
    `UPDATE departments SET dept_name = ?, sort_order = ?, is_deleted = ?, deleted_at = ? WHERE dept_no = ?`
  ).run(name, order, deleted, deletedAt, no);
  return { ok: true, deptNo: no };
}

// 프로필 이미지: users.profile_file_key → { id, name, size, mime } (없거나 파일이 사라졌으면 null)
function profileImageOf(key) {
  if (!key) return null;
  const file = getFile(key);
  if (!file) return null;
  return { id: file.key, name: file.name, size: file.size, mime: file.mime };
}

// 프로필 이미지 변경(본인). fileKey=null 이면 기본 이미지로 초기화
function setUserProfileImage(userNo, fileKey) {
  const no = toUserNo(userNo);
  if (!no) return { ok: false, reason: 'invalid_user' };
  if (fileKey != null) {
    const file = getFile(fileKey);
    if (!file) return { ok: false, reason: 'not_found' };
    if (!String(file.mime).startsWith('image/')) return { ok: false, reason: 'not_image' };
  }
  const info = db.prepare(`UPDATE users SET profile_file_key = ? WHERE user_no = ?`).run(fileKey ?? null, no);
  if (info.changes === 0) return { ok: false, reason: 'not_found' };
  return { ok: true, user_no: no };
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

// 로그인 비밀번호 확인
function verifyUserPassword(userNo, password) {
  const no = toUserNo(userNo);
  const row = no ? db.prepare(`SELECT password_hash FROM users WHERE user_no = ?`).get(no) : null;
  // 없는 사용자도 같은 해시 계산을 거쳐 응답 시간으로 아이디 존재 여부가 드러나지 않게 한다
  if (!row) {
    verifyPasswordHash(password, DUMMY_PASSWORD_HASH);
    return false;
  }
  return verifyPasswordHash(password, row.password_hash);
}

// 새 비밀번호 규칙: 8~50자, 영문+숫자 각 1자 이상
function isValidNewPassword(v) {
  const s = String(v ?? '');
  return s.length >= 8 && s.length <= 50 && /[A-Za-z]/.test(s) && /\d/.test(s);
}

// 다음 로그인 때 비밀번호 변경을 강제해야 하는지 (신규 등록 / 초기화 직후)
function mustChangePassword(userNo) {
  const no = toUserNo(userNo);
  if (!no) return false;
  const row = db.prepare(`SELECT must_change_password FROM users WHERE user_no = ?`).get(no);
  return !!row && Number(row.must_change_password) === 1;
}

// 비밀번호 변경: 본인만, 현재 비밀번호 확인 필수.
// 현재 비밀번호와 같거나, 초기화 직전 비밀번호로 되돌리는 것은 막는다. 성공하면 변경 강제 해제.
function changePassword({ userNo, currentPassword, newPassword }) {
  const no = toUserNo(userNo);
  if (!no || !getUserByNo(no)) return { ok: false, reason: 'not_found' };
  if (!verifyUserPassword(no, currentPassword)) return { ok: false, reason: 'wrong_current' };
  if (!isValidNewPassword(newPassword)) return { ok: false, reason: 'invalid_new' };
  if (String(newPassword) === String(currentPassword)) return { ok: false, reason: 'same_as_current' };
  const row = db.prepare(`SELECT prev_password_hash FROM users WHERE user_no = ?`).get(no);
  if (row?.prev_password_hash && verifyPasswordHash(newPassword, row.prev_password_hash)) {
    return { ok: false, reason: 'same_as_previous' };
  }
  db.prepare(
    `UPDATE users SET password_hash = ?, prev_password_hash = NULL, must_change_password = 0 WHERE user_no = ?`
  ).run(hashPassword(newPassword), no);
  return { ok: true, user_no: no };
}

// 비밀번호 초기화: 본인 또는 admin(user_no=1). 아이디 + 전화번호 뒤 4자리로 되돌린다.
function resetPassword({ targetNo, requesterNo }) {
  const target = toUserNo(targetNo);
  const requester = toUserNo(requesterNo);
  if (!target || !requester) return { ok: false, reason: 'invalid_user' };
  if (requester !== target && !isAdminNo(requester)) return { ok: false, reason: 'forbidden' };
  const row = getUserByNo(target);
  if (!row) return { ok: false, reason: 'not_found' };
  const plain = defaultPasswordOf(row.loginId, row.phone);
  // 이미 변경 강제 상태(초기화값 사용 중)면 그 전에 쓰던 비밀번호를 그대로 '직전 비밀번호'로 둔다
  db.prepare(
    `UPDATE users
        SET prev_password_hash = CASE WHEN must_change_password = 1 THEN prev_password_hash ELSE password_hash END,
            password_hash = ?, must_change_password = 1
      WHERE user_no = ?`
  ).run(hashPassword(plain), target);
  return { ok: true, user_no: target, password: plain };
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
    .prepare(`SELECT user_no, nickname, profile_file_key FROM users WHERE is_deleted = 0 ORDER BY nickname ASC`)
    .all()
    .map((r) => ({ user_no: Number(r.user_no), nickname: String(r.nickname), profileImage: profileImageOf(r.profile_file_key) }));
}

function getAllUsersDetail() {
  return db
    .prepare(`SELECT user_no, login_id, nickname, phone, user_name, is_deleted, dept_no, profile_file_key FROM users ORDER BY nickname ASC`)
    .all()
    .map((r) => ({
      user_no: Number(r.user_no),
      loginId: String(r.login_id ?? ''),
      nickname: String(r.nickname ?? ''),
      phone: r.phone == null ? null : String(r.phone),
      userName: r.user_name == null ? null : String(r.user_name),
      isDeleted: Number(r.is_deleted) === 1,
      deptNo: r.dept_no == null ? null : Number(r.dept_no),
      profileImage: profileImageOf(r.profile_file_key),
    }));
}

module.exports = {
  db,
  isValidLoginId,
  normalizeNickname,
  toUserNo,
  isAdminNo,
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
  findActiveOneToOneRoom,
  ensureOneToOneRoom,
  addMember,
  inviteMembers,
  removeMember,
  countMembers,
  getRoomMembers,
  getRoomMemberNos,
  getRoomIdsOfUser,
  getEarliestMemberExcept,
  transferOwner,
  getMyRooms,
  getRoomDisplayName,
  setRoomDisplayName,
  softDeleteRoom,
  closeRoomIfEmpty,
  getRoomHistory,
  getRecentRoomMessages,
  getRoomMessagesPage,
  getRoomMessagesAround,
  searchRoomMessages,
  getUserByNo,
  getUserByLoginId,
  isLoginIdTaken,
  isNicknameTaken,
  upsertUser,
  renameUser,
  verifyUserPassword,
  mustChangePassword,
  changePassword,
  resetPassword,
  setUserProfileImage,
  withdrawUser,
  isWithdrawnByNo,
  isRegisteredNo,
  getAllUsers,
  getAllUsersDetail,
  getAllDepts,
  upsertDept,
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
