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

  it("maps user attachments to text + image_url parts", async () => {
    mocks.create.mockResolvedValue(
      streamOf([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    );
    const adapter = new OpenAiAdapter({ providerId: "openai-compat", model: "gpt", apiKey: "k" });
    await adapter.chat(
      {
        model: "gpt",
        messages: [
          { role: "system", content: "sys" },
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
      { signal: new AbortController().signal, onDelta: () => undefined },
    );

    const body = mocks.create.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // system 은 string 유지, user 는 parts 배열.
    expect(body.messages[0].content).toBe("sys");
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "이 화면 봐줘\n\n[첨부 파일: app.log]\n```\nline1\n```" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
    ]);
  });

  it("omits the empty text part for an image-only send", async () => {
    mocks.create.mockResolvedValue(
      streamOf([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    );
    const adapter = new OpenAiAdapter({ providerId: "openai-compat", model: "gpt", apiKey: "k" });
    await adapter.chat(
      {
        model: "gpt",
        messages: [
          {
            role: "user",
            content: "",
            attachments: [{ kind: "image", mediaType: "image/jpeg", dataBase64: "aGk=" }],
          },
        ],
      },
      { signal: new AbortController().signal, onDelta: () => undefined },
    );

    const body = mocks.create.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,aGk=" } },
    ]);
  });

  it("accumulates streamed tool_calls by index and returns them", async () => {
    mocks.create.mockResolvedValue(
      streamOf([
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"que' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );
    const adapter = new OpenAiAdapter({ providerId: "openai-compat", model: "gpt", apiKey: "k" });
    const result = await adapter.chat(
      {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "web_search", parameters: { type: "object", properties: {} } }],
      },
      { signal: new AbortController().signal, onDelta: () => undefined },
    );
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{ id: "c1", name: "web_search", argsJson: '{"query":"x"}' }]);
  });
});
