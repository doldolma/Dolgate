import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  AwsProfilesServerSupport,
  DnsOverrideRecord,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  ManagedAwsProfilePayload,
  ManagedSecretPayload,
  ServerInfoResponse,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  SyncPayloadV2,
  SyncRecord,
  SyncStatus,
  TerminalPreferencesRecord
} from '@shared';
import {
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  DnsOverrideRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  AwsProfileRepository,
  SettingsRepository,
  SyncOutboxRepository,
  type SyncDeletionRecord
} from './database';
import { encodeSecretForStorage, SecretStore } from './secret-store';
import { AuthService } from './auth-service';
import { getDesktopStateStorage } from './state-storage';
import {
  AUTH_INVALID_ERROR_MESSAGE,
  extractApiErrorMessage,
  normalizeAuthInvalidErrorMessage,
} from './auth-error-message';

const RETRY_DELAY_MS = 30_000;

export class SyncAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncAuthenticationError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSyncStatus(): SyncStatus {
  return {
    status: 'idle',
    lastSuccessfulSyncAt: null,
    pendingPush: false,
    errorMessage: null,
    awsProfilesServerSupport: 'unknown'
  };
}

function isE2ESyncDisabled(): boolean {
  return process.env.DOLSSH_E2E_DISABLE_SYNC === '1';
}

function totalRecordCount(payload: SyncPayloadV2): number {
  return (
    payload.groups.length +
    payload.hosts.length +
    payload.secrets.length +
    payload.knownHosts.length +
    payload.portForwards.length +
    payload.dnsOverrides.length +
    payload.preferences.length +
    payload.awsProfiles.length
  );
}

function normalizeSyncPayload(
  payload: Partial<SyncPayloadV2> | null | undefined,
  options?: { includeAwsProfiles?: boolean }
): SyncPayloadV2 {
  const includeAwsProfiles = options?.includeAwsProfiles ?? true;
  return {
    groups: Array.isArray(payload?.groups) ? payload.groups : [],
    hosts: Array.isArray(payload?.hosts) ? payload.hosts : [],
    secrets: Array.isArray(payload?.secrets) ? payload.secrets : [],
    knownHosts: Array.isArray(payload?.knownHosts) ? payload.knownHosts : [],
    portForwards: Array.isArray(payload?.portForwards) ? payload.portForwards : [],
    dnsOverrides: Array.isArray(payload?.dnsOverrides) ? payload.dnsOverrides : [],
    preferences: Array.isArray(payload?.preferences) ? payload.preferences : [],
    awsProfiles:
      includeAwsProfiles && Array.isArray(payload?.awsProfiles) ? payload.awsProfiles : []
  };
}

function resolveAwsProfilesServerSupport(
  payload: Partial<ServerInfoResponse> | null | undefined
): AwsProfilesServerSupport {
  return payload?.capabilities?.sync?.awsProfiles === true ? 'supported' : 'unsupported';
}

function resolveManagedAwsProfileNameConflicts(
  profiles: ManagedAwsProfilePayload[]
): { profiles: ManagedAwsProfilePayload[]; hadConflicts: boolean } {
  if (profiles.length < 2) {
    return { profiles, hadConflicts: false };
  }

  const byName = new Map<string, ManagedAwsProfilePayload[]>();
  for (const profile of profiles) {
    const bucket = byName.get(profile.name) ?? [];
    bucket.push(profile);
    byName.set(profile.name, bucket);
  }

  const occupiedNames = new Set(profiles.map((profile) => profile.name));
  const renamedProfiles = new Map<string, ManagedAwsProfilePayload>();
  let hadConflicts = false;

  for (const [name, duplicates] of byName) {
    if (duplicates.length < 2) {
      continue;
    }

    hadConflicts = true;
    const ordered = [...duplicates].sort((left, right) => {
      const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return left.id.localeCompare(right.id);
    });

    for (const profile of ordered.slice(1)) {
      occupiedNames.delete(profile.name);
      const shortId = profile.id.slice(0, 8);
      let suffix = 0;
      let nextName = `${name}-conflict-${shortId}`;
      while (occupiedNames.has(nextName)) {
        suffix += 1;
        nextName = `${name}-conflict-${shortId}-${suffix}`;
      }
      occupiedNames.add(nextName);
      renamedProfiles.set(profile.id, {
        ...profile,
        name: nextName,
        updatedAt: nowIso(),
      });
    }
  }

  if (!hadConflicts) {
    return { profiles, hadConflicts: false };
  }

  return {
    profiles: profiles.map((profile) => renamedProfiles.get(profile.id) ?? profile),
    hadConflicts: true,
  };
}

