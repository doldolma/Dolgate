import type { AiSearchBackend, AiToolDef } from "../../../shared/ai";
import { WEB_SEARCH_TOOL, runWebSearch } from "./web-search";
import { FETCH_URL_TOOL, runFetchUrl } from "./fetch-url";

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
}

// 설정에서 켜진 클라이언트 도구만 노출한다. 검색키는 web_search executor 에 클로저로 주입.
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

  return { defs, executors };
}
