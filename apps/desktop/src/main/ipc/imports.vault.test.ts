import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupRecord, HostDraft, HostSecretInput } from "@shared";
import { t } from "../i18n";
import type { OpenSshImportService } from "../openssh-import-service";
import { buildTermiusEntityKey, type TermiusExportHost, type TermiusSnapshot } from "../termius-import-service";
import type { XshellSnapshot, XshellSnapshotHost } from "../xshell-import-service";

/**
 * 가져오기 셋(OpenSSH·Xshell·Termius)이 고른 볼트에 쓰는지 — 요청에서 저장소까지. 팀이면 그 팀에만 생기고 개인에는
 * 아무것도 없다. 공유를 켜면 팀 비밀값, 끄면 호스트마다 내 자격 증명이다.
 */

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "0.0.0" },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

// Xshell 비밀번호 풀기는 Windows 에서만 된다 — 여기서는 풀렸다고 본다.
vi.mock("../xshell-password-decryptor", () => ({
  resolveCurrentXshellPasswordSecurityContext: vi.fn(async () => ({ sid: "S-1", username: "tester" })),
  decryptXshellPassword: vi.fn(() => ({ ok: true, password: "db-pw" })),
}));

const { registerImportIpcHandlers } = await import("./imports");

const TEAM = "team-1";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
const tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-import-vault-"));
const keyPath = path.join(tempDir, "id_deploy");
writeFileSync(keyPath, KEY);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function group(name: string, parentPath: string | null): GroupRecord {
  return { id: `group:${name}`, name, path: parentPath ? `${parentPath}/${name}` : name, parentPath } as GroupRecord;
}

function opensshSnapshot() {
  const host = (key: string, identityFilePath: string | null) => ({
    key,
    alias: key,
    hostname: `${key}.example.test`,
    port: 22,
    username: "deploy",
    authType: identityFilePath ? "privateKey" : "password",
    identityFilePath,
    sourceFilePath: "/conf/config",
    sourceLine: 1,
  });
  return {
    sources: [],
    warnings: [],
    // web-1·web-2 는 같은 키 파일, db 는 비밀번호.
    hostsByKey: new Map([
      ["web-1", host("web-1", keyPath)],
      ["web-2", host("web-2", keyPath)],
      ["db", host("db", null)],
    ]),
  };
}

function xshellSnapshot(): XshellSnapshot {
  const host = (key: string, extra: Partial<XshellSnapshotHost>): XshellSnapshotHost => ({
    key,
    label: key,
    hostname: `${key}.example.test`,
    port: 22,
    username: "deploy",
    authType: "password",
    groupPath: "Servers",
    privateKeyPath: null,
    sourceFilePath: `/sessions/Servers/${key}.xsh`,
    duplicateKey: key,
    hasPasswordHint: false,
    hasAuthProfile: false,
    encryptedPassword: null,
    authMethodList: null,
    sessionFileVersion: "7.0",
    masterPasswordEnabled: false,
    ...extra,
  });
  return {
    sources: [],
    groupPaths: new Set(["Servers"]),
    hostsByKey: new Map([
      ["web", host("web", { authType: "privateKey", privateKeyPath: keyPath })],
      ["db", host("db", { hasPasswordHint: true, encryptedPassword: "ENC" })],
    ]),
    warnings: [],
    seenDuplicateKeys: new Set(),
    seenSourcePaths: new Set(),
    skippedExistingHostCount: 0,
    skippedDuplicateHostCount: 0,
  };
}

// 두 호스트가 같은 Termius ID(키)를 쓴다.
const termiusHosts: TermiusExportHost[] = [1, 2].map((id) => ({
  id,
  localId: id,
  name: `web-${id}`,
  address: `10.0.0.${id}`,
  sshConfig: { port: 22 },
  identity: { id: 100, localId: 100, username: "deploy", sshKey: { privateKeyPem: KEY } },
}));
const termiusKeys = termiusHosts.map((host) =>
  buildTermiusEntityKey(host.id, host.localId, `${host.name}|${host.address}|`),
);

function termiusSnapshot(): TermiusSnapshot {
  return {
    bundle: { meta: { termiusDataDir: "/tmp/Termius" }, groups: [], hosts: termiusHosts },
    hostsByKey: new Map(termiusHosts.map((host, index) => [termiusKeys[index]!, host])),
  } as TermiusSnapshot;
}

