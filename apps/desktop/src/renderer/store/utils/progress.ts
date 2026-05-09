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
