import { randomUUID } from "node:crypto";
import { isSshHostDraft } from "@shared";
import type {
  HostDraft,
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
        secrets.certificateText,
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
      "호스트 전용 인증 정보를 저장했습니다.",
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
    const resolvedSecrets = mergeSecrets(
      await loadSecrets(host.secretRef),
      secrets ?? {},
    );
    const shouldPersistHostSecret = Boolean(secrets && hasSecretValue(secrets));

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
        "SSH 인증서를 찾을 수 없습니다. 새 인증서를 가져와 다시 시도하세요.",
      );
    }

    if (info.status === "expired") {
      throw new Error(
        "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
      );
    }
    if (info.status === "not_yet_valid") {
      throw new Error(
        info.validAfter
          ? `SSH 인증서가 아직 유효하지 않습니다. Valid after ${info.validAfter}`
          : "SSH 인증서가 아직 유효하지 않습니다.",
      );
    }
    if (info.status === "invalid") {
      throw new Error(
        "SSH 인증서를 해석할 수 없습니다. 인증서 내용을 확인해 주세요.",
      );
    }
    if (info.status !== "valid") {
      throw new Error("SSH 인증서를 확인하지 못했습니다.");
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
