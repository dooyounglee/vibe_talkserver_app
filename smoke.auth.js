// 스모크 테스트 공용 로그인 헬퍼
// - 테스트 사용자 전화번호는 TEST_PHONE 고정 → 초기 비밀번호 = 아이디 + '1234' (admin은 'admin')
// - 신규 등록 계정은 첫 로그인에 비밀번호 변경이 강제되므로(password_change_required)
//   자동으로 '<아이디>Pass99'로 바꾸고, 이후 로그인에는 바뀐 비밀번호를 쓴다.
const TEST_PHONE = '010-0000-1234';
const passwords = new Map([['admin', 'admin']]);
const currentPassword = (loginId) => passwords.get(loginId) ?? `${loginId}1234`;

function sendJoin(ws, loginId) {
  ws.send(JSON.stringify({ type: 'join', loginId, password: currentPassword(loginId) }));
  const onMessage = (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'password_change_required') {
      const next = `${loginId}Pass99`;
      ws.send(JSON.stringify({ type: 'password_change', currentPassword: currentPassword(loginId), newPassword: next }));
      passwords.set(loginId, next);
    }
    if (m.type === 'join_ok' || m.type === 'join_failed') ws.off('message', onMessage);
  };
  ws.on('message', onMessage);
}

module.exports = { TEST_PHONE, sendJoin, currentPassword };
