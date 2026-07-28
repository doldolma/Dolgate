import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from "@shared";
import type {
  HostRecord,
  SftpConnectionStage,
  TerminalConnectionProgress,
} from "@shared";
import type { StoreApi } from "zustand";
import type { AppState } from "../types";
import { createConnectionProgress } from "./errors-and-prompts";
import { getPane, resolveSftpPaneIdByEndpoint, updatePaneState } from "./sftp";
import { t } from '../../i18n';

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

  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
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
    t('connectProgress.hostKeyChecking', { label: host.label }),
  );
}

export function resolveAwaitingHostTrustProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "awaiting-host-trust",
    t('connectProgress.hostKeyNeeded', { label: host.label }),
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
      t('connectProgress.ssmStarting', { label: host.label }),
    );
  }
  if (isWarpgateSshHostRecord(host)) {
    return createConnectionProgress(
      "connecting",
      t('connectProgress.warpgateConnecting', { label: host.label }),
    );
  }
  if (host.kind === "serial") {
    return createConnectionProgress(
      "connecting",
      t('connectProgress.serialConnecting', { label: host.label }),
    );
  }
  return createConnectionProgress(
    "connecting",
    t('connectProgress.sshConnecting', { label: host.label }),
  );
}

export function resolveLocalStartingProgress(): TerminalConnectionProgress {
  return createConnectionProgress(
    "connecting",
    t('connectProgress.localStarting'),
  );
}

export function resolveWaitingShellProgress(
  host: HostRecord,
): TerminalConnectionProgress {
  return createConnectionProgress(
    "waiting-shell",
    t('connectProgress.waitingFirstOutput', { label: host.label }),
  );
}

export function resolveLocalWaitingShellProgress(): TerminalConnectionProgress {
  return createConnectionProgress("waiting-shell", t('connectProgress.waitingShell'));
}

export function resolveCredentialRetryProgress(
  host: HostRecord,
  _credentialKind?: "auth",
): TerminalConnectionProgress {
  return createConnectionProgress(
    "awaiting-credentials",
    t('connectProgress.credentialRetry', { label: host.label }),
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

/**
 * tailnet 노드가 올라오는 동안의 진행 상태.
 *
 * 무엇을 기다리는지가 매번 다르다 — 링크를 받는 중인지, 사람이 브라우저에서 로그인해야 하는지,
 * 관리자 승인을 기다리는지. 문구를 만드는 곳을 한 군데로 모아 둔다.
 */
export function resolveTailnetProgress(
  tailnetLabel: string,
  waiting: 'connecting' | 'preparingAuth' | 'needsAuth' | 'verifyingAuth' | 'needsApproval',
): TerminalConnectionProgress {
  const messages = {
    connecting: 'connectProgress.tailnetConnecting',
    preparingAuth: 'connectProgress.tailnetPreparingAuth',
    needsAuth: 'connectProgress.tailnetNeedsAuth',
    verifyingAuth: 'connectProgress.tailnetVerifyingAuth',
    needsApproval: 'connectProgress.tailnetNeedsApproval',
  } as const;
  return createConnectionProgress(
    "tailnet-connecting",
    t(messages[waiting], { label: tailnetLabel }),
    // 사람이 브라우저에서 할 일이 있는 단계만 차단으로 표시한다 — AWS SSO 로그인과 같은 취급.
    { blockingKind: waiting === 'needsAuth' ? 'browser' : 'none' },
  );
}

/**
 * 연결 진행을 그 연결이 보이는 곳에 반영한다.
 *
 * 소비자마다 진행을 담는 자리가 다르다 — 터미널은 탭(sessionId), SFTP 는 패인(endpointId),
 * 컨테이너는 컨테이너 탭(hostId). 알리는 쪽마다 그 자리를 찾게 두면 호출부가 늘어날 때마다
 * 하나씩 빠뜨린다. 여기 한 곳에서 처리한다.
 */
export function applyConnectionProgress(
  set: StoreApi<AppState>["setState"],
  target: { sessionId?: string | null; endpointId?: string | null; hostId: string },
  progress: TerminalConnectionProgress,
): void {
  set((state) => {
    const next: Partial<AppState> = {};

    if (target.sessionId && state.tabs.some((tab) => tab.sessionId === target.sessionId)) {
      next.tabs = state.tabs.map((tab) =>
        tab.sessionId === target.sessionId ? { ...tab, connectionProgress: progress } : tab,
      );
    }

    if (target.endpointId) {
      const endpointId = target.endpointId;
      const paneId = resolveSftpPaneIdByEndpoint(state, endpointId);
      if (paneId) {
        // SFTP·컨테이너 진행 이벤트는 blockingKind/retryable 을 담지 않는다.
        next.sftp = updatePaneState(state, paneId, {
          ...getPane(state, paneId),
          connectionProgress: {
            hostId: target.hostId,
            endpointId,
            stage: progress.stage as SftpConnectionStage,
            message: progress.message,
          },
        });
      }
      if (state.containerTabs.some((tab) => tab.hostId === target.hostId)) {
        next.containerTabs = state.containerTabs.map((tab) =>
          tab.hostId === target.hostId
            ? {
                ...tab,
                connectionProgress: {
                  hostId: target.hostId,
                  endpointId,
                  stage: progress.stage as SftpConnectionStage,
                  message: progress.message,
                },
              }
            : tab,
        );
      }
    }

    return next;
  });
}
