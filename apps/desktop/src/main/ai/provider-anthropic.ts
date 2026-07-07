import Anthropic from "@anthropic-ai/sdk";

import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResult,
  AiFinishReason,
  AiToolCall,
  AiToolDef,
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
    const { system, messages } = toAnthropicMessages(request.messages);
    const temperature = request.temperature ?? this.temperature;
    let text = "";

    const stream = this.client.messages.stream(
      {
        model: request.model || this.model,
        max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        messages,
        ...(system ? { system } : {}),
        ...(typeof temperature === "number" ? { temperature } : {}),
        ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) } : {}),
      },
      { signal: opts.signal },
    );

    stream.on("text", (delta: string) => {
      text += delta;
      opts.onDelta({ kind: "text", text: delta });
    });

    // finalMessage()는 스트림 완료 시 resolve, 에러/취소 시 reject → 상위(AiService)가 정규화.
    const final = await stream.finalMessage();
    const toolCalls: AiToolCall[] = (final.content ?? [])
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, argsJson: JSON.stringify(block.input ?? {}) }));
    for (const call of toolCalls) {
      opts.onDelta({ kind: "tool_call_start", id: call.id, name: call.name });
    }
    const usage = final.usage
      ? { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }
      : undefined;

    return {
      text,
      finishReason: mapAnthropicStopReason(final.stop_reason),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage,
    };
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

function toAnthropicTools(tools: AiToolDef[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// 정규화된 메시지를 Anthropic 포맷으로. system 은 top-level 로 분리, tool 결과/호출은 content 블록으로.
function toAnthropicMessages(messages: AiChatMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: (message.toolResults ?? []).map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
          is_error: result.isError,
        })),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: safeParseJson(call.argsJson) });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: message.role as "user" | "assistant", content: message.content });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}
