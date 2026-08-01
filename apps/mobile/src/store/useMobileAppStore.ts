import { Buffer } from 'buffer';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { AppState } from 'react-native';
import type {
  AwsProfilesServerSupport,
  AwsSftpCreateSessionRequest,
  AwsEc2HostRecord,
  AwsSsmSessionClientMessage,
  AwsSsmSessionServerMessage,
  AuthSession,
  AuthState,
  DirectoryListing,
  FileEntry,
  GroupRecord,
  HostRecord,
  HostSecretInput,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  MobileConnectionTabRef,
  ManagedAwsProfilePayload,
  MobileSessionRecord,
  MobileSettings,
  MobileSftpSessionRecord,
  MobileSftpTransferRecord,
  SecretMetadataRecord,
  SshHostRecord,
  SyncPayloadV2,
  SyncStatus,
  VaultCacheOwner,
  VaultKdfDescriptor,
} from '@dolssh/shared-core';
import {
  buildAwsSsmKnownHostIdentity,
  computeVaultDekVerifier,
  createVaultDek,
  createVaultKdfDescriptor,
  decideVaultAccess,
  deriveVaultKek,
  formatSyncRevisionEtag,
  isVaultEpochRejectionCode,
  parseSyncRevisionEtag,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
  isSshHostRecord,
  normalizeServerUrl,
  resolveVaultDescriptorState,
  unwrapVaultDek,
  wrapVaultDek,
} from '@dolssh/shared-core';
import { fromByteArray, toByteArray } from 'base64-js';
import {
  buildBrowserLoginUrl,
  clearStoredAwsProfiles,
  clearStoredAwsSsoTokens,
  buildHostMutationSyncPayload,
  buildKnownHostRecord,
  buildKnownHostsSyncPayload,
  buildLocalStateSyncPayload,
  clearStoredAuthSession,
  clearStoredSecrets,
  changeRemoteAccountPassword,
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createLocalId,
  createRandomStateToken,
  createUnauthenticatedState,
  decodeAwsProfiles,
  decodeGroups,
  decodeKnownHosts,
  decodeManagedSecrets,
  decodeSupportedHosts,
  deleteRemoteAccount,
  deriveSecretMetadata,
  fetchExchangeSession,
  fetchServerInfo,
  fetchSyncSnapshot,
  getSettingsValidationMessage,
  clearStoredVaultDek,
  loadStoredAwsProfiles,
  loadStoredVaultDek,
  type StoredVaultDek,
  logoutRemoteSession,
  mergePromptedSecrets,
  MobileServerPublicKeyInfo,
  postSyncSnapshot,
  postVaultReset,
  postVaultSetup,
  putVaultRewrap,
  getVaultMutationTimeoutMessage,
  VAULT_MUTATION_TIMEOUT_MS,
  refreshAuthSession,
  saveStoredVaultDek,
  sanitizeTerminalSnapshot,
  saveStoredAuthSession,
  saveStoredAwsProfiles,
  saveStoredSecrets,
  AsyncStorage,
  loadStoredAuthSession,
  loadStoredSecrets,
  ApiError,
} from '../lib/mobile';
import {
  getAuthCallbackStateErrorMessage,
  getSyncFailureMessage,
} from '../lib/auth-flow';
import { nativeArgon2idDerive } from '../lib/vault';
import {
  type AwsSsoBrowserLoginPrompt,
  resolveAwsSessionForHost,
} from '../lib/aws-session';
import { AwsSftpHostKeyChallengeError, connectAwsSftp } from '../lib/aws-sftp';
import { openAwsSsoBrowser } from '../lib/aws-sso-bridge';
import { closeInAppBrowser, openInAppBrowser } from '../lib/in-app-browser';
import {
  resolvePtyTerminalGridSize,
  setReportedTerminalGrid,
  type TerminalGridSize,
} from '../lib/terminal-size';
import {
  deleteDownloadDestination,
  finalizeDownloadDestination,
  createDownloadDirectory,
  createDownloadFile,
  pickDownloadDestination,
  pickDownloadDirectory,
  pickUploadFile,
  readLocalFileChunk,
  writeDownloadChunk,
} from '../lib/mobile-file-transfer';
import {
  getEngine,
  type EngineConnection,
  type EngineCredential,
  type EngineSftpConnection,
  type EngineShell,
} from '../engine';
import { getAwsEc2SftpDisabledMessage, getNewVaultPassphraseMessage } from '../i18n/shared-messages';
import { t } from '../i18n';

// shared-core 는 코드만 돌려주므로, 사용자에게 보일 문구는 이 앱에서 만들어 던진다.
function assertVaultPassphrase(passphrase: string): void {
  const message = getNewVaultPassphraseMessage(passphrase);
  if (message) {
    throw new Error(message);
  }
}

const MAX_TERMINAL_SNAPSHOT_CHARS = 8_000;
const MAX_PERSISTED_SESSIONS = 24;
const SFTP_TRANSFER_CHUNK_SIZE = 256 * 1024;
const SESSION_SNAPSHOT_FLUSH_MS = 750;
const STARTUP_REFRESH_TIMEOUT_MS = 3_000;
// 모듈 로드 시점에는 i18n 초기화 전이고 언어를 바꿔도 갱신되지 않으므로 호출 시점에 번역한다.
function getStartupRefreshTimeoutMessage(): string {
  return t('store.serverSlow');
}
const OFFLINE_RECOVERY_RETRY_DELAYS_MS = [2_000, 5_000, 5_000, 5_000] as const;
function getSecureStateLoadingMessage(): string {
  return t('store.restoringSecrets');
}

function isStartupTimingLoggingEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function getStartupTimingNow(): number {
  const performanceNow =
    typeof globalThis.performance?.now === 'function'
      ? globalThis.performance.now.bind(globalThis.performance)
      : null;
  return performanceNow ? performanceNow() : Date.now();
}

function beginStartupTiming(label: string): (() => void) | null {
  if (!isStartupTimingLoggingEnabled()) {
    return null;
  }

  const startedAt = getStartupTimingNow();
  return () => {
    const durationMs =
      Math.round((getStartupTimingNow() - startedAt) * 10) / 10;
    console.info(`[mobile-startup] ${label}: ${durationMs}ms`);
  };
}

interface PendingServerKeyPromptState {
  hostId: string;
  hostLabel: string;
  status: 'untrusted' | 'mismatch';
  info: MobileServerPublicKeyInfo;
  existing?: KnownHostRecord | null;
}

interface PendingCredentialPromptState {
  hostId: string;
  hostLabel: string;
  authType: 'password' | 'privateKey' | 'certificate';
  message?: string | null;
  initialValue: HostSecretInput;
}

type PendingAwsSsoLoginState = AwsSsoBrowserLoginPrompt;

type ReactNativeWebSocketConstructor = new (
  uri: string,
  protocols?: string | string[] | null,
  options?: {
    headers: Record<string, string>;
    [optionName: string]: unknown;
  } | null,
) => WebSocket;

interface MobileSftpReadChunk {
  bytes: ArrayBuffer;
  bytesRead: number;
  eof: boolean;
}

interface MobileSftpConnection {
  listDirectory: (path: string) => Promise<DirectoryListing>;
  readFileChunk: (
    path: string,
    offset: number,
    length: number,
  ) => Promise<MobileSftpReadChunk>;
  writeFileChunk: (
    path: string,
    offset: number,
    data: ArrayBuffer,
  ) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  rename: (sourcePath: string, targetPath: string) => Promise<void>;
  chmod: (path: string, permissions: number) => Promise<void>;
  delete: (path: string) => Promise<void>;
  close: () => Promise<void>;
}

interface SshRuntimeSession {
  kind: 'ssh';
  recordId: string;
  hostId: string;
  connection: EngineConnection;
  shell: EngineShell;
  backgroundListenerId: number | null;
}

interface AwsRuntimeSession {
  kind: 'aws-ssm';
  recordId: string;
  hostId: string;
  socket: WebSocket;
  replayChunks: Uint8Array[];
  subscribers: Map<string, SessionTerminalSubscription>;
}

type RuntimeSession = SshRuntimeSession | AwsRuntimeSession;

type EngineCredentialInput = EngineCredential;

function hasCredentialText(value?: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalCredentialText(value?: string | null): string | undefined {
  return hasCredentialText(value) ? value.trim() : undefined;
}

function getMobileCredentialPromptAuthType(
  host: SshHostRecord,
): PendingCredentialPromptState['authType'] {
  if (host.authType === 'certificate') {
    return 'certificate';
  }
  if (host.authType === 'privateKey') {
    return 'privateKey';
  }
  return 'password';
}

function buildEngineCredential(
  host: SshHostRecord,
  credentials: HostSecretInput,
): EngineCredentialInput | null {
  if (host.authType === 'password') {
    const password = optionalCredentialText(credentials.password);
    return password ? { type: 'password', password } : null;
  }

  if (host.authType === 'privateKey') {
    const privateKey = optionalCredentialText(credentials.privateKeyPem);
    return privateKey
      ? {
          type: 'key',
          privateKey,
          passphrase: optionalCredentialText(credentials.passphrase),
        }
      : null;
  }

  if (host.authType === 'certificate') {
    const privateKey = optionalCredentialText(credentials.privateKeyPem);
    const certificate = optionalCredentialText(credentials.certificateText);
    return privateKey && certificate
      ? {
          type: 'certificate',
          privateKey,
          certificate,
          passphrase: optionalCredentialText(credentials.passphrase),
        }
      : null;
  }

  return null;
}

function getMissingCredentialMessage(host: SshHostRecord): string {
  if (host.authType === 'password') {
    return t('store.passwordRequired');
  }
  if (host.authType === 'certificate') {
    return t('store.keyAndCertRequired');
  }
  return t('store.keyRequired');
}

// 자격증명 사전 검증. 엔진이 네이티브로 파싱하므로 비동기이고, 반환값은
// 사용자에게 보여줄 문제 설명(문제 없으면 null)이다.
async function validateEngineCredential(
  security: EngineCredentialInput,
): Promise<string | null> {
  const engine = getEngine();

  if (security.type === 'key' || security.type === 'certificate') {
    const problem = await engine.validatePrivateKey(
      security.privateKey,
      security.passphrase,
    );
    if (problem) {
      return t('store.keyFormatOrPassphrase');
    }
  }

  if (security.type === 'certificate') {
    const problem = await engine.validateCertificate(security.certificate);
    if (problem) {
      return t('store.certFormat');
    }
  }

  return null;
}

interface SftpRuntimeSession {
  recordId: string;
  hostId: string;
  connection: MobileSftpConnection;
}

interface SftpCopyBufferEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  kind: FileEntry['kind'];
}

interface SftpCopyBuffer {
  sftpSessionId: string;
  hostId: string;
  entries: SftpCopyBufferEntry[];
  createdAt: string;
}

interface SessionTerminalSubscription {
  onReplay: (chunks: Uint8Array[]) => void;
  onData: (chunk: Uint8Array) => void;
}

// E2EE 볼트(v2)의 클라이언트 상태 머신.
// none: 미인증 등 볼트를 논할 수 없는 상태 / legacy: v1 — 세션의 keyBase64 를 그대로 사용
// setup-required: 신규 유저 — 동기화 암호 설정 필요 / locked: 암호 입력 필요 /
// unlocked: DEK 확보 — 동기화 가능.
// unlocked 는 항상 verifier(정체성 증명) 또는 암호 unwrap(암호학적 증명)을 거친 상태다 —
// "미검증 임시 신뢰" 같은 중간 상태가 없다. epoch 은 push fence 헤더와 낡은 descriptor
// 무시 판정에 쓴다(구서버 = 0).
export type MobileVaultState =
  | { status: 'none' }
  | { status: 'legacy'; epoch: number; migrationRequired: boolean }
  | { status: 'setup-required'; epoch: number }
  | { status: 'error'; errorMessage: string }
  | {
      status: 'locked';
      wrappedDekBase64: string;
      kdf: VaultKdfDescriptor;
      epoch: number;
      wrapRevision: number;
      // descriptor 의 verifier. 없으면 verifier 도입 이전 볼트 — 잠금해제 성공 시
      // 서버에 지연 백필한다(암호로 DEK 를 증명한 시점에만 안전하다).
      dekVerifierBase64?: string;
    }
  | {
      status: 'unlocked';
      dekBase64: string;
      wrappedDekBase64?: string;
      kdf?: VaultKdfDescriptor;
      epoch: number;
      wrapRevision: number;
      owner?: VaultCacheOwner;
      dekVerifierBase64?: string;
    };

type VaultOperationContext = {
  userId: string;
  serverUrl: string;
};

function hasCoherentVaultDescriptor(vault: MobileVaultState): vault is Extract<
  MobileVaultState,
  { status: 'unlocked' }
> & {
  wrappedDekBase64: string;
  kdf: VaultKdfDescriptor;
} {
  return (
    vault.status === 'unlocked' &&
    typeof vault.wrappedDekBase64 === 'string' &&
    vault.wrappedDekBase64.length > 0 &&
    vault.kdf !== undefined
  );
}

function unlockedVaultStateFromCache(
  cached: StoredVaultDek,
): Extract<MobileVaultState, { status: 'unlocked' }> {
  return {
    status: 'unlocked',
    dekBase64: cached.dekBase64,
    epoch: cached.epoch ?? 0,
    wrapRevision: cached.wrapRevision ?? 0,
    ...(cached.owner ? { owner: cached.owner } : {}),
    ...(cached.dekVerifierBase64
      ? { dekVerifierBase64: cached.dekVerifierBase64 }
      : {}),
    ...(cached.wrappedDekBase64 && cached.kdf
      ? {
          wrappedDekBase64: cached.wrappedDekBase64,
          kdf: cached.kdf,
        }
      : {}),
  };
}

// 모바일 호스트 폼(생성·수정)의 입력. 데스크톱 전용 필드(jump host·env·시작 명령 등)는
// 다루지 않는다 — 수정 시 기존 레코드의 해당 필드를 그대로 보존한다.
export interface MobileHostDraftInput {
  hostId?: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  groupName?: string | null;
  credentialMode?: 'preserve' | 'replace' | 'remove';
  credentials?: {
    password?: string;
    privateKeyPem?: string;
    passphrase?: string;
  } | null;
}

interface MobileAppState {
  hydrated: boolean;
  // WebView 안 xterm 이 실제로 fit 한 그리드. 원격 PTY 크기의 기준이며, 콜드스타트
  // 첫 접속도 정확한 크기를 쓰도록 persist 한다(모듈 캐시는 재시작 시 사라진다).
  terminalGrid: TerminalGridSize | null;
  reportTerminalGrid: (size: TerminalGridSize) => void;
  bootstrapping: boolean;
  authGateResolved: boolean;
  secureStateReady: boolean;
  auth: AuthState;
  vault: MobileVaultState;
  // 기존(v1) 유저의 E2EE 전환 프롬프트를 이번 실행 동안 미룸("나중에"). 재시작하면 다시 뜬다.
  vaultMigrationDeferred: boolean;
  settings: MobileSettings;
  syncStatus: SyncStatus;
  groups: GroupRecord[];
  hosts: HostRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  knownHosts: KnownHostRecord[];
  secretMetadata: SecretMetadataRecord[];
  sessions: MobileSessionRecord[];
  sftpSessions: MobileSftpSessionRecord[];
  sftpTransfers: MobileSftpTransferRecord[];
  sftpCopyBuffer: SftpCopyBuffer | null;
  activeSessionTabId: string | null;
  activeConnectionTab: MobileConnectionTabRef | null;
  secretsByRef: Record<string, LoadedManagedSecretPayload>;
  pendingBrowserLoginState: string | null;
  pendingAwsSsoLogin: PendingAwsSsoLoginState | null;
  pendingServerKeyPrompt: PendingServerKeyPromptState | null;
  pendingCredentialPrompt: PendingCredentialPromptState | null;
  initializeApp: () => Promise<void>;
  handleAuthCallbackUrl: (url: string) => Promise<void>;
  startBrowserLogin: () => Promise<void>;
  cancelBrowserLogin: () => void;
  cancelAwsSsoLogin: () => void;
  reopenAwsSsoLogin: () => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  changeAccountPassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  setupVault: (passphrase: string) => Promise<void>;
  unlockVault: (passphrase: string) => Promise<void>;
  resetVault: () => Promise<void>;
  migrateVault: (passphrase: string) => Promise<void>;
  deferVaultMigration: () => void;
  changeVaultPassphrase: (
    currentPassphrase: string,
    nextPassphrase: string,
  ) => Promise<void>;
  syncNow: () => Promise<void>;
  updateSettings: (input: Partial<MobileSettings>) => Promise<void>;
  connectToHost: (hostId: string) => Promise<string | null>;
  saveHost: (input: MobileHostDraftInput) => Promise<void>;
  deleteHost: (hostId: string) => Promise<void>;
  duplicateSession: (sessionId: string) => Promise<string | null>;
  setActiveConnectionTab: (tab: MobileConnectionTabRef | null) => void;
  setActiveSessionTab: (sessionId: string | null) => void;
  resumeSession: (sessionId: string) => Promise<string | null>;
  disconnectSession: (sessionId: string) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  writeToSession: (sessionId: string, data: string) => Promise<void>;
  subscribeToSessionTerminal: (
    sessionId: string,
    handlers: SessionTerminalSubscription,
  ) => () => void;
  acceptServerKeyPrompt: () => Promise<void>;
  rejectServerKeyPrompt: () => Promise<void>;
  submitCredentialPrompt: (input: HostSecretInput) => Promise<void>;
  cancelCredentialPrompt: () => void;
  openSftpForSession: (sessionId: string) => Promise<string | null>;
  disconnectSftpSession: (sftpSessionId: string) => Promise<void>;
  listSftpDirectory: (sftpSessionId: string, path?: string) => Promise<void>;
  downloadSftpFile: (
    sftpSessionId: string,
    remotePath: string,
  ) => Promise<void>;
  downloadSftpEntries: (
    sftpSessionId: string,
    remotePaths: string[],
  ) => Promise<void>;
  uploadSftpFile: (sftpSessionId: string) => Promise<void>;
  createSftpDirectory: (sftpSessionId: string, name: string) => Promise<void>;
  renameSftpEntry: (
    sftpSessionId: string,
    sourcePath: string,
    nextName: string,
  ) => Promise<void>;
  chmodSftpEntry: (
    sftpSessionId: string,
    remotePath: string,
    mode: string,
  ) => Promise<void>;
  deleteSftpEntries: (sftpSessionId: string, paths: string[]) => Promise<void>;
  copySftpEntries: (sftpSessionId: string, paths: string[]) => void;
  pasteSftpEntries: (sftpSessionId: string) => Promise<void>;
  clearSftpCopyBuffer: () => void;
}

const runtimeSessions = new Map<string, RuntimeSession>();
const runtimeSftpSessions = new Map<string, SftpRuntimeSession>();
// 세션별 터미널 구독 세대. 재구독이 잦아 낡은 리스너가 겹치는데, 이 값으로
// 배달 시점에 차단한다(자세한 이유는 subscribeToSessionTerminal 참고).
const terminalSubscriptionGenerations = new Map<string, number>();
const pendingSessionConnections = new Set<string>();
const pendingSftpConnections = new Set<string>();
const runtimeSessionSnapshots = new Map<string, string>();
const runtimeSnapshotFlushTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
let runtimeSubscriptionCounter = 0;

let initializePromise: Promise<void> | null = null;
let syncPromise: Promise<void> | null = null;
// 진행 중 syncPromise 가 캡처한 볼트 세대. 세대가 다르면 그 결과는 버려질 예정이므로
// 새 호출자는 기다렸다가 새로 돈다(잠금해제 직후의 pull 이 stale dedup 으로 유실 방지).
let syncPromiseGeneration = 0;
let offlineRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let offlineRecoveryAttempt = 0;
let offlineRecoveryInFlight = false;
let offlineRecoveryKey: string | null = null;
let secureStateRestoreVersion = 0;
// 마지막으로 서버와 맞춘 리비전(ETag). 폴링의 If-None-Match 로 보내 변경 없으면 304 로
// 조기 종료한다. 메모리에만 두고, 로그아웃/계정교체 시 초기화한다.
let lastSyncRevision: string | null = null;
// 볼트 전이(설정/잠금해제/초기화/세대 교체) 세대 토큰. in-flight sync 는 시작 시점의
// 값을 캡처하고, 완료 시 달라져 있으면 결과를 버린다 — 잠긴 상태에서 시작된 sync 가
// 방금 잠금해제/재설정된 상태를 덮어쓰는 레이스를 막는다.
let vaultSyncGeneration = 0;
// 30초 폴링 타이머 + 포그라운드 리스너 정리 함수.
let syncPollTimer: ReturnType<typeof setInterval> | null = null;
let appStateSubscription: { remove: () => void } | null = null;
let pendingServerKeyResolver: ((accepted: boolean) => void) | null = null;
let pendingCredentialResolver:
  | ((value: HostSecretInput | null) => void)
  | null = null;
let pendingAwsSsoCancelHandler: (() => void) | null = null;

function stopSyncPolling(): void {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
}

// pull 을 돌려도 되는 상태인지 — 인증 + 볼트가 잠금해제(v2) 또는 legacy(v1, 세션 키로 동기화
// 가능). 데스크톱(App.tsx)과 동일 기준. 로그아웃/잠김/설정필요 상태에서는 폴링하지 않는다.
function shouldPollSync(
  state: ReturnType<typeof useMobileAppStore.getState>,
): boolean {
  return (
    state.auth.status === 'authenticated' &&
    (state.vault.status === 'unlocked' || state.vault.status === 'legacy')
  );
}

function startSyncPolling(): void {
  if (syncPollTimer) {
    return;
  }
  syncPollTimer = setInterval(() => {
    const state = useMobileAppStore.getState();
    // 중복은 syncWithSession 의 syncPromise 가이드가 막는다.
    if (shouldPollSync(state)) {
      void state.syncNow().catch(() => undefined);
    }
  }, 30_000);
}

// 폴링 라이프사이클을 앱 수명 동안 한 번 설정한다: 포그라운드 복귀 시 즉시 pull + 30초
// 주기 시작, 백그라운드로 가면 타이머 정지(배터리). 조건부 GET(ETag)이라 변경 없으면 304.
function ensureSyncPollingLifecycle(): void {
  if (!appStateSubscription) {
    appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        const state = useMobileAppStore.getState();
        // 로그아웃 상태에서 포그라운드 복귀 시 유휴 타이머를 돌리지 않는다.
        if (shouldPollSync(state)) {
          startSyncPolling();
          void state.syncNow().catch(() => undefined);
        }
      } else {
        stopSyncPolling();
      }
    });
  }
  if (AppState.currentState === 'active') {
    startSyncPolling();
  }
}

// 서버 capability 불리언 → supported/unsupported/unknown 3-state. undefined(=서버 미응답)
// 은 unknown. (vaultE2ee 는 "응답했으나 미광고=unsupported" 라는 다른 의미라 별도 처리.)
function toServerSupport(cap: boolean | undefined): AwsProfilesServerSupport {
  return cap === true ? 'supported' : cap === false ? 'unsupported' : 'unknown';
}

// 스냅샷의 전체 레코드 수(tombstone 포함) — "서버가 진짜 비어 있는가" 판정에 쓴다.
// 사용자가 데이터를 전부 삭제한 경우는 tombstone 이 남아 0 이 되지 않는다. 0 은 초기화
// (hard delete) 직후나 서버 유실뿐이다.
function countSyncPayloadRecords(payload: SyncPayloadV2): number {
  return (
    (payload.groups?.length ?? 0) +
    (payload.hosts?.length ?? 0) +
    (payload.secrets?.length ?? 0) +
    (payload.knownHosts?.length ?? 0) +
    (payload.portForwards?.length ?? 0) +
    (payload.dnsOverrides?.length ?? 0) +
    (payload.preferences?.length ?? 0) +
    (payload.awsProfiles?.length ?? 0) +
    (payload.snippets?.length ?? 0)
  );
}

