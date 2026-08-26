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

  // 화면 배율. 상단바는 이 값의 역수로 자신을 되돌려 물리 크기를 고정한다(신호등과 어긋나지
  // 않게). CSS 가 읽을 수 있게 문서 루트에 얹는 것으로 끝낸다 — 상태로 들고 다닐 값이 아니다.
  //
  // 배율이 바뀐 프레임에 상단바가 한 번 움찔한다(페이지 줌은 즉시, 이 값은 IPC 라 한 박자
  // 늦다). devicePixelRatio 변화로 먼저 짐작해 그 움찔을 없애 봤지만, 창을 다른 배율의
  // 모니터로 옮길 때도 devicePixelRatio 가 바뀌는 바람에 상단바가 통째로 어긋났다 —
  // 배율은 그대로인데 짐작이 틀리기 때문이다. 한 프레임의 움찔이 그것보다 낫다.
  useEffect(() => {
    return desktopApi.window.onZoomChanged((factor) => {
      const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
      document.documentElement.style.setProperty('--app-zoom', String(safe));
    });
  }, []);

  return null;
}
