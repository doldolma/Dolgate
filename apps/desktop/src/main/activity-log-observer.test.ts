import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOGS_CHANGED_DELAY_MS,
  createActivityLogObserver,
  createActivityLogsChangedNotifier,
} from "./activity-log-observer";

afterEach(() => {
  vi.useRealTimers();
  const tempDir = process.env.DOLSSH_USER_DATA_DIR;
  delete process.env.DOLSSH_USER_DATA_DIR;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe("createActivityLogsChangedNotifier", () => {
  it("tells the screen once for lines written one after another, and again for lines after that", () => {
    vi.useFakeTimers();
    const broadcast = vi.fn();
    const notifier = createActivityLogsChangedNotifier(broadcast);

    notifier.notify();
    notifier.notify();
    notifier.notify();
    expect(broadcast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ACTIVITY_LOGS_CHANGED_DELAY_MS);
    expect(broadcast).toHaveBeenCalledTimes(1);

    notifier.notify();
    vi.advanceTimersByTime(ACTIVITY_LOGS_CHANGED_DELAY_MS);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("sends nothing once disposed", () => {
    vi.useFakeTimers();
    const broadcast = vi.fn();
    const notifier = createActivityLogsChangedNotifier(broadcast);
    notifier.notify();
    notifier.dispose();
    vi.advanceTimersByTime(ACTIVITY_LOGS_CHANGED_DELAY_MS * 2);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("createActivityLogObserver", () => {
  it("tells the screen even when mirroring to the team fails", () => {
    const notifyChanged = vi.fn();
    const observer = createActivityLogObserver({
      notifyChanged,
      mirror: () => {
        throw new Error("team outbox broken");
      },
    });
    expect(() => observer({} as never)).toThrow("team outbox broken");
    expect(notifyChanged).toHaveBeenCalledTimes(1);
  });

  it("is called for every line the log writes — new lines and lifecycle updates", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-log-observer-"));
    process.env.DOLSSH_USER_DATA_DIR = tempDir;
    vi.resetModules();
    const stateStorage = await import("./state-storage");
    stateStorage.resetDesktopStateStorageForTests();
    stateStorage.getDesktopStateStorage().activateActivityLogScope({ userId: "user-1", serverUrl: "https://ssh.example.test" });
    const { ActivityLogRepository } = await import("./database");
    const repository = new ActivityLogRepository();
    const notifyChanged = vi.fn();
    const mirror = vi.fn();
    repository.setObserver(createActivityLogObserver({ notifyChanged, mirror }));

    // 가져오기·내보내기 같은 감사 줄 — 전에는 화면에 알리지 않았다.
    const appended = repository.append("info", "audit", "exported", { rowCount: 2 });
    expect(notifyChanged).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenLastCalledWith(appended);

    repository.upsert({ ...appended, message: "exported again" });
    expect(notifyChanged).toHaveBeenCalledTimes(2);
  });
});
