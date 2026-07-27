import { convert } from "html-to-text";

import type { AiSearchBackend, AiToolDef } from "../../../shared/ai";
import { t } from '../../i18n';

export const WEB_SEARCH_TOOL: AiToolDef = {
  name: "web_search",
  description:
    "Search the web for up-to-date information (docs, errors, CVEs, versions). " +
    "Returns titles, URLs, and content snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },
};

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const MAX_SNIPPET = 500;
const DDG_MAX_OUTPUT = 5_000;

// 검색 쿼리 egress 전 흔한 시크릿 흔적 제거(모델 컨텍스트는 이미 redact되지만 방어적으로).
function redactQuery(query: string): string {
  return query
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, "sk-***")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AWS_KEY_***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***");
}

export async function runWebSearch(
  args: Record<string, unknown>,
  opts: { signal: AbortSignal; backend: AiSearchBackend; apiKey: string | null },
): Promise<string> {
  const query = typeof args.query === "string" ? redactQuery(args.query.trim()) : "";
  if (!query) {
    return t('webSearch.queryEmpty');
  }
  if (opts.backend === "tavily") {
    return searchTavily(query, opts.apiKey, opts.signal);
  }
  return searchDuckDuckGo(query, opts.signal);
}

interface TavilyResponse {
  answer?: string;
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

async function searchTavily(
  query: string,
  apiKey: string | null,
  signal: AbortSignal,
): Promise<string> {
  if (!apiKey) {
    return t('webSearch.noTavilyKey');
  }
  let response: Response;
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        include_answer: true,
        search_depth: "basic",
      }),
      signal,
    });
  } catch {
    return t('webSearch.networkFailed');
  }
  if (!response.ok) {
    return t('webSearch.httpFailed', { status: response.status });
  }
  let data: TavilyResponse;
  try {
    data = (await response.json()) as TavilyResponse;
  } catch {
    return t('webSearch.parseFailed');
  }
  const parts: string[] = [];
  if (data.answer) {
    parts.push(`Answer: ${data.answer}`);
  }
  for (const result of data.results ?? []) {
    const snippet = (result.content ?? "").slice(0, MAX_SNIPPET);
    parts.push(`- ${result.title ?? "(untitled)"} — ${result.url ?? ""}\n  ${snippet}`);
  }
  return parts.length > 0 ? parts.join("\n") : t('webSearch.noResults');
}

// 키리스: DuckDuckGo HTML 엔드포인트를 스크레이프한다(비공식 — rate-limit/DOM 변경에 취약).
async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(DDG_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // 봇 차단 회피용 브라우저 UA.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal,
    });
  } catch {
    return t('webSearch.networkFailed');
  }
  if (!response.ok) {
    return t('webSearch.httpFailed', { status: response.status });
  }
  const html = await response.text();
  // 결과 블록만 텍스트화(클래스가 바뀌면 전체 페이지로 폴백).
  let text = convert(html, {
    wordwrap: false,
    baseElements: { selectors: ["div.result", ".result", ".web-result"] },
  });
  if (!text.trim()) {
    text = convert(html, { wordwrap: false });
  }
  return text.trim().slice(0, DDG_MAX_OUTPUT) || t('webSearch.noResults');
}
