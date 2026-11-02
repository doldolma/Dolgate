import { describe, expect, it, vi } from "vitest";
import type { GroupRecord, HostDraft, HostSecretInput } from "@shared";
import { t } from "../i18n";
import { resolveImportTarget } from "./import-target";

const TEAM = "team-1";

const draft: HostDraft = {
  kind: "ssh",
  label: "web",
  groupName: "Prod",
  tags: [],
  terminalThemeId: null,
  hostname: "web.example.test",
  port: 22,
  username: "deploy",
  authType: "privateKey",
};

function group(name: string, parentPath: string | null): GroupRecord {
  return {
    id: `group:${name}`,
    name,
    path: parentPath ? `${parentPath}/${name}` : name,
    parentPath,
  } as GroupRecord;
}

/** 개인 저장소와 팀 하나를 가진 메인 — 어디에 무엇을 썼는지만 본다. */
function harness({ editable = true, onDevice = true } = {}) {
  const personal = {
    groups: { list: vi.fn(() => [group("Mine", null)]), create: vi.fn((_id: string, name: string, parent: string | null) => group(name, parent)) },
    hosts: { create: vi.fn((id: string, value: HostDraft, secretRef?: string | null) => ({ id, ...value, secretRef })) },
  };
  const teamGroups = {
    list: vi.fn(() => [group("Prod", null)]),
    create: vi.fn((_id: string, name: string, parent: string | null) => group(name, parent)),
  };
  const scope = { groups: teamGroups, secrets: {}, secretMetadata: {} };
  const vaults = {
    getScope: vi.fn((vaultId: string) => (onDevice && vaultId === TEAM ? scope : null)),
    canEditVault: vi.fn(() => editable),
    createHost: vi.fn((_vaultId: string, id: string, value: HostDraft, secretRef?: string | null) => ({ id, ...value, secretRef })),
    setMyHostCredentials: vi.fn(),
  };
  const ctx = {
    groups: personal.groups,
    hosts: personal.hosts,
    persistImportedSecret: vi.fn(async (_label: string, _secrets: HostSecretInput) => "secret:personal"),
    persistSecret: vi.fn(async (_label: string, _secrets: HostSecretInput, _target?: unknown) => "secret:team"),
    hasSecretValue: (secrets: HostSecretInput) => Object.values(secrets).some(Boolean),
    vaults,
  };
  return { ctx: ctx as never as Parameters<typeof resolveImportTarget>[0], raw: ctx, personal, teamGroups, scope, vaults };
}

describe("resolveImportTarget", () => {
  it.each([{}, { vaultId: null }, { vaultId: "personal" }, { vaultId: "  " }])(
    "writes into your own vault for %j, as before",
    async (request) => {
      const { ctx, raw, personal, vaults } = harness();
      const target = resolveImportTarget(ctx, request);

      expect(target.vaultId).toBe("personal");
      expect(target.listGroupPaths()).toEqual(["Mine"]);
      target.createGroup("Web", "Mine");
      expect(personal.groups.create).toHaveBeenCalledWith(expect.any(String), "Web", "Mine");
      const secret = await target.persistSecret("OpenSSH web", { privateKeyPem: "KEY" });
      expect(raw.persistImportedSecret).toHaveBeenCalledWith("OpenSSH web", { privateKeyPem: "KEY" });
      target.createHost("host-1", draft, secret);
      expect(personal.hosts.create).toHaveBeenCalledWith("host-1", draft, "secret:personal");
      expect(vaults.getScope).not.toHaveBeenCalled();
      expect(vaults.createHost).not.toHaveBeenCalled();
    },
  );

  it("refuses a team that is not on this device", () => {
    const { ctx } = harness({ onDevice: false });
    expect(() => resolveImportTarget(ctx, { vaultId: TEAM })).toThrow(t("teams.notOnDevice"));
  });

  it("refuses a team you can only read", () => {
    const { ctx, vaults } = harness({ editable: false });
    expect(() => resolveImportTarget(ctx, { vaultId: TEAM, shareSecrets: true })).toThrow(t("teams.readOnly"));
    expect(vaults.canEditVault).toHaveBeenCalledWith(TEAM);
  });

  it("writes groups, the team's secret and hosts into the team when sharing", async () => {
    const { ctx, raw, personal, teamGroups, scope, vaults } = harness();
    const target = resolveImportTarget(ctx, { vaultId: TEAM });

    expect(target.vaultId).toBe(TEAM);
    expect(target.listGroupPaths()).toEqual(["Prod"]);
    target.createGroup("Web", "Prod");
    expect(teamGroups.create).toHaveBeenCalledWith(expect.any(String), "Web", "Prod");

    const secret = await target.persistSecret("OpenSSH web", { privateKeyPem: "KEY" });
    expect(raw.persistSecret).toHaveBeenCalledWith("OpenSSH web", { privateKeyPem: "KEY" }, scope);
    expect(secret).toEqual({ secretRef: "secret:team" });
    target.createHost("host-1", draft, secret);
    expect(vaults.createHost).toHaveBeenCalledWith(TEAM, "host-1", draft, "secret:team");
    expect(vaults.setMyHostCredentials).not.toHaveBeenCalled();

    expect(personal.groups.create).not.toHaveBeenCalled();
    expect(personal.hosts.create).not.toHaveBeenCalled();
    expect(raw.persistImportedSecret).not.toHaveBeenCalled();
  });

  it("keeps the secret out of the team and puts it in my credentials when sharing is off", async () => {
    const { ctx, raw, vaults } = harness();
    const target = resolveImportTarget(ctx, { vaultId: TEAM, shareSecrets: false });

    const secrets: HostSecretInput = { kind: "ssh", username: "deploy", privateKeyPem: "KEY", passphrase: "pp" };
    const secret = await target.persistSecret("OpenSSH web", secrets);
    expect(raw.persistSecret).not.toHaveBeenCalled();
    target.createHost("host-1", draft, secret);

    expect(vaults.createHost).toHaveBeenCalledWith(TEAM, "host-1", draft, null);
    // 비밀번호·키만 옮긴다 — 사용자 이름은 팀 레코드에 있다.
    expect(vaults.setMyHostCredentials).toHaveBeenCalledWith("host-1", { privateKeyPem: "KEY", passphrase: "pp" });
    expect(raw.persistImportedSecret).not.toHaveBeenCalled();
  });

  it("makes nothing for an empty secret", async () => {
    const { ctx, raw, vaults } = harness();
    for (const shareSecrets of [true, false]) {
      const target = resolveImportTarget(ctx, { vaultId: TEAM, shareSecrets });
      await expect(target.persistSecret("OpenSSH web", { password: "" })).resolves.toBeNull();
      target.createHost("host-1", draft, null);
    }
    expect(raw.persistSecret).not.toHaveBeenCalled();
    expect(vaults.setMyHostCredentials).not.toHaveBeenCalled();
  });
});
