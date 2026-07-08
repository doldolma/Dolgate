import type {
  AiChatDelta,
  AiChatRequest,
  AiChatResult,
  AiProviderId,
  AiTestResult,
  AiToolEvent,
} from "../../shared/ai";

// AiService가 어댑터를 만들 때 넘기는 해석된 설정. apiKey는 SecretStore에서 읽어 채운다.
// 어댑터는 이 apiKey를 호출 동안만 쓰고 별도로 캐시하지 않는다(AiService가 매 호출 재조회).
export interface ProviderConfig {
  providerId: AiProviderId;
  baseUrl?: string;
  model: string;
  apiKey: string;
  temperature?: number;
}

export interface ProviderChatOptions {
  signal: AbortSignal;
  onDelta: (delta: AiChatDelta) => void;
  // 어댑터 내부 에이전트 루프에서 실행되는 내장 도구 활동(codex web_search·로컬 실행 등)을
  // AiService 실행 경로와 같은 tool 칩 스트림으로 올린다. dolssh 도구(MCP 경유)는 해당 없음.
  onToolEvent?: (tool: AiToolEvent) => void;
}

// main 프로세스 전용 provider 어댑터. 모든 LLM egress는 이 뒤에 격리된다.
export interface ProviderAdapter {
  readonly id: AiProviderId;
  testConnection(opts: { signal: AbortSignal }): Promise<AiTestResult>;
  chat(request: AiChatRequest, opts: ProviderChatOptions): Promise<AiChatResult>;
  // 모델의 컨텍스트 창(입력 토큰 한도)을 프로바이더에서 조회. 알 수 없으면 null.
  // Anthropic 은 Models API 로 정확히 알 수 있어 구현하고, openai-compat 은 서버에
  // 로드된 창을 API 로 알 수 없어 미구현(사용자 설정 사용). 실패는 throw 하지 않는다.
  getModelContextTokens?(model: string, opts: { signal: AbortSignal }): Promise<number | null>;
}
