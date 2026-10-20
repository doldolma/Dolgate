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
import { PERSONAL_VAULT_ID, type VaultCatalog, type VaultScope } from "../../vault-catalog";
import { hasCredentialSecret, type TeamHostCredentials } from "../../team-member-prefs";
import type { ResolvedSshAuth, SshHostRecord } from "../context";
import { t } from '../../i18n';
import { logMessage } from "../../activity-log-message";

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
    target?: Pick<VaultScope, "secrets" | "secretMetadata">,
  ) => Promise<string | null>;
  persistImportedSecret: (
    label: string,
    secrets: HostSecretInput,
  ) => Promise<string | null>;
  /**
   * 요청 창 값을 붙은 뒤에 저장한다. 사용자 이름(typedUsername)은 개인 호스트면 레코드에, 팀 호스트면 내 자격
   * 증명에 둔다 — 팀 레코드에 쓰면 팀 모두의 사용자 이름이 바뀐다.
   */
  persistHostSpecificSecret: (
    hostId: string,
    label: string,
    secrets: HostSecretInput,
    typedUsername?: string | null,
  ) => Promise<string | null>;
  loadSecrets: (secretRef?: string | null) => Promise<HostSecretInput>;
  /** RDP·VNC 처럼 비밀값만 읽는 접속. 팀 호스트는 내 자격 증명이 먼저다. */
  loadHostSecrets: (host: { id: string; secretRef?: string | null }) => Promise<HostSecretInput>;
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
  /**
   * SSH 로 붙을 자격 증명 — 사용자 이름·인증 방식·비밀값을 한 곳에서 정한다. SSH 계열 접속 경로는 모두
   * 이것을 거친다. includeRuntimeCache 를 끄면 이 실행 중 요청 창에 넣었던 값을 쓰지 않는다(키 설치).
   */
  resolveSshAuth: (
    host: SshHostRecord,
    secrets?: HostSecretInput,
    options?: { includeRuntimeCache?: boolean },
  ) => Promise<ResolvedSshAuth>;
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
    authType?: SshHostRecord["authType"],
  ) => Promise<SshCertificateInfo | null>;
}

/** 내 자격 증명의 비밀값 칸을 접속에 넘기는 모양으로. 빈 칸은 넣지 않는다(합칠 때 팀 것을 지우지 않게). */
function toHostSecretInput(credentials: TeamHostCredentials): HostSecretInput {
  const secrets: HostSecretInput = {};
  for (const field of ["username", "domain", "password", "passphrase", "privateKeyPem", "certificateText"] as const) {
    if (credentials[field]) {
      secrets[field] = credentials[field];
    }
  }
  return secrets;
}

