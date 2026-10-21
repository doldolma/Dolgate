import { isSshHostRecord } from "@shared";
import type { AuthType, ConnectCredentialsNeeded, HostRecord, VaultIndex } from "@shared";
import { t } from "../../i18n";
import type { ConnectAttemptSecrets, PendingCredentialRetry } from "../types";
import { myUsernameOf } from "./vaults";

/** 요청 창이 다룰 수 있는 인증 방식으로(에이전트·대화형 등은 비밀번호 칸으로 묻는다 — 지금까지와 같다). */
export function credentialRetryAuthType(
  authType: AuthType,
): PendingCredentialRetry["authType"] {
  return authType === "certificate" ? "certificate" : authType === "privateKey" ? "privateKey" : "password";
}

/**
 * "이 호스트의 자격 증명이 있어야 붙는다"(메인의 붙기 전 검사·점프 홉의 거절)를 요청 창 요청으로 바꾼다.
 *
 * 묻는 호스트가 대상의 점프 호스트면 창은 그 호스트(제목·사용자 이름·인증 방식)로 뜨고, 넣은 값은 그 홉
 * 자리로 간다(promptHostId). 앞서 넣은 값(carried)은 다음 시도에 함께 보낸다.
 */
export function buildHopCredentialRetry(input: {
  hosts: readonly HostRecord[];
  vaultIndex: VaultIndex | null | undefined;
  hostId: string;
  needed: ConnectCredentialsNeeded;
  source: PendingCredentialRetry["source"];
  sessionId?: string | null;
  paneId?: PendingCredentialRetry["paneId"];
  carried?: ConnectAttemptSecrets;
}): PendingCredentialRetry | null {
  const promptHost = input.hosts.find((host) => host.id === input.needed.hostId);
  if (!promptHost || !isSshHostRecord(promptHost)) {
    return null;
  }
  const target = input.hosts.find((host) => host.id === input.hostId);
  const isJumpHop = input.needed.hostId !== input.hostId;
  const message =
    input.needed.reason === "missing"
      ? isJumpHop
        ? t("credentialRetry.jumpPasswordNeeded", { label: promptHost.label, target: target?.label ?? "" })
        : t("credentialRetry.passwordNeeded", { label: promptHost.label })
      : (input.needed.message ?? "");
  return {
    requestId: globalThis.crypto.randomUUID(),
    sessionId: input.sessionId ?? null,
    hostId: input.hostId,
    promptHostId: isJumpHop ? promptHost.id : undefined,
    source: input.source,
    // 붙기 전 검사는 비밀번호 방식에서만 "없음"을 알린다.
    authType: input.needed.reason === "missing" ? "password" : credentialRetryAuthType(promptHost.authType),
    message,
    initialUsername: myUsernameOf(input.vaultIndex, promptHost.id) ?? promptHost.username,
    ...(input.paneId ? { paneId: input.paneId } : {}),
    ...(input.carried ? { carried: input.carried } : {}),
  };
}
