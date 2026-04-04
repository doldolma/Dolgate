import { describe, expect, it } from "vitest";
import type { SftpPaneState } from "../types";
import {
  buildSftpHostPickerPane,
  createEmptyPane,
  resolveNextSftpSelection,
  resolveSftpPaneIdByEndpoint,
  resolveSftpVisibleEntryPaths,
  updatePaneState,
} from "./sftp";

function createPane(
  overrides: Partial<SftpPaneState> = {},
): SftpPaneState {
  return {
    ...createEmptyPane("left"),
    currentPath: "/tmp",
    entries: [
      {
        path: "/tmp/a.txt",
        name: "a.txt",
        isDirectory: false,
        size: 1,
        mtime: "2026-04-04T00:00:00.000Z",
        kind: "file",
      },
      {
        path: "/tmp/b.txt",
        name: "b.txt",
        isDirectory: false,
        size: 1,
        mtime: "2026-04-04T00:00:00.000Z",
        kind: "file",
      },
      {
        path: "/tmp/c.txt",
        name: "c.txt",
        isDirectory: false,
        size: 1,
        mtime: "2026-04-04T00:00:00.000Z",
        kind: "file",
      },
    ],
    ...overrides,
  };
}

describe("sftp utils", () => {
  it("resolves pane id from endpoint references", () => {
    expect(
      resolveSftpPaneIdByEndpoint(
        {
          sftp: {
            localHomePath: "/Users/test",
            leftPane: createPane({
              endpoint: {
                id: "endpoint-left",
                hostId: "host-1",
                path: "/tmp",
                kind: "remote",
                title: "Host 1",
                connectedAt: "2026-04-04T00:00:00.000Z",
              },
            }),
            rightPane: createEmptyPane("right"),
            transfers: [],
            pendingConflictDialog: null,
          },
        },
        "endpoint-left",
      ),
    ).toBe("left");
  });

  it("resolves selection ranges against visible entry paths", () => {
    const pane = createPane({
      selectedPaths: ["/tmp/a.txt"],
      selectionAnchorPath: "/tmp/a.txt",
    });

    expect(
      resolveNextSftpSelection(pane, {
        entryPath: "/tmp/c.txt",
        range: true,
      }),
    ).toEqual({
      selectedPaths: ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"],
      selectionAnchorPath: "/tmp/a.txt",
    });
  });

  it("builds a host picker pane and preserves selected host context", () => {
    const pane = createPane({
      sourceKind: "host",
      endpoint: {
        id: "endpoint-right",
        hostId: "host-2",
        path: "/srv",
        kind: "remote",
        title: "Host 2",
        connectedAt: "2026-04-04T00:00:00.000Z",
      },
      selectedHostId: null,
      connectingHostId: "host-3",
    });

    expect(buildSftpHostPickerPane(pane)).toMatchObject({
      sourceKind: "host",
      endpoint: null,
      selectedHostId: "host-2",
      entries: [],
      selectedPaths: [],
    });
  });

  it("updates only the targeted pane state", () => {
    const state = {
      sftp: {
        localHomePath: "/Users/test",
        leftPane: createEmptyPane("left"),
        rightPane: createEmptyPane("right"),
        transfers: [],
        pendingConflictDialog: null,
      },
    };

    const next = updatePaneState(state, "right", createPane({ id: "right" as const }));

    expect(next.leftPane.id).toBe("left");
    expect(next.rightPane.currentPath).toBe("/tmp");
  });

  it("filters visible entry paths from the current query", () => {
    const pane = createPane({
      filterQuery: "b.",
    });

    expect(resolveSftpVisibleEntryPaths(pane)).toEqual(["/tmp/b.txt"]);
  });
});
