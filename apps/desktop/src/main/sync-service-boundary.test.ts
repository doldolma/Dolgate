import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainDir = path.dirname(fileURLToPath(import.meta.url));
const syncServicePath = path.join(mainDir, "sync-service.ts");

// tailnet 노드 이름은 기기마다 달라야 한다 — 같은 이름으로 여러 기기가 등록하면 컨트롤
// 플레인이 -1, -2 를 붙여 기기 목록이 엉킨다. settings 가 동기화 대상이 아니라는 사실에
// 기대고 있으므로, 나중에 누군가 settings 를 동기화에 얹으면 이 값도 딸려 나간다.
describe("device-local settings stay out of sync", () => {
  it("never puts the tailnet node name on the wire", () => {
    const content = fs.readFileSync(syncServicePath, "utf8");

    expect(content).not.toContain("tailnetHostname");
  });
});

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