function sortHosts(hosts: HostRecord[]): HostRecord[] {
  return [...hosts].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function sortGroups(groups: GroupRecord[]): GroupRecord[] {
  return [...groups].sort((left, right) => left.path.localeCompare(right.path));
}

function sortKnownHosts(knownHosts: KnownHostRecord[]): KnownHostRecord[] {
  return [...knownHosts].sort((left, right) => {
    const hostComparison = left.host.localeCompare(right.host);
    if (hostComparison !== 0) {
      return hostComparison;
    }
    return left.port - right.port;
  });
}

// 최근 활동 순(내림차순) 정렬. `sessions` 자체에는 적용하지 않는다 — 그 배열이
// 터미널 탭 순서이고, 원격 출력마다 lastEventAt 이 갱신되므로 정렬하면 사용자가
// 타이핑하는 중에 탭이 손가락 밑에서 맨 왼쪽으로 튄다.
//
// 그래서 탭 순서는 안정적(추가된 순서)으로 두고, 최근순은 그게 실제로 필요한
// 곳에서만 쓴다: 목록 표시(ConnectionsScreen)와 영속 세션 잘라내기.
export function sortSessionsByRecency(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  return [...sessions].sort((left, right) =>
    right.lastEventAt.localeCompare(left.lastEventAt),
  );
}

// v1(레거시) 볼트 키 추출 — v1 세션에는 서버가 내려준 DEK 원문이 그대로 들어 있다.
function requireLegacyVaultKey(session: AuthSession): string {
  const keyBase64 = session.vaultBootstrap.keyBase64;
  if (!keyBase64) {
    throw new Error(
      t('store.noVaultKey'),
    );
  }
  return keyBase64;
}

// 캐시된 DEK 의 verifier 를 계산한다. 손상된 캐시(길이 오류 등)는 "캐시 없음"으로 취급.
function verifierOfCachedDek(
  dekBase64: string | null | undefined,
): string | null {
  if (!dekBase64) {
    return null;
  }
  try {
    return computeVaultDekVerifier(toByteArray(dekBase64));
  } catch {
    return null;
  }
}

function createVaultCacheOwner(
  session: AuthSession,
  serverUrl: string,
): VaultCacheOwner {
  return {
    userId: session.user.id,
    serverUrl: normalizeServerUrl(serverUrl),
  };
}

function vaultCacheOwnersEqual(
  left: VaultCacheOwner | undefined,
  right: VaultCacheOwner,
): boolean {
  return left?.userId === right.userId && left.serverUrl === right.serverUrl;
}

// e2ee descriptor + 캐시(또는 로컬) DEK 로 볼트 상태를 결정하고 keychain 부수효과(세대
// 교체 시 폐기 / epoch 채택 저장)를 적용한다. 판정은 shared-core 의 decideVaultAccess
// (epoch 순서 + verifier 정체성 증명) 하나뿐 — resolveStoredVaultState 와
// syncWithSession 이 공유하고, hot-path 신뢰나 미검증 임시 채택 같은 추정이 없다.
async function applyVaultCacheDecision(
  descriptor: {
    wrappedDekBase64: string;
    kdf: VaultKdfDescriptor;
    epoch?: number;
    dekVerifierBase64?: string;
    wrapRevision?: number;
  },
  cached: StoredVaultDek | null,
  // descriptor 가 캐시보다 낡은 응답일 때(ignore-descriptor) 유지할 현재 상태.
  currentVault: MobileVaultState,
  owner: VaultCacheOwner,
): Promise<MobileVaultState> {
  const decision = decideVaultAccess({
    descriptorEpoch: descriptor.epoch,
    descriptorVerifier: descriptor.dekVerifierBase64,
    cachedDekVerifier: verifierOfCachedDek(cached?.dekBase64),
    cachedEpoch: cached?.epoch ?? null,
    descriptorWrapRevision: descriptor.wrapRevision,
    cachedWrapRevision: cached?.wrapRevision ?? null,
  });
  switch (decision.kind) {
    case 'ignore-descriptor': {
      // descriptor 가 내 캐시 epoch 보다 낡았다(자기 재설정 직후의 in-flight 응답,
      // 또는 재설정 후 갱신되지 못한 저장 세션). 살아있는 unlocked 상태가 있으면 그대로
      // 유지하고, 콜드 부팅(none 등)이면 캐시가 진실이므로 캐시로 복원한다 — 안 하면
      // 오프라인 재시작에서 볼트가 none 으로 떠 복원이 깨진다.
      if (currentVault.status === 'unlocked') {
        return { ...currentVault, owner };
      }
      return unlockedVaultStateFromCache(cached as StoredVaultDek);
    }
    case 'locked':
      if (cached) {
        // verifier 불일치 = DEK 세대 교체(다른 기기의 초기화+재설정). 옛 캐시를
        // 버리고 새 암호를 받는다.
        await clearStoredVaultDek().catch(() => undefined);
      }
      return {
        status: 'locked',
        wrappedDekBase64: descriptor.wrappedDekBase64,
        kdf: descriptor.kdf,
        epoch: descriptor.epoch ?? 0,
        wrapRevision: descriptor.wrapRevision ?? 0,
        dekVerifierBase64: descriptor.dekVerifierBase64,
      };
    case 'unlocked':
    case 'unlocked-unverifiable': {
      // unlocked: verifier 일치(암호학적 증명). unlocked-unverifiable: verifier 이전
      // 볼트/구서버 — 검증 수단이 없어 기존 신뢰를 유지한다(잠금해제 시 백필로 소멸).
      const cachedDek = cached as StoredVaultDek;
      // verifier/암호로 DEK 정체성이 확인된 descriptor를 완전한 v2 레코드로 저장한다.
      const dekVerifierBase64 =
        descriptor.dekVerifierBase64 ??
        verifierOfCachedDek(cachedDek.dekBase64)!;
      if (
        cachedDek.epoch !== decision.epoch ||
        cachedDek.wrappedDekBase64 !== descriptor.wrappedDekBase64 ||
        cachedDek.dekVerifierBase64 !== dekVerifierBase64 ||
        cachedDek.wrapRevision !== (descriptor.wrapRevision ?? 0) ||
        !vaultCacheOwnersEqual(cachedDek.owner, owner) ||
        !vaultKdfDescriptorsEqual(cachedDek.kdf, descriptor.kdf)
      ) {
        await saveStoredVaultDek(cachedDek.dekBase64, decision.epoch, owner, {
          wrappedDekBase64: descriptor.wrappedDekBase64,
          kdf: descriptor.kdf,
          dekVerifierBase64,
          wrapRevision: descriptor.wrapRevision ?? 0,
        }).catch(() => undefined);
      }
      return {
        status: 'unlocked',
        dekBase64: cachedDek.dekBase64,
        wrappedDekBase64: descriptor.wrappedDekBase64,
        kdf: descriptor.kdf,
        epoch: decision.epoch,
        wrapRevision: descriptor.wrapRevision ?? 0,
        owner,
        dekVerifierBase64,
      };
    }
  }
}

function vaultKdfDescriptorsEqual(
  left: VaultKdfDescriptor | undefined,
  right: VaultKdfDescriptor,
): boolean {
  return (
    left?.algorithm === right.algorithm &&
    left.saltBase64 === right.saltBase64 &&
    left.memoryKib === right.memoryKib &&
    left.timeCost === right.timeCost &&
    left.parallelism === right.parallelism
  );
}

// 저장된 세션에서 볼트 상태를 복원한다. E2EE(v2) 잠금해제는 서버 없이도 keychain 의
// DEK 캐시(또는 동기화 암호 입력)만으로 가능해 오프라인 경로에서도 동작한다.
async function resolveVaultStateForSession(
  session: AuthSession,
  currentVault: MobileVaultState,
  serverUrl: string,
): Promise<MobileVaultState> {
  let descriptor: ReturnType<typeof resolveVaultDescriptorState>;
  try {
    descriptor = resolveVaultDescriptorState(session.vaultBootstrap);
  } catch (error) {
    return {
      status: 'error',
      errorMessage:
        error instanceof Error && error.message.trim()
          ? error.message
          : t('store.vaultDataUnusable'),
    };
  }

  const owner = createVaultCacheOwner(session, serverUrl);
  let stored: StoredVaultDek | null;
  try {
    stored =
      currentVault.status === 'unlocked'
        ? {
            dekBase64: currentVault.dekBase64,
            epoch: currentVault.epoch as number | null,
            wrapRevision: currentVault.wrapRevision as number | null,
            owner: currentVault.owner,
            ...(hasCoherentVaultDescriptor(currentVault)
              ? {
                  wrappedDekBase64: currentVault.wrappedDekBase64,
                  kdf: currentVault.kdf,
                  dekVerifierBase64:
                    verifierOfCachedDek(currentVault.dekBase64) ?? undefined,
                }
              : {}),
          }
        : await loadStoredVaultDek();
  } catch {
    // 유효한 v2 descriptor가 있으면 캐시가 없어도 암호 입력으로 복구할 수 있다.
    // Keychain 일시 오류를 잘못된 descriptor 오류로 승격하지 않는다.
    stored = null;
  }

  if (stored?.owner && !vaultCacheOwnersEqual(stored.owner, owner)) {
    await clearStoredVaultDek();
    stored = null;
  } else if (stored && !stored.owner) {
    // owner 도입 전 캐시는 현재 계정 소유임을 암호학적으로 증명할 수 있을 때만 승격한다.
    const ownerProven =
      (descriptor.kind === 'legacy' &&
        descriptor.keyBase64 === stored.dekBase64) ||
      (descriptor.kind === 'e2ee' &&
        Boolean(descriptor.dekVerifierBase64) &&
        descriptor.dekVerifierBase64 === verifierOfCachedDek(stored.dekBase64));
    if (!ownerProven) {
      await clearStoredVaultDek();
      stored = null;
    }
  }

  try {
    if (descriptor.kind === 'legacy' || descriptor.kind === 'setup-required') {
      const descriptorEpoch = descriptor.epoch ?? 0;
      if (
        stored?.epoch !== null &&
        stored?.epoch !== undefined &&
        descriptorEpoch < stored.epoch
      ) {
        return unlockedVaultStateFromCache(stored);
      }
      if (
        descriptor.kind === 'setup-required' &&
        descriptor.epoch === undefined &&
        stored?.wrappedDekBase64 &&
        stored.kdf
      ) {
        return unlockedVaultStateFromCache(stored);
      }
    }
    if (descriptor.kind === 'legacy') {
      void saveStoredVaultDek(
        descriptor.keyBase64,
        descriptor.epoch ?? 0,
        owner,
      ).catch(() => undefined);
      return {
        status: 'legacy',
        epoch: descriptor.epoch ?? 0,
        migrationRequired: descriptor.e2eeRequired === true,
      };
    }
    if (descriptor.kind === 'setup-required') {
      if (stored) {
        await clearStoredVaultDek().catch(() => undefined);
      }
      return { status: 'setup-required', epoch: descriptor.epoch ?? 0 };
    }
    return applyVaultCacheDecision(descriptor, stored, currentVault, owner);
  } catch (error) {
    return {
      status: 'error',
      errorMessage:
        error instanceof Error && error.message.trim()
          ? error.message
          : t('store.vaultStateRestoreFailed'),
    };
  }
}

async function resolveStoredVaultState(
  session: AuthSession,
): Promise<MobileVaultState> {
  return resolveVaultStateForSession(
    session,
    useMobileAppStore.getState().vault,
    useMobileAppStore.getState().settings.serverUrl,
  );
}

function isLiveSession(session: MobileSessionRecord): boolean {
  return session.status !== 'closed';
}

function getLiveSessions(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  return sessions.filter(isLiveSession);
}

function sortSftpSessions(
  sftpSessions: MobileSftpSessionRecord[],
): MobileSftpSessionRecord[] {
  return [...sftpSessions].sort((left, right) =>
    right.lastEventAt.localeCompare(left.lastEventAt),
  );
}

function isLiveSftpSession(session: MobileSftpSessionRecord): boolean {
  return session.status !== 'closed';
}

function getLiveSftpSessions(
  sftpSessions: MobileSftpSessionRecord[],
): MobileSftpSessionRecord[] {
  return sortSftpSessions(sftpSessions).filter(isLiveSftpSession);
}

function normalizeActiveConnectionTab(
  sessions: MobileSessionRecord[],
  sftpSessions: MobileSftpSessionRecord[],
  currentTab: MobileConnectionTabRef | null,
  preferredTab?: MobileConnectionTabRef | null,
): MobileConnectionTabRef | null {
  const liveSessions = getLiveSessions(sessions);
  const liveSftpSessions = getLiveSftpSessions(sftpSessions);
  const isValidTab = (tab: MobileConnectionTabRef | null | undefined) => {
    if (!tab) {
      return false;
    }
    if (tab.kind === 'terminal') {
      return liveSessions.some(session => session.id === tab.id);
    }
    return liveSftpSessions.some(session => session.id === tab.id);
  };

  if (isValidTab(preferredTab)) {
    return preferredTab ?? null;
  }
  if (isValidTab(currentTab)) {
    return currentTab;
  }
  const firstTerminal = liveSessions[0];
  if (firstTerminal) {
    return { kind: 'terminal', id: firstTerminal.id };
  }
  const firstSftp = liveSftpSessions[0];
  if (firstSftp) {
    return { kind: 'sftp', id: firstSftp.id };
  }
  return null;
}

function resolveActiveSessionTabId(
  sessions: MobileSessionRecord[],
  currentActiveSessionTabId: string | null,
  preferredSessionId?: string | null,
): string | null {
  const liveSessions = getLiveSessions(sessions);
  if (preferredSessionId) {
    const preferredSession = liveSessions.find(
      session => session.id === preferredSessionId,
    );
    if (preferredSession) {
      return preferredSession.id;
    }
  }

  if (currentActiveSessionTabId) {
    const currentSession = liveSessions.find(
      session => session.id === currentActiveSessionTabId,
    );
    if (currentSession) {
      return currentSession.id;
    }
  }

  return liveSessions[0]?.id ?? null;
}

function patchSftpSessionRecord(
  sftpSessions: MobileSftpSessionRecord[],
  sessionId: string,
  patch: Partial<MobileSftpSessionRecord>,
): MobileSftpSessionRecord[] {
  return sortSftpSessions(
    sftpSessions.map(session =>
      session.id === sessionId ? { ...session, ...patch } : session,
    ),
  );
}

function upsertSftpSessionRecord(
  sftpSessions: MobileSftpSessionRecord[],
  nextRecord: MobileSftpSessionRecord,
): MobileSftpSessionRecord[] {
  const existingIndex = sftpSessions.findIndex(
    session => session.id === nextRecord.id,
  );
  if (existingIndex === -1) {
    return sortSftpSessions([nextRecord, ...sftpSessions]);
  }

  const nextSessions = [...sftpSessions];
  nextSessions[existingIndex] = nextRecord;
  return sortSftpSessions(nextSessions);
}

function patchSftpTransferRecord(
  transfers: MobileSftpTransferRecord[],
  transferId: string,
  patch: Partial<MobileSftpTransferRecord>,
): MobileSftpTransferRecord[] {
  return transfers.map(transfer =>
    transfer.id === transferId
      ? {
          ...transfer,
          ...patch,
          updatedAt: patch.updatedAt ?? new Date().toISOString(),
        }
      : transfer,
  );
}

function trimSnapshot(value: string): string {
  const sanitized = sanitizeTerminalSnapshot(value);
  if (sanitized.length <= MAX_TERMINAL_SNAPSHOT_CHARS) {
    return sanitized;
  }
  return sanitized.slice(-MAX_TERMINAL_SNAPSHOT_CHARS);
}

function patchSessionRecord(
  sessions: MobileSessionRecord[],
  sessionId: string,
  patch: Partial<MobileSessionRecord>,
): MobileSessionRecord[] {
  return sessions.map(session =>
    session.id === sessionId ? { ...session, ...patch } : session,
  );
}

function upsertSessionRecord(
  sessions: MobileSessionRecord[],
  nextRecord: MobileSessionRecord,
): MobileSessionRecord[] {
  const existingIndex = sessions.findIndex(
    session => session.id === nextRecord.id,
  );
  if (existingIndex === -1) {
    return [...sessions, nextRecord];
  }

  const nextSessions = [...sessions];
  nextSessions[existingIndex] = nextRecord;
  return nextSessions;
}

function createSessionRecord(host: HostRecord): MobileSessionRecord {
  const now = new Date().toISOString();
  const id = createLocalId('session');
  const connectionKind = host.kind === 'aws-ec2' ? 'aws-ssm' : 'ssh';
  const connectionDetails =
    host.kind === 'aws-ec2'
      ? [host.awsProfileName, host.awsRegion, host.awsInstanceId]
          .filter(Boolean)
          .join(' · ')
      : isSshHostRecord(host)
      ? `${host.username}@${host.hostname}:${host.port}`
      : host.label;
  return {
    id,
    sessionId: id,
    hostId: host.id,
    title: host.label,
    connectionKind,
    connectionDetails,
    status: 'connecting',
    hasReceivedOutput: false,
    isRestorable: true,
    lastViewportSnapshot: '',
    lastEventAt: now,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    errorMessage: null,
  };
}

function createSftpSessionRecord(
  sourceSession: MobileSessionRecord,
  host: SshHostRecord | AwsEc2HostRecord,
): MobileSftpSessionRecord {
  const now = new Date().toISOString();
  return {
    id: createLocalId('sftp'),
    hostId: host.id,
    sourceSessionId: sourceSession.id,
    title: `${host.label} SFTP`,
    status: 'connecting',
    currentPath: '.',
    listing: null,
    errorMessage: null,
    lastEventAt: now,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
  };
}

// Adapts an engine SFTP session to MobileSftpConnection, the port the file
// browser and transfer loops already speak — the same port the AWS backend is
// adapted to above. Doing it here keeps the ~25 call sites and the chunked
// transfer loops untouched by the engine swap.
function wrapEngineSftpConnection(
  sftp: EngineSftpConnection,
): MobileSftpConnection {
  return {
    listDirectory: async path => {
      const listing = await sftp.list(path);
      return { path: listing.path, entries: listing.entries };
    },
    readFileChunk: async (path, offset, length) => {
      const chunk = await sftp.readChunk(path, offset, length);
      const bytes = chunk.bytes;
      return {
        // The transfer loops advance by bytesRead, which the engine does not
        // report separately: what came back is what was read.
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        bytesRead: bytes.byteLength,
        eof: chunk.eof,
      };
    },
    writeFileChunk: (path, offset, data) =>
      sftp.writeChunk(path, offset, new Uint8Array(data)),
    mkdir: path => sftp.mkdir(path),
    rename: (sourcePath, targetPath) => sftp.rename(sourcePath, targetPath),
    chmod: (path, permissions) => sftp.chmod(path, permissions),
    delete: path => sftp.remove(path),
    close: () => sftp.close(),
  };
}

function joinRemotePath(parent: string, name: string): string {
  const cleanName = name.trim().replace(/^\/+/, '');
  if (!cleanName) {
    return parent || '.';
  }
  if (!parent || parent === '.') {
    return cleanName;
  }
  if (parent === '/') {
    return `/${cleanName}`;
  }
  return `${parent.replace(/\/+$/, '')}/${cleanName}`;
}

function parentRemotePath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex <= 0) {
    return normalized.startsWith('/') ? '/' : '.';
  }
  return normalized.slice(0, slashIndex);
}

function remoteBasename(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function parseUnixMode(value: string): number {
  const trimmed = value.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) {
    throw new Error(t('store.permissionOctal'));
  }
  return Number.parseInt(trimmed, 8);
}

function makeCopyName(requestedName: string, index: number): string {
  const dotIndex = requestedName.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < requestedName.length - 1;
  const stem = hasExtension ? requestedName.slice(0, dotIndex) : requestedName;
  const extension = hasExtension ? requestedName.slice(dotIndex) : '';
  const suffix = index === 1 ? ' copy' : ` copy ${index}`;
  return `${stem}${suffix}${extension}`;
}

function resolveUniqueName(existingNames: Set<string>, requestedName: string) {
  if (!existingNames.has(requestedName)) {
    return requestedName;
  }
  let index = 1;
  for (;;) {
    const candidate = makeCopyName(requestedName, index);
    if (!existingNames.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

async function listRemoteDirectory(
  connection: MobileSftpConnection,
  path: string,
): Promise<DirectoryListing> {
  return connection.listDirectory(path);
}

async function resolveRemoteEntry(
  connection: MobileSftpConnection,
  path: string,
  currentListing?: DirectoryListing | null,
): Promise<FileEntry> {
  const currentEntry = currentListing?.entries.find(
    entry => entry.path === path,
  );
  if (currentEntry) {
    return currentEntry;
  }

  const parentListing = await listRemoteDirectory(
    connection,
    parentRemotePath(path),
  );
  const parentEntry = parentListing.entries.find(entry => entry.path === path);
  if (parentEntry) {
    return parentEntry;
  }

  return {
    name: remoteBasename(path) || path,
    path,
    isDirectory: false,
    size: 0,
    mtime: '',
    kind: 'unknown',
  };
}

async function streamRemoteFileToLocalDocument(
  connection: MobileSftpConnection,
  remotePath: string,
  destinationUri: string,
  onProgress: (bytesTransferred: number) => void,
): Promise<number> {
  let offset = 0;
  for (;;) {
    const chunk = await connection.readFileChunk(
      remotePath,
      offset,
      SFTP_TRANSFER_CHUNK_SIZE,
    );
    const bytes = Buffer.from(new Uint8Array(chunk.bytes));
    const bytesRead = chunk.bytesRead || bytes.byteLength;
    if (bytesRead <= 0) {
      break;
    }
    await writeDownloadChunk(
      destinationUri,
      bytes.toString('base64'),
      offset > 0,
    );
    offset += bytesRead;
    onProgress(offset);
    if (chunk.eof || bytesRead < SFTP_TRANSFER_CHUNK_SIZE) {
      break;
    }
  }
  return offset;
}

async function copyRemoteFile(
  connection: MobileSftpConnection,
  sourcePath: string,
  targetPath: string,
  onProgress: (bytesTransferred: number) => void,
): Promise<number> {
  let offset = 0;
  for (;;) {
    const chunk = await connection.readFileChunk(
      sourcePath,
      offset,
      SFTP_TRANSFER_CHUNK_SIZE,
    );
    const bytes = Buffer.from(new Uint8Array(chunk.bytes));
    const bytesRead = chunk.bytesRead || bytes.byteLength;
    if (bytesRead <= 0) {
      break;
    }
    await connection.writeFileChunk(
      targetPath,
      offset,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    offset += bytesRead;
    onProgress(offset);
    if (chunk.eof || bytesRead < SFTP_TRANSFER_CHUNK_SIZE) {
      break;
    }
  }
  return offset;
}

async function downloadRemoteEntryToDirectory(
  connection: MobileSftpConnection,
  entry: FileEntry,
  parentDirectoryUri: string,
  onProgress: (bytesTransferred: number) => void,
): Promise<number> {
  if (entry.isDirectory) {
    const childDirectory = await createDownloadDirectory(
      parentDirectoryUri,
      entry.name,
    );
    const listing = await listRemoteDirectory(connection, entry.path);
    let totalBytes = 0;
    for (const child of listing.entries) {
      totalBytes += await downloadRemoteEntryToDirectory(
        connection,
        child,
        childDirectory.uri,
        bytesTransferred => onProgress(totalBytes + bytesTransferred),
      );
      onProgress(totalBytes);
    }
    return totalBytes;
  }

  const destination = await createDownloadFile(parentDirectoryUri, entry.name);
  return streamRemoteFileToLocalDocument(
    connection,
    entry.path,
    destination.uri,
    onProgress,
  );
}

async function resolveUniqueRemotePath(
  connection: MobileSftpConnection,
  parentPath: string,
  requestedName: string,
): Promise<string> {
  const listing = await listRemoteDirectory(connection, parentPath);
  const uniqueName = resolveUniqueName(
    new Set(listing.entries.map(entry => entry.name)),
    requestedName,
  );
  return joinRemotePath(parentPath, uniqueName);
}

async function copyRemoteEntryToPath(
  connection: MobileSftpConnection,
  entry: SftpCopyBufferEntry | FileEntry,
  targetPath: string,
  onProgress: (bytesTransferred: number) => void,
): Promise<number> {
  if (entry.isDirectory) {
    await connection.mkdir(targetPath);
    const listing = await listRemoteDirectory(connection, entry.path);
    let totalBytes = 0;
    for (const child of listing.entries) {
      totalBytes += await copyRemoteEntryToPath(
        connection,
        child,
        joinRemotePath(targetPath, child.name),
        bytesTransferred => onProgress(totalBytes + bytesTransferred),
      );
      onProgress(totalBytes);
    }
    return totalBytes;
  }

  return copyRemoteFile(connection, entry.path, targetPath, onProgress);
}

async function deleteRemoteEntryRecursive(
  connection: MobileSftpConnection,
  entry: FileEntry,
): Promise<void> {
  if (entry.isDirectory) {
    const listing = await listRemoteDirectory(connection, entry.path);
    for (const child of listing.entries) {
      await deleteRemoteEntryRecursive(connection, child);
    }
  }
  await connection.delete(entry.path);
}

function compactPersistedSessions(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  const keep = new Set(
    sortSessionsByRecency(sessions)
      .slice(0, MAX_PERSISTED_SESSIONS)
      .map(session => session.id),
  );
  return sessions
    .filter(session => keep.has(session.id))
    .map(session => ({
      ...session,
      lastViewportSnapshot: '',
    }));
}

function normalizePersistedSessionsForColdStart(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  const now = new Date().toISOString();
  return sessions.map(session => {
    const normalizedSession: MobileSessionRecord = !isLiveSession(session)
      ? session
      : {
          ...session,
          status: 'closed',
          errorMessage: null,
          lastEventAt: now,
          lastDisconnectedAt: session.lastDisconnectedAt ?? now,
        };

    return {
      ...normalizedSession,
      lastViewportSnapshot: '',
    };
  });
}

function isSecureStateRestoreCurrent(
  currentVersion: number,
  serverUrl: string,
  auth: AuthState,
  currentServerUrl: string,
): boolean {
  return (
    secureStateRestoreVersion === currentVersion &&
    currentServerUrl === serverUrl &&
    Boolean(auth.session)
  );
}

function buildOfflineState(session: AuthSession, reason: string) {
  return {
    expiresAt: session.offlineLease.expiresAt,
    lastOnlineAt: new Date().toISOString(),
    reason,
  };
}

function isOfflineLeaseActive(
  session: AuthSession | null | undefined,
): boolean {
  if (!session?.offlineLease.expiresAt) {
    return false;
  }
  return new Date(session.offlineLease.expiresAt).getTime() > Date.now();
}

function isLikelyNetworkError(error: unknown): boolean {
  return !(error instanceof ApiError) || typeof error.status !== 'number';
}

function getUnknownErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return '';
}

function isAuthExpiredError(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) {
    return true;
  }

  const message = getUnknownErrorMessage(error).toLowerCase();
  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전 메시지와
  // 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  return (
    message.includes('token has invalid claims') ||
    message.includes('invalid claims') ||
    (message.includes('jwt') && message.includes('expired')) ||
    message.includes('세션이 만료') ||
    message.includes('session has expired')
  );
}

function buildOfflineRecoveryKey(
  session: AuthSession,
  serverUrl: string,
): string {
  return `${serverUrl.trim()}::${session.tokens.refreshToken}`;
}

function createEmptyProtectedState(): Pick<
  MobileAppState,
  | 'vault'
  | 'groups'
  | 'hosts'
  | 'awsProfiles'
  | 'knownHosts'
  | 'secretMetadata'
  | 'secretsByRef'
  | 'sessions'
  | 'sftpSessions'
  | 'sftpTransfers'
  | 'sftpCopyBuffer'
  | 'activeSessionTabId'
  | 'activeConnectionTab'
> {
  return {
    vault: { status: 'none' },
    groups: [],
    hosts: [],
    awsProfiles: [],
    knownHosts: [],
    secretMetadata: [],
    secretsByRef: {},
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    activeSessionTabId: null,
    activeConnectionTab: null,
  };
}

function parseAuthCallbackUrl(
  url: string,
): { code: string; state?: string | null } | null {
  if (!url.startsWith('dolgate://auth/callback')) {
    return null;
  }

  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) {
    return null;
  }

  const rawQuery = url.slice(queryIndex + 1);
  const searchParams = new URLSearchParams(rawQuery);
  const code = searchParams.get('code');
  if (!code) {
    return null;
  }

  return {
    code,
    state: searchParams.get('state'),
  };
}

