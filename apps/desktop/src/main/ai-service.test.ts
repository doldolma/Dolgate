import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampAiTemperature, normalizeAiBaseUrl } from "@shared";

// 어댑터 모듈을 목으로 대체해 네트워크 없이 AiService 오케스트레이션만 검증한다.
const adapterMocks = vi.hoisted(() => ({
  chat: vi.fn(),
  testConnection: vi.fn(),
  // 기본(mockReset 직후)은 undefined 반환 → runChat 이 설정값/기본값으로 폴백.
  getModelContextTokens: vi.fn(),
  // 어댑터 생성자에 전달된 ProviderConfig 를 기록(베이스 URL 스코핑 등 config 해석 검증용).
  openaiCtor: vi.fn(),
  anthropicCtor: vi.fn(),
}));

vi.mock("./ai/provider-openai", () => ({
  OpenAiAdapter: class {
    id = "openai-compat" as const;
    chat = adapterMocks.chat;
    testConnection = adapterMocks.testConnection;
    constructor(config: unknown) {
      adapterMocks.openaiCtor(config);
    }
  },
}));
vi.mock("./ai/provider-anthropic", () => ({
  AnthropicAdapter: class {
    id = "anthropic" as const;
    chat = adapterMocks.chat;
    testConnection = adapterMocks.testConnection;
    getModelContextTokens = adapterMocks.getModelContextTokens;
    constructor(config: unknown) {
      adapterMocks.anthropicCtor(config);
    }
  },
}));

// codex 어댑터/앱서버/MCP 배관도 목으로 대체(electron·바이너리·소켓 의존 차단).
const codexMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  loginStart: vi.fn(),
  authStatus: vi.fn(),
  logout: vi.fn(),
  usage: vi.fn(),
  registerMcp: vi.fn(),
  disposeMcp: vi.fn(),
}));
vi.mock("./ai/provider-codex", () => ({
  CodexAdapter: class {
    id = "codex" as const;
    chat = adapterMocks.chat;
    testConnection = adapterMocks.testConnection;
    constructor(config: unknown, mcp?: unknown) {
      codexMocks.ctor(config, mcp);
    }
  },
}));
vi.mock("./ai/codex-app-server", () => ({
  getCodexAppServer: () => ({}),
  codexLoginStart: codexMocks.loginStart,
  codexAuthStatus: codexMocks.authStatus,
  codexLogout: codexMocks.logout,
  codexUsage: codexMocks.usage,
}));
vi.mock("./ai/codex-mcp-server", () => ({
  registerCodexMcpTools: codexMocks.registerMcp,
}));

// 도구 registry 도 목으로 대체(네트워크 없는 도구 실행). web_search executor 만 노출.
const toolsMock = vi.hoisted(() => ({
  defs: [] as unknown[],
  executor: vi.fn(),
  runExecutor: vi.fn(),
  inspectExecutor: vi.fn(),
  terminalOutputExecutor: vi.fn(),
}));
vi.mock("./ai/tools/registry", () => ({
  buildToolRegistry: () => ({
    defs: toolsMock.defs,
    executors: new Map([
      ["web_search", toolsMock.executor],
      ["run_in_terminal", toolsMock.runExecutor],
      ["inspect_command", toolsMock.inspectExecutor],
      ["read_terminal_output", toolsMock.terminalOutputExecutor],
    ]),
  }),
}));

import { AiService, trimMessages } from "./ai-service";
import type { AiChatEvent, AiChatMessage } from "../shared/ai";
import { mergeTextAttachments } from "../shared/ai";

function makeSecretStore() {
  const store = new Map<string, string>();
  return {
    save: vi.fn(async (account: string, secret: string) => {
      store.set(account, secret);
      return account;
    }),
    load: vi.fn(async (account: string) => store.get(account) ?? null),
    remove: vi.fn(async (account: string) => {
      store.delete(account);
    }),
    isEncryptionAvailable: () => true,
  };
}

function makeSettings(ai: unknown) {
  return { get: vi.fn(() => ({ ai })) };
}

function collectChat(service: AiService, requestId: string, request: unknown): Promise<AiChatEvent[]> {
  return new Promise((resolve) => {
    const events: AiChatEvent[] = [];
    service.startChat({ requestId, request: request as never }, (event) => {
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        resolve(events);
      }
    });
  });
}

