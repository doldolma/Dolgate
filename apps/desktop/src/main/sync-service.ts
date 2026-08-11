import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  AwsProfilesServerSupport,
  DnsOverrideRecord,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  ManagedAwsProfilePayload,
  ManagedSecretPayload,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  ServerInfoResponse,
  SnippetRecord,
  SyncPayloadV2,
  SyncRecord,
  SyncStatus,
  TailnetPayload,
  TerminalPreferencesRecord,
} from "@shared";
import {
  formatSyncRevisionEtag,
  isKnownHostKind,
  projectSecretMetadata,
  isVaultEpochRejectionCode,
  parseSyncRevisionEtag,
  SYNC_DATA_FLOOR_HEADER,
  SYNC_DATA_FLOOR_LEGACY_INTOLERANT_KINDS,
  LEGACY_TOLERATED_HOST_KINDS,
  VAULT_EPOCH_HEADER,
} from '@shared';
import {
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  DnsOverrideRepository,
  PortForwardRepository,
  SnippetRepository,
  TailnetRepository,
  SecretMetadataRepository,
  AwsProfileRepository,
  SettingsRepository,
  SyncOutboxRepository,
  normalizeTailnetPayloadForStorage,
  type SyncDeletionRecord
} from './database';
import { encodeSecretForStorage, SecretStore } from './secret-store';
import { AuthService, type AuthSyncContext } from './auth-service';
import { getDesktopStateStorage } from './state-storage';
import {
  AUTH_INVALID_ERROR_MESSAGE,
  extractApiErrorMessage,
  normalizeAuthInvalidErrorMessage,
} from './auth-error-message';
import { t } from './i18n';

const RETRY_DELAY_MS = 30_000;

interface SyncLease extends AuthSyncContext {
  generation: number;
  signal: AbortSignal;
}

interface SyncTask {
  generation: number;
  promise: Promise<SyncStatus>;
}

class StaleSyncLeaseError extends Error {
  constructor() {
    super(t('sync.generationChanged'));
    this.name = 'StaleSyncLeaseError';
  }
}

export class SyncAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncAuthenticationError';
  }
}

// 서버가 push 를 stale DEK(다른 기기의 초기화 후 재설정으로 교체됨)로 판정해 거부했다.
// 일반 오류로 재시도하면 영원히 실패하므로, 캐시 DEK 를 버리고 재잠금해야 한다.
export class SyncVaultDekMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncVaultDekMismatchError';
  }
}

// pull 한 레코드를 캐시 DEK 로 복호화하지 못했다 — 다른 기기가 초기화 후 재설정해 DEK 가
// 교체됐다는 신호다(우리 DEK 로 만든 데이터라면 복호화가 실패할 리 없다). 재잠금 대상.
export class SyncVaultDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncVaultDecodeError';
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
    payload.snippets.length +
    payload.tailnets.length +
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
    snippets: Array.isArray(payload?.snippets) ? payload.snippets : [],
    tailnets: Array.isArray(payload?.tailnets) ? payload.tailnets : [],
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
  try {
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
  } catch (error) {
    // GCM 인증 실패(잘못된 DEK) 등 — stale DEK 신호로 올려보내 재잠금을 유도한다.
    throw new SyncVaultDecodeError(
      error instanceof Error ? error.message : t('sync.decryptFailed'),
    );
  }
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
    return t("sync.htmlResponse", { fallback, status: response.status });
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

  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  return /token is expired|invalid claims|unauthorized|forbidden|jwt|로그인이 필요합니다|sign-in is required|세션이 만료|session has expired/i.test(message);
}

async function toApiError(response: Response, fallback: string): Promise<Error> {
  const message = await toApiErrorMessage(response, fallback);
  if (isLikelyAuthError(response, message)) {
    return new SyncAuthenticationError(message);
  }
  return new Error(message);
}

// 409 응답은 body 의 code 로 종류를 구분한다. vault_dek_mismatch(DEK 세대 불일치)와
// vault_reset(볼트 삭제 직후, 재설정 전) 모두 "이 DEK 로는 더 못 간다" 신호이므로 같은
// 재판정 플로우로 보낸다 — 세션을 갱신하면 epoch/verifier 재해석이 올바른 상태(잠금 또는
// 설정 게이트)로 이끌고, 30초 폴링이 전체 스냅샷 재암호화를 반복하는 hot loop 도 사라진다.
// toApiErrorMessage 는 message 만 추출해 code 가 유실되므로 여기서 직접 읽는다.
async function toConflictError(response: Response, fallback: string): Promise<Error> {
  const text = (await response.text()).trim();
  let message = '';
  let code = '';
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    message = typeof parsed.error === 'string' ? parsed.error : '';
    code = typeof parsed.code === 'string' ? parsed.code : '';
  } catch {
    // JSON 이 아니면 fallback 메시지를 쓴다.
  }
  const resolvedMessage = message || `${fallback} (${response.status})`;
  if (isVaultEpochRejectionCode(code)) {
    return new SyncVaultDekMismatchError(resolvedMessage);
  }
  return new Error(resolvedMessage);
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

