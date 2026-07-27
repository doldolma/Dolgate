import type { AiToolDef } from "../../../shared/ai";
import { redactSecrets } from "../redact";
import { t } from '../../i18n';

export const RUN_IN_TERMINAL_TOOL: AiToolDef = {
  name: "run_in_terminal",
  description:
    "Type a shell command into the user's ACTIVE terminal session and run it there, so the user sees the command " +
    "and its live output in their own terminal. Use this when the user should watch the command run or its result: " +
    "starting/stopping/restarting services, following logs ('docker logs -f', 'tail -f'), interactive or long-running " +
    "commands, or any change the user should observe. Read-only commands run immediately; state-changing commands ask " +
    "the user to approve first. It runs in the user's current shell, so working directory and environment persist. " +
    "The captured output is returned to you, so summarize it for the user afterward rather than telling them to look at the terminal; " +
    "long-running/streaming commands only return the first few seconds (marked still-running) — do not re-run them waiting for more. " +
    "This is NOT for answering informational questions — for those, use inspect_command and report the answer yourself.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to type into the user's terminal.",
      },
      changes_state: {
        type: "boolean",
        description:
          "YOU decide: set true if this command changes the host in any way (creates/edits/deletes files, " +
          "installs/removes packages, starts/stops/restarts services or containers, changes config/permissions, " +
          "kills processes, reboots, etc.); false for read-only/observing commands (logs, status, listing). " +
          "When true, the user is asked to approve before it runs. Be honest — err toward true if unsure.",
      },
      explanation: {
        type: "string",
        description: "Optional one-line reason this command is being run (shown to the user).",
      },
    },
    required: ["command"],
  },
};

export interface TerminalRunResult {
  output: string;
  running: boolean;
}

const MAX_OUTPUT_CHARS = 8_000;

// run_in_terminal executor. `runInTerminal` 은 sessionId 가 바인딩된 함수로, 사용자의 활성 PTY 에
// 명령을 입력(+Enter)하고 그 결과 출력을 캡처해 돌려준다. 실행 불가하면 throw(→ isError 로 모델에 전달).
export async function runInTerminalTool(
  args: Record<string, unknown>,
  runInTerminal: (command: string) => Promise<TerminalRunResult>,
): Promise<string> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return t('runCommand.empty');
  }
  const { output, running } = await runInTerminal(command);
  const body = clip(redactSecrets(output));
  const parts = [
    t('runCommand.header', { command }),
    "",
    body || t('runCommand.noOutput'),
  ];
  if (running) {
    parts.push("", t('runCommand.stillRunning'));
  }
  return parts.join("\n");
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n${t('runCommand.truncated')}`;
}
