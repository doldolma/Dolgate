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

export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // assistant 턴이 요청한 도구 호출(에이전트 루프 내부에서만 채워지고, 렌더러 표시 메시지엔 없음).
  toolCalls?: AiToolCall[];
  // role:"tool" 턴의 도구 실행 결과.
  toolResults?: AiToolResult[];
}

export interface AiChatRequest {
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: AiToolDef[];
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
