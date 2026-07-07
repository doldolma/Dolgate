import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Codex, type ThreadEvent, type ThreadItem, type UserInput } from "@openai/codex-sdk";

import type { AiChatMessage, AiChatRequest, AiChatResult, AiTestResult } from "../../shared/ai";
import { mergeTextAttachments } from "../../shared/ai";
import type { ProviderAdapter, ProviderChatOptions, ProviderConfig } from "./provider";
import { AiRequestError, normalizeAiError } from "./provider-errors";
import {
  codexAuthStatus,
  codexEnv,
  getCodexAppServer,
  resolveCodexBin,
  resolveCodexHome,
} from "./codex-app-server";

// codex 프로세스 env 에서 bearer 토큰을 읽게 할 변수 이름(mcp_servers.<name>.bearer_token_env_var).
const MCP_TOKEN_ENV = "DOLGATE_MCP_TOKEN";
// run_in_terminal 승인 대기(사용자 응답) 동안 MCP 호출이 타임아웃되지 않도록 넉넉히.
const MCP_TOOL_TIMEOUT_SEC = 1200;

// AiService 가 채팅마다 등록해 주는 dolssh 도구 MCP 엔드포인트.
export interface CodexMcpEndpoint {
  url: string;
  token: string;
}

// Codex(ChatGPT 계정) 어댑터. API 키 대신 CODEX_HOME 의 로그인 세션을 쓰고,
// 요청마다 새 thread 에 대화 히스토리를 평탄화해 넣는다(stateless — dolssh 가 매 턴
// 전체 히스토리를 재전송하는 구조와 맞춤). dolssh 도구는 function calling 대신
// localhost MCP 서버(codex-mcp-server.ts)로 노출되어 codex 가 직접 호출한다.
export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private readonly model: string;

  constructor(
    config: ProviderConfig,
    private readonly mcp?: CodexMcpEndpoint,
  ) {
    this.model = config.model;
  }

  async testConnection(): Promise<AiTestResult> {
    try {
      const status = await codexAuthStatus(getCodexAppServer());
      if (!status.authenticated) {
        return {
          ok: false,
          reason: "auth",
          message: "Codex 로그인이 필요합니다. 설정에서 'Codex 로그인' 버튼을 눌러 주세요.",
        };
      }
      const detail = [status.email, status.planType].filter(Boolean).join(" · ");
      return { ok: true, message: `로그인되어 있습니다${detail ? ` — ${detail}` : ""}.` };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return { ok: false, reason: normalized.reason, message: normalized.message };
    }
  }

  async chat(request: AiChatRequest, opts: ProviderChatOptions): Promise<AiChatResult> {
    const model = request.model || this.model;
    const { prompt, imagePaths, cleanup } = await buildCodexInput(request.messages, {
      hasRemoteTools: Boolean(this.mcp),
    });
    try {
      const env = codexEnv();
      if (this.mcp) {
        env[MCP_TOKEN_ENV] = this.mcp.token;
      }
      const codex = new Codex({
        codexPathOverride: resolveCodexBin(),
        env,
        // dolssh 도구 MCP 서버 연결(채팅마다 1회용 토큰). 키는 `codex mcp add --url
        // --bearer-token-env-var` 가 config.toml 에 쓰는 이름과 동일하게 맞춘다.
        ...(this.mcp
          ? {
              config: {
                mcp_servers: {
                  dolgate: {
                    url: this.mcp.url,
                    bearer_token_env_var: MCP_TOKEN_ENV,
                    tool_timeout_sec: MCP_TOOL_TIMEOUT_SEC,
                    // codex 는 MCP 도구 호출마다 승인을 요구하고, 비대화형(exec)에선
                    // "user cancelled MCP tool call" 로 자동 취소된다. dolssh 도구는
                    // 자체 승인 게이트(변경 명령 → 승인 카드)가 있으므로 codex 쪽은
                    // 자동 승인("approve")으로 둔다 — 승인 관문은 dolssh 하나로 단일화.
                    default_tools_approval_mode: "approve",
                  },
                },
              },
            }
          : {}),
      });
      const thread = codex.startThread({
        ...(model ? { model } : {}),
        // 원격(SSH) 세션 어시스턴트 컨텍스트 — codex 의 로컬 도구는 읽기전용으로 묶고
        // 승인 프롬프트 없이(대화형 아님) 돌린다. 작업 디렉토리는 CODEX_HOME 으로 고정.
        sandboxMode: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
        workingDirectory: resolveCodexHome(),
      });

      const input: UserInput[] = [
        { type: "text", text: prompt },
        ...imagePaths.map((imagePath) => ({ type: "local_image" as const, path: imagePath })),
      ];
      const { events } = await thread.runStreamed(input, { signal: opts.signal });

      let streamedText = "";
      // 최종 답변 = 마지막 agent_message 항목. 도구 호출 앞의 예고 문장(별도 항목)은
      // 델타로만 흘려보내고 최종 텍스트에서 제외한다 — 렌더러가 그런 중간 텍스트를
      // "작업 내역"(generationTrace)으로 접는 기존 프로바이더 동작과 맞춤(중복 방지).
      let lastAgentMessage = "";
      let usage: AiChatResult["usage"];
      let failure: string | null = null;
      // agent_message 는 item.updated 마다 전체 텍스트가 다시 오므로 항목별 직전 길이와의 diff 를 델타로 방출.
      const emittedLengths = new Map<string, number>();

      for await (const event of events) {
        if (isAgentMessageEvent(event)) {
          const item = event.item;
          const previous = emittedLengths.get(item.id) ?? 0;
          if (item.text.length > previous) {
            const delta = item.text.slice(previous);
            emittedLengths.set(item.id, item.text.length);
            streamedText += delta;
            opts.onDelta({ kind: "text", text: delta });
          }
          if (event.type === "item.completed") {
            lastAgentMessage = item.text;
          }
        } else if (event.type === "turn.completed") {
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          };
        } else if (event.type === "turn.failed") {
          failure = event.error.message;
        } else if (event.type === "error") {
          failure = event.message;
        } else if (event.type === "item.completed") {
          logCodexItem(event.item);
        }
      }

      if (failure) {
        throw mapCodexFailure(failure);
      }
      return { text: lastAgentMessage || streamedText, finishReason: "stop", usage };
    } finally {
      await cleanup();
    }
  }
}

