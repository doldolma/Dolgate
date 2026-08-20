import type {
  KeychainSecretCloneInput,
  KeychainSecretUpdateInput,
  KnownHostProbeInput,
  KnownHostTrustInput,
  LoadedManagedSecretPayload,
  HostSecretInput,
  ManagedSecretPayload,
} from "@shared";
import { isSshHostRecord } from "@shared";
import { BrowserWindow, clipboard, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext, SshHostRecord } from "./context";
import { t } from '../i18n';
import { logMessage } from "../activity-log-message";

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
    return t('knownHostsIpc.noSecrets');
  }
  if (secrets.certificateText && !secrets.privateKeyPem) {
    return t('knownHostsIpc.certificateNeedsKey');
  }
  if (secrets.passphrase && !secrets.privateKeyPem) {
    return t('knownHostsIpc.passphraseNeedsKey');
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
      // 베스천 뒤의(직접 닿지 않는) 타깃이면 점프 호스트를 해석해 그 경유로 키를 읽는다.
      // 점프 호스트 자신을 probe할 땐 jumpHostId가 없어 jump는 undefined → 직접 probe된다.
      const host = ctx.hosts.getById(input.hostId);
      const jump =
        host && isSshHostRecord(host)
          ? await ctx.resolveJumpHostTarget(host)
          : undefined;
      try {
        return await ctx.buildHostKeyProbeResult(emitProgress, input, jump);
      } catch (error) {
        // 호스트 키 probe는 실제 연결 직전(세션 lifecycle 생성 전) 단계라, 도달 불가 호스트
        // 등으로 여기서 실패하면 core-manager의 세션 로그 경로를 타지 못한다. 따라서 연결
        // 실패를 활동 로그에 직접 남겨 Logs/최근 로그에 보이게 한다(ssh/sftp/containers 공통).
        const reason = error instanceof Error ? error.message : String(error);
        ctx.activityLogs.append(
          "error",
          "session",
          logMessage('knownHostsIpc.connectFailed'),
          {
            hostId: input.hostId,
            hostLabel: host?.label ?? null,
            endpointId: input.endpointId ?? null,
            reason,
          },
        );
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(ipcChannels.logs.changed);
          }
        }
        // 실패한 호스트를 라벨+주소로 식별해 다시 던진다(다단 ProxyJump에서 어느 호스트
        // 에서 끊겼는지 UI가 raw IP 대신 이름으로 보여줄 수 있게). 원본 메시지(reset/timeout
        // 등)는 뒤에 보존해 렌더러의 실패 분류가 그대로 동작한다. jump가 있으면 타깃을 점프
        // 경유로 probe한 것이라, 실제 끊긴 지점(베스천 등)은 메시지 내부 주소로 구분된다.
        if (host && isSshHostRecord(host)) {
          throw new Error(
            `host-key probe failed for "${host.label}" [${host.hostname}:${host.port}]${
              jump ? " via-jump" : ""
            }: ${reason}`,
          );
        }
        throw error;
      }
    },
  );

  /**
   * 신뢰를 어느 tailnet 범위에 저장할지는 호스트 레코드가 정한다.
   *
   * 렌더러가 보낸 값을 쓰지 않는 이유는, 그 값이 곧 "이 키를 어디서 신뢰하는가"를 결정하는
   * 보안 경계이기 때문이다. 렌더러가 틀리거나 조작되면 tailnet 밖에서 신뢰한 키가 tailnet
   * 안에서 통하게 된다.
   */
  const resolveTrustScope = (input: KnownHostTrustInput): KnownHostTrustInput => {
    const host = ctx.hosts.getById(input.hostId);
    const tailnetId =
      host && isSshHostRecord(host) ? (host.tailnetId ?? undefined) : undefined;
    return { ...input, tailnetId };
  };

  ipcMain.handle(
    ipcChannels.knownHosts.trust,
    async (_event, rawInput: KnownHostTrustInput) => {
      const input = resolveTrustScope(rawInput);
      const record = ctx.knownHosts.trust(input);
      ctx.activityLogs.append(
        "info",
        "audit",
        logMessage('knownHostsIpc.hostKeyTrusted'),
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
    async (_event, rawInput: KnownHostTrustInput) => {
      const input = resolveTrustScope(rawInput);
      const record = ctx.knownHosts.trust(input);
      ctx.activityLogs.append("warn", "audit", logMessage('knownHostsIpc.hostKeyReplaced'), {
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
      logMessage('knownHostsIpc.hostKeyRemoved'),
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

  ipcMain.handle(ipcChannels.sessionReplays.storageUsage, async () =>
    ctx.sessionReplayService.getStorageUsage(),
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
    ipcChannels.keychain.copyPassword,
    async (_event, secretRef: string) => {
      const metadata = ctx.secretMetadata.getBySecretRef(secretRef);
      if (!metadata) {
        throw new Error(t('knownHostsIpc.secretNotFound'));
      }

      const raw = await ctx.secretStore.load(secretRef);
      if (!raw) {
        throw new Error(t('knownHostsIpc.secretLoadFailed'));
      }

      const payload = JSON.parse(raw) as ManagedSecretPayload;
      if (!payload.password) {
        throw new Error(t('knownHostsIpc.noStoredPassword'));
      }

      clipboard.writeText(payload.password);
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.remove,
    async (_event, secretRef: string) => {
      await ctx.secretStore.remove(secretRef);
      ctx.secretMetadata.remove(secretRef);
      ctx.hosts.clearSecretRef(secretRef);
      ctx.syncOutbox.upsertDeletion("secrets", secretRef);
      ctx.activityLogs.append("warn", "audit", logMessage('knownHostsIpc.secretRemoved'), {
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
      const currentRaw = await ctx.secretStore.load(input.secretRef);
      const currentPayload = currentRaw
        ? (JSON.parse(currentRaw) as ManagedSecretPayload)
        : null;
      const keepPublicKeyMetadata =
        currentPayload?.privateKeyPem &&
        currentPayload.privateKeyPem === replacementSecrets.privateKeyPem;
      // 이름은 암호화 레코드와 평문 메타데이터 양쪽에 있다. 한쪽만 바꾸면 목록과 편집 화면이
      // 서로 다른 이름을 말한다. 빈 값은 "그대로" 로 본다 — 이름 없는 자격증명은 고를 수 없다.
      const nextLabel = input.label?.trim() ? input.label.trim() : currentMetadata.label;

      await ctx.secretStore.save(
        input.secretRef,
        JSON.stringify({
          secretRef: input.secretRef,
          label: nextLabel,
          password: replacementSecrets.password,
          passphrase: replacementSecrets.passphrase,
          privateKeyPem: replacementSecrets.privateKeyPem,
          certificateText: replacementSecrets.certificateText,
          publicKey: keepPublicKeyMetadata ? currentPayload.publicKey : undefined,
          publicKeyFingerprintSha256: keepPublicKeyMetadata
            ? currentPayload.publicKeyFingerprintSha256
            : undefined,
          keyAlgorithm: keepPublicKeyMetadata
            ? currentPayload.keyAlgorithm
            : undefined,
          privateKeyEncrypted: keepPublicKeyMetadata
            ? currentPayload.privateKeyEncrypted
            : undefined,
          keyCurve: keepPublicKeyMetadata ? currentPayload.keyCurve : undefined,
          keyBits: keepPublicKeyMetadata ? currentPayload.keyBits : undefined,
          privateKeyCipher: keepPublicKeyMetadata
            ? currentPayload.privateKeyCipher
            : undefined,
          privateKeyKdfRounds: keepPublicKeyMetadata
            ? currentPayload.privateKeyKdfRounds
            : undefined,
          passphraseSaved: keepPublicKeyMetadata
            ? currentPayload.passphraseSaved
            : undefined,
          generatedByApp: keepPublicKeyMetadata
            ? currentPayload.generatedByApp
            : undefined,
          updatedAt: new Date().toISOString(),
        } satisfies ManagedSecretPayload),
      );
      ctx.secretMetadata.upsert({
        secretRef: input.secretRef,
        label: nextLabel,
        hasPassword: Boolean(replacementSecrets.password),
        hasPassphrase: Boolean(replacementSecrets.passphrase),
        hasManagedPrivateKey: Boolean(replacementSecrets.privateKeyPem),
        hasCertificate: Boolean(replacementSecrets.certificateText),
        privateKeyEncrypted: keepPublicKeyMetadata
          ? currentPayload.privateKeyEncrypted
          : undefined,
        keyAlgorithm: keepPublicKeyMetadata ? currentPayload.keyAlgorithm : undefined,
        keyCurve: keepPublicKeyMetadata ? currentPayload.keyCurve : undefined,
        keyBits: keepPublicKeyMetadata ? currentPayload.keyBits : undefined,
        privateKeyCipher: keepPublicKeyMetadata
          ? currentPayload.privateKeyCipher
          : undefined,
        privateKeyKdfRounds: keepPublicKeyMetadata
          ? currentPayload.privateKeyKdfRounds
          : undefined,
        passphraseSaved: keepPublicKeyMetadata
          ? currentPayload.passphraseSaved
          : undefined,
      });

      ctx.activityLogs.append("info", "audit", logMessage('knownHostsIpc.sharedSecretUpdated'), {
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
        input.label?.trim() ? input.label.trim() : ctx.describeHostLabel(sshHost),
        replacementSecrets,
      );
      if (!nextSecretRef) {
        throw new Error(t('knownHostsIpc.secretCreateFailed'));
      }

      ctx.hosts.updateSecretRef(sshHost.id, nextSecretRef);
      ctx.activityLogs.append(
        "info",
        "audit",
        logMessage('knownHostsIpc.hostSecretCreated'),
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
