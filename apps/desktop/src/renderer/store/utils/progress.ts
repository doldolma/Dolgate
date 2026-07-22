import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from "@shared";
import type { HostRecord, TerminalConnectionProgress } from "@shared";
import { createConnectionProgress } from "./errors-and-prompts";

export function resolveCredentialRetryKind(
  host: HostRecord | undefined,
  message: string,
): "auth" | null {
  if (!host || !isSshHostRecord(host)) {
    return null;
  }

  // 호스트 키 문제(불일치/미신뢰/협상 실패)는 인증(비밀번호·키) 문제가 아니라 신뢰 문제다.
  // 이런 에러 메시지엔 "ssh handshake failed"가 함께 붙는 경우가 많아, 아래 auth 패턴 검사
  // 이전에 먼저 걸러야 한다. 안 그러면 host key mismatch가 계정/비밀번호 재입력 다이얼로그를
  // 잘못 띄운다(그 입력으로는 절대 해결되지 않음 — 호스트 키 신뢰/교체 플로우가 처리할 몫).
  if (
    /host key mismatch|trusted host key|host key is not trusted|no matching host key|no common host key/i.test(
      message,
    )
  ) {
    return null;
  }

  if (host.authType === "keyboardInteractive") {
    return null;
  }

  if (host.authType === "password") {
    return /requires a password|password required|permission denied|unable to authenticate|authentication failed|ssh handshake failed|unexpected message type 51/i.test(
      message,
    )
      ? "auth"
      : null;
  }

  return /passphrase|private key|certificate|인증서|valid after|expired on|not valid before|unable to authenticate|authentication failed|ssh handshake failed|unexpected message type 51|parse private key/i.test(
    message,
  )
    ? "auth"
    : null;
}

export function shouldPromptAwsSftpConfigRetry(
  host: HostRecord | undefined,
  message: string,
): boolean {
  if (!host || !isAwsEc2HostRecord(host)) {
    return false;
  }
  if (!(host.awsSshUsername ?? "").trim()) {
    return true;
  }
  return /instanceosuser|os user|ssh username|authentication failed|unable to authenticate|ssh handshake failed|permission denied|connection refused|timed out/i.test(
    message,
  );
}

export function resolveHostKeyCheckProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "host-key-check",
    `${host.label} 호스트 키를 확인하는 중입니다.`,
  );
}

export function resolveAwaitingHostTrustProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "awaiting-host-trust",
    `${host.label} 호스트 키 확인이 필요합니다.`,
    {
      blockingKind: "dialog",
    },
  );
}

export function resolveConnectingProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  if (isAwsEc2HostRecord(host)) {
    return createConnectionProgress(
      "connecting",
      `${host.label} SSM 세션을 시작하는 중입니다.`,
    );
  }
  if (isWarpgateSshHostRecord(host)) {
    return createConnectionProgress(
      "connecting",
      `${host.label} Warpgate SSH 세션을 연결하는 중입니다.`,
    );
  }
  if (host.kind === "serial") {
    return createConnectionProgress(
      "connecting",
      `${host.label} Serial 세션을 연결하는 중입니다.`,
    );
  }
  return createConnectionProgress(
    "connecting",
    `${host.label} SSH 세션을 연결하는 중입니다.`,
  );
}

export function resolveLocalStartingProgress(): TerminalConnectionProgress {
  return createConnectionProgress(
    "connecting",
    "로컬 터미널을 시작하는 중입니다.",
  );
}

export function resolveWaitingShellProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "waiting-shell",
    `${host.label} 원격 셸이 첫 출력을 보내는 중입니다.`,
  );
}

export function resolveLocalWaitingShellProgress(): TerminalConnectionProgress {
  return createConnectionProgress("waiting-shell", "셸이 준비되는 중입니다.");
}

export function resolveCredentialRetryProgress(
  host: HostRecord,
  _credentialKind?: "auth",
): TerminalConnectionProgress {
  return createConnectionProgress(
    "awaiting-credentials",
    `${host.label} 인증 정보를 다시 확인해 주세요.`,
    {
      blockingKind: "dialog",
      retryable: true,
    },
  );
}

export function resolveErrorProgress(
  message: string,
  retryable = true,
): TerminalConnectionProgress {
  return createConnectionProgress("connecting", message, {
    retryable,
  });
}
