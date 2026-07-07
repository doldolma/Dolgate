import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  list: vi.fn(),
  retrieve: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: mocks.stream };
    models = { list: mocks.list, retrieve: mocks.retrieve };
    constructor(options: unknown) {
      mocks.ctor(options);
    }
  },
}));

import { AnthropicAdapter } from "./provider-anthropic";

// on('text') 로 등록된 콜백을 finalMessage()에서 흘려주는 가짜 MessageStream.
function fakeStream(text: string, final: unknown) {
  let onText: ((delta: string) => void) | undefined;
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === "text") {
        onText = cb;
      }
      return this;
    },
    async finalMessage() {
      onText?.(text);
      return final;
    },
  };
}

describe("AnthropicAdapter", () => {
  beforeEach(() => {
    mocks.stream.mockReset();
    mocks.list.mockReset();
    mocks.retrieve.mockReset();
    mocks.ctor.mockReset();
  });

  it("extracts system prompt, streams text, and maps stop_reason", async () => {
    mocks.stream.mockReturnValue(
      fakeStream("hi there", {
        stop_reason: "max_tokens",
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
    );
    const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude", apiKey: "k" });
    const deltas: string[] = [];
    const result = await adapter.chat(
      {
        model: "claude",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
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

    expect(deltas).toEqual(["hi there"]);
    expect(result.text).toBe("hi there");
    expect(result.finishReason).toBe("length");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5 });

    const body = mocks.stream.mock.calls[0][0] as {
      system?: string;
      messages: Array<{ role: string }>;
    };
    expect(body.system).toBe("be brief");
    expect(body.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("maps user attachments to image blocks + merged text block", async () => {
    mocks.stream.mockReturnValue(fakeStream("ok", { stop_reason: "end_turn" }));
    const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude", apiKey: "k" });
    await adapter.chat(
      {
        model: "claude",
        messages: [
          {
            role: "user",
            content: "이 화면 봐줘",
            attachments: [
              { kind: "image", mediaType: "image/png", dataBase64: "aGk=" },
              { kind: "text", name: "app.log", text: "line1" },
            ],
          },
        ],
      },
      { signal: new AbortController().signal, onDelta: () => {} },
    );

    const body = mocks.stream.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
      { type: "text", text: "이 화면 봐줘\n\n[첨부 파일: app.log]\n```\nline1\n```" },
    ]);
  });

  it("omits the text block for an image-only send and keeps plain string without attachments", async () => {
    mocks.stream.mockReturnValue(fakeStream("ok", { stop_reason: "end_turn" }));
    const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude", apiKey: "k" });
    await adapter.chat(
      {
        model: "claude",
        messages: [
          {
            role: "user",
            content: "",
            attachments: [{ kind: "image", mediaType: "image/jpeg", dataBase64: "aGk=" }],
          },
          { role: "assistant", content: "네" },
          { role: "user", content: "plain" },
        ],
      },
      { signal: new AbortController().signal, onDelta: () => {} },
    );

    const body = mocks.stream.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } },
    ]);
    expect(body.messages[1].content).toBe("네");
    expect(body.messages[2].content).toBe("plain");
  });

  it("falls back to plain string when every attachment is filtered out", async () => {
    mocks.stream.mockReturnValue(fakeStream("ok", { stop_reason: "end_turn" }));
    const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude", apiKey: "k" });
    await adapter.chat(
      {
        model: "claude",
        messages: [
          {
            role: "user",
            content: "",
            // 비지원 media type 이고 텍스트도 없음 → 블록이 하나도 안 나옴 → 평문 폴백.
            attachments: [{ kind: "image", mediaType: "image/tiff", dataBase64: "aGk=" }],
          },
        ],
      },
      { signal: new AbortController().signal, onDelta: () => {} },
    );

    const body = mocks.stream.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toBe("");
  });

  it("sends x-api-key auth via the constructed client and lists models on test", async () => {
    mocks.list.mockResolvedValue({ data: [{ id: "claude-x" }] });
    const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "", apiKey: "sk-ant" });
    const result = await adapter.testConnection({ signal: new AbortController().signal });
    expect(mocks.ctor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-ant" }));
    expect(result.ok).toBe(true);
    expect(result.detectedModels).toEqual(["claude-x"]);
  });

  it("maps a 404 to model-not-found", async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error("missing"), { status: 404 }));
    const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "", apiKey: "k" });
    const result = await adapter.testConnection({ signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("model-not-found");
  });

  // 주의: 컨텍스트 창 캐시는 모듈 레벨이라 테스트 간 공유된다 — 케이스마다 고유 모델명을 쓴다.
  describe("getModelContextTokens", () => {
    it("returns max_input_tokens from the Models API and caches per model", async () => {
      mocks.retrieve.mockResolvedValue({ id: "claude-cw-1", max_input_tokens: 200_000 });
      const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude-cw-1", apiKey: "k" });
      const signal = new AbortController().signal;

      expect(await adapter.getModelContextTokens("claude-cw-1", { signal })).toBe(200_000);
      expect(await adapter.getModelContextTokens("claude-cw-1", { signal })).toBe(200_000);
      expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    });

    it("returns null (and does not cache) when the lookup fails", async () => {
      mocks.retrieve.mockRejectedValueOnce(new Error("network"));
      mocks.retrieve.mockResolvedValueOnce({ id: "claude-cw-2", max_input_tokens: 1_000_000 });
      const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude-cw-2", apiKey: "k" });
      const signal = new AbortController().signal;

      expect(await adapter.getModelContextTokens("claude-cw-2", { signal })).toBeNull();
      // 실패는 캐시되지 않으므로 다음 호출은 다시 조회해 성공값을 얻는다.
      expect(await adapter.getModelContextTokens("claude-cw-2", { signal })).toBe(1_000_000);
    });

    it("returns null when the API omits max_input_tokens (old gateway)", async () => {
      mocks.retrieve.mockResolvedValue({ id: "claude-cw-3" });
      const adapter = new AnthropicAdapter({ providerId: "anthropic", model: "claude-cw-3", apiKey: "k" });
      expect(
        await adapter.getModelContextTokens("claude-cw-3", { signal: new AbortController().signal }),
      ).toBeNull();
    });
  });
});
