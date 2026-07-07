import type { SettingsRepository } from "./database";
import type { SecretStore } from "./secret-store";
import type {
  AiApiKeyStatus,
  AiChatEvent,
  AiChatRequest,
  AiChatStartInput,
  AiProviderId,
  AiTestConnectionInput,
  AiTestResult,
} from "../shared/ai";
import type { ProviderAdapter, ProviderConfig } from "./ai/provider";
import { AnthropicAdapter } from "./ai/provider-anthropic";
import { OpenAiAdapter } from "./ai/provider-openai";
import { AiRequestError, normalizeAiError } from "./ai/provider-errors";

const API_KEY_ACCOUNT_PREFIX = "ai:apiKey:";
const TEST_CONNECTION_TIMEOUT_MS = 15_000;

function apiKeyAccount(providerId: AiProviderId): string {
  return `${API_KEY_ACCOUNT_PREFIX}${providerId}`;
}

// AI 어시스턴트의 main 프로세스 소유 서비스. 모든 LLM egress 를 이 뒤에 격리한다.
// - 설정은 SettingsRepository, API 키는 SecretStore(키체인)에서 매 호출 재조회(메모리 캐시 안 함).
// - chat 스트리밍은 requestId 로 상관하고, emit 콜백(핸들러가 event.sender 로 구성)으로 렌더러에 푸시.
export class AiService {
  private readonly activeChats = new Map<string, AbortController>();

  constructor(
    private readonly settings: SettingsRepository,
    private readonly secretStore: SecretStore,
  ) {}

  async setApiKey(providerId: AiProviderId, key: string): Promise<AiApiKeyStatus> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new AiRequestError("auth", "API 키가 비어 있습니다.");
    }
    await this.secretStore.save(apiKeyAccount(providerId), trimmed);
    return { hasKey: true };
  }

  async clearApiKey(providerId: AiProviderId): Promise<AiApiKeyStatus> {
    await this.secretStore.remove(apiKeyAccount(providerId));
    return { hasKey: false };
  }

  // 원본 키를 노출하지 않고 "키 설정됨" 여부만 반환한다.
  async apiKeyStatus(providerId: AiProviderId): Promise<AiApiKeyStatus> {
    const key = await this.secretStore.load(apiKeyAccount(providerId));
    return { hasKey: key !== null && key.length > 0 };
  }

  // 저장 전 검증용. transient 키가 있으면 그것으로(저장하지 않음), 없으면 키체인 키로 테스트.
  async testConnection(input: AiTestConnectionInput): Promise<AiTestResult> {
    const transientKey = input.apiKey?.trim();
    const apiKey = transientKey || (await this.secretStore.load(apiKeyAccount(input.providerId))) || "";
    const adapter = this.buildAdapter({
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey,
      temperature: undefined,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
    try {
      // 어댑터의 testConnection 은 내부에서 정규화해 AiTestResult 를 반환한다(throw 안 함).
      return await adapter.testConnection({ signal: controller.signal });
    } catch (error) {
      const normalized = normalizeAiError(error);
      return { ok: false, reason: normalized.reason, message: normalized.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  // 스트리밍 chat 시작. 즉시 반환하고, delta/done/error 를 emit 으로 푸시한다.
  startChat(input: AiChatStartInput, emit: (event: AiChatEvent) => void): void {
    const { requestId, request } = input;
    if (this.activeChats.has(requestId)) {
      emit({
        requestId,
        type: "error",
        error: { reason: "invalid-response", message: "이미 진행 중인 요청입니다." },
      });
      return;
    }

    const controller = new AbortController();
    this.activeChats.set(requestId, controller);
    void this.runChat(requestId, request, controller, emit).finally(() => {
      this.activeChats.delete(requestId);
    });
  }

  cancelChat(requestId: string): void {
    this.activeChats.get(requestId)?.abort();
  }

  private async runChat(
    requestId: string,
    request: AiChatRequest,
    controller: AbortController,
    emit: (event: AiChatEvent) => void,
  ): Promise<void> {
    try {
      const config = await this.resolveChatConfig(request.model);
      const adapter = this.buildAdapter(config);
      const result = await adapter.chat(request, {
        signal: controller.signal,
        onDelta: (delta) => emit({ requestId, type: "delta", delta }),
      });
      emit({ requestId, type: "done", result });
    } catch (error) {
      if (controller.signal.aborted) {
        // 사용자 취소(cancelChat) 또는 타임아웃 → 에러가 아니라 깨끗한 aborted done.
        emit({ requestId, type: "done", result: { text: "", finishReason: "aborted" } });
        return;
      }
      emit({ requestId, type: "error", error: normalizeAiError(error) });
    }
  }

  private async resolveChatConfig(requestModel?: string): Promise<ProviderConfig> {
    const ai = this.settings.get().ai;
    if (!ai || !ai.enabled) {
      throw new AiRequestError("disabled", "AI 어시스턴트가 비활성화되어 있습니다.");
    }
    const apiKey = (await this.secretStore.load(apiKeyAccount(ai.providerId))) ?? "";
    // openai-compat 로컬 서버는 키가 없을 수 있으나, anthropic 은 키 필수.
    if (!apiKey && ai.providerId === "anthropic") {
      throw new AiRequestError("auth", "API 키가 설정되지 않았습니다.");
    }
    const model = requestModel || ai.model;
    if (!model) {
      throw new AiRequestError("model-not-found", "사용할 모델이 설정되지 않았습니다.");
    }
    return {
      providerId: ai.providerId,
      baseUrl: ai.baseUrl,
      model,
      apiKey,
      temperature: ai.temperature,
    };
  }

  private buildAdapter(config: ProviderConfig): ProviderAdapter {
    switch (config.providerId) {
      case "anthropic":
        return new AnthropicAdapter(config);
      case "openai-compat":
      default:
        return new OpenAiAdapter(config);
    }
  }
}
