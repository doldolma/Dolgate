import type { SettingsRepository } from "./database";
import type { SecretStore } from "./secret-store";
import type {
  AiApiKeyStatus,
  AiApprovalResponse,
  AiChatEvent,
  AiChatMessage,
  AiChatRequest,
  AiChatStartInput,
  AiTerminalOutputResponse,
  AiProviderId,
  AiSearchBackend,
  AiToolCall,
  AiToolResult,
  AiTestConnectionInput,
  AiTestResult,
  CodexAuthStatus,
  CodexLoginStart,
  CodexUsage,
} from "../shared/ai";
import { mergeTextAttachments } from "../shared/ai";
import type { ProviderAdapter, ProviderConfig } from "./ai/provider";
import { buildToolRegistry, type ToolRegistry } from "./ai/tools/registry";
import { isLongRunningOrInteractive, looksDestructive } from "./ai/tools/command-classify";
import { RUN_IN_TERMINAL_TOOL, type TerminalRunResult } from "./ai/tools/run-command";
import { INSPECT_COMMAND_TOOL, type HostCommandResult } from "./ai/tools/inspect-command";
import {
  READ_TERMINAL_OUTPUT_TOOL,
  normalizeTerminalOutputReadArgs,
  rangeLabel as terminalOutputRangeLabel,
  type TerminalOutputReadInput,
} from "./ai/tools/read-terminal-output";
import { AnthropicAdapter } from "./ai/provider-anthropic";
import { CodexAdapter } from "./ai/provider-codex";
import {
  codexAuthStatus,
  codexLoginStart,
  codexLogout,
  codexUsage,
  getCodexAppServer,
} from "./ai/codex-app-server";
import { registerCodexMcpTools, type CodexMcpRegistration } from "./ai/codex-mcp-server";
import { randomUUID } from "node:crypto";
import { OpenAiAdapter } from "./ai/provider-openai";
import { AiRequestError, normalizeAiError } from "./ai/provider-errors";

// AiService 에 주입하는 host 도구 능력(run_command). 모두 옵셔널 — 없으면 run_command 미노출.
// 구현은 ai/host-exec-helpers.ts(coreManager 기반)가 제공한다.
export interface AiToolExecutorHelpers {
  // run_in_terminal: 사용자의 활성 터미널에 명령을 입력해 실행하고, 캡처한 출력을 돌려준다.
  runInTerminal?: (sessionId: string, command: string) => Promise<TerminalRunResult>;
  canRunInTerminal?: (sessionId: string) => boolean;
  // inspect_command: 숨은 exec 채널로 읽기전용 조회 → stdout/stderr/exit 반환(AI가 분석).
  execCapture?: (sessionId: string, command: string) => Promise<HostCommandResult>;
  canExecCapture?: (sessionId: string) => boolean;
}

export interface AiClientToolExecutorHelpers {
  readTerminalOutput?: (
    input: TerminalOutputReadInput,
    signal: AbortSignal,
  ) => Promise<AiTerminalOutputResponse>;
}

