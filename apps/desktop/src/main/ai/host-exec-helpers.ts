import type { CoreManager } from "../core-manager";
import type { ActivityLogRepository, HostRepository } from "../database";
import type { AiToolExecutorHelpers } from "../ai-service";

// inspect_command(숨은 exec 채널)은 sshsession(= Go runtime.ssh)이 실제 ssh.Client 를 쥐는 전송만 가능.
// run_in_terminal(PTY 입력)은 연결된 세션이면 어디든 가능(SSH/tmux/local/serial/aws-ssm…).
const EXEC_CAPTURE_TRANSPORTS = new Set<string>(["ssh", "warpgate", "aws-ssm-server-proxy"]);

// AiService 에 주입할 host 실행·감사 헬퍼. 두 실행 경로를 제공한다:
//  - runInTerminal: 사용자의 활성 터미널(PTY)에 명령 입력(사용자가 실행/출력을 직접 봄).
//  - execCapture: 별도 exec 채널로 읽기전용 조회 → 출력 캡처(AI가 분석·요약).
// AiService 를 coreManager/hosts/activityLogs 에 직접 결합하지 않도록 좁은 콜백만 넘긴다.
export function buildAiToolHelpers(deps: {
  coreManager: CoreManager;
  hosts: HostRepository;
  activityLogs: ActivityLogRepository;
}): AiToolExecutorHelpers {
  const { coreManager, hosts, activityLogs } = deps;

  const connectedTab = (sessionId: string) =>
    coreManager.listTabs().find((tab) => tab.sessionId === sessionId && tab.status === "connected");

  const hostLabelOf = (hostId: string | null) => (hostId ? (hosts.getById(hostId)?.label ?? null) : null);

  return {
    canRunInTerminal: (sessionId) => connectedTab(sessionId) !== undefined,
    runInTerminal: async (sessionId, command) => {
      const tab = connectedTab(sessionId);
      if (!tab) {
        throw new Error("연결된 터미널 세션이 없어 명령을 입력할 수 없습니다.");
      }
      // 사용자의 활성 PTY 에 명령을 입력하고(사용자가 실행/출력을 직접 봄) 결과 출력을 캡처해 돌려준다.
      const result = await coreManager.runInTerminalCapture(sessionId, command);
      activityLogs.append("info", "audit", `AI가 터미널에 명령 입력: ${command}`, {
        sessionId,
        hostId: tab.hostId,
        hostLabel: hostLabelOf(tab.hostId),
        command,
        via: "run_in_terminal",
      });
      return result;
    },
    canExecCapture: (sessionId) => {
      const transport = coreManager.getSessionTransport(sessionId);
      return transport !== undefined && EXEC_CAPTURE_TRANSPORTS.has(transport);
    },
    execCapture: async (sessionId, command) => {
      const startedAt = Date.now();
      const result = await coreManager.runCommand(sessionId, command);
      const durationMs = Date.now() - startedAt;
      const tab = connectedTab(sessionId);
      activityLogs.append(
        result.exitCode === 0 ? "info" : "warn",
        "audit",
        `AI가 조회 명령 실행: ${command}`,
        {
          sessionId,
          hostId: tab?.hostId ?? null,
          hostLabel: hostLabelOf(tab?.hostId ?? null),
          command,
          exitCode: result.exitCode,
          durationMs,
          via: "inspect_command",
        },
      );
      return result;
    },
    auditLog: (level, category, message, metadata) => {
      activityLogs.append(level, category, message, metadata);
    },
  };
}
