import { describe, expect, it } from "vitest";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";

describe("createAppStore", () => {
  it("composes the store with stable public actions", () => {
    const store = createAppStore(createMockApi());
    const state = store.getState();

    expect(state.activeWorkspaceTab).toBe("home");
    expect(typeof state.bootstrap).toBe("function");
    expect(typeof state.connectHost).toBe("function");
    expect(typeof state.openHostContainersTab).toBe("function");
    expect(typeof state.connectSftpHost).toBe("function");
    expect(typeof state.handleCoreEvent).toBe("function");
  });
});
