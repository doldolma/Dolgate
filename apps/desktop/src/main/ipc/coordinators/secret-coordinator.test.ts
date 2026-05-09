import { describe, expect, it, vi } from "vitest";
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
});