function harness({ editable = true } = {}) {
  const personal = {
    groups: { list: vi.fn(() => [] as GroupRecord[]), create: vi.fn((_id: string, name: string, parent: string | null) => group(name, parent)) },
    hosts: { create: vi.fn((id: string, draft: HostDraft, secretRef?: string | null) => ({ id, ...draft, secretRef })) },
  };
  const teamGroups = {
    list: vi.fn(() => [group("Prod", null)]),
    create: vi.fn((_id: string, name: string, parent: string | null) => group(name, parent)),
  };
  const scope = { groups: teamGroups, secrets: {}, secretMetadata: {} };
  const vaults = {
    getScope: vi.fn((vaultId: string) => (vaultId === TEAM ? scope : null)),
    canEditVault: vi.fn(() => editable),
    createHost: vi.fn((_vaultId: string, id: string, draft: HostDraft, secretRef?: string | null) => ({ id, ...draft, secretRef })),
    setMyHostCredentials: vi.fn(),
  };
  const services = {
    opensshImportService: { getSnapshot: vi.fn(() => opensshSnapshot()), discardSnapshot: vi.fn() } as unknown as OpenSshImportService,
    xshellImportService: { getSnapshot: vi.fn(() => xshellSnapshot()), discardSnapshot: vi.fn() },
    termiusImportService: { getSnapshot: vi.fn(() => termiusSnapshot()), discardSnapshot: vi.fn() },
  };
  const ctx = {
    ...services,
    groups: personal.groups,
    hosts: personal.hosts,
    persistImportedSecret: vi.fn(async (_label: string, _secrets: HostSecretInput) => "secret:personal"),
    persistSecret: vi.fn(async (_label: string, _secrets: HostSecretInput, _target?: unknown) => "secret:team"),
    hasSecretValue: (secrets: HostSecretInput) => Object.values(secrets).some(Boolean),
    vaults,
    activityLogs: { append: vi.fn() },
    queueSync: vi.fn(),
  };
  registerImportIpcHandlers(ctx as never);
  const call = (channel: string, input: object) => handlers.get(channel)!({}, input);
  return { ctx, personal, teamGroups, scope, vaults, services, call };
}

/** 개인 저장소에 아무것도 쓰지 않았다. */
function expectNothingPersonal(h: ReturnType<typeof harness>) {
  expect(h.personal.groups.create).not.toHaveBeenCalled();
  expect(h.personal.hosts.create).not.toHaveBeenCalled();
  expect(h.ctx.persistImportedSecret).not.toHaveBeenCalled();
}

/** 어느 볼트에도 아무것도 쓰지 않았다. */
function expectNothingWritten(h: ReturnType<typeof harness>) {
  expectNothingPersonal(h);
  expect(h.teamGroups.create).not.toHaveBeenCalled();
  expect(h.vaults.createHost).not.toHaveBeenCalled();
  expect(h.vaults.setMyHostCredentials).not.toHaveBeenCalled();
  expect(h.ctx.persistSecret).not.toHaveBeenCalled();
}

const createdHosts = (h: ReturnType<typeof harness>) =>
  h.vaults.createHost.mock.calls.map(([vaultId, , draft, secretRef]) => ({ vaultId, label: draft.label, groupName: draft.groupName, secretRef }));

beforeEach(() => {
  handlers.clear();
});

describe("OpenSSH 가져오기 — 고른 볼트로", () => {
  const input = {
    snapshotId: "snapshot-1",
    selectedHostKeys: ["web-1", "web-2", "db"],
    groupPath: "Prod/Web",
  };

  it("writes into the team only, with one team key for the two hosts that share it", async () => {
    const h = harness();
    const result = await h.call("openssh:import-selection", { ...input, vaultId: TEAM, shareSecrets: true });

    expect(result).toMatchObject({ createdHostCount: 3, createdSecretCount: 1, skippedHostCount: 0 });
    // 팀에 있는 Prod 는 두고, 없는 Web 만 그 아래 만든다.
    expect(h.teamGroups.create.mock.calls.map(([, name, parent]) => [name, parent])).toEqual([["Web", "Prod"]]);
    expect(h.ctx.persistSecret).toHaveBeenCalledTimes(1);
    expect(h.ctx.persistSecret).toHaveBeenCalledWith("OpenSSH web-1", { privateKeyPem: KEY }, h.scope);
    expect(createdHosts(h)).toEqual([
      { vaultId: TEAM, label: "web-1", groupName: "Prod/Web", secretRef: "secret:team" },
      { vaultId: TEAM, label: "web-2", groupName: "Prod/Web", secretRef: "secret:team" },
      { vaultId: TEAM, label: "db", groupName: "Prod/Web", secretRef: null },
    ]);
    expect(h.vaults.setMyHostCredentials).not.toHaveBeenCalled();
    expectNothingPersonal(h);
    expect(h.ctx.activityLogs.append).toHaveBeenCalledWith(
      "info",
      "audit",
      expect.anything(),
      expect.objectContaining({ vaultId: TEAM, createdHostCount: 3 }),
    );
    expect(h.ctx.queueSync).toHaveBeenCalled();
  });

  it("puts the key in my credentials for each host using it when sharing is off", async () => {
    const h = harness();
    await h.call("openssh:import-selection", { ...input, vaultId: TEAM, shareSecrets: false });

    expect(h.ctx.persistSecret).not.toHaveBeenCalled();
    expect(createdHosts(h).map((host) => host.secretRef)).toEqual([null, null, null]);
    const hostIds = h.vaults.createHost.mock.calls.map(([, id]) => id);
    expect(h.vaults.setMyHostCredentials.mock.calls).toEqual([
      [hostIds[0], { privateKeyPem: KEY }],
      [hostIds[1], { privateKeyPem: KEY }],
    ]);
    expectNothingPersonal(h);
  });

  it("refuses a team you can only read before writing anything, and keeps the config for another try", async () => {
    const h = harness({ editable: false });
    await expect(h.call("openssh:import-selection", { ...input, vaultId: TEAM })).rejects.toThrow(t("teams.readOnly"));
    expectNothingWritten(h);
    expect(h.services.opensshImportService.discardSnapshot).not.toHaveBeenCalled();
  });

  it("writes into your own vault without a vault, as before", async () => {
    const h = harness();
    await h.call("openssh:import-selection", input);

    expect(h.personal.hosts.create.mock.calls.map(([, , secretRef]) => secretRef)).toEqual([
      "secret:personal",
      "secret:personal",
      null,
    ]);
    expect(h.vaults.getScope).not.toHaveBeenCalled();
    expect(h.vaults.createHost).not.toHaveBeenCalled();
    expect(h.services.opensshImportService.discardSnapshot).toHaveBeenCalledWith("snapshot-1");
  });
});

