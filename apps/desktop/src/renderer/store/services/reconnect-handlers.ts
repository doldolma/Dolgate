// 재연결 오케스트레이터에 등록하는 타입별 핸들러.
//
// 엔진(reconnect-orchestrator)은 백오프/네트워크/상한만 담당하고, "무엇을 어떻게
// 재연결하고 UI를 어떻게 갱신할지"는 여기서 store 액션으로 구현한다.
// NetworkBridge가 마운트 시 registerReconnectHandlers()를 1회 호출한다.

import type { SftpPaneId, TerminalReconnectState } from "@shared";
import { appStore } from "../appStore";
import { createConnectionProgress, getPane, updatePaneState } from "../utils";
import {
  registerReconnectHandler,
  type ReconnectAttemptInfo,
} from "./reconnect-orchestrator";

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
    return "네트워크 대기 중입니다. 연결이 복구되면 재연결합니다.";
  }
  return `연결이 끊겨 재연결 중입니다… (시도 ${info.attempt}/${info.maxAttempts})`;
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
      const message = `재연결에 실패했습니다 (${info.attempts}회 시도). 수동으로 다시 연결해 주세요.`;
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
              ? "네트워크 대기 중입니다. 복구되면 재연결합니다."
              : `연결이 끊겨 재연결 중입니다… (시도 ${info.attempt}/${info.maxAttempts})`,
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
      const message = `SFTP 재연결에 실패했습니다 (${info.attempts}회 시도). 다시 연결해 주세요.`;
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
                    ? "네트워크 대기 중"
                    : `재연결 중… (${info.attempt}/${info.maxAttempts})`,
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
                message: `재연결 실패 (${info.attempts}회 시도)`,
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
}