function getKnownHostStatus(
  knownHosts: KnownHostRecord[],
  info: MobileServerPublicKeyInfo,
): {
  status: 'trusted' | 'untrusted' | 'mismatch';
  existing: KnownHostRecord | null;
} {
  const sameAlgorithm =
    knownHosts.find(
      record =>
        record.host === info.host &&
        record.port === info.port &&
        record.algorithm === info.algorithm,
    ) ?? null;

  if (sameAlgorithm) {
    return sameAlgorithm.publicKeyBase64 === info.keyBase64
      ? { status: 'trusted', existing: sameAlgorithm }
      : { status: 'mismatch', existing: sameAlgorithm };
  }

  return { status: 'untrusted', existing: null };
}

function disconnectRuntimeSession(sessionId: string): void {
  const runtime = runtimeSessions.get(sessionId);
  if (runtime?.kind === 'aws-ssm') {
    try {
      runtime.socket.close();
    } catch {}
    runtime.subscribers.clear();
    runtime.replayChunks.length = 0;
  }

  runtimeSessions.delete(sessionId);
  pendingSessionConnections.delete(sessionId);
  runtimeSessionSnapshots.delete(sessionId);
  const pendingFlush = runtimeSnapshotFlushTimers.get(sessionId);
  if (pendingFlush) {
    clearTimeout(pendingFlush);
    runtimeSnapshotFlushTimers.delete(sessionId);
  }
}

async function closeSshRuntimeResources(
  connection: EngineConnection,
  shell: EngineShell | null,
  backgroundListenerId: number | null,
): Promise<void> {
  if (shell && backgroundListenerId !== null) {
    try {
      await shell.unfollow(backgroundListenerId);
    } catch {}
  }
  if (shell) {
    try {
      await shell.close();
    } catch {}
  }
  try {
    await connection.disconnect();
  } catch {}
}

async function disposeRuntimeSession(sessionId: string): Promise<void> {
  const runtime = runtimeSessions.get(sessionId);
  // Ownership is removed before native close calls. Their callbacks can re-enter
  // this function, and the second call must be a no-op rather than closing twice.
  disconnectRuntimeSession(sessionId);
  if (runtime?.kind === 'ssh') {
    await closeSshRuntimeResources(
      runtime.connection,
      runtime.shell,
      runtime.backgroundListenerId,
    );
  }
}

function disconnectRuntimeSftpSession(sessionId: string): void {
  runtimeSftpSessions.delete(sessionId);
  pendingSftpConnections.delete(sessionId);
}

async function disposeRuntimeSftpSession(sessionId: string): Promise<void> {
  const runtime = runtimeSftpSessions.get(sessionId);
  disconnectRuntimeSftpSession(sessionId);
  if (runtime) {
    try {
      await runtime.connection.close();
    } catch {}
  }
}

async function disconnectAllRuntimeSessions(): Promise<void> {
  for (const sessionId of [...runtimeSessions.keys()]) {
    await disposeRuntimeSession(sessionId);
  }
  for (const sessionId of [...runtimeSftpSessions.keys()]) {
    await disposeRuntimeSftpSession(sessionId);
  }
}