beforeEach(() => {
  codexMocks.authStatus.mockReset();
  codexMocks.authStatus.mockResolvedValue({
    authenticated: true,
    authMode: "chatgpt",
    email: "dev@example.com",
    planType: "pro",
  });
});

describe("AiService key management", () => {
  beforeEach(() => {
    adapterMocks.chat.mockReset();
    adapterMocks.getModelContextTokens.mockReset();
    adapterMocks.testConnection.mockReset();
    codexMocks.ctor.mockReset();
    codexMocks.registerMcp.mockReset();
    codexMocks.disposeMcp.mockReset();
    codexMocks.usage.mockReset();
  });

  it("saves the api key under ai:apiKey:<provider> and reports status", async () => {
    const secretStore = makeSecretStore();
    const service = new AiService(makeSettings(undefined) as never, secretStore as never);
    await service.setApiKey("anthropic", "sk-ant");
    expect(secretStore.save).toHaveBeenCalledWith("ai:apiKey:anthropic", "sk-ant");
    expect(await service.apiKeyStatus("anthropic")).toEqual({ hasKey: true });
    expect(await service.apiKeyStatus("openai-compat")).toEqual({ hasKey: false });
  });

  it("rejects an empty api key", async () => {
    const service = new AiService(makeSettings(undefined) as never, makeSecretStore() as never);
    await expect(service.setApiKey("openai-compat", "   ")).rejects.toThrow();
  });

  it("clearApiKey removes the stored key", async () => {
    const secretStore = makeSecretStore();
    const service = new AiService(makeSettings(undefined) as never, secretStore as never);
    await service.setApiKey("openai-compat", "sk-x");
    await service.clearApiKey("openai-compat");
    expect(secretStore.remove).toHaveBeenCalledWith("ai:apiKey:openai-compat");
    expect(await service.apiKeyStatus("openai-compat")).toEqual({ hasKey: false });
  });
});

