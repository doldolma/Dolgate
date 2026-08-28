// 서브셸 진입 명령을 보냈을 때 셸 통합을 다시 넣는 한 곳.
//
// 왜 따로 두나: 감지는 원래 **사용자가 터미널에 친 입력**(pane 컨트롤러의 onData)에만 붙어
// 있었다. 그런데 패널(도커 섹션의 셸 접속, 스니펫)은 xterm 을 거치지 않고 PTY 로 곧장 쓰므로
// 그 경로를 타지 않는다 — `docker exec` 로 컨테이너에 들어가도 통합이 안 붙어 명령 상태가
// 회색으로 굳었다. 두 경로가 같은 판정을 쓰도록 여기로 모은다.

import { appStore } from '../store/appStore';
import { reinjectTerminalShellIntegration } from '../services/desktop/terminal';
import { detectSubshellEntry } from './subshell-detect';

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
  const detection = detectSubshellEntry(
    command,
    settings?.subshellReinjectPatterns ?? [],
  );
  if (!detection) {
    return;
  }
  // 일반적인 ssh/docker 명령에서 대상 셸은 **짐작하지 않는다.**
  //
  // 예전에는 명령 문자열의 마지막 토큰에서 셸을 짚었는데, 그 추측이 계속 틀렸다. 마지막이
  // `sh -c '… exec bash || exec sh'` 인 도커 접속 명령을 "sh" 로 단정해, bash 컨테이너인데도
  // 통합을 포기했다. 다만 `& "C:\...\bash.exe"`처럼 첫 실행 파일 자체가 지원 셸이면 대상이
  // 확실하므로 힌트를 보낸다. 그 밖에는 도착한 셸에게 코어가 직접 묻는다(ShellProbeCommand).
  void reinjectTerminalShellIntegration(sessionId, detection.shellHint).catch(
    () => undefined,
  );
}
