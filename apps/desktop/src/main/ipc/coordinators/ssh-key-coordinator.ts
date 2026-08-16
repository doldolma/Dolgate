import { keyInstallCorrelationId } from "@shared";
import type {
  AuthType,
  HostSecretInput,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
  SshKeyMaterialResult,
} from "@shared";
import type { HostRepository } from "../../database";
import { fingerprintSha256FromPublicKey } from "../../ssh-key-material";
import type {
  ResolvedAuthorizedKeyInstallPayload,
  ResolvedAuthorizedKeyInstallResult,
  ResolvedPrivateKeyGeneratePayload,
  ResolvedPrivateKeyGenerateResult,
} from "@shared";
import type {
  SshHostRecord,
} from "../context";
import { t } from '../../i18n';
import { logMessage } from "../../activity-log-message";

export interface SshKeyCoordinator {
  generateSshKey: (input: SshKeyGenerateInput) => Promise<SshKeyMaterialResult>;
  resolveSshPublicKey: (
    secretRef: string,
    passphraseOverride?: string | null,
  ) => Promise<SshKeyMaterialResult>;
  installSshPublicKey: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
}

function normalizeLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) {
    throw new Error(t('sshKeyIpc.nameRequired'));
  }
  return normalized;
}

function normalizePublicKey(publicKey: string): string {
  const normalized = publicKey.trim();
  const [keyType, keyData] = normalized.split(/\s+/, 3);
  const supportedKeyType =
    keyType === "ssh-ed25519" ||
    keyType === "ssh-rsa" ||
    keyType === "ecdsa-sha2-nistp256" ||
    keyType === "ecdsa-sha2-nistp384" ||
    keyType === "ecdsa-sha2-nistp521" ||
    keyType === "sk-ssh-ed25519@openssh.com" ||
    keyType === "sk-ecdsa-sha2-nistp256@openssh.com";
  if (!supportedKeyType || !keyData) {
    throw new Error(t('sshKeyIpc.publicKeyParseFailed'));
  }
  return normalized;
}

function normalizeAlgorithm(input: SshKeyGenerateInput): NonNullable<SshKeyGenerateInput["algorithm"]> {
  return input.algorithm === "ecdsa" || input.algorithm === "rsa"
    ? input.algorithm
    : "ed25519";
}

