import type { AiSearchBackend, AiToolDef } from "../../../shared/ai";
import { WEB_SEARCH_TOOL, runWebSearch } from "./web-search";
import { FETCH_URL_TOOL, runFetchUrl } from "./fetch-url";
import { RUN_IN_TERMINAL_TOOL, runInTerminalTool, type TerminalRunResult } from "./run-command";
import { INSPECT_COMMAND_TOOL, inspectCommandTool, type HostCommandResult } from "./inspect-command";

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: { signal: AbortSignal },
) => Promise<string>;

export interface ToolRegistry {
  defs: AiToolDef[];
  executors: Map<string, ToolExecutor>;
}

export interface ToolRegistryConfig {
  webSearch: boolean;
  fetchUrl: boolean;
  searchBackend: AiSearchBackend;
  searchKey: string | null;
  // 있으면 run_in_terminal 노출: 사용자의 활성 터미널에 타이핑 후 캡처한 출력을 돌려줌. sessionId 바인딩됨.
  runInTerminal?: (command: string) => Promise<TerminalRunResult>;
  // 있으면 inspect_command 노출: 숨은 exec 채널로 조회해 출력을 돌려줌(AI가 분석). sessionId 바인딩됨.
  execCapture?: (command: string) => Promise<HostCommandResult>;
}

// 설정/세션에 따라 사용 가능한 클라이언트 도구만 노출한다. 검색키·host 실행자는 executor 에 클로저로 주입.
export function buildToolRegistry(config: ToolRegistryConfig): ToolRegistry {
  const defs: AiToolDef[] = [];
  const executors = new Map<string, ToolExecutor>();

  if (config.webSearch) {
    defs.push(WEB_SEARCH_TOOL);
    executors.set(WEB_SEARCH_TOOL.name, (args, ctx) =>
      runWebSearch(args, {
        signal: ctx.signal,
        backend: config.searchBackend,
        apiKey: config.searchKey,
      }),
    );
  }
  if (config.fetchUrl) {
    defs.push(FETCH_URL_TOOL);
    executors.set(FETCH_URL_TOOL.name, (args, ctx) => runFetchUrl(args, ctx));
  }
  if (config.runInTerminal) {
    const typeIntoTerminal = config.runInTerminal;
    defs.push(RUN_IN_TERMINAL_TOOL);
    executors.set(RUN_IN_TERMINAL_TOOL.name, (args) => runInTerminalTool(args, typeIntoTerminal));
  }
  if (config.execCapture) {
    const exec = config.execCapture;
    defs.push(INSPECT_COMMAND_TOOL);
    executors.set(INSPECT_COMMAND_TOOL.name, (args) => inspectCommandTool(args, exec));
  }

  return { defs, executors };
}
