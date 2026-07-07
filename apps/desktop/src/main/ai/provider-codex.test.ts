import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  startThread: vi.fn(),
  runStreamed: vi.fn(),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: unknown) {
      sdkMocks.ctor(options);
    }
    startThread(options: unknown) {
      sdkMocks.startThread(options);
      return { runStreamed: sdkMocks.runStreamed };
    }
  },
}));

const appServerMocks = vi.hoisted(() => ({
  codexAuthStatus: vi.fn(),
}));

// electron 의존(app.getPath 등)을 피하기 위해 배관 모듈 전체를 목으로 대체한다.
vi.mock("./codex-app-server", () => ({
  resolveCodexBin: () => "/mock/bin/codex",
  resolveCodexHome: () => "/mock/codex-home",
  codexEnv: () => ({ CODEX_HOME: "/mock/codex-home" }),
  getCodexAppServer: () => ({}),
  codexAuthStatus: appServerMocks.codexAuthStatus,
}));

import { CodexAdapter, buildCodexInput } from "./provider-codex";
import type { AiChatMessage } from "../../shared/ai";
import { AiRequestError } from "./provider-errors";

async function* eventsOf(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

function makeAdapter(model = "gpt-5.5") {
  return new CodexAdapter({ providerId: "codex", model, apiKey: "" });
}

describe("CodexAdapter.chat", () => {
  beforeEach(() => {
    sdkMocks.ctor.mockReset();
    sdkMocks.startThread.mockReset();
    sdkMocks.runStreamed.mockReset();
  });

  it("flattens history into a single prompt and emits streamed deltas", async () => {
    sdkMocks.runStreamed.mockResolvedValue({
      events: eventsOf([
        { type: "thread.started", thread_id: "t1" },
        { type: "item.updated", item: { id: "m1", type: "agent_message", text: "안녕" } },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "안녕하세요" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
        },
      ]),
    });

    const deltas: string[] = [];
    const result = await makeAdapter().chat(
      {
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "이전 질문" },
          { role: "assistant", content: "이전 답" },
          { role: "user", content: "지금 질문" },
        ],
      },
      {
        signal: new AbortController().signal,
        onDelta: (delta) => {
          if (delta.kind === "text") {
            deltas.push(delta.text);
          }
        },
      },
    );

    expect(deltas).toEqual(["안녕", "하세요"]);
    expect(result.text).toBe("안녕하세요");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // 스레드는 읽기전용 샌드박스 + 승인 없음으로 열리고 모델이 전달된다.
    expect(sdkMocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      }),
    );
    // 프롬프트에 히스토리가 라벨과 함께 평탄화된다.
    const input = sdkMocks.runStreamed.mock.calls[0][0] as Array<{ type: string; text?: string }>;
    const prompt = input[0].text ?? "";
    expect(prompt).toContain("## System\nbe brief");
    expect(prompt).toContain("## User\n이전 질문");
    expect(prompt).toContain("## Assistant\n이전 답");
    expect(prompt).toContain("## User\n지금 질문");
  });

  it("returns only the LAST agent message as final text (pre-tool preamble stays delta-only)", async () => {
    sdkMocks.runStreamed.mockResolvedValue({
      events: eventsOf([
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "확인하겠습니다." } },
        { type: "item.completed", item: { id: "tool", type: "mcp_tool_call", server: "dolgate", tool: "inspect_command", status: "completed" } },
        { type: "item.completed", item: { id: "m2", type: "agent_message", text: "DSM 7.3.2 입니다." } },
      ]),
    });
    const deltas: string[] = [];
    const result = await makeAdapter().chat(
      { model: "gpt-5.5", messages: [{ role: "user", content: "os?" }] },
      {
        signal: new AbortController().signal,
        onDelta: (delta) => {
          if (delta.kind === "text") {
            deltas.push(delta.text);
          }
        },
      },
    );
    // 예고 문장은 스트리밍 델타로만 나가고(렌더러가 작업 내역으로 접음), 최종 텍스트는 마지막 메시지만.
    expect(deltas).toEqual(["확인하겠습니다.", "DSM 7.3.2 입니다."]);
    expect(result.text).toBe("DSM 7.3.2 입니다.");
  });

  it("injects the dolgate MCP server config and token env when a binding is provided", async () => {
    sdkMocks.runStreamed.mockResolvedValue({
      events: eventsOf([
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
      ]),
    });
    const adapter = new CodexAdapter(
      { providerId: "codex", model: "gpt-5.5", apiKey: "" },
      { url: "http://127.0.0.1:1234/mcp", token: "secret-token" },
    );
    await adapter.chat(
      { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
      { signal: new AbortController().signal, onDelta: () => {} },
    );

    const options = sdkMocks.ctor.mock.calls[0][0] as {
      env: Record<string, string>;
      config?: { mcp_servers?: Record<string, Record<string, unknown>> };
    };
    expect(options.env.DOLGATE_MCP_TOKEN).toBe("secret-token");
    expect(options.config?.mcp_servers?.dolgate).toMatchObject({
      url: "http://127.0.0.1:1234/mcp",
      bearer_token_env_var: "DOLGATE_MCP_TOKEN",
      // 비대화형에서 MCP 호출이 "user cancelled" 로 자동 취소되지 않도록 자동 승인
      // (승인 관문은 dolssh 의 run_in_terminal 게이트로 단일화).
      default_tools_approval_mode: "approve",
    });

    // 도구 연결 시 지시문이 "MCP 도구를 써라"로 바뀐다.
    const input = sdkMocks.runStreamed.mock.calls[0][0] as Array<{ text?: string }>;
    expect(input[0].text).toContain("dolgate MCP tools");
    expect(input[0].text).toContain("run_in_terminal");
  });

  it("omits MCP config entirely without a binding (suggest-only instructions)", async () => {
    sdkMocks.runStreamed.mockResolvedValue({ events: eventsOf([]) });
    await makeAdapter().chat(
      { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
      { signal: new AbortController().signal, onDelta: () => {} },
    );
    const options = sdkMocks.ctor.mock.calls[0][0] as {
      env: Record<string, string>;
      config?: unknown;
    };
    expect(options.config).toBeUndefined();
    expect(options.env.DOLGATE_MCP_TOKEN).toBeUndefined();
    const input = sdkMocks.runStreamed.mock.calls[0][0] as Array<{ text?: string }>;
    expect(input[0].text).toContain("suggest commands for the user to run instead");
  });

  it("omits the model option when empty (codex default model)", async () => {
    sdkMocks.runStreamed.mockResolvedValue({ events: eventsOf([]) });
    await makeAdapter("").chat(
      { model: "", messages: [{ role: "user", content: "hi" }] },
      { signal: new AbortController().signal, onDelta: () => {} },
    );
    expect(sdkMocks.startThread.mock.calls[0][0]).not.toHaveProperty("model");
  });

  it("writes image attachments to temp files, passes them as local_image, and cleans up", async () => {
    sdkMocks.runStreamed.mockResolvedValue({
      events: eventsOf([
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } },
      ]),
    });
    await makeAdapter().chat(
      {
        model: "gpt-5.5",
        messages: [
          {
            role: "user",
            content: "이거 봐줘",
            attachments: [{ kind: "image", mediaType: "image/png", dataBase64: "aGk=" }],
          },
        ],
      },
      { signal: new AbortController().signal, onDelta: () => {} },
    );

    const input = sdkMocks.runStreamed.mock.calls[0][0] as Array<{ type: string; path?: string }>;
    const image = input.find((part) => part.type === "local_image");
    expect(image?.path).toMatch(/\.png$/);
    // chat 종료 후 임시 파일은 정리된다.
    expect(existsSync(image!.path!)).toBe(false);
  });

  it("maps auth-looking turn failures to an AiRequestError(auth)", async () => {
    sdkMocks.runStreamed.mockResolvedValue({
      events: eventsOf([
        { type: "turn.failed", error: { message: "401 Unauthorized: please login" } },
      ]),
    });
    await expect(
      makeAdapter().chat(
        { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
        { signal: new AbortController().signal, onDelta: () => {} },
      ),
    ).rejects.toMatchObject({ name: "AiRequestError", reason: "auth" });
  });

  it("throws plain errors for other stream failures", async () => {
    sdkMocks.runStreamed.mockResolvedValue({
      events: eventsOf([{ type: "error", message: "boom" }]),
    });
    await expect(
      makeAdapter().chat(
        { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] },
        { signal: new AbortController().signal, onDelta: () => {} },
      ),
    ).rejects.toThrow("boom");
  });
});

