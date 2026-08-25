import { useEffect } from "react";
import { appStore, desktopApi } from "../store/appStore";
import {
  persistAllScrollbackToSession,
  refreshAllTerminals,
} from "../lib/terminal-write-registry";
import { registerReconnectHandlers } from "../store/services/reconnect-handlers";
import { isRdpKeyboardCaptureFocused } from "../lib/rdp-keyboard-focus";
import { startTailnetStatusStream } from "../services/desktop/tailnet-watch";
import {
  initReconnectHold,
  initReconnectOrchestrator,
  onConnectivityChange,
  onSystemResume,
} from "../store/services/reconnect-orchestrator";
import { resolveHostTailnetId } from "../lib/host-tailnet";

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

    // Tailscale 이 브라우저 로그인을 기다리는 동안은 재연결이 될 수 없다. 그 사이에 시도 횟수를
    // 소비하면 사용자가 로그인하기 전에 상한을 다 써서 포기해 버린다.
    //
    // 판정은 코어가 하고(ready) 공유 상태에 담는다. 여기서는 그 결과만 읽는다.
    initReconnectHold((meta) => {
      const hostId = typeof meta.hostId === "string" ? meta.hostId : null;
      const state = appStore.getState();
      const host = hostId
        ? state.hosts.find((item) => item.id === hostId)
        : undefined;
      // 관문·오버레이와 같은 판정을 쓴다. 대상의 tailnetId 만 읽으면 "점프 호스트에만 tailnet"
      // 구성이 이 유예를 못 받아, 사용자가 브라우저 로그인을 마치기 전에 재연결 상한을 다 쓴다.
      const tailnetId = resolveHostTailnetId(host, state.hosts);
      if (!tailnetId) {
        return false;
      }
      const status = state.tailnetStatuses[tailnetId];
      return status?.state === "needsAuth" || status?.state === "needsApproval";
    });

    // tailnet 상태를 한곳으로 모은다. 어느 화면이 시험을 시작했는지와 무관하게 받아야 한다 —
    // 설정에서 시작한 연결의 진행을 터미널 화면도 알아야 하고, 그 반대도 마찬가지다.
    const stopTailnetStatusStream = startTailnetStatusStream();

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

    // 메뉴 탭 단축키(다음/이전/번호/마지막/닫은탭 다시 열기) → 스토어 처리.
    const offTabCommand =
      typeof desktopApi.window?.onTabCommand === "function"
        ? desktopApi.window.onTabCommand((payload) => {
            appStore.getState().runTabCommand(payload);
          })
        : () => undefined;

    // 맥 크롬처럼 Ctrl+Tab / Ctrl+Shift+Tab 으로도 다음/이전 탭. macOS 는 메뉴 accelerator
    // 가 Ctrl+Tab 을 잡지 못해(Tab 예약) 렌더러에서 직접 처리한다. capture 단계에서
    // 가로채 xterm 으로 새지 않게 한다. (Win/Linux 는 메뉴가 Ctrl+Tab 을 담당하므로 제외 —
    // 안 그러면 이중 전환.)
    const handleTabCycleKey = (event: KeyboardEvent) => {
      // 원격 화면에 포커스가 있으면 Ctrl+Tab 은 원격 것이다. capture 단계라 캔버스보다 먼저
      // 도착하므로, 캔버스가 stopPropagation 으로 막을 수 없어 여기서 비켜 준다.
      if (isRdpKeyboardCaptureFocused()) {
        return;
      }
      if (
        document.documentElement.dataset.platform === "darwin" &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key === "Tab"
      ) {
        event.preventDefault();
        event.stopPropagation();
        appStore
          .getState()
          .runTabCommand({ kind: event.shiftKey ? "prev" : "next" });
      }
    };
    window.addEventListener("keydown", handleTabCycleKey, true);

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
      window.removeEventListener("keydown", handleTabCycleKey, true);
      offResume();
      offCloseActiveTab();
      offTabCommand();
      stopTailnetStatusStream();
    };
  }, []);

  return null;
}
