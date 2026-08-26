import { describe, expect, it } from "vitest";
import type { WorkspaceLayoutNode, WorkspaceTab } from "../types";
import {
  clearSessionScopedState,
  useSessionScopedState,
} from '../../components/terminal-workspace/session-panel/useSessionScopedState';
import { removeSessionFromState } from './workspaces';
import {
  asSessionTabId,
  asWorkspaceTabId,
  parseTmuxLayout,
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

  it("never picks a tmux session group tab as a split target", () => {
    // tmux 세션 그룹 탭은 자체 윈도우/pane 레이아웃을 가지므로 일반 드래그-분할에
    // 참여하지 않는다 — 인접이 tmux 탭뿐이면 분할 대상 없음(null).
    expect(
      resolveAdjacentTarget(
        [
          { kind: "session", sessionId: "session-1" },
          { kind: "tmux", tmuxGroupId: "group-1" },
        ],
        [],
        "session-1",
      ),
    ).toBeNull();
  });
});

describe("parseTmuxLayout", () => {
  const id = (paneId: string) => `tmux:base:${paneId}`;

  it("parses a single pane into a leaf with tmux cell size", () => {
    expect(parseTmuxLayout("bd5e,80x24,0,0,0", id)).toEqual({
      id: expect.any(String),
      kind: "leaf",
      sessionId: "tmux:base:0",
      // leaf 는 tmux 레이아웃 칸 수(cols×rows)를 실어, pane xterm 을 이 크기로 고정한다.
      cols: 80,
      rows: 24,
    });
  });

  it("parses a left-right split as a horizontal split", () => {
    const node = parseTmuxLayout("b25d,80x24,0,0{40x24,0,0,1,39x24,41,0,2}", id);
    if (node?.kind !== "split") throw new Error("expected split");
    expect(node.axis).toBe("horizontal");
    expect(node.ratio).toBeCloseTo(40 / 79, 5);
    expect(node.first).toMatchObject({ kind: "leaf", sessionId: "tmux:base:1" });
    expect(node.second).toMatchObject({ kind: "leaf", sessionId: "tmux:base:2" });
  });

  it("parses a top-bottom split as a vertical split", () => {
    const node = parseTmuxLayout("9f1a,80x24,0,0[80x12,0,0,1,80x11,0,13,2]", id);
    if (node?.kind !== "split") throw new Error("expected split");
    expect(node.axis).toBe("vertical");
    expect(node.ratio).toBeCloseTo(12 / 23, 5);
    expect(node.first).toMatchObject({ kind: "leaf", sessionId: "tmux:base:1" });
    expect(node.second).toMatchObject({ kind: "leaf", sessionId: "tmux:base:2" });
  });

  it("nests an N-way split into a binary tree", () => {
    const node = parseTmuxLayout(
      "0000,90x24,0,0{30x24,0,0,1,30x24,31,0,2,28x24,62,0,3}",
      id,
    );
    if (node?.kind !== "split") throw new Error("expected split");
    expect(node.first).toMatchObject({ kind: "leaf", sessionId: "tmux:base:1" });
    if (node.second.kind !== "split") throw new Error("expected nested split");
    expect(node.second.axis).toBe("horizontal");
    expect(node.second.first).toMatchObject({
      kind: "leaf",
      sessionId: "tmux:base:2",
    });
    expect(node.second.second).toMatchObject({
      kind: "leaf",
      sessionId: "tmux:base:3",
    });
  });

  it("parses a left-right split that contains a top-bottom split", () => {
    const node = parseTmuxLayout(
      "0000,80x24,0,0{40x24,0,0,1,39x24,41,0[39x12,41,0,2,39x11,41,13,3]}",
      id,
    );
    if (node?.kind !== "split") throw new Error("expected split");
    expect(node.axis).toBe("horizontal");
    expect(node.first).toMatchObject({ kind: "leaf", sessionId: "tmux:base:1" });
    if (node.second.kind !== "split") throw new Error("expected nested split");
    expect(node.second.axis).toBe("vertical");
  });

  it("handles a layout without a checksum prefix", () => {
    expect(parseTmuxLayout("80x24,0,0,5", id)).toMatchObject({
      kind: "leaf",
      sessionId: "tmux:base:5",
    });
  });

  it("returns null for malformed input", () => {
    expect(parseTmuxLayout("", id)).toBeNull();
    expect(parseTmuxLayout("garbage", id)).toBeNull();
    expect(parseTmuxLayout("bd5e,80x24,0,0{40x24,0,0,1", id)).toBeNull();
  });
});

describe("세션이 사라지면 그 세션 것도 함께 버린다", () => {
  it("패널이 기억해 둔 화면 상태와 열어 둔 터널을 지운다", () => {
    // 앱을 오래 켜 두면 죽은 세션의 검색어·펼침 상태가 모듈 맵에 쌓인다. 재연결은 이 함수를
    // 지나지 않으므로 "돌아오면 보던 그대로" 는 그대로다.
    const state = {
      tabs: [{ sessionId: "session-1", stableId: "stable-1" }],
      tabStrip: [],
      workspaces: [],
      activeWorkspaceTab: "home",
      homeSection: "hosts",
      settingsSection: null,
      activeContainerHostId: null,
      sessionReturnTargets: {},
      resolvedStartupCommandsBySessionId: {},
      pendingConnectionAttempts: [],
      pendingInteractiveAuths: [],
      pendingCredentialRetry: null,
      sessionShareChatNotifications: {},
      tmuxGroups: [],
      portForwardRuntimes: [],
      recentlyClosedHosts: [],
      queuedHostKeyPrompts: [],
      pendingHostKeyPrompt: null,
      connectionHops: {},
      aiConversations: {},
      sessionContainerTunnels: {
        "session-1": [
          {
            ruleId: "container-service-tunnel:1",
            containerId: "abc",
            containerName: "web",
            targetPort: 80,
            bindPort: 12345,
            status: "running",
          },
        ],
        "session-2": [],
      },
    } as never;

    const next = removeSessionFromState(state, "session-1") as {
      sessionContainerTunnels: Record<string, unknown[]>;
    };

    expect(next.sessionContainerTunnels["session-1"]).toBeUndefined();
    expect(next.sessionContainerTunnels["session-2"]).toBeDefined();
  });
});
