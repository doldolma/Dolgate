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
import { mergeTextAttachments } from "../../shared/ai";
import type { ProviderAdapter, ProviderChatOptions, ProviderConfig } from "./provider";
import { normalizeAiError } from "./provider-errors";

// Anthropic 은 max_tokens 가 필수라 기본 상한을 둔다(요청이 값을 주면 그걸 우선).
// 4096 = 현재 Claude 계열이 공통으로 허용하는 안전한 출력 상한(1024 는 답이 잘렸음).
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

// Models API 조회가 채팅 시작을 붙잡지 않도록 하는 상한. 초과하면 포기하고 폴백(설정/기본값).
const MODEL_LOOKUP_TIMEOUT_MS = 3_000;

// 모델별 컨텍스트 창 캐시 — 어댑터 인스턴스는 채팅마다 새로 만들어지므로 모듈 레벨에 둔다.
// 값은 모델의 고정 속성이라 프로세스 수명 동안 캐시해도 안전하다.
const modelContextTokensCache = new Map<string, number>();

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly temperature?: number;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      // 게이트웨이/프록시용 override 만 허용(기본값은 SDK가 api.anthropic.com 사용).
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model;
    this.temperature = config.temperature;
    this.baseUrl = config.baseUrl ?? "";
  }

  // 모델의 컨텍스트 창을 Models API(max_input_tokens)에서 조회한다. 사용자가 설정할 필요가
  // 없도록 자동화하는 용도라 실패(네트워크/미지원 게이트웨이/구버전 API)는 null 로 삼킨다.
  async getModelContextTokens(model: string, opts: { signal: AbortSignal }): Promise<number | null> {
    const cacheKey = `${this.baseUrl}|${model}`;
    const cached = modelContextTokensCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    // 채팅 signal + 자체 타임아웃 합성(AbortSignal.any 는 Node 버전에 따라 없을 수 있어 수동 합성).
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), MODEL_LOOKUP_TIMEOUT_MS);
    try {
      const info = await this.client.models.retrieve(model, undefined, { signal: controller.signal });
      const tokens = info?.max_input_tokens;
      if (typeof tokens === "number" && tokens > 0) {
        modelContextTokensCache.set(cacheKey, tokens);
        return tokens;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
      opts.signal.removeEventListener("abort", onAbort);
    }
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

// Anthropic Base64ImageSource.media_type 은 closed union — 그 외 타입은 이미지 블록으로 못 보낸다.
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// user 턴의 첨부를 content 블록 배열로. 이미지 블록 먼저, 병합 텍스트 블록 하나가 뒤따른다.
// 빈 text 블록은 Anthropic 이 400 으로 거부하므로 텍스트가 비면 생략. 블록이 하나도 없으면 null(평문 폴백).
function toUserContentBlocks(message: AiChatMessage): Anthropic.ContentBlockParam[] | null {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.kind === "image" && ANTHROPIC_IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType as Anthropic.Base64ImageSource["media_type"],
          data: attachment.dataBase64,
        },
      });
    }
  }
  const text = mergeTextAttachments(message.content, message.attachments);
  if (text) {
    blocks.push({ type: "text", text });
  }
  return blocks.length > 0 ? blocks : null;
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
    if (message.role === "user" && message.attachments?.length) {
      const blocks = toUserContentBlocks(message);
      if (blocks) {
        out.push({ role: "user", content: blocks });
        continue;
      }
      // 첨부가 전부 걸러졌으면(비지원 media type 등) 평문 폴백.
    }
    out.push({ role: message.role as "user" | "assistant", content: message.content });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}
