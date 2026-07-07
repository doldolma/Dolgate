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
  runExecutor: vi.fn(),
  inspectExecutor: vi.fn(),
}));
vi.mock("./ai/tools/registry", () => ({
  buildToolRegistry: () => ({
    defs: toolsMock.defs,
    executors: new Map([
      ["web_search", toolsMock.executor],
      ["run_in_terminal", toolsMock.runExecutor],
      ["inspect_command", toolsMock.inspectExecutor],
    ]),
  }),
}));

import { AiService, trimMessages } from "./ai-service";
import type { AiChatEvent, AiChatMessage } from "../shared/ai";

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

describe("AiService run_in_terminal approval gate", () => {
  const GATE_SETTINGS = { enabled: true, providerId: "openai-compat", model: "m" };

  beforeEach(() => {
    adapterMocks.chat.mockReset();
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

  it("audits a rejected command via the injected auditLog", async () => {
    const auditLog = vi.fn();
    const service = new AiService(makeSettings(GATE_SETTINGS) as never, makeSecretStore() as never, {
      auditLog,
    });
    await drive(service, "r6", "systemctl restart nginx", {
      sessionId: "s1",
      onApproval: (toolCallId) => service.resolveApproval({ requestId: "r6", toolCallId, approved: false }),
    });
    expect(auditLog).toHaveBeenCalledWith("warn", "audit", expect.stringContaining("거부"), expect.anything());
  });
});

describe("AiService inspect_command (read-only, hidden)", () => {
  const SETTINGS = { enabled: true, providerId: "openai-compat", model: "m" };

  beforeEach(() => {
    adapterMocks.chat.mockReset();
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
