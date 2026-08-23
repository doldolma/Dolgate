import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from "@shared";

// 판정 규칙은 모바일도 써야 해서 shared-core 로 옮겼다. 가져다 쓰는 슬라이스가 여섯이라
// 여기서 다시 내보내 경로를 그대로 둔다.
export {
  isInteractiveOnlyAuthFailure,
  resolveCredentialRetryKind,
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

/**
 * 저장된 호스트 키와 서버가 내놓은 키가 다를 때의 오류인지.
 *
 * shared-core 의 resolveCredentialRetryKind 가 걸러내는 "호스트 키 문제" 전체보다 좁다 — 키를 교체하면
 * 풀리는 것만 잡는다. 미신뢰(아직 저장 안 됨)는 정상 경로의 probe 가 이미 프롬프트를 띄우고,
 * 알고리즘 협상 실패("no matching host key type")는 키를 교체해도 그대로라서 제외한다.
 */
export function isChangedHostKeyErrorMessage(message: string): boolean {
  return /host key mismatch|host key changed/i.test(message);
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
