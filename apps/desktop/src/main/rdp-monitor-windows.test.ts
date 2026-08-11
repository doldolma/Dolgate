import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpMonitorPlacement } from "@shared";

// 펼침은 창 여러 개가 한 덩어리다. 보조 창 하나에서 빠져나왔을 때 메인 창이 전체화면으로 남으면,
// 원격은 여전히 여러 모니터인데 보이는 화면은 하나뿐이고 되돌릴 곳도 없다.

const { windows } = vi.hoisted(() => ({
  windows: [] as MockWindow[],
}));

interface MockWindow {
  bounds: { x: number; y: number; width: number; height: number };
  destroyed: boolean;
  fullScreen: boolean;
  destroy: () => void;
  setFullScreen: (value: boolean) => void;
  emit: (event: string) => void;
}

vi.stubGlobal("MAIN_WINDOW_VITE_DEV_SERVER_URL", "http://localhost:5173/");
vi.stubGlobal("MAIN_WINDOW_VITE_NAME", "main_window");

vi.mock("./i18n", () => ({ getMainLocale: () => "ko" }));

vi.mock("electron", () => {
  class MockBrowserWindow {
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    destroyed = false;
    fullScreen = false;
    private readonly listeners = new Map<string, Array<() => void>>();

    constructor(options?: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }) {
      this.bounds = {
        x: options?.x ?? 0,
        y: options?.y ?? 0,
        width: options?.width ?? 0,
        height: options?.height ?? 0,
      };
      windows.push(this as unknown as MockWindow);
    }

    on(event: string, listener: () => void) {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
      return this;
    }

    once(event: string, listener: () => void) {
      return this.on(event, listener);
    }

    emit(event: string) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener();
      }
    }

    setMenuBarVisibility() {}
    show() {}
    isDestroyed() {
      return this.destroyed;
    }
    isFullScreen() {
      return this.fullScreen;
    }
    setFullScreen(value: boolean) {
      this.fullScreen = value;
    }
    destroy() {
      this.destroyed = true;
      // Electron 은 destroy 가 창을 닫으며 closed 를 낸다. 그 이벤트를 사용자 조작으로 오해하면
      // 접는 중에 다시 "접어 달라" 가 올라간다.
      this.emit("closed");
    }
    getBounds() {
      return this.bounds;
    }
    async loadURL() {}
    async loadFile() {}
  }

  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getAllDisplays: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
        { id: 2, bounds: { x: -2560, y: -428, width: 2560, height: 1440 } },
      ],
      getDisplayMatching: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
      }),
    },
  };
});

const { RdpMonitorWindows } = await import("./rdp-monitor-windows");
const { BrowserWindow } = await import("electron");

const PLACEMENTS: RdpMonitorPlacement[] = [
  { index: 0, width: 1512, height: 982, left: 0, top: 0 },
  { index: 1, width: 2560, height: 1440, left: -2560, top: -428 },
];

/** 메인 창은 디스플레이 1(getDisplayMatching 이 돌려주는 것)에 있다 → 보조 창은 디스플레이 2. */
function createMainWindow() {
  return new BrowserWindow({
    x: 0,
    y: 0,
    width: 1512,
    height: 982,
  }) as unknown as MockWindow & { getBounds: () => unknown };
}

function secondaryWindows(): MockWindow[] {
  // 첫 창은 테스트가 만든 메인 창이다.
  return windows.slice(1);
}

beforeEach(() => {
  windows.length = 0;
});

describe("RdpMonitorWindows", () => {
  it("메인 창이 놓인 화면을 빼고 보조 창을 띄운다", async () => {
    const monitors = new RdpMonitorWindows();
    const mainWindow = createMainWindow();

    const mainIndex = await monitors.open(
      "s1",
      mainWindow as never,
      PLACEMENTS,
      [1, 2],
    );

    expect(mainIndex).toBe(0);
    expect(monitors.entries("s1").map((entry) => entry.index)).toEqual([1]);
  });

  it("보조 창을 사용자가 닫으면 펼침을 접어 달라고 알린다", async () => {
    const monitors = new RdpMonitorWindows();
    const collapse = vi.fn();
    monitors.onCollapseRequested = collapse;
    await monitors.open("s1", createMainWindow() as never, PLACEMENTS, [1, 2]);

    secondaryWindows()[0].emit("closed");

    expect(collapse).toHaveBeenCalledWith("s1");
  });

  it("보조 창의 전체화면을 빠져나오면 접어 달라고 알린다", async () => {
    const monitors = new RdpMonitorWindows();
    const collapse = vi.fn();
    monitors.onCollapseRequested = collapse;
    await monitors.open("s1", createMainWindow() as never, PLACEMENTS, [1, 2]);

    secondaryWindows()[0].emit("leave-full-screen");

    expect(collapse).toHaveBeenCalledWith("s1");
  });

  it("우리가 접는 중에 나는 창 이벤트는 되돌려 보내지 않는다", async () => {
    // 이 구분이 없으면 close() 가 부르는 destroy → closed 가 다시 접기를 요청해 같은 정리가
    // 겹쳐 돈다(재펼침 중이면 새로 연 창까지 닫는다).
    const monitors = new RdpMonitorWindows();
    await monitors.open("s1", createMainWindow() as never, PLACEMENTS, [1, 2]);
    const collapse = vi.fn();
    monitors.onCollapseRequested = collapse;

    await monitors.close("s1");

    expect(collapse).not.toHaveBeenCalled();
    expect(monitors.entries("s1")).toEqual([]);
  });

  it("다시 펼칠 때 앞의 창을 닫는 것도 접기 요청이 아니다", async () => {
    const monitors = new RdpMonitorWindows();
    const collapse = vi.fn();
    monitors.onCollapseRequested = collapse;
    await monitors.open("s1", createMainWindow() as never, PLACEMENTS, [1, 2]);

    await monitors.open("s1", createMainWindow() as never, PLACEMENTS, [1, 2]);

    expect(collapse).not.toHaveBeenCalled();
    expect(monitors.entries("s1")).toHaveLength(1);
  });
});
