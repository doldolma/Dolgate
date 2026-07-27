import { randomUUID } from "node:crypto";
import { isSshHostDraft, normalizeHostEnvVars } from "@shared";
import type {
  HostDraft,
  HostEnvVar,
  HostSecretInput,
  ManagedSecretPayload,
  SshCertificateInfo,
} from "@shared";
import type {
  ActivityLogRepository,
  HostRepository,
  SecretMetadataRepository,
} from "../../database";
import type { SecretStore } from "../../secret-store";
import type { SshHostRecord } from "../context";
import { t } from '../../i18n';

// 자동 재연결용 런타임 시크릿 캐시(메모리 전용). 디스크/keychain에 저장하지 않으며
// 앱 종료 시 프로세스 메모리와 함께 소멸한다. TTL로 오래된 항목을 자동 폐기한다.
interface RuntimeSecretCacheEntry {
  password?: string;
  passphrase?: string;
  cachedAt: number;
}
const RUNTIME_SECRET_TTL_MS = 60 * 60 * 1000;
const runtimeSecretCache = new Map<string, RuntimeSecretCacheEntry>();

function writeRuntimeSecretCache(
  hostId: string,
  value: { password?: string; passphrase?: string },
): void {
  if (!value.password && !value.passphrase) {
    return;
  }
  runtimeSecretCache.set(hostId, {
    password: value.password,
    passphrase: value.passphrase,
    cachedAt: Date.now(),
  });
}

function readRuntimeSecretCache(
  hostId: string,
): RuntimeSecretCacheEntry | null {
  const entry = runtimeSecretCache.get(hostId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.cachedAt > RUNTIME_SECRET_TTL_MS) {
    runtimeSecretCache.delete(hostId);
    return null;
  }
  return entry;
}

export function clearRuntimeSecretCache(hostId?: string): void {
  if (hostId) {
    runtimeSecretCache.delete(hostId);
    return;
  }
  runtimeSecretCache.clear();
}

export interface SecretCoordinator {
  persistSecret: (
    label: string,
    secrets?: HostSecretInput,
  ) => Promise<string | null>;
  persistImportedSecret: (
    label: string,
    secrets: HostSecretInput,
  ) => Promise<string | null>;
  persistHostSpecificSecret: (
    hostId: string,
    label: string,
    secrets: HostSecretInput,
  ) => Promise<string | null>;
  loadSecrets: (secretRef?: string | null) => Promise<HostSecretInput>;
  hasSecretValue: (secrets: HostSecretInput) => boolean;
  mergeSecrets: (
    current: HostSecretInput,
    patch: HostSecretInput,
  ) => HostSecretInput;
  resolveRuntimeSshSecrets: (
    host: SshHostRecord,
    secrets?: HostSecretInput,
  ) => Promise<{
    secrets: HostSecretInput;
    shouldPersistHostSecret: boolean;
  }>;
  resolveManagedPrivateKeyPem: (
    draft: HostDraft,
    nextSecrets: HostSecretInput | undefined,
    currentSecretRef: string | null,
  ) => Promise<string | undefined>;
  resolveManagedCertificateText: (
    draft: HostDraft,
    nextSecrets: HostSecretInput | undefined,
    currentSecretRef: string | null,
  ) => Promise<string | undefined>;
  inspectCertificate: (certificateText: string) => Promise<SshCertificateInfo>;
  inspectStoredCertificate: (input: {
    secretRef?: string | null;
    certificateText?: string | undefined;
  }) => Promise<SshCertificateInfo | null>;
  ensureCertificateAuthReady: (
    host: SshHostRecord,
    secrets: HostSecretInput,
  ) => Promise<SshCertificateInfo | null>;
}