describe("CodexAdapter.testConnection", () => {
  beforeEach(() => {
    appServerMocks.codexAuthStatus.mockReset();
  });

  it("reports ok with account details when authenticated", async () => {
    appServerMocks.codexAuthStatus.mockResolvedValue({
      authenticated: true,
      authMode: "chatgpt",
      email: "dev@example.com",
      planType: "pro",
    });
    const result = await makeAdapter().testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("dev@example.com");
  });

  it("reports auth failure when not logged in", async () => {
    appServerMocks.codexAuthStatus.mockResolvedValue({
      authenticated: false,
      authMode: null,
      email: null,
      planType: null,
    });
    const result = await makeAdapter().testConnection();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth");
  });
});

describe("buildCodexInput", () => {
  it("keeps tool-turn output as plain text and appends the reply instructions", async () => {
    const messages: AiChatMessage[] = [
      { role: "user", content: "do it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "x", argsJson: "{}" }] },
      { role: "tool", content: "", toolResults: [{ toolCallId: "c1", content: "tool says hi" }] },
      { role: "user", content: "follow up" },
    ];
    const { prompt, imagePaths, cleanup } = await buildCodexInput(messages);
    await cleanup();
    expect(imagePaths).toEqual([]);
    expect(prompt).toContain("## Tool output\ntool says hi");
    expect(prompt.trim().endsWith("suggest commands for the user to run instead.")).toBe(true);
  });

  it("throws nothing and returns AiRequestError type guard sanity", () => {
    // mapCodexFailure 는 내부 함수지만 AiRequestError 가 export 되어 있는지만 확인(회귀 가드).
    expect(new AiRequestError("auth", "x").reason).toBe("auth");
  });
});
