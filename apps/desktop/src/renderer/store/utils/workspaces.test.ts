import { describe, expect, it } from "vitest";
import type { WorkspaceLayoutNode, WorkspaceTab } from "../types";
import {
  asSessionTabId,
  asWorkspaceTabId,
  resolveAdjacentTarget,
  resolveNextVisibleTab,
  updateWorkspaceSplitRatio,
} from "./workspaces";

describe("workspaces utils", () => {
  it("clamps and updates the matching split ratio", () => {
    const layout: WorkspaceLayoutNode = {
      id: "split-root",
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: {
        id: "leaf-1",
        kind: "leaf",
        sessionId: "session-1",
      },
      second: {
        id: "leaf-2",
        kind: "leaf",
        sessionId: "session-2",
      },
    };

    expect(updateWorkspaceSplitRatio(layout, "split-root", 0.95)).toEqual({
      ...layout,
      ratio: 0.8,
    });
    expect(updateWorkspaceSplitRatio(layout, "missing", 0.1)).toEqual(layout);
  });

  it("resolves the next visible tab from remaining strip items", () => {
    expect(resolveNextVisibleTab([], 0)).toBe("home");
    expect(
      resolveNextVisibleTab(
        [
          { kind: "session", sessionId: "session-1" },
          { kind: "workspace", workspaceId: "workspace-1" },
        ],
        0,
      ),
    ).toBe(asSessionTabId("session-1"));
    expect(
      resolveNextVisibleTab(
        [{ kind: "workspace", workspaceId: "workspace-1" }],
        0,
      ),
    ).toBe(asWorkspaceTabId("workspace-1"));
  });

  it("skips full workspaces when resolving adjacent targets", () => {
    const workspaces: WorkspaceTab[] = [
      {
        id: "workspace-full",
        title: "Workspace Full",
        activeSessionId: "session-2",
        broadcastEnabled: false,
        layout: {
          id: "split-a",
          kind: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: {
            id: "split-b",
            kind: "split",
            axis: "vertical",
            ratio: 0.5,
            first: { id: "leaf-2", kind: "leaf", sessionId: "session-2" },
            second: { id: "leaf-3", kind: "leaf", sessionId: "session-3" },
          },
          second: {
            id: "split-c",
            kind: "split",
            axis: "vertical",
            ratio: 0.5,
            first: { id: "leaf-4", kind: "leaf", sessionId: "session-4" },
            second: { id: "leaf-5", kind: "leaf", sessionId: "session-5" },
          },
        },
      },
    ];

    expect(
      resolveAdjacentTarget(
        [
          { kind: "session", sessionId: "session-1" },
          { kind: "workspace", workspaceId: "workspace-full" },
        ],
        workspaces,
        "session-1",
      ),
    ).toBeNull();
  });
});
