import type {
  KeychainSecretCloneInput,
  KeychainSecretUpdateInput,
  KnownHostProbeInput,
  KnownHostTrustInput,
  LoadedManagedSecretPayload,
  HostSecretInput,
  ManagedSecretPayload,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext, SshHostRecord } from "./context";

function normalizeReplacementSecrets(secrets: HostSecretInput): HostSecretInput {
  const privateKeyPem =
    secrets.privateKeyPem && secrets.privateKeyPem.trim().length > 0
      ? secrets.privateKeyPem
      : undefined;
  const certificateText =
    secrets.certificateText && secrets.certificateText.trim().length > 0
      ? secrets.certificateText
      : undefined;

  return {
    password: secrets.password ? secrets.password : undefined,
    passphrase: secrets.passphrase ? secrets.passphrase : undefined,
    privateKeyPem,
    certificateText,
  };
}

function validateReplacementSecrets(secrets: HostSecretInput): string | null {
  if (
    !secrets.password &&
    !secrets.passphrase &&
    !secrets.privateKeyPem &&
    !secrets.certificateText
  ) {
    return "저장할 인증 정보가 없습니다.";
  }
  if (secrets.certificateText && !secrets.privateKeyPem) {
    return "SSH 인증서를 저장하려면 개인키도 함께 포함해야 합니다.";
  }
  if (secrets.passphrase && !secrets.privateKeyPem) {
    return "패스프레이즈는 개인키와 함께만 저장할 수 있습니다.";
  }
  return null;
}

