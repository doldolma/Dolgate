// 서버 배너(RFC 4252 §5.4)를 세션 스냅샷에 합치는 규칙.
//
// 배너를 터미널에 직접 쓰지 않고 세션 스냅샷(runtimeSessionSnapshots → lastViewportSnapshot)
// 에 넣는다. 직접 쓰면 두 가지로 깨진다:
//
//  1. 화면은 WebView 하나뿐이고 활성 세션만 그린다. 백그라운드에서 붙는 탭의 배너는
//     아무도 받지 못한다. 게다가 배너의 원래 저장처(connectionViews)는 연결이 성공하는
//     순간 지워져서, 나중에 그 탭으로 가도 되찾을 수 없다.
//  2. 화면은 lastViewportSnapshot 이 바뀌면 resetTerminalViewport 로 화면을 지우고
//     스냅샷으로 다시 그린다(SessionScreen 의 restoreTerminalSnapshot). 직접 쓴 배너는
//     그 다음 복원에서 지워진다.
//
// 스냅샷에 넣으면 즉시 표시·탭 전환·늦은 WebView 부팅·재접속이 전부 같은 한 경로로
// 해결된다 — 세션마다 독립인 상태이기 때문이다.
//
// 배너는 인증 단계에 오므로 보통 스냅샷이 비어 있고, 자연히 셸 출력보다 앞에 놓인다.

/**
 * 스냅샷 뒤에 배너를 붙인 새 스냅샷. 붙일 것이 없으면 null(호출부가 아무것도 안 한다).
 */
export function appendSessionBanner(
  snapshot: string | undefined,
  banner: string,
): string | null {
  const text = banner.trim();
  if (!text) {
    return null;
  }
  // xterm 은 \n 만으로 열을 되돌리지 않아 줄이 계단처럼 밀린다 — CRLF 로 맞춘다.
  const block = `${text.replace(/\r?\n/g, '\r\n')}\r\n`;
  const current = snapshot ?? '';
  // 서버가 같은 배너를 여러 번 보내거나 이벤트가 중복 전달돼도 화면에 두 번 쌓지 않는다.
  if (current.includes(block)) {
    return null;
  }
  return `${current}${block}`;
}