export function createSecretCoordinator(deps: {
  secretStore: SecretStore;
  secretMetadata: SecretMetadataRepository;
  hosts: HostRepository;
  /**
   * 비밀값은 모든 볼트에서 찾고(secretRef 는 볼트를 넘어 겹치지 않는다), 팀 호스트를 가린다. 팀 호스트는 내
   * 자격 증명(멤버 개인 칸)이 먼저다.
   */
  vaults: Pick<
    VaultCatalog,
    | "loadSecret"
    | "scopeOfHost"
    | "getHost"
    | "getMyHostCredentials"
    | "setMyHostCredentials"
    | "setHostLoginUsername"
  >;
  activityLogs: ActivityLogRepository;
  queueSync: () => void;
  inspectCertificate: (certificateText: string) => Promise<SshCertificateInfo>;
}): SecretCoordinator {
  const {
    secretStore,
    secretMetadata,
    hosts,
    vaults,
    activityLogs,
    queueSync,
    inspectCertificate,
  } = deps;

  const hasSecretValue = (secrets: HostSecretInput): boolean =>
    Boolean(
      secrets.password ||
        secrets.passphrase ||
        secrets.privateKeyPem ||
        secrets.certificateText,
    );

  const mergeSecrets = (
    current: HostSecretInput,
    patch: HostSecretInput,
  ): HostSecretInput => ({
    kind: patch.kind !== undefined ? patch.kind : current.kind,
    username: patch.username !== undefined ? patch.username : current.username,
    domain: patch.domain !== undefined ? patch.domain : current.domain,
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
  });

  // target 이 없으면 개인 볼트다. 팀 호스트의 비밀값은 그 팀 볼트에 둔다 — 개인에 두면 팀원이 못 쓰고
  // 내 개인 동기화로 올라간다.
  const persistSecret = async (
    label: string,
    secrets?: HostSecretInput,
    target?: Pick<VaultScope, "secrets" | "secretMetadata">,
  ): Promise<string | null> => {
    if (!secrets || !hasSecretValue(secrets)) {
      return null;
    }

    const secretRef = `secret:${randomUUID()}`;
    const updatedAt = new Date().toISOString();
    await (target?.secrets ?? secretStore).save(
      secretRef,
      JSON.stringify({
        secretRef,
        label,
        kind: secrets.kind,
        username: secrets.username,
        domain: secrets.domain,
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
        updatedAt,
      } satisfies ManagedSecretPayload),
    );
    (target?.secretMetadata ?? secretMetadata).upsert({
      secretRef,
      label,
      kind: secrets.kind,
      // 평문으로 한 번 더 적는다. 목록 표시와 접속이 복호화 없이 계정을 알아야 한다.
      // 쓰는 곳이 여기 하나뿐이라 번들과 갈리지 않는다.
      username: secrets.username,
      domain: secrets.domain,
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
    const secretJson = await vaults.loadSecret(secretRef);
    if (!secretJson) {
      return {};
    }
    const parsed = JSON.parse(secretJson) as Record<string, unknown>;
    return {
      secretRef,
      label: typeof parsed.label === "string" ? parsed.label : secretRef,
      kind: parsed.kind === "rdp" ? "rdp" : undefined,
      username: typeof parsed.username === "string" ? parsed.username : undefined,
      domain: typeof parsed.domain === "string" ? parsed.domain : undefined,
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

  /**
   * 요청 창 값을 내 자격 증명으로. 넘어온 값은 팀 비밀값과 합쳐진 것이라, 팀 것과 같은 칸은 옮기지 않는다 —
   * 옮기면 팀이 키를 바꿔도 내 낡은 사본이 먼저 쓰인다.
   */
  const persistMyHostCredentials = async (hostId: string, secrets: HostSecretInput): Promise<void> => {
    const host = vaults.getHost(hostId);
    const team = host && "secretRef" in host ? await loadSecrets(host.secretRef) : {};
    const typed: TeamHostCredentials = {};
    // 사용자 이름은 여기서 옮기지 않는다 — 요청 창에서 넣은 것만 따로 저장한다(setHostLoginUsername).
    for (const field of ["domain", "password", "passphrase", "privateKeyPem", "certificateText"] as const) {
      const value = secrets[field];
      if (typeof value === "string" && value && value !== team[field]) {
        typed[field] = value;
      }
    }
    if (Object.keys(typed).length === 0) {
      return;
    }
    vaults.setMyHostCredentials(hostId, { ...(vaults.getMyHostCredentials(hostId) ?? {}), ...typed });
    activityLogs.append("info", "audit", logMessage("teams.myCredentialsSaved"), { hostId });
    queueSync();
  };

  const persistHostSpecificSecret = async (
    hostId: string,
    label: string,
    secrets: HostSecretInput,
    typedUsername?: string | null,
  ): Promise<string | null> => {
    // 사용자 이름을 먼저 둔다(기다리는 것 없이) — 화면은 "붙었다"를 받자마자 호스트 목록을 다시 읽는다.
    if (typedUsername?.trim()) {
      vaults.setHostLoginUsername(hostId, typedUsername);
      queueSync();
    }
    if (!hasSecretValue(secrets)) {
      return null;
    }

    // 팀 호스트에서 요청 창에 넣은 값은 내 자격 증명(멤버 개인 칸)에 둔다. 팀 호스트의 비밀값은 팀 모두의
    // 것이라 건드리지 않는다.
    if (vaults.scopeOfHost(hostId).id !== PERSONAL_VAULT_ID) {
      await persistMyHostCredentials(hostId, secrets);
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
      logMessage('secretIpc.hostSecretSaved'),
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

  const resolveSshAuth = async (
    host: SshHostRecord,
    provided?: HostSecretInput,
    options: { includeRuntimeCache?: boolean } = {},
  ): Promise<ResolvedSshAuth> => {
    // 팀 호스트는 내 자격 증명이 먼저다(내 것 → 팀 것 → 요청 창). 비운 칸은 호스트 것을 쓴다. 요청 창에 넣은
    // 사용자 이름은 이번 시도의 것이고, 붙으면 저장된다(persistHostSpecificSecret).
    const mine = vaults.getMyHostCredentials(host.id);
    const typedUsername = provided?.username?.trim() || null;
    const username = (typedUsername ?? mine?.username ?? host.username).trim();
    if (!username) {
      throw new Error(t("hostIpc.usernameRequired"));
    }
    const authType = mine?.authType ?? host.authType;
    const persistTyped = (hasTypedSecret: boolean) => hasTypedSecret || typedUsername !== null;
    if (mine && hasCredentialSecret(mine)) {
      return {
        username,
        authType,
        secrets: mergeSecrets(toHostSecretInput(mine), provided ?? {}),
        shouldPersistHostSecret: persistTyped(Boolean(provided && hasSecretValue(provided))),
        typedUsername,
      };
    }
    const { secrets, shouldPersistHostSecret } =
      options.includeRuntimeCache === false
        ? {
            secrets: mergeSecrets(await loadSecrets(host.secretRef), provided ?? {}),
            shouldPersistHostSecret: Boolean(provided && hasSecretValue(provided)),
          }
        : await resolveRuntimeSshSecrets(host, provided);
    return { username, authType, secrets, shouldPersistHostSecret: persistTyped(shouldPersistHostSecret), typedUsername };
  };

  const loadHostSecrets = async (host: { id: string; secretRef?: string | null }): Promise<HostSecretInput> => {
    const mine = vaults.getMyHostCredentials(host.id);
    if (mine && hasCredentialSecret(mine)) {
      return toHostSecretInput(mine);
    }
    const shared = await loadSecrets(host.secretRef);
    // 계정 이름·도메인만 내 것으로 둔 경우(비밀번호는 팀 것).
    return mine ? mergeSecrets(shared, { username: mine.username, domain: mine.domain }) : shared;
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
    authType: SshHostRecord["authType"] = host.authType,
  ): Promise<SshCertificateInfo | null> => {
    if (authType !== "certificate") {
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
    loadHostSecrets,
    hasSecretValue,
    mergeSecrets,
    resolveRuntimeSshSecrets,
    resolveSshAuth,
    resolveManagedPrivateKeyPem,
    resolveManagedCertificateText,
    inspectCertificate,
    inspectStoredCertificate,
    ensureCertificateAuthReady,
  };
}
