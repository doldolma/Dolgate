import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
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
  SavedWorkspaceRecord,
  SnippetRecord,
  SyncPayloadV2,
  SyncPushEntry,
  SyncPushSendOutcome,
  SyncRecord,
  SyncStatus,
  SyncWatchResult,
  TailnetPayload,
  TerminalPreferencesRecord,
} from "@shared";
import {
  abortableSleep,
  formatSyncRevisionEtag,
  isKnownHostKind,
  collectGroupPaths,
  materializeImplicitHostGroups,
  isGroupWithinPath,
  normalizeGroupPath,
  normalizeSavedWorkspaceRecord,
  rebaseGroupPath,
  projectSecretMetadata,
  isVaultEpochRejectionCode,
  normalizeSyncRevisionEtag,
  parseSyncRevisionEtag,
  pushSyncRecordsInBatches,
  SYNC_DATA_FLOOR_HEADER,
  SYNC_DATA_FLOOR_LEGACY_INTOLERANT_KINDS,
  LEGACY_TOLERATED_HOST_KINDS,
  SYNC_WATCH_CLIENT_TIMEOUT_MS,
  SYNC_WATCH_FALLBACK_POLL_MS,
  VAULT_EPOCH_HEADER,
} from '@shared';
import {
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  DnsOverrideRepository,
  PortForwardRepository,
  SnippetRepository,
  SavedWorkspaceRepository,
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

// 레코드 하나가 그것만 보내도 앞단(리버스 프록시)의 본문 한도를 넘는다. 나머지는 올렸다. 그 레코드가 남아 있는
// 동안은 받기를 하지 않는다 — 받기는 서버 사본으로 로컬을 갈아 끼우므로, 받으면 그 레코드를 잃는다.
export class SyncRecordTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRecordTooLargeError';
  }
}

/** 이 기기가 아는 서버 사본의 레코드 하나 — 바뀐 것만 고르는 기준(SyncService.serverIndex). */
interface ServerRecordMark {
  /** 서버가 견주는 시각(updated_at, ms). */
  at: number;
  /** 복호화한 내용의 지문. 지운 것이거나 풀지 못했으면 null. */
  fingerprint: string | null;
  deleted: boolean;
}

/** 너무 커서 못 올린 레코드. 내용이 그대로인 동안 다시 보내지 않는다. */
interface OversizedRecord {
  fingerprint: string;
  bytes: number;
  label: string;
}

/** 올릴 수 있는 로컬 레코드 하나 — 서버에 보낼 모양 그대로의 값. */
interface PushCandidate {
  kind: SyncRecordKind;
  id: string;
  updatedAt: string;
  value: unknown;
}

/** GET /sync 의 결과. payload 가 null 이면 304(이미 적용한 리비전 그대로)다. */
interface RemoteSnapshot {
  payload: SyncPayloadV2 | null;
  etag: string | null;
}

/** 이번에 올릴 것 — 서버 사본과 다른 레코드와 지움. */
interface PushDelta {
  payload: SyncPayloadV2;
  /** 지움 대기열에서 실은 것(실은 뒤 서버가 받으면 대기열에서 지운다). */
  includedDeletions: SyncDeletionRecord[];
  /** 레코드가 들어가면 기준이 될 값(`종류\0id`). */
  marks: Map<string, ServerRecordMark>;
  /** 너무 클 때 알릴 이름(`종류\0id`). */
  labels: Map<string, string>;
  /** 너무 커서 지난번에 뺐고 그대로라 이번에도 싣지 않은 것. */
  held: OversizedRecord[];
}

function syncIndexKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

/** 키 순서와 상관없는 JSON — 같은 내용을 다른 기기(다른 키 순서)가 써도 같은 글이 된다. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined || typeof item === 'function' ? 'null' : canonicalJson(item)))
      .join(',')}]`;
  }
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || typeof item === 'function') {
      continue;
    }
    fields.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${fields.join(',')}}`;
}

/** 레코드 내용의 지문. 암호문은 올릴 때마다 달라서 견줄 수 없으므로 복호화한 내용으로 잰다. */
export function syncContentFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}

function describeByteSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

/** 너무 큰 레코드를 알리는 문구 — 첫 레코드의 이름과 크기, 더 있으면 그 수. 팀 동기화도 쓴다. */
export function describeOversized(records: ReadonlyArray<{ label: string; bytes: number }>): string {
  const [first, ...rest] = records;
  return rest.length === 0
    ? t('sync.recordTooLarge', { name: first.label, size: describeByteSize(first.bytes) })
    : t('sync.recordsTooLarge', { name: first.label, size: describeByteSize(first.bytes), count: rest.length });
}

