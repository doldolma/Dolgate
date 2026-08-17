import { isWarpgateSshHostRecord } from "@shared";
import type {
  HostRecord,
  KeyboardInteractiveChallenge,
  KeyboardInteractiveHop,
} from "@shared";
import type {
  PendingContainersInteractiveAuth,
  PendingInteractiveAuth,
  PendingPortForwardInteractiveAuth,
  PendingKeyInstallInteractiveAuth,
  PendingSessionInteractiveAuth,
  PendingSftpInteractiveAuth,
} from "../types";

export function isPendingSessionInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingSessionInteractiveAuth {
  return pending?.source === "ssh";
}

export function isPendingSftpInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingSftpInteractiveAuth {
  return pending?.source === "sftp";
}

export function isPendingContainersInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingContainersInteractiveAuth {
  return pending?.source === "containers";
}

export function isPendingKeyInstallInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingKeyInstallInteractiveAuth {
  return pending?.source === "keyInstall";
}

export function isPendingPortForwardInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingPortForwardInteractiveAuth {
  return pending?.source === "portForward";
}

export function normalizeInteractiveText(value: string | undefined | null): string {
  return (value ?? "").trim();
}

/**
 * 이 인증 요청이 어느 대상의 것인지. 같은 대상의 새 요청은 앞의 것을 대체한다.
 *
 * 코어가 챌린지를 올릴 때 쓰는 상관 ID 와 같아야 한다. endpointId 가 있으면 그쪽이 대상이다 —
 * VNC 터널은 두 ID 를 다 갖지만 답은 endpointId 로 가기 때문이다(대기표가 거기 걸려 있다).
 * 나머지(세션·공개 키 설치)는 sessionId 가 대상이다.
 */
export function interactiveAuthScope(auth: PendingInteractiveAuth): string {
  return "endpointId" in auth
    ? `endpoint:${auth.endpointId}`
    : `session:${auth.sessionId}`;
}

/** 같은 대상의 것을 갈아 끼우고, 없으면 뒤에 붙인다. */
export function upsertPendingInteractiveAuth(
  auths: PendingInteractiveAuth[],
  auth: PendingInteractiveAuth,
): PendingInteractiveAuth[] {
  const scope = interactiveAuthScope(auth);
  const others = auths.filter((item) => interactiveAuthScope(item) !== scope);
  return [...others, auth];
}

/** 그 대상의 것을 내린다. 다른 대상의 것은 그대로 둔다. */
export function clearSessionPendingInteractiveAuth(
  auths: PendingInteractiveAuth[],
  sessionId: string,
): PendingInteractiveAuth[] {
  return auths.filter(
    (auth) => !(auth.source === "ssh" && auth.sessionId === sessionId),
  );
}

/** 그 엔드포인트의 것을 내린다(SFTP·컨테이너·포워딩 공통). */
export function clearEndpointPendingInteractiveAuth(
  auths: PendingInteractiveAuth[],
  endpointId: string,
): PendingInteractiveAuth[] {
  return auths.filter(
    (auth) => !("endpointId" in auth) || auth.endpointId !== endpointId,
  );
}

/** 이 세션이 답을 기다리는 인증. 없으면 null. */
export function findSessionPendingInteractiveAuth(
  auths: PendingInteractiveAuth[],
  sessionId: string | null | undefined,
): PendingSessionInteractiveAuth | null {
  if (!sessionId) {
    return null;
  }
  return (
    auths.find(
      (auth): auth is PendingSessionInteractiveAuth =>
        auth.source === "ssh" && auth.sessionId === sessionId,
    ) ?? null
  );
}

/** 이 엔드포인트가 답을 기다리는 인증. 없으면 null. */
export function findEndpointPendingInteractiveAuth(
  auths: PendingInteractiveAuth[],
  endpointId: string | null | undefined,
): PendingInteractiveAuth | null {
  if (!endpointId) {
    return null;
  }
  return (
    auths.find(
      (auth) => "endpointId" in auth && auth.endpointId === endpointId,
    ) ?? null
  );
}

/** 챌린지 ID 로 찾는다. 응답을 보낼 때 어느 대상의 것인지 알아야 한다. */
export function findPendingInteractiveAuthByChallengeId(
  auths: PendingInteractiveAuth[],
  challengeId: string,
): PendingInteractiveAuth | null {
  return auths.find((auth) => auth.challengeId === challengeId) ?? null;
}

/**
 * 코어가 보낸 홉 정보를 옮긴다. 호스트가 없으면 null — 표시할 것이 없는데 빈 칸을 그리면
 * "누구인지 모른다" 를 "이름 없는 홉" 으로 잘못 보여준다.
 */
