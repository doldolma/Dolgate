import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";
import type { RdpMonitorPlacement } from "@shared";
import { APP_LOCALE_QUERY_PARAM } from "../common/i18n/locale";
import { getMainLocale } from "./i18n";

// URL.pathname 을 그대로 쓰면 공백이 %20 으로 남아 경로가 어긋난다. 다른 서비스와 같은 방식.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 원격 모니터를 실제 물리 화면에 하나씩 펼친다.
 *
 * 프레임은 메인 프로세스가 모든 창에 뿌리므로 창마다 세션을 새로 열지 않는다 — 그러면 원격에
 * 세션이 여러 개 생긴다. 각 창은 같은 세션을 구독해 제 몫만 잘라 그린다.
 */
export class RdpMonitorWindows {
  /** 세션마다 열어 둔 보조 창들. 메인 창이 맡은 모니터는 여기 없다. */
  private readonly windowsBySession = new Map<string, BrowserWindow[]>();

  /** 이 세션에 보조 창이 떠 있는지. */
  isOpen(sessionId: string): boolean {
    return (this.windowsBySession.get(sessionId)?.length ?? 0) > 0;
  }

  /**
   * 메인 창이 놓인 화면을 뺀 나머지 모니터를 각자의 물리 화면에 띄운다.
   *
   * @param displayIds 접속 때 선언한 순서대로의 로컬 디스플레이 id. placements 와 같은 순서다.
   * @returns 메인 창이 맡을 모니터 번호. 매칭에 실패하면 null.
   */
  async open(
    sessionId: string,
    mainWindow: BrowserWindow,
    placements: readonly RdpMonitorPlacement[],
    displayIds: readonly number[],
  ): Promise<number | null> {
    await this.close(sessionId);

    if (placements.length < 2 || displayIds.length !== placements.length) {
      // 선언 순서와 배치가 어긋나면 어느 화면에 무엇을 띄울지 알 수 없다. 나누지 않는 편이
      // 엉뚱한 화면에 띄우는 것보다 낫다.
      return null;
    }

    const mainDisplayId = screen.getDisplayMatching(mainWindow.getBounds()).id;
    const mainIndex = displayIds.indexOf(mainDisplayId);
    if (mainIndex < 0) {
      return null;
    }

    const opened: BrowserWindow[] = [];
    for (let index = 0; index < placements.length; index += 1) {
      if (index === mainIndex) {
        continue;
      }
      const display = screen
        .getAllDisplays()
        .find((candidate) => candidate.id === displayIds[index]);
      if (!display) {
        // 창을 여는 사이에 화면이 빠질 수 있다. 그 모니터만 건너뛴다.
        continue;
      }

      const window = new BrowserWindow({
        // 먼저 목표 화면 위에 올려둔다. 전체화면은 "창이 지금 놓인 화면"으로 가므로, 이 좌표가
        // 없으면 전부 주 화면에서 겹쳐 열린다.
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        // macOS 는 타이틀바만 숨긴다 — frame:false 로 만들면 신호등이 아예 없어서, 이 창을 닫을
        // 방법이 메인 창에서 전체화면을 빠져나오는 것뿐이 된다. 다른 앱들도 여러 화면에
        // 전체화면일 때 화면마다 신호등을 남겨둔다.
        ...(process.platform === "darwin"
          ? { titleBarStyle: "hidden" as const }
          : { frame: false }),
        show: false,
        backgroundColor: "#000000",
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      window.setMenuBarVisibility(false);
      // 사용자가 신호등으로 직접 닫을 수 있다. 목록에 죽은 창이 남지 않게 지운다.
      window.on("closed", () => {
        const current = this.windowsBySession.get(sessionId);
        if (current) {
          this.windowsBySession.set(
            sessionId,
            current.filter((entry) => entry !== window),
          );
        }
      });
      window.once("ready-to-show", () => {
        window.show();
        // 크기만 화면에 맞춰서는 전체화면이 아니다 — macOS 는 메뉴바와 Dock 을, Windows 는
        // 작업표시줄을 이 창 위에 그린다. 실제로 전환해야 화면을 온전히 쓴다.
        //
        // macOS 에서는 이 창이 자기 화면의 별도 Space 로 간다. "디스플레이마다 공간 분리"가
        // 켜져 있으면(기본값) 메인 창의 전체화면과 나란히 유지된다.
        window.setFullScreen(true);
      });
      opened.push(window);
      await this.load(window, sessionId, index);
    }

    this.windowsBySession.set(sessionId, opened);
    return mainIndex;
  }

  /** 이 세션의 보조 창을 모두 닫는다. */
  async close(sessionId: string): Promise<void> {
    const windows = this.windowsBySession.get(sessionId) ?? [];
    this.windowsBySession.delete(sessionId);
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  }

  /** 모든 세션의 보조 창을 닫는다. 앱을 내릴 때 쓴다. */
  async closeAll(): Promise<void> {
    for (const sessionId of [...this.windowsBySession.keys()]) {
      await this.close(sessionId);
    }
  }

  private async load(
    window: BrowserWindow,
    sessionId: string,
    monitorIndex: number,
  ): Promise<void> {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const target = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      target.searchParams.set("window", "rdp-monitor");
      target.searchParams.set("sessionId", sessionId);
      target.searchParams.set("monitorIndex", String(monitorIndex));
      target.searchParams.set(APP_LOCALE_QUERY_PARAM, getMainLocale());
      await window.loadURL(target.toString());
      return;
    }

    await window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        query: {
          window: "rdp-monitor",
          sessionId,
          monitorIndex: String(monitorIndex),
          [APP_LOCALE_QUERY_PARAM]: getMainLocale(),
        },
      },
    );
  }
}