/** 너무 클 때 알릴 이름 — 호스트·스니펫·비밀값은 label, 그룹·워크스페이스는 name. 없으면 id. 팀 동기화도 쓴다. */
export function syncRecordLabel(value: unknown, id: string): string {
  const fields = value as { label?: unknown; name?: unknown } | null;
  const label = typeof fields?.label === 'string' && fields.label.trim() ? fields.label : null;
  const name = typeof fields?.name === 'string' && fields.name.trim() ? fields.name : null;
  return label ?? name ?? id;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface GroupPathRename {
  from: string;
  to: string;
}

/**
 * pull 로 들어온 그룹 목록에서 **경로가 바뀐 것**을 골라낸다.
 *
 * 그룹 레코드는 id 가 안정적이므로 같은 id 의 path 를 대조하면 rename 매핑이 정확히 나온다 —
 * 스냅샷만 보고 추측하는 것이 아니다. 삭제(레코드가 사라진 것)는 여기서 다루지 않는다:
 * delete-subtree 였는지 reparent 였는지 스냅샷으로는 복원할 수 없고, pull 이 사용자 데이터를
 * 지우거나 말없이 옮기는 것보다 눈에 보이는 채로 두는 편이 안전하다.
 */
export function collectRenamedGroupPaths(
  previousGroups: readonly GroupRecord[],
  nextGroups: readonly GroupRecord[]
): GroupPathRename[] {
  const previousPathById = new Map(previousGroups.map((record) => [record.id, record.path]));
  const renames: GroupPathRename[] = [];
  for (const record of nextGroups) {
    const from = previousPathById.get(record.id);
    // record.path 가 비어 있으면 rename 이 아니다. 그것을 to 로 쓰면 rebaseGroupPath 가 null 로
    // 정규화해 그 하위 Workspace 를 전부 "그룹 없음" 으로 만들고, 그 손실이 push 된다. 다른
    // 곳에서는 경로 없는 그룹 레코드가 그냥 안 보일 뿐이다 — 여기서만 데이터가 사라졌다.
    if (from && record.path && from !== record.path) {
      renames.push({ from, to: record.path });
    }
  }
  // 가장 구체적인(긴) from 을 먼저 둔다 — 적용은 하나만 한다(rebaseSavedWorkspaceGroups).
  return renames.sort((left, right) => right.from.length - left.from.length);
}

/**
 * 이름이 바뀐 그룹에 소속된 저장된 Workspace 의 groupName 을 따라 옮긴다.
 *
 * 로컬에서 이름을 바꾸면 GroupRepository.applyPathMutation 이 이 일을 한다. 그런데 이름 변경이
 * **동기화로 들어오면** 그 래퍼를 지나지 않아 아무도 rebase 하지 않았고, 데스크톱 사이드바에는
 * 옛 경로를 든 유령 그룹이 워크스페이스를 안고 남았다(groups/hosts 는 서버 값으로 맞춰지는데
 * workspaces 의 groupName 만 옛 경로를 가리켰다).
 *
 * updatedAt 을 올리고, 호출부가 pendingPush 를 세워 push 를 예약한다 — 그러지 않으면 다음 pull 이
 * 옛 경로를 다시 설치하는데 그때는 rename diff 가 이미 사라져 되돌릴 방법이 없다(pull 이 로컬을
 * 고쳤으니 되올려야 한다는 점에서 AWS 프로필 이름 충돌 해소와 같은 처리다).
 */
export function rebaseSavedWorkspaceGroups(
  workspaces: readonly SavedWorkspaceRecord[],
  renames: readonly GroupPathRename[],
  survivingGroupPaths: ReadonlySet<string>,
  timestamp: string
): SavedWorkspaceRecord[] {
  return workspaces.map((workspace) => {
    const currentGroupName = normalizeGroupPath(workspace.groupName);
    if (!currentGroupName) {
      return workspace;
    }
    // **아직 있는 경로는 건드리지 않는다.** 이름을 바꾼 기기가 Workspace 도 아는 기기였다면
    // 이미 rebase 해서 올렸으므로 pull 로 온 값이 정답이다. 그 값에 rename 을 적용하면
    // 정답을 망친다 — 두 그룹이 경로를 맞바꾼 경우(a→b, b→a)나, 한 리비전에 prod→prod-2024 와
    // staging→prod 가 함께 온 경우가 그렇다(비워진 경로를 다른 그룹이 물려받는다).
    // rebase 가 필요한 것은 그 경로가 **사라진** 경우뿐이다.
    if (survivingGroupPaths.has(currentGroupName)) {
      return workspace;
    }
    // 적용은 가장 구체적인 rename 하나만 한다. 차례로 여러 번 고치면 앞 rename 이 만들어 낸
    // 값을 뒤 rename 이 또 고친다.
    const match = renames.find((rename) =>
      isGroupWithinPath(currentGroupName, rename.from)
    );
    if (!match) {
      return workspace;
    }
    const groupName = rebaseGroupPath(currentGroupName, match.from, match.to);
    return groupName === currentGroupName
      ? workspace
      : { ...workspace, groupName, updatedAt: timestamp };
  });
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

function emptySyncPayload(): SyncPayloadV2 {
  return {
    groups: [],
    hosts: [],
    secrets: [],
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    snippets: [],
    workspaces: [],
    preferences: [],
    awsProfiles: [],
    tailnets: [],
  };
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
    payload.workspaces.length +
    payload.tailnets.length +
    payload.preferences.length +
    payload.awsProfiles.length
  );
}

export function normalizeSyncPayload(
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
    workspaces: Array.isArray(payload?.workspaces) ? payload.workspaces : [],
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

// 서버(Go time.RFC3339)가 받는 시각 모양. toISOString() 이 이것을 만든다.
const SYNC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 서버가 받는 레코드인가 — id 는 빈 칸 아닌 문자열, 시각은 RFC3339. 서버는 하나라도 어긋나면 push 전체를 400 으로
 * 거절하고 앱은 같은 것을 다시 보낸다. 그러면 그 뒤의 변경이 하나도 올라가지 않는다(2026-10-23, 옛 빌드가 지움 기록의
 * id 자리에 배열을 썼다). 그래서 올리기 전에 거른다.
 */
export function isPushableSyncRecord(record: SyncRecord): boolean {
  const deletedAt = record.deleted_at;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.updated_at === 'string' &&
    SYNC_TIMESTAMP_PATTERN.test(record.updated_at) &&
    (deletedAt === undefined ||
      deletedAt === null ||
      deletedAt === '' ||
      (typeof deletedAt === 'string' && SYNC_TIMESTAMP_PATTERN.test(deletedAt)))
  );
}

/** 서버가 받지 않을 레코드를 뺀다. 지움 기록이었다면 push 가 끝난 뒤 대기열에서도 치워진다. */
function keepPushableRecords<T extends object>(payload: T): T {
  let dropped = 0;
  const kept: Record<string, SyncRecord[]> = {};
  for (const [kind, records] of Object.entries(payload as Record<string, SyncRecord[]>)) {
    const pushable = records.filter(isPushableSyncRecord);
    dropped += records.length - pushable.length;
    kept[kind] = pushable;
  }
  if (dropped > 0) {
    console.warn('[sync] dropped records the server would reject', { dropped });
  }
  return kept as T;
}

export function encodeEncryptedPayload(plaintext: string, keyBase64: string): string {
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

export function decodeEncryptedPayload<T>(payload: string, keyBase64: string): T {
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

export async function toApiErrorMessage(response: Response, fallback: string): Promise<string> {
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

export function isLikelyAuthError(response: Response, message: string): boolean {
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
  // 마지막으로 받은 서버 사본의 레코드별 시각·내용 지문(`종류\0id`) — 바뀐 것만 올리는 기준이다. 받을 때(200)마다
  // 새로 만들고, 묶음을 보낼 때마다 보낸 것으로 고친다. 리비전과 같은 "이 기기가 아는 서버 모습" 이라 같이 지운다.
  // 없으면(앱을 켠 뒤 아직 못 받았으면) 올리기 전에 한 번 받아 만든다.
  private serverIndex: Map<string, ServerRecordMark> | null = null;
  // 너무 커서 못 올린 레코드(`종류\0id`). 내용이 그대로인 동안은 다시 보내지 않는다(30초마다 1MB 를 되풀이하지 않게).
  private oversized = new Map<string, OversizedRecord>();
  // 서버가 변경 대기(GET /sync/watch)를 지원하는가. /api/info 로 알게 되고, 서버 URL 이 바뀌면
  // 다시 모르는 것으로 본다. 대기 요청이 404 등을 받으면 지원하지 않는 것으로 바꾼다.
  private watchSupport: { serverUrl: string; supported: boolean } | null = null;
  // 잠자기 복귀 때 진행 중인 대기를 끊는다 — 잠든 사이 죽은 연결을 45초 타임아웃까지 붙들고 있지
  // 않게. 끊을 때마다 새로 만든다.
  private watchInterrupt = new AbortController();
  private onAppliedSnapshot: (() => void | Promise<void>) | null = null;
  private onBootstrapFailed: (() => void) | null = null;
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
    private readonly tailnets: TailnetRepository,
    private readonly savedWorkspaces: SavedWorkspaceRepository
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
      this.serverIndex = null;
      this.oversized.clear();
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

  /**
   * 부트스트랩이 실패했을 때 부른다. 팀 동기화는 개인 pull 이 적용될 때(onAppliedSnapshot) 시작하는데, 개인 쪽이
   * 계속 실패하면 그 길이 끝내 오지 않아 팀 볼트까지 통째로 멈췄다 — main 이 이것으로 팀을 따로 띄운다.
   */
  setOnBootstrapFailed(listener: (() => void) | null): void {
    this.onBootstrapFailed = listener;
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

      // 올릴 것이 있으면 받기 전에 올린다. 받기는 서버 사본으로 로컬을 통째로 갈아 끼우므로, 못 올린 변경이
      // 있는 채 받으면 그 변경이 사라진다. 기준(서버 사본의 레코드별 모습)이 없으면 먼저 받아 만든다 — 그 받은
      // 것은 올린 것이 없을 때만 그대로 적용한다(받기를 두 번 하지 않는다). 올렸으면 서버가 바뀌었으니 다시 받는다.
      let inHand: RemoteSnapshot | null = null;
      if (hadPendingLocalChanges || shouldBackfillAwsProfiles) {
        inHand = await this.ensureServerIndex(awsProfilesServerSupport, lease);
        if (await this.pushLocalChanges(awsProfilesServerSupport, lease)) {
          inHand = null;
        }
      }

      let remote = inHand ?? (await this.fetchRemoteSnapshot(awsProfilesServerSupport, lease));
      this.assertSyncLeaseActive(lease);
      // remote 가 비어 있으면(신규/서버 유실) 로컬을 다시 올려 복구한다. 서버 사본이 비었으니 전부 고른다.
      if (remote.payload !== null && totalRecordCount(remote.payload) === 0) {
        this.serverIndex = new Map();
        if (await this.pushLocalChanges(awsProfilesServerSupport, lease)) {
          remote = await this.fetchRemoteSnapshot(awsProfilesServerSupport, lease);
          this.assertSyncLeaseActive(lease);
        }
      }

      // payload === null 은 304(마지막 동기화 이후 서버 변경 없음) — 적용을 건너뛴다.
      const applied = remote.payload !== null;
      // pull 이 로컬 데이터를 고쳤는가(AWS 프로필 이름 충돌 해소, 그룹 rename 에 따른 Workspace
      // 경로 이동). 고쳤으면 그 결과를 서버로 되올려야 한다.
      const pullChangedLocalData = applied
        ? await this.applyRemoteSnapshotAtomically(
            remote.payload as SyncPayloadV2,
            awsProfilesServerSupport,
            lease,
          )
        : false;
      this.assertSyncLeaseActive(lease);
      // "저장된 리비전 = 실제로 적용한 상태" 불변식: apply 가 성공한 지금에서야 ETag 를
      // 저장한다(decode 실패 시 저장되지 않아, 재잠금 후 unlock 이 304 에 갇히지 않는다).
      // 기준도 같다 — 적용한 서버 사본이 다음 올리기의 기준이다.
      if (applied) {
        this.serverIndex = this.buildServerIndex(remote.payload as SyncPayloadV2, lease.vaultKeyBase64);
        if (remote.etag) {
          this.lastSyncRevision = remote.etag;
        }
      }
      // 지움 대기열은 올린 것만 비운다(pushLocalChanges). 받는 사이에 새로 지운 것은 남겨 다음 올리기에 보낸다.
      this.patchState({
        status: 'ready',
        lastSuccessfulSyncAt: new Date().toISOString(),
        // 실제 적용(200)일 때만 데이터 변경 시각을 갱신 — 304 는 그대로 둬서 렌더러
        // 폴링이 불필요한 워크스페이스 재조회를 건너뛰게 한다.
        lastDataChangeAt: applied
          ? new Date().toISOString()
          : this.state.lastDataChangeAt ?? null,
        pendingPush: pullChangedLocalData,
        errorMessage: null
      });
      if (pullChangedLocalData) {
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
      this.onBootstrapFailed?.();
      throw error;
    }

    return this.state;
  }

  /**
   * 다른 기기의 변경을 기다린다 — 렌더러의 대기 루프(startSyncWatchLoop)가 부른다.
   *
   * 동기화 큐(enqueueSyncOperation) **밖**에서 돈다. 큐 안에서 25초를 기다리면 그동안 로컬 편집의
   * 업로드(pushDirty)가 그 뒤에 막힌다. 여기서는 "바뀌었다" 만 알아내고, 당기는 것은 렌더러가
   * 지금처럼 bootstrap 으로 한다.
   *
   * 서버가 대기를 모르거나(옛 자체 호스팅) 그 여부를 아직 모르면 30초 기다렸다 'changed' 를
   * 돌려준다. 렌더러가 그대로 당기므로 예전 30초 폴링과 같다.
   */
  async watchForChanges(): Promise<SyncWatchResult> {
    const interrupt = this.watchInterrupt.signal;
    const lease = this.captureSyncLease();
    const cancel = AbortSignal.any([lease.signal, interrupt]);
    if (!this.canWatchForChanges()) {
      // 지금은 당길 수 없다(로그아웃·잠김·오프라인 등). 요청 없이 쉬었다가 다시 묻게 한다.
      return this.waitWithoutServer(cancel, 'unchanged');
    }
    if (!(await this.resolveWatchSupport(lease))) {
      return this.waitWithoutServer(cancel, 'changed');
    }

    const known = this.lastSyncRevision;
    // 서버가 이 기능을 모른다는 답 — /api/info 판정과 같은 코드들.
    const unsupported = (status: number) => [404, 405, 501].includes(status);
    let response: Response;
    try {
      response = await this.fetchWithAuthRetry(
        lease,
        new URL('/sync/watch', lease.serverUrl),
        {
          headers: known ? { 'If-None-Match': known } : {},
          // 서버는 20~30초 안에 답한다. 그보다 한참 늦으면 연결이 조용히 죽은 것이다.
          signal: AbortSignal.any([cancel, AbortSignal.timeout(SYNC_WATCH_CLIENT_TIMEOUT_MS)]),
        },
        t('sync.fetchFailed'),
        unsupported,
      );
    } catch (error) {
      if (interrupt.aborted || !this.isSyncLeaseActive(lease)) {
        // 잠자기 복귀로 끊었거나 계정·볼트가 바뀌었다 — 바뀐 상태로 바로 다시 붙는다.
        return { outcome: 'unchanged', live: true };
      }
      throw error;
    }
    if (response.status === 304) {
      return { outcome: 'unchanged', live: true };
    }
    if (unsupported(response.status)) {
      // 서버가 대기를 모른다 — 옛 버전으로 되돌려졌다. 일시 오류로 보고 재시도만 하면 그동안
      // 아무것도 당기지 않는다. 옛 서버처럼 30초 폴링으로 물러선다. 당길 때 /api/info 를 다시
      // 읽으므로 dataFloor 같은 다른 기능 정보도 갱신되고, 서버가 다시 올라오면 롱폴링으로 돌아온다.
      this.watchSupport = { serverUrl: lease.serverUrl, supported: false };
      await response.body?.cancel();
      return this.waitWithoutServer(cancel, 'changed');
    }
    const etag = normalizeSyncRevisionEtag(response.headers.get('etag'));
    await response.body?.cancel();
    // 이미 그 리비전을 적용했다면(자기 push 의 메아리) 당길 것이 없다.
    return {
      outcome: etag !== null && etag === this.lastSyncRevision ? 'unchanged' : 'changed',
      live: true,
    };
  }

  /** 진행 중인 변경 대기를 끊는다 — 잠자기 복귀 때. 대기 루프는 바로 다시 붙는다. */
  interruptWatch(): void {
    this.watchInterrupt.abort();
    this.watchInterrupt = new AbortController();
  }

  private canWatchForChanges(): boolean {
    return (
      !isE2ESyncDisabled() &&
      this.authService.getState().status === 'authenticated' &&
      this.authService.isVaultReadyForSync()
    );
  }

  private async resolveWatchSupport(lease: SyncLease): Promise<boolean> {
    if (this.watchSupport?.serverUrl !== lease.serverUrl) {
      // /api/info 를 읽으면서 대기 지원 여부도 적어 둔다. 못 읽으면 모르는 채로 둔다(폴링으로 물러선다).
      await this.fetchAwsProfilesServerSupport(lease).catch(() => undefined);
    }
    return (
      this.watchSupport?.serverUrl === lease.serverUrl && this.watchSupport.supported
    );
  }

  private async waitWithoutServer(
    signal: AbortSignal,
    outcome: SyncWatchResult['outcome'],
  ): Promise<SyncWatchResult> {
    try {
      await abortableSleep(SYNC_WATCH_FALLBACK_POLL_MS, signal);
    } catch {
      // 잠자기 복귀·계정 변경이 깨웠다. 폴링 쪽이면 이때 바로 당기는 편이 낫다.
    }
    return { outcome, live: false };
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

    // 계정이 없으면 밀 곳이 없다.
    //
    // **표시는 남긴다.** 나중에 로그인할 때 이 플래그가 흡수를 일으킨다(runBootstrap 이
    // `hasPendingLocalChanges` 면 밀기를 먼저 한다). 옛 버전으로 되돌려도 이 값은 디스크에서
    // 그대로 읽히므로 거기서 로그인해도 로컬이 서버 것으로 덮이지 않는다.
    //
    // **여기서 멈춘다.** 계속 가면 볼트가 없다고 'paused' 가 되어, 신경 쓸 것이 없는 사람의
    // 화면에 동기화 상태가 뜬다.
    if (this.authService.getState().status === 'local-only') {
      return this.state;
    }

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
          const awsProfilesServerSupport = this.state.awsProfilesServerSupport ?? 'unknown';
          // 서버 사본과 다른 것만 올린다. 팀 편집처럼 개인 쪽이 그대로면 아무것도 보내지 않는다.
          await this.ensureServerIndex(awsProfilesServerSupport, lease);
          await this.pushLocalChanges(awsProfilesServerSupport, lease);
          this.assertSyncLeaseActive(lease);
          shouldContinuePush =
            this.queuedPushGeneration === lease.generation ||
            this.listSyncableDeletions(awsProfilesServerSupport).length > 0;
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
          // 너무 큰 레코드는 그대로인 동안 다시 해도 같다 — 고치면 그 편집이 올리기를 다시 부른다.
          if (!(error instanceof SyncRecordTooLargeError)) {
            this.scheduleRetry();
          }
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
    this.savedWorkspaces.replaceAll([]);
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
    // 오류로 던지지 않고 그대로 돌려받을 상태 — 호출자가 그 상태로 판정해야 할 때만 준다.
    passthrough?: (status: number) => boolean,
  ): Promise<Response> {
    this.assertSyncLeaseActive(lease);
    let response = await fetch(
      url,
      this.withAccessToken(
        // 호출자가 신호를 주면(변경 대기의 타임아웃) 그것을 쓴다 — 그 신호도 lease.signal 을 묶어 둔다.
        { ...init, signal: init.signal ?? lease.signal },
        lease.accessToken,
      ),
    );
    this.assertSyncLeaseActive(lease);
    // 304 Not Modified 는 조건부 GET 의 정상 결과(변경 없음)이므로 통과시킨다.
    if (response.ok || response.status === 304 || passthrough?.(response.status)) {
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
        { ...init, signal: init.signal ?? lease.signal },
        this.authService.getAccessToken(),
      ),
    );
    this.assertSyncLeaseActive(lease);
    if (!response.ok && response.status !== 304 && !passthrough?.(response.status)) {
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
    const etag = normalizeSyncRevisionEtag(response.headers.get('etag'));
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

  /** 묶음 하나를 올린다. 앞단이 본문이 크다고 거절하면(413) "too-large" — 나누기 도우미가 더 작게 나눈다. */
  private async pushSnapshot(
    payload: Partial<SyncPayloadV2>,
    lease: SyncLease,
  ): Promise<SyncPushSendOutcome> {
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
    //
    // 묶음마다 싣는다 — 첫 묶음이 하한을 올린 뒤에 새 종류가 들어간다(하한은 계정 전체 호스트로 잰다).
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
      (status) => status === 413,
    );
    if (response.status === 413) {
      await response.body?.cancel();
      return 'too-large';
    }
    // push 응답의 리비전은 "직전 pull 리비전 + 1"일 때만 저장한다. 그보다 크면 내 push
    // 이전에 다른 기기의 변경이 끼어 있다는 뜻 — 그대로 저장하면 다음 폴링이 304 로 그
    // 변경들을 영영 건너뛴다. 옛 ETag 를 유지해 다음 폴링이 200 전체를 받게 한다.
    // 묶음으로 나눠 보내면 묶음마다 리비전이 하나씩 오른다 — 묶음마다 이렇게 이어 받으면 사이에 다른 기기가
    // 끼지 않은 한 마지막 묶음의 리비전까지 따라간다.
    try {
      const body = (await response.json()) as { revision?: number };
      this.assertSyncLeaseActive(lease);
      if (typeof body.revision === 'number') {
        const lastPulled = parseSyncRevisionEtag(this.lastSyncRevision);
        if (lastPulled !== null && body.revision <= lastPulled + 1) {
          this.lastSyncRevision = formatSyncRevisionEtag(body.revision);
        }
      }
    } catch (error) {
      if (error instanceof StaleSyncLeaseError) {
        throw error;
      }
      // 구버전 서버는 본문이 없을 수 있다 — 그러면 다음 폴링이 전체를 한 번 당긴다(무해).
    }
    return 'sent';
  }

  /**
   * 기준(서버 사본의 레코드별 모습)이 없으면 서버 사본을 한 번 받아 만든다. 받은 것은 적용하지 않는다 — 올릴 것이
   * 있는 채 적용하면 그 변경이 사라진다. 받았으면 그 사본을 돌려준다(올릴 것이 없으면 부른 쪽이 그대로 적용한다).
   */
  private async ensureServerIndex(
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<RemoteSnapshot | null> {
    if (this.serverIndex) {
      return null;
    }
    const remote = await this.fetchRemoteSnapshot(awsProfilesServerSupport, lease, { ignoreEtag: true });
    this.assertSyncLeaseActive(lease);
    this.serverIndex = this.buildServerIndex(remote.payload as SyncPayloadV2, lease.vaultKeyBase64);
    return remote;
  }

  /**
   * 서버 사본의 레코드마다 시각과 내용 지문. 내용은 복호화해 잰다 — 암호문은 올릴 때마다 달라 견줄 수 없다.
   * 풀지 못한 레코드는 지문 없이 둔다(그 레코드는 같은 시각이어도 로컬 것을 다시 올린다).
   */
  private buildServerIndex(payload: SyncPayloadV2, vaultKeyBase64: string): Map<string, ServerRecordMark> {
    const index = new Map<string, ServerRecordMark>();
    for (const [kind, records] of Object.entries(payload) as Array<[string, SyncRecord[] | undefined]>) {
      for (const record of records ?? []) {
        const deleted = Boolean(record.deleted_at);
        let fingerprint: string | null = null;
        if (!deleted) {
          try {
            fingerprint = syncContentFingerprint(decodeEncryptedPayload<unknown>(record.encrypted_payload, vaultKeyBase64));
          } catch {
            fingerprint = null;
          }
        }
        index.set(syncIndexKey(kind, record.id), { at: Date.parse(record.updated_at), fingerprint, deleted });
      }
    }
    return index;
  }

  /**
   * 서버 사본과 다른 로컬 레코드와 지움을 묶음으로 나눠 올린다. 올린 묶음이 있으면 true.
   *
   * 고르는 규칙(buildPushDelta): 서버에 없거나, 서버 것보다 시각이 늦거나, 시각은 같은데 내용이 다른 레코드.
   * 마지막 것은 안전망이다 — 시각을 일부러 안 올리고 내용만 채우는 곳(HostRepository.fillRdpAwsSsmProfileId)이 있다.
   *
   * 레코드 하나가 그것만으로 앞단 한도를 넘으면 나머지를 다 올린 뒤 SyncRecordTooLargeError 를 던진다.
   */
  private async pushLocalChanges(
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<boolean> {
    const delta = await this.buildPushDelta(awsProfilesServerSupport, lease);
    this.assertSyncLeaseActive(lease);
    const result =
      totalRecordCount(delta.payload) > 0
        ? await pushSyncRecordsInBatches(delta.payload as unknown as Record<string, SyncRecord[]>, {
            serverKey: lease.serverUrl,
            send: (batch) => this.pushSnapshot(batch as Partial<SyncPayloadV2>, lease),
            onSent: (entries: SyncPushEntry[]) => {
              this.assertSyncLeaseActive(lease);
              for (const entry of entries) {
                const key = syncIndexKey(entry.kind, entry.record.id);
                const mark = delta.marks.get(key);
                if (mark) {
                  this.serverIndex?.set(key, mark);
                }
              }
            },
          })
        : { batches: 0, tooLarge: [] };
    this.assertSyncLeaseActive(lease);
    // 실은 지움은 다 들어갔다(못 들어갔으면 위에서 던졌다). 서버가 받지 않을 모양이라 뺀 지움도 같이 치운다.
    this.outbox.clearMany(delta.includedDeletions);
    const tooLarge: OversizedRecord[] = [];
    for (const entry of result.tooLarge) {
      const key = syncIndexKey(entry.kind, entry.record.id);
      const fingerprint = delta.marks.get(key)?.fingerprint;
      if (!fingerprint) {
        continue;
      }
      const record = { fingerprint, bytes: entry.bytes, label: delta.labels.get(key) ?? entry.record.id };
      this.oversized.set(key, record);
      tooLarge.push(record);
    }
    const left = [...tooLarge, ...delta.held];
    if (left.length > 0) {
      throw new SyncRecordTooLargeError(describeOversized(left));
    }
    return result.batches > 0;
  }

  /** 서버 사본(serverIndex)과 다른 로컬 레코드를 골라 암호화한다. 지움은 대기열에서 모두 싣는다. */
  private async buildPushDelta(
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<PushDelta> {
    const candidates = await this.collectPushCandidates(awsProfilesServerSupport, lease);
    const index = this.serverIndex ?? new Map<string, ServerRecordMark>();
    const payload = emptySyncPayload();
    const marks = new Map<string, ServerRecordMark>();
    const labels = new Map<string, string>();
    const held: OversizedRecord[] = [];
    for (const candidate of candidates) {
      const key = syncIndexKey(candidate.kind, candidate.id);
      const fingerprint = syncContentFingerprint(candidate.value);
      const oversized = this.oversized.get(key);
      if (oversized) {
        if (oversized.fingerprint === fingerprint) {
          held.push(oversized);
          continue;
        }
        // 고쳤다 — 다시 골라 본다.
        this.oversized.delete(key);
      }
      const at = Date.parse(candidate.updatedAt);
      const known = index.get(key);
      const changed =
        !known ||
        at > known.at ||
        (!known.deleted && at === known.at && known.fingerprint !== fingerprint);
      if (!changed) {
        continue;
      }
      payload[candidate.kind].push(
        this.toSyncRecord(candidate.id, candidate.updatedAt, candidate.value, lease.vaultKeyBase64),
      );
      marks.set(key, { at, fingerprint, deleted: false });
      labels.set(key, syncRecordLabel(candidate.value, candidate.id));
    }
    const includedDeletions = this.listSyncableDeletions(awsProfilesServerSupport);
    for (const tombstone of includedDeletions) {
      payload[tombstone.kind].push({
        id: tombstone.recordId,
        encrypted_payload: '',
        updated_at: tombstone.deletedAt,
        deleted_at: tombstone.deletedAt,
      });
      marks.set(syncIndexKey(tombstone.kind, tombstone.recordId), {
        at: Date.parse(tombstone.deletedAt),
        fingerprint: null,
        deleted: true,
      });
    }
    return { payload: keepPushableRecords(payload), includedDeletions, marks, labels, held };
  }

  /**
   * 서버에 올리는 모양 그대로의 로컬 레코드 — 종류·id·시각·값(암호화 전). 올리기와 내보내기가 함께 쓴다.
   * AWS 프로필은 서버가 모르면 뺀다.
   */
  private async collectPushCandidates(
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<PushCandidate[]> {
    this.assertSyncLeaseActive(lease);
    // 구버전 기기도 pull 이후에는 실제 Group ID로 이름을 바꿀 수 있도록,
    // Host만으로 존재하던 경로를 push 전에 영속화한다.
    const data = this.stateStorage.getState().data;
    const materializedGroups = materializeImplicitHostGroups(data.groups, data.hosts);
    if (materializedGroups.length !== data.groups.length) {
      this.stateStorage.updateState((state) => {
        state.data.groups = materializedGroups;
      });
    }
    const candidates: PushCandidate[] = [];
    const add = (kind: SyncRecordKind, id: string, updatedAt: string, value: unknown) => {
      candidates.push({ kind, id, updatedAt, value });
    };
    for (const record of this.groups.list()) add('groups', record.id, record.updatedAt, record);
    for (const record of this.hosts.list()) add('hosts', record.id, record.updatedAt, record);
    for (const record of this.knownHosts.list()) add('knownHosts', record.id, record.updatedAt, record);
    for (const record of this.portForwards.list()) add('portForwards', record.id, record.updatedAt, record);
    for (const record of this.dnsOverrides.list()) add('dnsOverrides', record.id, record.updatedAt, record);
    for (const record of this.snippets.list()) add('snippets', record.id, record.updatedAt, record);
    // 연 시각은 기기마다 다르다 — 올리지 않는다.
    for (const record of this.savedWorkspaces.list()) {
      add('workspaces', record.id, record.updatedAt, { ...record, lastOpenedAt: null });
    }
    // auth key 를 포함한 페이로드를 올린다. 서버는 암호문만 보므로(E2EE) 키가 실려도 안전하다.
    for (const record of this.tailnets.listPayloads()) add('tailnets', record.id, record.updatedAt, record);
    const preferences = this.settings.getSyncedTerminalPreferences();
    add('preferences', preferences.id, preferences.updatedAt, preferences);
    if (this.shouldSyncAwsProfiles(awsProfilesServerSupport)) {
      for (const record of this.awsProfiles.listPayloads()) add('awsProfiles', record.id, record.updatedAt, record);
    }
    for (const entry of this.secretMetadata.list()) {
      const secret = await loadManagedSecret(this.secretStore, entry.secretRef);
      this.assertSyncLeaseActive(lease);
      if (!secret) {
        continue;
      }
      add('secrets', entry.secretRef, secret.updatedAt, secret);
    }
    return candidates;
  }

  /** 로컬 전체를 서버에 올리는 모양으로(지움 포함) — 내보내기용. 올리기는 buildPushDelta 로 바뀐 것만 보낸다. */
  private async buildEncryptedSnapshot(
    awsProfilesServerSupport: AwsProfilesServerSupport,
    lease: SyncLease,
  ): Promise<SyncPayloadV2> {
    const candidates = await this.collectPushCandidates(awsProfilesServerSupport, lease);
    const payload = emptySyncPayload();
    for (const candidate of candidates) {
      payload[candidate.kind].push(
        this.toSyncRecord(candidate.id, candidate.updatedAt, candidate.value, lease.vaultKeyBase64),
      );
    }
    for (const tombstone of this.listSyncableDeletions(awsProfilesServerSupport)) {
      payload[tombstone.kind].push({
        id: tombstone.recordId,
        encrypted_payload: '',
        updated_at: tombstone.deletedAt,
        deleted_at: tombstone.deletedAt,
      });
    }
    return keepPushableRecords(payload);
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
    const workspaces = payload.workspaces
      .filter((record) => !record.deleted_at)
      .map((record) => decodeEncryptedPayload<SavedWorkspaceRecord>(record.encrypted_payload, vaultKeyBase64))
      .map(normalizeSavedWorkspaceRecord)
      .filter((record): record is SavedWorkspaceRecord => record !== null);
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

    // pull 이 로컬 데이터를 고쳤으면(그룹 rename 을 따라 Workspace 경로를 옮겼으면) 그것을
    // 서버로 되올려야 한다 — 아래 updateState 안에서 세운다.
    let rebasedWorkspaceGroups = false;

    // updateState는 동기식 단일 커밋이다. 그 직전에 lease를 확인해 reset/setup 뒤의
    // 늦은 pull이 새 세대의 로컬 상태를 덮어쓰지 못하게 한다.
    this.assertSyncLeaseActive(lease);
    this.stateStorage.updateState((state) => {
      // groups 를 덮기 전에 경로 rename 을 구한다(collectRenamedGroupPaths 주석 참고).
      const renamedGroupPaths = collectRenamedGroupPaths(
        materializeImplicitHostGroups(state.data.groups, state.data.hosts),
        groups,
      );
      state.data.groups = groups;
      state.data.hosts = hosts;
      state.data.knownHosts = knownHosts;
      state.data.portForwards = portForwards;
      state.data.dnsOverrides = dnsOverrides;
      state.data.snippets = snippets;
      const nextSavedWorkspaces =
        renamedGroupPaths.length > 0
          ? rebaseSavedWorkspaceGroups(
              workspaces,
              renamedGroupPaths,
              new Set(collectGroupPaths(groups, hosts)),
              nowIso()
            )
          : workspaces;
      rebasedWorkspaceGroups = nextSavedWorkspaces.some(
        (record, index) => record !== workspaces[index]
      );
      const localOpenedAt = new Map(state.data.savedWorkspaces.map((record) => [record.id, record.lastOpenedAt]));
      state.data.savedWorkspaces = nextSavedWorkspaces.map((record) => ({
        ...record,
        lastOpenedAt: localOpenedAt.get(record.id) ?? null,
      }));
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
    // 둘 다 "pull 이 로컬을 고쳤으니 되올려야 한다" 는 같은 뜻이라 한 신호로 합친다.
    return hadAwsProfileConflicts || rebasedWorkspaceGroups;
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
          this.watchSupport = { serverUrl: lease.serverUrl, supported: false };
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
      this.watchSupport = {
        serverUrl: lease.serverUrl,
        supported: serverInfo.capabilities?.sync?.watch === true,
      };
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
  | 'workspaces'
  | 'preferences'
  | 'awsProfiles'
  | 'tailnets';