export const useMobileAppStore = create<MobileAppState>()(
  persist(
    (set, get) => {
      const updateSecretsState = async (
        secretsByRef: Record<string, LoadedManagedSecretPayload>,
        hostsOverride?: HostRecord[],
      ) => {
        await saveStoredSecrets(secretsByRef);
        const nextHosts = hostsOverride ?? get().hosts;
        set({
          secretsByRef,
          secretMetadata: deriveSecretMetadata(nextHosts, secretsByRef),
        });
      };

      const clearPersistedSecureState = async (options?: {
        clearStoredAuthSession?: boolean;
      }) => {
        const tasks: Array<Promise<unknown>> = [
          clearStoredSecrets(),
          clearStoredAwsProfiles(),
          clearStoredAwsSsoTokens(),
        ];
        if (options?.clearStoredAuthSession !== false) {
          tasks.unshift(clearStoredAuthSession());
        }
        await Promise.allSettled(tasks);
      };

      const clearOfflineRecoveryLoop = () => {
        if (offlineRecoveryTimer) {
          clearTimeout(offlineRecoveryTimer);
          offlineRecoveryTimer = null;
        }
        offlineRecoveryAttempt = 0;
        offlineRecoveryInFlight = false;
        offlineRecoveryKey = null;
      };

      // 계정/서버 경계가 바뀌면 이전 대상에 속한 조건부 GET 표식과 진행 중 sync 결과를
      // 함께 무효화한다. syncPromise 자체를 비우면 이전 promise의 finally가 새 promise를
      // 지울 수 있으므로 generation guard로 결과만 폐기한다.
      const invalidateSyncRuntime = () => {
        lastSyncRevision = null;
        vaultSyncGeneration += 1;
        stopSyncPolling();
      };

      const clearPromptState = () => {
        pendingServerKeyResolver?.(false);
        pendingServerKeyResolver = null;
        pendingCredentialResolver?.(null);
        pendingCredentialResolver = null;
        pendingAwsSsoCancelHandler?.();
        pendingAwsSsoCancelHandler = null;
        set({
          pendingAwsSsoLogin: null,
          pendingServerKeyPrompt: null,
          pendingCredentialPrompt: null,
        });
      };

      const expireAuthSession = async (
        errorMessage = t('store.sessionExpiredSignIn'),
      ) => {
        clearOfflineRecoveryLoop();
        invalidateSyncRuntime();
        secureStateRestoreVersion += 1;
        clearPromptState();
        await disconnectAllRuntimeSessions();
        await clearPersistedSecureState();
        set({
          auth: {
            ...createUnauthenticatedState(),
            errorMessage,
          },
          syncStatus: {
            ...createDefaultSyncStatus(),
            status: 'error',
            errorMessage: t('store.sessionExpired'),
          },
          ...createEmptyProtectedState(),
          authGateResolved: true,
          secureStateReady: true,
          bootstrapping: false,
          pendingBrowserLoginState: null,
          pendingAwsSsoLogin: null,
          pendingServerKeyPrompt: null,
          pendingCredentialPrompt: null,
        });
      };

      const refreshAuthForConnection =
        async (): Promise<AuthSession | null> => {
          const currentSession = get().auth.session;
          if (!currentSession) {
            await expireAuthSession();
            return null;
          }

          try {
            const refreshed = await acceptAuthSession(
              await refreshAuthSession(
                get().settings.serverUrl,
                currentSession,
              ),
            );
            clearOfflineRecoveryLoop();
            set({
              auth: {
                status: 'authenticated',
                session: refreshed,
                offline: null,
                errorMessage: null,
              },
            });
            return refreshed;
          } catch (error) {
            if (isAuthExpiredError(error)) {
              await expireAuthSession();
              return null;
            }
            throw error;
          }
        };

      const resolveAuthGate = (
        nextState: Partial<
          Pick<
            MobileAppState,
            | 'auth'
            | 'syncStatus'
            | 'secretsByRef'
            | 'secretMetadata'
            | 'awsProfiles'
            | 'groups'
            | 'hosts'
            | 'knownHosts'
            | 'sessions'
            | 'sftpSessions'
            | 'sftpTransfers'
            | 'activeSessionTabId'
            | 'activeConnectionTab'
          >
        >,
        options?: {
          secureStateReady?: boolean;
        },
      ) => {
        set({
          ...nextState,
          bootstrapping: false,
          authGateResolved: true,
          secureStateReady: options?.secureStateReady ?? true,
        });
      };

      const isSessionRecoveryContextCurrent = (
        session: AuthSession,
        serverUrl: string,
      ) => {
        const currentSession = get().auth.session;
        return (
          Boolean(currentSession) &&
          currentSession?.tokens.refreshToken === session.tokens.refreshToken &&
          get().settings.serverUrl === serverUrl
        );
      };

      const restoreStoredSessionInBackground = async (
        session: AuthSession,
        serverUrl: string,
      ): Promise<void> => {
        const finishStartupRefreshTiming =
          beginStartupTiming('startup refresh');
        try {
          const received = await refreshAuthSession(serverUrl, session, {
            timeoutMs: STARTUP_REFRESH_TIMEOUT_MS,
            timeoutMessage: getStartupRefreshTimeoutMessage(),
          });
          if (!isSessionRecoveryContextCurrent(session, serverUrl)) {
            return;
          }

          clearOfflineRecoveryLoop();
          const refreshed = await acceptAuthSession(received);
          set(state => ({
            auth: {
              status: 'authenticated',
              session: refreshed,
              offline: null,
              errorMessage: null,
            },
            syncStatus: {
              ...state.syncStatus,
              errorMessage: null,
            },
          }));
          await syncWithSession(refreshed);
        } catch (error) {
          if (!isSessionRecoveryContextCurrent(session, serverUrl)) {
            return;
          }

          if (isLikelyNetworkError(error) && isOfflineLeaseActive(session)) {
            const offlineVaultState = await resolveStoredVaultState(session);
            set({
              auth: {
                status: 'offline-authenticated',
                session,
                offline: buildOfflineState(
                  session,
                  t('store.restoredOffline'),
                ),
                errorMessage: null,
              },
              vault: offlineVaultState,
              syncStatus: {
                ...get().syncStatus,
                status: 'paused',
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : t('store.networkUnavailable'),
              },
            });
            scheduleOfflineRecoveryRetry(session, serverUrl, {
              immediate: true,
              reset: true,
            });
            return;
          }

          const shouldClearStoredAuthSession =
            error instanceof ApiError && error.status === 401;
          clearOfflineRecoveryLoop();
          secureStateRestoreVersion += 1;
          set({
            auth: {
              ...createUnauthenticatedState(),
              errorMessage:
                error instanceof Error
                  ? error.message
                  : t('store.sessionRestoreFailed'),
            },
            syncStatus: createDefaultSyncStatus(),
            ...createEmptyProtectedState(),
            authGateResolved: true,
            secureStateReady: true,
            bootstrapping: false,
          });
          void clearPersistedSecureState({
            clearStoredAuthSession: shouldClearStoredAuthSession,
          });
        } finally {
          finishStartupRefreshTiming?.();
        }
      };

      const restoreStoredSecureStateInBackground = async (
        serverUrl: string,
        currentRestoreVersion: number,
      ): Promise<void> => {
        const finishSecureRestoreTiming = beginStartupTiming('secure restore');
        try {
          const [secretsByRef, awsProfiles] = await Promise.all([
            loadStoredSecrets(),
            loadStoredAwsProfiles(),
          ]);
          const currentState = get();
          if (
            !isSecureStateRestoreCurrent(
              currentRestoreVersion,
              serverUrl,
              currentState.auth,
              currentState.settings.serverUrl,
            )
          ) {
            return;
          }

          set(state => ({
            awsProfiles,
            secretsByRef,
            secretMetadata: deriveSecretMetadata(state.hosts, secretsByRef),
            secureStateReady: true,
          }));
        } finally {
          finishSecureRestoreTiming?.();
        }
      };

      const retrySessionRecoveryInBackground = async (
        session: AuthSession,
        serverUrl: string,
      ): Promise<'recovered' | 'retry' | 'stop'> => {
        try {
          const received = await refreshAuthSession(serverUrl, session);
          if (!isSessionRecoveryContextCurrent(session, serverUrl)) {
            return 'stop';
          }

          const refreshed = await acceptAuthSession(received);
          set(state => ({
            auth: {
              status: 'authenticated',
              session: refreshed,
              offline: null,
              errorMessage: null,
            },
            syncStatus: {
              ...state.syncStatus,
              errorMessage: null,
            },
          }));
          await syncWithSession(refreshed);
          const postRecoveryAuth = get().auth;
          if (
            !postRecoveryAuth.session ||
            get().settings.serverUrl !== serverUrl
          ) {
            return 'stop';
          }
          if (postRecoveryAuth.status === 'offline-authenticated') {
            return 'retry';
          }
          return postRecoveryAuth.status === 'authenticated'
            ? 'recovered'
            : 'stop';
        } catch (error) {
          if (!isSessionRecoveryContextCurrent(session, serverUrl)) {
            return 'stop';
          }

          if (error instanceof ApiError && error.status === 401) {
            await clearPersistedSecureState();
            clearOfflineRecoveryLoop();
            secureStateRestoreVersion += 1;
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: t('store.sessionExpiredSignIn'),
              },
              syncStatus: {
                ...createDefaultSyncStatus(),
                status: 'error',
                errorMessage: t('store.sessionExpired'),
              },
              ...createEmptyProtectedState(),
              authGateResolved: true,
              secureStateReady: true,
              bootstrapping: false,
            });
            return 'stop';
          }

          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              status: 'paused',
              errorMessage:
                error instanceof Error
                  ? error.message
                  : t('store.networkUnavailable'),
            },
          }));
          return 'retry';
        }
      };

      const scheduleOfflineRecoveryRetry = (
        session: AuthSession,
        serverUrl: string,
        options?: {
          immediate?: boolean;
          reset?: boolean;
        },
      ) => {
        const recoveryKey = buildOfflineRecoveryKey(session, serverUrl);
        if (options?.reset || offlineRecoveryKey !== recoveryKey) {
          if (offlineRecoveryTimer) {
            clearTimeout(offlineRecoveryTimer);
            offlineRecoveryTimer = null;
          }
          offlineRecoveryAttempt = 0;
          offlineRecoveryKey = recoveryKey;
        }

        const runAttempt = async () => {
          if (offlineRecoveryInFlight || offlineRecoveryKey !== recoveryKey) {
            return;
          }
          const activeSession = get().auth.session;
          if (
            !activeSession ||
            get().settings.serverUrl !== serverUrl ||
            buildOfflineRecoveryKey(activeSession, serverUrl) !== recoveryKey
          ) {
            if (offlineRecoveryKey === recoveryKey) {
              clearOfflineRecoveryLoop();
            }
            return;
          }

          offlineRecoveryInFlight = true;
          try {
            const result = await retrySessionRecoveryInBackground(
              activeSession,
              serverUrl,
            );
            if (result === 'recovered' || result === 'stop') {
              clearOfflineRecoveryLoop();
              return;
            }

            offlineRecoveryAttempt += 1;
          } finally {
            offlineRecoveryInFlight = false;
          }

          const currentSession = get().auth.session;
          if (
            !currentSession ||
            get().settings.serverUrl !== serverUrl ||
            buildOfflineRecoveryKey(currentSession, serverUrl) !== recoveryKey
          ) {
            clearOfflineRecoveryLoop();
            return;
          }

          const nextDelay =
            OFFLINE_RECOVERY_RETRY_DELAYS_MS[
              Math.min(
                offlineRecoveryAttempt - 1,
                OFFLINE_RECOVERY_RETRY_DELAYS_MS.length - 1,
              )
            ];
          offlineRecoveryTimer = setTimeout(() => {
            offlineRecoveryTimer = null;
            void runAttempt();
          }, nextDelay);
        };

        if (options?.immediate) {
          void runAttempt();
          return;
        }

        if (offlineRecoveryTimer || offlineRecoveryInFlight) {
          return;
        }

        const nextDelay =
          OFFLINE_RECOVERY_RETRY_DELAYS_MS[
            Math.min(
              offlineRecoveryAttempt,
              OFFLINE_RECOVERY_RETRY_DELAYS_MS.length - 1,
            )
          ];
        offlineRecoveryTimer = setTimeout(() => {
          offlineRecoveryTimer = null;
          void runAttempt();
        }, nextDelay);
      };

      // 동기화 push 에 쓸 볼트 키. E2EE 는 잠금해제된 DEK, 레거시는 세션의 keyBase64.
      const resolveVaultKeyForPush = (session: AuthSession): string => {
        const vault = get().vault;
        if (vault.status === 'unlocked') {
          return vault.dekBase64;
        }
        if (vault.status === 'legacy') {
          if (vault.migrationRequired) {
            throw new Error(
              t('store.vaultSetupRequired'),
            );
          }
          return requireLegacyVaultKey(session);
        }
        throw new Error(
          vault.status === 'error'
            ? vault.errorMessage
            : t('store.vaultUnlockRequired'),
        );
      };

      // push 헤더에 실을 DEK 세대 — 레거시(v1)에서는 null(헤더 생략, 서버 v1 경로).
      const resolveVaultEpochForPush = (): number | null => {
        const vault = get().vault;
        return vault.status === 'unlocked' ? vault.epoch : null;
      };

      // epoch floor: 버전과 무관하게 coherent cache보다 낮은 descriptor는 낡은 응답이다.
      // 신서버의 v0에도 epoch가 있으므로 실제 reset(높은 epoch)은 그대로 통과하고,
      // setup 직후 늦게 도착한 v0(낮은 epoch)만 현재 v2 descriptor로 치환한다.
      const applyVaultEpochFloor = (session: AuthSession): AuthSession => {
        const vault = get().vault;
        if (!hasCoherentVaultDescriptor(vault)) {
          return session;
        }
        const bootstrap = session.vaultBootstrap;
        const descriptorEpoch =
          typeof bootstrap.epoch === 'number' ? bootstrap.epoch : 0;
        const legacyVersionZeroWithoutEpoch =
          bootstrap.version === 0 && bootstrap.epoch === undefined;
        const descriptorWrapRevision =
          typeof bootstrap.wrapRevision === 'number'
            ? bootstrap.wrapRevision
            : 0;
        const descriptorIsCurrent =
          descriptorEpoch > vault.epoch ||
          (descriptorEpoch === vault.epoch &&
            descriptorWrapRevision >= vault.wrapRevision);
        if (descriptorIsCurrent && !legacyVersionZeroWithoutEpoch) {
          return session;
        }
        return {
          ...session,
          vaultBootstrap: {
            version: 2,
            wrappedDekBase64: vault.wrappedDekBase64,
            epoch: vault.epoch,
            wrapRevision: vault.wrapRevision,
            dekVerifierBase64: computeVaultDekVerifier(
              toByteArray(vault.dekBase64),
            ),
            kdf: vault.kdf,
          },
        };
      };

      // 모든 온라인 세션 수신 경로가 같은 epoch floor와 Keychain 저장 규칙을 탄다.
      // 다른 계정의 세션이면 이전 계정의 DEK를 먼저 제거해 floor에 섞이지 않게 한다.
      const acceptAuthSession = async (
        session: AuthSession,
      ): Promise<AuthSession> => {
        const currentUserId = get().auth.session?.user.id;
        if (currentUserId && currentUserId !== session.user.id) {
          await clearStoredVaultDek().catch(() => undefined);
          vaultSyncGeneration += 1;
          set({ vault: { status: 'none' } });
        }
        const accepted = applyVaultEpochFloor(session);
        await saveStoredAuthSession(accepted);
        return accepted;
      };

      // 볼트 변이(설정/전환/암호변경) 성공 직후, 네트워크 refresh 에 기대지 않고 알고
      // 있는 값(wrapped/kdf/epoch/verifier)으로 저장 세션의 descriptor 를 즉시 합성해
      // 저장한다 — 직후의 refresh 가 실패한 채 재시작(특히 오프라인)해도 저장 세션과
      // keychain 캐시의 epoch 이 어긋나 콜드 복원이 깨지지 않게 한다.
      const persistSynthesizedVaultDescriptor = async (): Promise<void> => {
        const { auth, vault } = get();
        const session = auth.session;
        if (!session || !hasCoherentVaultDescriptor(vault)) {
          return;
        }
        const synthesized: AuthSession = {
          ...session,
          vaultBootstrap: {
            version: 2,
            wrappedDekBase64: vault.wrappedDekBase64,
            epoch: vault.epoch,
            wrapRevision: vault.wrapRevision,
            dekVerifierBase64: computeVaultDekVerifier(
              toByteArray(vault.dekBase64),
            ),
            kdf: vault.kdf,
          },
        };
        await saveStoredAuthSession(synthesized).catch(() => undefined);
        set({ auth: { ...auth, session: synthesized } });
      };

      // push 응답의 리비전은 "직전 pull 리비전 + 1"일 때만 저장한다. 그보다 크면 내 push
      // 이전에 다른 기기의 변경이 끼어 있다는 뜻 — 그대로 저장하면 다음 폴링이 304 로 그
      // 변경들을 영영 건너뛴다. 옛 ETag 를 유지해 다음 폴링이 200 전체를 받게 한다.
      const storePushedRevision = (pushedRevision: string | null) => {
        if (!pushedRevision) {
          return;
        }
        const pushed = parseSyncRevisionEtag(pushedRevision);
        const lastPulled = parseSyncRevisionEtag(lastSyncRevision);
        if (
          pushed !== null &&
          lastPulled !== null &&
          pushed <= lastPulled + 1
        ) {
          lastSyncRevision = pushedRevision;
        }
      };

      // 서버가 push 를 볼트 세대 문제로 거부(409)했을 때의 공통 처리. 두 code 모두
      // "이 DEK 세대로는 더 못 간다" 신호다:
      //  - vault_dek_mismatch: DEK 세대 불일치(초기화 후 재설정 완료, v1 재생성 포함)
      //  - vault_reset: 볼트 삭제 직후(재설정 전) — 재시도해도 영원히 실패하는 hot loop 방지
      // 캐시를 먼저 지우지 않고 세션을 갱신해 재판정한다: 최신 descriptor 의
      // epoch/verifier 가 정확히 결정한다 — 진짜 세대 교체면 locked 경로가 캐시를
      // 정리하고, 마이그레이션 창(pre-seed DEK 유효)이면 verifier 일치로 재입력 없이
      // 이어진다. refresh 실패 시 상태를 바꾸지 않는다(비파괴 — 다음 폴링이 재시도).
      // 처리했으면 true.
      const handleVaultDekMismatchError = async (
        error: unknown,
      ): Promise<boolean> => {
        if (
          !(error instanceof ApiError) ||
          !isVaultEpochRejectionCode(error.code)
        ) {
          return false;
        }
        // 볼트 세대의 경계 — 이전 세대의 ETag 로 304 를 받지 않게 지운다.
        lastSyncRevision = null;
        let nextVault: MobileVaultState | null = null;
        const session = get().auth.session;
        if (session) {
          try {
            const refreshed = await acceptAuthSession(
              await refreshAuthSession(get().settings.serverUrl, session),
            );
            nextVault = await resolveStoredVaultState(refreshed);
            set({
              auth: {
                status: 'authenticated',
                session: refreshed,
                offline: null,
                errorMessage: null,
              },
            });
          } catch {
            // refresh 실패(네트워크 등) — 재판정 근거가 없으니 상태를 바꾸지 않는다.
          }
        }
        if (nextVault && nextVault.status !== get().vault.status) {
          // 볼트 전이(unlocked→locked 등) — in-flight sync 가 옛 상태를 되살리지 못하게.
          vaultSyncGeneration += 1;
        }
        set(state => ({
          ...(nextVault ? { vault: nextVault } : {}),
          syncStatus: {
            ...state.syncStatus,
            pendingPush: true,
            status: 'error',
            errorMessage:
              error.message ||
              t('store.vaultResetElsewhere'),
          },
        }));
        return true;
      };

      const pushKnownHosts = async (
        knownHosts: KnownHostRecord[],
        sessionOverride?: AuthSession | null,
      ) => {
        const session = sessionOverride ?? get().auth.session ?? null;
        if (!session) {
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              pendingPush: true,
            },
          }));
          return;
        }

        try {
          const pushedRevision = await postSyncSnapshot(
            get().settings.serverUrl,
            session.tokens.accessToken,
            buildKnownHostsSyncPayload(
              knownHosts,
              resolveVaultKeyForPush(session),
            ),
            resolveVaultEpochForPush(),
          );
          storePushedRevision(pushedRevision);
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              pendingPush: false,
              errorMessage: null,
              status: 'ready',
              lastSuccessfulSyncAt: new Date().toISOString(),
            },
          }));
        } catch (error) {
          if (await handleVaultDekMismatchError(error)) {
            return;
          }
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              pendingPush: true,
              status: 'error',
              errorMessage:
                error instanceof Error
                  ? error.message
                  : t('store.knownHostSyncFailed'),
            },
          }));
        }
      };

      // Every key on file for an address, so the engine can connect without
      // probing the host first. All of them rather than one: the server chooses
      // the algorithm, and a host with both Ed25519 and ECDSA on file would
      // otherwise fail whenever it picks the one that was left out.
      const trustedHostKeysFor = (hostname: string, port: number): string[] =>
        get()
          .knownHosts.filter(
            record => record.host === hostname && record.port === port,
          )
          .map(record => record.publicKeyBase64)
          .filter(Boolean);

      const resolveKnownHostTrust = async (
        host: Pick<HostRecord, 'id' | 'label'>,
        info: MobileServerPublicKeyInfo,
      ): Promise<boolean> => {
        const { status, existing } = getKnownHostStatus(get().knownHosts, info);
        if (status === 'trusted') {
          const refreshedRecord = buildKnownHostRecord(info, existing);
          set(state => ({
            knownHosts: sortKnownHosts(
              state.knownHosts.map(record =>
                record.id === refreshedRecord.id ? refreshedRecord : record,
              ),
            ),
          }));
          return true;
        }

        const accepted = await new Promise<boolean>(resolve => {
          pendingServerKeyResolver = resolve;
          set({
            pendingServerKeyPrompt: {
              hostId: host.id,
              hostLabel: host.label,
              status,
              info,
              existing,
            },
          });
        });

        if (!accepted) {
          return false;
        }

        const trustedRecord = buildKnownHostRecord(info, existing);
        const nextKnownHosts = sortKnownHosts(
          get().knownHosts.filter(record => record.id !== trustedRecord.id),
        );
        const mergedKnownHosts = sortKnownHosts([
          ...nextKnownHosts,
          trustedRecord,
        ]);

        set(state => ({
          knownHosts: mergedKnownHosts,
          syncStatus: {
            ...state.syncStatus,
            pendingPush: true,
          },
        }));
        await pushKnownHosts(mergedKnownHosts);
        return true;
      };

      const promptForCredentials = (
        host: SshHostRecord,
        initialValue: HostSecretInput,
        message?: string | null,
      ) =>
        new Promise<HostSecretInput | null>(resolve => {
          pendingCredentialResolver = resolve;
          set({
            pendingCredentialPrompt: {
              hostId: host.id,
              hostLabel: host.label,
              authType: getMobileCredentialPromptAuthType(host),
              message,
              initialValue,
            },
          });
        });

      const resolveHostCredentials = async (
        host: SshHostRecord,
      ): Promise<HostSecretInput | null> => {
        const existing = host.secretRef
          ? get().secretsByRef[host.secretRef]
          : undefined;
        const promptBase: HostSecretInput = {
          password: existing?.password,
          passphrase: existing?.passphrase,
          privateKeyPem: existing?.privateKeyPem,
          certificateText: existing?.certificateText,
        };

        if (host.authType === 'password') {
          if (promptBase.password) {
            return promptBase;
          }

          const prompted = await promptForCredentials(
            host,
            promptBase,
            t('store.enterPassword'),
          );
          if (!prompted) {
            return null;
          }

          if (host.secretRef) {
            const merged = mergePromptedSecrets(existing, host, prompted);
            if (merged) {
              await updateSecretsState({
                ...get().secretsByRef,
                [merged.secretRef]: merged,
              });
            }
          }

          return { ...promptBase, ...prompted };
        }

        if (host.authType === 'privateKey') {
          if (hasCredentialText(promptBase.privateKeyPem)) {
            return promptBase;
          }

          const prompted = await promptForCredentials(
            host,
            promptBase,
            t('store.enterKey'),
          );
          if (!prompted) {
            return null;
          }

          if (host.secretRef) {
            const merged = mergePromptedSecrets(existing, host, prompted);
            if (merged) {
              await updateSecretsState({
                ...get().secretsByRef,
                [merged.secretRef]: merged,
              });
            }
          }

          return { ...promptBase, ...prompted };
        }

        if (host.authType === 'certificate') {
          if (
            hasCredentialText(promptBase.privateKeyPem) &&
            hasCredentialText(promptBase.certificateText)
          ) {
            return promptBase;
          }

          const prompted = await promptForCredentials(
            host,
            promptBase,
            t('store.enterKeyAndCert'),
          );
          if (!prompted) {
            return null;
          }

          if (host.secretRef) {
            const merged = mergePromptedSecrets(existing, host, prompted);
            if (merged) {
              await updateSecretsState({
                ...get().secretsByRef,
                [merged.secretRef]: merged,
              });
            }
          }

          return { ...promptBase, ...prompted };
        }

        return null;
      };

      const flushSessionSnapshot = (
        sessionId: string,
        options?: {
          markActivity?: boolean;
        },
      ) => {
        const pendingFlush = runtimeSnapshotFlushTimers.get(sessionId);
        if (pendingFlush) {
          clearTimeout(pendingFlush);
          runtimeSnapshotFlushTimers.delete(sessionId);
        }

        const snapshot = runtimeSessionSnapshots.get(sessionId);
        if (snapshot == null) {
          return;
        }

        set(state => {
          const current = state.sessions.find(
            session => session.id === sessionId,
          );
          if (!current) {
            return state;
          }

          const patch: Partial<MobileSessionRecord> = {};
          if (snapshot !== current.lastViewportSnapshot) {
            patch.lastViewportSnapshot = snapshot;
          }
          if (!current.hasReceivedOutput && snapshot.length > 0) {
            patch.hasReceivedOutput = true;
          }
          if (options?.markActivity !== false) {
            patch.lastEventAt = new Date().toISOString();
          }

          if (Object.keys(patch).length === 0) {
            return state;
          }

          const nextSessions = patchSessionRecord(
            state.sessions,
            sessionId,
            patch,
          );
          return {
            sessions: nextSessions,
            activeSessionTabId: resolveActiveSessionTabId(
              nextSessions,
              state.activeSessionTabId,
            ),
          };
        });
      };

      const scheduleSessionSnapshotFlush = (sessionId: string) => {
        if (runtimeSnapshotFlushTimers.has(sessionId)) {
          return;
        }

        const timer = setTimeout(() => {
          runtimeSnapshotFlushTimers.delete(sessionId);
          flushSessionSnapshot(sessionId);
        }, SESSION_SNAPSHOT_FLUSH_MS);
        runtimeSnapshotFlushTimers.set(sessionId, timer);
      };

      const markSessionState = (
        sessionId: string,
        status: MobileSessionRecord['status'],
        errorMessage?: string | null,
      ) => {
        const now = new Date().toISOString();
        set(state => {
          const nextSessions = patchSessionRecord(state.sessions, sessionId, {
            status,
            errorMessage: errorMessage ?? null,
            isRestorable: true,
            lastEventAt: now,
            lastDisconnectedAt:
              status === 'closed' || status === 'error' ? now : undefined,
          });
          return {
            sessions: nextSessions,
            activeSessionTabId: resolveActiveSessionTabId(
              nextSessions,
              state.activeSessionTabId === sessionId && status === 'closed'
                ? null
                : state.activeSessionTabId,
            ),
            activeConnectionTab: normalizeActiveConnectionTab(
              nextSessions,
              state.sftpSessions,
              state.activeConnectionTab?.kind === 'terminal' &&
                state.activeConnectionTab.id === sessionId &&
                status === 'closed'
                ? null
                : state.activeConnectionTab,
            ),
          };
        });
      };

      const markSftpSessionState = (
        sessionId: string,
        status: MobileSftpSessionRecord['status'],
        errorMessage?: string | null,
      ) => {
        const now = new Date().toISOString();
        set(state => {
          const nextSftpSessions = patchSftpSessionRecord(
            state.sftpSessions,
            sessionId,
            {
              status,
              errorMessage: errorMessage ?? null,
              lastEventAt: now,
              lastDisconnectedAt:
                status === 'closed' || status === 'error' ? now : undefined,
            },
          );
          return {
            sftpSessions: nextSftpSessions,
            activeConnectionTab: normalizeActiveConnectionTab(
              state.sessions,
              nextSftpSessions,
              state.activeConnectionTab?.kind === 'sftp' &&
                state.activeConnectionTab.id === sessionId &&
                status === 'closed'
                ? null
                : state.activeConnectionTab,
            ),
          };
        });
      };

      const refreshSftpDirectory = async (
        sessionId: string,
        path?: string,
      ): Promise<void> => {
        const runtime = runtimeSftpSessions.get(sessionId);
        if (!runtime) {
          markSftpSessionState(
            sessionId,
            'error',
            t('store.sftpNotFound'),
          );
          return;
        }

        const currentRecord = get().sftpSessions.find(
          session => session.id === sessionId,
        );
        const nextPath = path ?? currentRecord?.currentPath ?? '.';
        try {
          const listing = await runtime.connection.listDirectory(nextPath);
          set(state => ({
            sftpSessions: patchSftpSessionRecord(
              state.sftpSessions,
              sessionId,
              {
                status: 'connected',
                currentPath: listing.path,
                listing,
                errorMessage: null,
                lastEventAt: new Date().toISOString(),
              },
            ),
          }));
        } catch (error) {
          markSftpSessionState(
            sessionId,
            'error',
            error instanceof Error
              ? error.message
              : t('store.sftpListFailed'),
          );
        }
      };

      const connectSftpSessionRecord = async (
        sftpSessionRecord: MobileSftpSessionRecord,
        host: SshHostRecord | AwsEc2HostRecord,
      ) => {
        if (
          runtimeSftpSessions.has(sftpSessionRecord.id) ||
          pendingSftpConnections.has(sftpSessionRecord.id)
        ) {
          return;
        }
        pendingSftpConnections.add(sftpSessionRecord.id);
        let pendingConnection: MobileSftpConnection | null = null;
        let closedDuringConnect = false;

        try {
          if (isAwsEc2HostRecord(host)) {
            await connectAwsSftpSessionRecord(sftpSessionRecord, host);
            return;
          }

          if (
            host.authType !== 'password' &&
            host.authType !== 'privateKey' &&
            host.authType !== 'certificate'
          ) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'error',
              t('store.sftpAuthLimited'),
            );
            return;
          }

          const credentials = await resolveHostCredentials(host);
          if (!credentials) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'closed',
              t('store.sftpCancelled'),
            );
            return;
          }

          const security = buildEngineCredential(host, credentials);

          if (!security) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'error',
              getMissingCredentialMessage(host),
            );
            return;
          }

          const validationMessage = await validateEngineCredential(security);
          if (validationMessage) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'error',
              validationMessage,
            );
            return;
          }

          set(state => ({
            sftpSessions: patchSftpSessionRecord(
              state.sftpSessions,
              sftpSessionRecord.id,
              {
                status: 'connecting',
                errorMessage: null,
                lastEventAt: new Date().toISOString(),
              },
            ),
          }));

          const engine = getEngine();
          console.info(
            `[mobile-sftp] engine=${engine.name} session=${sftpSessionRecord.id}`,
          );
          const engineSftp = await engine.connectSftp({
            connectionId: sftpSessionRecord.id,
            host: host.hostname,
            port: host.port,
            username: host.username,
            credential: security,
            trustedHostKeysBase64: trustedHostKeysFor(host.hostname, host.port),
            onServerKey: async info => resolveKnownHostTrust(host, info),
            onDisconnected: () => {
              closedDuringConnect = true;
              if (runtimeSftpSessions.has(sftpSessionRecord.id)) {
                void disposeRuntimeSftpSession(sftpSessionRecord.id);
              }
              markSftpSessionState(sftpSessionRecord.id, 'closed');
            },
          });
          const connection = wrapEngineSftpConnection(engineSftp);
          pendingConnection = connection;

          if (closedDuringConnect) {
            return;
          }

          runtimeSftpSessions.set(sftpSessionRecord.id, {
            recordId: sftpSessionRecord.id,
            hostId: host.id,
            connection,
          });
          pendingConnection = null;

          const listing = await connection.listDirectory(
            sftpSessionRecord.currentPath || '.',
          );
          if (closedDuringConnect) {
            return;
          }
          const now = new Date().toISOString();
          set(state => ({
            sftpSessions: patchSftpSessionRecord(
              state.sftpSessions,
              sftpSessionRecord.id,
              {
                status: 'connected',
                currentPath: listing.path,
                listing,
                errorMessage: null,
                lastEventAt: now,
                lastConnectedAt: now,
                title: `${host.label} SFTP`,
              },
            ),
          }));
        } catch (error) {
          await disposeRuntimeSftpSession(sftpSessionRecord.id);
          if (isAuthExpiredError(error)) {
            await expireAuthSession();
            return;
          }
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            error instanceof Error
              ? error.message
              : t('store.sftpConnectFailed'),
          );
        } finally {
          if (pendingConnection) {
            try {
              await pendingConnection.close();
            } catch {}
          }
          pendingSftpConnections.delete(sftpSessionRecord.id);
        }
      };

      const connectAwsSftpSessionRecord = async (
        sftpSessionRecord: MobileSftpSessionRecord,
        host: AwsEc2HostRecord,
      ) => {
        let accessToken = get().auth.session?.tokens.accessToken;
        if (!accessToken) {
          await expireAuthSession();
          return;
        }

        const disabledReason = getAwsEc2SftpDisabledMessage(host);
        if (disabledReason) {
          markSftpSessionState(sftpSessionRecord.id, 'error', disabledReason);
          return;
        }

        let awsSftpServerSupport = get().syncStatus.awsSftpServerSupport;
        if (awsSftpServerSupport === 'unknown') {
          try {
            const serverInfo = await fetchServerInfo(get().settings.serverUrl);
            awsSftpServerSupport = toServerSupport(
              serverInfo.capabilities.sessions.awsSftp,
            );
            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                awsProfilesServerSupport: toServerSupport(
                  serverInfo.capabilities.sync.awsProfiles,
                ),
                awsSsmServerSupport: toServerSupport(
                  serverInfo.capabilities.sessions.awsSsm,
                ),
                awsSftpServerSupport,
              },
            }));
          } catch {}
        }

        if (awsSftpServerSupport === 'unsupported') {
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            t('store.awsSftpUnsupported'),
          );
          return;
        }

        const sshUsername = host.awsSshUsername?.trim();
        if (!sshUsername) {
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            host.awsSshMetadataError ||
              t('store.awsSftpUsernameRequired'),
          );
          return;
        }
        const availabilityZone = host.awsAvailabilityZone?.trim();
        if (!availabilityZone) {
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            t('store.awsSftpAzRequired'),
          );
          return;
        }

        set(state => ({
          sftpSessions: patchSftpSessionRecord(
            state.sftpSessions,
            sftpSessionRecord.id,
            {
              status: 'connecting',
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
            },
          ),
        }));

        let resolvedSession = null as Awaited<
          ReturnType<typeof resolveAwsSessionForHost>
        > | null;
        let retriedAuth = false;
        while (!resolvedSession) {
          try {
            resolvedSession = await resolveAwsSessionForHost({
              host,
              profiles: get().awsProfiles,
              serverUrl: get().settings.serverUrl,
              authAccessToken: accessToken,
              presentLoginPrompt: prompt => {
                pendingAwsSsoCancelHandler = prompt.onCancel;
                set({ pendingAwsSsoLogin: prompt });
              },
              dismissLoginPrompt: () => {
                pendingAwsSsoCancelHandler = null;
                set({ pendingAwsSsoLogin: null });
              },
            });
          } catch (error) {
            if (isAuthExpiredError(error) && !retriedAuth) {
              const refreshed = await refreshAuthForConnection();
              if (!refreshed) {
                return;
              }
              accessToken = refreshed.tokens.accessToken;
              retriedAuth = true;
              continue;
            }
            if (isAuthExpiredError(error)) {
              await expireAuthSession();
              return;
            }
            throw error;
          }
        }

        const sshPort = getAwsEc2HostSshPort(host);
        const knownHostName = buildAwsSsmKnownHostIdentity({
          profileName: resolvedSession.profileName,
          region: resolvedSession.region,
          instanceId: host.awsInstanceId,
        });
        let trustedHostKeysBase64 = get()
          .knownHosts.filter(
            record => record.host === knownHostName && record.port === sshPort,
          )
          .map(record => record.publicKeyBase64);
        let trustedHostKeyBase64 = trustedHostKeysBase64[0] ?? null;

        let hostKeyAttempts = 0;
        while (hostKeyAttempts < 2) {
          const payload: AwsSftpCreateSessionRequest = {
            hostId: host.id,
            label: host.label,
            profileName: resolvedSession.profileName,
            region: resolvedSession.region,
            instanceId: host.awsInstanceId,
            availabilityZone,
            sshUsername,
            sshPort,
            env: resolvedSession.envSpec.env,
            unsetEnv: resolvedSession.envSpec.unsetEnv,
            trustedHostKeyBase64,
            trustedHostKeysBase64,
          };

          try {
            const connection = await connectAwsSftp({
              serverUrl: get().settings.serverUrl,
              accessToken,
              payload,
            });
            runtimeSftpSessions.set(sftpSessionRecord.id, {
              recordId: sftpSessionRecord.id,
              hostId: host.id,
              connection,
            });

            const listing = await connection.listDirectory(
              sftpSessionRecord.currentPath || '.',
            );
            const now = new Date().toISOString();
            set(state => ({
              sftpSessions: patchSftpSessionRecord(
                state.sftpSessions,
                sftpSessionRecord.id,
                {
                  status: 'connected',
                  currentPath: listing.path,
                  listing,
                  errorMessage: null,
                  lastEventAt: now,
                  lastConnectedAt: now,
                  title: `${host.label} SFTP`,
                },
              ),
            }));
            return;
          } catch (error) {
            if (error instanceof AwsSftpHostKeyChallengeError) {
              const accepted = await resolveKnownHostTrust(host, error.info);
              if (!accepted) {
                markSftpSessionState(
                  sftpSessionRecord.id,
                  'closed',
                  t('store.sftpCancelled'),
                );
                return;
              }
              trustedHostKeysBase64 = get()
                .knownHosts.filter(
                  record =>
                    record.host === knownHostName && record.port === sshPort,
                )
                .map(record => record.publicKeyBase64);
              trustedHostKeyBase64 = error.info.keyBase64;
              hostKeyAttempts += 1;
              continue;
            }
            if (isAuthExpiredError(error) && !retriedAuth) {
              const refreshed = await refreshAuthForConnection();
              if (!refreshed) {
                return;
              }
              accessToken = refreshed.tokens.accessToken;
              retriedAuth = true;
              continue;
            }
            if (isAuthExpiredError(error)) {
              await expireAuthSession();
              return;
            }
            throw error;
          }
        }

        markSftpSessionState(
          sftpSessionRecord.id,
          'error',
          t('store.awsSftpHostKeyFailed'),
        );
      };

      const connectSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: HostRecord,
      ) => {
        if (
          runtimeSessions.has(sessionRecord.id) ||
          pendingSessionConnections.has(sessionRecord.id)
        ) {
          return;
        }
        pendingSessionConnections.add(sessionRecord.id);
        runtimeSessionSnapshots.set(
          sessionRecord.id,
          get().sessions.find(item => item.id === sessionRecord.id)
            ?.lastViewportSnapshot ?? sessionRecord.lastViewportSnapshot,
        );
        if (isAwsEc2HostRecord(host)) {
          void connectAwsSessionRecord(sessionRecord, host);
          return;
        }
        if (isSshHostRecord(host)) {
          void connectSshSessionRecord(sessionRecord, host);
          return;
        }
        markSessionState(
          sessionRecord.id,
          'error',
          t('store.hostKindUnsupported'),
        );
        pendingSessionConnections.delete(sessionRecord.id);
      };

      const connectSshSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: SshHostRecord,
      ) => {
        let pendingConnection: EngineConnection | null = null;
        let pendingShell: EngineShell | null = null;
        let pendingBackgroundListenerId: number | null = null;
        let closedDuringConnect = false;
        try {
          if (
            host.authType !== 'password' &&
            host.authType !== 'privateKey' &&
            host.authType !== 'certificate'
          ) {
            markSessionState(
              sessionRecord.id,
              'error',
              t('store.authKindUnsupported'),
            );
            return;
          }

          const credentials = await resolveHostCredentials(host);
          if (!credentials) {
            markSessionState(
              sessionRecord.id,
              'closed',
              t('store.connectCancelled'),
            );
            return;
          }

          const security = buildEngineCredential(host, credentials);

          if (!security) {
            markSessionState(
              sessionRecord.id,
              'error',
              getMissingCredentialMessage(host),
            );
            return;
          }

          const validationMessage = await validateEngineCredential(security);
          if (validationMessage) {
            markSessionState(sessionRecord.id, 'error', validationMessage);
            return;
          }

          const connectionStartedAt = new Date().toISOString();
          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: 'connecting',
              errorMessage: null,
              lastEventAt: connectionStartedAt,
              connectionKind: 'ssh',
              connectionDetails: `${host.username}@${host.hostname}:${host.port}`,
            }),
          }));

          const engine = getEngine();
          // Names the engine in the device log. With one engine left this reads
          // mostly as a session-start marker, but it stays because it is what
          // ties a device log back to a session id.
          console.info(
            `[mobile-ssh] engine=${engine.name} session=${sessionRecord.id}`,
          );
          const markClosed = () => {
            closedDuringConnect = true;
            flushSessionSnapshot(sessionRecord.id, {
              markActivity: false,
            });
            if (runtimeSessions.has(sessionRecord.id)) {
              void disposeRuntimeSession(sessionRecord.id);
            }
            markSessionState(sessionRecord.id, 'closed');
          };

          const terminalSize = await resolvePtyTerminalGridSize();
          const connection = await engine.connect({
            connectionId: sessionRecord.id,
            host: host.hostname,
            port: host.port,
            username: host.username,
            credential: security,
            size: terminalSize,
            trustedHostKeysBase64: trustedHostKeysFor(host.hostname, host.port),
            onServerKey: async info => resolveKnownHostTrust(host, info),
            onDisconnected: markClosed,
          });
          pendingConnection = connection;
          if (closedDuringConnect) {
            return;
          }
          const shell = await connection.startShell({
            // Kept at plain xterm, which is what this session flow has always
            // requested; TERM changes what remote programs emit.
            term: 'xterm',
            size: terminalSize,
            onClosed: markClosed,
          });
          pendingShell = shell;
          if (closedDuringConnect) {
            return;
          }

          const backgroundListenerId = await shell.follow(
            {
              onChunk: chunk => {
                const text = Buffer.from(chunk.bytes).toString('utf8');
                const currentSnapshot =
                  runtimeSessionSnapshots.get(sessionRecord.id) ?? '';
                runtimeSessionSnapshots.set(
                  sessionRecord.id,
                  trimSnapshot(`${currentSnapshot}${text}`),
                );
                scheduleSessionSnapshotFlush(sessionRecord.id);
              },
            },
            {
              cursor: { mode: 'live' },
              coalesceMs: 20,
            },
          );
          pendingBackgroundListenerId = backgroundListenerId;
          if (closedDuringConnect) {
            return;
          }

          runtimeSessions.set(sessionRecord.id, {
            kind: 'ssh',
            recordId: sessionRecord.id,
            hostId: host.id,
            connection,
            shell,
            backgroundListenerId,
          });
          pendingConnection = null;
          pendingShell = null;
          pendingBackgroundListenerId = null;

          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: 'connected',
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
              lastConnectedAt: new Date().toISOString(),
              title: host.label,
              connectionKind: 'ssh',
              connectionDetails: `${host.username}@${host.hostname}:${host.port}`,
            }),
          }));
        } catch (error) {
          await disposeRuntimeSession(sessionRecord.id);
          if (!closedDuringConnect) {
            markSessionState(
              sessionRecord.id,
              'error',
              error instanceof Error
                ? error.message
                : t('store.sshConnectFailed'),
            );
          }
        } finally {
          if (pendingConnection) {
            await closeSshRuntimeResources(
              pendingConnection,
              pendingShell,
              pendingBackgroundListenerId,
            );
          }
          pendingSessionConnections.delete(sessionRecord.id);
        }
      };

      const connectAwsSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: AwsEc2HostRecord,
        options?: {
          retriedAuth?: boolean;
        },
      ) => {
        try {
          let accessToken = get().auth.session?.tokens.accessToken;
          if (!accessToken) {
            await expireAuthSession();
            return;
          }

          let awsSsmServerSupport = get().syncStatus.awsSsmServerSupport;
          if (awsSsmServerSupport === 'unknown') {
            try {
              const serverInfo = await fetchServerInfo(
                get().settings.serverUrl,
              );
              awsSsmServerSupport = toServerSupport(
                serverInfo.capabilities.sessions.awsSsm,
              );
              set(state => ({
                syncStatus: {
                  ...state.syncStatus,
                  awsProfilesServerSupport: toServerSupport(
                    serverInfo.capabilities.sync.awsProfiles,
                  ),
                  awsSsmServerSupport,
                  awsSftpServerSupport: toServerSupport(
                    serverInfo.capabilities.sessions.awsSftp,
                  ),
                },
              }));
            } catch {}
          }

          if (awsSsmServerSupport === 'unsupported') {
            markSessionState(
              sessionRecord.id,
              'error',
              t('store.ssmUnsupported'),
            );
            return;
          }

          let resolvedSession = null as Awaited<
            ReturnType<typeof resolveAwsSessionForHost>
          > | null;
          let retriedAuth = options?.retriedAuth === true;
          while (!resolvedSession) {
            try {
              resolvedSession = await resolveAwsSessionForHost({
                host,
                profiles: get().awsProfiles,
                serverUrl: get().settings.serverUrl,
                authAccessToken: accessToken,
                presentLoginPrompt: prompt => {
                  pendingAwsSsoCancelHandler = prompt.onCancel;
                  set({ pendingAwsSsoLogin: prompt });
                },
                dismissLoginPrompt: () => {
                  pendingAwsSsoCancelHandler = null;
                  set({ pendingAwsSsoLogin: null });
                },
              });
            } catch (error) {
              if (isAuthExpiredError(error) && !retriedAuth) {
                const refreshed = await refreshAuthForConnection();
                if (!refreshed) {
                  return;
                }
                accessToken = refreshed.tokens.accessToken;
                retriedAuth = true;
                continue;
              }
              if (isAuthExpiredError(error)) {
                await expireAuthSession();
                return;
              }
              throw error;
            }
          }
          const terminalSize = await resolvePtyTerminalGridSize();
          const wsUrl = new URL(
            '/api/aws-sessions/ws',
            get().settings.serverUrl,
          );
          wsUrl.searchParams.set('access_token', accessToken);
          const wsProtocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsEndpoint = `${wsProtocol}//${wsUrl.host}${wsUrl.pathname}${wsUrl.search}`;

          const socket =
            new (WebSocket as unknown as ReactNativeWebSocketConstructor)(
              wsEndpoint,
              [],
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
            );
          let socketOpened = false;
          let receivedServerMessage = false;
          const nextRuntime: AwsRuntimeSession = {
            kind: 'aws-ssm',
            recordId: sessionRecord.id,
            hostId: host.id,
            socket,
            replayChunks: [],
            subscribers: new Map<string, SessionTerminalSubscription>(),
          };
          runtimeSessions.set(sessionRecord.id, nextRuntime);

          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: 'connecting',
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
              title: host.label,
              connectionKind: 'aws-ssm',
              connectionDetails: resolvedSession.connectionDetails,
            }),
          }));

          socket.onopen = () => {
            socketOpened = true;
            const message: AwsSsmSessionClientMessage = {
              type: 'start',
              payload: {
                hostId: host.id,
                label: host.label,
                // Mobile sends resolved env credentials, so the server should not
                // depend on a matching profile file being present in the container.
                profileName: '',
                region: resolvedSession.region,
                instanceId: host.awsInstanceId,
                cols: terminalSize.cols,
                rows: terminalSize.rows,
                env: resolvedSession.envSpec.env,
                unsetEnv: resolvedSession.envSpec.unsetEnv,
              },
            };
            socket.send(JSON.stringify(message));
          };

          socket.onmessage = event => {
            receivedServerMessage = true;
            const message = JSON.parse(
              String(event.data),
            ) as AwsSsmSessionServerMessage;
            if (message.type === 'ready') {
              pendingSessionConnections.delete(sessionRecord.id);
              set(state => ({
                sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
                  status: 'connected',
                  errorMessage: null,
                  lastEventAt: new Date().toISOString(),
                  lastConnectedAt: new Date().toISOString(),
                  title: host.label,
                  connectionKind: 'aws-ssm',
                  connectionDetails: resolvedSession.connectionDetails,
                }),
              }));
              return;
            }

            if (message.type === 'output' && message.dataBase64) {
              const chunk = Uint8Array.from(
                Buffer.from(message.dataBase64, 'base64'),
              );
              const text = Buffer.from(chunk).toString('utf8');
              const currentSnapshot =
                runtimeSessionSnapshots.get(sessionRecord.id) ?? '';
              runtimeSessionSnapshots.set(
                sessionRecord.id,
                trimSnapshot(`${currentSnapshot}${text}`),
              );
              scheduleSessionSnapshotFlush(sessionRecord.id);
              nextRuntime.replayChunks.push(chunk);
              for (const subscriber of nextRuntime.subscribers.values()) {
                subscriber.onData(chunk);
              }
              return;
            }

            if (message.type === 'error') {
              pendingSessionConnections.delete(sessionRecord.id);
              if (isAuthExpiredError(message.message)) {
                void (async () => {
                  disconnectRuntimeSession(sessionRecord.id);
                  if (retriedAuth) {
                    await expireAuthSession();
                    return;
                  }
                  const refreshed = await refreshAuthForConnection();
                  if (!refreshed) {
                    return;
                  }
                  const currentSessionRecord = get().sessions.find(
                    item => item.id === sessionRecord.id,
                  );
                  if (!currentSessionRecord) {
                    return;
                  }
                  void connectAwsSessionRecord(currentSessionRecord, host, {
                    retriedAuth: true,
                  });
                })();
                return;
              }
              markSessionState(
                sessionRecord.id,
                'error',
                message.message || t('store.ssmConnectFailed'),
              );
              return;
            }

            if (message.type === 'exit') {
              flushSessionSnapshot(sessionRecord.id, {
                markActivity: false,
              });
              disconnectRuntimeSession(sessionRecord.id);
              const currentSession = get().sessions.find(
                item => item.id === sessionRecord.id,
              );
              if (currentSession?.status === 'error') {
                return;
              }

              if (
                currentSession &&
                currentSession.status !== 'disconnecting' &&
                (currentSession.status === 'connecting' ||
                  !currentSession.hasReceivedOutput)
              ) {
                markSessionState(
                  sessionRecord.id,
                  'error',
                  message.message || t('store.ssmClosedImmediately'),
                );
                return;
              }

              markSessionState(
                sessionRecord.id,
                'closed',
                message.message || null,
              );
            }
          };

          socket.onerror = event => {
            pendingSessionConnections.delete(sessionRecord.id);
            if (isAuthExpiredError(event)) {
              void (async () => {
                disconnectRuntimeSession(sessionRecord.id);
                if (retriedAuth) {
                  await expireAuthSession();
                  return;
                }
                const refreshed = await refreshAuthForConnection();
                if (!refreshed) {
                  return;
                }
                const currentSessionRecord = get().sessions.find(
                  item => item.id === sessionRecord.id,
                );
                if (!currentSessionRecord) {
                  return;
                }
                void connectAwsSessionRecord(currentSessionRecord, host, {
                  retriedAuth: true,
                });
              })();
              return;
            }
            if (socketOpened || receivedServerMessage) {
              return;
            }
            markSessionState(
              sessionRecord.id,
              'error',
              t('store.ssmWebsocketFailed'),
            );
          };

          socket.onclose = () => {
            flushSessionSnapshot(sessionRecord.id, {
              markActivity: false,
            });
            disconnectRuntimeSession(sessionRecord.id);
            const currentSession = get().sessions.find(
              item => item.id === sessionRecord.id,
            );
            if (
              currentSession &&
              currentSession.status !== 'closed' &&
              currentSession.status !== 'error'
            ) {
              if (
                currentSession.status !== 'disconnecting' &&
                (currentSession.status === 'connecting' ||
                  !currentSession.hasReceivedOutput)
              ) {
                markSessionState(
                  sessionRecord.id,
                  'error',
                  t('store.ssmClosedUnexpectedly'),
                );
                return;
              }
              markSessionState(sessionRecord.id, 'closed');
            }
          };
        } catch (error) {
          disconnectRuntimeSession(sessionRecord.id);
          if (isAuthExpiredError(error)) {
            await expireAuthSession();
            return;
          }
          markSessionState(
            sessionRecord.id,
            'error',
            error instanceof Error
              ? error.message
              : t('store.ssmConnectFailed'),
          );
        } finally {
          pendingSessionConnections.delete(sessionRecord.id);
        }
      };

      const syncWithSession = async (
        sessionOverride?: AuthSession | null,
        options?: {
          context?: 'login' | 'sync';
        },
      ) => {
        const activeSession = sessionOverride ?? get().auth.session ?? null;
        if (!activeSession) {
          clearOfflineRecoveryLoop();
          set({
            auth: createUnauthenticatedState(),
            syncStatus: createDefaultSyncStatus(),
            ...createEmptyProtectedState(),
          });
          return;
        }

        if (syncPromise) {
          if (syncPromiseGeneration === vaultSyncGeneration) {
            // 같은 세대의 진행 중 sync — 결과를 공유한다.
            return syncPromise;
          }
          // 진행 중 sync 는 이전 세대에서 시작돼 결과가 버려질 예정이다(아래 staleness
          // 가드). 끝나길 기다렸다가 현재 세대로 새로 돈다 — 잠금해제/설정 직후의 pull
          // 이 stale dedup 으로 유실되지 않게 한다.
          await syncPromise.catch(() => undefined);
          return syncWithSession(sessionOverride, options);
        }

        syncPromiseGeneration = vaultSyncGeneration;
        syncPromise = (async () => {
          // 시작 시점의 볼트 세대를 캡처한다. 진행 중 잠금해제/설정/초기화가 일어나면
          // (세대 증가) 이 sync 의 결과는 낡은 것이므로 상태를 덮지 않고 버린다.
          const startedGeneration = vaultSyncGeneration;
          const isStaleSync = () => vaultSyncGeneration !== startedGeneration;
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              status: 'syncing',
              errorMessage: null,
            },
          }));

          let currentSession = activeSession;
          try {
            const serverInfoPromise = fetchServerInfo(
              get().settings.serverUrl,
            ).catch(() => null);

            let snapshot;
            try {
              snapshot = await fetchSyncSnapshot(
                get().settings.serverUrl,
                currentSession.tokens.accessToken,
                lastSyncRevision,
              );
            } catch (error) {
              if (error instanceof ApiError && error.status === 401) {
                currentSession = await acceptAuthSession(
                  await refreshAuthSession(
                    get().settings.serverUrl,
                    currentSession,
                  ),
                );
                set({
                  auth: {
                    status: 'authenticated',
                    session: currentSession,
                    offline: null,
                    errorMessage: null,
                  },
                });
                snapshot = await fetchSyncSnapshot(
                  get().settings.serverUrl,
                  currentSession.tokens.accessToken,
                  lastSyncRevision,
                );
              } else {
                throw error;
              }
            }
            const serverInfo = await serverInfoPromise;

            const readySyncStatus: SyncStatus = {
              status: 'ready',
              pendingPush: false,
              errorMessage: null,
              lastSuccessfulSyncAt: new Date().toISOString(),
              awsProfilesServerSupport: toServerSupport(
                serverInfo?.capabilities.sync.awsProfiles,
              ),
              awsSsmServerSupport: toServerSupport(
                serverInfo?.capabilities.sessions.awsSsm,
              ),
              awsSftpServerSupport: toServerSupport(
                serverInfo?.capabilities.sessions.awsSftp,
              ),
              vaultE2eeServerSupport:
                serverInfo?.capabilities.vault?.e2ee === true
                  ? 'supported'
                  : serverInfo
                  ? 'unsupported'
                  : 'unknown',
            };
            const authenticatedAuth: AuthState = {
              status: 'authenticated',
              session: currentSession,
              offline: null,
              errorMessage: null,
            };

            // 304(변경 없음): 서버 sync 데이터가 마지막 동기화 이후 그대로다. 초기화는
            // 리비전을 bump 하므로 304 면 볼트도 안 바뀐 것 — 로컬/볼트를 그대로 두고
            // 동기화 상태만 갱신한다(전체 복호화·적용 생략).
            if (snapshot.notModified) {
              if (isStaleSync()) {
                return;
              }
              clearOfflineRecoveryLoop();
              set({
                secureStateReady: true,
                auth: authenticatedAuth,
                syncStatus: readySyncStatus,
              });
              ensureSyncPollingLifecycle();
              return;
            }
            // 주의: lastSyncRevision 은 여기서 설정하지 않는다. 아직 볼트가 잠겨 있어
            // 디코드하지 못하는 경우가 있는데(신규 기기), 여기서 revision 을 저장하면
            // 잠금해제 후 폴링이 304 를 받아 디코드를 건너뛰고 워크스페이스가 빈 채로
            // 남는다. 실제로 디코드·적용에 성공한 뒤에만(아래 성공 경로) 저장한다.
            const snapshotEtag = snapshot.etag;
            // notModified 는 위에서 반환했으므로 판별 유니온이 payload 를 non-null 로 좁힌다.
            const payload = snapshot.payload;

            // 볼트 상태 결정 — epoch/verifier 판정(applyVaultCacheDecision) 하나로
            // 로컬 unlocked(hot)·키체인 복원(cold)을 구분 없이 처리한다. 자기 재설정
            // 직후의 낡은 descriptor 는 epoch 규칙이 무시한다.
            const previousVault = get().vault;
            const vaultState = await resolveVaultStateForSession(
              currentSession,
              previousVault,
              get().settings.serverUrl,
            );

            // 설정·잠금해제가 필요한 상태에서는 데이터를 복호화할 수 없다 — 게이트
            // 화면(RootNavigator)이 뜨고, 해제 후 syncNow 로 이어서 내려받는다.
            if (
              (vaultState.status !== 'legacy' &&
                vaultState.status !== 'unlocked') ||
              (vaultState.status === 'legacy' && vaultState.migrationRequired)
            ) {
              if (isStaleSync()) {
                return;
              }
              clearOfflineRecoveryLoop();
              set({
                vault: vaultState,
                secureStateReady: true,
                auth: authenticatedAuth,
                syncStatus: readySyncStatus,
              });
              return;
            }

            const vaultKeyBase64 =
              vaultState.status === 'unlocked'
                ? vaultState.dekBase64
                : requireLegacyVaultKey(currentSession);

            let nextHosts: ReturnType<typeof sortHosts>;
            let nextGroups: GroupRecord[];
            let nextAwsProfiles: ManagedAwsProfilePayload[];
            let nextKnownHosts: KnownHostRecord[];
            let nextSecretsByRef: Record<string, LoadedManagedSecretPayload>;
            try {
              nextHosts = sortHosts(
                decodeSupportedHosts(payload, vaultKeyBase64),
              );
              nextGroups = sortGroups(decodeGroups(payload, vaultKeyBase64));
              nextAwsProfiles = decodeAwsProfiles(payload, vaultKeyBase64);
              nextKnownHosts = decodeKnownHosts(payload, vaultKeyBase64);
              nextSecretsByRef = decodeManagedSecrets(payload, vaultKeyBase64);
            } catch (decodeError) {
              if (vaultState.status !== 'unlocked') {
                throw decodeError;
              }
              clearOfflineRecoveryLoop();
              // 복호화 실패 — 세대 교체(다른 기기의 초기화 후 재설정)일 수도, 데이터
              // 손상일 수도 있다. 세션을 갱신해 최신 descriptor 의 epoch/verifier 로
              // 재판정한다(비파괴 — refresh 실패 시 상태를 바꾸지 않고 다음 폴링이
              // 재시도한다). 진짜 세대 교체면 재판정이 캐시를 정리하고 잠근다.
              let reconciled: MobileVaultState = vaultState;
              let reconciledAuth = authenticatedAuth;
              try {
                const refreshed = await acceptAuthSession(
                  await refreshAuthSession(
                    get().settings.serverUrl,
                    currentSession,
                  ),
                );
                reconciled = await resolveStoredVaultState(refreshed);
                reconciledAuth = {
                  status: 'authenticated',
                  session: refreshed,
                  offline: null,
                  errorMessage: null,
                };
              } catch {
                // 재판정 근거 없음 — 상태 유지.
              }
              if (isStaleSync()) {
                return;
              }
              if (reconciled.status === 'unlocked') {
                // 재판정 후에도 verifier 가 이 DEK 를 증명한다(세대 그대로) — 원인은
                // DEK 가 아니라 데이터 손상이다. 재잠금해 봐야 같은 DEK 를 다시 받을
                // 뿐이므로(무한 재입력 루프) 오류로 표시한다.
                set({
                  vault: reconciled,
                  secureStateReady: true,
                  auth: reconciledAuth,
                  syncStatus: {
                    ...readySyncStatus,
                    status: 'error',
                    errorMessage:
                      t('store.syncDecryptFailed'),
                  },
                });
                return;
              }
              // 여기 도달 = unlocked → locked/none 전이(세대 교체 확정). in-flight
              // 작업이 옛 unlocked 상태를 되살리지 못하게 세대를 올린다.
              vaultSyncGeneration += 1;
              set({
                vault: reconciled,
                secureStateReady: true,
                auth: reconciledAuth,
                syncStatus: {
                  ...readySyncStatus,
                  status: 'error',
                  errorMessage:
                    t('store.vaultResetElsewhere'),
                },
              });
              return;
            }
            if (isStaleSync()) {
              // 복호화는 성공했지만 그 사이 볼트 세대가 바뀌었다(잠금해제/설정/초기화)
              // — 이 결과는 이전 세대의 것이므로 적용하지 않는다. ETag 도 저장하지
              // 않아 새 세대의 첫 pull 이 304 로 가려지지 않는다.
              return;
            }

            // 서버가 진짜 비어 있는데(tombstone 조차 0 = 초기화 직후/서버 유실) 로컬에
            // 데이터가 있으면, 빈 스냅샷을 적용해 로컬을 비우는 대신 로컬을 재업로드한다
            // — 데스크톱 runBootstrap 과 같은 자연 복구 규칙. 재설정 직후 복구 push 가
            // 실패했더라도 다음 폴링이 이 경로로 스스로 치유한다.
            const localState = get();
            const hasLocalDataToRecover =
              localState.hosts.length > 0 ||
              localState.groups.length > 0 ||
              localState.knownHosts.length > 0 ||
              localState.awsProfiles.length > 0 ||
              Object.keys(localState.secretsByRef).length > 0;
            if (
              countSyncPayloadRecords(payload) === 0 &&
              hasLocalDataToRecover
            ) {
              const recoveryRevision = await postSyncSnapshot(
                get().settings.serverUrl,
                currentSession.tokens.accessToken,
                buildLocalStateSyncPayload(
                  {
                    hosts: localState.hosts,
                    groups: localState.groups,
                    knownHosts: localState.knownHosts,
                    secrets: Object.values(localState.secretsByRef),
                    awsProfiles: localState.awsProfiles,
                  },
                  vaultKeyBase64,
                ),
                vaultState.status === 'unlocked' ? vaultState.epoch : null,
              );
              if (isStaleSync()) {
                return;
              }
              storePushedRevision(recoveryRevision);
              clearOfflineRecoveryLoop();
              set({
                vault: vaultState,
                secureStateReady: true,
                auth: authenticatedAuth,
                syncStatus: readySyncStatus,
              });
              if (
                vaultState.status === 'unlocked' ||
                vaultState.status === 'legacy'
              ) {
                ensureSyncPollingLifecycle();
              }
              return;
            }

            // 성공적으로 복호화·적용했으니 이제서야 revision 을 저장한다
            // (실제 적용 후에만 — C1 빈 워크스페이스 방지).
            if (snapshotEtag) {
              lastSyncRevision = snapshotEtag;
            }

            await updateSecretsState(nextSecretsByRef, nextHosts);
            await saveStoredAwsProfiles(nextAwsProfiles);
            // v1(레거시) 키를 DEK 캐시에 선저장(pre-seeding) — 나중에 이 계정이 어느
            // 기기에서든 E2EE 로 전환돼도(DEK 동일 → verifier 일치) 이 기기는 암호
            // 재입력 없이 잠금이 풀린 상태로 이어진다.
            if (vaultState.status === 'legacy') {
              void saveStoredVaultDek(
                vaultKeyBase64,
                currentSession.vaultBootstrap.epoch ?? 0,
                createVaultCacheOwner(currentSession, get().settings.serverUrl),
              ).catch(() => undefined);
            }
            clearOfflineRecoveryLoop();
            set({
              vault: vaultState,
              groups: nextGroups,
              hosts: nextHosts,
              awsProfiles: nextAwsProfiles,
              knownHosts: sortKnownHosts(nextKnownHosts),
              secureStateReady: true,
              auth: authenticatedAuth,
              syncStatus: readySyncStatus,
            });
            // 인증 + 동기화 성공 — 포그라운드 폴링을 시작한다(잠금해제 상태에서만 pull).
            if (
              vaultState.status === 'unlocked' ||
              vaultState.status === 'legacy'
            ) {
              ensureSyncPollingLifecycle();
            }
          } catch (error) {
            if (isStaleSync()) {
              // 세대가 바뀐 sync 의 실패는 무의미하다 — 상태를 건드리지 않는다.
              return;
            }
            if (await handleVaultDekMismatchError(error)) {
              return;
            }
            if (
              isLikelyNetworkError(error) &&
              isOfflineLeaseActive(currentSession)
            ) {
              const previousVault = get().vault;
              const offlineVaultState =
                previousVault.status === 'unlocked'
                  ? previousVault
                  : await resolveStoredVaultState(currentSession);
              set({
                auth: {
                  status: 'offline-authenticated',
                  session: currentSession,
                  offline: buildOfflineState(
                    currentSession,
                    t('store.usingCache'),
                  ),
                  errorMessage: null,
                },
                vault: offlineVaultState,
                syncStatus: {
                  ...get().syncStatus,
                  status: 'paused',
                  errorMessage:
                    error instanceof Error
                      ? error.message
                      : t('store.networkUnavailable'),
                },
              });
              scheduleOfflineRecoveryRetry(
                currentSession,
                get().settings.serverUrl,
                {
                  reset: true,
                },
              );
              return;
            }

            if (error instanceof ApiError && error.status === 401) {
              await clearPersistedSecureState();
              clearOfflineRecoveryLoop();
              set({
                auth: {
                  ...createUnauthenticatedState(),
                  errorMessage: t('store.sessionExpiredSignIn'),
                },
                syncStatus: {
                  ...createDefaultSyncStatus(),
                  status: 'error',
                  errorMessage: t('store.sessionExpired'),
                },
                ...createEmptyProtectedState(),
              });
              return;
            }

            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                status: 'error',
                errorMessage: getSyncFailureMessage(
                  error,
                  options?.context ?? 'sync',
                ),
              },
            }));
          } finally {
            syncPromise = null;
          }
        })();

        return syncPromise;
      };

      const clearPrompts = clearPromptState;

      const captureVaultOperationContext = (): VaultOperationContext => {
        const auth = get().auth;
        const session = auth.session;
        if (auth.status !== 'authenticated' || !session) {
          throw new Error(t('store.onlineOnly'));
        }
        return {
          userId: session.user.id,
          serverUrl: normalizeServerUrl(get().settings.serverUrl),
        };
      };

      const assertVaultOperationContext = (
        context: VaultOperationContext,
      ): void => {
        const auth = get().auth;
        const session = auth.session;
        if (
          auth.status !== 'authenticated' ||
          !session ||
          session.user.id !== context.userId ||
          normalizeServerUrl(get().settings.serverUrl) !== context.serverUrl
        ) {
          throw new Error(
            t('store.vaultCancelledAccountChanged'),
          );
        }
      };

      // 인증 필요한 볼트 API 호출 공통 래퍼 — access 토큰이 만료(401/403)면 refresh 후
      // 1회 재시도한다(데스크톱 auth-service·deleteAccount 와 동일한 규약).
      const callWithFreshAccessToken = async <T>(
        run: (accessToken: string) => Promise<T>,
        operationContext?: VaultOperationContext,
      ): Promise<T> => {
        if (operationContext) {
          assertVaultOperationContext(operationContext);
        }
        const auth = get().auth;
        const session = auth.session;
        if (auth.status !== 'authenticated' || !session) {
          throw new Error(t('store.onlineOnly'));
        }

        try {
          const result = await run(session.tokens.accessToken);
          if (operationContext) {
            assertVaultOperationContext(operationContext);
          }
          return result;
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            (error.status !== 401 && error.status !== 403)
          ) {
            throw error;
          }

          if (operationContext) {
            assertVaultOperationContext(operationContext);
          }

          let refreshed: AuthSession;
          try {
            const received = await refreshAuthSession(
              operationContext?.serverUrl ?? get().settings.serverUrl,
              session,
              {
                timeoutMs: VAULT_MUTATION_TIMEOUT_MS,
                timeoutMessage: getVaultMutationTimeoutMessage(),
              },
            );
            if (operationContext) {
              assertVaultOperationContext(operationContext);
            }
            refreshed = await acceptAuthSession(received);
            if (operationContext) {
              assertVaultOperationContext(operationContext);
            }
          } catch {
            if (operationContext) {
              assertVaultOperationContext(operationContext);
            }
            throw new Error(
              t('store.sessionExpiredRetry'),
            );
          }
          set({
            auth: {
              status: 'authenticated',
              session: refreshed,
              offline: null,
              errorMessage: null,
            },
          });
          const result = await run(refreshed.tokens.accessToken);
          if (operationContext) {
            assertVaultOperationContext(operationContext);
          }
          return result;
        }
      };

      // 409(다른 기기가 먼저 볼트 설정/전환) 복구: 세션을 갱신해 최신 descriptor 를 받고
      // 볼트 상태를 재해석한다. 실패해도 다음 refresh 에서 따라오므로 조용히 넘어간다.
      const refreshSessionAndResolveVault = async (): Promise<void> => {
        const session = get().auth.session;
        if (!session) {
          return;
        }
        try {
          const refreshed = await acceptAuthSession(
            await refreshAuthSession(get().settings.serverUrl, session),
          );
          const nextVault = await resolveStoredVaultState(refreshed);
          set({
            auth: {
              status: 'authenticated',
              session: refreshed,
              offline: null,
              errorMessage: null,
            },
            vault: nextVault,
          });
        } catch {}
      };

      // 로그아웃·회원 탈퇴가 공유하는 로컬 정리 — keychain 자격증명과 메모리 상태를 모두 비운다.
      const resetToSignedOutState = async () => {
        await clearStoredAuthSession();
        await clearStoredSecrets();
        await clearStoredAwsProfiles();
        await clearStoredAwsSsoTokens();
        await clearStoredVaultDek();
        set({
          auth: createUnauthenticatedState(),
          vault: { status: 'none' },
          vaultMigrationDeferred: false,
          groups: [],
          hosts: [],
          awsProfiles: [],
          knownHosts: [],
          secretMetadata: [],
          secretsByRef: {},
          sessions: [],
          sftpSessions: [],
          sftpTransfers: [],
          sftpCopyBuffer: null,
          activeSessionTabId: null,
          activeConnectionTab: null,
          syncStatus: createDefaultSyncStatus(),
          pendingBrowserLoginState: null,
          pendingAwsSsoLogin: null,
          pendingServerKeyPrompt: null,
          pendingCredentialPrompt: null,
        });
      };

      return {
        hydrated: false,
        terminalGrid: null,
        reportTerminalGrid: (size: TerminalGridSize) => {
          setReportedTerminalGrid(size);
          const current = get().terminalGrid;
          if (current?.cols === size.cols && current?.rows === size.rows) {
            return;
          }
          set({ terminalGrid: size });
        },
        bootstrapping: false,
        authGateResolved: false,
        secureStateReady: false,
        auth: createUnauthenticatedState(),
        vault: { status: 'none' } as MobileVaultState,
        vaultMigrationDeferred: false,
        settings: createDefaultMobileSettings(),
        syncStatus: createDefaultSyncStatus(),
        groups: [],
        hosts: [],
        awsProfiles: [],
        knownHosts: [],
        secretMetadata: [],
        sessions: [],
        sftpSessions: [],
        sftpTransfers: [],
        sftpCopyBuffer: null,
        activeSessionTabId: null,
        activeConnectionTab: null,
        secretsByRef: {},
        pendingBrowserLoginState: null,
        pendingAwsSsoLogin: null,
        pendingServerKeyPrompt: null,
        pendingCredentialPrompt: null,
        initializeApp: async () => {
          if (initializePromise) {
            return initializePromise;
          }

          initializePromise = (async () => {
            set({
              bootstrapping: true,
              authGateResolved: false,
              secureStateReady: false,
            });

            try {
              const finishStoredAuthLoadTiming =
                beginStartupTiming('stored auth load');
              const storedSession = await loadStoredAuthSession();
              finishStoredAuthLoadTiming?.();
              if (!storedSession) {
                clearOfflineRecoveryLoop();
                secureStateRestoreVersion += 1;
                resolveAuthGate({
                  auth: createUnauthenticatedState(),
                  syncStatus: createDefaultSyncStatus(),
                  ...createEmptyProtectedState(),
                });
                void clearPersistedSecureState();
                return;
              }

              const currentServerUrl = get().settings.serverUrl;
              const currentRestoreVersion = secureStateRestoreVersion + 1;
              secureStateRestoreVersion = currentRestoreVersion;
              clearOfflineRecoveryLoop();
              resolveAuthGate(
                {
                  auth: {
                    status: 'authenticated',
                    session: storedSession,
                    offline: null,
                    errorMessage: null,
                  },
                  syncStatus: {
                    ...get().syncStatus,
                    status: 'syncing',
                    errorMessage: null,
                  },
                },
                {
                  secureStateReady: false,
                },
              );
              void restoreStoredSecureStateInBackground(
                currentServerUrl,
                currentRestoreVersion,
              );
              void restoreStoredSessionInBackground(
                storedSession,
                currentServerUrl,
              );
            } finally {
              set({ bootstrapping: false });
              initializePromise = null;
            }
          })();

          return initializePromise;
        },
        handleAuthCallbackUrl: async (url: string) => {
          const payload = parseAuthCallbackUrl(url);
          if (!payload) {
            return;
          }

          // 콜백 딥링크로 앱이 앞으로 나와도 로그인 시트는 그대로 떠 있다 — 교환 결과와
          // 무관하게 먼저 닫아 이후 진행(또는 오류)을 앱에서 보게 한다. pending 여부보다
          // 앞에서 닫는다: 브리지 페이지가 아직 떠 있는 시트에서 한 번 더 "Open Dolgate" 를
          // 누르면 pending 이 이미 비어 있어, 아래 가드에서 돌아가면 시트가 화면에 남는다.
          void closeInAppBrowser().catch(() => undefined);

          const expectedState = get().pendingBrowserLoginState;
          if (!expectedState) {
            return;
          }
          const stateValidationMessage = getAuthCallbackStateErrorMessage(
            expectedState,
            payload.state,
          );
          if (stateValidationMessage) {
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: stateValidationMessage,
              },
              pendingBrowserLoginState: null,
            });
            return;
          }

          set(state => ({
            auth: {
              ...state.auth,
              status: 'authenticating',
              errorMessage: null,
            },
          }));

          try {
            const session = await acceptAuthSession(
              await fetchExchangeSession(
                get().settings.serverUrl,
                payload.code,
              ),
            );
            clearOfflineRecoveryLoop();
            set({
              auth: {
                status: 'authenticated',
                session,
                offline: null,
                errorMessage: null,
              },
              pendingBrowserLoginState: null,
            });
            await syncWithSession(session, { context: 'login' });
          } catch (error) {
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : t('store.loginExchangeFailed'),
              },
              pendingBrowserLoginState: null,
            });
          }
        },
        startBrowserLogin: async () => {
          const validationMessage = getSettingsValidationMessage(
            get().settings.serverUrl,
          );
          if (validationMessage) {
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: validationMessage,
              },
            });
            return;
          }

          const stateToken = createRandomStateToken();
          set({
            pendingBrowserLoginState: stateToken,
            auth: {
              ...get().auth,
              status: 'authenticating',
              errorMessage: null,
            },
          });

          try {
            // 시스템 브라우저가 아니라 앱 안의 브라우저 시트에서 로그인한다 — 앱을 벗어나
            // 로그인시키면 App Store 심사 Guideline 4.0 에 걸린다(1.8.5 리젝 사유).
            await openInAppBrowser(
              buildBrowserLoginUrl(get().settings.serverUrl, stateToken),
            );
          } catch {
            // 네이티브 reject 문구는 지역화되지 않은 진단용이라 그대로 보여주지 않는다 —
            // 이 경로의 문구를 쓴다. 원문은 in-app-browser 가 콘솔에 남긴다.
            set({
              pendingBrowserLoginState: null,
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: t('store.browserLoginFailed'),
              },
            });
          }
        },
        cancelBrowserLogin: () => {
          // 앱에서 취소를 눌렀으면 아직 떠 있는 로그인 시트도 같이 닫는다.
          void closeInAppBrowser().catch(() => undefined);
          set({
            pendingBrowserLoginState: null,
            auth: createUnauthenticatedState(),
          });
        },
        cancelAwsSsoLogin: () => {
          pendingAwsSsoCancelHandler?.();
          pendingAwsSsoCancelHandler = null;
          set({
            pendingAwsSsoLogin: null,
          });
        },
        reopenAwsSsoLogin: async () => {
          const pending = get().pendingAwsSsoLogin;
          if (!pending?.browserUrl) {
            return;
          }
          try {
            await openAwsSsoBrowser(pending.browserUrl);
          } catch {
            set(state => ({
              auth: {
                ...state.auth,
                errorMessage: t('store.reopenBrowserFailed'),
              },
            }));
          }
        },
        logout: async () => {
          clearOfflineRecoveryLoop();
          invalidateSyncRuntime();
          secureStateRestoreVersion += 1;
          clearPrompts();
          await disconnectAllRuntimeSessions();

          try {
            await logoutRemoteSession(
              get().settings.serverUrl,
              get().auth.session ?? null,
            );
          } catch {}

          await resetToSignedOutState();
        },
        // 회원 탈퇴 — 서버의 모든 사용자 데이터를 즉시 영구 삭제한 뒤(DELETE /auth/account)
        // 로컬 상태를 로그아웃과 동일하게 정리한다. 서버 삭제가 실패하면 로컬은 건드리지
        // 않고 에러를 그대로 올려 UI에서 안내한다.
        deleteAccount: async () => {
          if (get().auth.status !== 'authenticated' || !get().auth.session) {
            throw new Error(
              t('store.deleteAccountOnlineOnly'),
            );
          }

          // access 토큰 만료(401/403) 시 refresh 후 1회 재시도는 공통 래퍼가 처리한다.
          await callWithFreshAccessToken(accessToken =>
            deleteRemoteAccount(get().settings.serverUrl, accessToken),
          );

          // 서버 세션과 refresh 토큰은 탈퇴로 이미 삭제됐으므로 로그아웃과 달리
          // 원격 로그아웃 호출 없이 이 기기의 로컬 상태만 정리한다.
          clearOfflineRecoveryLoop();
          invalidateSyncRuntime();
          secureStateRestoreVersion += 1;
          clearPrompts();
          await disconnectAllRuntimeSessions();

          await resetToSignedOutState();
        },
        changeAccountPassword: async (
          currentPassword: string,
          newPassword: string,
        ) => {
          const auth = get().auth;
          const session = auth.session;
          if (auth.status !== 'authenticated' || !session) {
            throw new Error(
              t('store.passwordOnlineOnly'),
            );
          }
          const userID = session.user.id;
          const serverUrl = normalizeServerUrl(get().settings.serverUrl);

          await callWithFreshAccessToken(accessToken => {
            const currentSession = get().auth.session;
            if (!currentSession || currentSession.user.id !== userID) {
              throw new Error(t('store.cancelledAccountChanged'));
            }
            return changeRemoteAccountPassword(
              serverUrl,
              accessToken,
              currentSession.tokens.refreshToken,
              currentPassword,
              newPassword,
            );
          });

          const currentAuth = get().auth;
          const currentSession = currentAuth.session;
          if (
            currentAuth.status !== 'authenticated' ||
            !currentSession ||
            currentSession.user.id !== userID ||
            normalizeServerUrl(get().settings.serverUrl) !== serverUrl
          ) {
            throw new Error(
              t('store.cancelledAccountOrServerChanged'),
            );
          }
          const updatedSession: AuthSession = {
            ...currentSession,
            user: { ...currentSession.user, passwordState: 'set' },
          };
          await saveStoredAuthSession(updatedSession);
          set({
            auth: { ...currentAuth, session: updatedSession },
          });
        },
        // 동기화 암호 최초 설정(신규 유저) — DEK 를 이 기기에서 만들고 암호로 감싸
        // 서버에 올린다. 서버는 감싼 DEK 만 보관하므로 이후 어떤 시점에도 복호화할 수 없다.
        setupVault: async (passphrase: string) => {
          const setupState = get().vault;
          if (setupState.status !== 'setup-required') {
            throw new Error(t('store.vaultAlreadySet'));
          }
          assertVaultPassphrase(passphrase);
          const ownerSession = get().auth.session;
          if (!ownerSession) {
            throw new Error(t('store.signInRequired'));
          }
          const operationContext = captureVaultOperationContext();
          const cacheOwner = createVaultCacheOwner(
            ownerSession,
            operationContext.serverUrl,
          );

          const dek = createVaultDek();
          const kdf = createVaultKdfDescriptor();
          const kek = await deriveVaultKek(
            nativeArgon2idDerive,
            passphrase,
            kdf,
          );
          const wrappedDekBase64 = wrapVaultDek(dek, kek);
          const dekVerifierBase64 = computeVaultDekVerifier(dek);
          assertVaultOperationContext(operationContext);

          let epoch = 0;
          let wrapRevision = 0;
          try {
            const mutation = await callWithFreshAccessToken(
              accessToken =>
                postVaultSetup(operationContext.serverUrl, accessToken, {
                  wrappedDekBase64,
                  dekVerifierBase64,
                  kdf,
                  expectedEpoch: setupState.epoch,
                }),
              operationContext,
            );
            epoch = mutation.epoch ?? 0;
            wrapRevision = mutation.wrapRevision ?? 0;
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              // 다른 기기가 먼저 설정했다 — 세션을 갱신해 descriptor 를 받아
              // 잠금해제 플로우로 전환한다.
              await refreshSessionAndResolveVault();
            }
            throw error;
          }
          assertVaultOperationContext(operationContext);

          const dekBase64 = fromByteArray(dek);
          // 볼트 세대의 경계 — 이전 세대의 ETag 를 버리고, in-flight sync 를 무효화한다.
          lastSyncRevision = null;
          vaultSyncGeneration += 1;
          set({
            vault: {
              status: 'unlocked',
              dekBase64,
              wrappedDekBase64,
              kdf,
              epoch,
              wrapRevision,
              owner: cacheOwner,
              dekVerifierBase64,
            },
          });
          await saveStoredVaultDek(dekBase64, epoch, cacheOwner, {
            wrappedDekBase64,
            kdf,
            dekVerifierBase64,
            wrapRevision,
          }).catch(error => {
            assertVaultOperationContext(operationContext);
            console.warn('Failed to persist the mobile vault cache.', error);
            set(state => ({
              auth: {
                ...state.auth,
                errorMessage:
                  t('store.vaultKeyStoreFailed'),
              },
            }));
          });
          assertVaultOperationContext(operationContext);
          // 알고 있는 값으로 저장 세션 descriptor 를 즉시 합성(아래 refresh 실패 대비).
          await persistSynthesizedVaultDescriptor();
          assertVaultOperationContext(operationContext);

          // 초기화(reset) 전의 로컬 데이터가 남아 있으면(자연 복구 경로) 첫 pull 이
          // 빈 서버 스냅샷으로 로컬을 비우기 전에 새 DEK 로 재암호화해 올린다 —
          // 데스크톱의 "로컬 보존 → 첫 push 재업로드"와 같은 시맨틱.
          const local = get();
          const hasLocalData =
            local.hosts.length > 0 ||
            local.groups.length > 0 ||
            local.knownHosts.length > 0 ||
            local.awsProfiles.length > 0 ||
            Object.keys(local.secretsByRef).length > 0;
          if (hasLocalData) {
            try {
              const pushedRevision = await callWithFreshAccessToken(
                accessToken =>
                  postSyncSnapshot(
                    operationContext.serverUrl,
                    accessToken,
                    buildLocalStateSyncPayload(
                      {
                        hosts: local.hosts,
                        groups: local.groups,
                        knownHosts: local.knownHosts,
                        secrets: Object.values(local.secretsByRef),
                        awsProfiles: local.awsProfiles,
                      },
                      dekBase64,
                    ),
                    epoch,
                  ),
                operationContext,
              );
              storePushedRevision(pushedRevision);
            } catch (error) {
              assertVaultOperationContext(operationContext);
              // 복구 push 실패 — 여기서 pull 로 이어가면 빈 서버 스냅샷이 로컬을 통째로
              // 비워버린다(복구 원본 소실). pull 을 중단하고 오류로 표시한다 — 다음
              // 폴링의 "빈 서버 + 로컬 데이터 → 재업로드" 규칙이 스스로 재시도한다.
              set(state => ({
                syncStatus: {
                  ...state.syncStatus,
                  status: 'error',
                  pendingPush: true,
                  errorMessage:
                    error instanceof Error
                      ? error.message
                      : t('store.reuploadFailed'),
                },
              }));
              ensureSyncPollingLifecycle();
              return;
            }
          }
          assertVaultOperationContext(operationContext);

          // 세션 descriptor 를 v2(새 epoch/verifier)로 갱신해 저장 세션과 캐시를 맞춘다.
          // 갱신 전에 낡은 descriptor 가 와도 epoch 규칙(내 epoch 보다 낮으면 무시)이
          // 방금 만든 DEK 를 보호한다. 실패해도 다음 refresh 에서 따라오므로 무해하다.
          const setupSession = get().auth.session;
          if (setupSession) {
            try {
              const refreshed = await acceptAuthSession(
                await refreshAuthSession(
                  operationContext.serverUrl,
                  setupSession,
                ),
              );
              set({
                auth: {
                  status: 'authenticated',
                  session: refreshed,
                  offline: null,
                  errorMessage: null,
                },
              });
            } catch {}
          }
          assertVaultOperationContext(operationContext);
          await syncWithSession();
        },
        // 동기화 암호 입력(새 기기 로그인) — 암호가 틀리면 GCM 인증 실패로 unwrap 이
        // 던져진다. 성공하면 DEK 를 keychain 에 캐시해 재입력을 없앤다.
        unlockVault: async (passphrase: string) => {
          const vault = get().vault;
          if (vault.status !== 'locked') {
            return;
          }
          const ownerSession = get().auth.session;
          if (!ownerSession) {
            throw new Error(t('store.signInRequired'));
          }
          const operationContext = captureVaultOperationContext();
          const cacheOwner = createVaultCacheOwner(
            ownerSession,
            operationContext.serverUrl,
          );

          let dek: Uint8Array;
          try {
            const kek = await deriveVaultKek(
              nativeArgon2idDerive,
              passphrase,
              vault.kdf,
            );
            dek = unwrapVaultDek(vault.wrappedDekBase64, kek);
          } catch {
            throw new Error(t('store.vaultPassphraseWrong'));
          }
          assertVaultOperationContext(operationContext);

          const dekBase64 = fromByteArray(dek);
          const dekVerifierBase64 = computeVaultDekVerifier(dek);
          if (
            vault.dekVerifierBase64 &&
            vault.dekVerifierBase64 !== dekVerifierBase64
          ) {
            await refreshSessionAndResolveVault().catch(() => undefined);
            throw new Error(
              t('store.vaultKeyVerifyFailed'),
            );
          }
          // 볼트 세대의 경계 — 이전 세대의 ETag 로 304 를 받아 새 스냅샷을 놓치지 않게
          // 리셋하고, in-flight sync 가 잠긴 상태를 되살리지 못하게 세대를 올린다.
          lastSyncRevision = null;
          vaultSyncGeneration += 1;
          set({
            vault: {
              status: 'unlocked',
              dekBase64,
              wrappedDekBase64: vault.wrappedDekBase64,
              kdf: vault.kdf,
              epoch: vault.epoch,
              wrapRevision: vault.wrapRevision,
              owner: cacheOwner,
              dekVerifierBase64,
            },
          });
          await saveStoredVaultDek(dekBase64, vault.epoch, cacheOwner, {
            wrappedDekBase64: vault.wrappedDekBase64,
            kdf: vault.kdf,
            dekVerifierBase64,
            wrapRevision: vault.wrapRevision,
          }).catch(error => {
            assertVaultOperationContext(operationContext);
            console.warn('Failed to persist the mobile vault cache.', error);
            set(state => ({
              auth: {
                ...state.auth,
                errorMessage:
                  t('store.vaultKeyStoreFailed'),
              },
            }));
          });
          assertVaultOperationContext(operationContext);
          // verifier 도입 이전 볼트(descriptor 에 verifier 없음)는 여기서 지연 백필한다
          // — 방금 암호로 DEK 를 증명했으므로 이 시점의 verifier 계산만이 안전하다.
          // 같은 wrapped/kdf 를 그대로 보내는 no-op rewrap 이며, 실패해도 무해하다.
          if (!vault.dekVerifierBase64) {
            void callWithFreshAccessToken(
              accessToken =>
                putVaultRewrap(operationContext.serverUrl, accessToken, {
                  wrappedDekBase64: vault.wrappedDekBase64,
                  dekVerifierBase64,
                  kdf: vault.kdf,
                  expectedEpoch: vault.epoch,
                  expectedDekVerifierBase64: '',
                  expectedWrapRevision: vault.wrapRevision,
                }),
              operationContext,
            ).catch(() => undefined);
          }
          assertVaultOperationContext(operationContext);
          await syncWithSession();
        },
        // 기존(v1) 유저의 E2EE 전환 — 서버가 알고 있던 기존 DEK 를 사용자가 정한
        // 동기화 암호로 감싸 올리고, 서버는 같은 트랜잭션에서 원문을 삭제한다.
        // DEK 가 그대로라 데이터 재암호화가 없고, pre-seeding 된 다른 기기들도
        // 재입력 없이 이어진다.
        migrateVault: async (passphrase: string) => {
          const vault = get().vault;
          if (vault.status !== 'legacy') {
            throw new Error(t('store.migrationNotAvailable'));
          }
          assertVaultPassphrase(passphrase);
          const session = get().auth.session;
          if (get().auth.status !== 'authenticated' || !session) {
            throw new Error(t('store.migrationOnlineOnly'));
          }
          const operationContext = captureVaultOperationContext();

          const keyBase64 = requireLegacyVaultKey(session);
          const kdf = createVaultKdfDescriptor();
          const kek = await deriveVaultKek(
            nativeArgon2idDerive,
            passphrase,
            kdf,
          );
          const legacyDek = toByteArray(keyBase64);
          const wrappedDekBase64 = wrapVaultDek(legacyDek, kek);
          const dekVerifierBase64 = computeVaultDekVerifier(legacyDek);
          assertVaultOperationContext(operationContext);

          let epoch = 0;
          let wrapRevision = 0;
          try {
            const mutation = await callWithFreshAccessToken(
              accessToken =>
                postVaultSetup(operationContext.serverUrl, accessToken, {
                  wrappedDekBase64,
                  dekVerifierBase64,
                  kdf,
                  expectedEpoch: vault.epoch,
                }),
              operationContext,
            );
            epoch = mutation.epoch ?? 0;
            wrapRevision = mutation.wrapRevision ?? 0;
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              // 다른 기기가 먼저 전환했다 — 세션을 갱신해 v2 descriptor 를 받는다.
              // pre-seeding 된 DEK 캐시가 verifier 검증을 통과해 곧바로 unlocked 로
              // 이어진다.
              await refreshSessionAndResolveVault();
              throw new Error(
                t('store.vaultSetElsewhere'),
              );
            }
            throw error;
          }
          assertVaultOperationContext(operationContext);

          const cacheOwner = createVaultCacheOwner(
            session,
            operationContext.serverUrl,
          );
          vaultSyncGeneration += 1;
          set({
            vault: {
              status: 'unlocked',
              dekBase64: keyBase64,
              wrappedDekBase64,
              kdf,
              epoch,
              wrapRevision,
              owner: cacheOwner,
              dekVerifierBase64,
            },
          });
          await saveStoredVaultDek(keyBase64, epoch, cacheOwner, {
            wrappedDekBase64,
            kdf,
            dekVerifierBase64,
            wrapRevision,
          }).catch(error => {
            assertVaultOperationContext(operationContext);
            console.warn('Failed to persist the mobile vault cache.', error);
            set(state => ({
              auth: {
                ...state.auth,
                errorMessage:
                  t('store.vaultKeyStoreFailed'),
              },
            }));
          });
          assertVaultOperationContext(operationContext);
          // 알고 있는 값으로 저장 세션 descriptor 를 즉시 합성(아래 refresh 실패 대비).
          await persistSynthesizedVaultDescriptor();
          assertVaultOperationContext(operationContext);

          // 세션 descriptor 를 서버 기준으로도 갱신 — 실패해도 다음 refresh 에서 따라온다.
          try {
            const refreshed = await acceptAuthSession(
              await refreshAuthSession(operationContext.serverUrl, session),
            );
            set({
              auth: {
                status: 'authenticated',
                session: refreshed,
                offline: null,
                errorMessage: null,
              },
            });
          } catch {}
          assertVaultOperationContext(operationContext);
          await syncWithSession();
        },
        deferVaultMigration: () => {
          const vault = get().vault;
          if (vault.status === 'legacy' && vault.migrationRequired) {
            return;
          }
          set({ vaultMigrationDeferred: true });
        },
        // 볼트 초기화 — 동기화 암호 분실 최후 수단. 서버의 볼트와 sync 데이터 전부를
        // 삭제하고 새 동기화 암호 설정부터 다시 시작한다. 이 기기의 로컬 데이터(메모리에
        // 이미 복호화된 hosts/groups/secrets 등)는 지우지 않는다 — 데스크톱과 같은
        // 시맨틱으로, 재설정 직후 setupVault 가 새 DEK 로 재암호화해 서버로 재업로드하는
        // 자연 복구 경로가 된다(모바일이 유일 기기여도 데이터가 살아남는다).
        resetVault: async () => {
          const operationContext = captureVaultOperationContext();
          const currentVault = get().vault;
          const expectedEpoch =
            'epoch' in currentVault
              ? currentVault.epoch
              : get().auth.session?.vaultBootstrap.epoch ?? 0;
          let mutation;
          try {
            mutation = await callWithFreshAccessToken(
              accessToken =>
                postVaultReset(
                  operationContext.serverUrl,
                  accessToken,
                  expectedEpoch,
                ),
              operationContext,
            );
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              await refreshSessionAndResolveVault().catch(() => undefined);
            }
            throw error;
          }
          assertVaultOperationContext(operationContext);

          const currentAuth = get().auth;
          const currentSession = currentAuth.session;
          const previousEpoch = currentSession?.vaultBootstrap.epoch ?? 0;
          const epoch = mutation.epoch ?? previousEpoch + 1;
          const resetSession = currentSession
            ? {
                ...currentSession,
                vaultBootstrap: { version: 0 as const, epoch },
              }
            : null;
          // 초기화로 서버 리비전이 bump 됐다 — 옛 ETag 를 버려 재설정 후 첫 pull 이
          // 전체를 받게 하고, in-flight sync 가 옛 상태를 되살리지 못하게 세대를 올린다.
          lastSyncRevision = null;
          vaultSyncGeneration += 1;
          set(state => ({
            vault: { status: 'setup-required', epoch },
            ...(resetSession
              ? { auth: { ...state.auth, session: resetSession } }
              : {}),
          }));
          // 서버 reset은 이미 커밋됐다. 이후 Keychain/세션 캐시 정리는 best effort로
          // 처리해 로컬 IO 오류가 성공한 reset을 실패처럼 보이게 하지 않는다.
          await Promise.allSettled([
            clearStoredVaultDek(),
            resetSession
              ? saveStoredAuthSession(resetSession)
              : Promise.resolve(),
          ]);
          assertVaultOperationContext(operationContext);
        },
        // 동기화 암호 변경(rewrap) — DEK 는 그대로라 데이터 재암호화도, 다른 기기의
        // 재입력도 필요 없다.
        changeVaultPassphrase: async (
          currentPassphrase: string,
          nextPassphrase: string,
        ) => {
          const vault = get().vault;
          if (!hasCoherentVaultDescriptor(vault)) {
            throw new Error(t('store.unlockBeforeChange'));
          }
          assertVaultPassphrase(nextPassphrase);
          const ownerSession = get().auth.session;
          if (!ownerSession) {
            throw new Error(t('store.signInRequired'));
          }
          const operationContext = captureVaultOperationContext();
          const cacheOwner = createVaultCacheOwner(
            ownerSession,
            operationContext.serverUrl,
          );

          // 현재 암호 확인 — 현재 wrapped DEK 를 풀 수 있어야 한다.
          let unwrappedDek: Uint8Array;
          try {
            const currentKek = await deriveVaultKek(
              nativeArgon2idDerive,
              currentPassphrase,
              vault.kdf,
            );
            unwrappedDek = unwrapVaultDek(vault.wrappedDekBase64, currentKek);
          } catch {
            throw new Error(t('store.currentPassphraseWrong'));
          }
          assertVaultOperationContext(operationContext);
          if (fromByteArray(unwrappedDek) !== vault.dekBase64) {
            throw new Error(
              t('store.vaultCacheMismatch'),
            );
          }

          const nextKdf = createVaultKdfDescriptor();
          const nextKek = await deriveVaultKek(
            nativeArgon2idDerive,
            nextPassphrase,
            nextKdf,
          );
          const nextWrappedDekBase64 = wrapVaultDek(
            toByteArray(vault.dekBase64),
            nextKek,
          );
          assertVaultOperationContext(operationContext);
          const currentDekVerifierBase64 = computeVaultDekVerifier(
            toByteArray(vault.dekBase64),
          );

          // 암호 변경은 DEK 를 안 바꾸므로 epoch 도 그대로다(서버가 확인차 돌려준다).
          // verifier 를 함께 보내 verifier 도입 이전 볼트라면 이 기회에 백필한다
          // (unlocked = DEK 증명 완료 시점이므로 안전).
          let mutation;
          try {
            mutation = await callWithFreshAccessToken(
              accessToken =>
                putVaultRewrap(operationContext.serverUrl, accessToken, {
                  wrappedDekBase64: nextWrappedDekBase64,
                  dekVerifierBase64: currentDekVerifierBase64,
                  kdf: nextKdf,
                  expectedEpoch: vault.epoch,
                  expectedDekVerifierBase64: vault.dekVerifierBase64 ?? '',
                  expectedWrapRevision: vault.wrapRevision,
                }),
              operationContext,
            );
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              await refreshSessionAndResolveVault().catch(() => undefined);
            }
            throw error;
          }
          assertVaultOperationContext(operationContext);

          const epoch = mutation.epoch ?? vault.epoch;
          const wrapRevision = mutation.wrapRevision ?? vault.wrapRevision + 1;
          set({
            vault: {
              status: 'unlocked',
              dekBase64: vault.dekBase64,
              wrappedDekBase64: nextWrappedDekBase64,
              kdf: nextKdf,
              epoch,
              wrapRevision,
              owner: cacheOwner,
              dekVerifierBase64: currentDekVerifierBase64,
            },
          });
          await saveStoredVaultDek(vault.dekBase64, epoch, cacheOwner, {
            wrappedDekBase64: nextWrappedDekBase64,
            kdf: nextKdf,
            dekVerifierBase64: currentDekVerifierBase64,
            wrapRevision,
          }).catch(error => {
            assertVaultOperationContext(operationContext);
            console.warn('Failed to persist the mobile vault cache.', error);
            set(state => ({
              auth: {
                ...state.auth,
                errorMessage:
                  t('store.vaultKeyStoreFailed'),
              },
            }));
          });
          assertVaultOperationContext(operationContext);
          // 새 wrapped/kdf 를 저장 세션 descriptor 에도 즉시 반영 — 재시작 시 잠금
          // 화면이 옛 wrapped(옛 암호) 기준으로 뜨지 않게 한다.
          await persistSynthesizedVaultDescriptor();
          assertVaultOperationContext(operationContext);
        },
        syncNow: async () => {
          await syncWithSession();
        },
        updateSettings: async (input: Partial<MobileSettings>) => {
          const nextSettings: MobileSettings = {
            ...get().settings,
            ...input,
          };

          if (typeof input.serverUrl === 'string') {
            const validationMessage = getSettingsValidationMessage(
              input.serverUrl,
            );
            if (validationMessage) {
              set(state => ({
                auth: {
                  ...state.auth,
                  errorMessage: validationMessage,
                },
              }));
              return;
            }
          }

          const serverChanged =
            typeof input.serverUrl === 'string' &&
            input.serverUrl.trim() !== get().settings.serverUrl;

          if (serverChanged) {
            clearOfflineRecoveryLoop();
            // disconnect/Keychain 정리보다 먼저 세대를 올려, 그 사이 완료되는 이전 서버의
            // sync 응답도 현재 상태를 되살리지 못하게 한다.
            invalidateSyncRuntime();
            secureStateRestoreVersion += 1;
            clearPrompts();
            await disconnectAllRuntimeSessions();
          }

          if (serverChanged) {
            await clearStoredAuthSession();
            await clearStoredSecrets();
            await clearStoredAwsProfiles();
            await clearStoredAwsSsoTokens();
            await clearStoredVaultDek();
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: get().auth.session
                  ? t('store.serverChangedSignIn')
                  : null,
              },
              vault: { status: 'none' },
              vaultMigrationDeferred: false,
              groups: [],
              hosts: [],
              awsProfiles: [],
              knownHosts: [],
              secretMetadata: [],
              secretsByRef: {},
              sessions: [],
              sftpSessions: [],
              sftpTransfers: [],
              sftpCopyBuffer: null,
              activeSessionTabId: null,
              activeConnectionTab: null,
              syncStatus: createDefaultSyncStatus(),
              pendingBrowserLoginState: null,
              pendingAwsSsoLogin: null,
            });
          }

          set({
            settings: nextSettings,
          });
        },
        // 호스트 생성·수정 — push-first: 서버 반영에 성공한 다음에만 로컬 상태를 바꾼다.
        // (sync pull 이 로컬 hosts 를 통째로 교체하므로 로컬 선반영은 다음 pull 에서
        // 유실될 수 있다.) 폼에 입력한 자격증명은 keychain 저장 + 서버 sync 에 함께
        // 올린다(다른 기기와 공유 — 볼트 키로 암호화되므로 E2EE 계정은 서버가 읽지 못한다).
        saveHost: async (input: MobileHostDraftInput) => {
          if (!get().secureStateReady) {
            throw new Error(getSecureStateLoadingMessage());
          }

          const now = new Date().toISOString();
          const existing = input.hostId
            ? get().hosts.find(host => host.id === input.hostId)
            : undefined;
          if (input.hostId && (!existing || !isSshHostRecord(existing))) {
            throw new Error(t('store.hostToEditNotFound'));
          }
          const existingSsh =
            existing && isSshHostRecord(existing) ? existing : undefined;

          const rawPassword = input.credentials?.password;
          const password = rawPassword?.length ? rawPassword : undefined;
          const privateKeyPem =
            input.credentials?.privateKeyPem?.trim() || undefined;
          const passphrase = input.credentials?.passphrase || undefined;
          const hasReplacementCredential = Boolean(password || privateKeyPem);
          const credentialMode =
            input.credentialMode ??
            (existingSsh?.secretRef ? 'preserve' : 'replace');
          if (
            credentialMode === 'preserve' &&
            (!existingSsh?.secretRef || existingSsh.authType !== input.authType)
          ) {
            throw new Error(
              t('store.authChangeNeedsCredential'),
            );
          }
          if (
            existingSsh?.secretRef &&
            credentialMode === 'replace' &&
            !hasReplacementCredential
          ) {
            throw new Error(
              t('store.replaceOrUnlink'),
            );
          }
          const secretRef =
            credentialMode === 'preserve'
              ? existingSsh?.secretRef
              : credentialMode === 'replace' && hasReplacementCredential
              ? existingSsh?.secretRef ?? createLocalId('secret')
              : undefined;
          const record: SshHostRecord = {
            ...(existingSsh ?? {}),
            id: existingSsh?.id ?? createLocalId('host'),
            kind: 'ssh',
            label: input.label.trim(),
            hostname: input.hostname.trim(),
            port: input.port,
            username: input.username.trim(),
            authType: input.authType,
            groupName: input.groupName?.trim() ? input.groupName.trim() : null,
            secretRef,
            createdAt: existingSsh?.createdAt ?? now,
            updatedAt: now,
          };

          const nextSecret: LoadedManagedSecretPayload | null =
            credentialMode === 'replace' && secretRef
              ? {
                  secretRef,
                  label:
                    get().secretsByRef[secretRef]?.label ??
                    `${record.label} credentials`,
                  ...(input.authType === 'password'
                    ? { password }
                    : { privateKeyPem, passphrase }),
                  updatedAt: now,
                }
              : null;

          try {
            await callWithFreshAccessToken(async accessToken => {
              const currentSession = get().auth.session;
              if (!currentSession) {
                throw new Error(t('store.onlineOnly'));
              }
              const pushedRevision = await postSyncSnapshot(
                get().settings.serverUrl,
                accessToken,
                buildHostMutationSyncPayload(
                  {
                    hosts: [record],
                    secrets: nextSecret ? [nextSecret] : [],
                  },
                  resolveVaultKeyForPush(currentSession),
                ),
                resolveVaultEpochForPush(),
              );
              storePushedRevision(pushedRevision);
            });
          } catch (error) {
            await handleVaultDekMismatchError(error);
            throw error;
          }

          const nextHosts = sortHosts([
            ...get().hosts.filter(host => host.id !== record.id),
            record,
          ]);
          set({ hosts: nextHosts });
          if (nextSecret) {
            await updateSecretsState(
              { ...get().secretsByRef, [nextSecret.secretRef]: nextSecret },
              nextHosts,
            );
          } else {
            await updateSecretsState(get().secretsByRef, nextHosts);
          }
        },
        // 호스트 삭제 — tombstone push 성공 후 로컬에서 제거. 연결된 시크릿은 다른
        // 호스트와 공유될 수 있으므로 남긴다. 라이브 세션도 유지된다(목록에는
        // "삭제된 호스트"로 표시).
        deleteHost: async (hostId: string) => {
          const host = get().hosts.find(item => item.id === hostId);
          if (!host) {
            return;
          }

          const deletedAt = new Date().toISOString();
          try {
            await callWithFreshAccessToken(async accessToken => {
              const currentSession = get().auth.session;
              if (!currentSession) {
                throw new Error(t('store.onlineOnly'));
              }
              const pushedRevision = await postSyncSnapshot(
                get().settings.serverUrl,
                accessToken,
                buildHostMutationSyncPayload(
                  { deletedHosts: [{ id: hostId, deletedAt }] },
                  resolveVaultKeyForPush(currentSession),
                ),
                resolveVaultEpochForPush(),
              );
              storePushedRevision(pushedRevision);
            });
          } catch (error) {
            await handleVaultDekMismatchError(error);
            throw error;
          }

          const nextHosts = get().hosts.filter(item => item.id !== hostId);
          set({
            hosts: nextHosts,
            secretMetadata: deriveSecretMetadata(nextHosts, get().secretsByRef),
          });
        },
        connectToHost: async (hostId: string) => {
          if (!get().secureStateReady) {
            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                errorMessage: getSecureStateLoadingMessage(),
              },
            }));
            return null;
          }

          const host = get().hosts.find(item => item.id === hostId);
          if (!host) {
            return null;
          }

          const liveSession = get().sessions.find(
            session => session.hostId === hostId && isLiveSession(session),
          );
          if (liveSession) {
            get().setActiveSessionTab(liveSession.id);
            if (
              !runtimeSessions.has(liveSession.id) &&
              !pendingSessionConnections.has(liveSession.id) &&
              liveSession.status !== 'connecting' &&
              liveSession.status !== 'disconnecting'
            ) {
              void get().resumeSession(liveSession.id);
            }
            return liveSession.id;
          }

          const nextSession = createSessionRecord(host);
          set(state => {
            const nextSessions = upsertSessionRecord(
              state.sessions,
              nextSession,
            );
            return {
              sessions: nextSessions,
              activeSessionTabId: resolveActiveSessionTabId(
                nextSessions,
                state.activeSessionTabId,
                nextSession.id,
              ),
              activeConnectionTab: normalizeActiveConnectionTab(
                nextSessions,
                state.sftpSessions,
                state.activeConnectionTab,
                { kind: 'terminal', id: nextSession.id },
              ),
            };
          });
          void connectSessionRecord(nextSession, host);
          return nextSession.id;
        },
        duplicateSession: async (sessionId: string) => {
          if (!get().secureStateReady) {
            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                errorMessage: getSecureStateLoadingMessage(),
              },
            }));
            return null;
          }

          const sourceSession = get().sessions.find(
            session => session.id === sessionId,
          );
          if (!sourceSession) {
            return null;
          }

          const host = get().hosts.find(
            item => item.id === sourceSession.hostId,
          );
          if (!host) {
            return null;
          }

          const nextSession = createSessionRecord(host);
          set(state => {
            const nextSessions = upsertSessionRecord(
              state.sessions,
              nextSession,
            );
            return {
              sessions: nextSessions,
              activeSessionTabId: resolveActiveSessionTabId(
                nextSessions,
                state.activeSessionTabId,
                nextSession.id,
              ),
              activeConnectionTab: normalizeActiveConnectionTab(
                nextSessions,
                state.sftpSessions,
                state.activeConnectionTab,
                { kind: 'terminal', id: nextSession.id },
              ),
            };
          });
          void connectSessionRecord(nextSession, host);
          return nextSession.id;
        },
        setActiveConnectionTab: (tab: MobileConnectionTabRef | null) => {
          set(state => {
            const nextTab = normalizeActiveConnectionTab(
              state.sessions,
              state.sftpSessions,
              state.activeConnectionTab,
              tab,
            );
            return {
              activeConnectionTab: nextTab,
              activeSessionTabId:
                nextTab?.kind === 'terminal'
                  ? nextTab.id
                  : state.activeSessionTabId,
            };
          });
        },
        setActiveSessionTab: (sessionId: string | null) => {
          set(state => ({
            activeSessionTabId: resolveActiveSessionTabId(
              state.sessions,
              state.activeSessionTabId,
              sessionId,
            ),
            activeConnectionTab: normalizeActiveConnectionTab(
              state.sessions,
              state.sftpSessions,
              state.activeConnectionTab,
              sessionId ? { kind: 'terminal', id: sessionId } : null,
            ),
          }));
        },
        resumeSession: async (sessionId: string) => {
          const session = get().sessions.find(item => item.id === sessionId);
          if (!session) {
            return null;
          }

          get().setActiveSessionTab(session.id);

          if (
            runtimeSessions.has(session.id) ||
            pendingSessionConnections.has(session.id) ||
            session.status === 'connecting' ||
            session.status === 'disconnecting'
          ) {
            return session.id;
          }

          const host = get().hosts.find(item => item.id === session.hostId);
          if (!host) {
            markSessionState(
              session.id,
              'error',
              t('store.sessionHostNotFound'),
            );
            return session.id;
          }

          set(state => {
            const nextSessions = patchSessionRecord(
              state.sessions,
              session.id,
              {
                status: 'connecting',
                errorMessage: null,
                lastEventAt: new Date().toISOString(),
              },
            );
            return {
              sessions: nextSessions,
              activeSessionTabId: resolveActiveSessionTabId(
                nextSessions,
                state.activeSessionTabId,
                session.id,
              ),
            };
          });
          void connectSessionRecord(session, host);
          return session.id;
        },
        disconnectSession: async (sessionId: string) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            markSessionState(sessionId, 'closed');
            return;
          }

          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionId, {
              status: 'disconnecting',
              lastEventAt: new Date().toISOString(),
            }),
          }));

          flushSessionSnapshot(sessionId, {
            markActivity: false,
          });
          await disposeRuntimeSession(sessionId);
          markSessionState(sessionId, 'closed');
        },
        removeSession: async (sessionId: string) => {
          const runtime = runtimeSessions.get(sessionId);

          set(state => {
            const nextSessions = state.sessions.filter(
              session => session.id !== sessionId,
            );
            return {
              sessions: nextSessions,
              activeSessionTabId: resolveActiveSessionTabId(
                nextSessions,
                state.activeSessionTabId === sessionId
                  ? null
                  : state.activeSessionTabId,
              ),
              activeConnectionTab: normalizeActiveConnectionTab(
                nextSessions,
                state.sftpSessions,
                state.activeConnectionTab?.kind === 'terminal' &&
                  state.activeConnectionTab.id === sessionId
                  ? null
                  : state.activeConnectionTab,
              ),
            };
          });

          if (!runtime) {
            pendingSessionConnections.delete(sessionId);
            disconnectRuntimeSession(sessionId);
            return;
          }

          await disposeRuntimeSession(sessionId);
        },
        writeToSession: async (sessionId: string, data: string) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            return;
          }
          const bytes = Buffer.from(data, 'utf8');
          if (runtime.kind === 'ssh') {
            await runtime.shell.sendData(
              new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            );
            return;
          }

          const message: AwsSsmSessionClientMessage = {
            type: 'input',
            dataBase64: bytes.toString('base64'),
          };
          runtime.socket.send(JSON.stringify(message));
        },
        subscribeToSessionTerminal: (sessionId, handlers) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            return () => {};
          }

          if (runtime.kind === 'ssh') {
            // The caller uses the returned function as a React effect cleanup,
            // so it has to come back synchronously, while the engine's reads and
            // subscriptions are async because they cross the native bridge.
            //
            // Attaching in the background is safe: the engine retains output in
            // its ring buffer, and the cursor the replay hands back is exactly
            // where the live feed resumes, so nothing is lost or repeated in the
            // gap between the two calls.
            const shell = runtime.shell;

            // Only the newest subscription for a session may deliver.
            //
            // The caller re-subscribes whenever its session record changes
            // identity, which happens on every snapshot flush — so a resubscribe
            // arrives roughly every time output arrives. Detaching is async
            // (it crosses the bridge), so the outgoing listener is still live
            // while the incoming one attaches, and both would write the same
            // bytes: every character appears twice until the old one detaches,
            // then the shell's next repaint "fixes" it.
            //
            // Gating on a generation makes a superseded listener go silent
            // immediately, without waiting for its detach to complete.
            const generation =
              (terminalSubscriptionGenerations.get(sessionId) ?? 0) + 1;
            terminalSubscriptionGenerations.set(sessionId, generation);
            const isCurrent = () =>
              terminalSubscriptionGenerations.get(sessionId) === generation;

            let attachedListenerId: number | null = null;

            void (async () => {
              try {
                const replay = await shell.readBuffer({ mode: 'head' });
                if (!isCurrent()) {
                  return;
                }
                handlers.onReplay(
                  replay.bytes.length > 0 ? [replay.bytes] : [],
                );

                const listenerId = await shell.follow(
                  {
                    onChunk: chunk => {
                      if (isCurrent()) {
                        handlers.onData(chunk.bytes);
                      }
                    },
                  },
                  {
                    cursor: { mode: 'seq', seq: replay.nextSeq },
                    coalesceMs: 16,
                  },
                );

                if (!isCurrent()) {
                  // Superseded while attaching; drop it rather than leaking.
                  void shell.unfollow(listenerId).catch(() => {});
                  return;
                }
                attachedListenerId = listenerId;
              } catch {
                // A shell that went away mid-attach needs no cleanup; the
                // session's own close path already reports it.
              }
            })();

            return () => {
              // Bumping the generation silences this listener at once; the
              // detach that follows is just housekeeping.
              if (isCurrent()) {
                terminalSubscriptionGenerations.set(sessionId, generation + 1);
              }
              if (attachedListenerId !== null) {
                void shell.unfollow(attachedListenerId).catch(() => {});
                attachedListenerId = null;
              }
            };
          }

          handlers.onReplay(
            runtime.replayChunks.length > 0
              ? runtime.replayChunks
              : sessionId
              ? [
                  Uint8Array.from(
                    Buffer.from(
                      get().sessions.find(item => item.id === sessionId)
                        ?.lastViewportSnapshot ?? '',
                      'utf8',
                    ),
                  ),
                ]
              : [],
          );
          const subscriptionId = `aws-sub-${runtimeSubscriptionCounter++}`;
          runtime.subscribers.set(subscriptionId, handlers);
          return () => {
            runtime.subscribers.delete(subscriptionId);
          };
        },
        openSftpForSession: async (sessionId: string) => {
          const sourceSession = get().sessions.find(
            session => session.id === sessionId && isLiveSession(session),
          );
          if (!sourceSession) {
            return null;
          }

          const host = get().hosts.find(
            item => item.id === sourceSession.hostId,
          );
          if (!host || (!isSshHostRecord(host) && !isAwsEc2HostRecord(host))) {
            return null;
          }

          const existing = get().sftpSessions.find(
            session => session.hostId === host.id && isLiveSftpSession(session),
          );
          if (existing) {
            get().setActiveConnectionTab({ kind: 'sftp', id: existing.id });
            if (
              existing.status === 'error' &&
              !runtimeSftpSessions.has(existing.id) &&
              !pendingSftpConnections.has(existing.id)
            ) {
              void connectSftpSessionRecord(existing, host);
            }
            return existing.id;
          }

          const nextSftpSession = createSftpSessionRecord(sourceSession, host);
          set(state => {
            const nextSftpSessions = upsertSftpSessionRecord(
              state.sftpSessions,
              nextSftpSession,
            );
            return {
              sftpSessions: nextSftpSessions,
              activeConnectionTab: normalizeActiveConnectionTab(
                state.sessions,
                nextSftpSessions,
                state.activeConnectionTab,
                { kind: 'sftp', id: nextSftpSession.id },
              ),
            };
          });
          void connectSftpSessionRecord(nextSftpSession, host);
          return nextSftpSession.id;
        },
        disconnectSftpSession: async (sftpSessionId: string) => {
          set(state => ({
            sftpSessions: patchSftpSessionRecord(
              state.sftpSessions,
              sftpSessionId,
              {
                status: 'disconnecting',
                lastEventAt: new Date().toISOString(),
              },
            ),
          }));

          await disposeRuntimeSftpSession(sftpSessionId);
          markSftpSessionState(sftpSessionId, 'closed');
        },
        listSftpDirectory: async (sftpSessionId: string, path?: string) => {
          await refreshSftpDirectory(sftpSessionId, path);
        },
        downloadSftpFile: async (sftpSessionId: string, remotePath: string) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession) {
            return;
          }

          const fileName = remoteBasename(remotePath) || 'download';
          const destination = await pickDownloadDestination(fileName);
          if (!destination) {
            return;
          }

          const listingEntry = sftpSession.listing?.entries.find(
            entry => entry.path === remotePath,
          );
          const now = new Date().toISOString();
          const transferId = createLocalId('sftp-transfer');
          set(state => ({
            sftpTransfers: [
              ...state.sftpTransfers,
              {
                id: transferId,
                sftpSessionId,
                direction: 'download',
                remotePath,
                localName: destination.name,
                status: 'running',
                bytesTransferred: 0,
                totalBytes: listingEntry?.size ?? null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }));

          let offset = 0;
          try {
            for (;;) {
              const chunk = await runtime.connection.readFileChunk(
                remotePath,
                offset,
                SFTP_TRANSFER_CHUNK_SIZE,
              );
              const bytes = Buffer.from(new Uint8Array(chunk.bytes));
              const bytesRead = chunk.bytesRead || bytes.byteLength;
              if (bytesRead <= 0) {
                break;
              }
              await writeDownloadChunk(
                destination.uri,
                bytes.toString('base64'),
                offset > 0,
              );
              offset += bytesRead;
              set(state => ({
                sftpTransfers: patchSftpTransferRecord(
                  state.sftpTransfers,
                  transferId,
                  {
                    bytesTransferred: offset,
                    status: 'running',
                  },
                ),
              }));
              if (chunk.eof || bytesRead < SFTP_TRANSFER_CHUNK_SIZE) {
                break;
              }
            }
            const finalDestination = destination.requiresExport
              ? await finalizeDownloadDestination(
                  destination.uri,
                  destination.name,
                )
              : destination;
            set(state => ({
              sftpTransfers: patchSftpTransferRecord(
                state.sftpTransfers,
                transferId,
                {
                  status: 'completed',
                  bytesTransferred: offset,
                  localName: finalDestination.name,
                },
              ),
            }));
          } catch (error) {
            try {
              await deleteDownloadDestination(destination.uri);
            } catch {}
            const message =
              error instanceof Error
                ? error.message
                : t('store.downloadFailed');
            set(state => ({
              sftpTransfers: patchSftpTransferRecord(
                state.sftpTransfers,
                transferId,
                {
                  status: 'error',
                  errorMessage: message,
                  bytesTransferred: offset,
                },
              ),
              sftpSessions: patchSftpSessionRecord(
                state.sftpSessions,
                sftpSessionId,
                {
                  errorMessage: message,
                  lastEventAt: new Date().toISOString(),
                },
              ),
            }));
          }
        },
        downloadSftpEntries: async (
          sftpSessionId: string,
          remotePaths: string[],
        ) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession || remotePaths.length === 0) {
            return;
          }

          const destinationDirectory = await pickDownloadDirectory(
            sftpSession.title || 'SFTP Downloads',
          );
          if (!destinationDirectory) {
            return;
          }

          const pendingExportCompletions: Array<{
            transferId: string;
            bytesTransferred: number;
          }> = [];

          for (const remotePath of remotePaths) {
            const entry = await resolveRemoteEntry(
              runtime.connection,
              remotePath,
              sftpSession.listing,
            );
            const now = new Date().toISOString();
            const transferId = createLocalId('sftp-transfer');
            set(state => ({
              sftpTransfers: [
                ...state.sftpTransfers,
                {
                  id: transferId,
                  sftpSessionId,
                  direction: 'download',
                  remotePath: entry.path,
                  localName: entry.name,
                  status: 'running',
                  bytesTransferred: 0,
                  totalBytes: entry.isDirectory ? null : entry.size,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }));

            try {
              const bytesTransferred = await downloadRemoteEntryToDirectory(
                runtime.connection,
                entry,
                destinationDirectory.uri,
                nextBytesTransferred => {
                  set(state => ({
                    sftpTransfers: patchSftpTransferRecord(
                      state.sftpTransfers,
                      transferId,
                      {
                        bytesTransferred: nextBytesTransferred,
                        status: 'running',
                      },
                    ),
                  }));
                },
              );
              if (destinationDirectory.requiresExport) {
                pendingExportCompletions.push({
                  transferId,
                  bytesTransferred,
                });
              } else {
                set(state => ({
                  sftpTransfers: patchSftpTransferRecord(
                    state.sftpTransfers,
                    transferId,
                    {
                      status: 'completed',
                      bytesTransferred,
                    },
                  ),
                }));
              }
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : t('store.downloadFailed');
              set(state => ({
                sftpTransfers: patchSftpTransferRecord(
                  state.sftpTransfers,
                  transferId,
                  {
                    status: 'error',
                    errorMessage: message,
                  },
                ),
                sftpSessions: patchSftpSessionRecord(
                  state.sftpSessions,
                  sftpSessionId,
                  {
                    errorMessage: message,
                    lastEventAt: new Date().toISOString(),
                  },
                ),
              }));
            }
          }

          if (
            destinationDirectory.requiresExport &&
            pendingExportCompletions.length > 0
          ) {
            try {
              await finalizeDownloadDestination(
                destinationDirectory.uri,
                destinationDirectory.name,
              );
              set(state => ({
                sftpTransfers: pendingExportCompletions.reduce(
                  (nextTransfers, completion) =>
                    patchSftpTransferRecord(
                      nextTransfers,
                      completion.transferId,
                      {
                        status: 'completed',
                        bytesTransferred: completion.bytesTransferred,
                      },
                    ),
                  state.sftpTransfers,
                ),
              }));
            } catch (error) {
              try {
                await deleteDownloadDestination(destinationDirectory.uri);
              } catch {}
              const message =
                error instanceof Error ? error.message : t('store.saveFailed');
              set(state => ({
                sftpTransfers: pendingExportCompletions.reduce(
                  (nextTransfers, completion) =>
                    patchSftpTransferRecord(
                      nextTransfers,
                      completion.transferId,
                      {
                        status: 'error',
                        errorMessage: message,
                        bytesTransferred: completion.bytesTransferred,
                      },
                    ),
                  state.sftpTransfers,
                ),
                sftpSessions: patchSftpSessionRecord(
                  state.sftpSessions,
                  sftpSessionId,
                  {
                    errorMessage: message,
                    lastEventAt: new Date().toISOString(),
                  },
                ),
              }));
            }
          }
        },
        uploadSftpFile: async (sftpSessionId: string) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession) {
            return;
          }

          const pickedFile = await pickUploadFile();
          if (!pickedFile) {
            return;
          }

          const remotePath = joinRemotePath(
            sftpSession.currentPath,
            pickedFile.name,
          );
          const now = new Date().toISOString();
          const transferId = createLocalId('sftp-transfer');
          set(state => ({
            sftpTransfers: [
              ...state.sftpTransfers,
              {
                id: transferId,
                sftpSessionId,
                direction: 'upload',
                remotePath,
                localName: pickedFile.name,
                status: 'running',
                bytesTransferred: 0,
                totalBytes: pickedFile.size ?? null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }));

          let offset = 0;
          try {
            for (;;) {
              const chunk = await readLocalFileChunk(
                pickedFile.uri,
                offset,
                SFTP_TRANSFER_CHUNK_SIZE,
              );
              if (chunk.bytesRead <= 0) {
                break;
              }
              const bytes = Buffer.from(chunk.base64, 'base64');
              await runtime.connection.writeFileChunk(
                remotePath,
                offset,
                bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
                ),
              );
              offset += chunk.bytesRead;
              set(state => ({
                sftpTransfers: patchSftpTransferRecord(
                  state.sftpTransfers,
                  transferId,
                  {
                    bytesTransferred: offset,
                    status: 'running',
                  },
                ),
              }));
              if (chunk.bytesRead < SFTP_TRANSFER_CHUNK_SIZE) {
                break;
              }
            }
            set(state => ({
              sftpTransfers: patchSftpTransferRecord(
                state.sftpTransfers,
                transferId,
                {
                  status: 'completed',
                  bytesTransferred: offset,
                },
              ),
            }));
            await refreshSftpDirectory(sftpSessionId, sftpSession.currentPath);
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : t('store.uploadFailed');
            set(state => ({
              sftpTransfers: patchSftpTransferRecord(
                state.sftpTransfers,
                transferId,
                {
                  status: 'error',
                  errorMessage: message,
                  bytesTransferred: offset,
                },
              ),
              sftpSessions: patchSftpSessionRecord(
                state.sftpSessions,
                sftpSessionId,
                {
                  errorMessage: message,
                  lastEventAt: new Date().toISOString(),
                },
              ),
            }));
          }
        },
        createSftpDirectory: async (sftpSessionId: string, name: string) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession || !name.trim()) {
            return;
          }
          const path = joinRemotePath(sftpSession.currentPath, name);
          await runtime.connection.mkdir(path);
          await refreshSftpDirectory(sftpSessionId, sftpSession.currentPath);
        },
        renameSftpEntry: async (
          sftpSessionId: string,
          sourcePath: string,
          nextName: string,
        ) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession || !nextName.trim()) {
            return;
          }
          const targetPath = joinRemotePath(
            parentRemotePath(sourcePath),
            nextName,
          );
          await runtime.connection.rename(sourcePath, targetPath);
          await refreshSftpDirectory(sftpSessionId, sftpSession.currentPath);
        },
        chmodSftpEntry: async (
          sftpSessionId: string,
          remotePath: string,
          mode: string,
        ) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession) {
            return;
          }
          await runtime.connection.chmod(remotePath, parseUnixMode(mode));
          await refreshSftpDirectory(sftpSessionId, sftpSession.currentPath);
        },
        deleteSftpEntries: async (sftpSessionId: string, paths: string[]) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!runtime || !sftpSession || paths.length === 0) {
            return;
          }
          try {
            for (const path of paths) {
              const entry = await resolveRemoteEntry(
                runtime.connection,
                path,
                sftpSession.listing,
              );
              await deleteRemoteEntryRecursive(runtime.connection, entry);
            }
            await refreshSftpDirectory(sftpSessionId, sftpSession.currentPath);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : t('store.deleteFailed');
            set(state => ({
              sftpSessions: patchSftpSessionRecord(
                state.sftpSessions,
                sftpSessionId,
                {
                  errorMessage: message,
                  lastEventAt: new Date().toISOString(),
                },
              ),
            }));
            throw error;
          }
        },
        copySftpEntries: (sftpSessionId: string, paths: string[]) => {
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          if (!sftpSession || paths.length === 0) {
            return;
          }
          const entries = paths.map(path => {
            const entry = sftpSession.listing?.entries.find(
              candidate => candidate.path === path,
            );
            return {
              path,
              name: entry?.name ?? remoteBasename(path) ?? path,
              isDirectory: entry?.isDirectory ?? false,
              kind: entry?.kind ?? 'unknown',
            };
          });
          set({
            sftpCopyBuffer: {
              sftpSessionId,
              hostId: sftpSession.hostId,
              entries,
              createdAt: new Date().toISOString(),
            },
          });
        },
        pasteSftpEntries: async (sftpSessionId: string) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const sftpSession = get().sftpSessions.find(
            session => session.id === sftpSessionId,
          );
          const copyBuffer = get().sftpCopyBuffer;
          if (
            !runtime ||
            !sftpSession ||
            !copyBuffer ||
            copyBuffer.sftpSessionId !== sftpSessionId ||
            copyBuffer.entries.length === 0
          ) {
            return;
          }

          for (const entry of copyBuffer.entries) {
            const targetPath = await resolveUniqueRemotePath(
              runtime.connection,
              sftpSession.currentPath,
              entry.name,
            );
            const now = new Date().toISOString();
            const transferId = createLocalId('sftp-transfer');
            set(state => ({
              sftpTransfers: [
                ...state.sftpTransfers,
                {
                  id: transferId,
                  sftpSessionId,
                  direction: 'copy',
                  remotePath: entry.path,
                  localName: remoteBasename(targetPath) || entry.name,
                  status: 'running',
                  bytesTransferred: 0,
                  totalBytes: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }));

            try {
              const bytesTransferred = await copyRemoteEntryToPath(
                runtime.connection,
                entry,
                targetPath,
                nextBytesTransferred => {
                  set(state => ({
                    sftpTransfers: patchSftpTransferRecord(
                      state.sftpTransfers,
                      transferId,
                      {
                        bytesTransferred: nextBytesTransferred,
                        status: 'running',
                      },
                    ),
                  }));
                },
              );
              set(state => ({
                sftpTransfers: patchSftpTransferRecord(
                  state.sftpTransfers,
                  transferId,
                  {
                    status: 'completed',
                    bytesTransferred,
                  },
                ),
              }));
            } catch (error) {
              const message =
                error instanceof Error ? error.message : t('store.copyFailed');
              set(state => ({
                sftpTransfers: patchSftpTransferRecord(
                  state.sftpTransfers,
                  transferId,
                  {
                    status: 'error',
                    errorMessage: message,
                  },
                ),
                sftpSessions: patchSftpSessionRecord(
                  state.sftpSessions,
                  sftpSessionId,
                  {
                    errorMessage: message,
                    lastEventAt: new Date().toISOString(),
                  },
                ),
              }));
            }
          }
          await refreshSftpDirectory(sftpSessionId, sftpSession.currentPath);
        },
        clearSftpCopyBuffer: () => {
          set({ sftpCopyBuffer: null });
        },
        acceptServerKeyPrompt: async () => {
          pendingServerKeyResolver?.(true);
          pendingServerKeyResolver = null;
          set({ pendingServerKeyPrompt: null });
        },
        rejectServerKeyPrompt: async () => {
          pendingServerKeyResolver?.(false);
          pendingServerKeyResolver = null;
          set({ pendingServerKeyPrompt: null });
        },
        submitCredentialPrompt: async (input: HostSecretInput) => {
          pendingCredentialResolver?.(input);
          pendingCredentialResolver = null;
          set({ pendingCredentialPrompt: null });
        },
        cancelCredentialPrompt: () => {
          pendingCredentialResolver?.(null);
          pendingCredentialResolver = null;
          set({ pendingCredentialPrompt: null });
        },
      };
    },
    {
      name: 'dolgate-mobile-store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: state => ({
        settings: state.settings,
        terminalGrid: state.terminalGrid,
        syncStatus: state.syncStatus,
        groups: state.groups,
        hosts: state.hosts,
        knownHosts: state.knownHosts,
        sessions: compactPersistedSessions(state.sessions),
        activeSessionTabId: resolveActiveSessionTabId(
          state.sessions,
          state.activeSessionTabId,
        ),
      }),
      onRehydrateStorage: () => {
        const finishPersistHydrateTiming =
          beginStartupTiming('persist hydrate');
        return () => {
          finishPersistHydrateTiming?.();
          // 저장된 실제 그리드를 모듈 캐시로 되돌려, 첫 접속의 PTY 크기가 추정값으로
          // 어긋나지 않게 한다(어긋나면 프롬프트 입력이 같은 줄에 겹쳐 그려진다).
          const persistedGrid = useMobileAppStore.getState().terminalGrid;
          if (persistedGrid) {
            setReportedTerminalGrid(persistedGrid);
          }
          const nextSessions = normalizePersistedSessionsForColdStart(
            useMobileAppStore.getState().sessions,
          );
          useMobileAppStore.setState(state => ({
            hydrated: true,
            sessions: nextSessions,
            sftpSessions: [],
            sftpTransfers: [],
            sftpCopyBuffer: null,
            activeSessionTabId: resolveActiveSessionTabId(nextSessions, null),
            activeConnectionTab: normalizeActiveConnectionTab(
              nextSessions,
              [],
              null,
            ),
          }));
        };
      },
    },
  ),
);

