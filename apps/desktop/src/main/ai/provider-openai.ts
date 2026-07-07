import OpenAI from "openai";

import type {
  AiChatRequest,
  AiChatResult,
  AiFinishReason,
  AiTestResult,
} from "../../shared/ai";
import type { ProviderAdapter, ProviderChatOptions, ProviderConfig } from "./provider";
import { normalizeAiError } from "./provider-errors";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

// OpenAI 및 OpenAI-호환 서버(Ollama/LM Studio/vLLM/게이트웨이) 어댑터.
export class OpenAiAdapter implements ProviderAdapter {
  readonly id = "openai-compat" as const;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly temperature?: number;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      // 로컬 호환 서버는 키가 필요 없을 수 있으므로 빈 값이면 자리표시자를 둔다(SDK가 키 없음으로 throw 방지).
      apiKey: config.apiKey || "dolgate-local",
      baseURL: config.baseUrl || DEFAULT_OPENAI_BASE_URL,
    });
    this.model = config.model;
    this.temperature = config.temperature;
  }

  async testConnection(opts: { signal: AbortSignal }): Promise<AiTestResult> {
    try {
      const page = await this.client.models.list({ signal: opts.signal });
      // 비표준 서버가 { data: [...] } 형태가 아닐 수 있으므로 방어적으로 처리(연결은 성공으로 간주).
      const entries = Array.isArray(page?.data) ? page.data : [];
      const detectedModels = entries
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string")
        .sort();
      return { ok: true, message: "연결에 성공했습니다.", detectedModels };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return { ok: false, reason: normalized.reason, message: normalized.message };
    }
  }

  async chat(request: AiChatRequest, opts: ProviderChatOptions): Promise<AiChatResult> {
    let text = "";
    let finishReason: AiFinishReason = "stop";

    const stream = await this.client.chat.completions.create(
      {
        model: request.model || this.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: request.temperature ?? this.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      },
      { signal: opts.signal },
    );

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        opts.onDelta({ kind: "text", text: delta });
      }
      if (choice?.finish_reason) {
        finishReason = mapOpenAiFinishReason(choice.finish_reason);
      }
    }

    return { text, finishReason };
  }
}

function mapOpenAiFinishReason(reason: string): AiFinishReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "stop";
  }
}