export function createSecretCoordinator(deps: {
  secretStore: SecretStore;
  secretMetadata: SecretMetadataRepository;
  hosts: HostRepository;
  activityLogs: ActivityLogRepository;
  queueSync: () => void;
  inspectCertificate: (certificateText: string) => Promise<SshCertificateInfo>;
}): SecretCoordinator {
  const {
    secretStore,
    secretMetadata,
    hosts,
    activityLogs,
    queueSync,
    inspectCertificate,
  } = deps;

  const hasSecretValue = (secrets: HostSecretInput): boolean =>
    Boolean(
      secrets.password ||
        secrets.passphrase ||
        secrets.privateKeyPem ||
        secrets.certificateText ||
        normalizeHostEnvVars(secrets.env).length > 0,
    );

  const mergeSecrets = (
    current: HostSecretInput,
    patch: HostSecretInput,
  ): HostSecretInput => ({
    password: patch.password !== undefined ? patch.password : current.password,
    passphrase:
      patch.passphrase !== undefined ? patch.passphrase : current.passphrase,
    privateKeyPem:
      patch.privateKeyPem !== undefined
        ? patch.privateKeyPem
        : current.privateKeyPem,
    certificateText:
      patch.certificateText !== undefined
        ? patch.certificateText
        : current.certificateText,
    publicKey: patch.publicKey !== undefined ? patch.publicKey : current.publicKey,
    publicKeyFingerprintSha256:
      patch.publicKeyFingerprintSha256 !== undefined
        ? patch.publicKeyFingerprintSha256
        : current.publicKeyFingerprintSha256,
    keyAlgorithm:
      patch.keyAlgorithm !== undefined ? patch.keyAlgorithm : current.keyAlgorithm,
    privateKeyEncrypted:
      patch.privateKeyEncrypted !== undefined
        ? patch.privateKeyEncrypted
        : current.privateKeyEncrypted,
    keyCurve: patch.keyCurve !== undefined ? patch.keyCurve : current.keyCurve,
    keyBits: patch.keyBits !== undefined ? patch.keyBits : current.keyBits,
    privateKeyCipher:
      patch.privateKeyCipher !== undefined
        ? patch.privateKeyCipher
        : current.privateKeyCipher,
    privateKeyKdfRounds:
      patch.privateKeyKdfRounds !== undefined
        ? patch.privateKeyKdfRounds
        : current.privateKeyKdfRounds,
    passphraseSaved:
      patch.passphraseSaved !== undefined
        ? patch.passphraseSaved
        : current.passphraseSaved,
    generatedByApp:
      patch.generatedByApp !== undefined
        ? patch.generatedByApp
        : current.generatedByApp,
    env: patch.env !== undefined ? patch.env : current.env,
  });

  const persistSecret = async (
    label: string,
    secrets?: HostSecretInput,
  ): Promise<string | null> => {
    if (!secrets || !hasSecretValue(secrets)) {
      return null;
    }

    const secretRef = `secret:${randomUUID()}`;
    const updatedAt = new Date().toISOString();
    await secretStore.save(
      secretRef,
      JSON.stringify({
        secretRef,
        label,
        password: secrets.password,
        passphrase: secrets.passphrase,
        privateKeyPem: secrets.privateKeyPem,
        certificateText: secrets.certificateText,
        publicKey: secrets.publicKey,
        publicKeyFingerprintSha256: secrets.publicKeyFingerprintSha256,
        keyAlgorithm: secrets.keyAlgorithm,
        privateKeyEncrypted: secrets.privateKeyEncrypted,
        keyCurve: secrets.keyCurve,
        keyBits: secrets.keyBits,
        privateKeyCipher: secrets.privateKeyCipher,
        privateKeyKdfRounds: secrets.privateKeyKdfRounds,
        passphraseSaved: secrets.passphraseSaved,
        generatedByApp: secrets.generatedByApp,
        env: normalizeHostEnvVars(secrets.env),
        updatedAt,
      } satisfies ManagedSecretPayload),
    );
    secretMetadata.upsert({
      secretRef,
      label,
      hasPassword: Boolean(secrets.password),
      hasPassphrase: Boolean(secrets.passphrase),
      hasManagedPrivateKey: Boolean(secrets.privateKeyPem),
      hasCertificate: Boolean(secrets.certificateText),
        privateKeyEncrypted: secrets.privateKeyEncrypted,
        keyAlgorithm: secrets.keyAlgorithm,
        keyCurve: secrets.keyCurve,
        keyBits: secrets.keyBits,
        privateKeyCipher: secrets.privateKeyCipher,
        privateKeyKdfRounds: secrets.privateKeyKdfRounds,
        passphraseSaved: secrets.passphraseSaved,
      });
    return secretRef;
  };

  const loadSecrets = async (
    secretRef?: string | null,
  ): Promise<HostSecretInput> => {
    if (!secretRef) {
      return {};
    }
    const secretJson = await secretStore.load(secretRef);
    if (!secretJson) {
      return {};
    }
    const parsed = JSON.parse(secretJson) as Record<string, unknown>;
    return {
      secretRef,
      label: typeof parsed.label === "string" ? parsed.label : secretRef,
      password: typeof parsed.password === "string" ? parsed.password : undefined,
      passphrase:
        typeof parsed.passphrase === "string" ? parsed.passphrase : undefined,
      privateKeyPem:
        typeof parsed.privateKeyPem === "string"
          ? parsed.privateKeyPem
          : undefined,
      certificateText:
        typeof parsed.certificateText === "string"
          ? parsed.certificateText
          : undefined,
      publicKey:
        typeof parsed.publicKey === "string" ? parsed.publicKey : undefined,
      publicKeyFingerprintSha256:
        typeof parsed.publicKeyFingerprintSha256 === "string"
          ? parsed.publicKeyFingerprintSha256
          : undefined,
      keyAlgorithm:
        typeof parsed.keyAlgorithm === "string"
          ? parsed.keyAlgorithm
          : undefined,
      privateKeyEncrypted:
        typeof parsed.privateKeyEncrypted === "boolean"
          ? parsed.privateKeyEncrypted
          : undefined,
      keyCurve:
        typeof parsed.keyCurve === "string" ? parsed.keyCurve : undefined,
      keyBits:
        typeof parsed.keyBits === "number" ? parsed.keyBits : undefined,
      privateKeyCipher:
        typeof parsed.privateKeyCipher === "string"
          ? parsed.privateKeyCipher
          : undefined,
      privateKeyKdfRounds:
        typeof parsed.privateKeyKdfRounds === "number"
          ? parsed.privateKeyKdfRounds
          : undefined,
      passphraseSaved:
        typeof parsed.passphraseSaved === "boolean"
          ? parsed.passphraseSaved
          : undefined,
      generatedByApp:
        typeof parsed.generatedByApp === "boolean"
          ? parsed.generatedByApp
          : undefined,
      env: normalizeHostEnvVars(parsed.env as HostEnvVar[] | undefined),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    } as ManagedSecretPayload;
  };

  const persistImportedSecret = (
    label: string,
    secrets: HostSecretInput,
  ): Promise<string | null> => {
    if (!hasSecretValue(secrets)) {
      return Promise.resolve(null);
    }
    return persistSecret(label, secrets);
  };

  const persistHostSpecificSecret = async (
    hostId: string,
    label: string,
    secrets: HostSecretInput,
  ): Promise<string | null> => {
    if (!hasSecretValue(secrets)) {
      return null;
    }

    const secretRef = await persistSecret(label, secrets);
    if (!secretRef) {
      return null;
    }

    hosts.updateSecretRef(hostId, secretRef);
    activityLogs.append(
      "info",
      "audit",
      t('secretIpc.hostSecretSaved'),
      {
        hostId,
        secretRef,
      },
    );
    queueSync();
    return secretRef;
  };

  const resolveRuntimeSshSecrets = async (
    host: SshHostRecord,
    secrets?: HostSecretInput,
  ) => {
    const provided = secrets ?? {};
    let resolvedSecrets = mergeSecrets(
      await loadSecrets(host.secretRef),
      provided,
    );
    const shouldPersistHostSecret = Boolean(secrets && hasSecretValue(secrets));

    // 자동 재연결: 사용자가 런타임에 입력한(=keychain에 저장하지 않은) 비밀번호/
    // 패스프레이즈를 호스트 단위로 메모리에 캐시한다. keychain·입력 어디에도
    // 비밀번호가 없을 때만 캐시를 폴백으로 사용한다. 이 캐시는 "최초 연결 성공
    // 이후의 transient 재연결"에서만 소비되므로(인증 실패는 permanent로 분류돼
    // 재연결하지 않음) 잘못된 비밀번호가 재사용될 위험이 없다.
    if (provided.password || provided.passphrase) {
      writeRuntimeSecretCache(host.id, {
        password: provided.password,
        passphrase: provided.passphrase,
      });
    }
    if (!resolvedSecrets.password && !resolvedSecrets.passphrase) {
      const cached = readRuntimeSecretCache(host.id);
      if (cached) {
        resolvedSecrets = mergeSecrets(resolvedSecrets, {
          password: cached.password,
          passphrase: cached.passphrase,
        });
      }
    }

    return {
      secrets: resolvedSecrets,
      shouldPersistHostSecret,
    };
  };

  const resolveManagedPrivateKeyPem = async (
    draft: HostDraft,
    nextSecrets: HostSecretInput | undefined,
    currentSecretRef: string | null,
  ): Promise<string | undefined> => {
    if (
      !isSshHostDraft(draft) ||
      (draft.authType !== "privateKey" && draft.authType !== "certificate")
    ) {
      return undefined;
    }

    if (nextSecrets?.privateKeyPem) {
      return nextSecrets.privateKeyPem;
    }

    if (currentSecretRef) {
      const currentSecrets = await loadSecrets(currentSecretRef);
      if (currentSecrets.privateKeyPem) {
        return currentSecrets.privateKeyPem;
      }
    }

    return undefined;
  };

  const resolveManagedCertificateText = async (
    draft: HostDraft,
    nextSecrets: HostSecretInput | undefined,
    currentSecretRef: string | null,
  ): Promise<string | undefined> => {
    if (!isSshHostDraft(draft) || draft.authType !== "certificate") {
      return undefined;
    }

    if (nextSecrets?.certificateText) {
      return nextSecrets.certificateText;
    }

    if (currentSecretRef) {
      const currentSecrets = await loadSecrets(currentSecretRef);
      if (currentSecrets.certificateText) {
        return currentSecrets.certificateText;
      }
    }

    return undefined;
  };

  const inspectStoredCertificate = async (input: {
    secretRef?: string | null;
    certificateText?: string | undefined;
  }): Promise<SshCertificateInfo | null> => {
    try {
      const directCertificateText =
        input.certificateText && input.certificateText.trim().length > 0
          ? input.certificateText
          : undefined;
      if (directCertificateText) {
        return inspectCertificate(directCertificateText);
      }

      if (!input.secretRef) {
        return null;
      }

      const storedSecrets = await loadSecrets(input.secretRef);
      const certificateText =
        storedSecrets.certificateText &&
        storedSecrets.certificateText.trim().length > 0
          ? storedSecrets.certificateText
          : undefined;
      if (!certificateText) {
        return null;
      }

      return inspectCertificate(certificateText);
    } catch {
      return null;
    }
  };

  const ensureCertificateAuthReady = async (
    host: SshHostRecord,
    secrets: HostSecretInput,
  ): Promise<SshCertificateInfo | null> => {
    if (host.authType !== "certificate") {
      return null;
    }

    const info = await inspectStoredCertificate({
      secretRef: host.secretRef,
      certificateText: secrets.certificateText,
    });

    if (!info) {
      throw new Error(
        t('secretIpc.certNotFound'),
      );
    }

    if (info.status === "expired") {
      throw new Error(
        t('secretIpc.certExpired'),
      );
    }
    if (info.status === "not_yet_valid") {
      throw new Error(
        info.validAfter
          ? t('secretIpc.certNotYetValidWith', { validAfter: info.validAfter })
          : t('secretIpc.certNotYetValid'),
      );
    }
    if (info.status === "invalid") {
      throw new Error(
        t('secretIpc.certParseFailed'),
      );
    }
    if (info.status !== "valid") {
      throw new Error(t('secretIpc.certCheckFailed'));
    }

    return info;
  };

  return {
    persistSecret,
    persistImportedSecret,
    persistHostSpecificSecret,
    loadSecrets,
    hasSecretValue,
    mergeSecrets,
    resolveRuntimeSshSecrets,
    resolveManagedPrivateKeyPem,
    resolveManagedCertificateText,
    inspectCertificate,
    inspectStoredCertificate,
    ensureCertificateAuthReady,
  };
}