function isAgentMessageEvent(
  event: ThreadEvent,
): event is Extract<ThreadEvent, { type: "item.updated" | "item.completed" }> & {
  item: { id: string; type: "agent_message"; text: string };
} {
  return (
    (event.type === "item.updated" || event.type === "item.completed") &&
    event.item.type === "agent_message"
  );
}

// codex 쪽 도구 활동을 main 로그로 남긴다 — 문제(도구 실패·의도치 않은 로컬 실행)를
// 패널 밖에서도 추적할 수 있게. 최종 텍스트/usage 외 항목은 여기서만 관찰된다.
function logCodexItem(item: ThreadItem): void {
  if (process.env.VITEST) {
    return;
  }
  if (item.type === "mcp_tool_call") {
    if (item.status === "failed") {
      console.error("[ai][codex] MCP tool failed", {
        tool: item.tool,
        error: item.error?.message ?? "unknown",
      });
    }
    return;
  }
  if (item.type === "command_execution") {
    // 프롬프트로 억제해 둔 로컬 실행이 일어났다는 신호 — read-only 샌드박스라 무해하지만 추적한다.
    console.error("[ai][codex] local command executed", {
      command: item.command,
      exitCode: item.exit_code ?? null,
      status: item.status,
    });
    return;
  }
  if (item.type === "error") {
    console.error("[ai][codex] stream item error", { message: item.message });
  }
}

// codex 실패 메시지를 정규화 가능한 에러로. 로그인 만료가 제일 흔한 케이스라 별도 안내.
function mapCodexFailure(message: string): Error {
  if (/unauthorized|401|not\s*logged\s*in|login|auth/i.test(message)) {
    return new AiRequestError(
      "auth",
      "Codex 인증이 만료되었거나 로그인이 필요합니다. 설정에서 'Codex 로그인'을 다시 진행해 주세요.",
    );
  }
  return new Error(message);
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

interface CodexInput {
  prompt: string;
  imagePaths: string[];
  cleanup: () => Promise<void>;
}

interface BuildCodexInputOptions {
  // dolgate MCP 도구(원격 호스트 도구)가 연결되어 있는지 — 마지막 지시문이 달라진다.
  hasRemoteTools?: boolean;
}

// 대화 히스토리를 단일 프롬프트로 평탄화하고, 이미지 첨부는 임시 파일로 내려 local_image 로 넘긴다.
// role:"tool" 턴(다른 프로바이더에서 넘어온 히스토리)은 도구 결과 텍스트만 보존한다.
export async function buildCodexInput(
  messages: AiChatMessage[],
  options: BuildCodexInputOptions = {},
): Promise<CodexInput> {
  const sections: string[] = [];
  const imagePaths: string[] = [];
  let tempDir: string | null = null;

  const ensureTempDir = async (): Promise<string> => {
    if (!tempDir) {
      tempDir = path.join(os.tmpdir(), `dolgate-codex-${randomUUID()}`);
      await mkdir(tempDir, { recursive: true });
    }
    return tempDir;
  };

  for (const message of messages) {
    if (message.role === "system") {
      sections.push(`## System\n${message.content}`);
      continue;
    }
    if (message.role === "tool") {
      const results = (message.toolResults ?? [])
        .map((result) => result.content)
        .filter(Boolean)
        .join("\n");
      if (results) {
        sections.push(`## Tool output\n${results}`);
      }
      continue;
    }
    const label = message.role === "user" ? "## User" : "## Assistant";
    const text = mergeTextAttachments(message.content, message.attachments);
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== "image") {
        continue;
      }
      const extension = IMAGE_EXTENSIONS[attachment.mediaType] ?? "png";
      const filePath = path.join(await ensureTempDir(), `${randomUUID()}.${extension}`);
      await writeFile(filePath, Buffer.from(attachment.dataBase64, "base64"));
      imagePaths.push(filePath);
    }
    if (text) {
      sections.push(`${label}\n${text}`);
    } else if (message.role === "user" && (message.attachments?.length ?? 0) > 0) {
      sections.push(`${label}\n(attached image)`);
    }
  }

  sections.push(
    options.hasRemoteTools
      ? "## Instructions\nReply to the last user message above, in the same language the user used. " +
          "You are assisting with a REMOTE terminal session. The connected remote host is reachable ONLY " +
          "through the dolgate MCP tools (inspect_command, run_in_terminal, read_terminal_output, …) — " +
          "use them to inspect or act on the host, then answer directly with a clear summary. " +
          "Do NOT run local shell commands or read local files on this machine; they target the wrong computer."
      : "## Instructions\nReply to the last user message above, in the same language the user used. " +
          "Answer directly in text. Do not run local commands, read local files, or modify anything — " +
          "you are assisting with a remote terminal session, so suggest commands for the user to run instead.",
  );

  return {
    prompt: sections.join("\n\n"),
    imagePaths,
    cleanup: async () => {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