export function registerKnownHostsLogsKeychainIpcHandlers(
  ctx: MainIpcContext,
): void {
  ipcMain.handle(ipcChannels.knownHosts.list, async () => ctx.knownHosts.list());

  ipcMain.handle(
    ipcChannels.knownHosts.probeHost,
    async (_event, input: KnownHostProbeInput) => {
      const emitProgress =
        input.endpointId?.startsWith("containers:")
          ? ctx.emitContainersConnectionProgress
          : ctx.emitSftpConnectionProgress;
      return ctx.buildHostKeyProbeResult(emitProgress, input);
    },
  );

  ipcMain.handle(
    ipcChannels.knownHosts.trust,
    async (_event, input: KnownHostTrustInput) => {
      const record = ctx.knownHosts.trust(input);
      ctx.activityLogs.append(
        "info",
        "audit",
        "새 호스트 키를 신뢰 목록에 저장했습니다.",
        {
          host: input.host,
          port: input.port,
          fingerprintSha256: input.fingerprintSha256,
        },
      );
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(
    ipcChannels.knownHosts.replace,
    async (_event, input: KnownHostTrustInput) => {
      const record = ctx.knownHosts.trust(input);
      ctx.activityLogs.append("warn", "audit", "호스트 키를 교체했습니다.", {
        host: input.host,
        port: input.port,
        fingerprintSha256: input.fingerprintSha256,
      });
      ctx.queueSync();
      return record;
    },
  );

  ipcMain.handle(ipcChannels.knownHosts.remove, async (_event, id: string) => {
    ctx.syncOutbox.upsertDeletion("knownHosts", id);
    ctx.knownHosts.remove(id);
    ctx.activityLogs.append(
      "info",
      "audit",
      "호스트 키를 신뢰 목록에서 제거했습니다.",
      {
        knownHostId: id,
      },
    );
    ctx.queueSync();
  });

  ipcMain.handle(ipcChannels.logs.list, async () => ctx.activityLogs.list());

  ipcMain.handle(ipcChannels.logs.clear, async () => {
    ctx.activityLogs.clear();
  });

  ipcMain.handle(
    ipcChannels.sessionReplays.open,
    async (event, recordingId: string) => {
      await ctx.sessionReplayService.openReplayWindow(
        recordingId,
        ctx.resolveWindowFromSender(event.sender),
      );
    },
  );

  ipcMain.handle(
    ipcChannels.sessionReplays.get,
    async (_event, recordingId: string) =>
      ctx.sessionReplayService.get(recordingId),
  );

  ipcMain.handle(ipcChannels.keychain.list, async () => ctx.secretMetadata.list());

  ipcMain.handle(
    ipcChannels.keychain.load,
    async (_event, secretRef: string) => {
      const metadata = ctx.secretMetadata.getBySecretRef(secretRef);
      if (!metadata) {
        return null;
      }
      const raw = await ctx.secretStore.load(secretRef);
      if (!raw) {
        return null;
      }
      const payload = JSON.parse(raw) as ManagedSecretPayload;
      const certificateInfo =
        payload.certificateText && payload.certificateText.trim().length > 0
          ? await ctx.inspectCertificate(payload.certificateText)
          : undefined;
      return {
        ...payload,
        secretRef,
        label: metadata.label,
        updatedAt: payload.updatedAt ?? metadata.updatedAt,
        certificateInfo,
      } satisfies LoadedManagedSecretPayload;
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.remove,
    async (_event, secretRef: string) => {
      await ctx.secretStore.remove(secretRef);
      ctx.secretMetadata.remove(secretRef);
      ctx.hosts.clearSecretRef(secretRef);
      ctx.syncOutbox.upsertDeletion("secrets", secretRef);
      ctx.activityLogs.append("warn", "audit", "호스트 secret을 제거했습니다.", {
        secretRef,
      });
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.update,
    async (_event, input: KeychainSecretUpdateInput) => {
      const currentMetadata = ctx.secretMetadata.getBySecretRef(input.secretRef);
      if (!currentMetadata) {
        throw new Error("Keychain secret not found");
      }

      const replacementSecrets = normalizeReplacementSecrets(input.secrets);
      const validationError = validateReplacementSecrets(replacementSecrets);
      if (validationError) {
        throw new Error(validationError);
      }

      await ctx.secretStore.save(
        input.secretRef,
        JSON.stringify({
          secretRef: input.secretRef,
          label: currentMetadata.label,
          password: replacementSecrets.password,
          passphrase: replacementSecrets.passphrase,
          privateKeyPem: replacementSecrets.privateKeyPem,
          certificateText: replacementSecrets.certificateText,
          updatedAt: new Date().toISOString(),
        } satisfies ManagedSecretPayload),
      );
      ctx.secretMetadata.upsert({
        secretRef: input.secretRef,
        label: currentMetadata.label,
        hasPassword: Boolean(replacementSecrets.password),
        hasPassphrase: Boolean(replacementSecrets.passphrase),
        hasManagedPrivateKey: Boolean(replacementSecrets.privateKeyPem),
        hasCertificate: Boolean(replacementSecrets.certificateText),
      });

      ctx.activityLogs.append("info", "audit", "공유 secret을 갱신했습니다.", {
        secretRef: input.secretRef,
      });
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.cloneForHost,
    async (_event, input: KeychainSecretCloneInput) => {
      const host = ctx.hosts.getById(input.hostId);
      ctx.assertSshHost(host);
      const sshHost = host as SshHostRecord;
      if (!sshHost.secretRef || sshHost.secretRef !== input.sourceSecretRef) {
        throw new Error("Host is not linked to the selected keychain secret");
      }

      const replacementSecrets = normalizeReplacementSecrets(input.secrets);
      const validationError = validateReplacementSecrets(replacementSecrets);
      if (validationError) {
        throw new Error(validationError);
      }

      const nextSecretRef = await ctx.persistSecret(
        ctx.describeHostLabel(sshHost),
        replacementSecrets,
      );
      if (!nextSecretRef) {
        throw new Error("새 secret을 생성하지 못했습니다.");
      }

      ctx.hosts.updateSecretRef(sshHost.id, nextSecretRef);
      ctx.activityLogs.append(
        "info",
        "audit",
        "호스트 전용 secret을 새로 생성했습니다.",
        {
          hostId: sshHost.id,
          sourceSecretRef: input.sourceSecretRef,
          nextSecretRef,
        },
      );
      ctx.queueSync();
    },
  );
}
