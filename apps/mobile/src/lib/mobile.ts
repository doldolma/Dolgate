import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import * as Keychain from 'react-native-keychain';
import { Platform } from 'react-native';
import type {
  AccountPasswordState,
  AuthSession,
  AuthState,
  AwsSsoMobileLoginHandoffRequest,
  AwsSsoMobileHandoffResponse,
  AwsSsoMobileLoginStartRequest,
  AwsSsoMobileLoginStartResponse,
  AwsEc2HostRecord,
  ManagedAwsProfilePayload,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  ManagedSecretPayload,
  SecretMetadataRecord,
  SnippetRecord,
  SshHostRecord,
  SyncPayloadV2,
  SyncPushEntry,
  SyncRecord,
  SyncStatus,
  TailnetPayload,
  TeamHostCredentials,
  ServerInfoResponse,
  VaultKdfDescriptor,
  VaultCacheRecord,
  VaultCacheOwner,
} from '@dolssh/shared-core';
import {
  formatSyncRevisionEtag,
  isAwsEc2HostRecord,
  isRdpHostRecord,
  isSshHostRecord,
  isVncHostRecord,
  LEGACY_TOLERATED_HOST_KINDS,
  normalizeServerUrl,
  normalizeSyncRevisionEtag,
  parseVaultCacheRecord,
  projectSecretMetadata,
  pushSyncRecordsInBatches,
  SYNC_DATA_FLOOR_HEADER,
  SYNC_DATA_FLOOR_LEGACY_INTOLERANT_KINDS,
  SYNC_WATCH_CLIENT_TIMEOUT_MS,
  VAULT_EPOCH_HEADER,
  type HostSecretInput,
  type MobileSettings,
} from '@dolssh/shared-core';
import { fromByteArray, toByteArray } from 'base64-js';
import { APP_VERSION } from './app-metadata';
import { getServerUrlValidationMessage } from '../i18n/shared-messages';
import { getAppLocale, t } from '../i18n';

export const DEFAULT_SERVER_URL = 'https://ssh.doldolma.com';
export const AUTH_REDIRECT_URI = 'dolgate://auth/callback';
export const AUTH_CLIENT_ID = 'dolgate-mobile';
export const AWS_SSO_APP_CALLBACK_URI = 'dolgate://aws-sso/callback';
// 스토어 메타데이터에 등록한 것과 같은 처리방침 문서. App Store 심사 가이드라인 5.1.1(i)
// 은 스토어 필드와 **앱 안** 양쪽에서 접근 가능해야 한다고 요구한다.
export const PRIVACY_POLICY_URL =
  'https://github.com/doldolma/dolgate/blob/main/PRIVACY.md';

const AUTH_SESSION_SERVICE = 'dolgate.mobile.auth-session';
const MANAGED_SECRETS_SERVICE = 'dolgate.mobile.managed-secrets';
const TEAM_SECRETS_SERVICE = 'dolgate.mobile.team-secrets';
const MANAGED_AWS_PROFILES_SERVICE = 'dolgate.mobile.managed-aws-profiles';
const MANAGED_TAILNETS_SERVICE = 'dolgate.mobile.managed-tailnets';
const AWS_SSO_TOKENS_SERVICE = 'dolgate.mobile.aws-sso-tokens';
const CLIENT_INSTALLATION_ID_SERVICE = 'dolgate.mobile.client-installation-id';
// E2EE 볼트(v2)의 잠금해제된 DEK. 동기화 암호 입력 후 캐시해 재입력을 없앤다.
const VAULT_DEK_SERVICE = 'dolgate.mobile.vault-dek';
// 완전한 v2 cache record. 기존 서비스는 구버전 앱 downgrade 호환을 위해 계속 이중 기록한다.
const VAULT_CACHE_V2_SERVICE = 'dolgate.mobile.vault-cache-v2';
// 키체인 username 필드에 DEK 세대(epoch)를 함께 넣을 때 쓰는 접두사.
// DEK 와 epoch 이 한 엔트리로 원자적으로 저장돼 둘이 어긋날 수 없다.
// 이전 포맷('dolgate' 초기, 'dekid:*' dekId 시절)은 epoch 없음(null)으로 읽는다 —
// verifier 가 정체성을 증명하므로 epoch 부재는 순서 비교 불가일 뿐 위험하지 않다.
const VAULT_EPOCH_USERNAME_PREFIX = 'epoch:';
export const VAULT_MUTATION_TIMEOUT_MS = 30_000;
// 모듈 로드 시점에는 i18n 초기화 전이고 언어를 바꿔도 갱신되지 않으므로 호출 시점에 번역한다.
export function getVaultMutationTimeoutMessage(): string {
  return t('mobileLib.vaultRequestTimeout');
}
export const ACCOUNT_PASSWORD_REQUEST_TIMEOUT_MS = 10_000;
export function getAccountPasswordRequestTimeoutMessage(): string {
  return t('mobileLib.passwordChangeTimeout');
}

const CLIENT_HEADER_NAME = 'X-Dolgate-Client';
const CLIENT_VERSION_HEADER_NAME = 'X-Dolgate-Client-Version';
const CLIENT_PLATFORM_HEADER_NAME = 'X-Dolgate-Platform';
const CLIENT_INSTALLATION_ID_HEADER_NAME = 'X-Dolgate-Client-Installation-Id';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    // 서버가 오류 종류 구분용으로 주는 code (예: vault_dek_mismatch).
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface SyncEnvelope {
  v: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface FetchRequestOptions {
  timeoutMs?: number;
  timeoutMessage?: string;
}

type ManagedSecretsMap = Record<string, LoadedManagedSecretPayload>;

export interface StoredAwsSsoTokenRecord {
  profileId: string;
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
}

export interface MobileServerPublicKeyInfo {
  host: string;
  port: number;
  remoteIp?: string;
  algorithm: string;
  fingerprintSha256: string;
  keyBase64: string;
}

export function createDefaultMobileSettings(): MobileSettings {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    theme: 'system',
    language: 'system',
    terminalAutocompleteEnabled: true,
    subshellReinjectPatterns: [],
  };
}

export function createDefaultSyncStatus(): SyncStatus {
  return {
    status: 'idle',
    pendingPush: false,
    lastSuccessfulSyncAt: null,
    errorMessage: null,
    awsProfilesServerSupport: 'unknown',
    awsSsmServerSupport: 'unknown',
    awsSftpServerSupport: 'unknown',
    vaultE2eeServerSupport: 'unknown',
    dataFloorServerSupport: 'unknown',
  };
}

