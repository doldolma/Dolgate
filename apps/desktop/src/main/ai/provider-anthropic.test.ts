import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  list: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: mocks.stream };
    models = { list: mocks.list };
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
});
