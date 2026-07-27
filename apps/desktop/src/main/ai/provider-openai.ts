import OpenAI from "openai";

import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResult,
  AiFinishReason,
  AiToolCall,
  AiToolDef,
  AiTestResult,
} from "../../shared/ai";
import { mergeTextAttachments } from "../../shared/ai";
import type { ProviderAdapter, ProviderChatOptions, ProviderConfig } from "./provider";
import { normalizeAiError } from "./provider-errors";
import { t } from '../i18n';

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
      return { ok: true, message: t('misc.connectSuccess'), detectedModels };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return { ok: false, reason: normalized.reason, message: normalized.message };
    }
  }

  async chat(request: AiChatRequest, opts: ProviderChatOptions): Promise<AiChatResult> {
    let text = "";
    let finishReason: AiFinishReason = "stop";
    // 스트리밍 tool_calls 는 index 별로 도착한다(id·name 1회, arguments 문자열 누적).
    const toolAcc = new Map<number, { id: string; name: string; args: string; started: boolean }>();

    const stream = await this.client.chat.completions.create(
      {
        model: request.model || this.model,
        messages: toOpenAiMessages(request.messages),
        temperature: request.temperature ?? this.temperature,
        max_tokens: request.maxTokens,
        ...(request.tools?.length
          ? { tools: toOpenAiTools(request.tools), tool_choice: "auto" as const }
          : {}),
        stream: true,
      },
      { signal: opts.signal },
    );

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const content = choice?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        text += content;
        opts.onDelta({ kind: "text", text: content });
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        const entry = toolAcc.get(call.index) ?? { id: "", name: "", args: "", started: false };
        if (call.id) {
          entry.id = call.id;
        }
        if (call.function?.name) {
          entry.name = call.function.name;
        }
        if (call.function?.arguments) {
          entry.args += call.function.arguments;
        }
        toolAcc.set(call.index, entry);
        if (!entry.started && entry.id && entry.name) {
          entry.started = true;
          opts.onDelta({ kind: "tool_call_start", id: entry.id, name: entry.name });
        } else if (entry.started && call.function?.arguments) {
          opts.onDelta({ kind: "tool_call_args", id: entry.id, argsDelta: call.function.arguments });
        }
      }
      if (choice?.finish_reason) {
        finishReason = mapOpenAiFinishReason(choice.finish_reason);
      }
    }

    const toolCalls: AiToolCall[] = [...toolAcc.values()]
      .filter((entry) => entry.id && entry.name)
      .map((entry) => ({ id: entry.id, name: entry.name, argsJson: entry.args || "{}" }));

    return { text, finishReason, toolCalls: toolCalls.length ? toolCalls : undefined };
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

function toOpenAiTools(tools: AiToolDef[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// 정규화된 메시지를 OpenAI 포맷으로. role:"tool"(다중 결과)은 tool_call_id 별 메시지로 펼친다.
function toOpenAiMessages(
  messages: AiChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const result of message.toolResults ?? []) {
        out.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.argsJson },
        })),
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      continue;
    }
    if (message.role === "user" && message.attachments?.length) {
      const parts = toUserContentParts(message);
      if (parts.length > 0) {
        out.push({ role: "user", content: parts });
        continue;
      }
    }
    out.push({
      role: message.role,
      content: message.content,
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
  }
  return out;
}

// user 턴의 첨부를 content parts 로. 병합 텍스트 part 하나 뒤에 이미지 data URL part 들.
// 빈 text part 는 호환 서버가 거부할 수 있어 생략. parts 가 비면 호출측이 평문 폴백.
function toUserContentParts(message: AiChatMessage): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const text = mergeTextAttachments(message.content, message.attachments);
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const attachment of message.attachments ?? []) {
    if (attachment.kind === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mediaType};base64,${attachment.dataBase64}` },
      });
    }
  }
  return parts;
}