export function createUnauthenticatedState(): AuthState {
  return {
    status: 'unauthenticated',
    session: null,
    offline: null,
    errorMessage: null,
  };
}

export function buildBrowserLoginUrl(serverUrl: string, state: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const loginUrl = new URL('/login', normalized);
  loginUrl.searchParams.set('client', AUTH_CLIENT_ID);
  loginUrl.searchParams.set('redirect_uri', AUTH_REDIRECT_URI);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('platform', resolveMobileClientPlatform());
  // 로그인 페이지가 앱과 같은 언어로 뜨게 한다. 서버는 이 값이 없으면 브라우저 언어
  // (Accept-Language)를 따른다.
  loginUrl.searchParams.set('lang', getAppLocale());
  return loginUrl.toString();
}

export function buildAwsSsoRedirectUri(serverUrl: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const callbackUrl = new URL('/auth/aws-sso/callback', normalized);
  return callbackUrl.toString();
}

export async function startAwsSsoBrowserLogin(
  serverUrl: string,
  accessToken: string,
  payload: AwsSsoMobileLoginStartRequest,
): Promise<AwsSsoMobileLoginStartResponse> {
  return fetchJson<AwsSsoMobileLoginStartResponse>(
    new URL(
      '/api/aws-sso/mobile/start',
      normalizeServerUrl(serverUrl),
    ).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function fetchAwsSsoLoginHandoff(
  serverUrl: string,
  accessToken: string,
  loginId: string,
): Promise<AwsSsoMobileHandoffResponse> {
  return fetchJson<AwsSsoMobileHandoffResponse>(
    new URL(
      `/api/aws-sso/mobile/handoff/${encodeURIComponent(loginId)}`,
      normalizeServerUrl(serverUrl),
    ).toString(),
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function completeAwsSsoLoginHandoff(
  serverUrl: string,
  accessToken: string,
  loginId: string,
  payload: AwsSsoMobileLoginHandoffRequest,
): Promise<AwsSsoMobileHandoffResponse> {
  return fetchJson<AwsSsoMobileHandoffResponse>(
    new URL(
      `/api/aws-sso/mobile/handoff/${encodeURIComponent(loginId)}`,
      normalizeServerUrl(serverUrl),
    ).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
}

export async function cancelAwsSsoBrowserLogin(
  serverUrl: string,
  accessToken: string,
  loginId: string,
): Promise<void> {
  await fetchEmpty(
    new URL(
      '/api/aws-sso/mobile/cancel',
      normalizeServerUrl(serverUrl),
    ).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ loginId }),
    },
  );
}

export function buildEmptySyncPayload(): SyncPayloadV2 {
  return {
    groups: [],
    hosts: [],
    secrets: [],
    knownHosts: [],
    portForwards: [],
    dnsOverrides: [],
    // 부분 push에서 빈 배열은 "이 kind 에 변경 없음"이다. Tailnet 설정은 데스크톱에서
    // 관리하고 모바일은 pull해서 사용하므로, 일반 모바일 mutation에는 담지 않는다.
    tailnets: [],
    preferences: [],
    awsProfiles: [],
    snippets: [],
    workspaces: [],
  };
}

export function createRandomStateToken(): string {
  return `state-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createInstallationId(): string {
  return createRandomUuid();
}

/** 표준형 UUID(v4). 서버가 id 로 표준형만 받는 곳(팀 기록 등)에 쓴다. */
export function createRandomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function resolveMobileClientPlatform(): string {
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    return Platform.OS;
  }
  return 'unknown';
}

export function formatRelativeTime(input: string | null | undefined): string {
  if (!input) {
    return t('mobileLib.justNow');
  }

  const value = new Date(input).getTime();
  if (Number.isNaN(value)) {
    return t('mobileLib.justNow');
  }

  const diffMs = Date.now() - value;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes <= 0) {
    return t('mobileLib.justNow');
  }
  if (diffMinutes < 60) {
    return t('mobileLib.minutesAgo', { minutes: diffMinutes });
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return t('mobileLib.hoursAgo', { hours: diffHours });
  }
  const diffDays = Math.floor(diffHours / 24);
  return t('mobileLib.daysAgo', { days: diffDays });
}

export function getSettingsValidationMessage(serverUrl: string): string | null {
  return getServerUrlValidationMessage(serverUrl);
}

export async function loadStoredAuthSession(): Promise<AuthSession | null> {
  const credentials = await Keychain.getGenericPassword({
    service: AUTH_SESSION_SERVICE,
  });
  if (!credentials) {
    return null;
  }

  try {
    return JSON.parse(credentials.password) as AuthSession;
  } catch {
    return null;
  }
}

export async function saveStoredAuthSession(
  session: AuthSession,
): Promise<void> {
  const saved = await Keychain.setGenericPassword('dolgate', JSON.stringify(session), {
    service: AUTH_SESSION_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (!saved) {
    throw new Error(t('mobileLib.sessionStoreFailed'));
  }
}

export async function clearStoredAuthSession(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: AUTH_SESSION_SERVICE,
  });
}

export async function loadStoredSecrets(): Promise<ManagedSecretsMap> {
  const credentials = await Keychain.getGenericPassword({
    service: MANAGED_SECRETS_SERVICE,
  });
  if (!credentials) {
    return {};
  }

  try {
    return JSON.parse(credentials.password) as ManagedSecretsMap;
  } catch {
    return {};
  }
}

export async function saveStoredSecrets(
  secretsByRef: ManagedSecretsMap,
): Promise<void> {
  await Keychain.setGenericPassword('dolgate', JSON.stringify(secretsByRef), {
    service: MANAGED_SECRETS_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredSecrets(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: MANAGED_SECRETS_SERVICE,
  });
}

/** 팀 정적 AWS 프로필에 이 기기에서 넣은 키. */
export interface TeamAwsKey {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * 팀마다 받은 비밀값과 내 자격 증명, 이 기기에서 넣은 팀 AWS 키(팀 ID → 그 팀 것). 개인 비밀값과 따로 둔다 — 개인
 * 것은 개인 동기화가 통째로 다시 쓰고, 팀 것은 팀에서 빠질 때 그 팀 몫만 지운다.
 */
export type StoredTeamSecrets = Record<
  string,
  {
    secretsByRef: ManagedSecretsMap;
    hostCredentials: Record<string, TeamHostCredentials>;
    /** 프로필 ID → 이 기기의 키. 어디로도 올리지 않는다 — 키는 기기마다 넣는다(데스크톱과 같다). */
    awsKeys?: Record<string, TeamAwsKey>;
  }
>;

export async function loadStoredTeamSecrets(): Promise<StoredTeamSecrets> {
  const credentials = await Keychain.getGenericPassword({
    service: TEAM_SECRETS_SERVICE,
  });
  if (!credentials) {
    return {};
  }

  try {
    return JSON.parse(credentials.password) as StoredTeamSecrets;
  } catch {
    return {};
  }
}

export async function saveStoredTeamSecrets(
  teamSecrets: StoredTeamSecrets,
): Promise<void> {
  await Keychain.setGenericPassword('dolgate', JSON.stringify(teamSecrets), {
    service: TEAM_SECRETS_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredTeamSecrets(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: TEAM_SECRETS_SERVICE,
  });
}

export async function loadStoredAwsProfiles(): Promise<
  ManagedAwsProfilePayload[]
> {
  const credentials = await Keychain.getGenericPassword({
    service: MANAGED_AWS_PROFILES_SERVICE,
  });
  if (!credentials) {
    return [];
  }

  try {
    return JSON.parse(credentials.password) as ManagedAwsProfilePayload[];
  } catch {
    return [];
  }
}

export async function saveStoredAwsProfiles(
  profiles: ManagedAwsProfilePayload[],
): Promise<void> {
  await Keychain.setGenericPassword('dolgate', JSON.stringify(profiles), {
    service: MANAGED_AWS_PROFILES_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredAwsProfiles(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: MANAGED_AWS_PROFILES_SERVICE,
  });
}

export async function loadStoredTailnets(): Promise<TailnetPayload[]> {
  const credentials = await Keychain.getGenericPassword({
    service: MANAGED_TAILNETS_SERVICE,
  });
  if (!credentials) {
    return [];
  }

  try {
    const parsed = JSON.parse(credentials.password) as unknown;
    return Array.isArray(parsed) ? (parsed as TailnetPayload[]) : [];
  } catch {
    return [];
  }
}

export async function saveStoredTailnets(
  tailnets: TailnetPayload[],
): Promise<void> {
  await Keychain.setGenericPassword('dolgate', JSON.stringify(tailnets), {
    service: MANAGED_TAILNETS_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredTailnets(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: MANAGED_TAILNETS_SERVICE,
  });
}

export async function loadStoredAwsSsoTokens(): Promise<
  Record<string, StoredAwsSsoTokenRecord>
> {
  const credentials = await Keychain.getGenericPassword({
    service: AWS_SSO_TOKENS_SERVICE,
  });
  if (!credentials) {
    return {};
  }

  try {
    return JSON.parse(credentials.password) as Record<
      string,
      StoredAwsSsoTokenRecord
    >;
  } catch {
    return {};
  }
}

export async function saveStoredAwsSsoTokens(
  tokensByProfileId: Record<string, StoredAwsSsoTokenRecord>,
): Promise<void> {
  await Keychain.setGenericPassword(
    'dolgate',
    JSON.stringify(tokensByProfileId),
    {
      service: AWS_SSO_TOKENS_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
}

export async function clearStoredAwsSsoTokens(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: AWS_SSO_TOKENS_SERVICE,
  });
}

export async function loadStoredClientInstallationId(): Promise<string | null> {
  const credentials = await Keychain.getGenericPassword({
    service: CLIENT_INSTALLATION_ID_SERVICE,
  });
  if (!credentials) {
    return null;
  }

  const installationId = credentials.password.trim();
  return installationId || null;
}

export async function saveStoredClientInstallationId(
  installationId: string,
): Promise<void> {
  await Keychain.setGenericPassword('dolgate', installationId, {
    service: CLIENT_INSTALLATION_ID_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

// 설치 ID 는 불변이므로 한 번 확보하면 프로세스 수명 동안 재사용한다 — 매 sync 마다
// 키체인을 왕복하지 않는다. 실패한 promise 는 캐시에서 비워 다음 호출이 재시도한다.
let clientInstallationIdPromise: Promise<string> | null = null;

export function resetClientInstallationIdCacheForTests(): void {
  clientInstallationIdPromise = null;
}

export async function getOrCreateClientInstallationId(): Promise<string> {
  if (!clientInstallationIdPromise) {
    clientInstallationIdPromise = (async () => {
      const storedInstallationId = await loadStoredClientInstallationId();
      if (storedInstallationId) {
        return storedInstallationId;
      }
      const installationId = createInstallationId();
      await saveStoredClientInstallationId(installationId);
      return installationId;
    })().catch(error => {
      clientInstallationIdPromise = null;
      throw error;
    });
  }
  return clientInstallationIdPromise;
}

// 클라이언트 식별 헤더 — 세션 발급뿐 아니라 /sync 에도 실어, 서버의 v2 push 버전
// 게이트(426)가 최신 클라이언트를 구버전으로 오인하지 않게 한다.
export async function buildClientIdentificationHeaders(): Promise<
  Record<string, string>
> {
  return {
    [CLIENT_HEADER_NAME]: 'mobile',
    [CLIENT_VERSION_HEADER_NAME]: APP_VERSION,
    [CLIENT_PLATFORM_HEADER_NAME]: resolveMobileClientPlatform(),
    [CLIENT_INSTALLATION_ID_HEADER_NAME]:
      await getOrCreateClientInstallationId(),
  };
}

async function buildAuthRequestHeaders(): Promise<Record<string, string>> {
  return {
    'content-type': 'application/json',
    ...(await buildClientIdentificationHeaders()),
  };
}

export async function fetchExchangeSession(
  serverUrl: string,
  code: string,
): Promise<AuthSession> {
  return fetchJson<AuthSession>(
    new URL('/auth/exchange', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'POST',
      headers: await buildAuthRequestHeaders(),
      body: JSON.stringify({ code }),
    },
  );
}

export async function refreshAuthSession(
  serverUrl: string,
  session: AuthSession,
  options?: FetchRequestOptions,
): Promise<AuthSession> {
  return fetchJson<AuthSession>(
    new URL('/auth/refresh', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'POST',
      headers: await buildAuthRequestHeaders(),
      body: JSON.stringify({
        refreshToken: session.tokens.refreshToken,
      }),
    },
    options,
  );
}

export async function logoutRemoteSession(
  serverUrl: string,
  session: AuthSession | null,
): Promise<void> {
  if (!session?.tokens.refreshToken) {
    return;
  }

  await fetchEmpty(
    new URL('/auth/logout', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        refreshToken: session.tokens.refreshToken,
      }),
    },
  );
}

export interface VaultSetupRequestBody {
  wrappedDekBase64: string;
  // DEK 공개 검증자(HMAC) — 설정(POST)에는 필수, 암호 변경(PUT)에는 선택(verifier 이전
  // 볼트의 지연 백필). 다른 기기들이 캐시 DEK 를 로컬 검증하는 근거다.
  dekVerifierBase64?: string;
  kdf: VaultKdfDescriptor;
  expectedEpoch: number;
  expectedDekVerifierBase64?: string;
  expectedWrapRevision?: number;
}

// POST/PUT /auth/vault 응답 — 시작/유지된 DEK 세대(epoch). 구 서버는 204/{dekId}를
// 주므로 null(epoch 0 취급).
export interface VaultMutationResult {
  epoch: number | null;
  wrapRevision: number | null;
}

async function fetchVaultMutation(
  url: string,
  init: RequestInit,
): Promise<VaultMutationResult> {
  const response = await fetchWithOptions(url, init, {
    timeoutMs: VAULT_MUTATION_TIMEOUT_MS,
    timeoutMessage: getVaultMutationTimeoutMessage(),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.status === 204) {
    return { epoch: null, wrapRevision: null };
  }
  try {
    const parsed = (await response.json()) as {
      epoch?: unknown;
      wrapRevision?: unknown;
    };
    return {
      epoch:
        typeof parsed.epoch === 'number' && Number.isSafeInteger(parsed.epoch)
          ? parsed.epoch
          : null,
      wrapRevision:
        typeof parsed.wrapRevision === 'number' &&
        Number.isSafeInteger(parsed.wrapRevision)
          ? parsed.wrapRevision
          : null,
    };
  } catch {
    return { epoch: null, wrapRevision: null };
  }
}

// E2EE 볼트 설정 — 동기화 암호로 감싼 DEK 를 서버에 저장한다(서버는 복호화 불가).
// 이미 다른 기기가 설정했으면 409 를 돌려주고, 클라이언트는 잠금해제 플로우로 전환한다.
export async function postVaultSetup(
  serverUrl: string,
  accessToken: string,
  body: VaultSetupRequestBody,
): Promise<VaultMutationResult> {
  return fetchVaultMutation(
    new URL('/auth/vault', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

// 동기화 암호 변경(rewrap) — DEK 는 그대로라 다른 기기의 캐시는 계속 유효하다.
export async function putVaultRewrap(
  serverUrl: string,
  accessToken: string,
  body: VaultSetupRequestBody,
): Promise<VaultMutationResult> {
  return fetchVaultMutation(
    new URL('/auth/vault', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

// 볼트 초기화 — 동기화 암호 분실 최후 수단. 서버의 볼트와 모든 sync 데이터가 삭제된다.
export async function postVaultReset(
  serverUrl: string,
  accessToken: string,
  expectedEpoch: number,
): Promise<VaultMutationResult> {
  return fetchVaultMutation(
    new URL('/auth/vault/reset', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedEpoch }),
    },
  );
}

export interface StoredVaultDek {
  dekBase64: string;
  owner?: VaultCacheOwner;
  // DEK 세대 — 세션 descriptor 의 epoch 과 크기 비교해 낡은 descriptor 를 무시하고,
  // push fence 헤더로 보낸다. epoch 도입 이전 엔트리(dekId 시절 포함)는 null.
  epoch: number | null;
  wrapRevision: number | null;
  wrappedDekBase64?: string;
  kdf?: VaultKdfDescriptor;
  dekVerifierBase64?: string;
}

export async function loadStoredVaultDek(): Promise<StoredVaultDek | null> {
  const v2Credentials = await Keychain.getGenericPassword({
    service: VAULT_CACHE_V2_SERVICE,
  });
  if (v2Credentials) {
    const record = parseVaultCacheRecord(v2Credentials.password);
    if (record) {
      return {
        dekBase64: record.dekBase64,
        epoch: record.epoch,
        wrapRevision: record.wrapRevision ?? 0,
        owner: record.owner,
        wrappedDekBase64: record.wrappedDekBase64,
        kdf: record.kdf,
        dekVerifierBase64: record.dekVerifierBase64,
      };
    }
  }
  const credentials = await Keychain.getGenericPassword({
    service: VAULT_DEK_SERVICE,
  });
  if (!credentials) {
    return null;
  }
  const dekBase64 = credentials.password.trim();
  if (!dekBase64) {
    return null;
  }
  const username = credentials.username ?? '';
  if (username.startsWith(VAULT_EPOCH_USERNAME_PREFIX)) {
    const parsed = Number(username.slice(VAULT_EPOCH_USERNAME_PREFIX.length));
    return {
      dekBase64,
      epoch: Number.isSafeInteger(parsed) ? parsed : null,
      wrapRevision: null,
    };
  }
  // 이전 포맷: 'dolgate'(초기) 또는 'dekid:*'(dekId 시절) — epoch 없음.
  return { dekBase64, epoch: null, wrapRevision: null };
}

export async function saveStoredVaultDek(
  dekBase64: string,
  epoch: number | null | undefined,
  owner: VaultCacheOwner,
  descriptor?: {
    wrappedDekBase64: string;
    kdf: VaultKdfDescriptor;
    dekVerifierBase64: string;
    wrapRevision: number;
  },
): Promise<void> {
  if (typeof epoch === 'number' && Number.isSafeInteger(epoch)) {
    const record: VaultCacheRecord = {
      version: 2,
      owner,
      dekBase64,
      epoch,
      wrapRevision: descriptor?.wrapRevision ?? 0,
      ...(descriptor
        ? {
            wrappedDekBase64: descriptor.wrappedDekBase64,
            kdf: descriptor.kdf,
            dekVerifierBase64: descriptor.dekVerifierBase64,
          }
        : {}),
    };
    const saved = await Keychain.setGenericPassword(
      'vault-cache:2',
      JSON.stringify(record),
      {
        service: VAULT_CACHE_V2_SERVICE,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      },
    );
    if (!saved) {
      throw new Error(t('mobileLib.vaultKeyStoreFailed'));
    }
  } else {
    // epoch 없는 아주 오래된 캐시는 owner까지 원자적으로 묶을 수 없으므로 v2 레코드를
    // 남기지 않는다. 현재 서버의 v1/v2 descriptor를 받으면 즉시 epoch 포함 형식으로 승격된다.
    await Keychain.resetGenericPassword({
      service: VAULT_CACHE_V2_SERVICE,
    });
  }
  // epoch 을 username 필드에 함께 넣어 DEK 와 한 엔트리로 원자적으로 저장한다.
  const username =
    typeof epoch === 'number' && Number.isSafeInteger(epoch)
      ? `${VAULT_EPOCH_USERNAME_PREFIX}${epoch}`
      : 'dolgate';
  const hasV2Cache = typeof epoch === 'number' && Number.isSafeInteger(epoch);
  try {
    const legacySaved = await Keychain.setGenericPassword(username, dekBase64, {
      service: VAULT_DEK_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!legacySaved && !hasV2Cache) {
      throw new Error(t('mobileLib.vaultKeyStoreFailed'));
    }
  } catch (error) {
    if (!hasV2Cache) {
      throw error;
    }
  }
}

export async function clearStoredVaultDek(): Promise<void> {
  // 한 서비스 정리 실패가 다른 서비스 정리를 막지 않게 한다. reset/logout의 서버 상태는
  // 이미 커밋됐을 수 있으므로 로컬 Keychain 오류를 전체 작업 실패로 승격하지 않는다.
  await Promise.allSettled([
    Keychain.resetGenericPassword({ service: VAULT_CACHE_V2_SERVICE }),
    Keychain.resetGenericPassword({ service: VAULT_DEK_SERVICE }),
  ]);
}

// 회원 탈퇴 — 서버의 모든 사용자 데이터(계정·vault 키·sync 레코드)를 즉시 영구 삭제한다.
export async function deleteRemoteAccount(
  serverUrl: string,
  accessToken: string,
): Promise<void> {
  await fetchEmpty(
    new URL('/auth/account', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
}

export async function changeRemoteAccountPassword(
  serverUrl: string,
  accessToken: string,
  refreshToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ passwordState: AccountPasswordState }> {
  return fetchJson<{ passwordState: AccountPasswordState }>(
    new URL('/auth/account/password', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ currentPassword, newPassword, refreshToken }),
    },
    {
      timeoutMs: ACCOUNT_PASSWORD_REQUEST_TIMEOUT_MS,
      timeoutMessage: getAccountPasswordRequestTimeoutMessage(),
    },
  );
}

// 조건부 GET 결과(판별 유니온). notModified=true 면 서버 데이터가 마지막 동기화 이후
// 그대로라 payload 가 없고, 폴링이 적용을 건너뛴다. 200 이면 payload 가 항상 있어
// 호출부의 도달 불가능한 null 가드가 필요 없다.
export type SyncSnapshotResult =
  | { notModified: true; payload: null; etag: null }
  | { notModified: false; payload: SyncPayloadV2; etag: string | null };

// 서버는 레코드가 0개인 kind 를 키째로 뺀다 — "없는 배열은 빈 배열로 다룬다" 가 응답
// 계약이다(sync-api listAllSyncRecordsTx). 디코드 쪽에서 kind 마다 막으면 하나 빠뜨리는
// 순간 `undefined.filter` 가 던지는데, 그 예외는 복호화 실패와 구분되지 않아 "데이터가
// 손상됐다"로 뜬다(그룹이나 AWS 프로필을 한 번도 안 만든 계정이 그렇게 깨졌다). 그래서
// 경계에서 한 번만 메꾼다 — 데스크톱 normalizeSyncPayload 와 같은 규칙이다.
//
// 모르는 kind 는 그대로 둔다. 우리가 안 읽을 뿐이고, 떨어뜨릴 이유가 없다.
export function normalizeSyncPayload(
  payload: Partial<SyncPayloadV2> | null | undefined,
): SyncPayloadV2 {
  const empty = buildEmptySyncPayload();
  const normalized: SyncPayloadV2 = { ...empty, ...(payload ?? {}) };
  for (const kind of Object.keys(empty) as Array<keyof SyncPayloadV2>) {
    if (!Array.isArray(normalized[kind])) {
      normalized[kind] = [];
    }
  }
  return normalized;
}

export async function fetchSyncSnapshot(
  serverUrl: string,
  accessToken: string,
  ifNoneMatch?: string | null,
): Promise<SyncSnapshotResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    // 안드로이드 기본 HTTP 캐시(OkHttp)를 건너뛴다. 서버가 no-store 를 붙이기 전(v1.9.4 전)에 저장된
    // 응답이 남아 있으면, 앱이 If-None-Match 를 안 보낸 첫 당기기에 캐시가 그 ETag 를 대신 붙이고 304 를
    // 받아 옛 본문(계정을 바꿨다면 다른 계정 것)을 200 인 척 넘긴다.
    'Cache-Control': 'no-cache',
    ...(await buildClientIdentificationHeaders()),
  };
  if (ifNoneMatch) {
    headers['If-None-Match'] = ifNoneMatch;
  }
  const response = await fetchWithOptions(
    new URL('/sync', normalizeServerUrl(serverUrl)).toString(),
    { headers },
  );
  if (response.status === 304) {
    // 304 의 ETag 는 보낸 If-None-Match 와 같으므로 소비할 정보가 없다 — null 로 둔다.
    return { notModified: true, payload: null, etag: null };
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  const payload = normalizeSyncPayload(
    (await response.json()) as Partial<SyncPayloadV2>,
  );
  return {
    notModified: false,
    payload,
    etag: normalizeSyncRevisionEtag(response.headers.get('etag')),
  };
}

/**
 * 다른 기기의 변경을 기다린다(서버 GET /sync/watch, 롱폴링). 서버는 20~30초 안에 답한다 —
 * 리비전이 바뀌면 그 순간 changed, 아니면 대기가 끝나 304(unchanged).
 *
 * 그보다 한참(45초) 늦으면 연결이 조용히 죽은 것으로 보고 끊는다. signal 이 abort 되면(앱이
 * 백그라운드로 가는 등) 바로 끊는다. fetchWithOptions 는 타임아웃을 걸면 호출자의 signal 을
 * 덮어써 이 둘을 같이 못 하므로 직접 묶는다.
 */
export async function watchSyncChanges(
  serverUrl: string,
  accessToken: string,
  ifNoneMatch: string | null,
  signal: AbortSignal,
): Promise<{ changed: boolean; etag: string | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    ...(await buildClientIdentificationHeaders()),
  };
  if (ifNoneMatch) {
    headers['If-None-Match'] = ifNoneMatch;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort);
  }
  const timer = setTimeout(abort, SYNC_WATCH_CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(
      new URL('/sync/watch', normalizeServerUrl(serverUrl)).toString(),
      { headers, signal: controller.signal },
    );
    if (response.status === 304) {
      return { changed: false, etag: ifNoneMatch };
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    return {
      changed: true,
      etag: normalizeSyncRevisionEtag(response.headers.get('etag')),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function fetchServerInfo(
  serverUrl: string,
): Promise<ServerInfoResponse> {
  return fetchJson<ServerInfoResponse>(
    new URL('/api/info', normalizeServerUrl(serverUrl)).toString(),
  );
}

export async function postSyncSnapshot(
  serverUrl: string,
  accessToken: string,
  payload: SyncPayloadV2,
  // 암호화에 쓴 DEK 의 세대(epoch) — 서버가 트랜잭션 안에서 fence 로 대조해, 다른
  // 기기의 초기화/재설정과 겹친 push 를 커밋 시점에 거부한다(409).
  vaultEpoch?: number | null,
  /**
   * 이 기기가 올리는 데이터가 요구하는 클라이언트 수준. 생략하면 0(요구 없음)이다.
   *
   * 모바일도 RDP/VNC 호스트를 보존하므로 호출자는 전체 로컬 호스트에서 계산한 수준을 넘긴다.
   * 부분 mutation payload 만 보면 계정의 다른 호스트 종류를 놓칠 수 있어 payload 자체로 추론하지
   * 않는다. 헤더를 안 보내거나 0 으로 보내면 서버 초기화 후 자연 복구가 옛 데스크톱에 새 종류를
   * 노출할 수 있다.
   */
  syncDataFloor?: number | null,
): Promise<string | null> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    ...(await buildClientIdentificationHeaders()),
  };
  if (typeof vaultEpoch === 'number' && Number.isSafeInteger(vaultEpoch)) {
    headers[VAULT_EPOCH_HEADER] = String(vaultEpoch);
  }
  // 항상 보낸다. 서버는 헤더가 없으면 0 으로 보지만, 모든 클라이언트가 자기 수준을 선언하는
  // 편이 규칙이 단순하다 — "안 보낸 것" 과 "0" 을 구분할 일이 없어진다.
  headers[SYNC_DATA_FLOOR_HEADER] = String(
    typeof syncDataFloor === 'number' && Number.isSafeInteger(syncDataFloor) && syncDataFloor > 0
      ? syncDataFloor
      : 0,
  );
  const response = await fetchWithOptions(
    new URL('/sync', normalizeServerUrl(serverUrl)).toString(),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  // 새 리비전을 ETag 형태("<n>")로 돌려줘, 다음 폴링이 내 push 를 다시 당기지 않게 한다.
  try {
    const body = (await response.json()) as { revision?: number };
    if (typeof body.revision === 'number') {
      return formatSyncRevisionEtag(body.revision);
    }
  } catch {
    // 구버전 서버는 본문이 없을 수 있다 — 다음 폴링이 전체를 한 번 당긴다(무해).
  }
  return null;
}

/**
 * 동기화 올리기를 묶음으로 나눠 보낸다(④, 2026-11-13).
 *
 * 서버 앞의 리버스 프록시는 본문이 크면(nginx 기본 1MB) 서버에 닿기도 전에 413 을 준다. 대기열이 클 때(오프라인에서
 * 많이 고쳤을 때)와 초기화 뒤 통째로 다시 올릴 때 넘는다. 서버는 받은 레코드만 넣거나 고치므로 나눠도 결과가 같다.
 *
 * 묶음 하나가 들어갈 때마다 onSent 로 그 리비전과 실은 레코드를 알린다. 그것만으로 한도를 넘는 레코드는 빼고
 * 돌려준다(나머지는 다 보냈다). 그 밖의 실패는 던진다 — 그때까지 들어간 묶음은 이미 알렸다.
 */
export async function postSyncSnapshotInBatches(
  serverUrl: string,
  accessToken: string,
  payload: SyncPayloadV2,
  vaultEpoch?: number | null,
  syncDataFloor?: number | null,
  onSent?: (revision: string | null, entries: SyncPushEntry[]) => void,
): Promise<SyncPushEntry[]> {
  let revision: string | null = null;
  const result = await pushSyncRecordsInBatches(
    payload as unknown as Record<string, SyncRecord[]>,
    {
      serverKey: normalizeServerUrl(serverUrl),
      send: async batch => {
        try {
          revision = await postSyncSnapshot(
            serverUrl,
            accessToken,
            batch as unknown as SyncPayloadV2,
            vaultEpoch,
            syncDataFloor,
          );
          return 'sent';
        } catch (error) {
          if (error instanceof ApiError && error.status === 413) {
            return 'too-large';
          }
          throw error;
        }
      },
      onSent: entries => onSent?.(revision, entries),
    },
  );
  return result.tooLarge;
}

/** 너무 커서 못 올린 레코드를 알리는 문구 — 첫 레코드의 이름과 크기, 더 있으면 그 수. */
export function describeOversizedSyncRecords(
  records: ReadonlyArray<{ label: string; bytes: number }>,
): string {
  const [first, ...rest] = records;
  const size =
    first.bytes >= 1024 * 1024
      ? `${(first.bytes / (1024 * 1024)).toFixed(1)}MB`
      : `${Math.ceil(first.bytes / 1024)}KB`;
  return rest.length === 0
    ? t('store.syncRecordTooLarge', { name: first.label, size })
    : t('store.syncRecordsTooLarge', { name: first.label, size, count: rest.length });
}

export function decodeSyncRecords<T>(
  records: SyncRecord[],
  keyBase64: string,
): T[] {
  return records
    .filter(record => !record.deleted_at)
    .map(record =>
      decodeEncryptedPayload<T>(record.encrypted_payload, keyBase64),
    );
}

/**
 * 서버가 알려 준 삭제(tombstone). `decodeSyncRecords` 가 이것을 걸러 내므로, 병합이
 * "서버에 없다 = 지워졌다" 와 "서버에 없다 = 아직 안 올렸다" 를 구분하려면 따로 꺼내야 한다.
 */
export function decodeSyncTombstones(
  records: SyncRecord[],
): Array<{ id: string; deletedAt: string }> {
  return records
    .filter(record => Boolean(record.deleted_at))
    .map(record => ({ id: record.id, deletedAt: record.deleted_at as string }));
}

export function decodeSshHosts(
  payload: SyncPayloadV2,
  keyBase64: string,
): SshHostRecord[] {
  return decodeSyncRecords<HostRecord>(payload.hosts, keyBase64).filter(
    isSshHostRecord,
  );
}

export function decodeSupportedHosts(
  payload: SyncPayloadV2,
  keyBase64: string,
): HostRecord[] {
  return decodeSyncRecords<HostRecord>(payload.hosts, keyBase64).filter(
    host =>
      isSshHostRecord(host) ||
      isAwsEc2HostRecord(host) ||
      isRdpHostRecord(host) ||
      isVncHostRecord(host),
  );
}

export function resolveMobileSyncDataFloor(
  hosts: readonly HostRecord[],
): number {
  return hosts.some(host => !LEGACY_TOLERATED_HOST_KINDS.has(host.kind))
    ? SYNC_DATA_FLOOR_LEGACY_INTOLERANT_KINDS
    : 0;
}

export function decodeGroups(
  payload: SyncPayloadV2,
  keyBase64: string,
): GroupRecord[] {
  return decodeSyncRecords<GroupRecord>(payload.groups, keyBase64);
}

export function decodeKnownHosts(
  payload: SyncPayloadV2,
  keyBase64: string,
): KnownHostRecord[] {
  return decodeSyncRecords<KnownHostRecord>(payload.knownHosts, keyBase64);
}

export function decodeManagedSecrets(
  payload: SyncPayloadV2,
  keyBase64: string,
): ManagedSecretsMap {
  const next: ManagedSecretsMap = {};
  for (const record of decodeSyncRecords<ManagedSecretPayload>(
    payload.secrets,
    keyBase64,
  )) {
    next[record.secretRef] = record;
  }
  return next;
}

export function decodeAwsProfiles(
  payload: SyncPayloadV2,
  keyBase64: string,
): ManagedAwsProfilePayload[] {
  return decodeSyncRecords<ManagedAwsProfilePayload>(
    payload.awsProfiles,
    keyBase64,
  ).sort((left, right) => left.name.localeCompare(right.name));
}

export function decodeTailnets(
  payload: SyncPayloadV2,
  keyBase64: string,
): TailnetPayload[] {
  // 구버전 서버는 tailnets 필드 자체를 모른다.
  return decodeSyncRecords<TailnetPayload>(payload.tailnets ?? [], keyBase64)
    .filter(
      tailnet => typeof tailnet.id === 'string' && tailnet.id.trim().length > 0,
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function decodeSnippets(
  payload: SyncPayloadV2,
  keyBase64: string,
): SnippetRecord[] {
  // 구버전 서버는 snippets 필드 자체를 모른다.
  return decodeSyncRecords<SnippetRecord>(
    payload.snippets ?? [],
    keyBase64,
  ).sort((left, right) => left.label.localeCompare(right.label));
}

export function buildKnownHostsSyncPayload(
  knownHosts: KnownHostRecord[],
  keyBase64: string,
): SyncPayloadV2 {
  return {
    ...buildEmptySyncPayload(),
    knownHosts: knownHosts.map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
  };
}

// 호스트 생성·수정·삭제를 서버로 push 할 때 쓰는 부분 스냅샷.
// POST /sync 는 레코드 단위 업서트(last-write-wins)라 담은 레코드만 반영된다.
// 삭제는 tombstone(빈 payload + deleted_at) — 서버·데스크톱과 같은 규약이다.
// 자격증명(secrets)은 secretRef 를 레코드 id 로 쓴다(데스크톱 sync-service 와 동일).
export function buildHostMutationSyncPayload(
  input: {
    hosts?: HostRecord[];
    secrets?: ManagedSecretPayload[];
    deletedHosts?: Array<{ id: string; deletedAt: string }>;
    /**
     * 바뀐 그룹. 그룹 이름을 바꾸면 그 아래 호스트의 `groupName`(경로 문자열)도 함께
     * 바뀌므로, 보통 `hosts` 와 같이 넘어온다.
     */
    groups?: GroupRecord[];
    deletedGroups?: Array<{ id: string; deletedAt: string }>;
    /** 바뀐 것만 보낸다. 예전에는 신뢰할 때마다 전체 목록을 밀었다. */
    knownHosts?: KnownHostRecord[];
  },
  keyBase64: string,
): SyncPayloadV2 {
  return {
    ...buildEmptySyncPayload(),
    groups: [
      ...(input.groups ?? []).map(record => ({
        id: record.id,
        encrypted_payload: encodeEncryptedPayload(record, keyBase64),
        updated_at: record.updatedAt,
      })),
      ...(input.deletedGroups ?? []).map(record => ({
        id: record.id,
        encrypted_payload: '',
        updated_at: record.deletedAt,
        deleted_at: record.deletedAt,
      })),
    ],
    hosts: [
      ...(input.hosts ?? []).map(record => ({
        id: record.id,
        encrypted_payload: encodeEncryptedPayload(record, keyBase64),
        updated_at: record.updatedAt,
      })),
      ...(input.deletedHosts ?? []).map(record => ({
        id: record.id,
        encrypted_payload: '',
        updated_at: record.deletedAt,
        deleted_at: record.deletedAt,
      })),
    ],
    secrets: (input.secrets ?? []).map(record => ({
      id: record.secretRef,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
    knownHosts: (input.knownHosts ?? []).map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
  };
}

// 초기화(reset) 후 재설정의 자연 복구 경로: 이 기기에 남아 있는(아직 복호화돼 있는)
// 로컬 데이터를 새 DEK 로 재암호화해 통째로 올린다 — 데스크톱의 "로컬 보존 → 첫 push
// 재업로드"와 같은 시맨틱. 첫 pull 이 빈 서버 스냅샷으로 로컬을 비우기 전에 실행해야 한다.
export function buildLocalStateSyncPayload(
  input: {
    hosts: HostRecord[];
    groups: GroupRecord[];
    knownHosts: KnownHostRecord[];
    secrets: ManagedSecretPayload[];
    awsProfiles: ManagedAwsProfilePayload[];
    tailnets: TailnetPayload[];
  },
  keyBase64: string,
): SyncPayloadV2 {
  return {
    ...buildEmptySyncPayload(),
    hosts: input.hosts.map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
    groups: input.groups.map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
    knownHosts: input.knownHosts.map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
    secrets: input.secrets.map(record => ({
      id: record.secretRef,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
    awsProfiles: input.awsProfiles.map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
    tailnets: input.tailnets.map(record => ({
      id: record.id,
      encrypted_payload: encodeEncryptedPayload(record, keyBase64),
      updated_at: record.updatedAt,
    })),
  };
}

export function buildKnownHostRecord(
  info: MobileServerPublicKeyInfo,
  existing?: KnownHostRecord | null,
  tailnetId?: string | null,
): KnownHostRecord {
  const now = new Date().toISOString();
  const normalizedTailnetId = tailnetId?.trim();
  return {
    id: existing?.id ?? createLocalId('known-host'),
    ...(normalizedTailnetId ? { tailnetId: normalizedTailnetId } : {}),
    host: info.host,
    port: info.port,
    algorithm: info.algorithm,
    publicKeyBase64: info.keyBase64,
    fingerprintSha256: info.fingerprintSha256,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
    updatedAt: now,
  };
}

export function deriveSecretMetadata(
  hosts: HostRecord[],
  secretsByRef: ManagedSecretsMap,
): SecretMetadataRecord[] {
  return Object.values(secretsByRef)
    .map(record =>
      projectSecretMetadata(record, {
        linkedHostCount: hosts.filter(
          host => isSshHostRecord(host) && host.secretRef === record.secretRef,
        ).length,
        updatedAt: record.updatedAt,
      }),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function mergePromptedSecrets(
  previous: LoadedManagedSecretPayload | undefined,
  host: SshHostRecord,
  prompt: HostSecretInput,
): LoadedManagedSecretPayload | null {
  if (!host.secretRef) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    secretRef: host.secretRef,
    label: previous?.label ?? `${host.label} credentials`,
    password: prompt.password ?? previous?.password,
    passphrase: prompt.passphrase ?? previous?.passphrase,
    privateKeyPem: prompt.privateKeyPem ?? previous?.privateKeyPem,
    certificateText: prompt.certificateText ?? previous?.certificateText,
    updatedAt: now,
  };
}

export function sanitizeTerminalSnapshot(input: string): string {
  return input.replace(/\u0000/g, '').replace(/\r/g, '');
}

/** 레코드 하나를 동기화 봉투(AES-GCM)로 잠근다 — 개인 동기화와 팀 개인 칸 올리기가 같은 모양을 쓴다. */
export function encodeEncryptedPayload<T>(value: T, keyBase64: string): string {
  const key = toByteArray(keyBase64);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const sealed = gcm(key, iv).encrypt(plaintext);
  const tag = sealed.slice(sealed.length - 16);
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const envelope: SyncEnvelope = {
    v: 1,
    iv: fromByteArray(iv),
    tag: fromByteArray(tag),
    ciphertext: fromByteArray(ciphertext),
  };
  return JSON.stringify(envelope);
}

/**
 * 레코드 복호화 실패에만 붙는 이름.
 *
 * "데이터가 손상됐다"고 말할 근거는 이 오류뿐이다. 디코드 블록의 catch 에는 구조 오류(서버
 * 응답 모양이 바뀌어 배열이 없다든지)도 같이 떨어지는데, 그것까지 손상으로 표시하면 사용자는
 * 복구할 수 없는 문제라고 오해하고 개발자는 암호 쪽을 파게 된다 — 실제로 그렇게 한참 돌아갔다.
 *
 * 클래스 대신 name 을 쓰는 이유는 트랜스파일 타깃에 따라 Error 상속의 instanceof 가 깨지기
 * 때문이다. 이름 비교는 어디서나 같게 동작한다.
 */
export const SYNC_RECORD_DECRYPT_ERROR_NAME = 'SyncRecordDecryptError';

export function isSyncRecordDecryptError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === SYNC_RECORD_DECRYPT_ERROR_NAME
  );
}

function decodeEncryptedPayload<T>(payload: string, keyBase64: string): T {
  try {
    const envelope = JSON.parse(payload) as SyncEnvelope;
    const key = toByteArray(keyBase64);
    const iv = toByteArray(envelope.iv);
    const tag = toByteArray(envelope.tag);
    const ciphertext = toByteArray(envelope.ciphertext);
    const sealed = new Uint8Array(ciphertext.length + tag.length);
    sealed.set(ciphertext);
    sealed.set(tag, ciphertext.length);
    const plaintext = gcm(key, iv).decrypt(sealed);
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as T;
  } catch (error) {
    // 봉투가 깨졌든 태그 검증이 실패했든 사용자에게는 같은 뜻이다 — 이 레코드는 이 키로 못 연다.
    const decryptError = new Error(
      error instanceof Error ? error.message : String(error),
    );
    decryptError.name = SYNC_RECORD_DECRYPT_ERROR_NAME;
    throw decryptError;
  }
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  options?: FetchRequestOptions,
): Promise<T> {
  const response = await fetchWithOptions(url, init, options);
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

async function fetchEmpty(
  url: string,
  init?: RequestInit,
  options?: FetchRequestOptions,
): Promise<void> {
  const response = await fetchWithOptions(url, init, options);
  if (!response.ok) {
    throw await toApiError(response);
  }
}

export async function fetchWithOptions(
  url: string,
  init?: RequestInit,
  options?: FetchRequestOptions,
): Promise<Response> {
  if (!options?.timeoutMs || options.timeoutMs <= 0) {
    return fetch(url, init);
  }

  const controller = new AbortController();
  const timeoutError = new Error(
    options.timeoutMessage ?? t('mobileLib.requestTimeout'),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (error === timeoutError || (error instanceof Error && error.name === 'AbortError')) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const raw = await response.text();
  const trimmed = raw.trim();
  let code: string | undefined;
  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown };
    if (typeof parsed.code === 'string' && parsed.code) {
      code = parsed.code;
    }
  } catch {
    // JSON 이 아니면 code 없음.
  }
  const message =
    extractApiErrorMessage(trimmed) ||
    t('mobileLib.requestFailed', { status: response.status });
  return new ApiError(message, response.status, code);
}

// 서버(sync-api)는 오류를 늘 JSON 의 error 로 준다. 그 밖의 본문 — 앞단 프록시가 대신 준 502·429 의 HTML 같은 것 —
// 은 서버가 한 말이 아니고 화면에 그대로 보일 글도 아니라서 쓰지 않는다. 부르는 쪽이 상태 번호가 든 문구로 바꾼다.
// (예전에는 nginx 의 502 HTML 이 로그인 화면 오류 칸에 그대로 찍혔다.)
function extractApiErrorMessage(raw: string): string | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    return null;
  }

  return null;
}

export { AsyncStorage, Keychain };
