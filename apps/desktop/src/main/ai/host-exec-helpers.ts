import type { CoreManager } from "../core-manager";
import type { ActivityLogRepository, HostRepository } from "../database";
import type { AiToolExecutorHelpers } from "../ai-service";
import { t } from '../i18n';

// inspect_command(숨은 exec 채널)은 코어가 **보조 채널로 로그인 셸을 돌릴 수 있는** 전송만
// 가능하다. SSH 계열은 ssh.Client 로, local-shell 은 이 컴퓨터의 프로세스로 돈다(Go
// localsession.RunHostCommand). tmux control-mode·serial·aws-ssm 은 그 통로가 없다.
// run_in_terminal(PTY 입력)은 연결된 세션이면 어디든 가능(SSH/tmux/local/serial/aws-ssm…).
const EXEC_CAPTURE_TRANSPORTS = new Set<string>([
  "ssh",
  "warpgate",
  "aws-ssm-server-proxy",
  "local-shell",
]);

// AiService 에 주입할 host 실행 헬퍼. 두 실행 경로를 제공한다:
//  - runInTerminal: 사용자의 활성 터미널(PTY)에 명령 입력(사용자가 실행/출력을 직접 봄).
//  - execCapture: 별도 exec 채널로 읽기전용 조회 → 출력 캡처(AI가 분석·요약).
// AI 도구 사용 내역은 AI 패널의 작업 내역에만 남기고 전역 Logs 페이지에는 기록하지 않는다.
export function buildAiToolHelpers(deps: {
  coreManager: CoreManager;
  hosts: HostRepository;
  activityLogs: ActivityLogRepository;
}): AiToolExecutorHelpers {
  const { coreManager } = deps;

  const connectedTab = (sessionId: string) =>
    coreManager.listTabs().find((tab) => tab.sessionId === sessionId && tab.status === "connected");

  return {
    canRunInTerminal: (sessionId) => connectedTab(sessionId) !== undefined,
    runInTerminal: async (sessionId, command) => {
      if (!connectedTab(sessionId)) {
        throw new Error(t('misc.noTerminalSession'));
      }
      // 사용자의 활성 PTY 에 명령을 입력하고(사용자가 실행/출력을 직접 봄) 결과 출력을 캡처해 돌려준다.
      return coreManager.runInTerminalCapture(sessionId, command);
    },
    canExecCapture: (sessionId) => {
      const transport = coreManager.getSessionTransport(sessionId);
      if (transport === undefined || !EXEC_CAPTURE_TRANSPORTS.has(transport)) {
        return false;
      }
      // **로컬 셸만 플랫폼을 따진다.** 코어는 보조 채널을 /bin/sh 로 돌리는데 윈도우에는 그것이
      // 없어 호출이 통째로 실패한다(localsession.RunHostCommand 가 거기서 에러를 낸다). 도구를
      // 아예 내주지 않으면 AI 는 터미널에 직접 넣는 길(runInTerminal)로 가므로, 못 하는 도구를
      // 쥐어 주고 실패를 보여 주는 것보다 낫다. 원격 SSH 는 저쪽이 유닉스라 이 제한과 무관하다.
      return transport !== "local-shell" || process.platform !== "win32";
    },
    execCapture: async (sessionId, command) => {
      return coreManager.runCommand(sessionId, command);
    },
  };
}
