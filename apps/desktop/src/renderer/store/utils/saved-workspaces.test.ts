import { describe, expect, it } from "vitest";
import type { HostRecord, SavedWorkspaceNode, TerminalTab } from "@shared";
import type { WorkspaceLayoutNode } from "../types";
import {
  captureSavedWorkspaceNode,
  countSavedWorkspacePanes,
  hydrateSavedWorkspaceLayout,
  listSavedWorkspaceLeaves,
} from "./saved-workspaces";

const hosts = [
  {
    id: "host-prod",
    kind: "ssh",
    label: "Production",
  } as HostRecord,
];

function tab(
  input: Pick<TerminalTab, "sessionId" | "source" | "hostId" | "title"> &
    Partial<TerminalTab>,
): TerminalTab {
  return input as TerminalTab;
}

const runtimeLayout: WorkspaceLayoutNode = {
  id: "runtime-root",
  kind: "split",
  axis: "horizontal",
  ratio: 0.62,
  first: { id: "runtime-host", kind: "leaf", sessionId: "session-host" },
  second: {
    id: "runtime-nested",
    kind: "split",
    axis: "vertical",
    ratio: 0.4,
    first: { id: "runtime-local", kind: "leaf", sessionId: "session-local" },
    second: { id: "runtime-host-2", kind: "leaf", sessionId: "session-host-2" },
  },
};

const capturedTabs = [
  tab({
    sessionId: "session-host",
    source: "host",
    hostId: "host-prod",
    title: "prod shell",
  }),
  tab({
    sessionId: "session-local",
    source: "local",
    hostId: null,
    title: "Local zsh",
    shellKind: "shell",
  }),
  tab({
    sessionId: "session-host-2",
    source: "host",
    hostId: "host-prod",
    title: "prod logs",
  }),
];

describe("saved workspace tree utilities", () => {
  it("captures host and ordinary local panes while preserving nested axes and ratios", () => {
    const captured = captureSavedWorkspaceNode(
      runtimeLayout,
      capturedTabs,
      hosts,
    );

    expect(captured).toEqual({
      id: "runtime-root",
      kind: "split",
      axis: "horizontal",
      ratio: 0.62,
      first: {
        id: "runtime-host",
        kind: "leaf",
        target: { kind: "host", hostId: "host-prod", label: "Production" },
      },
      second: {
        id: "runtime-nested",
        kind: "split",
        axis: "vertical",
        ratio: 0.4,
        first: {
          id: "runtime-local",
          kind: "leaf",
          target: { kind: "local", label: "Local zsh" },
        },
        second: {
          id: "runtime-host-2",
          kind: "leaf",
          target: { kind: "host", hostId: "host-prod", label: "Production" },
        },
      },
    });
    expect(countSavedWorkspacePanes(captured!)).toBe(3);
    expect(
      listSavedWorkspaceLeaves(captured!).map((leaf) => leaf.target.kind),
    ).toEqual(["host", "local", "host"]);
  });

  it("rejects a layout when any pane is missing, tmux, or an ECS Exec local pane", () => {
    expect(
      captureSavedWorkspaceNode(runtimeLayout, capturedTabs.slice(0, 2), hosts),
    ).toBeNull();

    const tmuxTabs = capturedTabs.map((entry) =>
      entry.sessionId === "session-host-2"
        ? { ...entry, tmux: {} as never }
        : entry,
    );
    expect(
      captureSavedWorkspaceNode(runtimeLayout, tmuxTabs, hosts),
    ).toBeNull();

    const ecsTabs = capturedTabs.map((entry) =>
      entry.sessionId === "session-local"
        ? { ...entry, shellKind: "aws-ecs-exec" as const }
        : entry,
    );
    expect(captureSavedWorkspaceNode(runtimeLayout, ecsTabs, hosts)).toBeNull();
  });

  it("hydrates the saved shape with supplied session ids and fresh runtime node ids", () => {
    const captured = captureSavedWorkspaceNode(
      runtimeLayout,
      capturedTabs,
      hosts,
    )!;
    const sessionIds = new Map([
      ["runtime-host", "pending-host"],
      ["runtime-local", "pending-local"],
      ["runtime-host-2", "pending-host-2"],
    ]);
    let nextId = 0;

    const hydrated = hydrateSavedWorkspaceLayout(
      captured,
      sessionIds,
      () => `fresh-${++nextId}`,
    );

    expect(hydrated).toEqual({
      id: "fresh-5",
      kind: "split",
      axis: "horizontal",
      ratio: 0.62,
      first: { id: "fresh-1", kind: "leaf", sessionId: "pending-host" },
      second: {
        id: "fresh-4",
        kind: "split",
        axis: "vertical",
        ratio: 0.4,
        first: { id: "fresh-2", kind: "leaf", sessionId: "pending-local" },
        second: { id: "fresh-3", kind: "leaf", sessionId: "pending-host-2" },
      },
    });
    expect(collectNodeIds(hydrated!)).not.toContain("runtime-root");
  });

  it("returns null when a saved leaf has no pending session mapping", () => {
    const saved: SavedWorkspaceNode = {
      id: "saved-root",
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: {
        id: "saved-a",
        kind: "leaf",
        target: { kind: "local", label: "A" },
      },
      second: {
        id: "saved-b",
        kind: "leaf",
        target: { kind: "local", label: "B" },
      },
    };

    expect(
      hydrateSavedWorkspaceLayout(saved, new Map([["saved-a", "pending-a"]])),
    ).toBeNull();
  });
});

function collectNodeIds(node: WorkspaceLayoutNode): string[] {
  return node.kind === "leaf"
    ? [node.id]
    : [node.id, ...collectNodeIds(node.first), ...collectNodeIds(node.second)];
}

// 컨테이너 셸 탭은 source: "host" + hostId 로 만들어져 평범한 호스트 셸과 구별되지 않았다.
// 그대로 저장되면 다시 열 때 컨테이너가 아니라 호스트에 그냥 붙는데, 레이아웃은 복원된 것처럼
// 보이고 제목도 호스트 이름이라 알아채기 어렵다(TerminalTab.containerId 주석 참고).
describe("captureSavedWorkspaceNode - 컨테이너 셸", () => {
  const layout: WorkspaceLayoutNode = {
    id: "root",
    kind: "split",
    axis: "horizontal",
    ratio: 0.5,
    first: { id: "left", kind: "leaf", sessionId: "session-plain" },
    second: { id: "right", kind: "leaf", sessionId: "session-container" },
  };

  it("컨테이너 셸이 섞여 있으면 저장하지 않는다", () => {
    const captured = captureSavedWorkspaceNode(
      layout,
      [
        tab({
          sessionId: "session-plain",
          source: "host",
          hostId: "host-prod",
          title: "prod shell",
        }),
        tab({
          sessionId: "session-container",
          source: "host",
          hostId: "host-prod",
          title: "Production · api",
          containerId: "container-api",
        }),
      ],
      hosts,
    );

    expect(captured).toBeNull();
  });

  it("컨테이너 표식이 없는 호스트 셸은 그대로 저장한다", () => {
    const captured = captureSavedWorkspaceNode(
      layout,
      [
        tab({
          sessionId: "session-plain",
          source: "host",
          hostId: "host-prod",
          title: "prod shell",
        }),
        tab({
          sessionId: "session-container",
          source: "host",
          hostId: "host-prod",
          title: "prod logs",
        }),
      ],
      hosts,
    );

    expect(captured).not.toBeNull();
    expect(countSavedWorkspacePanes(captured as SavedWorkspaceNode)).toBe(2);
  });
});