function encodeEncryptedPayload(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

function decodeEncryptedPayload<T>(payload: string, keyBase64: string): T {
  const envelope = JSON.parse(payload) as {
    v: number;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as T;
}

async function toApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = (await response.text()).trim();
  const looksLikeHtml =
    contentType.includes('text/html') ||
    text.startsWith('<!DOCTYPE html') ||
    text.startsWith('<html') ||
    text.includes('<body>');

  if (looksLikeHtml) {
    return `${fallback} 서버가 API 응답 대신 HTML 페이지를 반환했습니다. 배포 주소 또는 리버스 프록시 설정을 확인해 주세요. (${response.status})`;
  }

  const extracted = extractApiErrorMessage(text);
  const normalizedAuthMessage = extracted
    ? normalizeAuthInvalidErrorMessage({
        status: response.status,
        message: extracted,
      })
    : null;

  return normalizedAuthMessage || extracted || `${fallback} (${response.status})`;
}

function isLikelyAuthError(response: Response, message: string): boolean {
  if (response.status === 401 || response.status === 403) {
    return true;
  }

  return /token is expired|invalid claims|unauthorized|forbidden|jwt|로그인이 필요합니다|세션이 만료/i.test(message);
}

async function toApiError(response: Response, fallback: string): Promise<Error> {
  const message = await toApiErrorMessage(response, fallback);
  if (isLikelyAuthError(response, message)) {
    return new SyncAuthenticationError(message);
  }
  return new Error(message);
}

export function isSyncAuthenticationError(error: unknown): error is SyncAuthenticationError {
  return error instanceof SyncAuthenticationError;
}

async function loadManagedSecret(secretStore: SecretStore, secretRef: string): Promise<ManagedSecretPayload | null> {
  const raw = await secretStore.load(secretRef);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as ManagedSecretPayload;
}

export class SyncService {
  private readonly stateStorage = getDesktopStateStorage();
  private state: SyncStatus;
  private pushTimer: NodeJS.Timeout | null = null;
  private pushPromise: Promise<SyncStatus> | null = null;
  private queuedPushAfterCurrent = false;
  private onAppliedSnapshot: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly authService: AuthService,
    private readonly hosts: HostRepository,
    private readonly groups: GroupRepository,
    private readonly portForwards: PortForwardRepository,
    private readonly dnsOverrides: DnsOverrideRepository,
    private readonly knownHosts: KnownHostRepository,
    private readonly secretMetadata: SecretMetadataRepository,
    private readonly awsProfiles: AwsProfileRepository,
    private readonly settings: SettingsRepository,
    private readonly secretStore: SecretStore,
    private readonly outbox: SyncOutboxRepository
  ) {
    this.state = this.loadPersistedState();
  }

  getState(): SyncStatus {
    return this.state;
  }

  setOnAppliedSnapshot(listener: (() => void | Promise<void>) | null): void {
    this.onAppliedSnapshot = listener;
  }

  pause(errorMessage?: string | null): SyncStatus {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }

    this.patchState({
      status: 'paused',
      pendingPush: this.hasPendingLocalChanges(),
      errorMessage: errorMessage ?? null
    });
    return this.state;
  }

  markLocalChangesPendingPush(): SyncStatus {
    this.patchState({
      pendingPush: true,
      errorMessage: null
    });
    return this.state;
  }

  async bootstrap(): Promise<SyncStatus> {
    if (isE2ESyncDisabled()) {
      this.patchState({
        status: 'ready',
        lastSuccessfulSyncAt: new Date().toISOString(),
        pendingPush: false,
        errorMessage: null
      });
      return this.state;
    }

    if (this.authService.getState().status === 'offline-authenticated') {
      return this.pause('오프라인 모드에서는 동기화를 일시 중지합니다.');
    }

    const hadPendingLocalChanges = this.hasPendingLocalChanges();
    this.patchState({
      status: 'syncing',
      pendingPush: hadPendingLocalChanges,
      errorMessage: null
    });

    try {
      const previousAwsProfilesServerSupport =
        this.state.awsProfilesServerSupport ?? 'unknown';
      const awsProfilesServerSupport =
        await this.fetchAwsProfilesServerSupport();
      const shouldBackfillAwsProfiles =
        previousAwsProfilesServerSupport === 'unsupported' &&
        awsProfilesServerSupport === 'supported';
      this.patchState({
        awsProfilesServerSupport,
      });

      if (hadPendingLocalChanges || shouldBackfillAwsProfiles) {
        const local = await this.buildEncryptedSnapshot(true, awsProfilesServerSupport);
        if (totalRecordCount(local) > 0) {
          await this.pushSnapshot(local);
        }
      }

      let remote = await this.fetchRemoteSnapshot(awsProfilesServerSupport);
      if (totalRecordCount(remote) === 0) {
        const local = await this.buildEncryptedSnapshot(true, awsProfilesServerSupport);
        if (totalRecordCount(local) > 0) {
          await this.pushSnapshot(local);
          remote = await this.fetchRemoteSnapshot(awsProfilesServerSupport);
        }
      }

      const hadAwsProfileConflicts = await this.applyRemoteSnapshotAtomically(
        remote,
        awsProfilesServerSupport
      );
      this.outbox.clearMany(
        this.listSyncableDeletions(awsProfilesServerSupport)
      );
      this.patchState({
        status: 'ready',
        lastSuccessfulSyncAt: new Date().toISOString(),
        pendingPush: hadAwsProfileConflicts,
        errorMessage: null
      });
      if (hadAwsProfileConflicts) {
        this.scheduleRetry();
      }
    } catch (error) {
      this.patchState({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '초기 동기화에 실패했습니다.',
        pendingPush: true
      });
      throw error;
    }

    return this.state;
  }

  async pushDirty(): Promise<SyncStatus> {
    if (isE2ESyncDisabled()) {
      this.patchState({
        status: 'ready',
        lastSuccessfulSyncAt: new Date().toISOString(),
        pendingPush: false,
        errorMessage: null
      });
      return this.state;
    }

    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }

    this.markPendingPush();

    if (this.authService.getState().status === 'offline-authenticated') {
      return this.pause('오프라인 모드에서는 변경 내용을 로컬에 보관하고 나중에 동기화합니다.');
    }

    if (this.pushPromise) {
      this.queuedPushAfterCurrent = true;
      return this.pushPromise;
    }

    this.pushPromise = (async () => {
      try {
        let shouldContinuePush = false;
        do {
          this.queuedPushAfterCurrent = false;
          this.patchState({
            status: this.state.status === 'idle' ? 'syncing' : this.state.status,
            pendingPush: true,
            errorMessage: null
          });
          const snapshot = await this.buildEncryptedSnapshotResult(
            true,
            this.state.awsProfilesServerSupport ?? 'unknown'
          );
          await this.pushSnapshot(snapshot.payload);
          this.outbox.clearMany(snapshot.includedDeletions);
          shouldContinuePush =
            this.queuedPushAfterCurrent ||
            this.listSyncableDeletions(this.state.awsProfilesServerSupport ?? 'unknown').length > 0;
        } while (shouldContinuePush);

        this.patchState({
          status: 'ready',
          pendingPush: false,
          lastSuccessfulSyncAt: new Date().toISOString(),
          errorMessage: null
        });
      } catch (error) {
        this.patchState({
          status: 'error',
          pendingPush: true,
          errorMessage: error instanceof Error ? error.message : '동기화 업로드에 실패했습니다.'
        });
        this.scheduleRetry();
      } finally {
        this.pushPromise = null;
        this.queuedPushAfterCurrent = false;
      }
      return this.state;
    })();

    return this.pushPromise;
  }

  async exportDecryptedSnapshot(): Promise<SyncPayloadV2> {
    return this.buildEncryptedSnapshot(true, this.state.awsProfilesServerSupport ?? 'unknown');
  }

  markDeleted(kind: SyncRecordKind, recordId: string): void {
    this.outbox.upsertDeletion(kind, recordId);
  }

  async purgeAllSecrets(): Promise<void> {
    const entries = this.secretMetadata.list();
    for (const entry of entries) {
      await this.secretStore.remove(entry.secretRef).catch(() => undefined);
      this.secretMetadata.remove(entry.secretRef);
    }
  }

  async purgeSyncedCache(): Promise<void> {
    // 로그아웃 이후에는 서버에서 다시 hydrate하므로, 동기화 대상 secret은 source와 무관하게 모두 제거한다.
    await this.purgeAllSecrets();
    this.hosts.replaceAll([]);
    this.groups.replaceAll([]);
    this.knownHosts.replaceAll([]);
    this.portForwards.replaceAll([]);
    this.dnsOverrides.replaceAll([]);
    this.awsProfiles.replaceAll([]);
    this.settings.clearSyncedTerminalPreferences();
    this.outbox.clearAll();
    this.stateStorage.updateSyncDataOwner({
      userId: null,
      serverUrl: null
    });
    this.patchState(defaultSyncStatus());
  }

  private withAccessToken(init: RequestInit | undefined, accessToken: string): RequestInit {
    const headers = new Headers(init?.headers ?? {});
    headers.set('Authorization', `Bearer ${accessToken}`);
    return {
      ...init,
      headers
    };
  }

  private async fetchWithAuthRetry(url: URL, init: RequestInit, fallback: string): Promise<Response> {
    let response = await fetch(url, this.withAccessToken(init, this.authService.getAccessToken()));
    if (response.ok) {
      return response;
    }

    const firstFailureMessage = await toApiErrorMessage(response, fallback);
    if (!isLikelyAuthError(response, firstFailureMessage)) {
      throw new Error(firstFailureMessage);
    }

    const refreshed = await this.authService.refreshSession();
    if (refreshed.status !== 'authenticated') {
      throw new SyncAuthenticationError(firstFailureMessage || AUTH_INVALID_ERROR_MESSAGE);
    }

    response = await fetch(url, this.withAccessToken(init, this.authService.getAccessToken()));
    if (!response.ok) {
      throw await toApiError(response, fallback);
    }
    return response;
  }

  private async fetchRemoteSnapshot(
    awsProfilesServerSupport: AwsProfilesServerSupport
  ): Promise<SyncPayloadV2> {
    const response = await this.fetchWithAuthRetry(new URL('/sync', this.authService.getServerUrl()), {}, '동기화 데이터 조회에 실패했습니다.');
    return normalizeSyncPayload((await response.json()) as Partial<SyncPayloadV2>, {
      includeAwsProfiles: this.shouldSyncAwsProfiles(awsProfilesServerSupport),
    });
  }

  private async pushSnapshot(payload: SyncPayloadV2): Promise<void> {
    const response = await this.fetchWithAuthRetry(new URL('/sync', this.authService.getServerUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, '동기화 업로드에 실패했습니다.');
    void response;
  }

  private async buildEncryptedSnapshot(
    includeDeletions: boolean,
    awsProfilesServerSupport: AwsProfilesServerSupport = this.state.awsProfilesServerSupport ?? 'unknown'
  ): Promise<SyncPayloadV2> {
    const snapshot = await this.buildEncryptedSnapshotResult(includeDeletions, awsProfilesServerSupport);
    return snapshot.payload;
  }

  private async buildEncryptedSnapshotResult(
    includeDeletions: boolean,
    awsProfilesServerSupport: AwsProfilesServerSupport = this.state.awsProfilesServerSupport ?? 'unknown'
  ): Promise<{ payload: SyncPayloadV2; includedDeletions: SyncDeletionRecord[] }> {
    const vaultKeyBase64 = this.authService.getVaultKeyBase64();
    const groups = this.groups.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const hosts = this.hosts.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const knownHosts = this.knownHosts.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const portForwards = this.portForwards.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const dnsOverrides = this.dnsOverrides.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const preferences = [this.settings.getSyncedTerminalPreferences()].map((record) =>
      this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64)
    );
    const shouldSyncAwsProfiles = this.shouldSyncAwsProfiles(awsProfilesServerSupport);
    const awsProfiles = shouldSyncAwsProfiles
      ? this.awsProfiles.listPayloads().map((record) =>
          this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64)
        )
      : [];

    const secretEntries = this.secretMetadata.list();
    const secrets: SyncRecord[] = [];
    for (const entry of secretEntries) {
      const secret = await loadManagedSecret(this.secretStore, entry.secretRef);
      if (!secret) {
        continue;
      }
      secrets.push(this.toSyncRecord(entry.secretRef, secret.updatedAt, secret, vaultKeyBase64));
    }

    if (!includeDeletions) {
      return {
        payload: {
          groups,
          hosts,
          secrets,
          knownHosts,
          portForwards,
          dnsOverrides,
          preferences,
          awsProfiles
        },
        includedDeletions: []
      };
    }

    const includedDeletions = this.listSyncableDeletions(awsProfilesServerSupport);
    for (const tombstone of includedDeletions) {
      const record: SyncRecord = {
        id: tombstone.recordId,
        encrypted_payload: '',
        updated_at: tombstone.deletedAt,
        deleted_at: tombstone.deletedAt
      };
      switch (tombstone.kind) {
        case 'groups':
          groups.push(record);
          break;
        case 'hosts':
          hosts.push(record);
          break;
        case 'secrets':
          secrets.push(record);
          break;
        case 'knownHosts':
          knownHosts.push(record);
          break;
        case 'portForwards':
          portForwards.push(record);
          break;
        case 'dnsOverrides':
          dnsOverrides.push(record);
          break;
        case 'preferences':
          preferences.push(record);
          break;
        case 'awsProfiles':
          awsProfiles.push(record);
          break;
      }
    }

    return {
      payload: {
        groups,
        hosts,
        secrets,
        knownHosts,
        portForwards,
        dnsOverrides,
        preferences,
        awsProfiles
      },
      includedDeletions
    };
  }

  private toSyncRecord(id: string, updatedAt: string, payload: unknown, vaultKeyBase64: string): SyncRecord {
    return {
      id,
      encrypted_payload: encodeEncryptedPayload(JSON.stringify(payload), vaultKeyBase64),
      updated_at: updatedAt
    };
  }

  private async applyRemoteSnapshotAtomically(
    payload: SyncPayloadV2,
    awsProfilesServerSupport: AwsProfilesServerSupport
  ): Promise<boolean> {
    const vaultKeyBase64 = this.authService.getVaultKeyBase64();
    const shouldSyncAwsProfiles = this.shouldSyncAwsProfiles(awsProfilesServerSupport);

    const groups = payload.groups
      .filter((record) => !record.deleted_at)
      .map((record) =>
        decodeEncryptedPayload<GroupRecord>(
          record.encrypted_payload,
          vaultKeyBase64
        )
      );
    const hosts = payload.hosts
      .filter((record) => !record.deleted_at)
      .map((record) =>
        decodeEncryptedPayload<HostRecord>(
          record.encrypted_payload,
          vaultKeyBase64
        )
      );
    const knownHosts = payload.knownHosts
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<KnownHostRecord>(record.encrypted_payload, vaultKeyBase64));
    const portForwards = payload.portForwards
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<PortForwardRuleRecord>(record.encrypted_payload, vaultKeyBase64));
    const dnsOverrides = payload.dnsOverrides
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<DnsOverrideRecord>(record.encrypted_payload, vaultKeyBase64));
    const preferences = payload.preferences
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<TerminalPreferencesRecord>(record.encrypted_payload, vaultKeyBase64));
    const decodedAwsProfiles = shouldSyncAwsProfiles
      ? payload.awsProfiles
          .filter((record) => !record.deleted_at)
          .map((record) =>
            decodeEncryptedPayload<ManagedAwsProfilePayload>(record.encrypted_payload, vaultKeyBase64)
          )
      : [];
    const {
      profiles: awsProfiles,
      hadConflicts: hadAwsProfileConflicts,
    } = shouldSyncAwsProfiles
      ? resolveManagedAwsProfileNameConflicts(decodedAwsProfiles)
      : { profiles: [] as ManagedAwsProfilePayload[], hadConflicts: false };
    const secrets = payload.secrets
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<ManagedSecretPayload>(record.encrypted_payload, vaultKeyBase64));

    const nextSecretRefs = new Set(secrets.map((secret) => secret.secretRef));
    const nextSecretMetadata: SecretMetadataRecord[] = secrets.map((secret) => ({
        secretRef: secret.secretRef,
        label: secret.label,
        hasPassword: Boolean(secret.password),
        hasPassphrase: Boolean(secret.passphrase),
        hasManagedPrivateKey: Boolean(secret.privateKeyPem),
        source: 'server_managed',
        linkedHostCount: 0,
        updatedAt: secret.updatedAt
      }));
    const nextStoredSecrets = new Map(
      secrets.map((secret) => [
        secret.secretRef,
        encodeSecretForStorage(JSON.stringify(secret))
      ])
    );

    this.stateStorage.updateState((state) => {
      const existingServerSecretRefs = new Set(
        state.data.secretMetadata
          .filter((record) => record.source === 'server_managed')
          .map((record) => record.secretRef)
      );
      const remainingMetadata = state.data.secretMetadata.filter(
        (record) => record.source !== 'server_managed'
      );

      state.data.groups = groups;
      state.data.hosts = hosts;
      state.data.knownHosts = knownHosts;
      state.data.portForwards = portForwards;
      state.data.dnsOverrides = dnsOverrides;
      if (shouldSyncAwsProfiles) {
        state.data.awsProfiles = awsProfiles.map((record) => ({
          id: record.id,
          name: record.name,
          kind: record.kind,
          updatedAt: record.updatedAt
        }));
      }
      state.terminal.globalThemeId =
        preferences[0]?.globalTerminalThemeId ?? 'dolssh-dark';
      state.terminal.globalThemeUpdatedAt =
        preferences[0]?.updatedAt ?? nowIso();
      state.data.secretMetadata = [...remainingMetadata, ...nextSecretMetadata];

      for (const secretRef of existingServerSecretRefs) {
        if (!nextSecretRefs.has(secretRef)) {
          delete state.secure.managedSecretsByRef[secretRef];
        }
      }
      for (const [secretRef, storedSecret] of nextStoredSecrets) {
        state.secure.managedSecretsByRef[secretRef] = storedSecret;
      }
      if (shouldSyncAwsProfiles) {
        const nextAwsProfileIds = new Set(awsProfiles.map((profile) => profile.id));
        for (const profileId of Object.keys(state.secure.managedAwsProfilesById)) {
          if (!nextAwsProfileIds.has(profileId)) {
            delete state.secure.managedAwsProfilesById[profileId];
          }
        }
        for (const profile of awsProfiles) {
          state.secure.managedAwsProfilesById[profile.id] = encodeSecretForStorage(JSON.stringify(profile));
        }
      }
    });
    await this.onAppliedSnapshot?.();
    return hadAwsProfileConflicts;
  }

  private scheduleRetry(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    this.pushTimer = setTimeout(() => {
      void this.pushDirty();
    }, RETRY_DELAY_MS);
  }

  private loadPersistedState(): SyncStatus {
    const syncState = this.stateStorage.getState().sync;
    return {
      status: 'idle',
      lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
      pendingPush: syncState.pendingPush,
      errorMessage: syncState.errorMessage,
      awsProfilesServerSupport: syncState.awsProfilesServerSupport ?? 'unknown'
    };
  }

  private hasPendingLocalChanges(): boolean {
    return (
      this.state.pendingPush ||
      this.stateStorage.getState().sync.pendingPush ||
      this.listSyncableDeletions(this.state.awsProfilesServerSupport ?? 'unknown').length > 0
    );
  }

  private markPendingPush(): void {
    if (this.hasPendingLocalChanges()) {
      if (!this.state.pendingPush) {
        this.patchState({
          pendingPush: true
        });
      }
      return;
    }

    this.patchState({
      pendingPush: true,
      errorMessage: null
    });
  }

  private patchState(patch: Partial<SyncStatus>): void {
    this.state = {
      ...this.state,
      ...patch
    };
    this.stateStorage.updateSyncState({
      lastSuccessfulSyncAt: this.state.lastSuccessfulSyncAt ?? null,
      pendingPush: this.state.pendingPush,
      errorMessage: this.state.errorMessage ?? null,
      awsProfilesServerSupport: this.state.awsProfilesServerSupport ?? 'unknown'
    });
  }

  private shouldSyncAwsProfiles(
    awsProfilesServerSupport: AwsProfilesServerSupport
  ): boolean {
    return awsProfilesServerSupport !== 'unsupported';
  }

  private listSyncableDeletions(
    awsProfilesServerSupport: AwsProfilesServerSupport
  ): SyncDeletionRecord[] {
    const shouldSyncAwsProfiles = this.shouldSyncAwsProfiles(awsProfilesServerSupport);
    return this.outbox
      .list()
      .filter((record) => shouldSyncAwsProfiles || record.kind !== 'awsProfiles');
  }

  private async fetchAwsProfilesServerSupport(): Promise<AwsProfilesServerSupport> {
    try {
      const response = await fetch(new URL('/api/info', this.authService.getServerUrl()));
      if (!response.ok) {
        return 'unsupported';
      }
      return resolveAwsProfilesServerSupport(
        (await response.json()) as Partial<ServerInfoResponse>
      );
    } catch {
      return 'unsupported';
    }
  }
}

type SyncRecordKind =
  | 'groups'
  | 'hosts'
  | 'secrets'
  | 'knownHosts'
  | 'portForwards'
  | 'dnsOverrides'
  | 'preferences'
  | 'awsProfiles';
