import { useEffect, useEffectEvent } from 'react';
import type { AuthState } from '@shared';
import { desktopApi } from '../store/appStore';

interface DesktopEventBridgeProps {
  onCoreEvent: (event: any) => void;
  onSftpConnectionProgress: (event: any) => void;
  onContainerConnectionProgress: (event: any) => void;
  onTransferEvent: (event: any) => void;
  onPortForwardEvent: (event: any) => void;
  onSessionShareEvent: (event: any) => void;
  onSessionShareChatEvent: (event: any) => void;
  onAuthEvent: (state: AuthState) => void;
}

export function DesktopEventBridge({
  onCoreEvent,
  onSftpConnectionProgress,
  onContainerConnectionProgress,
  onTransferEvent,
  onPortForwardEvent,
  onSessionShareEvent,
  onSessionShareChatEvent,
  onAuthEvent,
}: DesktopEventBridgeProps) {
  const handleCoreEvent = useEffectEvent(onCoreEvent);
  const handleSftpConnectionProgress = useEffectEvent(onSftpConnectionProgress);
  const handleContainerConnectionProgress = useEffectEvent(
    onContainerConnectionProgress,
  );
  const handleTransferEvent = useEffectEvent(onTransferEvent);
  const handlePortForwardEvent = useEffectEvent(onPortForwardEvent);
  const handleSessionShareEvent = useEffectEvent(onSessionShareEvent);
  const handleSessionShareChatEvent = useEffectEvent(onSessionShareChatEvent);
  const handleAuthEvent = useEffectEvent(onAuthEvent);

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

    return () => {
      offCore();
      offSftpProgress();
      offContainersProgress();
      offTransfer();
      offForward();
      offSessionShare();
      offSessionShareChat();
      offAuth();
    };
  }, []);

  return null;
}