/**
 * pull 로 받은 자격증명 페이로드를 목록용 메타데이터로 투영한다.
 *
 * 투영 자체는 shared-core 의 projectSecretMetadata 가 한다 — 같은 투영이 번들 가져오기·모바일에도
 * 있어서 필드를 빠뜨리면 세 곳이 갈렸다(kind 가 실제로 그랬다). 여기서는 이 경로의 사실만 얹는다:
 * pull 직후에는 호스트 연결 수를 세지 않고(0), 시각은 페이로드에 적힌 값을 쓴다.
 */
export function secretMetadataFromSyncedSecret(secret: ManagedSecretPayload): SecretMetadataRecord {
  return projectSecretMetadata(secret, {
    linkedHostCount: 0,
    updatedAt: secret.updatedAt,
  });
}

export class SyncService {
  private readonly stateStorage = getDesktopStateStorage();
  private state: SyncStatus;
  private pushTimer: NodeJS.Timeout | null = null;
  private pushTask: SyncTask | null = null;
  private bootstrapTask: SyncTask | null = null;
  private queuedPushGeneration: number | null = null;
  private syncGeneration = 0;
  private syncAbortController = new AbortController();
  private operationTail: Promise<void> = Promise.resolve();
  // 마지막으로 서버와 맞춘 리비전(ETag). 폴링의 If-None-Match 로 보내 변경 없으면 304 로
  // 조기 종료한다. 프로세스 메모리에만 두고, 재시작 시 첫 부트스트랩이 전체를 받아 다시 채운다.
  private lastSyncRevision: string | null = null;
  private onAppliedSnapshot: (() => void | Promise<void>) | null = null;
  private onPurgedSyncedCache: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly authService: AuthService,
    private readonly hosts: HostRepository,
    private readonly groups: GroupRepository,
    private readonly portForwards: PortForwardRepository,
    private readonly dnsOverrides: DnsOverrideRepository,
    private readonly snippets: SnippetRepository,
    private readonly knownHosts: KnownHostRepository,
    private readonly secretMetadata: SecretMetadataRepository,
    private readonly awsProfiles: AwsProfileRepository,
    private readonly settings: SettingsRepository,
    private readonly secretStore: SecretStore,
    private readonly outbox: SyncOutboxRepository,
    // 새 인자는 끝에 붙인다. 중간에 끼우면 나머지 호출 인자가 조용히 한 칸씩 밀린다.
    private readonly tailnets: TailnetRepository
  ) {
    this.state = this.loadPersistedState();
  }

  getState(): SyncStatus {
    return this.state;
  }

  private captureSyncLease(): SyncLease {
    return {
      ...this.authService.captureSyncContext(),
      generation: this.syncGeneration,
      signal: this.syncAbortController.signal,
    };
  }

  private isSyncLeaseActive(lease: SyncLease): boolean {
    return (
      lease.generation === this.syncGeneration &&
      !lease.signal.aborted &&
      this.authService.isSyncContextCurrent(lease)
    );
  }

  private assertSyncLeaseActive(lease: SyncLease): void {
    if (!this.isSyncLeaseActive(lease)) {
      throw new StaleSyncLeaseError();
    }
  }

  private invalidateSyncGeneration(options?: {
    resetRevision?: boolean;
  }): void {
    this.syncGeneration += 1;
    this.syncAbortController.abort();
    this.syncAbortController = new AbortController();
    // 새 generation은 abort를 무시하는 이전 로컬 IO를 기다리지 않는다. 이전 tail은
    // lease guard로 결과를 버리고, 새 세대는 독립 queue에서 즉시 시작한다.
    this.operationTail = Promise.resolve();
    this.queuedPushGeneration = null;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (options?.resetRevision) {
      this.lastSyncRevision = null;
    }
  }

  private enqueueSyncOperation(
    lease: SyncLease,
    operation: () => Promise<SyncStatus>,
  ): Promise<SyncStatus> {
    const previous = this.operationTail;
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.isSyncLeaseActive(lease)) {
          return this.state;
        }
        return operation();
      });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  setOnAppliedSnapshot(listener: (() => void | Promise<void>) | null): void {
    this.onAppliedSnapshot = listener;
  }

  setOnPurgedSyncedCache(listener: (() => void | Promise<void>) | null): void {
    this.onPurgedSyncedCache = listener;
  }

  pause(errorMessage?: string | null): SyncStatus {
    this.invalidateSyncGeneration();

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

  // 볼트 라이프사이클 이벤트(잠금해제·설정·초기화)에서 호출 — ETag 는 "적용한 상태"의
  // 표식이므로 새 DEK 세대에는 무효다(304 로 새 세대 스냅샷을 건너뛰지 않게 지운다).
  resetVaultRecoveryState(): void {
    this.invalidateSyncGeneration({ resetRevision: true });
    this.patchState({
      status: 'paused',
      pendingPush: this.hasPendingLocalChanges(),
      errorMessage: null,
    });
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
      return this.pause(t('sync.pausedOffline'));
    }

    if (!this.authService.isVaultReadyForSync()) {
      return this.pause(t('sync.pausedNeedsVault'));
    }

    const lease = this.captureSyncLease();
    // 잠금해제 IPC와 렌더러 하이드레이션이 동시에 부를 수 있다. 같은 generation만
    // 공유하고, reset 등으로 무효화된 이전 task는 완료를 기다리지 않고 새 task를 연다.
    if (this.bootstrapTask?.generation === lease.generation) {
      return this.bootstrapTask.promise;
    }
    const promise = this.enqueueSyncOperation(lease, () =>
      this.runBootstrap(lease),
    ).finally(() => {
      if (this.bootstrapTask?.generation === lease.generation) {
        this.bootstrapTask = null;
      }
    });
    this.bootstrapTask = { generation: lease.generation, promise };
    return promise;
  }

  private async runBootstrap(lease: SyncLease): Promise<SyncStatus> {
    this.assertSyncLeaseActive(lease);
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
        await this.fetchAwsProfilesServerSupport(lease);
      this.assertSyncLeaseActive(lease);
      const shouldBackfillAwsProfiles =
        previousAwsProfilesServerSupport === 'unsupported' &&
        awsProfilesServerSupport === 'supported';
      this.patchState({
        awsProfilesServerSupport,
      });

      if (hadPendingLocalChanges || shouldBackfillAwsProfiles) {
        const local = await this.buildEncryptedSnapshot(true, awsProfilesServerSupport, lease);
        this.assertSyncLeaseActive(lease);
        if (totalRecordCount(local) > 0) {
          await this.pushSnapshot(local, lease);
        }
      }

      let remote = await this.fetchRemoteSnapshot(awsProfilesServerSupport, lease);
      this.assertSyncLeaseActive(lease);
      // remote 가 비어 있으면(신규/서버 유실) 로컬을 재업로드해 복구한다.
      if (remote.payload !== null && totalRecordCount(remote.payload) === 0) {
        const local = await this.buildEncryptedSnapshot(true, awsProfilesServerSupport, lease);
        this.assertSyncLeaseActive(lease);
        if (totalRecordCount(local) > 0) {
          await this.pushSnapshot(local, lease);
          remote = await this.fetchRemoteSnapshot(awsProfilesServerSupport, lease);
          this.assertSyncLeaseActive(lease);
        }
      }

      // payload === null 은 304(마지막 동기화 이후 서버 변경 없음) — 적용을 건너뛴다.
      const applied = remote.payload !== null;
      const hadAwsProfileConflicts = applied
        ? await this.applyRemoteSnapshotAtomically(
            remote.payload as SyncPayloadV2,
            awsProfilesServerSupport,
            lease,
          )
        : false;
      this.assertSyncLeaseActive(lease);
      // "저장된 리비전 = 실제로 적용한 상태" 불변식: apply 가 성공한 지금에서야 ETag 를
      // 저장한다(decode 실패 시 저장되지 않아, 재잠금 후 unlock 이 304 에 갇히지 않는다).
      if (applied && remote.etag) {
        this.lastSyncRevision = remote.etag;
      }
      this.outbox.clearMany(
        this.listSyncableDeletions(awsProfilesServerSupport)
      );
      this.patchState({
        status: 'ready',
        lastSuccessfulSyncAt: new Date().toISOString(),
        // 실제 적용(200)일 때만 데이터 변경 시각을 갱신 — 304 는 그대로 둬서 렌더러
        // 폴링이 불필요한 워크스페이스 재조회를 건너뛰게 한다.
        lastDataChangeAt: applied
          ? new Date().toISOString()
          : this.state.lastDataChangeAt ?? null,
        pendingPush: hadAwsProfileConflicts,
        errorMessage: null
      });
      if (hadAwsProfileConflicts) {
        this.scheduleRetry();
      }
    } catch (error) {
      if (
        error instanceof StaleSyncLeaseError ||
        !this.isSyncLeaseActive(lease)
      ) {
        return this.state;
      }
      // 볼트 세대 문제(push 409) 또는 pull 복호화 실패 — 둘 다 같은 재판정으로 보낸다:
      // 세션을 갱신해 최신 descriptor 의 epoch/verifier 로 재해석한다(비파괴 — refresh
      // 실패 시 아무것도 잃지 않고 다음 폴링이 재시도한다).
      if (
        error instanceof SyncVaultDekMismatchError ||
        error instanceof SyncVaultDecodeError
      ) {
        await this.authService.handleVaultDekRejected();
        // refresh를 기다리는 동안 사용자가 reset/setup 등 새 볼트 전환을 시작했다면,
        // 옛 복구 결과가 새 계정/서버/DEK context를 다시 pause하지 않게 한다.
        if (!this.isSyncLeaseActive(lease)) {
          return this.state;
        }
        if (
          error instanceof SyncVaultDecodeError &&
          this.authService.getVaultStatus() === 'unlocked'
        ) {
          // 재판정 후에도 verifier 가 이 DEK 를 증명한다(세대 그대로) — 복호화 실패의
          // 원인은 DEK 가 아니라 데이터 손상이다. 재잠금해 봐야 같은 DEK 를 다시 받을
          // 뿐이므로(무한 재입력 루프) 오류로 표시한다.
          return this.pause(
            t('sync.decryptCorrupt'),
          );
        }
        return this.pause(error.message);
      }
      this.patchState({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : t('sync.initialFailed'),
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
      return this.pause(t('sync.pausedOfflineUpload'));
    }

    if (!this.authService.isVaultReadyForSync()) {
      return this.pause(t('sync.pausedNeedsVaultUpload'));
    }

    const lease = this.captureSyncLease();
    if (this.pushTask?.generation === lease.generation) {
      this.queuedPushGeneration = lease.generation;
      return this.pushTask.promise;
    }

    const promise = this.enqueueSyncOperation(lease, async () => {
      try {
        let shouldContinuePush = false;
        do {
          this.assertSyncLeaseActive(lease);
          if (this.queuedPushGeneration === lease.generation) {
            this.queuedPushGeneration = null;
          }
          this.patchState({
            status: this.state.status === 'idle' ? 'syncing' : this.state.status,
            pendingPush: true,
            errorMessage: null
          });
          const snapshot = await this.buildEncryptedSnapshotResult(
            true,
            this.state.awsProfilesServerSupport ?? 'unknown',
            lease,
          );
          this.assertSyncLeaseActive(lease);
          await this.pushSnapshot(snapshot.payload, lease);
          this.assertSyncLeaseActive(lease);
          this.outbox.clearMany(snapshot.includedDeletions);
          shouldContinuePush =
            this.queuedPushGeneration === lease.generation ||
            this.listSyncableDeletions(this.state.awsProfilesServerSupport ?? 'unknown').length > 0;
        } while (shouldContinuePush);

        this.patchState({
          status: 'ready',
          pendingPush: false,
          lastSuccessfulSyncAt: new Date().toISOString(),
          errorMessage: null
        });
      } catch (error) {
        if (
          error instanceof StaleSyncLeaseError ||
          !this.isSyncLeaseActive(lease)
        ) {
          return this.state;
        }
        if (error instanceof SyncVaultDekMismatchError) {
          // 옛 세대 push 거부 — 재시도해도 영원히 실패하므로 재판정으로 전환하고
          // 재시도 스케줄을 걸지 않는다(재잠금 후 새 암호 잠금해제가 다시 부트스트랩한다).
          await this.authService.handleVaultDekRejected();
          if (!this.isSyncLeaseActive(lease)) {
            return this.state;
          }
          this.pause(error.message);
        } else {
          this.patchState({
            status: 'error',
            pendingPush: true,
            errorMessage: error instanceof Error ? error.message : t('sync.uploadFailed')
          });
          this.scheduleRetry();
        }
      }
      return this.state;
    }).finally(() => {
      // enqueueSyncOperation이 callback 실행 전에 stale lease를 건너뛰어도 task는
      // 반드시 해제돼야 다음 push가 완료된 Promise에 영구 합류하지 않는다.
      if (this.pushTask?.generation === lease.generation) {
        this.pushTask = null;
      }
      if (this.queuedPushGeneration === lease.generation) {
        this.queuedPushGeneration = null;
      }
    });

    this.pushTask = { generation: lease.generation, promise };
    return promise;
  }

  async exportDecryptedSnapshot(): Promise<SyncPayloadV2> {
    const lease = this.captureSyncLease();
    return this.buildEncryptedSnapshot(
      true,
      this.state.awsProfilesServerSupport ?? 'unknown',
      lease,
    );
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
    // purge보다 먼저 이전 작업을 무효화한다. secret 정리 중 늦게 도착한 pull이 방금
    // 비운 저장소를 다시 채우는 일을 막는다.
    this.invalidateSyncGeneration({ resetRevision: true });
    // 로그아웃 이후에는 서버에서 다시 hydrate하므로, 동기화 대상 secret은 source와 무관하게 모두 제거한다.
    await this.purgeAllSecrets();
    this.hosts.replaceAll([]);
    this.groups.replaceAll([]);
    this.knownHosts.replaceAll([]);
    this.portForwards.replaceAll([]);
    this.dnsOverrides.replaceAll([]);
    this.snippets.replaceAll([]);
    this.tailnets.replaceAll([]);
    this.awsProfiles.replaceAll([]);
    this.settings.clearSyncedTerminalPreferences();
    this.outbox.clearAll();
    this.stateStorage.updateSyncDataOwner({
      userId: null,
      serverUrl: null
    });
    // patchState 는 병합이라 이전 계정의 lastDataChangeAt 이 남는다 — 명시적으로 지운다.
    this.patchState({ ...defaultSyncStatus(), lastDataChangeAt: null });
    try {
      await this.onPurgedSyncedCache?.();
    } catch (error) {
      // 계정 경계 bookkeeping은 이미 완료됐다. 런타임 파일 정리 실패가 로그아웃이나
      // 다음 계정 로그인을 막지 않게 하고, 다음 materialize에서 다시 정리할 수 있게 둔다.
      console.error('[sync] failed to purge account-scoped runtime artifacts', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private withAccessToken(init: RequestInit | undefined, accessToken: string): RequestInit {
    const headers = new Headers(init?.headers ?? {});
    headers.set('Authorization', `Bearer ${accessToken}`);
    // 클라 식별 헤더 — 서버의 v2 push 버전 게이트(426)가 이 클라이언트를 구버전으로
    // 오인하지 않게 한다(세션 발급에만 붙던 헤더를 /sync 에도 붙인다).
    for (const [name, value] of Object.entries(
      this.authService.getClientIdentificationHeaders(),
    )) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
    return {
      ...init,
      headers
    };
  }

  private async fetchWithAuthRetry(
    lease: SyncLease,
    url: URL,
    init: RequestInit,
    fallback: string,
  ): Promise<Response> {
    this.assertSyncLeaseActive(lease);
    let response = await fetch(
      url,
      this.withAccessToken(
        { ...init, signal: lease.signal },
        lease.accessToken,
      ),
    );
    this.assertSyncLeaseActive(lease);
    // 304 Not Modified 는 조건부 GET 의 정상 결과(변경 없음)이므로 통과시킨다.
    if (response.ok || response.status === 304) {
      return response;
    }
    if (response.status === 409) {
      throw await toConflictError(response, fallback);
    }

    const firstFailureMessage = await toApiErrorMessage(response, fallback);
    this.assertSyncLeaseActive(lease);
    if (!isLikelyAuthError(response, firstFailureMessage)) {
      throw new Error(firstFailureMessage);
    }

    const refreshed = await this.authService.refreshSession();
    this.assertSyncLeaseActive(lease);
    if (refreshed.status !== 'authenticated') {
      throw new SyncAuthenticationError(firstFailureMessage || AUTH_INVALID_ERROR_MESSAGE);
    }

    response = await fetch(
      url,
      this.withAccessToken(
        { ...init, signal: lease.signal },
        this.authService.getAccessToken(),
      ),
    );
    this.assertSyncLeaseActive(lease);
    if (!response.ok && response.status !== 304) {
      if (response.status === 409) {
        throw await toConflictError(response, fallback);
      }
      throw await toApiError(response, fallback);
    }
    return response;
  }

  // 조건부 GET. lastSyncRevision 은 여기서 절대 저장하지 않는다 — "저장된 리비전은 실제로
  // 적용한 상태만 가리킨다" 는 불변식을 지키기 위해, 저장은 apply 성공 후 호출자가 한다.
  // (fetch 시점에 저장하면 decode 실패→재잠금→새 암호 unlock 후 304 를 받아 새 스냅샷을
  // 영영 적용하지 못하는 창이 생긴다 — 모바일에서 고친 것과 동일한 버그.)
  private async fetchRemoteSnapshot(
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
    options?: { ignoreEtag?: boolean }
  ): Promise<{ payload: SyncPayloadV2 | null; etag: string | null }> {
    const headers: Record<string, string> = {};
    if (!options?.ignoreEtag && this.lastSyncRevision) {
      headers['If-None-Match'] = this.lastSyncRevision;
    }
    const response = await this.fetchWithAuthRetry(
      lease,
      new URL('/sync', lease.serverUrl),
      { headers },
      t('sync.fetchFailed'),
    );
    if (response.status === 304) {
      return { payload: null, etag: this.lastSyncRevision };
    }
    const etag = response.headers.get('etag');
    const payload = normalizeSyncPayload((await response.json()) as Partial<SyncPayloadV2>, {
      includeAwsProfiles: this.shouldSyncAwsProfiles(awsProfilesServerSupport),
    });
    this.assertSyncLeaseActive(lease);
    return { payload, etag };
  }

  /**
   * 이 계정의 데이터를 다루는 데 필요한 클라이언트 수준.
   *
   * 페이로드를 다시 복호화해 보는 대신 로컬 저장소를 본다 — 같은 값이고 훨씬 싸다. 다른 기기만
   * RDP 호스트를 가진 경우는 그 기기가 이미 올려 뒀다(서버는 max 로만 반영한다).
   */
  private resolveSyncDataFloor(): number {
    // "RDP 가 있나" 가 아니라 "옛 버전이 모르는 종류가 있나" 로 본다.
    //
    // 종류 이름을 여기 적으면 새 종류를 만들 때마다 이 함수를 기억해야 하고, 한 번 잊으면 그
    // 종류를 저장한 계정에서 1.8.10 이 흰 화면이 된다(RDP 때 겪은 그대로다). 지난 빌드가 알던
    // 목록만 고정해 두고 그 밖은 전부 하한을 올린다 — VNC 든 그다음이든 이 함수는 그대로다.
    return this.hosts
      .list()
      .some((record) => !LEGACY_TOLERATED_HOST_KINDS.has(record.kind))
      ? SYNC_DATA_FLOOR_LEGACY_INTOLERANT_KINDS
      : 0;
  }

  private async pushSnapshot(
    payload: SyncPayloadV2,
    lease: SyncLease,
  ): Promise<void> {
    this.assertSyncLeaseActive(lease);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    // 암호화에 쓴 DEK 의 세대(epoch)를 실어 보낸다 — 서버가 트랜잭션 안에서 fence 로
    // 대조해, 다른 기기의 초기화/재설정과 겹친 push 를 커밋 시점에 거부한다(409).
    if (lease.vaultEpoch !== null) {
      headers[VAULT_EPOCH_HEADER] = String(lease.vaultEpoch);
    }
    // 이 계정의 데이터를 다루는 데 필요한 클라이언트 수준을 알린다. 서버는 페이로드가 암호문이라
    // 안을 볼 수 없으므로 이 헤더로만 알 수 있고, 값을 올리기만 한다(단조).
    //
    // 이게 없으면 옛 클라이언트가 RDP 호스트를 받아 화면이 비거나 레코드를 SSH 로 고쳐 되올린다.
    // 반대로 계정 전체에 버전 하한을 걸면 RDP 를 안 쓰는 사용자까지 업데이트를 강요받는다.
    //
    // 0 이어도 보낸다. 서버는 헤더가 없으면 0 으로 보지만, 모든 클라이언트가 자기 수준을 선언하는
    // 편이 규칙이 단순하다 — "안 보낸 것" 과 "0" 을 구분할 일이 없어진다.
    headers[SYNC_DATA_FLOOR_HEADER] = String(this.resolveSyncDataFloor());
    const response = await this.fetchWithAuthRetry(
      lease,
      new URL('/sync', lease.serverUrl),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      },
      t('sync.uploadFailed'),
    );
    // push 응답의 리비전은 "직전 pull 리비전 + 1"일 때만 저장한다. 그보다 크면 내 push
    // 이전에 다른 기기의 변경이 끼어 있다는 뜻 — 그대로 저장하면 다음 폴링이 304 로 그
    // 변경들을 영영 건너뛴다. 옛 ETag 를 유지해 다음 폴링이 200 전체를 받게 한다.
    try {
      const body = (await response.json()) as { revision?: number };
      this.assertSyncLeaseActive(lease);
      if (typeof body.revision === 'number') {
        const lastPulled = parseSyncRevisionEtag(this.lastSyncRevision);
        if (lastPulled !== null && body.revision <= lastPulled + 1) {
          this.lastSyncRevision = formatSyncRevisionEtag(body.revision);
        }
      }
    } catch {
      // 구버전 서버는 본문이 없을 수 있다 — 그러면 다음 폴링이 전체를 한 번 당긴다(무해).
    }
  }

  private async buildEncryptedSnapshot(
    includeDeletions: boolean,
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<SyncPayloadV2> {
    const snapshot = await this.buildEncryptedSnapshotResult(
      includeDeletions,
      awsProfilesServerSupport,
      lease,
    );
    return snapshot.payload;
  }

  private async buildEncryptedSnapshotResult(
    includeDeletions: boolean,
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<{ payload: SyncPayloadV2; includedDeletions: SyncDeletionRecord[] }> {
    this.assertSyncLeaseActive(lease);
    const vaultKeyBase64 = lease.vaultKeyBase64;
    const groups = this.groups.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const hosts = this.hosts.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const knownHosts = this.knownHosts.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const portForwards = this.portForwards.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const dnsOverrides = this.dnsOverrides.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    const snippets = this.snippets.list().map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
    // auth key 를 포함한 페이로드를 올린다. 서버는 암호문만 보므로(E2EE) 키가 실려도 안전하다.
    const tailnets = this.tailnets
      .listPayloads()
      .map((record) => this.toSyncRecord(record.id, record.updatedAt, record, vaultKeyBase64));
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
      this.assertSyncLeaseActive(lease);
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
          snippets,
          preferences,
          awsProfiles,
          tailnets
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
        case 'snippets':
          snippets.push(record);
          break;
        case 'preferences':
          preferences.push(record);
          break;
        case 'awsProfiles':
          awsProfiles.push(record);
          break;
        case 'tailnets':
          tailnets.push(record);
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
        snippets,
        preferences,
        awsProfiles,
        tailnets
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
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<boolean> {
    this.assertSyncLeaseActive(lease);
    const vaultKeyBase64 = lease.vaultKeyBase64;
    const shouldSyncAwsProfiles = this.shouldSyncAwsProfiles(awsProfilesServerSupport);

    const groups = payload.groups
      .filter((record) => !record.deleted_at)
      .map((record) =>
        decodeEncryptedPayload<GroupRecord>(
          record.encrypted_payload,
          vaultKeyBase64
        )
      );
    // **이 빌드가 모르는 종류는 상태에 넣지 않는다.** 다른 기기의 새 버전이 만든 호스트가
    // 그대로 들어오면, 그 레코드의 없는 필드를 읽는 코드가 렌더 중에 던져 목록을 그리다 화면이
    // 통째로 빈다(1.8.10 이 RDP 호스트를 받고 그렇게 됐다). 걸러낸 레코드는 버리는 것이 아니라
    // 안 보이게 두는 것이다 — 우리가 안 올리면 서버 사본은 upsert 라서 그대로 남고, 업데이트하면
    // 다시 보인다. 억지로 정규화해 끼워 맞추면 모르는 필드를 잃은 채 되올려 원본을 망친다.
    const hosts = payload.hosts
      .filter((record) => !record.deleted_at)
      .map((record) =>
        decodeEncryptedPayload<HostRecord>(
          record.encrypted_payload,
          vaultKeyBase64
        )
      )
      .filter((record) => isKnownHostKind(record?.kind));
    const knownHosts = payload.knownHosts
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<KnownHostRecord>(record.encrypted_payload, vaultKeyBase64));
    const portForwards = payload.portForwards
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<PortForwardRuleRecord>(record.encrypted_payload, vaultKeyBase64));
    const dnsOverrides = payload.dnsOverrides
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<DnsOverrideRecord>(record.encrypted_payload, vaultKeyBase64));
    const snippets = payload.snippets
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<SnippetRecord>(record.encrypted_payload, vaultKeyBase64));
    const tailnets = payload.tailnets
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<TailnetPayload>(record.encrypted_payload, vaultKeyBase64));
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

    const nextSecretMetadata: SecretMetadataRecord[] = secrets.map(
      secretMetadataFromSyncedSecret,
    );
    const nextStoredSecrets = new Map(
      secrets.map((secret) => [
        secret.secretRef,
        encodeSecretForStorage(JSON.stringify(secret))
      ])
    );

    // updateState는 동기식 단일 커밋이다. 그 직전에 lease를 확인해 reset/setup 뒤의
    // 늦은 pull이 새 세대의 로컬 상태를 덮어쓰지 못하게 한다.
    this.assertSyncLeaseActive(lease);
    this.stateStorage.updateState((state) => {
      state.data.groups = groups;
      state.data.hosts = hosts;
      state.data.knownHosts = knownHosts;
      state.data.portForwards = portForwards;
      state.data.dnsOverrides = dnsOverrides;
      state.data.snippets = snippets;
      // 레코드와 auth key 를 한 커밋에서 같이 쓴다. 나눠 쓰면 그 사이에 ephemeral 판정이
      // hasAuthKey 를 잘못 보게 된다.
      state.data.tailnets = tailnets.map(normalizeTailnetPayloadForStorage);
      state.secure.tailnetAuthKeysById = Object.fromEntries(
        tailnets
          .filter((payload) => Boolean(payload.authKey))
          .map((payload) => [
            payload.id,
            encodeSecretForStorage(payload.authKey as string),
          ]),
      );
      if (shouldSyncAwsProfiles) {
        state.data.awsProfiles = awsProfiles.map((record) => ({
          id: record.id,
          name: record.name,
          kind: record.kind,
          updatedAt: record.updatedAt
        }));
      }
      state.terminal.globalThemeId =
        preferences[0]?.globalTerminalThemeId ?? 'system';
      state.terminal.globalThemeUpdatedAt =
        preferences[0]?.updatedAt ?? nowIso();
      state.data.secretMetadata = nextSecretMetadata;
      state.secure.managedSecretsByRef = Object.fromEntries(nextStoredSecrets);
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
    this.assertSyncLeaseActive(lease);
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

  private async fetchAwsProfilesServerSupport(
    lease: SyncLease,
  ): Promise<AwsProfilesServerSupport> {
    try {
      const response = await fetch(new URL('/api/info', lease.serverUrl), {
        signal: lease.signal,
      });
      this.assertSyncLeaseActive(lease);
      if (!response.ok) {
        // 구서버처럼 info endpoint 자체가 없거나 구현되지 않은 경우는 hard unsupported다.
        // 5xx(501 제외)와 인증/프록시 오류는 구서버로 오인하지 않고 마지막 판정을 유지한다.
        if ([404, 405, 501].includes(response.status)) {
          this.authService.noteServerVaultSupport(false);
          this.authService.noteServerWebauthnSupport(false);
          this.authService.noteServerDataFloorSupport(false);
          return 'unsupported';
        }
        return this.state.awsProfilesServerSupport ?? 'unknown';
      }
      const serverInfo = (await response.json()) as Partial<ServerInfoResponse>;
      this.assertSyncLeaseActive(lease);
      // 셀프호스팅 구버전 서버(vault capability 없음)에서는 E2EE 전환 프롬프트를 숨긴다.
      this.authService.noteServerVaultSupport(
        serverInfo.capabilities?.vault?.e2ee === true
      );
      this.authService.noteServerWebauthnSupport(
        serverInfo.capabilities?.auth?.webauthn === true
      );
      // 이 서버가 계정 데이터 수준을 저장·판정할 수 있는지. 못 하면 옛 클라이언트를 막아 줄
      // 장치가 없으므로, 화면이 그 보호가 필요한 기능을 닫는다.
      this.authService.noteServerDataFloorSupport(
        serverInfo.capabilities?.sync?.dataFloor === true
      );
      return resolveAwsProfilesServerSupport(serverInfo);
    } catch (error) {
      if (
        error instanceof StaleSyncLeaseError ||
        !this.isSyncLeaseActive(lease)
      ) {
        throw new StaleSyncLeaseError();
      }
      // 네트워크 실패는 판단 보류 — 기존 값을 유지한다.
      return this.state.awsProfilesServerSupport ?? 'unknown';
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
  | 'snippets'
  | 'preferences'
  | 'awsProfiles'
  | 'tailnets';
