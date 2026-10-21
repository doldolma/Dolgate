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
import { resolveListedVault } from "./listed-vault";
import { t } from '../i18n';
import { logMessage } from "../activity-log-message";
import { PERSONAL_VAULT_ID } from "../vault-catalog";

/**
 * 그 저장 자격 증명이 든 볼트의 저장소. 개인이면 지금까지 쓰던 것(ctx 의 secretStore·secretMetadata·hosts·
 * syncOutbox) 그대로다 — 팀이 없으면 호출이 하나도 바뀌지 않는다. 팀 것을 바꾸거나 지우면 멤버 모두에게 간다.
 */
function secretVaultOf(ctx: MainIpcContext, secretRef: string) {
  const scope = ctx.vaults.scopeOfSecret(secretRef);
  if (scope.id === PERSONAL_VAULT_ID) {
    return { secrets: ctx.secretStore, metadata: ctx.secretMetadata, hosts: ctx.hosts, syncOutbox: ctx.syncOutbox };
  }
  return { secrets: scope.secrets, metadata: scope.secretMetadata, hosts: scope.hosts, syncOutbox: scope.syncOutbox };
}

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
  // 설정 화면이 볼트를 골라 본다. 고르지 않았으면 개인 볼트다(지금까지와 같다).
  ipcMain.handle(ipcChannels.knownHosts.list, async (_event, vaultId?: string | null) => {
    const vault = resolveListedVault(ctx.vaults, vaultId);
    return vault === "personal" ? ctx.knownHosts.list() : (vault?.knownHosts.list() ?? []);
  });

  ipcMain.handle(
    ipcChannels.knownHosts.probeHost,
    async (_event, input: KnownHostProbeInput) => {
      const emitProgress =
        input.endpointId?.startsWith("containers:")
          ? ctx.emitContainersConnectionProgress
          : ctx.emitSftpConnectionProgress;
      // 베스천 뒤의(직접 닿지 않는) 타깃이면 점프 호스트를 해석해 그 경유로 키를 읽는다.
      // 점프 호스트 자신을 probe할 땐 jumpHostId가 없어 jump는 undefined → 직접 probe된다.
      const host = ctx.vaults.getHost(input.hostId);
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
  /**
   * 신뢰를 저장할 tailnet 범위.
   *
   * **렌더러가 주장하는 범위는 쓰지 않는다** — 그것이 곧 우회 경로다(tailnet 밖에서 신뢰한 키를
   * 안에서 통하게 만들 수 있다). 범위는 `hostId` 가 가리키는 호스트 레코드가 정한다.
   *
   * 그러니 **부르는 쪽이 hostId 를 제대로 넘기는 것**이 이 규칙의 전제다. 실기기에서 저장해도
   * 매번 다시 묻던 건이 그 전제가 깨진 경우였다: 연결 중 뜨는 신뢰 물음이 hostId 를 홉 주소로
   * 찾아 채우다 빈 값("")을 넘겼고, 그러면 여기서 호스트를 못 찾아 범위 없이 저장됐다. 정작
   * 연결은 그 호스트의 tailnet 범위로 조회하니 영원히 못 찾는다. 고친 곳은 hostId 를 채우는
   * 쪽이다(runtimeEventSlice: 탭의 호스트를 먼저 본다).
   */
  const resolveTrustScope = (input: KnownHostTrustInput): KnownHostTrustInput => {
    const host = ctx.vaults.getHost(input.hostId);
    const tailnetId =
      host && isSshHostRecord(host) ? (host.tailnetId ?? undefined) : undefined;
    return { ...input, tailnetId };
  };

  ipcMain.handle(
    ipcChannels.knownHosts.trust,
    async (_event, rawInput: KnownHostTrustInput) => {
      const input = resolveTrustScope(rawInput);
      // 신뢰는 그 호스트의 볼트에 둔다 — 팀 호스트의 키는 팀원 모두가 믿는다.
      const record = ctx.vaults.scopeOfHost(input.hostId).knownHosts.trust(input);
      ctx.activityLogs.append(
        "info",
        "audit",
        logMessage('knownHostsIpc.hostKeyTrusted'),
        {
          hostId: input.hostId,
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
      const record = ctx.vaults.scopeOfHost(input.hostId).knownHosts.trust(input);
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
    // 그 기록이 든 볼트에서 지운다 — 팀 것은 멤버 모두가 다음 접속에서 다시 확인한다.
    const scope = ctx.vaults.scopeOfKnownHost(id);
    if (scope.id === PERSONAL_VAULT_ID) {
      ctx.syncOutbox.upsertDeletion("knownHosts", id);
      ctx.knownHosts.remove(id);
    } else {
      scope.syncOutbox.upsertDeletion("knownHosts", id);
      scope.knownHosts.remove(id);
    }
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
    async (event, recordingId: string, teamId?: string | null) => {
      await ctx.sessionReplayService.openReplayWindow(
        recordingId,
        ctx.resolveWindowFromSender(event.sender),
        teamId ?? null,
      );
    },
  );

  ipcMain.handle(
    ipcChannels.sessionReplays.load,
    async (_event, recordingId: string, teamId?: string | null) =>
      ctx.sessionReplayService.load(recordingId, teamId ?? null),
  );

  ipcMain.handle(
    ipcChannels.sessionReplays.readSegment,
    async (_event, recordingId: string, segmentIndex: number, teamId?: string | null) =>
      ctx.sessionReplayService.readSegment(recordingId, segmentIndex, teamId ?? null),
  );

  ipcMain.handle(
    ipcChannels.sessionReplays.readSnapshot,
    async (_event, recordingId: string, segmentIndex: number, teamId: string) =>
      ctx.sessionReplayService.readSnapshot(recordingId, segmentIndex, teamId),
  );

  ipcMain.handle(ipcChannels.sessionReplays.storageUsage, async () =>
    ctx.sessionReplayService.getStorageUsage(),
  );

  ipcMain.handle(ipcChannels.keychain.list, async (_event, vaultId?: string | null) => {
    const vault = resolveListedVault(ctx.vaults, vaultId);
    return vault === "personal" ? ctx.secretMetadata.list() : (vault?.secretMetadata.list() ?? []);
  });

  ipcMain.handle(
    ipcChannels.keychain.load,
    async (_event, secretRef: string) => {
      const vault = secretVaultOf(ctx, secretRef);
      const metadata = vault.metadata.getBySecretRef(secretRef);
      if (!metadata) {
        return null;
      }
      const raw = await vault.secrets.load(secretRef);
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
      const vault = secretVaultOf(ctx, secretRef);
      const metadata = vault.metadata.getBySecretRef(secretRef);
      if (!metadata) {
        throw new Error(t('knownHostsIpc.secretNotFound'));
      }

      const raw = await vault.secrets.load(secretRef);
      if (!raw) {
        throw new Error(t('knownHostsIpc.secretLoadFailed'));
      }

      const payload = JSON.parse(raw) as ManagedSecretPayload;
      if (!payload.password) {
        throw new Error(t('knownHostsIpc.noStoredPassword'));
      }

      await clipboard.writeText(payload.password);
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.remove,
    async (_event, secretRef: string) => {
      // 그 볼트의 호스트만 이 비밀값을 가리킨다(볼트를 넘는 참조는 메인이 거절한다). 지움 기록을 먼저 남긴다 —
      // 비밀값을 지우고 메타데이터를 지우기 전(기다리는 사이)에 팀 동기화가 돌면, 기록 없이 빠진 것을 서버 사본으로 되살린다.
      const vaultId = ctx.vaults.scopeOfSecret(secretRef).id;
      const vault = secretVaultOf(ctx, secretRef);
      vault.syncOutbox.upsertDeletion("secrets", secretRef);
      await vault.secrets.remove(secretRef);
      vault.metadata.remove(secretRef);
      vault.hosts.clearSecretRef(secretRef);
      ctx.activityLogs.append("warn", "audit", logMessage('knownHostsIpc.secretRemoved'), {
        vaultId,
        secretRef,
      });
      ctx.queueSync();
    },
  );

  ipcMain.handle(
    ipcChannels.keychain.update,
    async (_event, input: KeychainSecretUpdateInput) => {
      const vault = secretVaultOf(ctx, input.secretRef);
      const currentMetadata = vault.metadata.getBySecretRef(input.secretRef);
      if (!currentMetadata) {
        throw new Error("Keychain secret not found");
      }

      const replacementSecrets = normalizeReplacementSecrets(input.secrets);
      const validationError = validateReplacementSecrets(replacementSecrets);
      if (validationError) {
        throw new Error(validationError);
      }
      const currentRaw = await vault.secrets.load(input.secretRef);
      const currentPayload = currentRaw
        ? (JSON.parse(currentRaw) as ManagedSecretPayload)
        : null;
      const keepPublicKeyMetadata =
        currentPayload?.privateKeyPem &&
        currentPayload.privateKeyPem === replacementSecrets.privateKeyPem;
      // 이름은 암호화 레코드와 평문 메타데이터 양쪽에 있다. 한쪽만 바꾸면 목록과 편집 화면이
      // 서로 다른 이름을 말한다. 빈 값은 "그대로" 로 본다 — 이름 없는 자격증명은 고를 수 없다.
      const nextLabel = input.label?.trim() ? input.label.trim() : currentMetadata.label;

      await vault.secrets.save(
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
      vault.metadata.upsert({
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
      const host = ctx.vaults.getHost(input.hostId);
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

      // 새 비밀값은 그 호스트의 볼트에 둔다(팀 호스트면 그 팀).
      const vault = ctx.vaults.scopeOfHost(sshHost.id);
      const label = input.label?.trim() ? input.label.trim() : ctx.describeHostLabel(sshHost);
      const nextSecretRef =
        vault === ctx.vaults.personal
          ? await ctx.persistSecret(label, replacementSecrets)
          : await ctx.persistSecret(label, replacementSecrets, vault);
      if (!nextSecretRef) {
        throw new Error(t('knownHostsIpc.secretCreateFailed'));
      }

      ctx.vaults.writeHost(sshHost.id, (hosts) => hosts.updateSecretRef(sshHost.id, nextSecretRef));
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