describe("Xshell 가져오기 — 고른 볼트로", () => {
  const input = { snapshotId: "snapshot-x", selectedGroupPaths: ["Servers"], selectedHostKeys: [] };

  it("writes the group, team secrets and hosts into the team only", async () => {
    const h = harness();
    const result = await h.call("xshell:import-selection", { ...input, vaultId: TEAM, shareSecrets: true });

    expect(result).toMatchObject({ createdGroupCount: 1, createdHostCount: 2, createdSecretCount: 2 });
    expect(h.teamGroups.create.mock.calls.map(([, name, parent]) => [name, parent])).toEqual([["Servers", null]]);
    expect(h.ctx.persistSecret.mock.calls).toEqual([
      ["Xshell • db", { password: "db-pw" }, h.scope],
      ["Xshell • web", { privateKeyPem: KEY }, h.scope],
    ]);
    expect(createdHosts(h)).toEqual([
      { vaultId: TEAM, label: "db", groupName: "Servers", secretRef: "secret:team" },
      { vaultId: TEAM, label: "web", groupName: "Servers", secretRef: "secret:team" },
    ]);
    expectNothingPersonal(h);
  });

  it("puts the password and key in my credentials when sharing is off", async () => {
    const h = harness();
    await h.call("xshell:import-selection", { ...input, vaultId: TEAM, shareSecrets: false });

    expect(h.ctx.persistSecret).not.toHaveBeenCalled();
    const hostIds = h.vaults.createHost.mock.calls.map(([, id]) => id);
    expect(h.vaults.setMyHostCredentials.mock.calls).toEqual([
      [hostIds[0], { password: "db-pw" }],
      [hostIds[1], { privateKeyPem: KEY }],
    ]);
    expectNothingPersonal(h);
  });

  it("refuses a team you can only read before writing anything", async () => {
    const h = harness({ editable: false });
    await expect(h.call("xshell:import-selection", { ...input, vaultId: TEAM })).rejects.toThrow(t("teams.readOnly"));
    expectNothingWritten(h);
    expect(h.services.xshellImportService.discardSnapshot).not.toHaveBeenCalled();
  });
});

describe("Termius 가져오기 — 고른 볼트로", () => {
  const input = { snapshotId: "snapshot-t", selectedGroupPaths: [], selectedHostKeys: termiusKeys };

  it("writes one team secret for an identity two hosts share, into the team only", async () => {
    const h = harness();
    const result = await h.call("termius:import-selection", { ...input, vaultId: TEAM, shareSecrets: true });

    expect(result).toMatchObject({ createdHostCount: 2, createdSecretCount: 1 });
    expect(h.ctx.persistSecret).toHaveBeenCalledTimes(1);
    expect(h.ctx.persistSecret.mock.calls[0]?.[2]).toBe(h.scope);
    expect(createdHosts(h).map((host) => [host.vaultId, host.secretRef])).toEqual([
      [TEAM, "secret:team"],
      [TEAM, "secret:team"],
    ]);
    expectNothingPersonal(h);
  });

  it("puts the identity's key in my credentials for each host when sharing is off", async () => {
    const h = harness();
    await h.call("termius:import-selection", { ...input, vaultId: TEAM, shareSecrets: false });

    expect(h.ctx.persistSecret).not.toHaveBeenCalled();
    expect(h.vaults.setMyHostCredentials).toHaveBeenCalledTimes(2);
    // Termius 는 키 글의 앞뒤 공백을 다듬는다.
    expect(h.vaults.setMyHostCredentials.mock.calls.map(([, credentials]) => credentials)).toEqual([
      { privateKeyPem: KEY.trim() },
      { privateKeyPem: KEY.trim() },
    ]);
    expectNothingPersonal(h);
  });

  it("refuses a team you can only read before writing anything", async () => {
    const h = harness({ editable: false });
    await expect(h.call("termius:import-selection", { ...input, vaultId: TEAM })).rejects.toThrow(t("teams.readOnly"));
    expectNothingWritten(h);
  });
});
