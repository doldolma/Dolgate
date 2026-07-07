import type {
  AiChatDelta,
  AiChatRequest,
  AiChatResult,
  AiProviderId,
  AiTestResult,
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
}

// main 프로세스 전용 provider 어댑터. 모든 LLM egress는 이 뒤에 격리된다.
export interface ProviderAdapter {
  readonly id: AiProviderId;
  testConnection(opts: { signal: AbortSignal }): Promise<AiTestResult>;
  chat(request: AiChatRequest, opts: ProviderChatOptions): Promise<AiChatResult>;
}
