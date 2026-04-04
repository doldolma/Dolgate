import { useEffect, useEffectEvent } from 'react';
import type { DesktopWindowState, UpdateState } from '@shared';
import { desktopApi } from '../store/appStore';

interface DesktopStateBridgeProps {
  loadSettings: () => Promise<void>;
  onLoginServerSettingsReady: () => void;
  onUpdateState: (state: UpdateState) => void;
  onWindowState: (state: DesktopWindowState) => void;
}

export function DesktopStateBridge({
  loadSettings,
  onLoginServerSettingsReady,
  onUpdateState,
  onWindowState,
}: DesktopStateBridgeProps) {
  const loadSettingsEvent = useEffectEvent(loadSettings);
  const handleLoginServerSettingsReady = useEffectEvent(onLoginServerSettingsReady);
  const handleUpdateState = useEffectEvent(onUpdateState);
  const handleWindowState = useEffectEvent(onWindowState);

  useEffect(() => {
    let isMounted = true;
    void loadSettingsEvent().finally(() => {
      if (isMounted) {
        handleLoginServerSettingsReady();
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    void desktopApi.updater.getState().then((state) => {
      if (isMounted) {
        handleUpdateState(state);
      }
    });

    const offUpdater = desktopApi.updater.onEvent((event) => {
      handleUpdateState(event.state);
    });

    return () => {
      isMounted = false;
      offUpdater();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    void desktopApi.window.getState().then((state) => {
      if (isMounted) {
        handleWindowState(state);
      }
    });

    const offWindowState = desktopApi.window.onStateChanged((state) => {
      handleWindowState(state);
    });

    return () => {
      isMounted = false;
      offWindowState();
    };
  }, []);

  return null;
}
