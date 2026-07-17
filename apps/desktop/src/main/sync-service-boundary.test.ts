import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainDir = path.dirname(fileURLToPath(import.meta.url));
const syncServicePath = path.join(mainDir, "sync-service.ts");

describe("SyncService generation boundary", () => {
  it("does not re-read mutable vault or server state inside a sync operation", () => {
    const content = fs.readFileSync(syncServicePath, "utf8");

    expect(content).not.toContain("authService.getVaultKeyBase64(");
    expect(content).not.toContain("authService.getVaultEpoch(");
    expect(content).not.toContain("authService.getServerUrl(");
    expect(content).toContain("captureSyncLease()");
    expect(content).toContain("lease.vaultKeyBase64");
    expect(content).toContain("lease.vaultEpoch");
    expect(content).toContain("lease.serverUrl");
  });
});
