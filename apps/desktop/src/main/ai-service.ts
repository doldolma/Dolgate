import type { SettingsRepository } from "./database";
import type { SecretStore } from "./secret-store";
import type {
  AiApiKeyStatus,
  AiChatEvent,
  AiChatMessage,
  AiChatRequest,
  AiChatStartInput,
  AiProviderId,
  AiSearchBackend,
  AiToolCall,
  AiToolResult,
  AiTestConnectionInput,
  AiTestResult,
} from "../shared/ai";
import type { ProviderAdapter, ProviderConfig } from "./ai/provider";
import { buildToolRegistry, type ToolRegistry } from "./ai/tools/registry";
import { AnthropicAdapter } from "./ai/provider-anthropic";
import { OpenAiAdapter } from "./ai/provider-openai";
import { AiRequestError, normalizeAiError } from "./ai/provider-errors";

const API_KEY_ACCOUNT_PREFIX = "ai:apiKey:";
const SEARCH_KEY_ACCOUNT_PREFIX = "ai:searchKey:";
const TEST_CONNECTION_TIMEOUT_MS = 15_000;
const MAX_TOOL_ITERATIONS = 5;

function apiKeyAccount(providerId: AiProviderId): string {
  return `${API_KEY_ACCOUNT_PREFIX}${providerId}`;
}

function searchKeyAccount(backend: AiSearchBackend): string {
  return `${SEARCH_KEY_ACCOUNT_PREFIX}${backend}`;
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

  async setSearchKey(backend: AiSearchBackend, key: string): Promise<AiApiKeyStatus> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new AiRequestError("auth", "검색 API 키가 비어 있습니다.");
    }
    await this.secretStore.save(searchKeyAccount(backend), trimmed);
    return { hasKey: true };
  }

  async clearSearchKey(backend: AiSearchBackend): Promise<AiApiKeyStatus> {
    await this.secretStore.remove(searchKeyAccount(backend));
    return { hasKey: false };
  }

  async searchKeyStatus(backend: AiSearchBackend): Promise<AiApiKeyStatus> {
    const key = await this.secretStore.load(searchKeyAccount(backend));
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
      const registry = await this.resolveTools();
      const tools = registry.defs.length ? registry.defs : undefined;

      // 에이전트 루프: 모델이 도구를 부르면 실행 결과를 붙여 다시 물어본다(상한까지).
      let messages: AiChatMessage[] = [...request.messages];
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const result = await adapter.chat(
          { ...request, messages, tools },
          { signal: controller.signal, onDelta: (delta) => emit({ requestId, type: "delta", delta }) },
        );
        if (result.finishReason !== "tool_calls" || !result.toolCalls?.length) {
          emit({ requestId, type: "done", result });
          return;
        }
        const toolResults = await this.executeTools(
          requestId,
          result.toolCalls,
          registry,
          controller,
          emit,
        );
        messages = [
          ...messages,
          { role: "assistant", content: result.text, toolCalls: result.toolCalls },
          { role: "tool", content: "", toolResults },
        ];
      }
      emit({
        requestId,
        type: "error",
        error: { reason: "server", message: "도구 반복 횟수를 초과했습니다." },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // 사용자 취소(cancelChat) 또는 타임아웃 → 에러가 아니라 깨끗한 aborted done.
        emit({ requestId, type: "done", result: { text: "", finishReason: "aborted" } });
        return;
      }
      emit({ requestId, type: "error", error: normalizeAiError(error) });
    }
  }

  // 도구를 순차 실행하고 상태를 emit 한다. 취소(signal)면 상위로 던져 aborted 처리.
  private async executeTools(
    requestId: string,
    toolCalls: AiToolCall[],
    registry: ToolRegistry,
    controller: AbortController,
    emit: (event: AiChatEvent) => void,
  ): Promise<AiToolResult[]> {
    const results: AiToolResult[] = [];
    for (const call of toolCalls) {
      const label = toolLabel(call);
      emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "running", label } });
      const executor = registry.executors.get(call.name);
      if (!executor) {
        results.push({ toolCallId: call.id, content: `error: unknown tool ${call.name}`, isError: true });
        emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "error", label } });
        continue;
      }
      try {
        const content = await executor(safeParseArgs(call.argsJson), { signal: controller.signal });
        results.push({ toolCallId: call.id, content });
        emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "done", label } });
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }
        results.push({
          toolCallId: call.id,
          content: `error: ${error instanceof Error ? error.message : "tool failed"}`,
          isError: true,
        });
        emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "error", label } });
      }
    }
    return results;
  }

  // 설정에서 켜진 클라이언트 도구 registry(+ 검색키)를 만든다.
  private async resolveTools(): Promise<ToolRegistry> {
    // 도구는 항상 켜져 있다(사용자 설정 없음). Tavily 키가 있으면 검색을 Tavily로 업그레이드, 없으면 DuckDuckGo.
    const tavilyKey = await this.secretStore.load(searchKeyAccount("tavily"));
    return buildToolRegistry({
      webSearch: true,
      fetchUrl: true,
      searchBackend: tavilyKey ? "tavily" : "duckduckgo",
      searchKey: tavilyKey,
    });
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

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 도구 실행 상태에 보여줄 사람 친화적 라벨.
function toolLabel(call: AiToolCall): string {
  try {
    const args = JSON.parse(call.argsJson) as Record<string, unknown>;
    if (call.name === "web_search" && typeof args.query === "string") {
      return `🔍 웹 검색: ${args.query}`;
    }
    if (call.name === "fetch_url" && typeof args.url === "string") {
      return `🌐 URL 읽기: ${args.url}`;
    }
  } catch {
    // 무시하고 기본 라벨.
  }
  return `도구 실행: ${call.name}`;
}