describe("AiService.startChat", () => {
  beforeEach(() => {
    adapterMocks.chat.mockReset();
    adapterMocks.getModelContextTokens.mockReset();
    adapterMocks.testConnection.mockReset();
    codexMocks.ctor.mockReset();
    codexMocks.registerMcp.mockReset();
    codexMocks.disposeMcp.mockReset();
    codexMocks.usage.mockReset();
  });

  it("emits delta then done on success", async () => {
    adapterMocks.chat.mockImplementation(async (_request, opts) => {
      opts.onDelta({ kind: "text", text: "hi" });
      return { text: "hi", finishReason: "stop" };
    });
    const secretStore = makeSecretStore();
    await secretStore.save("ai:apiKey:openai-compat", "k");
    const service = new AiService(
      makeSettings({ enabled: true, providerId: "openai-compat", model: "m" }) as never,
      secretStore as never,
    );
    const events = await collectChat(service, "r1", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(events.map((event) => event.type)).toEqual(["delta", "done"]);
  });

  it("codex chats without an api key/model, bridges tools via MCP instead of function calling", async () => {
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    codexMocks.registerMcp.mockResolvedValue({
      url: "http://127.0.0.1:9/mcp",
      token: "tok",
      dispose: codexMocks.disposeMcp,
    });
    // 도구가 있으면 요청 페이로드가 아니라 MCP 등록으로 흘러야 한다.
    toolsMock.defs = [{ name: "web_search" }];
    try {
      const service = new AiService(
        makeSettings({ enabled: true, providerId: "codex", model: "" }) as never,
        makeSecretStore() as never, // 키 저장 안 됨 — codex 는 키 불필요
      );
      const events = await collectChat(service, "r-codex", {
        model: "",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(events.at(-1)).toMatchObject({ type: "done" });
      // registry 의 defs 그대로 MCP 에 등록되고, 어댑터에 엔드포인트가 주입된다.
      expect(codexMocks.registerMcp).toHaveBeenCalledWith(
        expect.objectContaining({ defs: toolsMock.defs }),
      );
      expect(codexMocks.ctor).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "codex", model: "gpt-5.5" }),
        expect.objectContaining({ url: "http://127.0.0.1:9/mcp", token: "tok" }),
      );
      // 요청 페이로드에는 function-calling 도구가 실리지 않는다.
      expect(adapterMocks.chat.mock.calls[0][0].tools).toBeUndefined();
      // 채팅 종료 후 MCP 등록이 해제된다.
      expect(codexMocks.disposeMcp).toHaveBeenCalledTimes(1);
    } finally {
      toolsMock.defs = [];
    }
  });

  it("stops codex chats before SDK execution when the account is not authenticated", async () => {
    codexMocks.authStatus.mockResolvedValue({
      authenticated: false,
      authMode: null,
      email: null,
      planType: null,
    });
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    const service = new AiService(
      makeSettings({ enabled: true, providerId: "codex", model: "" }) as never,
      makeSecretStore() as never,
    );
    const events = await collectChat(service, "r-codex-auth", {
      model: "",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(events.at(-1)).toMatchObject({ type: "error", error: { reason: "auth" } });
    expect(adapterMocks.chat).not.toHaveBeenCalled();
    expect(codexMocks.registerMcp).not.toHaveBeenCalled();
  });

  it("normalizes stored non-Codex model ids before constructing the Codex adapter", async () => {
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    const service = new AiService(
      makeSettings({ enabled: true, providerId: "codex", model: "Qwen-AgentWorld-35B-A3B" }) as never,
      makeSecretStore() as never,
    );
    await collectChat(service, "r-codex-model", {
      model: "",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(codexMocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "codex", model: "gpt-5.5" }),
      undefined,
    );
  });

  it("codex MCP invoke routes through the shared tool executor (events + result)", async () => {
    let binding: { invoke: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }> } | null =
      null;
    codexMocks.registerMcp.mockImplementation(async (input) => {
      binding = input;
      return { url: "http://127.0.0.1:9/mcp", token: "tok", dispose: codexMocks.disposeMcp };
    });
    toolsMock.executor.mockResolvedValue("검색 결과 요약");
    toolsMock.defs = [{ name: "web_search" }];
    try {
      adapterMocks.chat.mockImplementation(async () => {
        expect(binding).not.toBeNull();
        const ok = await binding!.invoke("web_search", { query: "dolgate" });
        expect(ok).toEqual({ content: "검색 결과 요약", isError: undefined });
        return { text: "ok", finishReason: "stop" };
      });
      const service = new AiService(
        makeSettings({ enabled: true, providerId: "codex", model: "" }) as never,
        makeSecretStore() as never,
      );
      const events = await collectChat(service, "r-codex-invoke", {
        model: "",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(toolsMock.executor).toHaveBeenCalledWith(
        { query: "dolgate" },
        expect.objectContaining({ signal: expect.anything() }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool",
          tool: expect.objectContaining({ name: "web_search", status: "running" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool",
          tool: expect.objectContaining({ name: "web_search", status: "done" }),
        }),
      );
    } finally {
      toolsMock.defs = [];
      toolsMock.executor.mockReset();
    }
  });

  it("codex MCP run_in_terminal uses the shared approval gate", async () => {
    let binding: { invoke: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }> } | null =
      null;
    codexMocks.registerMcp.mockImplementation(async (input) => {
      binding = input;
      return { url: "http://127.0.0.1:9/mcp", token: "tok", dispose: codexMocks.disposeMcp };
    });
    toolsMock.defs = [{ name: "run_in_terminal" }];
    toolsMock.runExecutor.mockResolvedValue("typed into terminal");
    adapterMocks.chat.mockImplementation(async () => {
      expect(binding).not.toBeNull();
      const result = await binding!.invoke("run_in_terminal", {
        command: "rm -rf /tmp/dolgate-test",
        changes_state: true,
      });
      expect(result).toEqual({ content: "typed into terminal", isError: undefined });
      return { text: "ok", finishReason: "stop" };
    });

    try {
      const service = new AiService(
        makeSettings({ enabled: true, providerId: "codex", model: "" }) as never,
        makeSecretStore() as never,
      );
      const events = await new Promise<AiChatEvent[]>((resolve) => {
        const collected: AiChatEvent[] = [];
        service.startChat(
          {
            requestId: "r-codex-run",
            sessionId: "s1",
            request: { model: "", messages: [{ role: "user", content: "run" }] } as never,
          },
          (event) => {
            collected.push(event);
            if (event.type === "approval-required") {
              service.resolveApproval({
                requestId: "r-codex-run",
                toolCallId: event.approval.toolCallId,
                approved: true,
              });
            }
            if (event.type === "done" || event.type === "error") {
              resolve(collected);
            }
          },
        );
      });

      expect(events).toContainEqual(expect.objectContaining({ type: "approval-required" }));
      expect(toolsMock.runExecutor).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool",
          tool: expect.objectContaining({ name: "run_in_terminal", status: "running" }),
        }),
      );
      expect(events.at(-1)).toMatchObject({ type: "done" });
    } finally {
      toolsMock.defs = [];
      toolsMock.runExecutor.mockReset();
    }
  });

  it("delegates codex auth methods to the app-server helpers", async () => {
    codexMocks.loginStart.mockResolvedValue({ loginId: "L1", authUrl: "https://auth" });
    codexMocks.authStatus.mockResolvedValue({ authenticated: true });
    codexMocks.logout.mockResolvedValue(undefined);
    const service = new AiService(
      makeSettings({ enabled: true, providerId: "codex", model: "" }) as never,
      makeSecretStore() as never,
    );
    await expect(service.codexLoginStart()).resolves.toEqual({ loginId: "L1", authUrl: "https://auth" });
    await expect(service.codexAuthStatus()).resolves.toEqual({ authenticated: true });
    await service.codexLogout();
    expect(codexMocks.logout).toHaveBeenCalledTimes(1);
  });

  it("delegates codexUsage to the app-server helper", async () => {
    codexMocks.usage.mockResolvedValue({
      planType: "plus",
      primary: { usedPercent: 3, windowMinutes: 300, resetsAt: 1783450934 },
      secondary: null,
    });
    const service = new AiService(
      makeSettings({ enabled: true, providerId: "codex", model: "" }) as never,
      makeSecretStore() as never,
    );
    await expect(service.codexUsage()).resolves.toMatchObject({ planType: "plus" });
    expect(codexMocks.usage).toHaveBeenCalledTimes(1);
  });

  it("emits an error when the assistant is disabled", async () => {
    const service = new AiService(
      makeSettings({ enabled: false, providerId: "openai-compat", model: "m" }) as never,
      makeSecretStore() as never,
    );
    const events = await collectChat(service, "r2", { model: "m", messages: [] });
    expect(events[0]).toMatchObject({ type: "error", error: { reason: "disabled" } });
    expect(adapterMocks.chat).not.toHaveBeenCalled();
  });

  it("prefers the adapter-reported context window over the stored setting (anthropic auto)", async () => {
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    // 저장된 설정(3000)으로는 잘릴 히스토리가, 어댑터 조회값(60k)으로는 유지되어야 한다.
    adapterMocks.getModelContextTokens.mockResolvedValue(60_000);
    const secretStore = makeSecretStore();
    await secretStore.save("ai:apiKey:anthropic", "k");
    const service = new AiService(
      makeSettings({
        enabled: true,
        providerId: "anthropic",
        model: "claude-x",
        contextTokens: 3000,
      }) as never,
      secretStore as never,
    );
    const longHistory = "x".repeat(20_000); // ≈5k tokens — 3000 예산에선 탈락, 60k 예산에선 유지
    await collectChat(service, "r-auto", {
      model: "claude-x",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: longHistory },
        { role: "assistant", content: "a1" },
        { role: "user", content: "recent" },
      ],
    });

    expect(adapterMocks.getModelContextTokens).toHaveBeenCalledWith(
      "claude-x",
      expect.objectContaining({ signal: expect.anything() }),
    );
    const sent = adapterMocks.chat.mock.calls[0][0].messages as Array<{ content: string }>;
    expect(sent.some((message) => message.content === longHistory)).toBe(true);
  });

  it("does not leak the openai-compat baseUrl into anthropic requests", async () => {
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    const secretStore = makeSecretStore();
    await secretStore.save("ai:apiKey:anthropic", "k");
    // openai-compat 시절 저장된 잔존 baseUrl(예: Ollama) — anthropic 은 무시해야 한다.
    const service = new AiService(
      makeSettings({
        enabled: true,
        providerId: "anthropic",
        baseUrl: "http://localhost:11434/v1",
        model: "claude-x",
      }) as never,
      secretStore as never,
    );
    await collectChat(service, "r-base", {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(adapterMocks.anthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: undefined }),
    );

    // testConnection 도 같은 규칙(패널이 provider 무관하게 draft.baseUrl 을 보내는 경우 방어).
    adapterMocks.testConnection.mockResolvedValue({ ok: true, message: "ok" });
    await service.testConnection({
      providerId: "anthropic",
      baseUrl: "http://localhost:11434/v1",
      model: "claude-x",
    });
    expect(adapterMocks.anthropicCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: undefined }),
    );
  });

  it("keeps the configured baseUrl for openai-compat", async () => {
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    const secretStore = makeSecretStore();
    await secretStore.save("ai:apiKey:openai-compat", "k");
    const service = new AiService(
      makeSettings({
        enabled: true,
        providerId: "openai-compat",
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.1",
      }) as never,
      secretStore as never,
    );
    await collectChat(service, "r-base-oai", {
      model: "llama3.1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(adapterMocks.openaiCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://localhost:11434/v1" }),
    );
  });

  it("falls back to the stored context setting when the adapter lookup returns null", async () => {
    adapterMocks.chat.mockResolvedValue({ text: "ok", finishReason: "stop" });
    adapterMocks.getModelContextTokens.mockResolvedValue(null);
    const secretStore = makeSecretStore();
    await secretStore.save("ai:apiKey:anthropic", "k");
    const service = new AiService(
      makeSettings({
        enabled: true,
        providerId: "anthropic",
        model: "claude-x",
        contextTokens: 3000,
      }) as never,
      secretStore as never,
    );
    const longHistory = "x".repeat(20_000);
    await collectChat(service, "r-fallback", {
      model: "claude-x",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: longHistory },
        { role: "assistant", content: "a1" },
        { role: "user", content: "recent" },
      ],
    });

    const sent = adapterMocks.chat.mock.calls[0][0].messages as Array<{ content: string }>;
    expect(sent.some((message) => message.content === longHistory)).toBe(false);
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "recent" });
  });

  it("emits an aborted done when cancelled", async () => {
    adapterMocks.chat.mockImplementation(
      (_request, opts) =>
        new Promise((_resolve, reject) => {
          const onAbort = () =>
            reject(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }));
          // 취소가 adapter.chat 호출보다 먼저 일어나면 signal 이 이미 aborted 이므로 즉시 처리.
          if (opts.signal.aborted) {
            onAbort();
            return;
          }
          opts.signal.addEventListener("abort", onAbort);
        }),
    );
    const secretStore = makeSecretStore();
    await secretStore.save("ai:apiKey:openai-compat", "k");
    const service = new AiService(
      makeSettings({ enabled: true, providerId: "openai-compat", model: "m" }) as never,
      secretStore as never,
    );
    const done = collectChat(service, "r3", { model: "m", messages: [] });
    service.cancelChat("r3");
    const events = await done;
    expect(events.at(-1)).toMatchObject({ type: "done", result: { finishReason: "aborted" } });
  });
});

