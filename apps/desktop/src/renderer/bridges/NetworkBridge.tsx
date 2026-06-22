import { useEffect } from "react";
import { appStore, desktopApi } from "../store/appStore";
import {
  persistAllScrollbackToSession,
  refreshAllTerminals,
} from "../lib/terminal-write-registry";
import { registerReconnectHandlers } from "../store/services/reconnect-handlers";
import {
  initReconnectOrchestrator,
  onConnectivityChange,
  onSystemResume,
} from "../store/services/reconnect-orchestrator";

// NetworkBridge는 재연결 오케스트레이터에 네트워크/절전 신호를 연결한다.
//  - window online/offline: 오프라인이면 재연결 대기, 복귀하면 즉시 전부 재시도.
//  - system:resume(메인 powerMonitor): 절전/잠금 복귀 시 죽은 소켓 즉시 재검증.
// 오케스트레이터의 설정 provider도 여기서 1회 초기화한다.
export function NetworkBridge() {
  useEffect(() => {
    initReconnectOrchestrator(() => {
      const settings = appStore.getState().settings;
      return {
        autoReconnectEnabled: settings.autoReconnectEnabled,
        autoReconnectMaxAttempts: settings.autoReconnectMaxAttempts,
        autoReconnectBaseDelayMs: settings.autoReconnectBaseDelayMs,
        autoReconnectMaxDelayMs: settings.autoReconnectMaxDelayMs,
      };
    });
    registerReconnectHandlers();

    // 초기 상태 시드.
    onConnectivityChange(
      typeof navigator === "undefined" ? true : navigator.onLine,
    );

    const handleOnline = () => {
      onConnectivityChange(true);
      // GPU/WebGL 컨텍스트가 살아있어도 네트워크 복귀 시 화면이 멈춰 보일 수 있어 재렌더.
      refreshAllTerminals();
    };
    const handleOffline = () => onConnectivityChange(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const offResume =
      typeof desktopApi.system?.onResume === "function"
        ? desktopApi.system.onResume(() => {
            onSystemResume();
            // 절전/잠금 복귀 시 GPU 컨텍스트 손실로 빈 화면이 된 터미널을 모두 재렌더한다.
            refreshAllTerminals();
          })
        : () => undefined;

    // Cmd+W(메뉴): 활성 탭을 닫는다(크롬식). 닫을 동적 탭이 없으면 창을 닫는다.
    const offCloseActiveTab =
      typeof desktopApi.window?.onCloseActiveTab === "function"
        ? desktopApi.window.onCloseActiveTab(() => {
            if (!appStore.getState().closeActiveTab()) {
              void desktopApi.window.close();
            }
          })
        : () => undefined;

    // 페이지 리로드(dev vite 풀 리로드 등) 직전에 스크롤백을 sessionStorage에 저장한다.
    // 리로드 후 같은 sessionId의 터미널이 다시 만들어질 때 복원된다.
    const handleBeforeUnload = () => {
      persistAllScrollbackToSession();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      offResume();
      offCloseActiveTab();
    };
  }, []);

  return null;
}
