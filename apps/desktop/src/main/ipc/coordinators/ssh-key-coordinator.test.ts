import { describe, expect, it, vi } from "vitest";
import type { HostSecretInput, SshHostRecord } from "@shared";
import { createSshKeyCoordinator } from "./ssh-key-coordinator";
import { createSshKeyPair } from "../../ssh-key-material";

const STORED_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGX8pbiVYy3HVD1jfhKrzjs3b7ZgoE4BdAvAYMM7Ka8b prod";
const DERIVED_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB/xCUyiWZJhdH2lSMqDl4+MnpSdyZrVxYSluGROHkxe imported";

function createHost(
  id: string,
  overrides: Partial<SshHostRecord> = {},
): SshHostRecord {
  return {
    id,
    kind: "ssh",
    label: id === "host-1" ? "Prod" : "Staging",
    hostname: `${id}.example.com`,
    port: 22,
    username: "ubuntu",
    authType: "password",
    secretRef: `${id}-secret`,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createCoordinator(options: {
  hostsById?: Record<string, SshHostRecord | undefined>;
  secretsByRef?: Record<string, HostSecretInput>;
  installAuthorizedKey?: ReturnType<typeof vi.fn>;
} = {}) {
  const hostsById = options.hostsById ?? {
    "host-1": createHost("host-1"),
    "host-2": createHost("host-2"),
  };
  const secretsByRef = options.secretsByRef ?? {
    "host-1-secret": { password: "current-password" },
    "host-2-secret": { password: "current-password" },
    "key-ref": {
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      publicKey: STORED_PUBLIC_KEY,
      publicKeyFingerprintSha256: "SHA256:stored",
      keyAlgorithm: "ssh-ed25519",
    },
  };
  const deps = {
    hosts: {
      getById: vi.fn((id: string) => hostsById[id] ?? null),
      updateSshAuthSecret: vi.fn(),
    },
    persistSecret: vi.fn().mockResolvedValue("generated-ref"),
    loadSecrets: vi.fn(async (secretRef?: string | null) =>
      secretRef ? (secretsByRef[secretRef] ?? {}) : {},
    ),
    requireTrustedHostKeys: vi.fn(() => ["trusted-host-key"]),
    requireConfiguredSshUsername: vi.fn((host: SshHostRecord) => host.username),
    resolveJumpHostTarget: vi.fn().mockResolvedValue(null),
    ensureCertificateAuthReady: vi.fn().mockResolvedValue(null),
    inspectPrivateKey: vi.fn().mockResolvedValue({
      algorithm: "ssh-ed25519",
      publicKey: DERIVED_PUBLIC_KEY,
      fingerprintSha256: "SHA256:derived",
    }),
    generatePrivateKey: vi.fn().mockResolvedValue({
      algorithm: "ssh-ed25519",
      privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
      publicKey: STORED_PUBLIC_KEY,
      fingerprintSha256: "SHA256:generated",
      privateKeyEncrypted: false,
    }),
    installAuthorizedKey:
      options.installAuthorizedKey ??
      vi.fn().mockResolvedValue({ status: "installed" }),
    queueSync: vi.fn(),
  } as any;

  return {
    deps,
    coordinator: createSshKeyCoordinator(deps),
  };
}

describe("ssh key coordinator", () => {
  it("generates an Ed25519 key, stores SSH metadata, and queues sync", async () => {
    const { deps, coordinator } = createCoordinator();

    const result = await coordinator.generateSshKey({
      label: "Prod key",
      comment: "ubuntu@prod",
    });

    expect(result).toMatchObject({
      secretRef: "generated-ref",
      label: "Prod key",
      algorithm: "ssh-ed25519",
    });
    expect(result.publicKey).toBe(STORED_PUBLIC_KEY);
    expect(result.fingerprintSha256).toBe("SHA256:generated");
    expect(deps.generatePrivateKey).toHaveBeenCalledWith({
      algorithm: "ed25519",
      curve: undefined,
      rsaBits: undefined,
      privateKeyCipher: undefined,
      kdfRounds: undefined,
      comment: "ubuntu@prod",
      passphrase: undefined,
    });
    expect(deps.persistSecret).toHaveBeenCalledWith(
      "Prod key",
      expect.objectContaining({
        privateKeyPem: expect.stringContaining("OPENSSH PRIVATE KEY"),
        publicKey: result.publicKey,
        publicKeyFingerprintSha256: result.fingerprintSha256,
        keyAlgorithm: "ssh-ed25519",
        privateKeyEncrypted: false,
        passphraseSaved: false,
        generatedByApp: true,
      }),
    );
    expect(deps.queueSync).toHaveBeenCalledOnce();
  });

  it("encrypts generated private keys without storing unsaved passphrases", async () => {
    const { deps, coordinator } = createCoordinator();
    deps.generatePrivateKey.mockResolvedValueOnce({
      algorithm: "ecdsa-sha2-nistp384",
      privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----\nencrypted\n-----END OPENSSH PRIVATE KEY-----",
      publicKey: "ecdsa-sha2-nistp384 AAAATEST prod",
      fingerprintSha256: "SHA256:encrypted",
      privateKeyEncrypted: true,
      keyCurve: "nistp384",
      privateKeyCipher: "aes256-cbc",
      privateKeyKdfRounds: 128,
    });

    await coordinator.generateSshKey({
      label: "Encrypted key",
      algorithm: "ecdsa",
      curve: "nistp384",
      privateKeyCipher: "aes256-cbc",
      kdfRounds: 128,
      passphrase: "keep-local",
      savePassphrase: false,
    });

    expect(deps.generatePrivateKey).toHaveBeenCalledWith(
      expect.objectContaining({
        algorithm: "ecdsa",
        curve: "nistp384",
        passphrase: "keep-local",
      }),
    );
    expect(deps.persistSecret).toHaveBeenCalledWith(
      "Encrypted key",
      expect.objectContaining({
        passphrase: undefined,
        privateKeyEncrypted: true,
        keyCurve: "nistp384",
        privateKeyCipher: "aes256-cbc",
        privateKeyKdfRounds: 128,
        passphraseSaved: false,
      }),
    );
  });

  it("derives a public key from an imported private key when metadata is missing", async () => {
    const { deps, coordinator } = createCoordinator({
      secretsByRef: {
        "key-ref": {
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
          passphrase: "secret",
        },
      },
    });

    await expect(coordinator.resolveSshPublicKey("key-ref")).resolves.toMatchObject({
      secretRef: "key-ref",
      publicKey: DERIVED_PUBLIC_KEY,
      fingerprintSha256: "SHA256:derived",
    });
    expect(deps.inspectPrivateKey).toHaveBeenCalledWith(
      expect.stringContaining("PRIVATE KEY"),
      "secret",
    );
  });

  it("switches a host to the key only after installAndUse verification succeeds", async () => {
    const { deps, coordinator } = createCoordinator();

    await expect(
      coordinator.installSshPublicKey({
        secretRef: "key-ref",
        hostIds: ["host-1"],
        mode: "installAndUse",
        passphraseOverride: "transient",
      }),
    ).resolves.toMatchObject({
      results: [{ hostId: "host-1", status: "installed" }],
    });

    expect(deps.installAuthorizedKey).toHaveBeenCalledTimes(2);
    expect(deps.installAuthorizedKey).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authType: "password",
        password: "current-password",
        publicKey: STORED_PUBLIC_KEY,
      }),
    );
    expect(deps.installAuthorizedKey).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authType: "privateKey",
        privateKeyPem: expect.stringContaining("PRIVATE KEY"),
        passphrase: "transient",
        publicKey: STORED_PUBLIC_KEY,
      }),
    );
    expect(deps.hosts.updateSshAuthSecret).toHaveBeenCalledWith(
      "host-1",
      "privateKey",
      "key-ref",
    );
  });

  it("keeps the existing host auth when installAndUse verification fails", async () => {
    const installAuthorizedKey = vi
      .fn()
      .mockResolvedValueOnce({ status: "installed" })
      .mockRejectedValueOnce(new Error("Permission denied (publickey)."));
    const { deps, coordinator } = createCoordinator({ installAuthorizedKey });

    await expect(
      coordinator.installSshPublicKey({
        secretRef: "key-ref",
        hostIds: ["host-1"],
        mode: "installAndUse",
      }),
    ).resolves.toMatchObject({
      results: [
        {
          hostId: "host-1",
          status: "failed",
          message: "Permission denied (publickey).",
        },
      ],
    });

    expect(deps.hosts.updateSshAuthSecret).not.toHaveBeenCalled();
    expect(deps.queueSync).not.toHaveBeenCalled();
  });

  it("continues installing to later hosts when one host fails", async () => {
    const installAuthorizedKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("first host failed"))
      .mockResolvedValueOnce({ status: "already-present" });
    const { deps, coordinator } = createCoordinator({ installAuthorizedKey });

    await expect(
      coordinator.installSshPublicKey({
        secretRef: "key-ref",
        hostIds: ["host-1", "host-2"],
        mode: "installOnly",
      }),
    ).resolves.toEqual({
      secretRef: "key-ref",
      mode: "installOnly",
      results: [
        {
          hostId: "host-1",
          hostLabel: "Prod",
          status: "failed",
          message: "first host failed",
        },
        {
          hostId: "host-2",
          hostLabel: "Staging",
          status: "already-present",
        },
      ],
    });
    expect(deps.installAuthorizedKey).toHaveBeenCalledTimes(2);
    expect(deps.queueSync).toHaveBeenCalledOnce();
  });

  it("installs an ECDSA public key instead of rejecting the key type", async () => {
    const ecdsaKey = createSshKeyPair({
      algorithm: "ecdsa",
      curve: "nistp384",
      comment: "ecdsa-prod",
    });
    const { deps, coordinator } = createCoordinator({
      secretsByRef: {
        "host-1-secret": { password: "current-password" },
        "ecdsa-ref": {
          privateKeyPem:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
          publicKey: ecdsaKey.publicKey,
          publicKeyFingerprintSha256: ecdsaKey.fingerprintSha256,
          keyAlgorithm: ecdsaKey.algorithm,
        },
      },
    });

    await expect(
      coordinator.installSshPublicKey({
        secretRef: "ecdsa-ref",
        hostIds: ["host-1"],
        mode: "installOnly",
      }),
    ).resolves.toMatchObject({
      results: [{ hostId: "host-1", status: "installed" }],
    });

    expect(deps.installAuthorizedKey).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: ecdsaKey.publicKey }),
    );
  });

  it("resolves an ECDSA public key for clipboard copy without a parse error", async () => {
    const ecdsaKey = createSshKeyPair({
      algorithm: "ecdsa",
      curve: "nistp521",
      comment: "ecdsa-copy",
    });
    const { coordinator } = createCoordinator({
      secretsByRef: {
        "ecdsa-ref": {
          publicKey: ecdsaKey.publicKey,
          publicKeyFingerprintSha256: ecdsaKey.fingerprintSha256,
          keyAlgorithm: ecdsaKey.algorithm,
        },
      },
    });

    await expect(
      coordinator.resolveSshPublicKey("ecdsa-ref"),
    ).resolves.toMatchObject({
      publicKey: ecdsaKey.publicKey,
      algorithm: "ecdsa-sha2-nistp521",
    });
  });

  it("installs and switches to a passphrase-protected key using its saved passphrase", async () => {
    const key = createSshKeyPair({
      algorithm: "ed25519",
      comment: "passphrase-key",
    });
    const { deps, coordinator } = createCoordinator({
      secretsByRef: {
        "host-1-secret": { password: "current-password" },
        "key-ref": {
          privateKeyPem:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nenc\n-----END OPENSSH PRIVATE KEY-----",
          publicKey: key.publicKey,
          publicKeyFingerprintSha256: key.fingerprintSha256,
          keyAlgorithm: key.algorithm,
          passphrase: "saved-passphrase",
        },
      },
    });

    await expect(
      coordinator.installSshPublicKey({
        secretRef: "key-ref",
        hostIds: ["host-1"],
        mode: "installAndUse",
      }),
    ).resolves.toMatchObject({
      results: [{ hostId: "host-1", status: "installed" }],
    });

    // installAndUse 검증 연결(2번째 호출)에 저장된 passphrase가 전달돼야 한다.
    expect(deps.installAuthorizedKey).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authType: "privateKey",
        passphrase: "saved-passphrase",
        publicKey: key.publicKey,
      }),
    );
    expect(deps.hosts.updateSshAuthSecret).toHaveBeenCalledWith(
      "host-1",
      "privateKey",
      "key-ref",
    );
  });
});