export function resetMobileStoreRuntimeForTests(): void {
  initializePromise = null;
  syncPromise = null;
  syncPromiseGeneration = 0;
  secureStateRestoreVersion = 0;
  lastSyncRevision = null;
  vaultSyncGeneration = 0;
  stopSyncPolling();
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  if (offlineRecoveryTimer) {
    clearTimeout(offlineRecoveryTimer);
    offlineRecoveryTimer = null;
  }
  offlineRecoveryAttempt = 0;
  offlineRecoveryInFlight = false;
  offlineRecoveryKey = null;
  pendingServerKeyResolver = null;
  pendingCredentialResolver = null;
  pendingAwsSsoCancelHandler = null;
  for (const runtime of runtimeSessions.values()) {
    try {
      if (runtime.kind === 'ssh') {
        void runtime.shell.close();
        void runtime.connection.disconnect();
      } else {
        runtime.socket.close();
      }
    } catch {}
  }
  runtimeSessions.clear();
  for (const runtime of runtimeSftpSessions.values()) {
    try {
      void runtime.connection.close();
    } catch {}
  }
  runtimeSftpSessions.clear();
  pendingSessionConnections.clear();
  pendingSftpConnections.clear();
  runtimeSessionSnapshots.clear();
  for (const timer of runtimeSnapshotFlushTimers.values()) {
    clearTimeout(timer);
  }
  runtimeSnapshotFlushTimers.clear();
}

export type {
  MobileAppState,
  PendingCredentialPromptState,
  PendingServerKeyPromptState,
};
