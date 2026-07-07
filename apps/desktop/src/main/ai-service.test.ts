import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampAiTemperature, normalizeAiBaseUrl } from "@shared";

// 어댑터 모듈을 목으로 대체해 네트워크 없이 AiService 오케스트레이션만 검증한다.
const adapterMocks = vi.hoisted(() => ({
  chat: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("./ai/provider-openai", () => ({
  OpenAiAdapter: class {
    id = "openai-compat" as const;
    chat = adapterMocks.chat;
    testConnection = adapterMocks.testConnection;
  },
}));
vi.mock("./ai/provider-anthropic", () => ({
  AnthropicAdapter: class {
    id = "anthropic" as const;
    chat = adapterMocks.chat;
    testConnection = adapterMocks.testConnection;
  },
}));

// 도구 registry 도 목으로 대체(네트워크 없는 도구 실행). web_search executor 만 노출.
const toolsMock = vi.hoisted(() => ({
  defs: [] as unknown[],
  executor: vi.fn(),
}));
vi.mock("./ai/tools/registry", () => ({
  buildToolRegistry: () => ({
    defs: toolsMock.defs,
    executors: new Map([["web_search", toolsMock.executor]]),
  }),
}));

import { AiService } from "./ai-service";
import type { AiChatEvent } from "../shared/ai";

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

describe("AiService key management", () => {
  beforeEach(() => {
    adapterMocks.chat.mockReset();
    adapterMocks.testConnection.mockReset();
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
    adapterMocks.testConnection.mockReset();
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

  it("emits an error when the assistant is disabled", async () => {
    const service = new AiService(
      makeSettings({ enabled: false, providerId: "openai-compat", model: "m" }) as never,
      makeSecretStore() as never,
    );
    const events = await collectChat(service, "r2", { model: "m", messages: [] });
    expect(events[0]).toMatchObject({ type: "error", error: { reason: "disabled" } });
    expect(adapterMocks.chat).not.toHaveBeenCalled();
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
    toolsMock.defs = [];
    toolsMock.executor.mockReset();
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
});

describe("ai settings helpers", () => {
  it("clampAiTemperature clamps to 0..2 without rounding", () => {
    expect(clampAiTemperature(3)).toBe(2);
    expect(clampAiTemperature(-1)).toBe(0);
    expect(clampAiTemperature(0.7)).toBeCloseTo(0.7);
    expect(clampAiTemperature(Number.NaN)).toBe(0);
  });

  it("normalizeAiBaseUrl trims trailing slash and rejects non-http", () => {
    expect(normalizeAiBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeAiBaseUrl("ftp://x")).toBeUndefined();
    expect(normalizeAiBaseUrl("   ")).toBeUndefined();
    expect(normalizeAiBaseUrl(undefined)).toBeUndefined();
  });
});
