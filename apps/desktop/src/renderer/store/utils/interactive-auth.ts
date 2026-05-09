import { isWarpgateSshHostRecord } from "@shared";
import type { HostRecord, KeyboardInteractiveChallenge } from "@shared";
import type {
  PendingContainersInteractiveAuth,
  PendingInteractiveAuth,
  PendingPortForwardInteractiveAuth,
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

export function isPendingPortForwardInteractiveAuth(
  pending: PendingInteractiveAuth | null,
): pending is PendingPortForwardInteractiveAuth {
  return pending?.source === "portForward";
}

export function normalizeInteractiveText(value: string | undefined | null): string {
  return (value ?? "").trim();
}

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
