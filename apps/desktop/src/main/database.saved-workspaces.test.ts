import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedWorkspaceNode, SavedWorkspaceRecord } from "@shared";

let tempDir = "";

async function createRepository() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-saved-workspace-db-"));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const storage = await import("./state-storage");
  storage.resetDesktopStateStorageForTests();
  const { SavedWorkspaceRepository } = await import("./database");
  return new SavedWorkspaceRepository();
}

function root(ratio = 0.6): SavedWorkspaceNode {
  return {
    id: "root",
    kind: "split",
    axis: "horizontal",
    ratio,
    first: {
      id: "host-pane",
      kind: "leaf",
      target: { kind: "host", hostId: "host-1", label: "Prod" },
    },
    second: {
      id: "local-pane",
      kind: "leaf",
      target: { kind: "local", label: "Local shell" },
    },
  };
}

afterEach(() => {
  delete process.env.DOLSSH_USER_DATA_DIR;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
  vi.resetModules();
});

describe("SavedWorkspaceRepository", () => {
  it("always creates a new saved record and exposes no layout overwrite operation", async () => {
    const repository = await createRepository();

    const first = repository.create({ name: "Operations", root: root() });
    const second = repository.create({ name: "Operations", root: root() });

    expect(first.id).not.toBe(second.id);
    expect(repository.list()).toHaveLength(2);
    expect("update" in repository).toBe(false);

    const renamed = repository.rename(first.id, "Morning operations");
    expect(renamed.name).toBe("Morning operations");
    expect(renamed.root).toEqual(first.root);
  });

  it("sorts favorites and recent opens, then removes only the requested record", async () => {
    const repository = await createRepository();
    const older = repository.create({ name: "Older", root: root() });
    const favorite = repository.create({ name: "Favorite", root: root() });

    repository.touchOpened(older.id);
    repository.setFavorite(favorite.id, true);

    expect(repository.list().map((record) => record.id)).toEqual([
      favorite.id,
      older.id,
    ]);

    repository.remove(favorite.id);
    expect(repository.list().map((record) => record.id)).toEqual([older.id]);
  });

  it("persists Workspace group placement through group path mutations", async () => {
    const repository = await createRepository();
    const { GroupRepository } = await import("./database");
    const groups = new GroupRepository();
    groups.create("group-root", "root");
    groups.create("group-branch", "branch", "root");
    groups.create("group-leaf", "leaf", "root/branch");
    groups.create("group-clients", "clients");

    const workspace = repository.create({
      name: "Grouped",
      root: root(),
      groupName: "root/branch/leaf",
    });
    expect(workspace.groupName).toBe("root/branch/leaf");

    expect(repository.moveToGroup(workspace.id, "root").groupName).toBe(
      "root",
    );
    repository.moveToGroup(workspace.id, "root/branch/leaf");

    const renamed = groups.rename("root/branch", "renamed");
    expect(renamed.savedWorkspaces?.[0]?.groupName).toBe(
      "root/renamed/leaf",
    );

    const moved = groups.move("root/renamed", "clients");
    expect(moved.savedWorkspaces?.[0]?.groupName).toBe(
      "clients/renamed/leaf",
    );

    const reparented = groups.remove(
      "clients/renamed",
      "reparent-descendants",
    );
    expect(reparented.savedWorkspaces?.[0]?.groupName).toBe("clients/leaf");

    const deleted = groups.remove("clients", "delete-subtree");
    expect(deleted.savedWorkspaces).toEqual([]);
    expect(deleted.removedWorkspaceIds).toEqual([workspace.id]);
    expect(repository.list()).toEqual([]);
  });

  it("filters malformed remote records and normalizes split ratios on replaceAll", async () => {
    const repository = await createRepository();
    const now = "2026-09-05T00:00:00.000Z";
    const valid: SavedWorkspaceRecord = {
      id: "valid",
      version: 1,
      name: "Valid",
      root: root(4),
      favorite: false,
      lastOpenedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const onePane = {
      ...valid,
      id: "one-pane",
      root: {
        id: "only",
        kind: "leaf",
        target: { kind: "local", label: "Only pane" },
      },
    } as unknown as SavedWorkspaceRecord;

    repository.replaceAll([valid, onePane]);

    const records = repository.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("valid");
    expect(records[0]?.root).toMatchObject({ ratio: 0.9 });
  });
});
