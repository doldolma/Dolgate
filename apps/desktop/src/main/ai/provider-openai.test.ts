import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
    models = { list: mocks.list };
    constructor(options: unknown) {
      mocks.ctor(options);
    }
  },
}));

import { OpenAiAdapter } from "./provider-openai";

async function* streamOf(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("OpenAiAdapter", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.list.mockReset();
    mocks.ctor.mockReset();
  });

  it("accumulates streamed text deltas and maps finish reason", async () => {
    mocks.create.mockResolvedValue(
      streamOf([
        { choices: [{ delta: { content: "he" }, finish_reason: null }] },
        { choices: [{ delta: { content: "llo" }, finish_reason: "stop" }] },
      ]),
    );
    const adapter = new OpenAiAdapter({ providerId: "openai-compat", model: "gpt", apiKey: "k" });
    const deltas: string[] = [];
    const result = await adapter.chat(
      { model: "gpt", messages: [{ role: "user", content: "hi" }] },
      {
        signal: new AbortController().signal,
        onDelta: (delta) => {
          if (delta.kind === "text") {
            deltas.push(delta.text);
          }
        },
      },
    );
    expect(deltas).toEqual(["he", "llo"]);
    expect(result.text).toBe("hello");
    expect(result.finishReason).toBe("stop");
  });

  it("testConnection returns sorted detected models from models.list", async () => {
    mocks.list.mockResolvedValue({ data: [{ id: "b" }, { id: "a" }] });
    const adapter = new OpenAiAdapter({ providerId: "openai-compat", model: "", apiKey: "k" });
    const result = await adapter.testConnection({ signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.detectedModels).toEqual(["a", "b"]);
  });

  it("maps a 401 to an auth failure", async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error("nope"), { status: 401 }));
    const adapter = new OpenAiAdapter({ providerId: "openai-compat", model: "", apiKey: "bad" });
    const result = await adapter.testConnection({ signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth");
  });

  it("uses a placeholder api key and custom baseURL for local servers", () => {
    new OpenAiAdapter({
      providerId: "openai-compat",
      model: "m",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(mocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://localhost:11434/v1", apiKey: "dolgate-local" }),
    );
  });
});
