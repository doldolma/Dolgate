import type {
  KeychainSecretCloneInput,
  KeychainSecretUpdateInput,
  KnownHostProbeInput,
  KnownHostTrustInput,
  ManagedSecretPayload,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext, SshHostRecord } from "./context";

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
      return {
        ...payload,
        secretRef,
        label: metadata.label,
        source: metadata.source,
        updatedAt: payload.updatedAt ?? metadata.updatedAt,
      } satisfies ManagedSecretPayload;
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

      const currentSecrets = await ctx.loadSecrets(input.secretRef);
      const mergedSecrets = ctx.mergeSecrets(currentSecrets, input.secrets);
      if (!ctx.hasSecretValue(mergedSecrets)) {
        throw new Error("업데이트할 secret 값이 없습니다.");
      }

      await ctx.secretStore.save(
        input.secretRef,
        JSON.stringify({
          secretRef: input.secretRef,
          label: currentMetadata.label,
          password: mergedSecrets.password,
          passphrase: mergedSecrets.passphrase,
          privateKeyPem: mergedSecrets.privateKeyPem,
          certificateText: mergedSecrets.certificateText,
          source: currentMetadata.source,
          updatedAt: new Date().toISOString(),
        } satisfies ManagedSecretPayload),
      );
      ctx.secretMetadata.upsert({
        secretRef: input.secretRef,
        label: currentMetadata.label,
        hasPassword: Boolean(mergedSecrets.password),
        hasPassphrase: Boolean(mergedSecrets.passphrase),
        hasManagedPrivateKey: Boolean(mergedSecrets.privateKeyPem),
        hasCertificate: Boolean(mergedSecrets.certificateText),
        source: currentMetadata.source,
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

      const currentSecrets = await ctx.loadSecrets(input.sourceSecretRef);
      const mergedSecrets = ctx.mergeSecrets(currentSecrets, input.secrets);
      if (!ctx.hasSecretValue(mergedSecrets)) {
        throw new Error("복제할 secret 값이 없습니다.");
      }

      const nextSecretRef = await ctx.persistSecret(
        ctx.describeHostLabel(sshHost),
        mergedSecrets,
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