describe("AiService agent loop", () => {
  beforeEach(() => {
    adapterMocks.chat.mockReset();
    adapterMocks.getModelContextTokens.mockReset();
    toolsMock.defs = [];
    toolsMock.executor.mockReset();
    toolsMock.terminalOutputExecutor.mockReset();
  });

  const AGENT_SETTINGS = {
    enabled: true,
    providerId: "openai-compat",
    model: "m",
    tools: { webSearch: true, fetchUrl: false },
    search: { backend: "tavily" },
  };

  it("executes a tool call then finalizes with the model answer", async () => {
    toolsMock.defs = [{ name: "web_search", parameters: { type: "object", properties: {} } }];
    toolsMock.executor.mockResolvedValue("search results");
    adapterMocks.chat
      .mockResolvedValueOnce({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "web_search", argsJson: '{"query":"x"}' }],
      })
      .mockResolvedValueOnce({ text: "final answer", finishReason: "stop" });
    const service = new AiService(makeSettings(AGENT_SETTINGS) as never, makeSecretStore() as never);
    const events = await collectChat(service, "r1", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(toolsMock.executor).toHaveBeenCalledTimes(1);
    expect(adapterMocks.chat).toHaveBeenCalledTimes(2);
    const secondCallMessages = adapterMocks.chat.mock.calls[1][0].messages as Array<{ role: string }>;
    expect(secondCallMessages.some((message) => message.role === "tool")).toBe(true);
    expect(events.some((event) => event.type === "tool")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", result: { text: "final answer" } });
  });

  it("emits an error after exceeding the tool iteration cap", async () => {
    toolsMock.defs = [{ name: "web_search", parameters: { type: "object", properties: {} } }];
    toolsMock.executor.mockResolvedValue("r");
    adapterMocks.chat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c", name: "web_search", argsJson: "{}" }],
    });
    const service = new AiService(makeSettings(AGENT_SETTINGS) as never, makeSecretStore() as never);
    const events = await collectChat(service, "r2", { model: "m", messages: [] });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("labels read_terminal_output ranges clearly in tool events", async () => {
    toolsMock.defs = [{ name: "read_terminal_output", parameters: { type: "object", properties: {} } }];
    toolsMock.terminalOutputExecutor.mockResolvedValue("older output");
    adapterMocks.chat
      .mockResolvedValueOnce({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "scrollback-1",
            name: "read_terminal_output",
            argsJson: '{"beforeRecentLines":100,"lines":200}',
          },
        ],
      })
      .mockResolvedValueOnce({ text: "done", finishReason: "stop" });
    const service = new AiService(makeSettings(AGENT_SETTINGS) as never, makeSecretStore() as never);
    const events = await collectChat(service, "r-terminal", { model: "m", messages: [] });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        tool: expect.objectContaining({
          name: "read_terminal_output",
          label: "터미널 출력 읽기: 101~300줄 전",
        }),
      }),
    );
    expect(toolsMock.terminalOutputExecutor).toHaveBeenCalledTimes(1);
  });
});

