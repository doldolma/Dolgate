import { describe, expect, it, vi } from "vitest";
import { normalizeHostEnvVars } from "@shared";
import { createSecretCoordinator } from "./secret-coordinator";

function createCoordinator(overrides: Record<string, unknown> = {}) {
  const deps = {
    secretStore: {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
    },
    secretMetadata: {
      upsert: vi.fn(),
    },
    hosts: {
      updateSecretRef: vi.fn(),
    },
    activityLogs: {
      append: vi.fn(),
    },
    queueSync: vi.fn(),
    inspectCertificate: vi.fn().mockResolvedValue({ status: "valid" }),
    ...overrides,
  } as any;

  return {
    deps,
    coordinator: createSecretCoordinator(deps),
  };
}

describe("secret coordinator", () => {
  it("does not persist empty secret payloads", async () => {
    const { deps, coordinator } = createCoordinator();

    await expect(coordinator.persistSecret("Prod", {})).resolves.toBeNull();

    expect(deps.secretStore.save).not.toHaveBeenCalled();
    expect(deps.secretMetadata.upsert).not.toHaveBeenCalled();
  });

  it("merges runtime secret patches without erasing omitted values", () => {
    const { coordinator } = createCoordinator();

    expect(
      coordinator.mergeSecrets(
        { password: "old", passphrase: "keep", privateKeyPem: "key" },
        { password: "new" },
      ),
    ).toEqual({
      password: "new",
      passphrase: "keep",
      privateKeyPem: "key",
      certificateText: undefined,
    });
  });

  it("rejects missing and invalid certificate auth before connecting", async () => {
    const { coordinator } = createCoordinator({
      inspectCertificate: vi.fn().mockResolvedValue({ status: "expired" }),
    });
    const host = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      secretRef: null,
    } as any;

    await expect(
      coordinator.ensureCertificateAuthReady(host, {}),
    ).rejects.toThrow("SSH 인증서를 찾을 수 없습니다.");
    await expect(
      coordinator.ensureCertificateAuthReady(host, {
        certificateText: "cert",
      }),
    ).rejects.toThrow("SSH 인증서가 만료되었습니다.");
  });

  it("persists and round-trips env vars (env-only host still gets a secretRef)", async () => {
    const saved: Record<string, string> = {};
    const { deps, coordinator } = createCoordinator({
      secretStore: {
        save: vi.fn(async (ref: string, json: string) => {
          saved[ref] = json;
        }),
        load: vi.fn(async (ref: string) => saved[ref] ?? null),
      },
    });

    const secretRef = await coordinator.persistSecret("Prod", {
      env: [
        { key: "FOO", value: "bar" },
        { key: "1BAD", value: "x" },
        { key: "MULTI", value: "a\nb" },
      ],
    });
    expect(secretRef).toBeTruthy();
    expect(deps.secretStore.save).toHaveBeenCalledOnce();

    const loaded = await coordinator.loadSecrets(secretRef);
    expect(loaded.env).toEqual([
      { key: "FOO", value: "bar" },
      { key: "MULTI", value: "ab" },
    ]);
  });

  it("round-trips the account and mirrors it into plaintext metadata", async () => {
    // RDP 는 계정이 자격증명에 딸린다. 평문 메타데이터에도 같이 적어야 목록 표시와 접속이
    // 복호화 없이 계정을 알 수 있다 — 쓰는 곳이 persistSecret 하나뿐이라 값이 갈리지 않는다.
    const saved: Record<string, string> = {};
    const { deps, coordinator } = createCoordinator({
      secretStore: {
        save: vi.fn(async (ref: string, json: string) => {
          saved[ref] = json;
        }),
        load: vi.fn(async (ref: string) => saved[ref] ?? null),
      },
    });

    const secretRef = await coordinator.persistSecret("Win admin", {
      kind: "rdp",
      username: "Administrator",
      domain: "CORP",
      password: "pw",
    });
    expect(secretRef).toBeTruthy();

    const loaded = await coordinator.loadSecrets(secretRef);
    expect(loaded.username).toBe("Administrator");
    expect(loaded.domain).toBe("CORP");

    // kind 도 같이 적힌다 — RDP 목록에 SSH 자격증명이 섞이면 고를 수 없는 항목만 늘어난다.
    expect(deps.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rdp",
        username: "Administrator",
        domain: "CORP",
        hasPassword: true,
      }),
    );
    expect(loaded.kind).toBe("rdp");
  });

  it("does not create a credential from an account with no password", async () => {
    // 비밀이 없는 자격증명은 의미가 없다. 만들면 목록에 붙을 수 없는 항목이 쌓인다.
    const { coordinator } = createCoordinator();
    await expect(
      coordinator.persistSecret("Win admin", { username: "Administrator" }),
    ).resolves.toBeNull();
  });

  it("keeps the account when merging runtime secret patches", () => {
    const { coordinator } = createCoordinator();
    expect(
      coordinator.mergeSecrets(
        { username: "Administrator", domain: "CORP", password: "pw" },
        { password: "new" },
      ),
    ).toMatchObject({ username: "Administrator", domain: "CORP", password: "new" });
  });

  it("preserves env when merging runtime secret patches", () => {
    const { coordinator } = createCoordinator();
    expect(
      coordinator.mergeSecrets({ env: [{ key: "A", value: "1" }] }, { password: "pw" })
        .env,
    ).toEqual([{ key: "A", value: "1" }]);
  });
});

describe("normalizeHostEnvVars", () => {
  it("keeps valid vars, drops invalid keys, strips newlines, caps count", () => {
    expect(
      normalizeHostEnvVars([
        { key: "FOO", value: "bar" },
        { key: " SPACED ", value: "x" },
        { key: "1BAD", value: "y" },
        { key: "OK2", value: "a\r\nb" },
      ]),
    ).toEqual([
      { key: "FOO", value: "bar" },
      { key: "SPACED", value: "x" },
      { key: "OK2", value: "ab" },
    ]);
    expect(normalizeHostEnvVars(undefined)).toEqual([]);
    expect(
      normalizeHostEnvVars(
        Array.from({ length: 150 }, (_, index) => ({
          key: `K${index}`,
          value: "v",
        })),
      ),
    ).toHaveLength(100);
  });
});
