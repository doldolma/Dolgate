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
/** 원격 모니터 번호와 그 창. 배치를 다시 선언할 때 번호 순서를 지켜야 한다. */
export interface RdpMonitorWindowEntry {
  index: number;
  window: BrowserWindow;
}

export class RdpMonitorWindows {
  /** 세션마다 열어 둔 보조 창들. 메인 창이 맡은 모니터는 여기 없다. */
  private readonly windowsBySession = new Map<
    string,
    RdpMonitorWindowEntry[]
  >();

  /**
   * 창의 크기·전체화면 상태가 바뀌었다.
   *
   * 고정 지연으로 재지 않는 이유: macOS 전체화면은 애니메이션이라 값이 늦게 정해지고, OS 가
   * 나중에 프레임을 또 손대기도 한다. 바뀔 때마다 알리면 저절로 따라간다.
   */
  onGeometryChanged: ((sessionId: string) => void) | null = null;

  /**
   * 사용자가 보조 창 하나를 닫거나 그 창의 전체화면을 빠져나왔다.
   *
   * 그 창만 사라지게 두면 메인 창은 전체화면으로 남고 원격은 여러 모니터인 채다 — 화면 하나에
   * 여러 모니터가 겹쳐 보이거나 한 화면만 보이는데 되돌릴 곳이 없다. 펼치기는 창 여러 개가 한
   * 덩어리로 움직여야 하므로, 어느 창에서 빠져나오든 전체를 접는다.
   */
  onCollapseRequested: ((sessionId: string) => void) | null = null;

  /**
   * 우리가 없앤 창들. 여기 있는 창이 내는 이벤트는 사용자 조작이 아니다.
   *
   * 세션 단위 플래그로는 안 된다 — `destroy()` 의 `closed` 가 같은 틱에 오지 않는 플랫폼이 있어서
   * 플래그를 언제 풀지 정할 수 없다. 일찍 풀면 그 이벤트가 사용자 조작으로 올라가고(다시 펼치는
   * 중이면 방금 연 창을 닫아 버린다), 늦게 풀면 그 사이의 진짜 조작을 삼킨다. 창 자체를 표시하면
   * 시점 문제가 사라진다 — 죽은 창의 이벤트는 언제 와도 우리 것이다.
   */
  private readonly destroyedByUs = new WeakSet<BrowserWindow>();

  /** 이 세션에 보조 창이 떠 있는지. */
  isOpen(sessionId: string): boolean {
    return (this.windowsBySession.get(sessionId)?.length ?? 0) > 0;
  }

  /** 이 세션의 보조 창들. 살아 있는 것만 준다. */
  entries(sessionId: string): RdpMonitorWindowEntry[] {
    return (this.windowsBySession.get(sessionId) ?? []).filter(
      (entry) => !entry.window.isDestroyed(),
    );
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

    const opened: RdpMonitorWindowEntry[] = [];
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
      // 사용자가 신호등으로 직접 닫을 수 있다. 목록에 죽은 창이 남지 않게 지우고, 우리가 닫은
      // 것이 아니면 펼침 전체를 접어 달라고 알린다.
      window.on("closed", () => {
        const current = this.windowsBySession.get(sessionId);
        if (current) {
          this.windowsBySession.set(
            sessionId,
            current.filter((entry) => entry.window !== window),
          );
        }
        this.requestCollapse(sessionId, window);
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

      // 이 창이 실제로 그릴 수 있는 크기가 정해지거나 바뀌면 알린다. 원격 배치를 그 크기로
      // 다시 선언해야 화면이 창에 꼭 맞는다(rdp-monitor-layout.ts 참고).
      const notify = () => this.onGeometryChanged?.(sessionId);
      window.on("enter-full-screen", notify);
      window.on("resize", notify);
      // 이 창의 전체화면을 빠져나오면 펼침을 그만두겠다는 뜻이다 — 창 크기만 되돌리고 원격 배치를
      // 그대로 두면, 이 화면에는 창 하나에 원격 모니터 하나가 축소되어 남고 메인 창은 전체화면
      // 그대로다. 접는 김에 배치도 접속 시점 하나로 돌아간다(collapse 가 한다).
      window.on("leave-full-screen", () => {
        this.requestCollapse(sessionId, window);
      });
      opened.push({ index, window });
      await this.load(window, sessionId, index);
    }

    this.windowsBySession.set(sessionId, opened);
    return mainIndex;
  }

  /** 이 세션의 보조 창을 모두 닫는다. */
  async close(sessionId: string): Promise<void> {
    const windows = this.windowsBySession.get(sessionId) ?? [];
    this.windowsBySession.delete(sessionId);
    for (const { window } of windows) {
      if (!window.isDestroyed()) {
        // 없애기 전에 표시한다. 표시가 없으면 destroy 가 부르는 `closed` 가 다시 "접어 달라" 로
        // 돌아와 같은 정리가 겹쳐 돈다.
        this.destroyedByUs.add(window);
        window.destroy();
      }
    }
  }

  /**
   * 사용자가 이 세션의 펼침에서 빠져나왔다고 알린다.
   *
   * 우리가 없앤 창이 내는 이벤트는 알리지 않는다 — 그건 이미 접는 과정이다.
   */
  private requestCollapse(sessionId: string, window: BrowserWindow): void {
    if (this.destroyedByUs.has(window)) {
      return;
    }
    this.onCollapseRequested?.(sessionId);
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
