import { describe, expect, it, vi } from "vitest";
import type { SavedWorkspaceRecord, TerminalTab } from "@shared";
import type { WorkspaceTab } from "./types";
import { createAppStore } from "./createAppStore";
import { createDeferred, createMockApi } from "./createAppStore.test-support";
import { listWorkspaceSessionIds } from "../components/terminal-workspace/terminalWorkspaceLayout";

function savedWorkspace(
  overrides: Partial<SavedWorkspaceRecord> = {},
): SavedWorkspaceRecord {
  return {
    id: "saved-1",
    version: 1,
    name: "Operations",
    root: {
      id: "saved-root",
      kind: "split",
      axis: "horizontal",
      ratio: 0.6,
      first: {
        id: "saved-host",
        kind: "leaf",
        target: { kind: "host", hostId: "host-1", label: "Prod" },
      },
      second: {
        id: "saved-local",
        kind: "leaf",
        target: { kind: "local", label: "Local shell" },
      },
    },
    favorite: false,
    lastOpenedAt: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("saved workspace store orchestration", () => {
  it("captures a two-pane host/local workspace and appends the created record", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().openLocalTerminal(120, 32);

    expect(
      store.getState().splitSessionIntoWorkspace("session-1", "right"),
    ).toBe(true);
    const workspace = store.getState().workspaces[0]!;

    const record = await store
      .getState()
      .createSavedWorkspace(workspace.id, "Production triage");

    expect(api.savedWorkspaces.create).toHaveBeenCalledWith({
      name: "Production triage",
      root: expect.objectContaining({
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
      }),
    });
    const draft = vi.mocked(api.savedWorkspaces.create).mock.calls[0]![0];
    expect(draft.root.kind).toBe("split");
    if (draft.root.kind === "split") {
      expect(
        [draft.root.first, draft.root.second]
          .map((node) => (node.kind === "leaf" ? node.target.kind : "split"))
          .sort(),
      ).toEqual(["host", "local"].sort());
    }
    expect(record.name).toBe("Production triage");
    expect(store.getState().savedWorkspaces).toEqual([record]);
  });

  it("rejects one-pane and tmux runtime workspaces", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    const onePane: WorkspaceTab = {
      id: "one-pane",
      title: "One pane",
      layout: { id: "one-leaf", kind: "leaf", sessionId: "one-session" },
      activeSessionId: "one-session",
      broadcastEnabled: false,
    };
    const tab = {
      sessionId: "one-session",
      source: "local",
      hostId: null,
      title: "Local",
      shellKind: "shell",
    } as TerminalTab;
    store.setState({ workspaces: [onePane], tabs: [tab] });

    await expect(
      store.getState().createSavedWorkspace(onePane.id, "No split"),
    ).rejects.toThrow();

    store.setState({
      workspaces: [{ ...onePane, id: "tmux-pane", tmux: {} as never }],
    });
    await expect(
      store.getState().createSavedWorkspace("tmux-pane", "tmux"),
    ).rejects.toThrow();
    expect(api.savedWorkspaces.create).not.toHaveBeenCalled();
  });

  it("renders all placeholders before starting host and local connections in parallel", async () => {
    const record = savedWorkspace();
    const api = createMockApi();
    api.savedWorkspaces.list = vi.fn().mockResolvedValue([record]);
    api.savedWorkspaces.touchOpened = vi.fn().mockResolvedValue({
      ...record,
      lastOpenedAt: "2026-09-05T01:00:00.000Z",
    });
    const hostConnection = createDeferred<{ sessionId: string }>();
    const localConnection = createDeferred<{ sessionId: string }>();
    api.ssh.connect = vi.fn(() => hostConnection.promise);
    api.ssh.connectLocal = vi.fn(() => localConnection.promise);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    const opening = store.getState().openSavedWorkspace(record.id, 120, 32);

    const placeholderState = store.getState();
    expect(placeholderState.workspaces).toHaveLength(1);
    expect(placeholderState.tabs).toHaveLength(2);
    expect(
      placeholderState.tabs.every((tab) =>
        tab.sessionId.startsWith("pending:"),
      ),
    ).toBe(true);
    expect(placeholderState.tabStrip).toEqual([
      {
        kind: "workspace",
        workspaceId: placeholderState.workspaces[0]!.id,
      },
    ]);

    await vi.waitFor(() => {
      expect(api.ssh.connect).toHaveBeenCalledTimes(1);
      expect(api.ssh.connectLocal).toHaveBeenCalledTimes(1);
    });
    expect(hostConnection.promise).not.toBe(localConnection.promise);

    hostConnection.resolve({ sessionId: "restored-host" });
    localConnection.resolve({ sessionId: "restored-local" });
    await opening;

    const restored = store.getState().workspaces[0]!;
    expect(listWorkspaceSessionIds(restored.layout)).toEqual([
      "restored-host",
      "restored-local",
    ]);
    expect(restored.activeSessionId).toBe("restored-host");
    expect(store.getState().activeWorkspaceTab).toBe(
      `workspace:${restored.id}`,
    );
    expect(api.savedWorkspaces.touchOpened).toHaveBeenCalledWith(record.id);
  });

  it("keeps a missing host pane as an error slot while restoring other panes", async () => {
    const record = savedWorkspace({
      root: {
        id: "missing-root",
        kind: "split",
        axis: "vertical",
        ratio: 0.35,
        first: {
          id: "missing-host",
          kind: "leaf",
          target: {
            kind: "host",
            hostId: "deleted-host",
            label: "Deleted database",
          },
        },
        second: {
          id: "working-local",
          kind: "leaf",
          target: { kind: "local", label: "Local shell" },
        },
      },
    });
    const api = createMockApi();
    api.savedWorkspaces.list = vi.fn().mockResolvedValue([record]);
    api.savedWorkspaces.touchOpened = vi.fn().mockResolvedValue(record);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().openSavedWorkspace(record.id, 120, 32);

    expect(store.getState().tabs).toHaveLength(2);
    expect(store.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostId: "deleted-host",
          title: "Deleted database",
          status: "error",
        }),
        expect.objectContaining({
          source: "local",
          sessionId: expect.stringMatching(/^local-session-/),
        }),
      ]),
    );
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(
      listWorkspaceSessionIds(store.getState().workspaces[0]!.layout),
    ).toHaveLength(2);
  });

  it("moves a saved Workspace to a group and refreshes the local record", async () => {
    const record = savedWorkspace({ groupName: null });
    const moved = savedWorkspace({ groupName: "Clients" });
    const api = createMockApi();
    api.savedWorkspaces.list = vi.fn().mockResolvedValue([record]);
    api.savedWorkspaces.moveToGroup = vi.fn().mockResolvedValue(moved);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().moveSavedWorkspaceToGroup(record.id, "Clients");

    expect(api.savedWorkspaces.moveToGroup).toHaveBeenCalledWith(
      record.id,
      "Clients",
    );
    expect(store.getState().savedWorkspaces).toEqual([moved]);
  });

  it("removes a saved record only after the desktop API deletion succeeds", async () => {
    const record = savedWorkspace();
    const api = createMockApi();
    api.savedWorkspaces.list = vi.fn().mockResolvedValue([record]);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().removeSavedWorkspace(record.id);

    expect(api.savedWorkspaces.remove).toHaveBeenCalledWith(record.id);
    expect(store.getState().savedWorkspaces).toEqual([]);
  });

  // 복제본이 groupName 을 잃으면 create 가 null 로 정규화해 루트로 간다. 그룹 안을 보고 있던
  // 사용자에게는 목록에 아무것도 나타나지 않아 복제가 조용히 실패한 것처럼 보였다.
  it("복제본을 원본과 같은 그룹에 만든다", async () => {
    const api = createMockApi();
    const source = savedWorkspace({ id: "saved-1", groupName: "Clients" });
    vi.mocked(api.savedWorkspaces.list).mockResolvedValue([source]);
    vi.mocked(api.savedWorkspaces.create).mockResolvedValue(
      savedWorkspace({ id: "saved-2", groupName: "Clients" }),
    );
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().duplicateSavedWorkspace("saved-1");

    expect(api.savedWorkspaces.create).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: "Clients" }),
    );
  });
});