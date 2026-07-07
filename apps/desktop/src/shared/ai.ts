import type { AiProviderId, AiSearchBackend } from "@dolssh/shared-core";

// AI 어시스턴트의 provider-agnostic wire 타입. 데스크톱 전용(main 어댑터 + preload + 렌더러 공유).
// shared-core 배럴의 export* 값-누락 footgun을 피하려고 shared-core가 아니라 여기에 둔다.
// AiProviderId 만 shared-core에서 type으로 재사용(값이 아니므로 안전).
// 재-export 해도 배럴 index 의 두 `export *`는 동일 심볼로 해석돼 충돌하지 않는다
// (main 파일들이 로컬 ai.ts 상대경로로 AiProviderId 를 함께 가져오게 하기 위함).
export type { AiProviderId, AiSearchBackend };

// 도구(function calling) — provider-agnostic.
export interface AiToolDef {
  name: string;
  description?: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}
export interface AiToolCall {
  id: string;
  name: string;
  // 원시 JSON 문자열(스트리밍 중 부분일 수 있음; 실행 시 JSON.parse).
  argsJson: string;
}
export interface AiToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// 사용자 턴 첨부. text 는 첨부 시점에 이미 redact + truncate 된 상태로 저장된다.
export type AiAttachment =
  | { kind: "image"; mediaType: string; dataBase64: string; name?: string }
  | { kind: "text"; name: string; text: string };

export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // 사용자 턴 전용 첨부(이미지/텍스트 파일). 어댑터는 user 턴에서만 해석한다.
  attachments?: AiAttachment[];
  // assistant 턴이 요청한 도구 호출(에이전트 루프 내부에서만 채워지고, 렌더러 표시 메시지엔 없음).
  toolCalls?: AiToolCall[];
  // role:"tool" 턴의 도구 실행 결과.
  toolResults?: AiToolResult[];
}

// 본문 + 텍스트 첨부를 하나의 최종 텍스트로 합친다(provider 어댑터 2곳 + 토큰 추정기 공용).
// 이미지 첨부는 무시한다. content 가 비면 구분자 없이 첨부만 이어붙인다.
export function mergeTextAttachments(content: string, attachments?: AiAttachment[]): string {
  const texts = (attachments ?? []).filter(
    (attachment): attachment is Extract<AiAttachment, { kind: "text" }> => attachment.kind === "text",
  );
  if (texts.length === 0) {
    return content;
  }
  const parts = texts.map((attachment) => `[첨부 파일: ${attachment.name}]\n\`\`\`\n${attachment.text}\n\`\`\``);
  return [content, ...parts].filter(Boolean).join("\n\n");
}

export interface AiChatRequest {
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: AiToolDef[];
}

// Codex(ChatGPT 계정) 인증 상태 — codex app-server `account/read` 결과 요약.
export interface CodexAuthStatus {
  authenticated: boolean;
  authMode: string | null;
  email: string | null;
  planType: string | null;
}

// `account/login/start` 응답. authUrl 을 렌더러가 외부 브라우저로 열고, 상태 폴링으로 완료를 감지한다.
export interface CodexLoginStart {
  loginId: string;
  authUrl: string;
}

// Codex 요금제 사용량 창(rate limit). usedPercent = 이 창에서 소진한 비율(0~100).
export interface CodexRateWindow {
  usedPercent: number;
  // 창 길이(분). 300 = 5시간, 10080 = 주간.
  windowMinutes: number;
  // 창이 리셋되는 시각(Unix epoch seconds). 알 수 없으면 null.
  resetsAt: number | null;
}

// `account/rateLimits/read` 요약 — 남은 플랜 용량 표시용. 미인증/미노출 시 windows 는 null.
export interface CodexUsage {
  planType: string | null;
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
}

// `model/list` 항목 요약 — 설정의 모델 select 용(숨김 모델 제외, 서버 순서 유지).
export interface CodexModel {
  id: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
}

export interface AiTerminalSnapshotRef {
  snapshotId: string;
  recentOutputLines: number;
}

export interface AiTerminalOutputRequest {
  requestId: string;
  clientRequestId: string;
  snapshotId: string;
  beforeRecentLines: number;
  lines: number;
}

export interface AiTerminalOutputResponse {
  clientRequestId: string;
  text?: string;
  rangeLabel?: string;
  reachedStart?: boolean;
  returnedLines?: number;
  error?: string;
}

// 스트리밍 델타. Phase 1은 text만 방출하고, tool_call_* 는 이후 phase를 위해
// 미리 정의만 해 둔다(다운스트림 코드가 선컴파일되도록).
export type AiChatDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; id: string; argsDelta: string };

export type AiFinishReason = "stop" | "length" | "tool_calls" | "aborted" | "error";

export interface AiChatResult {
  text: string;
  finishReason: AiFinishReason;
  // 어댑터가 이번 턴에 감지한 도구 호출(finishReason "tool_calls"일 때).
  toolCalls?: AiToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

// 정규화된 실패 사유 — UI가 사유별 메시지를 보여줄 수 있게 한다.
export type AiFailureReason =
  | "auth"
  | "network"
  | "model-not-found"
  | "server"
  | "invalid-response"
  | "timeout"
  | "disabled"
  | "no-key";

export interface AiErrorPayload {
  reason: AiFailureReason;
  // 사람이 읽는 메시지 — 키/인증 헤더/요청 바디가 절대 포함되지 않도록 redaction된 상태.
  message: string;
}

export interface AiTestResult {
  ok: boolean;
  reason?: AiFailureReason;
  message: string;
  // 프로바이더가 저렴하게 모델 목록을 줄 수 있을 때 채운다(OpenAI /models 등).
  detectedModels?: string[];
}

// testConnection 입력. apiKey는 저장 전 검증용 transient 키(생략 시 키체인 키 사용).
export interface AiTestConnectionInput {
  providerId: AiProviderId;
  baseUrl?: string;
  model: string;
  apiKey?: string;
}

// ai:chat 시작 입력. sessionId 는 host 도구(run_command)가 어느 세션에서 실행할지 알기 위해 필요.
// 세션 밖(예: 홈)에서 연 채팅이면 생략될 수 있고, 그 경우 run_command 는 노출되지 않는다.
export interface AiChatStartInput {
  requestId: string;
  sessionId?: string;
  request: AiChatRequest;
  terminalSnapshot?: AiTerminalSnapshotRef;
}

// run_command 승인 응답(renderer→main). remember=true 면 해당 세션에서 이후 변경 명령을 자동 승인.
export interface AiApprovalResponse {
  requestId: string;
  toolCallId: string;
  approved: boolean;
  remember?: boolean;
}

export type AiToolStatus = "running" | "done" | "error";

// ai:chat-event 로 main→renderer 푸시되는 스트리밍 이벤트.
export type AiChatEvent =
  | { requestId: string; type: "delta"; delta: AiChatDelta }
  | {
      requestId: string;
      type: "tool";
      tool: { id: string; name: string; status: AiToolStatus; label: string };
    }
  | {
      requestId: string;
      type: "approval-required";
      // 모델이 실행하려는 변경 가능성 있는 명령. 사용자가 승인/거부할 때까지 에이전트 루프가 멈춘다.
      approval: { toolCallId: string; command: string; reason: string };
    }
  | { requestId: string; type: "done"; result: AiChatResult }
  | { requestId: string; type: "error"; error: AiErrorPayload };

export interface AiApiKeyStatus {
  hasKey: boolean;
}
