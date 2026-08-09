import { describe, expect, it } from "vitest";
import type { TerminalTab } from "@shared";
import { resolveSpreadTarget } from "./useRdpMonitorSpread";

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "t1",
    stableId: "t1",
    sessionId: "s1",
    source: "host",
    hostId: "h1",
    title: "win",
    status: "connected",
    paneKind: "rdp",
    rdpMonitorCount: 3,
    lastEventAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TerminalTab;
}

function resolve(overrides: Partial<Parameters<typeof resolveSpreadTarget>[0]>) {
  return resolveSpreadTarget({
    isFullScreen: true,
    activeWorkspaceTab: "session:s1",
    tabs: [tab()],
    monitorCountBySession: () => 3,
    ...overrides,
  });
}

describe("resolveSpreadTarget", () => {
  it("spreads a connected multi-monitor session in fullscreen", () => {
    expect(resolve({})).toBe("s1");
  });

  it("stays put outside fullscreen", () => {
    // 창 모드에서 다른 화면에 전체화면 창이 튀어나오면 앱이 화면을 점령한 것처럼 보인다.
    expect(resolve({ isFullScreen: false })).toBeNull();
  });

  it("ignores a single-monitor session", () => {
    expect(resolve({ monitorCountBySession: () => 1 })).toBeNull();
  });

  it("ignores a terminal tab", () => {
    expect(resolve({ tabs: [tab({ paneKind: "terminal" })] })).toBeNull();
  });

  it("waits until the session is connected", () => {
    // 붙는 중에 펼치면 배치를 아직 몰라 빈 검은 창만 뜬다.
    expect(resolve({ tabs: [tab({ status: "connecting" })] })).toBeNull();
  });

  it("ignores non-session tabs", () => {
    for (const active of ["home", "sftp", "workspace:w1"] as const) {
      expect(resolve({ activeWorkspaceTab: active })).toBeNull();
    }
  });

  it("ignores a session that has no tab", () => {
    expect(resolve({ activeWorkspaceTab: "session:gone" })).toBeNull();
  });
});