const API_KEY_ACCOUNT_PREFIX = "ai:apiKey:";
const SEARCH_KEY_ACCOUNT_PREFIX = "ai:searchKey:";
const TEST_CONNECTION_TIMEOUT_MS = 15_000;
// 도구 반복 상한 — 진짜 런어웨이(무한 호출→토큰/비용 폭주)만 막는 넉넉한 안전장치.
// 도구 사용이 패널에 보이고 정지 버튼으로 중단 가능하므로 높게 둔다.
const MAX_TOOL_ITERATIONS = 50;
// maxOutputTokens 미설정 시 컨텍스트 예산에서 예약할 출력 토큰(Anthropic 기본과 맞춤).
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4096;
// 토큰 추정 오차·프롬프트 오버헤드 대비 여유분.
const CONTEXT_SAFETY_MARGIN_TOKENS = 1024;

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
  // toolCallId → 승인 대기 resolver. run_command 변경 명령이 승인/거부될 때까지 루프를 멈춘다.
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (approved: boolean) => void; requestId: string; sessionId?: string }
  >();
  // "이 세션 자동 승인"을 켠 sessionId 집합(메모리 전용 — 재접속/앱 재시작 시 리셋).
  private readonly autoApproveSessions = new Set<string>();

  constructor(
    private readonly settings: SettingsRepository,
    private readonly secretStore: SecretStore,
    private readonly toolHelpers?: AiToolExecutorHelpers,
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
      // baseUrl 은 openai-compat 전용 계약(AiSettings.baseUrl 주석). anthropic 에 넘기면
      // openai-compat 시절의 잔존값(예: Ollama 주소)이 Claude 요청을 엉뚱한 호스트로 보낸다.
      baseUrl: input.providerId === "openai-compat" ? input.baseUrl : undefined,
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
  startChat(
    input: AiChatStartInput,
    emit: (event: AiChatEvent) => void,
    clientTools?: AiClientToolExecutorHelpers,
  ): void {
    const { requestId, sessionId, request } = input;
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
    void this.runChat(requestId, sessionId, request, controller, emit, clientTools).finally(() => {
      this.activeChats.delete(requestId);
    });
  }

  cancelChat(requestId: string): void {
    this.activeChats.get(requestId)?.abort();
  }

  private async runChat(
    requestId: string,
    sessionId: string | undefined,
    request: AiChatRequest,
    controller: AbortController,
    emit: (event: AiChatEvent) => void,
    clientTools?: AiClientToolExecutorHelpers,
  ): Promise<void> {
    // codex 채팅 동안만 유효한 MCP 도구 등록(1회용 토큰) — finally 에서 해제.
    let codexMcp: CodexMcpRegistration | undefined;
    try {
      const config = await this.resolveChatConfig(request.model);
      const registry = await this.resolveTools(sessionId, clientTools);
      // codex 는 커스텀 function calling 이 없어 도구를 MCP 로 받는다. 같은 registry
      // (세션 바인딩·승인 게이트·redaction 포함)를 localhost MCP 서버에 등록하고,
      // 요청 페이로드에는 tools 를 싣지 않는다. 실행 경로는 executeToolCall 로 동일.
      if (config.providerId === "codex" && registry.defs.length > 0) {
        codexMcp = await registerCodexMcpTools({
          defs: registry.defs,
          invoke: async (name, args) => {
            const call: AiToolCall = { id: randomUUID(), name, argsJson: JSON.stringify(args ?? {}) };
            const result = await this.executeToolCall(requestId, sessionId, call, registry, controller, emit);
            return { content: result.content, isError: result.isError };
          },
        });
      }
      const adapter = this.buildAdapter(config, codexMcp);
      const tools =
        config.providerId === "codex" ? undefined : registry.defs.length ? registry.defs : undefined;

      // 컨텍스트 예산: 프로바이더가 모델의 컨텍스트 창을 알려주면 그걸 우선(설정 불필요 —
      // Anthropic 은 Models API 로 조회), 아니면 설정값(openai-compat: 서버에 로드된 창은
      // 클라이언트가 알 수 없어 사용자 입력) → 기본값. 여기서 출력 예약분과 여유를 뺀다.
      const ai = this.settings.get().ai;
      const autoContextTokens =
        (await adapter.getModelContextTokens?.(request.model || config.model, {
          signal: controller.signal,
        })) ?? null;
      const contextTokens = autoContextTokens ?? ai?.contextTokens ?? 128_000;
      const outputReserve = request.maxTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
      const inputBudget = Math.max(2_000, contextTokens - outputReserve - CONTEXT_SAFETY_MARGIN_TOKENS);

      // 에이전트 루프: 모델이 도구를 부르면 실행 결과를 붙여 다시 물어본다(상한까지).
      let messages: AiChatMessage[] = [...request.messages];
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const result = await adapter.chat(
          { ...request, messages: trimMessages(messages, inputBudget), tools },
          { signal: controller.signal, onDelta: (delta) => emit({ requestId, type: "delta", delta }) },
        );
        if (result.finishReason !== "tool_calls" || !result.toolCalls?.length) {
          emit({ requestId, type: "done", result });
          return;
        }
        const toolResults = await this.executeTools(
          requestId,
          sessionId,
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
        error: {
          reason: "server",
          message:
            "도구를 너무 여러 번 연속 호출해 중단했어요(무한 반복 방지 안전장치). 질문을 더 구체적으로 다시 시도해 주세요.",
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // 사용자 취소(cancelChat) 또는 타임아웃 → 에러가 아니라 깨끗한 aborted done.
        emit({ requestId, type: "done", result: { text: "", finishReason: "aborted" } });
        return;
      }
      emit({ requestId, type: "error", error: normalizeAiError(error) });
    } finally {
      codexMcp?.dispose();
    }
  }

  // 도구를 순차 실행하고 상태를 emit 한다. 취소(signal)면 상위로 던져 aborted 처리.
  private async executeTools(
    requestId: string,
    sessionId: string | undefined,
    toolCalls: AiToolCall[],
    registry: ToolRegistry,
    controller: AbortController,
    emit: (event: AiChatEvent) => void,
  ): Promise<AiToolResult[]> {
    const results: AiToolResult[] = [];
    for (const call of toolCalls) {
      results.push(await this.executeToolCall(requestId, sessionId, call, registry, controller, emit));
    }
    return results;
  }

  // 단일 도구 호출 실행 — 에이전트 루프와 codex MCP 브리지가 공유한다.
  // 승인 게이트(run_in_terminal)·inspect 안전망·tool 이벤트·에러 포장이 두 경로에서 동일하게 적용된다.
  private async executeToolCall(
    requestId: string,
    sessionId: string | undefined,
    call: AiToolCall,
    registry: ToolRegistry,
    controller: AbortController,
    emit: (event: AiChatEvent) => void,
  ): Promise<AiToolResult> {
    const label = toolLabel(call);
    const executor = registry.executors.get(call.name);
    if (!executor) {
      emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "error", label } });
      return { toolCallId: call.id, content: `error: unknown tool ${call.name}`, isError: true };
    }
    // run_in_terminal: 변경 명령은 사용자 승인 전까지 실행하지 않는다(읽기전용/세션 자동승인은 통과).
    if (call.name === RUN_IN_TERMINAL_TOOL.name) {
      const gate = await this.gateRunCommand(call, requestId, sessionId, emit, controller.signal);
      if (gate === "rejected") {
        emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "error", label } });
        return { toolCallId: call.id, content: "사용자가 명령 실행을 거부했습니다.", isError: true };
      }
    }
    // inspect_command: 파괴적 명령(숨은 변경 금지) + 스트리밍/대화형(채널 물림)은 거부하고 run_in_terminal 로 유도.
    if (call.name === INSPECT_COMMAND_TOOL.name) {
      const cmd = commandArg(call);
      if (cmd && (looksDestructive(cmd) || isLongRunningOrInteractive(cmd))) {
        emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "error", label } });
        return {
          toolCallId: call.id,
          content:
            "변경·스트리밍·대화형 명령은 inspect_command 로 실행할 수 없습니다. 사용자가 볼 수 있도록 run_in_terminal 을 사용하세요.",
          isError: true,
        };
      }
    }
    emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "running", label } });
    try {
      const content = await executor(safeParseArgs(call.argsJson), { signal: controller.signal });
      emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "done", label } });
      return { toolCallId: call.id, content };
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      emit({ requestId, type: "tool", tool: { id: call.id, name: call.name, status: "error", label } });
      return {
        toolCallId: call.id,
        content: `error: ${error instanceof Error ? error.message : "tool failed"}`,
        isError: true,
      };
    }
  }

  // run_command 변경 게이트. 읽기전용/세션 자동승인이면 즉시 통과, 아니면 승인 이벤트를 내고 응답을 기다린다.
  // 취소(signal abort) 시 승인 대기는 reject 되어 상위 루프가 aborted 로 종료된다.
  private async gateRunCommand(
    call: AiToolCall,
    requestId: string,
    sessionId: string | undefined,
    emit: (event: AiChatEvent) => void,
    signal: AbortSignal,
  ): Promise<"auto" | "approved" | "rejected"> {
    const args = safeParseArgs(call.argsJson);
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) {
      return "auto"; // executor 가 빈 명령 에러를 반환하게 둔다.
    }
    // 승인 필요 판정 = 모델이 스스로 "상태 변경"이라 표시(changes_state) OR 정규식 안전망(looksDestructive).
    // 둘 중 하나만 걸려도 승인. 모델 판단을 우선하되, 모델이 놓친 명백한 파괴 명령은 안전망이 잡는다.
    const modelSaysWrite = args.changes_state === true;
    if (!modelSaysWrite && !looksDestructive(command)) {
      return "auto"; // 읽기·조회성(파이프 포함)은 승인 없이 실행.
    }
    if (sessionId && this.autoApproveSessions.has(sessionId)) {
      return "auto";
    }
    // 승인 대기 resolver 를 먼저 등록한 뒤 이벤트를 낸다(응답이 즉시 와도 놓치지 않도록).
    const approvalPromise = this.waitForApproval(call.id, requestId, sessionId, signal);
    emit({
      requestId,
      type: "approval-required",
      approval: { toolCallId: call.id, command, reason: "변경 가능성이 있는 명령" },
    });
    const approved = await approvalPromise;
    if (approved) {
      return "approved";
    }
    return "rejected";
  }

  private waitForApproval(
    toolCallId: string,
    requestId: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("AI approval aborted"));
        return;
      }
      const onAbort = () => {
        this.pendingApprovals.delete(toolCallId);
        reject(new Error("AI approval aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(toolCallId, {
        requestId,
        sessionId,
        resolve: (approved) => {
          signal.removeEventListener("abort", onAbort);
          resolve(approved);
        },
      });
    });
  }

  // 렌더러의 승인/거부 응답을 대기 중인 Promise 에 연결한다. remember 면 세션 자동승인에 추가.
  resolveApproval(input: AiApprovalResponse): void {
    const pending = this.pendingApprovals.get(input.toolCallId);
    if (!pending) {
      return;
    }
    this.pendingApprovals.delete(input.toolCallId);
    if (input.approved && input.remember && pending.sessionId) {
      this.autoApproveSessions.add(pending.sessionId);
    }
    pending.resolve(input.approved);
  }

  // 클라이언트 도구 registry 를 만든다. web/검색은 항상 켜짐. run_in_terminal 은 연결 세션이면,
  // inspect_command 는 보조 exec 가능한 세션이면 노출(각각 sessionId 바인딩). Tavily 키 있으면 검색 업그레이드.
  private async resolveTools(
    sessionId: string | undefined,
    clientTools?: AiClientToolExecutorHelpers,
  ): Promise<ToolRegistry> {
    const tavilyKey = await this.secretStore.load(searchKeyAccount("tavily"));
    const helpers = this.toolHelpers;
    const canTerminal = Boolean(
      sessionId && helpers?.runInTerminal && (helpers.canRunInTerminal?.(sessionId) ?? true),
    );
    const canInspect = Boolean(
      sessionId && helpers?.execCapture && (helpers.canExecCapture?.(sessionId) ?? true),
    );
    return buildToolRegistry({
      webSearch: true,
      fetchUrl: true,
      searchBackend: tavilyKey ? "tavily" : "duckduckgo",
      searchKey: tavilyKey,
      runInTerminal:
        canTerminal && sessionId ? (command) => helpers!.runInTerminal!(sessionId, command) : undefined,
      execCapture:
        canInspect && sessionId ? (command) => helpers!.execCapture!(sessionId, command) : undefined,
      readTerminalOutput: clientTools?.readTerminalOutput,
    });
  }

  private async resolveChatConfig(requestModel?: string): Promise<ProviderConfig> {
    const ai = this.settings.get().ai;
    if (!ai || !ai.enabled) {
      throw new AiRequestError("disabled", "AI 어시스턴트가 비활성화되어 있습니다.");
    }
    const apiKey = (await this.secretStore.load(apiKeyAccount(ai.providerId))) ?? "";
    // openai-compat 로컬 서버는 키가 없을 수 있으나, anthropic 은 키 필수.
    // codex 는 API 키 대신 CODEX_HOME 로그인 세션을 쓴다(키 불필요).
    if (!apiKey && ai.providerId === "anthropic") {
      throw new AiRequestError("auth", "API 키가 설정되지 않았습니다.");
    }
    const model = requestModel || ai.model;
    // codex 는 모델 미지정 시 codex 기본 모델을 쓰므로 빈 값을 허용한다.
    if (!model && ai.providerId !== "codex") {
      throw new AiRequestError("model-not-found", "사용할 모델이 설정되지 않았습니다.");
    }
    return {
      providerId: ai.providerId,
      // openai-compat 전용 필드 — anthropic 은 항상 기본 호스트(잔존값 누수 방지, testConnection 과 동일 규칙).
      baseUrl: ai.providerId === "openai-compat" ? ai.baseUrl : undefined,
      model,
      apiKey,
      temperature: ai.temperature,
    };
  }

  private buildAdapter(config: ProviderConfig, codexMcp?: CodexMcpRegistration): ProviderAdapter {
    switch (config.providerId) {
      case "anthropic":
        return new AnthropicAdapter(config);
      case "codex":
        return new CodexAdapter(config, codexMcp);
      case "openai-compat":
      default:
        return new OpenAiAdapter(config);
    }
  }

  // Codex(ChatGPT 계정) 인증 — app-server 위임. 렌더러가 authUrl 을 브라우저로 열고 상태를 폴링한다.
  async codexLoginStart(): Promise<CodexLoginStart> {
    return codexLoginStart(getCodexAppServer());
  }

  async codexAuthStatus(): Promise<CodexAuthStatus> {
    return codexAuthStatus(getCodexAppServer());
  }

  async codexUsage(): Promise<CodexUsage> {
    return codexUsage(getCodexAppServer());
  }

  async codexLogout(): Promise<void> {
    await codexLogout(getCodexAppServer());
  }
}

