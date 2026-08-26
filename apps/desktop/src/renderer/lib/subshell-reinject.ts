// 서브셸 진입 명령을 보냈을 때 셸 통합을 다시 넣는 한 곳.
//
// 왜 따로 두나: 감지는 원래 **사용자가 터미널에 친 입력**(pane 컨트롤러의 onData)에만 붙어
// 있었다. 그런데 패널(도커 섹션의 셸 접속, 스니펫)은 xterm 을 거치지 않고 PTY 로 곧장 쓰므로
// 그 경로를 타지 않는다 — `docker exec` 로 컨테이너에 들어가도 통합이 안 붙어 명령 상태가
// 회색으로 굳었다. 두 경로가 같은 판정을 쓰도록 여기로 모은다.

import { appStore } from '../store/appStore';
import { reinjectTerminalShellIntegration } from '../services/desktop/terminal';
import { detectsSubshellEntry, resolveSubshellShell } from './subshell-detect';

/**
 * `command` 가 서브셸로 들어가는 것이면 통합을 다시 주입한다. 아니면 아무것도 하지 않는다.
 *
 * 실패는 삼킨다 — 통합이 안 붙는 것은 상태 표시가 낡는 정도고, 여기서 던지면 명령을 보낸 쪽이
 * 실패한 것처럼 보인다.
 */
export function reinjectShellIntegrationIfSubshell(
  sessionId: string,
  command: string,
): void {
  const settings = appStore.getState().settings;
  if (settings?.subshellReinjectEnabled === false) {
    return;
  }
  if (!detectsSubshellEntry(command, settings?.subshellReinjectPatterns ?? [])) {
    return;
  }
  // 어떤 셸로 들어가는지 명령에 적혀 있으면 함께 보낸다(`fish`, `docker exec … sh`).
  // 코어가 그 셸 전용 스크립트 한 줄만 보내고, 모르면 겸용을 보낸다.
  void reinjectTerminalShellIntegration(sessionId, resolveSubshellShell(command)).catch(
    () => undefined,
  );
}
