import { useCallback, useMemo } from 'react';
import type { SessionShareChatMessage, TerminalTab } from '@shared';
import type {
  PendingSessionInteractiveAuth,
  WorkspaceTab,
} from '../store/createAppStore';
import { useAppStore } from '../store/appStore';
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
  const pendingInteractiveAuth = useAppStore((state) => state.pendingInteractiveAuth);
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

  const getInteractiveAuth = useCallback(
    (sessionId: string): PendingSessionInteractiveAuth | null => {
      if (
        pendingInteractiveAuth?.source === 'ssh' &&
        pendingInteractiveAuth.sessionId === sessionId
      ) {
        return pendingInteractiveAuth;
      }

      return null;
    },
    [pendingInteractiveAuth],
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

      if (
        !activeWorkspace ||
        !activeWorkspace.broadcastEnabled ||
        activeWorkspace.activeSessionId !== sourceSessionId
      ) {
        return;
      }

      const sourceTab = tabsBySessionId.get(sourceSessionId);
      if (
        !isConnectedHostSession(sourceTab) ||
        connectedWorkspaceHostSessionIds.length < 2
      ) {
        return;
      }

      for (const targetSessionId of connectedWorkspaceHostSessionIds) {
        if (targetSessionId === sourceSessionId) {
          continue;
        }

        void Promise.resolve(writeTerminalInput(targetSessionId, data)).catch(
          () => undefined,
        );
      }
    },
    [activeWorkspace, connectedWorkspaceHostSessionIds, tabsBySessionId],
  );

  const sendSessionBinaryInput = useCallback(
    (sourceSessionId: string, data: Uint8Array) => {
      void Promise.resolve(
        writeTerminalBinaryInput(sourceSessionId, data.slice()),
      ).catch(() => undefined);

      if (
        !activeWorkspace ||
        !activeWorkspace.broadcastEnabled ||
        activeWorkspace.activeSessionId !== sourceSessionId
      ) {
        return;
      }

      const sourceTab = tabsBySessionId.get(sourceSessionId);
      if (
        !isConnectedHostSession(sourceTab) ||
        connectedWorkspaceHostSessionIds.length < 2
      ) {
        return;
      }

      for (const targetSessionId of connectedWorkspaceHostSessionIds) {
        if (targetSessionId === sourceSessionId) {
          continue;
        }

        void Promise.resolve(
          writeTerminalBinaryInput(targetSessionId, data.slice()),
        ).catch(() => undefined);
      }
    },
    [activeWorkspace, connectedWorkspaceHostSessionIds, tabsBySessionId],
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