// 이미지 첨부 1장당 고정 비용 — 1568px 다운스케일 후 Anthropic (w*h)/750 근사 상한.
const IMAGE_ATTACHMENT_ESTIMATED_TOKENS = 1600;

// 대략적 토큰 추정(정밀 토크나이저 없이 문자수/4 + 메시지 오버헤드).
function estimateMessageTokens(message: AiChatMessage): number {
  let chars = mergeTextAttachments(message.content, message.attachments).length;
  let imageTokens = 0;
  if (message.attachments) {
    for (const attachment of message.attachments) {
      if (attachment.kind === "image") {
        imageTokens += IMAGE_ATTACHMENT_ESTIMATED_TOKENS;
      }
    }
  }
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      chars += call.name.length + call.argsJson.length;
    }
  }
  if (message.toolResults) {
    for (const result of message.toolResults) {
      chars += result.content.length;
    }
  }
  return Math.ceil(chars / 4) + 8 + imageTokens;
}

// 입력 메시지를 토큰 예산에 맞게 자른다. 시스템 메시지와 현재 턴(마지막 user 이후 — 도구 호출/결과
// 쌍 포함)은 항상 유지하고, 그 앞 과거 대화만 최근 것부터 예산 안에서 유지한다(도구 쌍 안 깨지게).
export function trimMessages(messages: AiChatMessage[], budgetTokens: number): AiChatMessage[] {
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd].role === "system") {
    sysEnd += 1;
  }
  const system = messages.slice(0, sysEnd);
  const rest = messages.slice(sysEnd);
  let lastUser = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const tailStart = lastUser >= 0 ? lastUser : 0;
  const head = rest.slice(0, tailStart); // 과거 대화(평문 — 도구 쌍 없음)
  const tail = rest.slice(tailStart); // 현재 턴(도구 쌍 포함) — 항상 유지
  const fixedTokens =
    system.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
    tail.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  let remaining = budgetTokens - fixedTokens;
  const keptHead: AiChatMessage[] = [];
  for (let i = head.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessageTokens(head[i]);
    if (remaining - cost < 0) {
      break;
    }
    remaining -= cost;
    keptHead.unshift(head[i]);
  }
  return [...system, ...keptHead, ...tail];
}

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 명령 실행 도구 호출에서 command 인자를 안전하게 뽑는다(trim).
function commandArg(call: AiToolCall): string {
  const args = safeParseArgs(call.argsJson);
  return typeof args.command === "string" ? args.command.trim() : "";
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
    if (call.name === "run_in_terminal" && typeof args.command === "string") {
      return `⚡ 실행: ${args.command}`;
    }
    if (call.name === "inspect_command" && typeof args.command === "string") {
      return `🔎 조회: ${args.command}`;
    }
    if (call.name === READ_TERMINAL_OUTPUT_TOOL.name) {
      return `터미널 출력 읽기: ${terminalOutputRangeLabel(
        normalizeTerminalOutputReadArgs(args),
      )}`;
    }
  } catch {
    // 무시하고 기본 라벨.
  }
  return `도구 실행: ${call.name}`;
}
