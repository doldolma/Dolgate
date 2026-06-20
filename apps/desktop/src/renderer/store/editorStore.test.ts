import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "@shared";
import { createEditorStore } from "./editorStore";

function makeApi(sftp: Partial<DesktopApi["sftp"]>): DesktopApi {
  return { sftp } as unknown as DesktopApi;
}

const baseRead = {
  path: "/etc/app.conf",
  content: "port = 8080\n",
  size: 12,
  mtime: "2026-06-20T00:00:00Z",
  mode: 0o644,
};

describe("editorStore", () => {
  it("opens a file and tracks dirty state against the original", async () => {
    const store = createEditorStore(
      makeApi({ readFile: vi.fn().mockResolvedValue(baseRead) }),
    );

    await store.getState().openEditor({
      endpointId: "ep1",
      remotePath: "/etc/app.conf",
      fileName: "app.conf",
    });

    expect(store.getState().session?.content).toBe("port = 8080\n");
    expect(store.getState().session?.isDirty).toBe(false);

    store.getState().setEditorContent("port = 9090\n");
    expect(store.getState().session?.isDirty).toBe(true);

    // Same-length revert back to the original clears the dirty flag.
    store.getState().setEditorContent("port = 8080\n");
    expect(store.getState().session?.isDirty).toBe(false);
  });

  it("silently declines to open binary or oversized files", async () => {
    const store = createEditorStore(
      makeApi({
        readFile: vi
          .fn()
          .mockRejectedValue(
            new Error("file appears to be binary and cannot be edited as text"),
          ),
      }),
    );

    await store.getState().openEditor({
      endpointId: "ep1",
      remotePath: "/bin/ls",
      fileName: "ls",
    });

    expect(store.getState().target).toBeNull();
    expect(store.getState().session).toBeNull();
    expect(store.getState().error).toBeNull();
  });

  it("saves with the snapshot and refreshes it afterwards", async () => {
    const readFile = vi
      .fn()
      .mockResolvedValueOnce(baseRead)
      .mockResolvedValueOnce({
        ...baseRead,
        content: "port = 9090\n",
        size: 12,
        mtime: "2026-06-20T01:00:00Z",
      });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const store = createEditorStore(makeApi({ readFile, writeFile }));

    await store.getState().openEditor({
      endpointId: "ep1",
      remotePath: "/etc/app.conf",
      fileName: "app.conf",
    });
    store.getState().setEditorContent("port = 9090\n");

    const ok = await store.getState().saveEditor();
    expect(ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "port = 9090\n",
        expectedSize: 12,
        expectedMtime: "2026-06-20T00:00:00Z",
      }),
    );
    expect(store.getState().session?.isDirty).toBe(false);
    // Snapshot advanced so the next save does not falsely conflict.
    expect(store.getState().session?.mtime).toBe("2026-06-20T01:00:00Z");
  });

  it("flags conflicts from the core error", async () => {
    const store = createEditorStore(
      makeApi({
        readFile: vi.fn().mockResolvedValue(baseRead),
        writeFile: vi
          .fn()
          .mockRejectedValue(new Error("sftp-conflict: remote file changed")),
      }),
    );
    await store.getState().openEditor({
      endpointId: "ep1",
      remotePath: "/etc/app.conf",
      fileName: "app.conf",
    });
    store.getState().setEditorContent("changed");

    const ok = await store.getState().saveEditor();
    expect(ok).toBe(false);
    expect(store.getState().conflict).toBe(true);
  });

  it("requests a sudo password when the core asks for one", async () => {
    const writeFile = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("sftp-sudo-required: sudo password is required"),
      )
      .mockResolvedValueOnce(undefined);
    const store = createEditorStore(
      makeApi({
        readFile: vi.fn().mockResolvedValue(baseRead),
        writeFile,
      }),
    );
    await store.getState().openEditor({
      endpointId: "ep1",
      remotePath: "/etc/nginx.conf",
      fileName: "nginx.conf",
    });
    store.getState().setEditorContent("changed");

    const first = await store.getState().saveEditor();
    expect(first).toBe(false);
    expect(store.getState().sudoRequired).toBe(true);

    const second = await store.getState().saveEditor({ sudoPassword: "pw" });
    expect(second).toBe(true);
    expect(writeFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ sudoPassword: "pw" }),
    );
    expect(store.getState().sudoRequired).toBe(false);
  });
});
