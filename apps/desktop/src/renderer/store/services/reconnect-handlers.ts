// 재연결 오케스트레이터에 등록하는 타입별 핸들러.
//
// 엔진(reconnect-orchestrator)은 백오프/네트워크/상한만 담당하고, "무엇을 어떻게
// 재연결하고 UI를 어떻게 갱신할지"는 여기서 store 액션으로 구현한다.
// NetworkBridge가 마운트 시 registerReconnectHandlers()를 1회 호출한다.

import type { SftpPaneId, TerminalReconnectState } from "@shared";
import { appStore } from "../appStore";
import { createConnectionProgress, getPane, updatePaneState } from "../utils";
import { findPendingConnectionAttemptByHost } from "../utils/workspaces";
import {
  registerReconnectHandler,
  type ReconnectAttemptInfo,
} from "./reconnect-orchestrator";
import { t } from '../../i18n';

function reconnectSummary(info: ReconnectAttemptInfo): TerminalReconnectState {
  return {
    attempt: info.attempt,
    maxAttempts: info.maxAttempts,
    nextAttemptAt: info.nextAttemptAt,
    waitingForNetwork: info.waitingForNetwork,
  };
}

function reconnectMessage(info: ReconnectAttemptInfo): string {
  if (info.waitingForNetwork) {
    return t('reconnect.waitingNetwork');
  }
  return t('reconnect.reconnecting', { attempt: info.attempt, max: info.maxAttempts });
}

let registered = false;

