import { useCallback, useMemo } from 'react';
import type { SessionShareChatMessage, TerminalTab } from '@shared';
import type {
  PendingSessionInteractiveAuth,
  WorkspaceTab,
} from '../store/createAppStore';
import { useAppStore } from '../store/appStore';
import { findSessionPendingInteractiveAuth } from '../store/utils';
import {
  resizeTerminal,
  subscribeToTerminalData,
  writeTerminalBinaryInput,
  writeTerminalInput,
} from '../services/desktop/terminal';
import { listWorkspaceSessionIds } from '../components/terminal-workspace/terminalWorkspaceLayout';

interface UseTerminalWorkspaceControllerInput {
  activeWorkspace: WorkspaceTab | null;
  tabs: TerminalTab[];
}

const EMPTY_SESSION_SHARE_CHAT_NOTIFICATIONS: SessionShareChatMessage[] = [];

function isConnectedHostSession(tab: TerminalTab | undefined): boolean {
  return tab?.source === 'host' && tab.status === 'connected';
}

function isPendingConnectionSessionId(sessionId: string): boolean {
  return sessionId.startsWith('pending:');
}

export function useTerminalWorkspaceController({
  activeWorkspace,
  tabs,
}: UseTerminalWorkspaceControllerInput) {
  const pendingInteractiveAuths = useAppStore(
    (state) => state.pendingInteractiveAuths,
  );
  const respondInteractiveAuth = useAppStore((state) => state.respondInteractiveAuth);
  const reopenInteractiveAuthUrl = useAppStore(
    (state) => state.reopenInteractiveAuthUrl,
  );
  const clearPendingInteractiveAuth = useAppStore(
    (state) => state.clearPendingInteractiveAuth,
  );
  const updatePendingConnectionSize = useAppStore(
    (state) => state.updatePendingConnectionSize,
  );
  const markSessionOutput = useAppStore((state) => state.markSessionOutput);
  const sessionShareChatNotifications = useAppStore(
    (state) => state.sessionShareChatNotifications ?? {},
  );
  const dismissSessionShareChatNotification = useAppStore(
    (state) => state.dismissSessionShareChatNotification,
  );

  const tabsBySessionId = useMemo(
    () => new Map(tabs.map((tab) => [tab.sessionId, tab])),
    [tabs],
  );

  const connectedWorkspaceHostSessionIds = useMemo(() => {
    if (!activeWorkspace) {
      return [];
    }

    return listWorkspaceSessionIds(activeWorkspace.layout).filter((sessionId) =>
      isConnectedHostSession(tabsBySessionId.get(sessionId)),
    );
  }, [activeWorkspace, tabsBySessionId]);

  // 브로드캐스트 대상 = 연결된 host pane 중 사용자가 뺀 것을 제외한 나머지.
  // 상태는 "제외 목록"만 들고 있고(WorkspaceTab.broadcastExcludedSessionIds), 연결 여부는
  // 수시로 바뀌므로 전송 직전에 여기서 다시 거른다.
  const broadcastSessionIds = useMemo(() => {
    if (!activeWorkspace?.broadcastEnabled) {
      return [] as string[];
    }
    const excluded = activeWorkspace.broadcastExcludedSessionIds ?? [];
    return connectedWorkspaceHostSessionIds.filter(
      (sessionId) => !excluded.includes(sessionId),
    );
  }, [activeWorkspace, connectedWorkspaceHostSessionIds]);

  const getInteractiveAuth = useCallback(
    (sessionId: string): PendingSessionInteractiveAuth | null => {
      // 이 탭의 것만 고른다. 다른 탭·SFTP 의 인증 요청이 이 카드를 밀어내지 않는다.
      return findSessionPendingInteractiveAuth(pendingInteractiveAuths, sessionId);
    },
    [pendingInteractiveAuths],
  );

  const getSessionShareChatNotifications = useCallback(
    (sessionId: string): SessionShareChatMessage[] =>
      sessionShareChatNotifications[sessionId] ??
      EMPTY_SESSION_SHARE_CHAT_NOTIFICATIONS,
    [sessionShareChatNotifications],
  );

  const onSessionData = useCallback(
    (sessionId: string, listener: (chunk: Uint8Array) => void) =>
      subscribeToTerminalData(sessionId, (chunk) => {
        if (chunk.byteLength > 0) {
          markSessionOutput(sessionId, chunk);
        }
        listener(chunk);
      }),
    [markSessionOutput],
  );

  const onResizeSession = useCallback(
    (sessionId: string, cols: number, rows: number) => {
      if (isPendingConnectionSessionId(sessionId)) {
        updatePendingConnectionSize(sessionId, cols, rows);
        return Promise.resolve();
      }

      return resizeTerminal(sessionId, cols, rows);
    },
    [updatePendingConnectionSize],
  );

  const sendSessionInput = useCallback(
    (sourceSessionId: string, data: string) => {
      void Promise.resolve(writeTerminalInput(sourceSessionId, data)).catch(
        () => undefined,
      );

      // 입력한 pane 이 참여 중이 아니면 퍼뜨리지 않는다 — 브로드캐스트에서 뺀 pane 에서
      // 친 것까지 나가면 "빼 놨는데 왜 같이 가지"가 된다.
      if (
        broadcastSessionIds.length < 2 ||
        !broadcastSessionIds.includes(sourceSessionId)
      ) {
        return;
      }

      for (const targetSessionId of broadcastSessionIds) {
        if (targetSessionId === sourceSessionId) {
          continue;
        }

        void Promise.resolve(writeTerminalInput(targetSessionId, data)).catch(
          () => undefined,
        );
      }
    },
    [broadcastSessionIds],
  );

  const sendSessionBinaryInput = useCallback(
    (sourceSessionId: string, data: Uint8Array) => {
      void Promise.resolve(
        writeTerminalBinaryInput(sourceSessionId, data.slice()),
      ).catch(() => undefined);

      // 입력한 pane 이 참여 중이 아니면 퍼뜨리지 않는다 — 브로드캐스트에서 뺀 pane 에서
      // 친 것까지 나가면 "빼 놨는데 왜 같이 가지"가 된다.
      if (
        broadcastSessionIds.length < 2 ||
        !broadcastSessionIds.includes(sourceSessionId)
      ) {
        return;
      }

      for (const targetSessionId of broadcastSessionIds) {
        if (targetSessionId === sourceSessionId) {
          continue;
        }

        void Promise.resolve(
          writeTerminalBinaryInput(targetSessionId, data.slice()),
        ).catch(() => undefined);
      }
    },
    [broadcastSessionIds],
  );

  return useMemo(
    () => ({
      tabsBySessionId,
      getInteractiveAuth,
      getSessionShareChatNotifications,
      respondInteractiveAuth,
      reopenInteractiveAuthUrl,
      clearPendingInteractiveAuth,
      dismissSessionShareChatNotification,
      onSessionData,
      onResizeSession,
      sendSessionInput,
      sendSessionBinaryInput,
    }),
    [
      clearPendingInteractiveAuth,
      dismissSessionShareChatNotification,
      getInteractiveAuth,
      getSessionShareChatNotifications,
      onResizeSession,
      onSessionData,
      reopenInteractiveAuthUrl,
      respondInteractiveAuth,
      sendSessionBinaryInput,
      sendSessionInput,
      tabsBySessionId,
    ],
  );
}
