import { useEffect, useRef } from "react";
import type { TerminalTab } from "@shared";
import type { WorkspaceTabId } from "../../store/createAppStore";
import {
  collapseRdpMonitors,
  spreadRdpMonitors,
} from "../../services/desktop/rdp";

/**
 * 지금 펼쳐야 할 RDP 세션을 고른다.
 *
 * 전체화면이 아니면 아무것도 펼치지 않는다 — 창 모드에서 다른 화면에 전체화면 창이 튀어나오면
 * 앱이 화면을 점령한 것처럼 보인다.
 *
 * 모니터가 하나인 세션도 펼칠 것이 없다. 보조 창 없이 메인 창 하나로 충분하다.
 */
export function resolveSpreadTarget(input: {
  isFullScreen: boolean;
  activeWorkspaceTab: WorkspaceTabId;
  tabs: readonly TerminalTab[];
  monitorCountBySession: (sessionId: string) => number;
}): string | null {
  if (!input.isFullScreen) {
    return null;
  }

  const activeSessionId =
    typeof input.activeWorkspaceTab === "string" &&
    input.activeWorkspaceTab.startsWith("session:")
      ? input.activeWorkspaceTab.slice("session:".length)
      : null;
  if (!activeSessionId) {
    return null;
  }

  const tab = input.tabs.find((item) => item.sessionId === activeSessionId);
  if (!tab || tab.paneKind !== "rdp" || tab.status !== "connected") {
    return null;
  }

  return input.monitorCountBySession(activeSessionId) > 1
    ? activeSessionId
    : null;
}

/**
 * 전체화면일 때 원격 모니터를 물리 화면마다 펼치고, 벗어나면 접는다.
 *
 * 펼침은 메인 프로세스가 창을 열어 처리한다. 여기서는 "언제"만 정한다.
 */
export function useRdpMonitorSpread(target: string | null): void {
  // 지금 펼쳐 둔 세션. 대상이 바뀌면 이전 것을 먼저 접어야 창이 남지 않는다.
  const spreadRef = useRef<string | null>(null);

  useEffect(() => {
    if (spreadRef.current === target) {
      return;
    }

    const previous = spreadRef.current;
    spreadRef.current = target;

    if (previous) {
      void collapseRdpMonitors(previous).catch(() => undefined);
    }
    if (target) {
      void spreadRdpMonitors(target).catch(() => undefined);
    }
  }, [target]);

  // 창이 닫히거나 렌더러가 갈아엎힐 때 펼쳐 둔 창을 남기지 않는다. 프레임이 없는 전체화면 창이라
  // 남으면 사용자가 닫을 방법이 없다.
  useEffect(() => {
    return () => {
      const spread = spreadRef.current;
      if (spread) {
        void collapseRdpMonitors(spread).catch(() => undefined);
      }
    };
  }, []);
}