export function toKeyboardInteractiveHop(
  value: unknown,
): KeyboardInteractiveHop | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const host = normalizeInteractiveText(
    typeof candidate.host === "string" ? candidate.host : null,
  );
  if (!host) {
    return null;
  }
  const port = Number(candidate.port);
  return {
    host,
    username: normalizeInteractiveText(
      typeof candidate.username === "string" ? candidate.username : null,
    ),
    port: Number.isFinite(port) && port > 0 ? port : undefined,
  };
}

// findHostByAddress·formatInteractiveHop 은 shared-core 에 있다 — 모바일도 같은 이름·같은 주소
// 형식을 보여줘야 하고, 그 둘은 문구가 아니라 주소 조립이라 UI 언어에 걸리지 않는다.
export { findHostByAddress, formatInteractiveHop } from "@shared";

export function parseWarpgateApprovalUrl(
  ...parts: Array<string | undefined | null>
): string | null {
  const combined = parts
    .map(normalizeInteractiveText)
    .filter(Boolean)
    .join("\n");
  const match = combined.match(/https?:\/\/[^\s<>"')]+/i);
  return match ? match[0] : null;
}

export function parseWarpgateAuthCode(
  ...parts: Array<string | undefined | null>
): string | null {
  const combined = parts
    .map(normalizeInteractiveText)
    .filter(Boolean)
    .join("\n");
  const labeledMatch = combined.match(
    /(?:auth(?:entication)?|verification|security|device)?\s*code\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  );
  if (labeledMatch) {
    return labeledMatch[1];
  }
  const tokenMatch = combined.match(/([A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+)/i);
  return tokenMatch ? tokenMatch[1] : null;
}

export function isWarpgateCompletionPrompt(
  label: string,
  instruction: string,
): boolean {
  return /press enter when done|press enter to continue|once authorized|after authoriz|after logging in|after completing authentication|hit enter|return to continue/i.test(
    `${label}\n${instruction}`,
  );
}

export function isWarpgateCodePrompt(label: string, instruction: string): boolean {
  return (
    /code|verification|security|token|device/i.test(label) ||
    (/code/i.test(instruction) && !/press enter/i.test(label))
  );
}

export function shouldTreatAsWarpgate(
  host: HostRecord | undefined,
  challenge: KeyboardInteractiveChallenge,
): boolean {
  if (!host || !isWarpgateSshHostRecord(host)) {
    return false;
  }
  const sourceText = `${challenge.name ?? ""}\n${challenge.instruction}\n${challenge.prompts.map((prompt) => prompt.label).join("\n")}`;
  return /warpgate|authorize|device authorization|device code|verification code/i.test(
    sourceText,
  );
}

export function resolveInteractiveAuthUiState(
  host: HostRecord | undefined,
  challenge: KeyboardInteractiveChallenge,
): {
  provider: "generic" | "warpgate";
  approvalUrl: string | null;
  authCode: string | null;
  autoResponses: string[];
  autoSubmitted: boolean;
} {
  const isWarpgateChallenge = shouldTreatAsWarpgate(host, challenge);
  const approvalUrl = isWarpgateChallenge
    ? parseWarpgateApprovalUrl(
        challenge.instruction,
        challenge.name,
        ...challenge.prompts.map((prompt) => prompt.label),
      )
    : null;
  const authCode = isWarpgateChallenge
    ? parseWarpgateAuthCode(
        challenge.instruction,
        challenge.name,
        ...challenge.prompts.map((prompt) => prompt.label),
      )
    : null;
  const provider =
    isWarpgateChallenge && Boolean(approvalUrl || authCode)
      ? "warpgate"
      : "generic";

  const autoResponses: string[] = [];
  let canAutoRespond = challenge.prompts.length > 0;
  for (const prompt of challenge.prompts) {
    if (
      provider === "warpgate" &&
      authCode &&
      isWarpgateCodePrompt(prompt.label, challenge.instruction)
    ) {
      autoResponses.push(authCode);
      continue;
    }
    if (
      provider === "warpgate" &&
      isWarpgateCompletionPrompt(prompt.label, challenge.instruction)
    ) {
      autoResponses.push("");
      continue;
    }
    canAutoRespond = false;
    break;
  }

  return {
    provider,
    approvalUrl,
    authCode,
    autoResponses,
    autoSubmitted:
      canAutoRespond &&
      autoResponses.length === challenge.prompts.length &&
      challenge.prompts.length > 0,
  };
}

export function buildInteractiveBrowserChallengeKey(input: {
  sessionId?: string | null;
  endpointId?: string | null;
  challengeId: string;
  approvalUrl?: string | null;
}): string {
  const scopeId = normalizeInteractiveText(input.sessionId ?? input.endpointId);
  const approvalUrl = normalizeInteractiveText(input.approvalUrl);
  if (scopeId && approvalUrl) {
    return `${scopeId}::${approvalUrl}`;
  }
  if (scopeId) {
    return `${scopeId}::${input.challengeId}`;
  }
  if (approvalUrl) {
    return approvalUrl;
  }
  return input.challengeId;
}