describe("AiService run_in_terminal approval gate", () => {
  const GATE_SETTINGS = { enabled: true, providerId: "openai-compat", model: "m" };

  beforeEach(() => {
    adapterMocks.chat.mockReset();
    adapterMocks.getModelContextTokens.mockReset();
    toolsMock.defs = [{ name: "run_in_terminal", parameters: { type: "object", properties: {} } }];
    toolsMock.runExecutor.mockReset();
    toolsMock.runExecutor.mockResolvedValue("typed into terminal");
  });

  // 모델이 run_command 를 한 번 호출하고, 도구 결과를 받은 뒤 최종 답을 내는 흐름을 구성한다.
  function drive(
    service: AiService,
    requestId: string,
    command: string,
    opts: { sessionId?: string; changesState?: boolean; onApproval?: (toolCallId: string) => void } = {},
  ): Promise<AiChatEvent[]> {
    const argsJson = JSON.stringify(
      opts.changesState ? { command, changes_state: true } : { command },
    );
    adapterMocks.chat
      .mockResolvedValueOnce({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "tc1", name: "run_in_terminal", argsJson }],
      })
      .mockResolvedValueOnce({ text: "done", finishReason: "stop" });
    return new Promise((resolve) => {
      const events: AiChatEvent[] = [];
      service.startChat(
        { requestId, sessionId: opts.sessionId, request: { model: "m", messages: [] } as never },
        (event) => {
          events.push(event);
          if (event.type === "approval-required") {
            opts.onApproval?.(event.approval.toolCallId);
          }
          if (event.type === "done" || event.type === "error") {
            resolve(events);
          }
        },
      );
    });
  }

  it("auto-runs read-only commands without an approval prompt", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    const events = await drive(service, "r1", "ls -la", { sessionId: "s1" });
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(toolsMock.runExecutor).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("requires approval for mutating commands and runs them once approved", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    const events = await drive(service, "r2", "rm -rf /data", {
      sessionId: "s1",
      onApproval: (toolCallId) => service.resolveApproval({ requestId: "r2", toolCallId, approved: true }),
    });
    expect(events.some((event) => event.type === "approval-required")).toBe(true);
    expect(toolsMock.runExecutor).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("asks approval when the model marks it state-changing even if it looks read-only", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    const events = await drive(service, "rc", "touch /tmp/x", {
      changesState: true,
      onApproval: (toolCallId) => service.resolveApproval({ requestId: "rc", toolCallId, approved: true }),
    });
    expect(events.some((event) => event.type === "approval-required")).toBe(true);
    expect(toolsMock.runExecutor).toHaveBeenCalledTimes(1);
  });

  it("does not run the command when the user rejects", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    const events = await drive(service, "r3", "rm -rf /data", {
      sessionId: "s1",
      onApproval: (toolCallId) => service.resolveApproval({ requestId: "r3", toolCallId, approved: false }),
    });
    expect(toolsMock.runExecutor).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("skips approval for later mutating commands once the session is remembered", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    await drive(service, "r4a", "rm a", {
      sessionId: "sX",
      onApproval: (toolCallId) =>
        service.resolveApproval({ requestId: "r4a", toolCallId, approved: true, remember: true }),
    });
    const second = await drive(service, "r4b", "rm b", { sessionId: "sX" });
    expect(second.some((event) => event.type === "approval-required")).toBe(false);
    expect(toolsMock.runExecutor).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending approval when the chat is cancelled", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    const events = await drive(service, "r5", "rm -rf /data", {
      sessionId: "s1",
      onApproval: () => service.cancelChat("r5"),
    });
    expect(events.at(-1)).toMatchObject({ type: "done", result: { finishReason: "aborted" } });
    expect(toolsMock.runExecutor).not.toHaveBeenCalled();
  });

  it("does not write rejected commands to the global activity log", async () => {
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never);
    const events = await drive(service, "r6", "systemctl restart nginx", {
      sessionId: "s1",
      onApproval: (toolCallId) => service.resolveApproval({ requestId: "r6", toolCallId, approved: false }),
    });
    expect(events.some((event) => event.type === "approval-required")).toBe(true);
    expect(toolsMock.runExecutor).not.toHaveBeenCalled();
  });
});

