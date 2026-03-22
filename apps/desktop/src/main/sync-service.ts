import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  ManagedSecretPayload,
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
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SyncOutboxRepository
} from './database';
import { SecretStore } from './secret-store';
import { AuthService } from './auth-service';
import { getDesktopStateStorage } from './state-storage';

const RETRY_DELAY_MS = 30_000;

export class SyncAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncAuthenticationError';
  }
}

function defaultSyncStatus(): SyncStatus {
  return {
    status: 'idle',
    lastSuccessfulSyncAt: null,
    pendingPush: false,
    errorMessage: null
  };
}

function totalRecordCount(payload: SyncPayloadV2): number {
  return payload.groups.length + payload.hosts.length + payload.secrets.length + payload.knownHosts.length + payload.portForwards.length + payload.preferences.length;
}

function normalizeSyncPayload(payload: Partial<SyncPayloadV2> | null | undefined): SyncPayloadV2 {
  return {
    groups: Array.isArray(payload?.groups) ? payload.groups : [],
    hosts: Array.isArray(payload?.hosts) ? payload.hosts : [],
    secrets: Array.isArray(payload?.secrets) ? payload.secrets : [],
    knownHosts: Array.isArray(payload?.knownHosts) ? payload.knownHosts : [],
    portForwards: Array.isArray(payload?.portForwards) ? payload.portForwards : [],
    preferences: Array.isArray(payload?.preferences) ? payload.preferences : []
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

  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error;
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
  } catch {
    // JSON이 아니면 그대로 아래 fallback 경로를 탄다.
  }

  return text || `${fallback} (${response.status})`;
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
  private state: SyncStatus = defaultSyncStatus();
  private pushTimer: NodeJS.Timeout | null = null;
  private pushPromise: Promise<SyncStatus> | null = null;

  constructor(
    private readonly authService: AuthService,
    private readonly hosts: HostRepository,
    private readonly groups: GroupRepository,
    private readonly portForwards: PortForwardRepository,
    private readonly knownHosts: KnownHostRepository,
    private readonly secretMetadata: SecretMetadataRepository,
    private readonly settings: SettingsRepository,
    private readonly secretStore: SecretStore,
    private readonly outbox: SyncOutboxRepository
  ) {}

  getState(): SyncStatus {
    return this.state;
  }

  async bootstrap(): Promise<SyncStatus> {
    this.patchState({
      status: 'syncing',
      errorMessage: null
    });

    try {
      const remote = await this.fetchRemoteSnapshot();
      if (totalRecordCount(remote) === 0) {
        const local = await this.buildEncryptedSnapshot(true);
        if (totalRecordCount(local) > 0) {
          await this.pushSnapshot(local);
          await this.promoteLocalSecretsToServerManaged();
        }
      } else {
        await this.applyRemoteSnapshot(remote);
      }
      this.outbox.clearAll();
      this.patchState({
        status: 'ready',
        lastSuccessfulSyncAt: new Date().toISOString(),
        pendingPush: false,
        errorMessage: null
      });
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
    if (this.pushPromise) {
      return this.pushPromise;
    }

    this.pushPromise = (async () => {
      try {
        this.patchState({
          status: this.state.status === 'idle' ? 'syncing' : this.state.status,
          pendingPush: true,
          errorMessage: null
        });
        const payload = await this.buildEncryptedSnapshot(true);
        await this.pushSnapshot(payload);
        this.outbox.clearAll();
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
      }
      return this.state;
    })();

    return this.pushPromise;
  }

  async exportDecryptedSnapshot(): Promise<SyncPayloadV2> {
    return this.buildEncryptedSnapshot(true);
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
    this.settings.clearSyncedTerminalPreferences();
    this.outbox.clearAll();
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
      throw new SyncAuthenticationError(firstFailureMessage || '세션이 만료되었습니다. 다시 로그인해 주세요.');
    }

    response = await fetch(url, this.withAccessToken(init, this.authService.getAccessToken()));
    if (!response.ok) {
      throw await toApiError(response, fallback);
    }
    return response;
  }

  private async fetchRemoteSnapshot(): Promise<SyncPayloadV2> {
    const response = await this.fetchWithAuthRetry(new URL('/sync', this.authService.getServerUrl()), {}, '동기화 데이터 조회에 실패했습니다.');
    return normalizeSyncPayload((await response.json()) as Partial<SyncPayloadV2>);
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

  private async buildEncryptedSnapshot(includeDeletions: boolean): Promise<SyncPayloadV2> {
    const vaultKeyBase64 = this.authService.getVaultKeyBase64();
    const groups = this.groups.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const hosts = this.hosts.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const knownHosts = this.knownHosts.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const portForwards = this.portForwards.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const preferences = [this.settings.getSyncedTerminalPreferences()].map((record) =>
      this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64)
    );

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
        groups,
        hosts,
        secrets,
        knownHosts,
        portForwards,
        preferences
      };
    }

    const outbox = this.outbox.list();
    for (const tombstone of outbox) {
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
        case 'preferences':
          preferences.push(record);
          break;
      }
    }

    return {
      groups,
      hosts,
      secrets,
      knownHosts,
      portForwards,
      preferences
    };
  }

  private toSyncRecord(id: string, updatedAt: string, payload: unknown, vaultKeyBase64: string): SyncRecord {
    return {
      id,
      encrypted_payload: encodeEncryptedPayload(JSON.stringify(payload), vaultKeyBase64),
      updated_at: updatedAt
    };
  }

  private async applyRemoteSnapshot(payload: SyncPayloadV2): Promise<void> {
    const vaultKeyBase64 = this.authService.getVaultKeyBase64();

    const groups = payload.groups.filter((record) => !record.deleted_at).map((record) => decodeEncryptedPayload<GroupRecord>(record.encrypted_payload, vaultKeyBase64));
    const hosts = payload.hosts.filter((record) => !record.deleted_at).map((record) => decodeEncryptedPayload<HostRecord>(record.encrypted_payload, vaultKeyBase64));
    const knownHosts = payload.knownHosts
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<KnownHostRecord>(record.encrypted_payload, vaultKeyBase64));
    const portForwards = payload.portForwards
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<PortForwardRuleRecord>(record.encrypted_payload, vaultKeyBase64));
    const preferences = payload.preferences
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<TerminalPreferencesRecord>(record.encrypted_payload, vaultKeyBase64));
    const secrets = payload.secrets
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<ManagedSecretPayload>(record.encrypted_payload, vaultKeyBase64));

    this.groups.replaceAll(groups);
    this.hosts.replaceAll(hosts);
    this.knownHosts.replaceAll(knownHosts);
    this.portForwards.replaceAll(portForwards);
    this.settings.replaceSyncedTerminalPreferences(preferences[0] ?? null);

    const existingServerSecrets = this.secretMetadata.listBySource('server_managed');
    const nextSecretRefs = new Set(secrets.map((secret) => secret.secretRef));
    for (const existing of existingServerSecrets) {
      if (nextSecretRefs.has(existing.secretRef)) {
        continue;
      }
      await this.secretStore.remove(existing.secretRef).catch(() => undefined);
    }

    const nextSecretMetadata: SecretMetadataRecord[] = [];
    for (const secret of secrets) {
      await this.secretStore.save(secret.secretRef, JSON.stringify(secret));
      nextSecretMetadata.push({
        secretRef: secret.secretRef,
        label: secret.label,
        hasPassword: Boolean(secret.password),
        hasPassphrase: Boolean(secret.passphrase),
        hasManagedPrivateKey: Boolean(secret.privateKeyPem),
        source: 'server_managed',
        linkedHostCount: hosts.filter((host) => host.secretRef === secret.secretRef).length,
        updatedAt: secret.updatedAt
      });
    }
    this.secretMetadata.replaceAll(nextSecretMetadata, 'server_managed');
  }

  private async promoteLocalSecretsToServerManaged(): Promise<void> {
    const entries = this.secretMetadata.list();
    for (const entry of entries) {
      this.secretMetadata.upsert({
        secretRef: entry.secretRef,
        label: entry.label,
        hasPassword: entry.hasPassword,
        hasPassphrase: entry.hasPassphrase,
        hasManagedPrivateKey: entry.hasManagedPrivateKey,
        source: 'server_managed'
      });
    }
  }

  private scheduleRetry(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    this.pushTimer = setTimeout(() => {
      void this.pushDirty();
    }, RETRY_DELAY_MS);
  }

  private patchState(patch: Partial<SyncStatus>): void {
    this.state = {
      ...this.state,
      ...patch
    };
    this.stateStorage.updateSyncState({
      lastSuccessfulSyncAt: this.state.lastSuccessfulSyncAt ?? null,
      pendingPush: this.state.pendingPush,
      errorMessage: this.state.errorMessage ?? null
    });
  }
}

type SyncRecordKind = 'groups' | 'hosts' | 'secrets' | 'knownHosts' | 'portForwards' | 'preferences';
