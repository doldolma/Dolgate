import { describe, expect, it } from "vitest";
import type { TerminalTab } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { removeSessionFromState } from "./utils/workspaces";

function sessionTab(sessionId: string): TerminalTab {
  return {
    id: sessionId,
    stableId: `stable-${sessionId}`,
    sessionId,
    source: "host",
    hostId: "h1",
    title: sessionId,
    status: "connected",
    hasReceivedOutput: true,
    sessionShare: null,
    lastEventAt: "2025-01-01T00:00:00.000Z",
  };
}

// Cmd+W 연타로 탭을 정리할 때, 닫은 세션의 "복귀 대상"이 home 이어도 남은 동적 탭이
// 있으면 home 으로 포커스가 튀면 안 된다(다음 Cmd+W 가 창을 닫아버리는 회귀 방지).
describe("tab focus priority on session close (Cmd+W cleanup)", () => {
  it("focuses an adjacent dynamic tab (not Home) when the closed session's return target is Home", () => {
    const store = createAppStore(createMockApi());
    const state = {
      ...store.getState(),
      tabs: [sessionTab("s1"), sessionTab("s2")],
      tabStrip: [
        { kind: "session" as const, sessionId: "s1" },
        { kind: "session" as const, sessionId: "s2" },
      ],
      activeWorkspaceTab: "session:s1" as const,
      sessionReturnTargets: { s1: { activeWorkspaceTab: "home" as const } },
    };

    const next = removeSessionFromState(state, "s1");

    expect(next.activeWorkspaceTab).toBe("session:s2");
  });

  it("falls back to Home only when no dynamic tabs remain", () => {
    const store = createAppStore(createMockApi());
    const state = {
      ...store.getState(),
      tabs: [sessionTab("s1")],
      tabStrip: [{ kind: "session" as const, sessionId: "s1" }],
      activeWorkspaceTab: "session:s1" as const,
      sessionReturnTargets: { s1: { activeWorkspaceTab: "home" as const } },
    };

    const next = removeSessionFromState(state, "s1");

    expect(next.activeWorkspaceTab).toBe("home");
  });
});