export function createSshKeyCoordinator(deps: {
  hosts: HostRepository;
  persistSecret: (
    label: string,
    secrets?: HostSecretInput,
  ) => Promise<string | null>;
  loadSecrets: (secretRef?: string | null) => Promise<HostSecretInput>;
  /**
   * 지금 신뢰 중인 키들(없으면 빈 배열). 없어도 진행한다 — 처음 보는 키는 코어가 연결 안에서
   * 묻는다(세션·SFTP·컨테이너와 같은 규칙).
   *
   * tailnetId 를 함께 넘긴다: 신뢰는 tailnet 범위 안에서만 유효해서, 빼면 다른 tailnet 의
   * 동명 호스트 키를 신뢰된 것으로 볼 수 있다.
   */
  resolveTrustedHostKeys: (host: {
    hostname: string;
    port: number;
    tailnetId?: string | null;
  }) => string[];
  /**
   * 호스트를 어느 tailnet 으로 보낼지. 이것을 payload 에 싣지 않으면 코어가 일반 네트워크로
   * 나가서, tailnet 안에만 있는 호스트에는 키를 설치할 수 없다.
   */
  resolveTailnetRoute: (host: { tailnetId?: string | null }) => {
    tailnetId?: string;
    tailnetName?: string;
  };
  requireConfiguredSshUsername: (host: SshHostRecord) => string;
  resolveJumpHostTarget: (host: SshHostRecord) => Promise<ResolvedAuthorizedKeyInstallPayload["jump"]>;
  ensureCertificateAuthReady: (
    host: SshHostRecord,
    secrets: HostSecretInput,
  ) => Promise<unknown>;
  inspectPrivateKey: (
    privateKeyPem: string,
    passphrase?: string,
  ) => Promise<{
    algorithm: string;
    publicKey: string;
    fingerprintSha256: string;
  }>;
  generatePrivateKey: (
    payload: ResolvedPrivateKeyGeneratePayload,
  ) => Promise<ResolvedPrivateKeyGenerateResult>;
  installAuthorizedKey: (
    payload: ResolvedAuthorizedKeyInstallPayload,
    correlationId?: string,
  ) => Promise<ResolvedAuthorizedKeyInstallResult>;
  queueSync: () => void;
}): SshKeyCoordinator {
  const {
    hosts,
    persistSecret,
    loadSecrets,
    resolveTrustedHostKeys,
    resolveTailnetRoute,
    requireConfiguredSshUsername,
    resolveJumpHostTarget,
    ensureCertificateAuthReady,
    inspectPrivateKey,
    generatePrivateKey,
    installAuthorizedKey,
    queueSync,
  } = deps;

  const generateSshKey = async (
    input: SshKeyGenerateInput,
  ): Promise<SshKeyMaterialResult> => {
    const label = normalizeLabel(input.label);
    const algorithm = normalizeAlgorithm(input);
    const passphrase = input.passphrase?.trim() || undefined;
    const keyPair = await generatePrivateKey({
      algorithm,
      curve: input.curve,
      rsaBits: input.rsaBits,
      privateKeyCipher: input.privateKeyCipher,
      kdfRounds: input.kdfRounds,
      comment: input.comment || label,
      passphrase,
    });
    const passphraseSaved = Boolean(passphrase && input.savePassphrase);
    const secretRef = await persistSecret(label, {
      privateKeyPem: keyPair.privateKeyPem,
      passphrase: passphraseSaved ? passphrase : undefined,
      publicKey: keyPair.publicKey,
      publicKeyFingerprintSha256: keyPair.fingerprintSha256,
      keyAlgorithm: keyPair.algorithm,
      privateKeyEncrypted: keyPair.privateKeyEncrypted,
      keyCurve: keyPair.keyCurve,
      keyBits: keyPair.keyBits,
      privateKeyCipher: keyPair.privateKeyCipher,
      privateKeyKdfRounds: keyPair.privateKeyKdfRounds,
      passphraseSaved,
      generatedByApp: true,
    });
    if (!secretRef) {
      throw new Error(t('sshKeyIpc.saveFailed'));
    }
    queueSync();
    return {
      secretRef,
      label,
      algorithm: keyPair.algorithm,
      publicKey: keyPair.publicKey,
      fingerprintSha256: keyPair.fingerprintSha256,
    };
  };

  const resolveSshPublicKey = async (
    secretRef: string,
    passphraseOverride?: string | null,
  ): Promise<SshKeyMaterialResult> => {
    const metadataLabel = secretRef;
    const secrets = await loadSecrets(secretRef);
    const label =
      typeof (secrets as { label?: unknown }).label === "string"
        ? ((secrets as { label: string }).label || metadataLabel)
        : metadataLabel;
    if (secrets.publicKey) {
      const publicKey = normalizePublicKey(secrets.publicKey);
      return {
        secretRef,
        label,
        algorithm: secrets.keyAlgorithm || publicKey.split(/\s+/, 1)[0],
        publicKey,
        fingerprintSha256:
          secrets.publicKeyFingerprintSha256 ||
          fingerprintSha256FromPublicKey(publicKey),
      };
    }
    if (!secrets.privateKeyPem) {
      throw new Error(t('sshKeyIpc.noPrivateKey'));
    }
    const inspected = await inspectPrivateKey(
      secrets.privateKeyPem,
      passphraseOverride?.trim() || secrets.passphrase,
    );
    return {
      secretRef,
      label,
      algorithm: inspected.algorithm,
      publicKey: normalizePublicKey(inspected.publicKey),
      fingerprintSha256: inspected.fingerprintSha256,
    };
  };

  const buildInstallPayload = async (
    host: SshHostRecord,
    publicKey: string,
    authType: AuthType,
    secrets: HostSecretInput,
    passphraseOverride?: string | null,
  ): Promise<ResolvedAuthorizedKeyInstallPayload> => {
    // 세션과 같은 규칙이다 — 처음 보는 키는 **연결 안에서** 묻는다(코어의 hostKeyTrustChallenge).
    // 여기서 막으면 코어가 물어볼 기회 자체가 없어져서, 한 번도 안 붙어본 호스트에는 키를 올릴
    // 수 없다. 점프 호스트는 이미 이 규칙이었다(host-coordinator 의 resolveJumpHostTarget).
    const trustedHostKeysBase64 = resolveTrustedHostKeys(host);
    const passphrase =
      authType === "privateKey" || authType === "certificate"
        ? passphraseOverride?.trim() || secrets.passphrase
        : secrets.passphrase;
    return {
      host: host.hostname,
      port: host.port,
      username: requireConfiguredSshUsername(host),
      authType,
      password: secrets.password,
      privateKeyPem: secrets.privateKeyPem,
      certificateText: secrets.certificateText,
      passphrase,
      trustedHostKeyBase64: trustedHostKeysBase64[0],
      trustedHostKeysBase64,
      jump: await resolveJumpHostTarget(host),
      // 연결 경로는 세션과 같아야 한다 — 빠뜨리면 tailnet 호스트에 설치가 닿지 않는다.
      ...resolveTailnetRoute(host),
      cols: 0,
      rows: 0,
      publicKey,
    };
  };

  const installForHost = async (
    host: SshHostRecord,
    keyMaterial: SshKeyMaterialResult,
    mode: SshKeyInstallInput["mode"],
    passphraseOverride?: string | null,
  ): Promise<SshKeyInstallResult["results"][number]> => {
    const currentSecrets = await loadSecrets(host.secretRef);
    await ensureCertificateAuthReady(host, currentSecrets);
    const installResult = await installAuthorizedKey(
      await buildInstallPayload(
        host,
        keyMaterial.publicKey,
        host.authType,
        currentSecrets,
        host.secretRef === keyMaterial.secretRef ? passphraseOverride : undefined,
      ),
      // 이 값으로 코어의 인증 물음이 설치 대화상자에 붙는다(없으면 코어가 묻지 못한다).
      keyInstallCorrelationId(host.id),
    );

    if (mode === "installAndUse") {
      const keySecrets = await loadSecrets(keyMaterial.secretRef);
      await installAuthorizedKey(
        await buildInstallPayload(
          host,
          keyMaterial.publicKey,
          "privateKey",
          keySecrets,
          passphraseOverride,
        ),
        keyInstallCorrelationId(host.id),
      );
      hosts.updateSshAuthSecret(host.id, "privateKey", keyMaterial.secretRef);
    }

    return {
      hostId: host.id,
      hostLabel: host.label,
      status:
        installResult.status === "already-present"
          ? "already-present"
          : "installed",
    };
  };

  const installSshPublicKey = async (
    input: SshKeyInstallInput,
  ): Promise<SshKeyInstallResult> => {
    const hostIds = [...new Set(input.hostIds.filter(Boolean))];
    const mode = input.mode === "installAndUse" ? "installAndUse" : "installOnly";
    if (hostIds.length === 0) {
      throw new Error(t('sshKeyIpc.selectHost'));
    }
    const keyMaterial = await resolveSshPublicKey(
      input.secretRef,
      input.passphraseOverride,
    );
    const results: SshKeyInstallResult["results"] = [];

    for (const hostId of hostIds) {
      const host = hosts.getById(hostId);
      if (!host || host.kind !== "ssh") {
        results.push({
          hostId,
          hostLabel: host?.label ?? hostId,
          status: "failed",
          message: t('sshKeyIpc.notSshHost'),
        });
        continue;
      }
      try {
        results.push(
          await installForHost(
            host,
            keyMaterial,
            mode,
            input.passphraseOverride,
          ),
        );
      } catch (error) {
        results.push({
          hostId: host.id,
          hostLabel: host.label,
          status: "failed",
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : t('sshKeyIpc.installFailed'),
        });
      }
    }

    if (results.some((result) => result.status !== "failed")) {
      queueSync();
    }
    return {
      secretRef: input.secretRef,
      mode,
      results,
    };
  };

  return {
    generateSshKey,
    resolveSshPublicKey,
    installSshPublicKey,
  };
}
