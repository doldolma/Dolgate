import { isRdpCredentialFailure, isSshHostRecord, isVncCredentialFailure } from "@shared";
import type { AuthType, ConnectCredentialsNeeded, HostRecord, VaultIndex, VncCredentialFailure } from "@shared";
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
 *
 * tunnelFor 는 SSH 터널로 가는 VNC 호스트의 이름이다 — 그때 hostId 는 SSH 터널 호스트이고, 문구는 VNC 비밀번호가
 * 아님을 말한다.
 */
export function buildHopCredentialRetry(input: {
  hosts: readonly HostRecord[];
  vaultIndex: VaultIndex | null | undefined;
  hostId: string;
  needed: ConnectCredentialsNeeded;
  source: PendingCredentialRetry["source"];
  sessionId?: string | null;
  paneId?: PendingCredentialRetry["paneId"];
  ruleId?: string;
  containerId?: string;
  tunnelFor?: string;
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
        ? t("credentialRetry.jumpPasswordNeeded", {
            label: promptHost.label,
            target: input.tunnelFor ?? target?.label ?? "",
          })
        : input.tunnelFor
          ? t("credentialRetry.tunnelPasswordNeeded", { label: promptHost.label, target: input.tunnelFor })
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
    ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    ...(input.containerId ? { containerId: input.containerId } : {}),
    ...(input.carried ? { carried: input.carried } : {}),
  };
}

/** 계정까지 묻는 VNC 실패(macOS 화면 공유처럼 계정으로 로그인하는 서버). */
export function vncFailureAsksAccount(failure: VncCredentialFailure): boolean {
  return failure === "account-required" || failure === "account-auth-rejected";
}

/**
 * VNC 서버가 계정·비밀번호를 요구하거나 거절했다(메인의 credentialsNeeded 가 VNC 호스트 자신을 가리킨다)를 요청 창 요청으로 바꾼다.
 *
 * 넣은 값은 SSH 터널 자리가 아니라 VNC 자리로 가고(vncFailure), 문구는 까닭마다 다르다. 앞선 시도의 값은 싣지 않는다 — 여기까지
 * 왔으면 터널은 이미 열렸고 넣은 터널 값은 그때 저장됐다. 계정은 그 시도에서 쓴 것을 미리 채운다.
 */
export function buildVncCredentialRetry(input: {
  host: HostRecord;
  needed: ConnectCredentialsNeeded;
  sessionId: string;
}): PendingCredentialRetry | null {
  const failure = input.needed.failure;
  if (input.host.kind !== "vnc" || input.needed.hostId !== input.host.id || !isVncCredentialFailure(failure)) {
    return null;
  }
  const label = input.host.label;
  const message =
    failure === "password-required"
      ? t("credentialRetry.vncPasswordNeeded", { label })
      : failure === "password-truncated"
        ? t("credentialRetry.vncPasswordTruncated")
        : failure === "account-required"
          ? t("credentialRetry.vncAccountNeeded", { label })
          : failure === "account-auth-rejected"
            ? t("credentialRetry.vncAccountRejected")
            : t("credentialRetry.vncPasswordRejected");
  return {
    requestId: globalThis.crypto.randomUUID(),
    sessionId: input.sessionId,
    hostId: input.host.id,
    source: "vnc",
    authType: "password",
    message,
    initialUsername: input.needed.username ?? "",
    vncFailure: failure,
  };
}

/**
 * RDP 서버가 NLA 로 비밀번호를 요구하는데 없거나 넣은 값을 거절했다(메인의 credentialsNeeded 가 RDP 호스트 자신을 가리킨다)를
 * 요청 창 요청으로 바꾼다.
 *
 * 창은 계정·비밀번호·도메인을 함께 묻는다 — Windows 계정은 셋이 한 묶음이다. 그 시도에서 쓴 계정·도메인을 미리 채운다.
 */
export function buildRdpCredentialRetry(input: {
  host: HostRecord;
  needed: ConnectCredentialsNeeded;
  sessionId: string;
}): PendingCredentialRetry | null {
  const failure = input.needed.failure;
  if (input.host.kind !== "rdp" || input.needed.hostId !== input.host.id || !isRdpCredentialFailure(failure)) {
    return null;
  }
  return {
    requestId: globalThis.crypto.randomUUID(),
    sessionId: input.sessionId,
    hostId: input.host.id,
    source: "rdp",
    authType: "password",
    message:
      failure === "password-required"
        ? t("credentialRetry.rdpCredentialsNeeded", { label: input.host.label })
        : t("credentialRetry.rdpCredentialsRejected"),
    initialUsername: input.needed.username ?? "",
    initialDomain: input.needed.domain ?? "",
    rdpFailure: failure,
  };
}