describe("AiService inspect_command (read-only, hidden)", () => {
  const SETTINGS = { enabled: true, providerId: "openai-compat", model: "m" };

  beforeEach(() => {
    adapterMocks.chat.mockReset();
    adapterMocks.getModelContextTokens.mockReset();
    toolsMock.defs = [{ name: "inspect_command", parameters: { type: "object", properties: {} } }];
    toolsMock.inspectExecutor.mockReset();
    toolsMock.inspectExecutor.mockResolvedValue("$ df -h\nexit code: 0");
  });

  function driveInspect(
    service: AiService,
    requestId: string,
    command: string,
  ): Promise<AiChatEvent[]> {
    adapterMocks.chat
      .mockResolvedValueOnce({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "ic1", name: "inspect_command", argsJson: JSON.stringify({ command }) }],
      })
      .mockResolvedValueOnce({ text: "done", finishReason: "stop" });
    return new Promise((resolve) => {
      const events: AiChatEvent[] = [];
      service.startChat(
        { requestId, sessionId: "s1", request: { model: "m", messages: [] } as never },
        (event) => {
          events.push(event);
          if (event.type === "done" || event.type === "error") {
            resolve(events);
          }
        },
      );
    });
  }

  it("runs a read-only inspect command with no approval prompt", async () => {
    const service = new AiService(makeSettings(SETTINGS) as never, makeSecretStore() as never);
    const events = await driveInspect(service, "i1", "df -h");
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(toolsMock.inspectExecutor).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("refuses a state-changing command without prompting or executing (no hidden mutation)", async () => {
    const service = new AiService(makeSettings(SETTINGS) as never, makeSecretStore() as never);
    const events = await driveInspect(service, "i2", "rm -rf /data");
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(toolsMock.inspectExecutor).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("refuses streaming/interactive commands (would hang the channel) and points to run_in_terminal", async () => {
    const service = new AiService(makeSettings(SETTINGS) as never, makeSecretStore() as never);
    const events = await driveInspect(service, "i4", "docker logs -f plex");
    expect(events.some((event) => event.type === "approval-required")).toBe(false);
    expect(toolsMock.inspectExecutor).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("runs a read-only pipeline/loop (compound command) without refusing", async () => {
    const service = new AiService(makeSettings(SETTINGS) as never, makeSecretStore() as never);
    const events = await driveInspect(
      service,
      "i3",
      "for d in /sys/block/sd*; do cat $d/queue/rotational 2>/dev/null; done",
    );
    expect(toolsMock.inspectExecutor).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("trimMessages (context window budgeting)", () => {
  const sys: AiChatMessage = { role: "system", content: "system" };

  it("keeps system + the current turn and drops oldest history to fit the budget", () => {
    const messages: AiChatMessage[] = [
      sys,
      { role: "user", content: "x".repeat(4000) },
      { role: "assistant", content: "y".repeat(4000) },
      { role: "user", content: "recent question" },
    ];
    const trimmed = trimMessages(messages, 50);
    expect(trimmed[0]).toEqual(sys);
    expect(trimmed.at(-1)).toEqual({ role: "user", content: "recent question" });
    expect(trimmed.length).toBeLessThan(messages.length);
    expect(trimmed.some((m) => m.content.startsWith("x"))).toBe(false);
  });

  it("never splits the current turn's tool_call / tool_result pairs", () => {
    const messages: AiChatMessage[] = [
      sys,
      { role: "user", content: "z".repeat(8000) }, // 오래된 대화
      { role: "user", content: "do it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_in_terminal", argsJson: "{}" }] },
      { role: "tool", content: "", toolResults: [{ toolCallId: "c1", content: "output" }] },
    ];
    const trimmed = trimMessages(messages, 30);
    const roles = trimmed.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(trimmed.some((m) => m.content.startsWith("z"))).toBe(false);
    expect(trimmed.find((m) => m.content === "do it")).toBeTruthy();
  });

  it("keeps recent history when the budget is generous", () => {
    const messages: AiChatMessage[] = [
      sys,
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    expect(trimMessages(messages, 100000)).toEqual(messages);
  });

  it("counts image attachments toward history cost so image turns drop earlier", () => {
    const imageTurn: AiChatMessage = {
      role: "user",
      content: "짧은 질문",
      attachments: [{ kind: "image", mediaType: "image/png", dataBase64: "aGk=" }],
    };
    const textTwin: AiChatMessage = { role: "user", content: "짧은 질문" };
    const tail: AiChatMessage = { role: "user", content: "recent" };
    // 텍스트만 있으면 유지되는 예산에서, 같은 내용 + 이미지(≈1600 tokens)는 잘려야 한다.
    const budget = 200;
    expect(trimMessages([sys, textTwin, tail], budget)).toHaveLength(3);
    const trimmed = trimMessages([sys, imageTurn, tail], budget);
    expect(trimmed.map((m) => m.role)).toEqual(["system", "user"]);
    expect(trimmed.at(-1)).toEqual(tail);
  });

  it("counts text attachments toward history cost via mergeTextAttachments", () => {
    const bigTextAttachment: AiChatMessage = {
      role: "user",
      content: "질문",
      attachments: [{ kind: "text", name: "big.log", text: "x".repeat(4000) }],
    };
    const tail: AiChatMessage = { role: "user", content: "recent" };
    const trimmed = trimMessages([sys, bigTextAttachment, tail], 100);
    expect(trimmed.map((m) => m.role)).toEqual(["system", "user"]);
    expect(trimmed.at(-1)).toEqual(tail);
  });
});

describe("mergeTextAttachments", () => {
  it("returns content unchanged without text attachments (images ignored)", () => {
    expect(mergeTextAttachments("hello", undefined)).toBe("hello");
    expect(
      mergeTextAttachments("hello", [{ kind: "image", mediaType: "image/png", dataBase64: "aGk=" }]),
    ).toBe("hello");
  });

  it("appends text attachments as labeled fenced blocks", () => {
    const merged = mergeTextAttachments("질문", [
      { kind: "text", name: "a.log", text: "l1" },
      { kind: "text", name: "b.conf", text: "l2" },
    ]);
    expect(merged).toBe("질문\n\n[첨부 파일: a.log]\n```\nl1\n```\n\n[첨부 파일: b.conf]\n```\nl2\n```");
  });

  it("omits the leading separator when content is empty", () => {
    const merged = mergeTextAttachments("", [{ kind: "text", name: "a.log", text: "l1" }]);
    expect(merged).toBe("[첨부 파일: a.log]\n```\nl1\n```");
  });
});

describe("ai settings helpers", () => {
  it("clampAiTemperature clamps to 0..2 without rounding", () => {
    expect(clampAiTemperature(3)).toBe(2);
    expect(clampAiTemperature(-1)).toBe(0);
    expect(clampAiTemperature(0.7)).toBeCloseTo(0.7);
    expect(clampAiTemperature(Number.NaN)).toBe(0);
  });

  it("normalizeAiBaseUrl trims trailing slash and rejects non-http", () => {
    expect(normalizeAiBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(normalizeAiBaseUrl("ftp://x")).toBeUndefined();
    expect(normalizeAiBaseUrl("   ")).toBeUndefined();
    expect(normalizeAiBaseUrl(undefined)).toBeUndefined();
  });

  it("normalizeAiBaseUrl collapses the default host to undefined (unset semantics)", () => {
    // 과거 기본값('https://api.openai.com/v1')으로 저장된 설정을 미설정으로 마이그레이션한다.
    expect(normalizeAiBaseUrl("https://api.openai.com/v1")).toBeUndefined();
    expect(normalizeAiBaseUrl("https://api.openai.com/v1/")).toBeUndefined();
  });
});
