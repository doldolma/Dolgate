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
