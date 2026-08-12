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
    const resync = () => {
      void desktopApi.window.getState().then((state) => {
        if (isMounted) {
          handleWindowState(state);
        }
      });
    };

    resync();

    const offWindowState = desktopApi.window.onStateChanged((state) => {
      handleWindowState(state);
    });

    // 창이 다시 포커스를 받을 때마다 상태를 직접 물어본다.
    //
    // 푸시만 받으면 전이 이벤트를 한 번 놓친 순간부터 계속 어긋난 채 남는다(전체화면인데 탭이
    // 보이거나, 창인데 탭이 사라진 상태). 메인이 이벤트를 더 촘촘히 보내도 그것 역시 이벤트라
    // 원리상 같은 위험이 남는다. 포커스마다 한 번 되물으면, 어긋나더라도 다음 클릭에서 스스로
    // 복구된다 — 물어보는 값이 곧 사실이므로 어긋남이 지속될 수 없다.
    window.addEventListener('focus', resync);

    return () => {
      isMounted = false;
      window.removeEventListener('focus', resync);
      offWindowState();
    };
  }, []);

  return null;
}
