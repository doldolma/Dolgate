import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererRecovery, RENDERER_RELOAD_LIMIT } from "./renderer-recovery";

function createWindow(webContentsId = 7) {
  const webContents = Object.assign(new EventEmitter(), { id: webContentsId, reload: vi.fn() });
  const window = { webContents, destroyed: false, isDestroyed: () => window.destroyed };
  return window;
}

const crash = (window: ReturnType<typeof createWindow>, reason = "crashed", exitCode = 5) =>
  window.webContents.emit("render-process-gone", {}, { reason, exitCode });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: new Date("2026-10-23T00:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installRendererRecovery", () => {
  // 렌더러가 죽으면 창은 까만 채로 남았다 — 다시 불러오기를 누르기 전까지 아무것도 안 됐다.
  it("reloads the window after letting go of what the dead renderer held", () => {
    const window = createWindow();
    const release = vi.fn(() => expect(window.webContents.reload).not.toHaveBeenCalled());
    const onGone = vi.fn();
    installRendererRecovery(window as never, { release, onGone });

    crash(window, "oom", 133);
    expect(release).toHaveBeenCalledWith(7);
    vi.runAllTimers();

    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith({ reason: "oom", exitCode: 133 }, "reloaded");
  });

  it("leaves a renderer that ended on purpose, and a window already gone, alone", () => {
    const window = createWindow();
    const release = vi.fn();
    installRendererRecovery(window as never, { release });

    crash(window, "clean-exit", 0);
    window.destroyed = true;
    crash(window);
    vi.runAllTimers();

    expect(release).not.toHaveBeenCalled();
    expect(window.webContents.reload).not.toHaveBeenCalled();
  });

  it("does not reload a window closed before the reload came round", () => {
    const window = createWindow();
    installRendererRecovery(window as never, { release: vi.fn() });

    crash(window);
    window.destroyed = true;
    vi.runAllTimers();

    expect(window.webContents.reload).not.toHaveBeenCalled();
  });

  // 다시 불러오자마자 또 죽는 화면을 끝없이 되살리지 않는다. 그때도 단축키로 다시 불러올 수 있다.
  it("stops reloading a window that keeps dying, and starts again a minute later", () => {
    const window = createWindow();
    const release = vi.fn();
    const onGone = vi.fn();
    installRendererRecovery(window as never, { release, onGone });

    for (let crashes = 0; crashes < RENDERER_RELOAD_LIMIT; crashes += 1) {
      crash(window);
      vi.advanceTimersByTime(1_000);
    }
    expect(window.webContents.reload).toHaveBeenCalledTimes(RENDERER_RELOAD_LIMIT);

    crash(window);
    vi.runAllTimers();
    expect(window.webContents.reload).toHaveBeenCalledTimes(RENDERER_RELOAD_LIMIT);
    expect(onGone).toHaveBeenLastCalledWith({ reason: "crashed", exitCode: 5 }, "gave-up");
    // 되살리지 않아도 쥐고 있던 것은 놓는다 — 다시 불러오면 새 화면이 그것을 모른다.
    expect(release).toHaveBeenCalledTimes(RENDERER_RELOAD_LIMIT + 1);

    vi.advanceTimersByTime(60_000);
    crash(window);
    vi.runAllTimers();
    expect(window.webContents.reload).toHaveBeenCalledTimes(RENDERER_RELOAD_LIMIT + 1);
  });

  it("counts each window on its own", () => {
    const first = createWindow(1);
    const second = createWindow(2);
    installRendererRecovery(first as never, { release: vi.fn() });
    installRendererRecovery(second as never, { release: vi.fn() });

    for (let crashes = 0; crashes < RENDERER_RELOAD_LIMIT; crashes += 1) {
      crash(first);
    }
    crash(second);
    vi.runAllTimers();

    expect(second.webContents.reload).toHaveBeenCalledTimes(1);
  });
});
