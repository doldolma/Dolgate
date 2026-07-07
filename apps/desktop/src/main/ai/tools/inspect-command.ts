import type { AiToolDef } from "../../../shared/ai";
import { redactSecrets } from "../redact";

export const INSPECT_COMMAND_TOOL: AiToolDef = {
  name: "inspect_command",
  description:
    "Your DEFAULT tool for answering questions about the system: run a READ-ONLY command on a separate hidden channel " +
    "and get its stdout/stderr/exit code back, so you can analyze the output and answer the user directly with a summary. " +
    "Prefer this over run_in_terminal whenever the user just wants to KNOW something. Use it when you need to gather information to answer " +
    "(check disk usage, read a config file, list processes/containers, grep logs, enumerate devices, …) and present a " +
    "cleaned-up result. Read-only pipelines, loops and substitutions are fine (e.g. 'ps aux | grep nginx', " +
    "'for d in /sys/block/*; do cat $d/queue/rotational 2>/dev/null; done'). It does NOT appear in the user's terminal. " +
    "State-changing commands (rm, dd, writes, package installs, systemctl, sudo, …) are rejected here — for anything that " +
    "changes the host, or that the user should watch run live (following logs, interactive, long-running), use run_in_terminal instead. " +
    "Each call is a fresh non-interactive exec (no sudo password prompt; working directory/environment do NOT persist — chain with '&&'). Times out after ~30s.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The read-only shell command to run and capture.",
      },
      explanation: {
        type: "string",
        description: "Optional one-line reason this command is being run (shown to the user).",
      },
    },
    required: ["command"],
  },
};

export interface HostCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

const MAX_OUTPUT_CHARS = 8_000;

// inspect_command executor. `exec` 는 sessionId 가 바인딩된 hidden exec 함수(실행 불가 세션이면 throw
// → 에이전트 루프가 isError 로 모델에 전달). 출력은 모델로 나가기 전 redact.
export async function inspectCommandTool(
  args: Record<string, unknown>,
  exec: (command: string) => Promise<HostCommandResult>,
): Promise<string> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return "error: 실행할 명령(command)이 비어 있습니다.";
  }
  const result = await exec(command);
  return formatResult(command, result);
}

function formatResult(command: string, result: HostCommandResult): string {
  const stdout = clip(redactSecrets(result.stdout));
  const stderr = clip(redactSecrets(result.stderr));
  const parts: string[] = [`$ ${command}`, `exit code: ${result.exitCode}`];
  parts.push(`stdout:\n${stdout || "(empty)"}`);
  if (stderr.trim()) {
    parts.push(`stderr:\n${stderr}`);
  }
  if (result.truncated) {
    parts.push("(output truncated by host)");
  }
  return parts.join("\n");
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`;
}
