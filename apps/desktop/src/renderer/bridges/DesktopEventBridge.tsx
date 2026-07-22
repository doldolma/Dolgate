import { useEffect, useEffectEvent } from 'react';
import type { AiChatEvent, AuthState } from '@shared';
import { readAiTerminalSnapshot } from '../lib/ai-terminal-snapshot';
import { desktopApi } from '../store/appStore';

interface DesktopEventBridgeProps {
  onCoreEvent: (event: any) => void;
  onSftpConnectionProgress: (event: any) => void;
  onContainerConnectionProgress: (event: any) => void;
  onActivityLogsChanged: () => void;
  onTransferEvent: (event: any) => void;
  onPortForwardEvent: (event: any) => void;
  onSessionShareEvent: (event: any) => void;
  onSessionShareChatEvent: (event: any) => void;
  onAuthEvent: (state: AuthState) => void;
  onWorkspaceChanged?: () => void;
  onAiChatEvent: (event: AiChatEvent) => void;
}

export function DesktopEventBridge({
  onCoreEvent,
  onSftpConnectionProgress,
  onContainerConnectionProgress,
  onActivityLogsChanged,
  onTransferEvent,
  onPortForwardEvent,
  onSessionShareEvent,
  onSessionShareChatEvent,
  onAuthEvent,
  onWorkspaceChanged,
  onAiChatEvent,
}: DesktopEventBridgeProps) {
  const handleCoreEvent = useEffectEvent(onCoreEvent);
  const handleSftpConnectionProgress = useEffectEvent(onSftpConnectionProgress);
  const handleContainerConnectionProgress = useEffectEvent(
    onContainerConnectionProgress,
  );
  const handleActivityLogsChanged = useEffectEvent(onActivityLogsChanged);
  const handleTransferEvent = useEffectEvent(onTransferEvent);
  const handlePortForwardEvent = useEffectEvent(onPortForwardEvent);
  const handleSessionShareEvent = useEffectEvent(onSessionShareEvent);
  const handleSessionShareChatEvent = useEffectEvent(onSessionShareChatEvent);
  const handleAuthEvent = useEffectEvent(onAuthEvent);
  const handleWorkspaceChanged = useEffectEvent(onWorkspaceChanged ?? (() => undefined));
  const handleAiChatEvent = useEffectEvent(onAiChatEvent);

  useEffect(() => {
    const offCore = desktopApi.ssh.onEvent((event) => {
      handleCoreEvent(event);
    });
    const offSftpProgress =
      typeof desktopApi.sftp.onConnectionProgress === "function"
        ? desktopApi.sftp.onConnectionProgress((event) => {
            handleSftpConnectionProgress(event);
          })
        : () => undefined;
    const offContainersProgress =
      typeof desktopApi.containers.onConnectionProgress === "function"
        ? desktopApi.containers.onConnectionProgress((event) => {
            handleContainerConnectionProgress(event);
          })
        : () => undefined;
    const offActivityLogsChanged =
      typeof desktopApi.logs.onChanged === "function"
        ? desktopApi.logs.onChanged(() => {
            handleActivityLogsChanged();
          })
        : () => undefined;
    const offTransfer = desktopApi.sftp.onTransferEvent((event) => {
      handleTransferEvent(event);
    });
    const offForward = desktopApi.portForwards.onEvent((event) => {
      handlePortForwardEvent(event);
    });
    const offSessionShare = desktopApi.sessionShares.onEvent((event) => {
      handleSessionShareEvent(event);
    });
    const offSessionShareChat =
      typeof desktopApi.sessionShares.onChatEvent === 'function'
        ? desktopApi.sessionShares.onChatEvent((event) => {
            handleSessionShareChatEvent(event);
          })
        : () => undefined;
    const offAuth = desktopApi.auth.onEvent((state) => {
      handleAuthEvent(state);
    });
    const offWorkspaceChanged =
      typeof desktopApi.bootstrap?.onWorkspaceChanged === 'function'
        ? desktopApi.bootstrap.onWorkspaceChanged(() => {
            handleWorkspaceChanged();
          })
        : () => undefined;
    const offAiChat =
      typeof desktopApi.ai?.onChatEvent === 'function'
        ? desktopApi.ai.onChatEvent((event) => {
            handleAiChatEvent(event);
          })
        : () => undefined;
    const offAiTerminalOutput =
      typeof desktopApi.ai?.onTerminalOutputRequest === 'function' &&
      typeof desktopApi.ai?.respondTerminalOutput === 'function'
        ? desktopApi.ai.onTerminalOutputRequest((request) => {
            void desktopApi.ai.respondTerminalOutput(readAiTerminalSnapshot(request));
          })
        : () => undefined;

    return () => {
      offCore();
      offSftpProgress();
      offContainersProgress();
      offActivityLogsChanged();
      offTransfer();
      offForward();
      offSessionShare();
      offSessionShareChat();
      offAuth();
      offWorkspaceChanged();
      offAiChat();
      offAiTerminalOutput();
    };
  }, []);

  return null;
}