export function registerReconnectHandlers(): void {
  if (registered) {
    return;
  }
  registered = true;

  // --- 터미널 세션 ---
  registerReconnectHandler("session", {
    renderScheduled(stableId, info) {
      appStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.stableId === stableId
            ? {
                ...tab,
                status: "connecting" as const,
                errorMessage: undefined,
                connectionProgress: createConnectionProgress(
                  "reconnecting",
                  reconnectMessage(info),
                ),
                reconnect: reconnectSummary(info),
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    },
    async perform(stableId) {
      const tab = appStore
        .getState()
        .tabs.find((item) => item.stableId === stableId);
      if (!tab) {
        return;
      }
      // retrySessionConnection이 새 pendingSessionId 발급 + 기존 세션 정리 +
      // stableId 보존 재연결을 수행한다. secrets는 메인의 런타임 캐시/keychain에서
      // 해석되므로 여기선 넘기지 않는다.
      await appStore.getState().retrySessionConnection(tab.sessionId);
    },
    renderGaveUp(stableId, info) {
      const message = t('reconnect.failed', { attempts: info.attempts });
      appStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.stableId === stableId
            ? {
                ...tab,
                status: "error" as const,
                errorMessage: message,
                connectionProgress: createConnectionProgress(
                  "reconnecting",
                  message,
                  { retryable: true },
                ),
                reconnect: null,
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    },
    isStillPresent(stableId) {
      return appStore
        .getState()
        .tabs.some((item) => item.stableId === stableId);
    },
  });

  // --- RDP 세션 (key = stableId) ---
  //
  // 터미널과 나뉘어 있는 이유: 그쪽 perform 은 ssh-core 로 가는 retrySessionConnection 을 부른다.
  // 백오프·상한·홀드는 같은 엔진을 그대로 쓴다.
  registerReconnectHandler("rdp", {
    renderScheduled(stableId, info) {
      appStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.stableId === stableId
            ? {
                ...tab,
                status: "connecting" as const,
                errorMessage: undefined,
                connectionProgress: createConnectionProgress(
                  "reconnecting",
                  reconnectMessage(info),
                ),
                reconnect: reconnectSummary(info),
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    },
    async perform(stableId) {
      const tab = appStore
        .getState()
        .tabs.find((item) => item.stableId === stableId);
      if (!tab) {
        return;
      }
      // 같은 탭에 다시 붙는다(stableId 유지). 새 탭을 만들면 이 재연결의 시도 횟수를 잃는다.
      await appStore.getState().retryRdpConnection(tab.sessionId);
    },
    renderGaveUp(stableId, info) {
      const message = t('reconnect.failed', { attempts: info.attempts });
      appStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.stableId === stableId
            ? {
                ...tab,
                status: "error" as const,
                errorMessage: message,
                connectionProgress: createConnectionProgress(
                  "reconnecting",
                  message,
                  { retryable: true },
                ),
                reconnect: null,
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    },
    isStillPresent(stableId) {
      return appStore
        .getState()
        .tabs.some((item) => item.stableId === stableId);
    },
  });

  // --- VNC 세션 (key = stableId) ---
  //
  // RDP 와 같은 모양이고 perform 만 다르다(vnc-core 로 가는 retryVncConnection). 백오프·상한·
  // 홀드는 같은 엔진을 그대로 쓴다 — 재연결 규칙이 종류마다 갈리면 어느 것이 맞는지 알 수 없다.
  registerReconnectHandler("vnc", {
    renderScheduled(stableId, info) {
      appStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.stableId === stableId
            ? {
                ...tab,
                status: "connecting" as const,
                errorMessage: undefined,
                connectionProgress: createConnectionProgress(
                  "reconnecting",
                  reconnectMessage(info),
                ),
                reconnect: reconnectSummary(info),
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    },
    async perform(stableId) {
      const tab = appStore
        .getState()
        .tabs.find((item) => item.stableId === stableId);
      if (!tab) {
        return;
      }
      // 같은 탭에 다시 붙는다(stableId 유지). 새 탭을 만들면 이 재연결의 시도 횟수를 잃는다.
      await appStore.getState().retryVncConnection(tab.sessionId);
    },
    renderGaveUp(stableId, info) {
      const message = t('reconnect.failed', { attempts: info.attempts });
      appStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.stableId === stableId
            ? {
                ...tab,
                status: "error" as const,
                errorMessage: message,
                connectionProgress: createConnectionProgress(
                  "reconnecting",
                  message,
                  { retryable: true },
                ),
                reconnect: null,
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    },
    isStillPresent(stableId) {
      return appStore
        .getState()
        .tabs.some((item) => item.stableId === stableId);
    },
  });

  // --- SFTP (key = paneId 'left'|'right', meta.hostId) ---
  registerReconnectHandler("sftp", {
    renderScheduled(paneId, info) {
      const id = paneId as SftpPaneId;
      appStore.setState((state) => {
        const pane = getPane(state, id);
        if (!pane) {
          return {};
        }
        return {
          sftp: updatePaneState(state, id, {
            ...pane,
            errorMessage: info.waitingForNetwork
              ? t('reconnect.waitingNetworkShort')
              : t('reconnect.reconnecting', { attempt: info.attempt, max: info.maxAttempts }),
          }),
        };
      });
    },
    async perform(paneId, meta) {
      const hostId = typeof meta.hostId === "string" ? meta.hostId : null;
      if (!hostId) {
        return;
      }
      await appStore.getState().connectSftpHost(paneId as SftpPaneId, hostId);
    },
    renderGaveUp(paneId, info) {
      const id = paneId as SftpPaneId;
      const message = t('reconnect.sftpFailed', { attempts: info.attempts });
      appStore.setState((state) => {
        const pane = getPane(state, id);
        if (!pane) {
          return {};
        }
        return {
          sftp: updatePaneState(state, id, {
            ...pane,
            errorMessage: message,
          }),
        };
      });
    },
    isStillPresent(paneId, meta) {
      const hostId = typeof meta.hostId === "string" ? meta.hostId : null;
      return Boolean(getPane(appStore.getState(), paneId as SftpPaneId) && hostId);
    },
  });

  // --- 포트포워딩 (key = ruleId) ---
  registerReconnectHandler("portForward", {
    renderScheduled(ruleId, info) {
      appStore.setState((state) => {
        const runtime = state.portForwardRuntimes.find(
          (item) => item.ruleId === ruleId,
        );
        if (!runtime) {
          return {};
        }
        return {
          portForwardRuntimes: state.portForwardRuntimes.map((item) =>
            item.ruleId === ruleId
              ? {
                  ...item,
                  status: "starting" as const,
                  message: info.waitingForNetwork
                    ? t('reconnect.waitingNetworkBadge')
                    : t('reconnect.reconnectingShort', { attempt: info.attempt, max: info.maxAttempts }),
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        };
      });
    },
    async perform(ruleId) {
      await appStore.getState().startPortForward(ruleId);
    },
    renderGaveUp(ruleId, info) {
      appStore.setState((state) => ({
        portForwardRuntimes: state.portForwardRuntimes.map((item) =>
          item.ruleId === ruleId
            ? {
                ...item,
                status: "error" as const,
                message: t('reconnect.failedBadge', { attempts: info.attempts }),
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      }));
    },
    isStillPresent(ruleId) {
      return appStore
        .getState()
        .portForwards.some((rule) => rule.id === ruleId);
    },
  });

  // --- tmux control 세션 (key = group.id, meta.hostId) ---
  // control 세션은 그룹 형성 시 탭이 사라져 tab 기반 재연결을 못 탄다. 그룹 단위로
  // 재연결하고, 새 control 세션이 붙으면 handleTmuxLayoutChange 가 windowId 기준으로
  // 그룹/워크스페이스/패인을 새 controlSessionId 로 rebind 한다(stable pane id 로 xterm 유지).
  registerReconnectHandler("tmux", {
    renderScheduled(groupId, info) {
      appStore
        .getState()
        .applyTmuxGroupReconnecting(
          groupId,
          reconnectSummary(info),
          reconnectMessage(info),
        );
    },
    async perform(groupId, meta) {
      const hostId = typeof meta.hostId === "string" ? meta.hostId : null;
      if (!hostId) {
        return;
      }
      const group = appStore
        .getState()
        .tmuxGroups.find((g) => g.id === groupId);
      if (!group) {
        return;
      }
      // 직전 시도가 만든(실패해 그룹에 흡수되지 않은) control 탭/attempt 를 먼저 정리한다.
      // 재연결 control 은 reconnectGroupId 경로라 tabStrip 엔 없어 화면엔 안 보이지만,
      // 진행/이벤트용으로 tabs 에 남으므로 누적되지 않게 직전 것을 제거한다.
      const prior = group.reconnectSessionId ?? undefined;
      if (prior) {
        appStore.setState((state) => ({
          tabs: state.tabs.filter((t) => t.sessionId !== prior),
          pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
            (a) => a.sessionId !== prior,
          ),
        }));
      }
      // reconnectGroupId(=groupId) 를 넘겨 새 control 세션을 standalone 탭으로 만들지 않고,
      // 그룹에 흡수될 때까지 화면 밖(tabs/pending)에만 둔다 → 시도마다 별도 SSH 탭이
      // 보이거나 쌓이지 않는다. tmuxCommand 생략 → Go 가 attach-우선 기본 명령으로 살아있는
      // 서버 세션에 재attach. cols/rows 는 기본값; 패인 mount 후 일반 resize 흐름이 실제
      // 크기로 재동기화한다.
      await appStore
        .getState()
        .connectHost(
          hostId,
          120,
          32,
          undefined,
          true,
          undefined,
          undefined,
          groupId,
          // 처음 띄울 때 감지한 버전을 재연결에도 넘긴다(구버전 입력 인코딩 유지).
          group.tmuxVersion ?? undefined,
        );
      // 이번 시도가 만든 control 세션 id 를 기록(다음 시도 시작 시 정리용).
      const attempt = findPendingConnectionAttemptByHost(
        appStore.getState(),
        hostId,
      );
      appStore.setState((state) => ({
        tmuxGroups: state.tmuxGroups.map((g) =>
          g.id === groupId
            ? { ...g, reconnectSessionId: attempt?.sessionId ?? null }
            : g,
        ),
      }));
    },
    renderGaveUp(groupId, info) {
      const message = t('reconnect.tmuxFailed', { attempts: info.attempts });
      appStore.getState().applyTmuxGroupReconnectGaveUp(groupId, message);
    },
    isStillPresent(groupId) {
      return appStore.getState().tmuxGroups.some((g) => g.id === groupId);
    },
  });
}
