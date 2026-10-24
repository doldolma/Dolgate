import type { BrowserWindow } from "electron";

// 창의 렌더러 프로세스가 죽으면(메모리 부족·크래시·강제 종료) 창은 까만 채로 남는다 — 다시 불러오기를 누르기 전까지
// 아무것도 되지 않았다. 그 창을 그 자리에서 다시 불러온다.
//
// 같은 창을 다시 불러오는 이유: 터미널 세션은 메인에 그대로 있고, 새 렌더러가 부트스트랩에서 이 창의 탭으로 되찾는다
// (core-manager listTabs). 창을 새로 열면 그 세션들이 닫힌 창과 함께 끊긴다.

/** 이 시간 안에 이만큼 다시 불러왔는데 또 죽으면 멈춘다 — 열자마자 죽는 화면을 끝없이 되살리지 않는다. */
export const RENDERER_RELOAD_LIMIT = 3;
export const RENDERER_RELOAD_WINDOW_MS = 60_000;

export interface RendererGoneDetails {
  reason: string;
  exitCode: number;
}

export interface RendererRecoveryOptions {
  /**
   * 죽은 렌더러가 쥐고 있던 것 중 새 렌더러가 되찾지 못하는 것을 놓는다. 다시 불러오기 전에 부른다. 되살리지 않을
   * 때도 부른다 — 사용자가 직접 다시 불러와도 새 화면은 그것을 모른다.
   */
  release: (webContentsId: number) => void;
  onGone?: (details: RendererGoneDetails, outcome: "reloaded" | "gave-up") => void;
}

export function installRendererRecovery(
  window: Pick<BrowserWindow, "webContents" | "isDestroyed">,
  options: RendererRecoveryOptions,
): void {
  const webContents = window.webContents;
  const webContentsId = webContents.id;
  const reloadedAt: number[] = [];
  webContents.on("render-process-gone", (_event, { reason, exitCode }) => {
    // 창을 닫으면서 끝난 것이다.
    if (reason === "clean-exit" || window.isDestroyed()) {
      return;
    }
    options.release(webContentsId);
    const now = Date.now();
    while (reloadedAt.length > 0 && now - reloadedAt[0] >= RENDERER_RELOAD_WINDOW_MS) {
      reloadedAt.shift();
    }
    if (reloadedAt.length >= RENDERER_RELOAD_LIMIT) {
      options.onGone?.({ reason, exitCode }, "gave-up");
      return;
    }
    reloadedAt.push(now);
    options.onGone?.({ reason, exitCode }, "reloaded");
    // 같은 이벤트를 듣는 다른 정리(터미널 출력 흐름 등)가 끝난 뒤에 새 렌더러를 띄운다.
    setTimeout(() => {
      if (!window.isDestroyed()) {
        webContents.reload();
      }
    }, 0);
  });
}
