import Anthropic from "@anthropic-ai/sdk";

import type {
  AiChatRequest,
  AiChatResult,
  AiFinishReason,
  AiTestResult,
} from "../../shared/ai";
import type { ProviderAdapter, ProviderChatOptions, ProviderConfig } from "./provider";
import { normalizeAiError } from "./provider-errors";

// Anthropic 은 max_tokens 가 필수라 기본 상한을 둔다(요청이 값을 주면 그걸 우선).
const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly temperature?: number;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      // 게이트웨이/프록시용 override 만 허용(기본값은 SDK가 api.anthropic.com 사용).
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model;
    this.temperature = config.temperature;
  }

  async testConnection(opts: { signal: AbortSignal }): Promise<AiTestResult> {
    try {
      // 저렴한 검증: 모델 목록(무과금). params 는 없으므로 undefined, signal 은 옵션으로 전달.
      const page = await this.client.models.list(undefined, { signal: opts.signal });
      const entries = Array.isArray(page?.data) ? page.data : [];
      const detectedModels = entries
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string");
      return { ok: true, message: "연결에 성공했습니다.", detectedModels };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return { ok: false, reason: normalized.reason, message: normalized.message };
    }
  }

  async chat(request: AiChatRequest, opts: ProviderChatOptions): Promise<AiChatResult> {
    // system 메시지는 top-level 파라미터로 분리하고, 나머지만 messages[]로 보낸다.
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));

    const temperature = request.temperature ?? this.temperature;

    let text = "";

    const stream = this.client.messages.stream(
      {
        model: request.model || this.model,
        max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        messages,
        ...(system ? { system } : {}),
        ...(typeof temperature === "number" ? { temperature } : {}),
      },
      { signal: opts.signal },
    );

    stream.on("text", (delta: string) => {
      text += delta;
      opts.onDelta({ kind: "text", text: delta });
    });

    // finalMessage()는 스트림 완료 시 resolve, 에러/취소 시 reject → 상위(AiService)가 정규화.
    const final = await stream.finalMessage();
    const usage = final.usage
      ? { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }
      : undefined;

    return { text, finishReason: mapAnthropicStopReason(final.stop_reason), usage };
  }
}

function mapAnthropicStopReason(reason: string | null): AiFinishReason {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}
