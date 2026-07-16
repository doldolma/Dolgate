import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { registerAuthIpcHandlers } from "./auth";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

function getRegisteredHandler(channel: string) {
  const match = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!match) {
    throw new Error(`Handler not registered for channel: ${channel}`);
  }
  return match[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("registerAuthIpcHandlers", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
  });

  it("resets sync recovery and bootstraps after vault migration", async () => {
    const migrateVault = vi.fn().mockResolvedValue(undefined);
    const resetVaultRecoveryState = vi.fn();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      authService: { migrateVault },
      syncService: { resetVaultRecoveryState, bootstrap },
    } as never;

    registerAuthIpcHandlers(ctx);
    const handler = getRegisteredHandler(ipcChannels.auth.migrateVault);
    await handler({}, "sync-passphrase");

    expect(migrateVault).toHaveBeenCalledWith("sync-passphrase");
    expect(resetVaultRecoveryState).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(migrateVault.mock.invocationCallOrder[0]).toBeLessThan(
      resetVaultRecoveryState.mock.invocationCallOrder[0] as number,
    );
    expect(resetVaultRecoveryState.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[0] as number,
    );
  });
});
