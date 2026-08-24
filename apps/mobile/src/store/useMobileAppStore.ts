import { Buffer } from 'buffer';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { AppState } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import type {
  AwsProfilesServerSupport,
  AwsSftpCreateSessionRequest,
  AwsEc2HostRecord,
  AwsSsmSessionClientMessage,
  AwsSsmSessionServerMessage,
  AuthSession,
  AuthState,
  AuthType,
  DirectoryListing,
  FileEntry,
  GroupRecord,
  GroupRemoveMode,
  HostEnvVar,
  HostRecord,
  ParsedQuickSshCommand,
  HostSecretInput,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  MobileConnectionTabRef,
  MobileRemoteDesktopSessionRecord,
  ManagedAwsProfilePayload,
  MobileSessionRecord,
  MobileSettings,
  MobileSftpSessionRecord,
  MobileSftpTransferRecord,
  HostStartupCommand,
  SecretMetadataRecord,
  SnippetRecord,
  SshHostRecord,
  RdpHostRecord,
  VncHostRecord,
  SyncPayloadV2,
  SyncStatus,
  TailnetPayload,
  VncImageQuality,
  VaultCacheOwner,
  VaultKdfDescriptor,
} from '@dolssh/shared-core';
// 그룹 트리 변형 규칙. 데스크톱 메인도 같은 함수를 쓴다 — 두 벌이 되면 같은 그룹을 폰에서
// 지운 것과 PC 에서 지운 것이 다른 결과를 낳는다.
import {
  LEGACY_TOLERATED_HOST_KINDS,
  buildQuickSshHostLabel,
  createGroupIn,
  findExistingQuickSshHost,
  removeGroupFrom,
  renameGroupIn,
} from '@dolssh/shared-core';
import {
  buildSyncOutboxPayload,
  enqueueManySyncOutbox,
  removeSyncOutbox,
  type SyncOutboxEntry,
} from '../lib/sync-outbox';
import { mergeSyncedState } from '../lib/sync-merge';
import {
  buildAwsSsmKnownHostIdentity,
  describeRdpDrives,
  computeVaultDekVerifier,
  createVaultDek,
  createVaultKdfDescriptor,
  decideVaultAccess,
  deriveVaultKek,
  formatInteractiveHop,
  normalizeJumpHostIds,
  resolveSshHostTailnetId,
  type ConnectionFailureLayer,
  isVaultEpochRejectionCode,
  parseSyncRevisionEtag,
  getAwsEc2HostSshPort,
  isAwsEc2WindowsPlatform,
  isAwsHostKeySecurityError,
  recordSshOverSsmFallback,
  shouldAttemptSshOverSsm,
  usesAwsServerProxy,
  type AwsSshOverSsmFallbackMemo,
  isAwsEc2HostRecord,
  isRdpHostRecord,
  isSshHostRecord,
  isVncHostRecord,
  MAX_HOST_STARTUP_COMMAND_LENGTH,
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
  clearStoredTailnets,
  buildHostMutationSyncPayload,
  buildKnownHostRecord,
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
  isSyncRecordDecryptError,
  decodeManagedSecrets,
  decodeSnippets,
  decodeSupportedHosts,
  decodeSyncTombstones,
  decodeTailnets,
  deleteRemoteAccount,
  deriveSecretMetadata,
  fetchExchangeSession,
  fetchServerInfo,
  fetchSyncSnapshot,
  getSettingsValidationMessage,
  clearStoredVaultDek,
  loadStoredAwsProfiles,
  loadStoredTailnets,
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
  resolveMobileSyncDataFloor,
  saveStoredVaultDek,
  sanitizeTerminalSnapshot,
  saveStoredAuthSession,
  saveStoredAwsProfiles,
  saveStoredTailnets,
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
  createStartupCommandFlusher,
  resolveStartupCommand,
  type StartupCommandFlusher,
} from '../lib/startup-command';
import {
  resolveSnippetCommand,
  type SnippetVariable,
} from '../lib/snippet-variables';
import {
  isLiveSession,
  normalizePersistedSessionsForColdStart,
  resumeDroppedActiveSession,
} from '../lib/session-resume';
import {
  type AwsSsoBrowserLoginPrompt,
  resolveAwsSessionForHost,
  type ResolvedAwsSessionResult,
} from '../lib/aws-session';
import {
  pushEc2InstanceConnectKey,
  startSsmPortForwardSession,
  startSsmShellSession,
} from '../lib/aws-ssm-direct';
import { appendSessionBanner } from '../lib/terminal-banner';
import { AwsSftpHostKeyChallengeError, connectAwsSftp } from '../lib/aws-sftp';
import { openAwsSsoBrowser } from '../lib/aws-sso-bridge';
import { closeInAppBrowser, openInAppBrowser } from '../lib/in-app-browser';
import {
  cancelSyncedTailnetStart,
  closeSyncedTailnets,
  configureSyncedTailnets,
  forgetSyncedTailnets,
  isSyncedTailnetConfigCurrent,
  resolveSyncedTailnetRoute,
  resetSyncedTailnetRuntimeForTests,
  startSyncedTailnet,
  SyncedTailnetStartError,
  type SyncedTailnetRouteResolution,
} from '../lib/tailnet-runtime';
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
  openRemoteDesktopTunnel,
  closeRemoteDesktopTunnel,
  type EngineConnection,
  type EngineSsmForward,
  type EngineCredential,
  type EngineInteractiveAnswer,
  type EngineHopProgress,
  type EngineInteractiveChallenge,
  type EngineJumpTarget,
  type EngineSftpConnection,
  type EngineShell,
  type EngineTailnetStatus,
} from '../engine';
import {
  isNativeSessionAvailable,
  nativeConnect,
  nativeDisconnect,
  nativeRefresh,
  nativeSetActive,
  nativeTrustCertificate,
  subscribeToSessionEvents,
  type RemoteDesktopConnectOptions,
  type RemoteDesktopSessionEvent,
} from '@dolssh/react-native-remote-desktop';
import {
  getAwsEc2SftpDisabledMessage,
  getConnectFailureLayer,
  getConnectFailureMessage,
  getNewVaultPassphraseMessage,
} from '../i18n/shared-messages';
import {
  buildCredentialRetryRequest,
  type CredentialRetryRequest,
  type CredentialRetryTarget,
} from '../lib/credential-retry';
import { t } from '../i18n';
import {
  createRemoteDesktopSlice,
  compactPersistedRemoteDesktopSessions,
  getLiveRemoteDesktopSessions,
  guardRemoteDesktopEngine,
  setRemoteDesktopHandle,
  removeRemoteDesktopHandle,
  getRemoteDesktopHandle,
  getAllRemoteDesktopHandles,
  type RemoteDesktopRuntimeHandle,
  type RemoteDesktopSlice,
  type RemoteDesktopSliceState,
} from './remoteDesktopSlice';

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
/**
 * 출력이 흐르는 동안 활동 시각을 다시 쓰는 최소 간격.
 *
 * 이 값은 세 곳에서만 쓰인다 — 호스트 카드의 "최근 사용 N분 전" 라벨, 최근 세션 목록 정렬,
 * persist 할 세션 고르기. 전부 분 단위면 충분하다(홈 호스트 순서는 이름순으로 고정돼 있어
 * 여기에 영향받지 않는다). 750ms 마다 쓰면 그때마다 세션 레코드가 새 객체가 되어, 이 레코드를
 * 구독하는 화면들이 그 주기로 리렌더되고 persist 가 스토어 전체를 다시 직렬화해 디스크에 쓴다.
 */
const SESSION_ACTIVITY_THROTTLE_MS = 30_000;
const STARTUP_REFRESH_TIMEOUT_MS = 3_000;
const MOBILE_TAILNET_START_TIMEOUT_MS = 3 * 60 * 1_000;

function canonicalizeRdpFingerprint(value: string | null | undefined): string {
  const normalized = value?.trim().toUpperCase() ?? '';
  const withoutPrefix = normalized.replace(/^SHA256:/, '');
  const hex = withoutPrefix.replace(/[^0-9A-F]/g, '');
  if (hex.length !== 64) return normalized;
  return hex.match(/.{2}/g)?.join(':') ?? normalized;
}

/** ProxyJump 다단 깊이 상한. 데스크톱과 같은 값이다(안전장치). */
export const MOBILE_MAX_JUMP_CHAIN = 8;
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

interface PendingRdpCertificatePromptState {
  sessionId: string;
  hostId: string;
  hostLabel: string;
  logicalHost: string;
  fingerprint: string;
  previousFingerprint?: string | null;
  subject?: string;
  issuer?: string;
  notAfter?: string;
}

interface PendingCredentialPromptState {
  hostId: string;
  hostLabel: string;
  authType: 'password' | 'privateKey' | 'certificate';
  message?: string | null;
  initialValue: HostSecretInput;
  /**
   * 호스트에 저장된 SSH 사용자명. 이 창에서도 고칠 수 있어야 한다 — 사용자명이 틀렸을 때
   * 붙어 보고 실패할 때까지 기다렸다 고치게 하면, 눈앞에 자격증명 창을 두고도 못 고친다.
   */
  initialUsername: string;
}

/**
 * 인증이 깨진 뒤 계정·비밀을 다시 받는 창. 데스크톱 `CredentialRetryDialog` 와 같은 자리다.
 *
 * 위의 프롬프트와 다르다. 프롬프트는 **저장된 비밀이 없어서** 붙기 전에 묻는 것이라 사용자명을
 * 묻지 않는다(호스트에 있다). 이쪽은 이미 붙어 보고 인증이 깨진 뒤라서, 틀린 것이 비밀인지
 * 사용자명인지 알 수 없다 — 그래서 **둘 다** 받고, 저장된 비밀도 덮어쓴다.
 */
type PendingCredentialRetryState = CredentialRetryRequest;

/**
 * 연결 도중 서버가 낸 대화형 인증 물음(OTP·SSH 쪽 비밀번호 등).
 *
 * 자격증명 프롬프트와 다르다. 저 물음은 붙기 **전에** 우리가 무엇을 들고 갈지 묻는 것이고, 이것은
 * 이미 붙어서 인증하는 중에 **서버가** 묻는 것이다. 그래서 이 물음이 뜬 동안 연결은 답을 기다리며
 * 서 있고, 닫으면 그 연결이 끝난다.
 */
/**
 * 연결 하나가 지금 무엇을 거치는지. 단계 계산에 넣는 입력이다.
 *
 * 예전에는 한 줄 문구(connectionStatusMessage) 하나였다. 그러면 새 단계가 앞 단계를 덮어써서
 * 지나간 것은 사라지고, 실패했을 때 어디까지 갔는지 알 수 없다 — tailnet 때문인지 SSH 가
 * 거절한 것인지 구분할 방법이 없었다. 데스크톱이 이것을 단계 목록으로 바꾼 이유가 그것이고,
 * 계산은 shared-core 가 두 앱에 같은 것을 준다.
 *
 * persist 하지 않는다(partialize 는 명시 목록이다). 화면 상태이고, 다시 붙을 때 새로 만들어진다.
 */
export interface MobileConnectionViewState {
  hostId: string;
  /** tailnet 을 거치는 연결이면 그 노드의 마지막 상태. */
  tailnetStatus?: EngineTailnetStatus;
  /** tailnet 을 쓰는 연결인지. 쓰지 않으면 그 계층을 아예 안 보여준다. */
  hasTailnet: boolean;
  /** 대상 주소. 넷맵에서 그 기기를 찾아 경로를 보여주는 데 쓴다. */
  targetAddress?: string;
  /** Remote Desktop이면 마지막 protocol 단계를 SSH로 잘못 그리지 않게 한다. */
  hostKind?: 'rdp' | 'vnc';
  /** 코어/연결 배선이 확정한 현재 단계. 문구로 추측하지 않는다. */
  stage?: string;
  /** VNC가 SSH gateway를 거칠 때 두 tunnel 관문을 세우는 라벨. */
  tunnelLabel?: string;
  /** RDP가 기존 SSM port forward를 거치는지. */
  ssmTunnel?: boolean;
  /** 사람이 호스트 키를 판단하는 중인지. */
  hostKeyPrompted?: boolean;
  /** 사람이 대화형 인증에 답하는 중인지. */
  interactiveAuthPending?: boolean;
  /** 서버가 인증 단계에 보낸 배너. 원문 그대로 보여준다. */
  banner?: string;
  /** 지금 붙고 있는 홉. 점프 체인에서 어디까지 갔는지의 유일한 근거다. */
  hop?: EngineHopProgress;
  failureLayer?: ConnectionFailureLayer | null;
  failureMessage?: string;
}

interface PendingInteractiveAuthPromptState {
  hostId: string;
  hostLabel: string;
  challenge: EngineInteractiveChallenge;
  /** 물음을 낸 서버. 점프 체인에서 누구의 코드인지 이것으로 가른다. */
  hopLabel: string | null;
}

/**
 * startup command 로 지정한 스니펫에 `{{변수}}` 가 있을 때 값을 받는 프롬프트.
 *
 * 데스크톱은 접속을 시작하기 전에 묻지만(sessionSlice.ts) 모바일은 셸이 열린 뒤에 묻는다.
 * 여기서는 startup command 해석 자체가 셸 오픈 뒤에 일어나고, 그 앞으로 옮기면 cols·rows·
 * secrets 를 미리 만들어야 해서 접속 경로를 크게 흔든다. 셸이 이미 떠 있어도 명령은 프롬프트가
 * 감지된 뒤에 타이핑되므로 사용자가 보는 결과는 같다.
 */
interface PendingStartupCommandPromptState {
  sessionId: string;
  hostLabel: string;
  snippetId: string;
  command: string;
  variables: SnippetVariable[];
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
  /**
   * 내장 편집기용 읽기/쓰기. AWS SFTP 는 sync-api 브로커를 지나며 이 연산이 없어서
   * 옵셔널이다 — 없는 세션에서는 편집 동작을 내보내지 않는다.
   */
  readTextFile?: (path: string) => Promise<MobileSftpTextFile>;
  writeTextFile?: (request: MobileSftpWriteTextFile) => Promise<void>;
  close: () => Promise<void>;
}

/** 편집기가 연 파일. size·mtime 은 저장 시 원격이 바뀌었는지 대조하는 기준이다. */
interface MobileSftpTextFile {
  content: string;
  size: number;
  mtime: string;
  mode: number;
}

interface MobileSftpWriteTextFile {
  path: string;
  content: string;
  expectedSize?: number | null;
  expectedMtime?: string | null;
  mode?: number;
  force?: boolean;
}

/**
 * 열려 있는 원격 파일 편집기. 화면 상태라 persist 하지 않는다(partialize 는 명시 목록이다).
 * size·mtime 은 열었을 때의 값으로, 저장할 때 원격이 바뀌었는지 판정하는 기준이 된다.
 */
export interface MobileSftpEditorState {
  sftpSessionId: string;
  path: string;
  fileName: string;
  content: string;
  originalContent: string;
  size: number;
  mtime: string;
  mode: number;
  isLoading: boolean;
  isSaving: boolean;
  /** 원격이 바뀌어 저장이 막힌 상태 — 다시 불러오기/덮어쓰기를 물어야 한다. */
  conflict: boolean;
  errorMessage: string | null;
}

interface SshRuntimeSession {
  kind: 'ssh';
  recordId: string;
  hostId: string;
  /**
   * SSH 세션이면 채워진다. **기기에서 직접 연 SSM 셸에서는 null 이다** — 그 세션에는 SSH
   * 연결이 없고 셸만 있다(SSM 데이터채널 위의 원격 셸이다).
   */
  connection: EngineConnection | null;
  shell: EngineShell;
  backgroundListenerId: number | null;
  /**
   * SSH over SSM 을 태운 로컬 포워드. 세션이 끝나면 반드시 닫아야 한다 — 남겨 두면 AWS 쪽에
   * SSM 세션이 살아 있는 것으로 남는다.
   */
  ssmForward?: EngineSsmForward | null;
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

// 이 기기에서 성립하지 않는 인증 방식을 왜 못 쓰는지까지 말해 준다. "지원하지 않습니다"만
// 보여 주면 사용자가 무엇을 바꿔야 하는지 알 수 없다 — 'agent' 는 서명을 로컬 ssh-agent
// 소켓에 위임하는 방식이라 그 프로세스가 없는 iOS·Android 에서는 성립할 수 없고, 데스크톱
// 앱에서 인증 방식을 바꾸는 것이 유일한 해결이다.
function getUnsupportedAuthTypeMessage(
  host: SshHostRecord,
  fallbackKey: string,
): string {
  if (host.authType === 'agent') {
    return t('store.agentAuthUnsupported');
  }
  if (host.authType === 'keyboardInteractive') {
    return t('store.keyboardInteractiveUnsupported');
  }
  return t(fallbackKey);
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
  // 폼이 직접 고를 수 있는 건 password·privateKey·certificate 뿐이다. 'agent' 는 서명을
  // 로컬 ssh-agent 소켓에 위임하는 방식이라 그 프로세스가 없는 iOS·Android 에서는 성립하지
  // 않는다. 그래도 타입을 좁히지 않는다 — 데스크톱에서 설정된 방식을 모바일에서 편집할 때
  // 그대로 되돌려 보내야 하고, 좁히면 password 로 덮어써 데스크톱에서도 호스트가 깨진다.
  authType: AuthType;
  groupName?: string | null;
  credentialMode?: 'preserve' | 'replace' | 'remove';
  credentials?: {
    password?: string;
    privateKeyPem?: string;
    passphrase?: string;
    certificateText?: string;
  } | null;
  /**
   * 세 가지 상태를 구분한다 — 값이면 설정, `null` 이면 해제, **생략(`undefined`)이면 보존**.
   * 보존이 기본값이어야 한다: 이 필드를 모르는 화면이 호스트를 저장할 때 데스크톱에서 넣은
   * 값이 사라지면 안 된다.
   */
  startupCommand?: HostStartupCommand | null;
  /**
   * 아래 필드들도 같은 규약이다 — 값이면 설정, `null`(목록은 `[]`)이면 해제, 생략이면 보존.
   *
   * 목록형은 **빈 배열과 생략이 다른 뜻**이다. 빈 배열은 "전부 지워라", 생략은 "건드리지
   * 마라" — 둘을 섞으면 이 필드를 모르는 화면이 저장할 때 데스크톱에서 넣은 값이 사라진다.
   */
  tags?: string[];
  env?: HostEnvVar[] | null;
  agentForwarding?: boolean | null;
  useMosh?: boolean | null;
  jumpHostIds?: string[] | null;
  tailnetId?: string | null;
}

/**
 * RDP·VNC 호스트 편집 입력.
 *
 * SSH 와 같은 보존 규약이다 — 값이면 설정, `null` 이면 해제, 생략이면 보존. RDP 는 계정이
 * 자격증명에 딸리므로(도메인도) 사용자명이 여기 있다.
 */
export interface MobileRemoteDesktopDraftInput {
  hostId?: string;
  kind: 'rdp' | 'vnc';
  label: string;
  hostname: string;
  port: number;
  groupName?: string | null;
  tags?: string[];
  tailnetId?: string | null;
  credentialMode?: 'preserve' | 'replace' | 'remove';
  credentials?: {
    username?: string;
    domain?: string;
    password?: string;
  } | null;
  /** VNC 전용. */
  shared?: boolean | null;
  viewOnly?: boolean | null;
  imageQuality?: VncImageQuality | null;
  sshTunnelHostId?: string | null;
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
  /**
   * 아직 서버에 밀지 못한 변경.
   *
   * 쓰기는 **로컬에 먼저** 반영하고 여기 쌓은 뒤 밀어 본다. 오프라인·로그아웃이면 큐에
   * 남았다가 다음 기회에 나간다 — 데스크톱이 로컬 DB 에 쓰고 나중에 동기화하는 것과 같다.
   */
  syncOutbox: SyncOutboxEntry[];
  hosts: HostRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  tailnets: TailnetPayload[];
  /**
   * pull 로만 채운다 — 모바일에서 스니펫을 만들거나 고치지 않는다. 호스트의 startup command 가
   * 가리키는 스니펫을 풀고, 폼에서 고를 목록을 주기 위해서만 있다.
   */
  snippets: SnippetRecord[];
  knownHosts: KnownHostRecord[];
  secretMetadata: SecretMetadataRecord[];
  sessions: MobileSessionRecord[];
  sftpSessions: MobileSftpSessionRecord[];
  /** 열려 있는 원격 파일 편집기. 한 번에 하나만 띄운다. */
  sftpEditor: MobileSftpEditorState | null;
  sftpTransfers: MobileSftpTransferRecord[];
  sftpCopyBuffer: SftpCopyBuffer | null;
  /** Remote desktop (RDP/VNC) sessions — separate lifecycle from terminal. */
  remoteDesktopSessions: MobileRemoteDesktopSessionRecord[];
  remoteDesktopImmersive: boolean;
  activeSessionTabId: string | null;
  activeConnectionTab: MobileConnectionTabRef | null;
  secretsByRef: Record<string, LoadedManagedSecretPayload>;
  pendingBrowserLoginState: string | null;
  pendingAwsSsoLogin: PendingAwsSsoLoginState | null;
  pendingServerKeyPrompt: PendingServerKeyPromptState | null;
  pendingRdpCertificatePrompt: PendingRdpCertificatePromptState | null;
  pendingCredentialPrompt: PendingCredentialPromptState | null;
  pendingCredentialRetry: PendingCredentialRetryState | null;
  /**
   * 큐를 밀다 **연달아** 실패한 횟수와 마지막 이유.
   *
   * 한 번 실패는 흔하다(잠깐 끊김). 사람에게 알릴 값어치가 있는 것은 다시 시도해도 안 될
   * 때다. 예전에는 이유를 통째로 삼켜서, 영영 안 올라가는 계정도 화면상으로는 "최신" 이었다.
   */
  syncOutboxFailure: { count: number; message: string } | null;
  pendingInteractiveAuthPrompt: PendingInteractiveAuthPromptState | null;
  /** 세션·SFTP 레코드 ID 별 연결 진행. 붙는 중에만 값이 있다. */
  connectionViews: Record<string, MobileConnectionViewState>;
  pendingStartupCommandPrompt: PendingStartupCommandPromptState | null;
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
  /**
   * 아직 밀지 못한 변경을 서버로 민다. 실패해도 던지지 않고 큐에 남긴다.
   *
   * 포그라운드 복귀와 로그인 직후에 부른다 — 오프라인에서 한 편집이 그때 나간다.
   */
  flushSyncOutbox: () => Promise<void>;
  /**
   * 비밀 복원이 실패한 채로 남아 있으면 다시 시도한다.
   *
   * 복원 전에는 큐를 밀지 않으므로(비밀 값 없이 밀면 secrets 항목이 버려진다), 실패가
   * 그대로 남으면 동기화가 멈춘 채로 있다. 포그라운드 복귀 때 불러 앱 재시작 없이 푼다.
   */
  ensureSecureStateRestored: () => void;
  updateSettings: (input: Partial<MobileSettings>) => Promise<void>;
  connectToHost: (hostId: string) => Promise<string | null>;
  saveHost: (input: MobileHostDraftInput) => Promise<void>;
  /**
   * RDP·VNC 호스트를 만들거나 고친다.
   *
   * `saveHost` 와 섞지 않는다 — 그쪽은 SSH 전용이고(레코드를 `kind: 'ssh'` 로 만든다),
   * 한 함수로 합치면 종류를 잘못 넘겼을 때 호스트의 종류가 조용히 바뀐다.
   */
  saveRemoteDesktopHost: (
    input: MobileRemoteDesktopDraftInput,
  ) => Promise<void>;
  /**
   * EC2 호스트의 서버 프록시 설정을 바꾼다.
   *
   * `saveHost` 는 SSH 호스트 전용이라(다른 종류는 거절한다) 이 한 필드만 다루는 자리를 따로
   * 둔다. 켜면 SSH 전송이 sync-api WebSocket 을 타고, 끄면 기기에서 직접 SSM 으로 붙는다.
   */
  setAwsSsmServerProxyEnabled: (
    hostId: string,
    enabled: boolean,
  ) => Promise<void>;
  toggleHostFavorite: (hostId: string) => Promise<void>;
  deleteHost: (hostId: string) => Promise<void>;
  /**
   * 그룹을 새로 만든다. 호스트가 없는 빈 그룹으로 시작한다 — 홈 목록은 호스트가 0개인
   * 그룹도 그대로 보여 준다(buildVisibleGroups 가 거르지 않는다).
   */
  /**
   * 등록하지 않은 서버에 주소만으로 붙는다(`user@host[:port]`).
   *
   * 같은 주소의 호스트가 이미 있으면 그것으로 붙고, 없으면 만들어 붙는다 — 데스크톱 명령
   * 팔레트의 즉석 접속과 같은 규칙이다. 쓰기는 로컬 우선이라 오프라인에서도 된다.
   */
  quickConnectSsh: (input: ParsedQuickSshCommand) => Promise<string | null>;
  createGroup: (name: string, parentPath: string | null) => Promise<void>;
  /** 그룹 이름 변경. 그 아래 호스트의 groupName(경로)도 함께 다시 쓰인다. */
  renameGroup: (path: string, name: string) => Promise<void>;
  /** 그룹 삭제. mode 가 하위 항목을 지울지 한 단계 끌어올릴지 정한다. */
  removeGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  duplicateSession: (sessionId: string) => Promise<string | null>;
  setActiveConnectionTab: (tab: MobileConnectionTabRef | null) => void;
  setActiveSessionTab: (sessionId: string | null) => void;
  /** auto 는 포그라운드 복귀 자동 재연결이다 — startup 변수 값을 묻지 않는다. */
  resumeSession: (
    sessionId: string,
    options?: { auto?: boolean; credentialOverride?: HostSecretInput },
  ) => Promise<string | null>;
  disconnectSession: (sessionId: string) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  writeToSession: (sessionId: string, data: string) => Promise<void>;
  subscribeToSessionTerminal: (
    sessionId: string,
    handlers: SessionTerminalSubscription,
  ) => () => void;
  acceptServerKeyPrompt: () => Promise<void>;
  rejectServerKeyPrompt: () => Promise<void>;
  acceptRdpCertificatePrompt: () => Promise<void>;
  rejectRdpCertificatePrompt: () => Promise<void>;
  submitCredentialPrompt: (
    input: HostSecretInput & { username?: string },
  ) => Promise<void>;
  cancelCredentialPrompt: () => void;
  submitCredentialRetry: (
    input: HostSecretInput & { username: string },
  ) => Promise<void>;
  cancelCredentialRetry: () => void;
  submitInteractiveAuthPrompt: (answer: EngineInteractiveAnswer) => void;
  /** 닫으면 그 연결을 접는다 — 답 없이 두면 코어가 예산까지 기다린다. */
  cancelInteractiveAuthPrompt: () => void;
  submitStartupCommandPrompt: (values: Record<string, string>) => void;
  /** 취소하면 startup command 없이 접속을 그대로 쓴다. */
  cancelStartupCommandPrompt: () => void;
  openSftpForSession: (sessionId: string) => Promise<string | null>;
  /**
   * 터미널 탭을 만들지 않고 호스트에서 바로 SFTP 를 연다. 호스트 메뉴의 SFTP 가 쓰는
   * 경로다 — SFTP 는 자기 연결을 여니 터미널 세션을 먼저 띄울 이유가 없다.
   */
  openSftpForHost: (hostId: string) => Promise<string | null>;
  openSftpEditor: (sftpSessionId: string, remotePath: string) => Promise<void>;
  setSftpEditorContent: (content: string) => void;
  /** force 는 충돌을 알고도 덮어쓰기를 고른 경우다. */
  saveSftpEditor: (options?: { force?: boolean }) => Promise<boolean>;
  reloadSftpEditor: () => Promise<void>;
  closeSftpEditor: () => void;
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
  // Remote Desktop (RDP/VNC) actions
  createRemoteDesktopSession: RemoteDesktopSlice['createRemoteDesktopSession'];
  updateRemoteDesktopSession: RemoteDesktopSlice['updateRemoteDesktopSession'];
  removeRemoteDesktopSession: RemoteDesktopSlice['removeRemoteDesktopSession'];
  activateRemoteDesktopSession: RemoteDesktopSlice['activateRemoteDesktopSession'];
  setRemoteDesktopImmersive: RemoteDesktopSlice['setRemoteDesktopImmersive'];
  disconnectRemoteDesktopSession: (sessionId: string) => Promise<void>;
  /**
   * 실패한 RDP·VNC 세션을 **같은 탭에서** 다시 붙인다.
   *
   * SSH 의 resumeSession 과 다른 것은 이어 붙일 상태가 없다는 점이다 — 화면은 서버가 다시
   * 그리므로 처음부터 붙는 것이 맞다. 대신 세션 id 를 재사용해서, 탭을 닫고 홈에서 다시
   * 들어오는 일 없이 그 자리에서 이어지게 한다.
   */
  reconnectRemoteDesktopSession: (sessionId: string) => Promise<void>;
}

/** 프롬프트로 받았지만 아직 연결 성공을 못 본 자격증명. 성공하면 저장하고 지운다. */
const promptedSecretsByHostId = new Map<string, HostSecretInput>();

const runtimeSessions = new Map<string, RuntimeSession>();
/**
 * SSH over SSM 이 실패한 호스트의 기억. 앱이 도는 동안만 산다.
 *
 * 데스크톱도 같은 방식이다(메모리 맵) — 저장할 값이 아니다. 실패 이유는 대개 인스턴스 쪽
 * 사정이고, 앱을 다시 켰을 때 한 번 더 시도해 보는 것이 맞다.
 */
const awsSshOverSsmFallbacks = new Map<string, AwsSshOverSsmFallbackMemo>();
const runtimeSftpSessions = new Map<string, SftpRuntimeSession>();
// 세션별 터미널 구독 세대. 재구독이 잦아 낡은 리스너가 겹치는데, 이 값으로
// 배달 시점에 차단한다(자세한 이유는 subscribeToSessionTerminal 참고).
const terminalSubscriptionGenerations = new Map<string, number>();
const pendingSessionConnections = new Set<string>();
const pendingSftpConnections = new Set<string>();
type PendingTailnetConnection = {
  requestId: string;
  tailnetId: string;
  configSignature: string;
};
const pendingTailnetConnections = new Map<string, PendingTailnetConnection>();
// Native in-app browsers have one presentation slot. Joined callers may share
// the same URL, but a different Tailnet must not replace an authorization page
// the user is already completing.
let activeTailnetAuthorization: {
  requestIds: Set<string>;
  tailnetId: string;
  url: string;
} | null = null;
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
// 진행 중인 비밀 복원. pull 이 복원보다 먼저 도착하면 그 시점의 secretsByRef 가 비어 있어,
// 병합이 "로컬에 없다" 고 보고 서버 것으로 Keychain 을 덮어쓴다 — 아직 안 올린 비밀이
// 저장소에서 지워진다. 적용 전에 이 프라미스를 기다려 그 경합을 없앤다.
let secureStateRestorePromise: Promise<void> | null = null;
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
let pendingInteractiveAuthResolver:
  | ((answer: EngineInteractiveAnswer | null) => void)
  | null = null;
let pendingStartupCommandResolver:
  | ((values: Record<string, string> | null) => void)
  | null = null;
/**
 * 세션별로 마지막에 입력한 startup 변수 값. 자동 재연결이 재사용한다 — 홈→복귀 때마다 모달이
 * 뜨면 쓸 수 없다. 메모리에만 두고 persist 하지 않는다(명령에 비밀이 섞일 수 있다).
 */
const startupVarsBySession = new Map<string, Record<string, string>>();
let pendingAwsSsoCancelHandler: (() => void) | null = null;
let tailnetRequestCounter = 0;

class TailnetPreparationCancelledError extends Error {
  constructor() {
    super('Tailnet preparation was cancelled.');
    this.name = 'TailnetPreparationCancelledError';
  }
}

class TailnetConfigurationChangedError extends Error {
  constructor() {
    super(t('store.tailnetConfigurationChanged'));
    this.name = 'TailnetConfigurationChangedError';
  }
}

class TailnetAuthorizationBusyError extends Error {
  constructor() {
    super(t('store.tailnetAuthorizationBusy'));
    this.name = 'TailnetAuthorizationBusyError';
  }
}

async function cancelPendingTailnetConnection(
  recordId: string,
): Promise<boolean> {
  const pending = pendingTailnetConnections.get(recordId);
  if (!pending) {
    return false;
  }
  pendingTailnetConnections.delete(recordId);

  // Go joins simultaneous attempts for one Tailnet. Cancelling the shared
  // attempt while another tab still needs it would abort that tab too.
  const anotherConsumer = [...pendingTailnetConnections.values()].some(
    candidate => candidate.tailnetId === pending.tailnetId,
  );
  if (!anotherConsumer) {
    await cancelSyncedTailnetStart(pending.requestId, pending.tailnetId).catch(
      () => undefined,
    );
  }
  return true;
}

async function cancelAllPendingTailnetConnections(): Promise<void> {
  const pending = [...pendingTailnetConnections.values()];
  pendingTailnetConnections.clear();
  const requestByTailnet = new Map<string, string>();
  for (const request of pending) {
    if (!requestByTailnet.has(request.tailnetId)) {
      requestByTailnet.set(request.tailnetId, request.requestId);
    }
  }
  await Promise.allSettled(
    [...requestByTailnet].map(([tailnetId, requestId]) =>
      cancelSyncedTailnetStart(requestId, tailnetId),
    ),
  );
  activeTailnetAuthorization = null;
}

function getTailnetProgressMessage(status: EngineTailnetStatus): string {
  if (status.loginError) {
    return t('store.tailnetLoginRejected');
  }
  if (status.state === 'needsApproval') {
    return t('store.tailnetNeedsApproval');
  }
  if (status.authUrl) {
    return t('store.tailnetAuthorizeInBrowser');
  }
  if (status.expired || status.identityInvalid) {
    return t('store.tailnetReauthenticating');
  }
  if (status.state === 'needsAuth') {
    return t('store.tailnetPreparingAuthorization');
  }
  if (status.ready || status.degraded) {
    return t('store.tailnetReady');
  }
  return t('store.tailnetConnecting');
}

function getTailnetFailureMessage(
  status: EngineTailnetStatus | undefined,
): string {
  if (status?.loginError) {
    return t('store.tailnetLoginRejected');
  }
  if (status?.state === 'needsApproval') {
    return t('store.tailnetNeedsApproval');
  }
  if (status?.identityInvalid) {
    return t('store.tailnetIdentityInvalid');
  }
  if (status?.expired) {
    return t('store.tailnetReauthFailed');
  }
  if (status?.state === 'needsAuth') {
    return t('store.tailnetAuthorizationIncomplete');
  }
  return t('store.tailnetConnectFailed');
}

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
          // 비밀 복원이 실패한 채였다면 여기서 다시 시도한다. 그것이 안 풀리면 큐를
          // 밀지 않으므로, 이 한 줄이 없으면 앱을 껐다 켜기 전엔 동기화가 멈춰 있다.
          state.ensureSecureStateRestored();
          // 큐를 먼저 미는 것은 syncNow 가 보장한다(syncWithSession 앞머리).
          void state.syncNow().catch(() => undefined);
        }
        resumeDroppedActiveSession({
          sessions: state.sessions,
          activeSessionTabId: state.activeSessionTabId,
          // 포그라운드 복귀는 자동이다 — startup 변수 모달을 띄우지 않는다.
          resumeSession: sessionId =>
            state.resumeSession(sessionId, { auto: true }),
        });
        // Resume presentation only for the currently selected remote tab.
        //
        // 되살리는 탭은 화면을 통째로 다시 받는다. 백그라운드 동안 놓친 갱신은 damage rect 로
        // 다시 오지 않으므로(그 픽셀이 또 바뀔 때까지) 낡은 그림이 남는다. setActive 는 표시
        // 정책만 되돌린다.
        for (const rdSession of getLiveRemoteDesktopSessions(
          state.remoteDesktopSessions,
        )) {
          const active =
            state.activeConnectionTab?.kind === rdSession.protocol &&
            state.activeConnectionTab.id === rdSession.id;
          void nativeSetActive(rdSession.id, active).catch(() => undefined);
          if (active) {
            void nativeRefresh(rdSession.id).catch(() => undefined);
          }
        }
      } else {
        stopSyncPolling();
        // Pause all live remote desktop sessions on background
        const state = useMobileAppStore.getState();
        for (const rdSession of getLiveRemoteDesktopSessions(
          state.remoteDesktopSessions,
        )) {
          void nativeSetActive(rdSession.id, false).catch(() => undefined);
        }
        // Do not close Tailnet here. Browser authorization intentionally sends
        // the app to the background, and live SSH/SFTP sessions hold Tailnet
        // leases that should survive a brief app switch. The mobile Go runtime
        // tears down only idle nodes after its shorter grace period; native
        // module invalidation and account boundaries close everything eagerly.
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
    (payload.tailnets?.length ?? 0) +
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
    throw new Error(t('store.noVaultKey'));
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

function getLiveSessions(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  return sessions.filter(isLiveSession);
}

function isLiveSftpSession(session: MobileSftpSessionRecord): boolean {
  return session.status !== 'closed';
}

function getLiveSftpSessions(
  sftpSessions: MobileSftpSessionRecord[],
): MobileSftpSessionRecord[] {
  return sftpSessions.filter(isLiveSftpSession);
}

function normalizeActiveConnectionTab(
  sessions: MobileSessionRecord[],
  sftpSessions: MobileSftpSessionRecord[],
  currentTab: MobileConnectionTabRef | null,
  preferredTab?: MobileConnectionTabRef | null,
  rdSessions?: MobileRemoteDesktopSessionRecord[],
): MobileConnectionTabRef | null {
  const liveSessions = getLiveSessions(sessions);
  const liveSftpSessions = getLiveSftpSessions(sftpSessions);
  const liveRdSessions = getLiveRemoteDesktopSessions(rdSessions ?? []);
  const isValidTab = (tab: MobileConnectionTabRef | null | undefined) => {
    if (!tab) {
      return false;
    }
    if (tab.kind === 'terminal') {
      return liveSessions.some(session => session.id === tab.id);
    }
    if (tab.kind === 'sftp') {
      return liveSftpSessions.some(session => session.id === tab.id);
    }
    if (tab.kind === 'rdp' || tab.kind === 'vnc') {
      return liveRdSessions.some(session => session.id === tab.id);
    }
    return false;
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
  const firstRd = liveRdSessions[0];
  if (firstRd) {
    return { kind: firstRd.protocol, id: firstRd.id };
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

// 터미널 세션과 같은 규칙 — 제자리에서 갱신하고 순서는 건드리지 않는다. 예전에는 갱신마다
// lastEventAt 순으로 다시 정렬해서, 파일 목록을 한 번 새로 읽을 때마다 탭이 앞으로 튀었다.
function patchSftpSessionRecord(
  sftpSessions: MobileSftpSessionRecord[],
  sessionId: string,
  patch: Partial<MobileSftpSessionRecord>,
): MobileSftpSessionRecord[] {
  return sftpSessions.map(session =>
    session.id === sessionId ? { ...session, ...patch } : session,
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
    return [...sftpSessions, nextRecord];
  }

  const nextSessions = [...sftpSessions];
  nextSessions[existingIndex] = nextRecord;
  return nextSessions;
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
    openedAt: now,
    sessionId: id,
    hostId: host.id,
    title: host.label,
    connectionKind,
    connectionDetails,
    connectionStatusMessage: null,
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

// 저장·불러오기는 await 를 지나므로, 결과를 상태에 쓰기 전에 사용자가 아직 그 파일을 보고
// 있는지 확인해야 한다. 확인하지 않으면 느린 저장이 끝난 뒤 그 사이 열린 다른 파일의 기준을
// 덮어써, 그 파일이 수정되지 않은 것처럼 보이거나 거짓 충돌을 낸다.
function isSameEditorTarget(
  current: MobileSftpEditorState | null,
  target: Pick<MobileSftpEditorState, 'sftpSessionId' | 'path'>,
): current is MobileSftpEditorState {
  return (
    current !== null &&
    current.sftpSessionId === target.sftpSessionId &&
    current.path === target.path
  );
}

// 원격이 재는 크기는 바이트다. JS 문자열 length 는 UTF-16 단위라 한글·주석이 있는 파일에서
// 어긋나고, 그 값을 충돌 기준으로 두면 다음 저장이 거짓 충돌을 낸다.
function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// 편집기 제목에 쓸 파일 이름. 원격 경로는 항상 '/' 구분이라 basename 만 떼면 된다.
function remoteFileName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

// 엔진(sftpedit)이 "원격이 바뀌었다"를 이 접두어로 알려 준다 — 일반 실패와 구분해
// 다시 불러오기/덮어쓰기를 물어야 하기 때문이다.
const SFTP_WRITE_CONFLICT_PREFIX = 'sftp-conflict:';

function isSftpWriteConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(SFTP_WRITE_CONFLICT_PREFIX);
}

function getSftpEditorErrorMessage(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error ?? '')
  ).trim();
  return message || t('sftpEditor.failed');
}

function createSftpSessionRecord(
  host: SshHostRecord | AwsEc2HostRecord,
  sourceSessionId?: string | null,
): MobileSftpSessionRecord {
  const now = new Date().toISOString();
  return {
    id: createLocalId('sftp'),
    hostId: host.id,
    sourceSessionId: sourceSessionId ?? null,
    openedAt: now,
    title: `${host.label} SFTP`,
    status: 'connecting',
    currentPath: '.',
    listing: null,
    connectionStatusMessage: null,
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
    readTextFile: path => sftp.readTextFile(path),
    writeTextFile: request => sftp.writeTextFile(request),
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
      connectionStatusMessage: null,
    }));
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
  | 'syncOutbox'
  | 'hosts'
  | 'awsProfiles'
  | 'tailnets'
  | 'snippets'
  | 'knownHosts'
  | 'secretMetadata'
  | 'secretsByRef'
  | 'sessions'
  | 'sftpSessions'
  | 'sftpTransfers'
  | 'sftpCopyBuffer'
  | 'remoteDesktopSessions'
  | 'remoteDesktopImmersive'
  | 'activeSessionTabId'
  | 'activeConnectionTab'
> {
  return {
    vault: { status: 'none' },
    groups: [],
    syncOutbox: [],
    hosts: [],
    awsProfiles: [],
    tailnets: [],
    snippets: [],
    knownHosts: [],
    secretMetadata: [],
    secretsByRef: {},
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    remoteDesktopSessions: [],
    remoteDesktopImmersive: false,
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
  tailnetId?: string | null,
): {
  status: 'trusted' | 'untrusted' | 'mismatch';
  existing: KnownHostRecord | null;
} {
  const normalizedTailnetId = tailnetId?.trim() || undefined;
  const sameAlgorithm =
    knownHosts.find(
      record =>
        (record.tailnetId?.trim() || undefined) === normalizedTailnetId &&
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
  connection: EngineConnection | null,
  shell: EngineShell | null,
  backgroundListenerId: number | null,
  ssmForward?: EngineSsmForward | null,
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
  if (connection) {
    try {
      await connection.disconnect();
    } catch {}
  }
  // 포워드는 마지막에 닫는다 — SSH 를 먼저 끊어야 그 위의 터널이 조용히 끝난다.
  if (ssmForward) {
    try {
      await ssmForward.stop();
    } catch {}
  }
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
      runtime.ssmForward,
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
  await cancelAllPendingTailnetConnections();
  for (const sessionId of [...runtimeSessions.keys()]) {
    await disposeRuntimeSession(sessionId);
  }
  for (const sessionId of [...runtimeSftpSessions.keys()]) {
    await disposeRuntimeSftpSession(sessionId);
  }

  const pendingCertificate =
    useMobileAppStore.getState().pendingRdpCertificatePrompt;
  if (pendingCertificate) {
    useMobileAppStore.setState({ pendingRdpCertificatePrompt: null });
    await nativeTrustCertificate(pendingCertificate.sessionId, false).catch(
      () => undefined,
    );
  }

  // Native session first, then every transport resource, then its listener.
  for (const [sessionId, handle] of [...getAllRemoteDesktopHandles()]) {
    handle.cancelled = true;
    if (handle.dispose) {
      await handle.dispose();
      continue;
    }

    // Compatibility fallback for a handle created before the unified disposer was installed.
    removeRemoteDesktopHandle(sessionId);
    await nativeDisconnect(sessionId).catch(() => undefined);
    if (handle.tunnelId) {
      await closeRemoteDesktopTunnel(handle.tunnelId).catch(() => undefined);
    }
    await handle.ssmForward?.stop().catch(() => undefined);
    handle.eventUnsubscribe?.();
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
        // This helper is the final account boundary for startup rejection,
        // refresh expiry, logout, account deletion, and server changes. Keep
        // runtime teardown here so a new caller cannot clear credentials while
        // old-account sockets or Tailnet authorization attempts remain alive.
        await disconnectAllRuntimeSessions();
        const tasks: Array<Promise<unknown>> = [
          clearStoredSecrets(),
          clearStoredAwsProfiles(),
          clearStoredAwsSsoTokens(),
          clearStoredTailnets(),
          closeSyncedTailnets(),
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
        const rdpCertificate = get().pendingRdpCertificatePrompt;
        if (rdpCertificate) {
          void nativeTrustCertificate(rdpCertificate.sessionId, false).catch(
            () => undefined,
          );
        }
        pendingServerKeyResolver?.(false);
        pendingServerKeyResolver = null;
        pendingCredentialResolver?.(null);
        pendingCredentialResolver = null;
        pendingInteractiveAuthResolver?.(null);
        pendingInteractiveAuthResolver = null;
        pendingAwsSsoCancelHandler?.();
        pendingAwsSsoCancelHandler = null;
        set({
          pendingAwsSsoLogin: null,
          pendingServerKeyPrompt: null,
          pendingRdpCertificatePrompt: null,
          pendingCredentialPrompt: null,
          pendingCredentialRetry: null,
          syncOutboxFailure: null,
          pendingInteractiveAuthPrompt: null,
          pendingStartupCommandPrompt: null,
          connectionViews: {},
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
          pendingRdpCertificatePrompt: null,
          pendingCredentialPrompt: null,
          pendingCredentialRetry: null,
          syncOutboxFailure: null,
          pendingInteractiveAuthPrompt: null,
          pendingStartupCommandPrompt: null,
          connectionViews: {},
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
                offline: buildOfflineState(session, t('store.restoredOffline')),
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
          const [secretsByRef, awsProfiles, tailnets] = await Promise.all([
            loadStoredSecrets(),
            loadStoredAwsProfiles(),
            loadStoredTailnets(),
          ]);
          let currentState = get();
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

          const currentSession = currentState.auth.session;
          if (!currentSession) {
            return;
          }
          await configureSyncedTailnets({
            serverUrl,
            userId: currentSession.user.id,
            tailnets,
          }).catch(error => {
            console.warn('Failed to restore cached Tailnets.', error);
          });

          currentState = get();
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
            tailnets,
            secretsByRef,
            secretMetadata: deriveSecretMetadata(state.hosts, secretsByRef),
            secureStateReady: true,
          }));

          // 여기서 콜드스타트 자동 재연결을 시도했다가 되돌렸다. 교착이 생긴다:
          // 접속은 resolvePtyTerminalGridSize() 로 터미널 그리드를 기다리는데, 화면은 세션이
          // 'connecting' 이면 터미널 대신 로딩 상태를 그려서 그리드가 측정되지 않는다. 실측에서
          // "Preparing the terminal" 에 4분 이상 머물렀다.
          //
          // 콜드스타트에서 필요한 것(탭이 남는 것)은 normalizePersistedSessionsForColdStart 가
          // 이미 한다. 사용자가 그 탭을 누르면 그때는 터미널 뷰가 살아 있어 정상적으로 붙는다.
          // 자동 재연결은 AppState 전환(포그라운드 복귀)에만 걸어 둔다 — 그 경로는 화면이 이미
          // 마운트돼 있어 이 교착이 없고, 원래 보고된 증상이기도 하다.
        } catch (error) {
          // **삼키면 안 된다.** 여기서 던지면 위의 `secureStateReady: true` 에 도달하지
          // 못하고, 그 플래그가 false 인 동안은 큐를 밀지 않는다(비밀 값을 못 읽는 채로
          // 밀면 secrets 항목이 버려져 비밀번호가 사라진다). 즉 실패가 곧 **동기화 정지**다.
          //
          // 막는 것은 맞지만 조용히·영구히 막으면 안 된다. 상태에 남겨 화면이 "최신" 이라고
          // 거짓말하지 않게 하고, 포그라운드로 돌아올 때 ensureSecureStateRestored 가
          // 다시 시도해 앱 재시작 없이 풀리게 한다.
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              status: 'error',
              errorMessage:
                error instanceof Error && error.message.trim()
                  ? error.message
                  : t('store.vaultStateRestoreFailed'),
            },
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
            throw new Error(t('store.vaultSetupRequired'));
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
            errorMessage: error.message || t('store.vaultResetElsewhere'),
          },
        }));
        return true;
      };

      /**
       * 못 민 로컬 변경을 서버로 올린다.
       *
       * **바뀐 레코드만 보낸다.** 데스크톱(sync-service)은 밀 것이 있으면 로컬 전체
       * 스냅샷을 올리는데, 그 규칙은 여기서 쓰면 안 된다 — 모바일은 아는 종류만 남기고
       * 버리므로(decodeSupportedHosts: ssh·ec2·rdp·vnc) 폰의 로컬은 계정의 부분집합이다.
       * 전체 스냅샷으로 밀면 serial·warpgate·ECS 호스트가 서버에서 지워진다.
       *
       * 페이로드는 **지금 로컬 상태에서 다시 만든다**(buildSyncOutboxPayload). 큐가 값을
       * 들고 있지 않으므로 같은 레코드를 여러 번 고쳐도 마지막 값 하나만 나간다.
       *
       * **던지지 않는다.** 오프라인·로그아웃·서버 오류면 큐를 그대로 두고 이유만 남긴다.
       */
      const drainSyncOutbox = async (): Promise<void> => {
        const queued = get().syncOutbox;
        if (queued.length === 0) {
          return;
        }
        if (!get().auth.session) {
          return;
        }
        // 비밀은 Keychain 에서 **뒤늦게** 복원된다(secureStateReady 가 그때 켜진다).
        // 그 전에 밀면 secrets 항목이 보낼 것을 못 찾아 큐에서 조용히 빠지고, 호스트만
        // 올라가고 비밀번호는 영영 안 올라간다. 복원될 때까지 기다린다 — 다음 회차가 민다.
        if (!get().secureStateReady) {
          return;
        }

        const local = get();
        const { payload, drained } = buildSyncOutboxPayload(queued, {
          hosts: local.hosts,
          groups: local.groups,
          knownHosts: local.knownHosts,
          secretsByRef: local.secretsByRef,
        });

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
                payload,
                resolveVaultKeyForPush(currentSession),
              ),
              resolveVaultEpochForPush(),
              resolveMobileSyncDataFloor(get().hosts),
            );
            storePushedRevision(pushedRevision);
          });
        } catch (error) {
          // 볼트 세대 문제는 재시도해도 영원히 실패한다 — 공통 처리가 상태를 정리한다.
          // 그 밖의 실패(네트워크 등)는 큐를 그대로 두고 다음 기회를 기다린다.
          await handleVaultDekMismatchError(error).catch(() => undefined);
          // **이유를 남긴다.** 예전에는 여기서 통째로 삼켰고, 그래서 영영 안 올라가는 계정도
          // 화면상으로는 "최신" 이었다. 조용한 실패가 제일 나쁜 결말이다.
          const message =
            error instanceof Error && error.message.trim()
              ? error.message
              : t('store.syncFailed');
          set(state => {
            const count = (state.syncOutboxFailure?.count ?? 0) + 1;
            return {
              syncOutboxFailure: { count, message },
              syncStatus: {
                ...state.syncStatus,
                pendingPush: true,
                // 한 번 실패는 흔하다(잠깐 끊김) — 다음 회차가 조용히 다시 민다.
                // 다시 시도해도 안 되면 그때는 상태에 드러내야 한다. 안 그러면 밀기가
                // 계속 실패해도 당기기만 되면 화면이 "최신" 이라고 말한다.
                ...(count >= 2
                  ? { status: 'error' as const, errorMessage: message }
                  : {}),
              },
            };
          });
          return;
        }

        // 미는 동안 사용자가 또 고쳤을 수 있다. 그 항목은 남겨야 한다.
        set(state => {
          const next = removeSyncOutbox(state.syncOutbox, drained);
          const cleared = next.length === 0;
          return {
            syncOutbox: next,
            syncStatus: {
              ...state.syncStatus,
              pendingPush: !cleared,
              // 다 올렸으면 앞선 실패 표시를 걷는다. 안 걷으면 이미 해결된 오류가 화면에
              // 남고, 당기기가 없는 회차에서는 마지막 동기화 시각도 안 움직인다.
              ...(cleared && state.syncStatus.status === 'error'
                ? { status: 'ready' as const, errorMessage: null }
                : {}),
              ...(cleared
                ? { lastSuccessfulSyncAt: new Date().toISOString() }
                : {}),
            },
            syncOutboxFailure: null,
          };
        });
      };

      /** 로컬을 먼저 바꾸고 큐에 넣은 뒤 밀어 본다. 오프라인이면 큐에 남는다. */
      const enqueueAndDrain = (entries: SyncOutboxEntry[]) => {
        set(state => {
          const next = enqueueManySyncOutbox(state.syncOutbox, entries);
          return {
            syncOutbox: next,
            syncStatus: { ...state.syncStatus, pendingPush: next.length > 0 },
          };
        });
        void drainSyncOutbox();
      };

      // Every key on file for an address, so the engine can connect without
      // probing the host first. All of them rather than one: the server chooses
      // the algorithm, and a host with both Ed25519 and ECDSA on file would
      // otherwise fail whenever it picks the one that was left out.
      const trustedHostKeysFor = (
        hostname: string,
        port: number,
        tailnetId?: string | null,
      ): string[] => {
        const normalizedTailnetId = tailnetId?.trim() || undefined;
        return get()
          .knownHosts.filter(
            record =>
              (record.tailnetId?.trim() || undefined) === normalizedTailnetId &&
              record.host === hostname &&
              record.port === port,
          )
          .map(record => record.publicKeyBase64)
          .filter(Boolean);
      };

      /**
       * 점프 체인을 연결 페이로드의 모양으로 조립한다.
       *
       * 모바일은 이것을 아예 보내지 않았다 — 데스크톱에서 점프 호스트를 설정해 동기화해도 폰은
       * 대상 주소로 직접 붙었고, 베스천 경유만 가능한 호스트는 그냥 타임아웃으로 끝났다.
       *
       * 홉도 대상과 같은 자격증명 경로를 쓴다(vault → 없으면 물어본다). 홉의 비밀번호가 없으면
       * 여기서 사용자에게 묻는데, 그것이 맞다 — 그 홉은 실제로 인증해야 지나갈 수 있다.
       *
       * 코어가 읽는 순서는 안쪽부터다: 가장 안쪽(jump 없음)이 이 기기에서 직접 소켓을 여는 첫 홉.
       */
      const resolveJumpChain = async (
        host: SshHostRecord,
      ): Promise<EngineJumpTarget | undefined> => {
        const chain = normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId);
        if (chain.length === 0) {
          return undefined;
        }
        // 데스크톱과 같은 상한. 없으면 잘못 엮인 체인이 재귀로 앱을 잡아먹는다.
        if (chain.length > MOBILE_MAX_JUMP_CHAIN) {
          throw new Error(
            t('store.jumpChainTooDeep', { max: MOBILE_MAX_JUMP_CHAIN }),
          );
        }
        if (chain.includes(host.id)) {
          throw new Error(t('store.jumpChainSelf'));
        }

        let resolved: EngineJumpTarget | undefined;
        for (const jumpHostId of chain) {
          const jumpHostRecord = get().hosts.find(
            record => record.id === jumpHostId,
          );
          if (!jumpHostRecord) {
            throw new Error(t('store.jumpHostMissing'));
          }
          if (!isSshHostRecord(jumpHostRecord)) {
            throw new Error(t('store.jumpHostMustBeSsh'));
          }
          let jumpHost = jumpHostRecord;
          const credentials = await resolveHostCredentials(jumpHost);
          if (!credentials) {
            // 사용자가 홉의 자격증명 입력을 접었다. 취소로 끝낸다.
            throw new TailnetPreparationCancelledError();
          }
          // 창에서 사용자명을 고쳤을 수 있다 — 고친 값으로 이 홉을 지나가야 한다.
          jumpHost = refreshSshHost(jumpHost);
          const credential = buildEngineCredential(jumpHost, credentials);
          if (!credential) {
            throw new Error(
              t('store.jumpHostCredentialMissing', { label: jumpHost.label }),
            );
          }
          resolved = {
            host: jumpHost.hostname,
            port: jumpHost.port,
            username: jumpHost.username,
            credential,
            trustedHostKeysBase64: trustedHostKeysFor(
              jumpHost.hostname,
              jumpHost.port,
              jumpHost.tailnetId,
            ),
            ...(resolved ? { jump: resolved } : {}),
          };
        }
        return resolved;
      };

      /**
       * 서버가 낸 대화형 인증 물음을 사람에게 올리고 답을 기다린다.
       *
       * 답이 올 때까지 그 연결은 코어에서 서 있다 — 그래서 이 약속을 반드시 풀어야 한다. 취소는
       * null 이고, 그것도 답이다(코어가 그 자리에서 접는다).
       */
      const askInteractiveAuth = async (
        host: Pick<HostRecord, 'id' | 'label'>,
        challenge: EngineInteractiveChallenge,
        recordId?: string,
      ): Promise<EngineInteractiveAnswer | null> => {
        const hopLabel = formatInteractiveHop(challenge.hop, get().hosts);
        if (recordId) {
          patchConnectionView(recordId, { interactiveAuthPending: true });
        }
        const answer = await new Promise<EngineInteractiveAnswer | null>(
          resolve => {
            // 앞의 물음이 아직 떠 있으면 그것부터 접는다. 슬롯이 하나뿐이라 덮어쓰면 앞의 것을
            // 아무도 답할 수 없고, 그 연결이 예산까지 멈춘다.
            pendingInteractiveAuthResolver?.(null);
            pendingInteractiveAuthResolver = resolve;
            set({
              pendingInteractiveAuthPrompt: {
                hostId: host.id,
                hostLabel: host.label,
                challenge,
                hopLabel,
              },
            });
          },
        );
        if (recordId) {
          patchConnectionView(recordId, { interactiveAuthPending: false });
        }
        return answer;
      };

      /**
       * AWS 접속 실패를 사람이 읽는 문구로.
       *
       * SSH 경로가 쓰는 분류기를 그대로 쓴다(데스크톱과 같은 표). 분류되지 않으면 원문을 남긴다.
       */
      const describeAwsConnectFailure = (
        error: unknown,
        target: string,
      ): string => {
        if (!(error instanceof Error) || !error.message.trim()) {
          return t('store.ssmDirectFailed');
        }
        return getConnectFailureMessage(error.message, target);
      };

      /**
       * EC2 인스턴스에 **기기에서 직접** 붙는다. 서버(sync-api)를 거치지 않는다.
       *
       * 데스크톱과 같은 순서다: SSH over SSM 을 먼저 시도하고(실제 SSH 셸이라 셸 통합·SFTP·
       * 점프가 살아난다) 실패하면 SSM 셸로 폴백한다. 무엇을 시도할지·언제 재시도할지는
       * shared-core 의 규칙을 쓴다 — 두 플랫폼이 갈리지 않아야 한다.
       *
       * 서버 프록시를 켠 호스트는 여기 오지 않는다(호출부에서 갈린다).
       */
      const connectAwsEc2Directly = async (input: {
        host: AwsEc2HostRecord;
        sessionRecordId: string;
        resolved: ResolvedAwsSessionResult;
        terminalSize: { cols: number; rows: number };
        markClosed: () => void;
        markDropped: () => void;
      }): Promise<void> => {
        const { host, sessionRecordId, resolved, terminalSize } = input;
        const engine = getEngine();
        const sshPort = getAwsEc2HostSshPort(host);
        const isWindowsInstance = isAwsEc2WindowsPlatform(host.awsPlatform);
        const attemptSsh = shouldAttemptSshOverSsm({
          host,
          isWindowsInstance,
          memo: awsSshOverSsmFallbacks.get(host.id) ?? null,
          nowMs: Date.now(),
        });

        console.info(
          `[mobile-aws] direct attemptSsh=${attemptSsh} windows=${isWindowsInstance}`,
        );
        let sshFailure: string | null = null;
        if (attemptSsh) {
          const sshUsername = host.awsSshUsername?.trim();
          const availabilityZone = host.awsAvailabilityZone?.trim();
          if (!sshUsername || !availabilityZone) {
            // 계정·AZ 는 인스턴스 메타데이터에서 온다. 없으면 SSH 로 갈 수 없다 — 폴백 사유로
            // 남기고 SSM 셸로 간다(데스크톱도 이 경우 SSH 를 시도하지 않는다).
            sshFailure =
              host.awsSshMetadataError || t('store.awsSftpUsernameRequired');
          } else {
            let forward: EngineSsmForward | null = null;
            try {
              // EIC 키는 60초만 유효하다. 세션마다 새로 만든다.
              const key = await engine.generateEphemeralSshKey();
              await pushEc2InstanceConnectKey({
                credentials: resolved.credentials,
                region: resolved.region,
                instanceId: host.awsInstanceId,
                availabilityZone,
                osUser: sshUsername,
                publicKey: key.publicKey,
              });
              const token = await startSsmPortForwardSession({
                credentials: resolved.credentials,
                region: resolved.region,
                instanceId: host.awsInstanceId,
                remotePort: sshPort,
                // 0 이면 커널이 빈 포트를 고른다. 기기에서 고정 포트를 쓸 이유가 없다.
                localPort: 0,
              });
              forward = await engine.startSsmPortForward({
                forwardId: `ssm-fwd:${sessionRecordId}`,
                request: {
                  region: resolved.region,
                  targetId: host.awsInstanceId,
                  targetPort: sshPort,
                  bindPort: 0,
                  streamUrl: token.streamUrl,
                  tokenValue: token.tokenValue,
                  ssmSessionId: token.sessionId,
                },
              });

              // **호스트 키 신뢰는 인스턴스 신원으로 기록한다.** 실제로 붙는 주소는
              // 127.0.0.1 이라, 그 주소로 기록하면 다른 인스턴스도 같은 키로 통과한다.
              const identity = buildAwsSsmKnownHostIdentity({
                profileName: resolved.profileName,
                region: resolved.region,
                instanceId: host.awsInstanceId,
              });
              const connection = await engine.connect({
                connectionId: sessionRecordId,
                host: '127.0.0.1',
                port: forward.bindPort,
                username: sshUsername,
                credential: { type: 'key', privateKey: key.privateKeyPem },
                size: terminalSize,
                trustedHostKeysBase64: trustedHostKeysFor(identity, sshPort),
                onServerKey: async info =>
                  resolveKnownHostTrust(
                    host,
                    { ...info, host: identity, port: sshPort },
                    sessionRecordId,
                  ),
                onDisconnected: input.markDropped,
              });
              const shell = await connection.startShell({
                term: 'xterm',
                size: terminalSize,
                onClosed: input.markClosed,
              });

              runtimeSessions.set(sessionRecordId, {
                kind: 'ssh',
                recordId: sessionRecordId,
                hostId: host.id,
                connection,
                shell,
                backgroundListenerId: null,
                ssmForward: forward,
              });
              // 연결에 성공했으니 방금 쓴 자격증명을 저장한다(데스크톱과 같은 시점).
              commitConnectionSecrets(host);
              awsSshOverSsmFallbacks.delete(host.id);
              console.info(
                `[mobile-aws] direct connected=ssh-over-ssm user=${sshUsername} ` +
                  `localPort=${forward.bindPort}`,
              );
              set(state => ({
                sessions: patchSessionRecord(state.sessions, sessionRecordId, {
                  status: 'connected',
                  errorMessage: null,
                  // **어떤 경로로 붙었는지 남긴다.** 두 경로 모두 결과가 "붙었다" 라서 이것 없이는
                  // 서버를 거쳤는지 기기에서 직접 붙었는지 확인할 방법이 없다.
                  connectionStatusMessage: t('store.ssmPathDirectSsh'),
                  lastEventAt: new Date().toISOString(),
                  lastConnectedAt: new Date().toISOString(),
                  title: host.label,
                  connectionKind: 'aws-ssm',
                  connectionDetails: resolved.connectionDetails,
                }),
              }));
              return;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              // 호스트 키 문제는 폴백하지 않는다 — 폴백해 버리면 사용자가 신뢰한 뒤 SSH 로
              // 붙을 기회가 사라진다.
              if (isAwsHostKeySecurityError(message)) {
                if (forward) {
                  await forward.stop().catch(() => undefined);
                }
                throw error;
              }
              sshFailure = message;
              console.info(`[mobile-aws] direct sshFailed reason=${message}`);
              if (forward) {
                await forward.stop().catch(() => undefined);
              }
              awsSshOverSsmFallbacks.set(
                host.id,
                recordSshOverSsmFallback({ host, nowMs: Date.now() }),
              );
            }
          }
        }

        // SSM 셸로 폴백. 윈도우 인스턴스는 애초에 여기로 온다.
        try {
          const token = await startSsmShellSession({
            credentials: resolved.credentials,
            region: resolved.region,
            instanceId: host.awsInstanceId,
          });
          const shell = await engine.startAwsSsmShell({
            sessionId: sessionRecordId,
            request: {
              region: resolved.region,
              instanceId: host.awsInstanceId,
              cols: terminalSize.cols,
              rows: terminalSize.rows,
              streamUrl: token.streamUrl,
              tokenValue: token.tokenValue,
              ssmSessionId: token.sessionId,
              shellKind: isWindowsInstance ? 'powershell' : '',
              kmsKeyId: token.kmsKeyId,
              kmsCipherTextBlobBase64: token.kmsCipherTextBlobBase64,
              kmsPlainTextKeyBase64: token.kmsPlainTextKeyBase64,
            },
            onClosed: input.markClosed,
          });

          console.info(
            `[mobile-aws] direct connected=ssm-shell fellBack=${sshFailure !== null}`,
          );
          runtimeSessions.set(sessionRecordId, {
            kind: 'ssh',
            recordId: sessionRecordId,
            hostId: host.id,
            // SSM 셸에는 SSH 연결이 없다 — 셸만 있다.
            connection: null,
            shell,
            backgroundListenerId: null,
            ssmForward: null,
          });
          // 연결에 성공했으니 방금 쓴 자격증명을 저장한다(데스크톱과 같은 시점).
          commitConnectionSecrets(host);
          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionRecordId, {
              status: 'connected',
              errorMessage: null,
              // SSH 로 붙지 못해 내려온 것이면 그 사실을 남긴다. 조용히 SSM 셸로 붙으면
              // 사용자는 왜 계정이 ssm-user 인지, 왜 SFTP 가 없는지 알 수 없다.
              connectionStatusMessage: sshFailure
                ? t('store.ssmSshFellBack')
                : t('store.ssmPathDirectShell'),
              lastEventAt: new Date().toISOString(),
              lastConnectedAt: new Date().toISOString(),
              title: host.label,
              connectionKind: 'aws-ssm',
              connectionDetails: resolved.connectionDetails,
            }),
          }));
        } catch (error) {
          const target = `${host.awsInstanceName?.trim() || host.awsInstanceId}`;
          const fallbackMessage = describeAwsConnectFailure(error, target);
          if (!sshFailure) {
            throw new Error(fallbackMessage);
          }
          const sshMessage = getConnectFailureMessage(sshFailure, target);
          // 둘 다 실패했으면 두 이유를 같이 보여준다 — 하나만 보이면 엉뚱한 곳을 고친다.
          // 다만 **같은 이유면 한 번만** 보여준다. 예전에는 같은 문구가 `/` 로 두 번 붙어서
          // 무슨 말인지 알 수 없었다(실측: "undefined is not a function" 두 개).
          throw new Error(
            sshMessage === fallbackMessage
              ? sshMessage
              : t('store.ssmBothFailed', {
                  ssh: sshMessage,
                  shell: fallbackMessage,
                }),
          );
        }
      };

      const resolveKnownHostTrust = async (
        host: Pick<HostRecord, 'id' | 'label'> & {
          tailnetId?: string | null;
        },
        info: MobileServerPublicKeyInfo,
        recordId?: string,
      ): Promise<boolean> => {
        const { status, existing } = getKnownHostStatus(
          get().knownHosts,
          info,
          host.tailnetId,
        );
        if (status === 'trusted') {
          const refreshedRecord = buildKnownHostRecord(
            info,
            existing,
            host.tailnetId,
          );
          set(state => ({
            knownHosts: sortKnownHosts(
              state.knownHosts.map(record =>
                record.id === refreshedRecord.id ? refreshedRecord : record,
              ),
            ),
          }));
          return true;
        }

        if (recordId) {
          patchConnectionView(recordId, { hostKeyPrompted: true });
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

        if (recordId) {
          patchConnectionView(recordId, { hostKeyPrompted: false });
        }
        if (!accepted) {
          return false;
        }

        const trustedRecord = buildKnownHostRecord(
          info,
          existing,
          host.tailnetId,
        );
        const nextKnownHosts = sortKnownHosts(
          get().knownHosts.filter(record => record.id !== trustedRecord.id),
        );
        const mergedKnownHosts = sortKnownHosts([
          ...nextKnownHosts,
          trustedRecord,
        ]);

        // 신뢰는 이미 명시적이다. 로컬에 먼저 남기고 아웃박스가 나른다 — 예전에는 여기서
        // 바로 밀고 실패하면 pendingPush 만 세웠는데, 그 플래그를 읽는 곳이 없어 오프라인에서
        // 신뢰한 호스트키가 그 기기에만 남았다.
        set({ knownHosts: mergedKnownHosts });
        enqueueAndDrain([
          { kind: 'knownHosts', id: trustedRecord.id, op: 'upsert' },
        ]);
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
              initialUsername: host.username,
            },
          });
        });

      /**
       * 프롬프트로 받은 자격증명을 **연결 성공 때까지 들고만 있는다.**
       *
       * 예전에는 프롬프트 직후 바로 저장했다. 틀린 비밀번호도 저장되고, `secretRef` 가 없는
       * 호스트(주소만 적어 만든 것 등)는 아예 저장되지 않아 붙을 때마다 다시 물었다.
       * 데스크톱은 코어가 "connected" 를 보낸 뒤에만 저장한다(persistHostSpecificSecret).
       */
      const rememberPromptedSecret = (
        host: SshHostRecord,
        prompted: HostSecretInput,
      ) => {
        if (
          !prompted.password &&
          !prompted.passphrase &&
          !prompted.privateKeyPem &&
          !prompted.certificateText
        ) {
          return;
        }
        promptedSecretsByHostId.set(host.id, prompted);
      };

      /**
       * 연결에 성공했으니 방금 쓴 자격증명을 저장한다.
       *
       * `secretRef` 가 없으면 여기서 만든다 — 그래야 다음에 붙을 때 묻지 않는다. 호스트
       * 레코드가 바뀌므로 아웃박스에 실어 보낸다(오프라인이면 큐에 남는다).
       */
      const commitPromptedSecret = async (hostId: string) => {
        const prompted = promptedSecretsByHostId.get(hostId);
        if (!prompted) {
          return;
        }
        promptedSecretsByHostId.delete(hostId);

        const host = get().hosts.find(item => item.id === hostId);
        if (!host || !isSshHostRecord(host)) {
          return;
        }

        const secretRef = host.secretRef ?? createLocalId('secret');
        const merged = mergePromptedSecrets(
          get().secretsByRef[secretRef],
          { ...host, secretRef },
          prompted,
        );
        if (!merged) {
          return;
        }

        const entries: SyncOutboxEntry[] = [
          { kind: 'secrets', id: secretRef, op: 'upsert' },
        ];
        let nextHosts = get().hosts;
        if (!host.secretRef) {
          const record: HostRecord = {
            ...host,
            secretRef,
            updatedAt: new Date().toISOString(),
          };
          nextHosts = sortHosts([
            ...nextHosts.filter(item => item.id !== hostId),
            record,
          ]);
          set({ hosts: nextHosts });
          entries.push({ kind: 'hosts', id: hostId, op: 'upsert' });
        }

        await updateSecretsState(
          { ...get().secretsByRef, [secretRef]: merged },
          nextHosts,
        );
        enqueueAndDrain(entries);
      };

      /**
       * 자격증명 창에서 고친 SSH 사용자명을 호스트에 남긴다.
       *
       * 로컬 우선 + 아웃박스다 — 로그인·네트워크 없이도 고쳐지고, 이번 연결이 또 실패해도
       * 고쳐 넣은 값은 남는다(아니면 매번 같은 오타를 다시 친다).
       */
      /**
       * 연결에 성공했으니 **이 연결이 쓴** 자격증명을 저장한다.
       *
       * 대상 호스트만으로는 모자란다 — 점프 홉도 붙기 전에 물어보므로, 그 홉의 비밀도 같이
       * 저장하지 않으면 갈 때마다 다시 묻는다.
       */
      const commitConnectionSecrets = (host: HostRecord) => {
        void commitPromptedSecret(host.id);
        if (!isSshHostRecord(host)) {
          return;
        }
        for (const jumpHostId of normalizeJumpHostIds(
          host.jumpHostIds,
          host.jumpHostId,
        )) {
          void commitPromptedSecret(jumpHostId);
        }
      };

      const applyHostUsername = (host: SshHostRecord, username: string) => {
        if (username === host.username.trim()) {
          return;
        }
        const record: HostRecord = {
          ...host,
          username,
          updatedAt: new Date().toISOString(),
        };
        const nextHosts = sortHosts([
          ...get().hosts.filter(item => item.id !== host.id),
          record,
        ]);
        set({
          hosts: nextHosts,
          secretMetadata: deriveSecretMetadata(nextHosts, get().secretsByRef),
        });
        enqueueAndDrain([{ kind: 'hosts', id: host.id, op: 'upsert' }]);
      };

      /**
       * 자격증명 창을 지나온 뒤 호스트를 다시 읽는다.
       *
       * 연결 경로는 창을 띄우기 **전에** 읽은 레코드를 들고 있다. 창에서 사용자명을 고쳤는데
       * 그대로 두면 이번 시도가 옛 사용자명으로 나가고, 방금 고친 사람은 왜 또 실패하는지
       * 알 수 없다.
       */
      const refreshSshHost = <T extends SshHostRecord>(host: T): T => {
        const next = get().hosts.find(item => item.id === host.id);
        return next && isSshHostRecord(next) ? (next as T) : host;
      };

      /**
       * 이 호스트로 붙을 때 쓸 자격증명을 고른다.
       *
       * `override` 는 인증 실패 재시도 창이 방금 받아 온 값이다. **저장된 값보다 우선한다** —
       * 안 그러면 저장된 비밀번호가 틀린 경우(서버에서 바꿨을 때)를 고칠 방법이 없다.
       * 저장은 여기서 하지 않는다. 연결이 성공해야 저장하는 규칙은 그대로다.
       */
      /** 인증이 깨진 것이면 재시도 창을 세운다. 판정과 내용은 lib/credential-retry 가 만든다. */
      const offerCredentialRetry = (
        host: HostRecord,
        error: unknown,
        target: CredentialRetryTarget,
        message: string,
      ) => {
        const request = buildCredentialRetryRequest(
          host,
          error,
          target,
          message,
        );
        if (request) {
          set({ pendingCredentialRetry: request });
        }
      };

      /**
       * 이 호스트로 붙을 때 쓸 자격증명을 고른다.
       *
       * `override` 는 인증 실패 재시도 창이 방금 받아 온 값이다. **저장된 값보다 우선한다** —
       * 안 그러면 저장된 비밀번호가 틀린 경우(서버에서 바꿨을 때)를 고칠 방법이 없다.
       * 저장은 여기서 하지 않는다. 연결이 성공해야 저장하는 규칙은 그대로다.
       */
      const resolveHostCredentials = async (
        host: SshHostRecord,
        override?: HostSecretInput | null,
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

        if (override) {
          const merged: HostSecretInput = {
            password: override.password ?? promptBase.password,
            passphrase: override.passphrase ?? promptBase.passphrase,
            privateKeyPem: override.privateKeyPem ?? promptBase.privateKeyPem,
            certificateText:
              override.certificateText ?? promptBase.certificateText,
          };
          rememberPromptedSecret(host, merged);
          return merged;
        }

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

          rememberPromptedSecret(host, prompted);

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

          rememberPromptedSecret(host, prompted);

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

          rememberPromptedSecret(host, prompted);

          return { ...promptBase, ...prompted };
        }

        return null;
      };

      /**
       * 런타임 스냅샷을 세션 레코드에 게시한다.
       *
       * **주기 호출(`periodic: true`)에서는 스냅샷을 쓰지 않는다.** 그 문자열은 출력마다 바뀌어서
       * 레코드를 750ms 마다 새 객체로 만들고, 그러면 이 레코드를 구독하는 모든 화면이 그 주기로
       * 리렌더되고 persist 가 스토어 전체를 다시 직렬화해 디스크에 쓴다. 출력이 흐르는 내내다.
       *
       * 화면 복원에 필요한 것은 **끝나는 순간의 화면**이고, 그건 세션이 live 를 벗어날 때 부르는
       * 직접 호출이 게시한다(runtimeSessionSnapshots 는 그동안 계속 쌓인다).
       *
       * 백그라운드 전환에서는 게시하지 않는다. 그때는 프로세스가 살아 있어 런타임 Map 이 그대로
       * 남고, persist 는 스냅샷을 빈 문자열로 비워 저장하므로(compactPersistedSessions) 레코드에
       * 옮겨 적어도 디스크로 나가지 않는다 — 하는 일 없이 리렌더만 만든다. 스냅샷을 실제로
       * 저장하게 바꾸는 날에는 그때 백그라운드 게시를 함께 넣어야 한다.
       * 살아 있는 세션의 화면은 구독 리플레이가 런타임 값에서 바로 준다.
       */
      const flushSessionSnapshot = (
        sessionId: string,
        options?: {
          markActivity?: boolean;
          periodic?: boolean;
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
          if (!options?.periodic && snapshot !== current.lastViewportSnapshot) {
            patch.lastViewportSnapshot = snapshot;
          }
          if (!current.hasReceivedOutput && snapshot.length > 0) {
            patch.hasReceivedOutput = true;
          }
          if (options?.markActivity !== false) {
            const now = Date.now();
            const previous = Date.parse(current.lastEventAt);
            // 주기 갱신만 스로틀한다. 직접 호출(세션 종료·백그라운드 등)은 그 순간의 시각이
            // 의미가 있으므로 그대로 쓴다.
            const staleEnough =
              !options?.periodic ||
              Number.isNaN(previous) ||
              now - previous >= SESSION_ACTIVITY_THROTTLE_MS;
            if (staleEnough) {
              patch.lastEventAt = new Date(now).toISOString();
            }
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
          flushSessionSnapshot(sessionId, { periodic: true });
        }, SESSION_SNAPSHOT_FLUSH_MS);
        runtimeSnapshotFlushTimers.set(sessionId, timer);
      };

      const markSessionState = (
        sessionId: string,
        status: MobileSessionRecord['status'],
        errorMessage?: string | null,
        // 밖에서 끊긴 경우에만 'dropped' 를 넘긴다(client-api.ts 의 disconnectReason 참고).
        // 넘기지 않으면 patch 가 undefined 로 덮어써 표시가 자동으로 원복된다 — 재연결에
        // 성공한 세션이 "Disconnected" 로 남지 않게 하는 것이 이 기본값의 목적이다.
        disconnectReason?: MobileSessionRecord['disconnectReason'],
      ) => {
        const now = new Date().toISOString();
        set(state => {
          const nextSessions = patchSessionRecord(state.sessions, sessionId, {
            status,
            errorMessage: errorMessage ?? null,
            ...(status === 'connecting'
              ? {}
              : { connectionStatusMessage: null }),
            isRestorable: true,
            lastEventAt: now,
            lastDisconnectedAt:
              status === 'closed' || status === 'error' ? now : undefined,
            disconnectReason,
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
              ...(status === 'connecting'
                ? {}
                : { connectionStatusMessage: null }),
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

      const setConnectionProgress = (
        kind: 'terminal' | 'sftp' | 'remoteDesktop',
        recordId: string,
        message: string | null,
      ) => {
        const now = new Date().toISOString();
        if (kind === 'terminal') {
          set(state => ({
            sessions: patchSessionRecord(state.sessions, recordId, {
              connectionStatusMessage: message,
              lastEventAt: now,
            }),
          }));
          return;
        }
        if (kind === 'remoteDesktop') {
          get().updateRemoteDesktopSession(recordId, {
            connectionStatusMessage: message,
          });
          return;
        }
        set(state => ({
          sftpSessions: patchSftpSessionRecord(state.sftpSessions, recordId, {
            connectionStatusMessage: message,
            lastEventAt: now,
          }),
        }));
      };

      /**
       * 연결 진행을 고친다. 없던 연결이면 만들고, 있으면 얹는다.
       *
       * 붙는 중에만 존재한다 — 끝나면 beginConnectionView 로 다시 시작하거나 clearConnectionView
       * 로 지운다. 남겨 두면 다음 연결이 지난번 tailnet 상태를 물려받아 이미 통과한 것처럼 보인다.
       */
      const patchConnectionView = (
        recordId: string,
        patch: Partial<MobileConnectionViewState>,
      ) => {
        set(state => {
          const current = state.connectionViews[recordId];
          if (!current) {
            return {};
          }
          return {
            connectionViews: {
              ...state.connectionViews,
              [recordId]: { ...current, ...patch },
            },
          };
        });
      };

      const beginConnectionView = (
        recordId: string,
        view: MobileConnectionViewState,
      ) => {
        set(state => ({
          connectionViews: { ...state.connectionViews, [recordId]: view },
        }));
      };

      const clearConnectionView = (recordId: string) => {
        set(state => {
          if (!state.connectionViews[recordId]) {
            return {};
          }
          const next = { ...state.connectionViews };
          delete next[recordId];
          return { connectionViews: next };
        });
      };

      const prepareTailnetForConnection = async (input: {
        kind: 'terminal' | 'sftp' | 'remoteDesktop';
        recordId: string;
        hostId: string;
        resolution: Extract<SyncedTailnetRouteResolution, { kind: 'tailnet' }>;
      }): Promise<
        Extract<SyncedTailnetRouteResolution, { kind: 'tailnet' }>
      > => {
        tailnetRequestCounter += 1;
        const requestId = `mobile-${input.kind}-${input.recordId}-${tailnetRequestCounter}`;
        const pendingRequest: PendingTailnetConnection = {
          requestId,
          tailnetId: input.resolution.tailnetId,
          configSignature: input.resolution.configSignature,
        };
        pendingTailnetConnections.set(input.recordId, pendingRequest);
        const browserOpenTasks: Promise<void>[] = [];
        let browserOpenError: unknown;

        setConnectionProgress(
          input.kind,
          input.recordId,
          t('store.tailnetConnecting'),
        );

        try {
          await startSyncedTailnet({
            requestId,
            tailnetId: input.resolution.tailnetId,
            tailnets: get().tailnets,
            timeoutMs: MOBILE_TAILNET_START_TIMEOUT_MS,
            onStatus: status => {
              setConnectionProgress(
                input.kind,
                input.recordId,
                getTailnetProgressMessage(status),
              );
              // 단계 화면이 읽는 것. 한 줄 문구와 달리 지나간 관문이 남는다.
              patchConnectionView(input.recordId, { tailnetStatus: status });
              const authUrl = status.authUrl?.trim();
              if (!authUrl) {
                return;
              }
              if (
                activeTailnetAuthorization?.url === authUrl &&
                activeTailnetAuthorization.tailnetId ===
                  input.resolution.tailnetId
              ) {
                activeTailnetAuthorization.requestIds.add(requestId);
                return;
              }
              if (activeTailnetAuthorization) {
                browserOpenError = new TailnetAuthorizationBusyError();
                void getEngine()
                  .cancelTailnet(requestId, input.resolution.tailnetId)
                  .catch(() => undefined);
                return;
              }
              activeTailnetAuthorization = {
                requestIds: new Set([requestId]),
                tailnetId: input.resolution.tailnetId,
                url: authUrl,
              };
              // Keep Tailnet authorization in the same browser sheet used by
              // account and AWS login. The user closes it manually after the
              // provider confirms approval; completion does not rely on a
              // Headscale redirect because the Go runtime polls readiness.
              browserOpenTasks.push(
                openInAppBrowser(authUrl).catch(error => {
                  browserOpenError = error;
                  void getEngine()
                    .cancelTailnet(requestId, input.resolution.tailnetId)
                    .catch(() => undefined);
                }),
              );
            },
          });
          await Promise.all(browserOpenTasks);

          if (
            pendingTailnetConnections.get(input.recordId) !== pendingRequest
          ) {
            throw new TailnetPreparationCancelledError();
          }
          if (browserOpenError) {
            if (browserOpenError instanceof TailnetAuthorizationBusyError) {
              throw browserOpenError;
            }
            throw new Error(t('store.tailnetBrowserOpenFailed'));
          }
          const currentHost = get().hosts.find(
            host => host.id === input.hostId,
          );
          // **처음 정할 때와 같은 규칙으로 다시 정해야 한다.** 여기서 대상의 tailnetId 를 직접
          // 읽으면, 첫 홉의 tailnet 으로 노드를 올려놓고 대상 기준으로 검사하게 된다 — 대상에
          // 설정이 없는 경유 구성에서는 그 둘이 언제나 달라서 붙을 때마다 "설정이 변경되었습니다"
          // 로 끝났다. 같은 것을 두 곳에서 다르게 판정한 것이 원인이다.
          const currentResolution = currentHost
            ? resolveSyncedTailnetRoute(
                {
                  tailnetId: resolveSshHostTailnetId(currentHost, get().hosts),
                },
                get().tailnets,
              )
            : {
                kind: 'missing' as const,
                tailnetId: input.resolution.tailnetId,
              };
          if (
            !isSyncedTailnetConfigCurrent(
              input.resolution.tailnetId,
              input.resolution.configSignature,
            ) ||
            currentResolution.kind !== 'tailnet' ||
            currentResolution.tailnetId !== input.resolution.tailnetId ||
            currentResolution.configSignature !==
              input.resolution.configSignature
          ) {
            throw new TailnetConfigurationChangedError();
          }
          return currentResolution;
        } catch (error) {
          if (
            error instanceof TailnetPreparationCancelledError ||
            pendingTailnetConnections.get(input.recordId) !== pendingRequest
          ) {
            throw new TailnetPreparationCancelledError();
          }
          if (error instanceof TailnetConfigurationChangedError) {
            throw error;
          }
          if (error instanceof TailnetAuthorizationBusyError) {
            throw error;
          }
          if (browserOpenError) {
            console.warn(
              '[mobile-tailnet] Failed to open the authorization URL.',
              browserOpenError,
            );
            throw new Error(t('store.tailnetBrowserOpenFailed'));
          }
          const status =
            error instanceof SyncedTailnetStartError ? error.status : undefined;
          console.warn(
            '[mobile-tailnet] Failed to prepare the network.',
            error,
          );
          throw new Error(getTailnetFailureMessage(status));
        } finally {
          if (
            pendingTailnetConnections.get(input.recordId) === pendingRequest
          ) {
            pendingTailnetConnections.delete(input.recordId);
          }
          if (activeTailnetAuthorization?.requestIds.has(requestId)) {
            activeTailnetAuthorization.requestIds.delete(requestId);
            if (activeTailnetAuthorization.requestIds.size === 0) {
              activeTailnetAuthorization = null;
            }
          }
          setConnectionProgress(input.kind, input.recordId, null);
        }
      };

      const refreshSftpDirectory = async (
        sessionId: string,
        path?: string,
      ): Promise<void> => {
        const runtime = runtimeSftpSessions.get(sessionId);
        if (!runtime) {
          markSftpSessionState(sessionId, 'error', t('store.sftpNotFound'));
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
            error instanceof Error ? error.message : t('store.sftpListFailed'),
          );
        }
      };

      // SFTP 는 자격 증명·호스트 키·연결을 자기 것으로 여니 터미널 세션이 필요 없다.
      // 터미널 탭에서 열었을 때만 어디서 열렸는지를 sourceSessionId 로 남긴다.
      const openSftpForHostId = async (
        hostId: string,
        sourceSessionId?: string,
      ): Promise<string | null> => {
        const host = get().hosts.find(item => item.id === hostId);
        if (!host || (!isSshHostRecord(host) && !isAwsEc2HostRecord(host))) {
          return null;
        }

        // 같은 호스트에 살아 있는 SFTP 탭이 있으면 그걸 활성화한다 — 탭이 겹쳐 쌓이지 않게.
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

        const nextSftpSession = createSftpSessionRecord(host, sourceSessionId);
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
      };

      const connectSftpSessionRecord = async (
        sftpSessionRecord: MobileSftpSessionRecord,
        host: SshHostRecord | AwsEc2HostRecord,
        options?: {
          /** 인증 실패 재시도 창이 방금 받아 온 자격증명. 저장된 값보다 우선한다. */
          credentialOverride?: HostSecretInput | null;
        },
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
              getUnsupportedAuthTypeMessage(host, 'store.sftpAuthLimited'),
            );
            return;
          }

          const credentials = await resolveHostCredentials(
            host,
            options?.credentialOverride,
          );
          if (!credentials) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'closed',
              t('store.sftpCancelled'),
            );
            return;
          }

          // 창에서 사용자명을 고쳤을 수 있다 — 고친 값으로 붙어야 한다.
          host = isSshHostRecord(host) ? refreshSshHost(host) : host;

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

          // 점프 체인이 있으면 올려야 하는 노드는 **첫 홉**의 것이다. 대상에서 읽으면
          // "tailnet 안의 베스천을 거쳐 사내 LAN 호스트로" 가 안 된다 — 판정은 shared-core 가
          // 데스크톱과 같은 규칙으로 한다.
          const tailnetResolution = resolveSyncedTailnetRoute(
            { tailnetId: resolveSshHostTailnetId(host, get().hosts) },
            get().tailnets,
          );
          if (tailnetResolution.kind === 'missing') {
            markSftpSessionState(
              sftpSessionRecord.id,
              'error',
              t('store.tailnetMissing'),
            );
            return;
          }
          let tailnet: { tailnetId: string; tailnetName?: string } | undefined;

          set(state => ({
            sftpSessions: patchSftpSessionRecord(
              state.sftpSessions,
              sftpSessionRecord.id,
              {
                status: 'connecting',
                errorMessage: null,
                connectionStatusMessage: null,
                lastEventAt: new Date().toISOString(),
              },
            ),
          }));

          // 터미널과 같은 규칙 — tailnet 준비 전에 세워야 그 구간이 화면에 보인다.
          beginConnectionView(sftpSessionRecord.id, {
            hostId: host.id,
            hasTailnet: tailnetResolution.kind === 'tailnet',
            targetAddress: host.hostname,
          });

          if (tailnetResolution.kind === 'tailnet') {
            const prepared = await prepareTailnetForConnection({
              kind: 'sftp',
              recordId: sftpSessionRecord.id,
              hostId: host.id,
              resolution: tailnetResolution,
            });
            tailnet = {
              tailnetId: prepared.tailnetId,
              ...(prepared.tailnetName
                ? { tailnetName: prepared.tailnetName }
                : {}),
            };
          }

          const engine = getEngine();
          console.info(
            `[mobile-sftp] engine=${engine.name} session=${sftpSessionRecord.id}`,
          );
          // 홉의 자격증명이 없으면 여기서 물어본다 — 붙기 전이라 물어볼 자리가 있다.
          const jumpChain = isSshHostRecord(host)
            ? await resolveJumpChain(host)
            : undefined;
          const engineSftp = await engine.connectSftp({
            connectionId: sftpSessionRecord.id,
            host: host.hostname,
            port: host.port,
            username: host.username,
            credential: security,
            ...(tailnet ? { tailnet } : {}),
            ...(jumpChain ? { jump: jumpChain } : {}),
            trustedHostKeysBase64: trustedHostKeysFor(
              host.hostname,
              host.port,
              host.tailnetId,
            ),
            onServerKey: async info =>
              resolveKnownHostTrust(host, info, sftpSessionRecord.id),
            onInteractiveChallenge: challenge =>
              askInteractiveAuth(host, challenge, sftpSessionRecord.id),
            // 서버가 인증 단계에 보낸 안내. 붙어 있는 동안 보여줘야 그 자리에서 끝난다 —
            // 실패한 뒤에 말해 주면 이미 끊긴 연결을 다시 시작해야 한다.
            onBanner: bannerText =>
              patchConnectionView(sftpSessionRecord.id, { banner: bannerText }),
            onHopProgress: hop =>
              patchConnectionView(sftpSessionRecord.id, { hop }),
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
          // 터미널과 같은 시점에 저장한다. 여기 없으면 SFTP 로만 쓰는 호스트는 붙을 때마다
          // 비밀번호를 다시 묻는다 — 물어본 비밀을 성공 뒤에만 저장하도록 바꾸면서 빠졌었다.
          commitConnectionSecrets(host);
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
                connectionStatusMessage: null,
                lastEventAt: now,
                lastConnectedAt: now,
                title: `${host.label} SFTP`,
              },
            ),
            connectionViews: (() => {
              const next = { ...state.connectionViews };
              delete next[sftpSessionRecord.id];
              return next;
            })(),
          }));
        } catch (error) {
          await disposeRuntimeSftpSession(sftpSessionRecord.id);
          if (error instanceof TailnetPreparationCancelledError) {
            return;
          }
          if (isAuthExpiredError(error)) {
            await expireAuthSession();
            return;
          }
          const message =
            error instanceof Error
              ? getConnectFailureMessage(
                  error.message,
                  isSshHostRecord(host)
                    ? `${host.username}@${host.hostname}:${host.port}`
                    : host.label,
                )
              : t('store.sftpConnectFailed');
          markSftpSessionState(sftpSessionRecord.id, 'error', message);
          offerCredentialRetry(
            host,
            error,
            { kind: 'sftp', recordId: sftpSessionRecord.id },
            message,
          );
          // 터미널과 같은 규칙 — 실패한 단계를 남겨 어디서 막혔는지 보이게 한다.
          patchConnectionView(sftpSessionRecord.id, {
            failureLayer:
              error instanceof Error
                ? getConnectFailureLayer(error.message)
                : null,
            failureMessage: message,
            hostKeyPrompted: false,
            interactiveAuthPending: false,
          });
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
                dataFloorServerSupport: toServerSupport(
                  serverInfo.capabilities.sync.dataFloor,
                ),
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
            host.awsSshMetadataError || t('store.awsSftpUsernameRequired'),
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

      // ------------------------------------------------------------------
      // Remote Desktop (VNC/RDP) connection path
      // ------------------------------------------------------------------

      const rejectPendingRdpCertificateForSession = async (rdId: string) => {
        const prompt = get().pendingRdpCertificatePrompt;
        if (!prompt || prompt.sessionId !== rdId) return;
        set({ pendingRdpCertificatePrompt: null });
        await nativeTrustCertificate(rdId, false).catch(() => undefined);
      };

      const releaseRemoteDesktopRuntime = async (
        rdId: string,
        expectedRuntime?: RemoteDesktopRuntimeHandle,
      ) => {
        const runtime = expectedRuntime ?? getRemoteDesktopHandle(rdId);
        if (!runtime) {
          await rejectPendingRdpCertificateForSession(rdId);
          return;
        }

        runtime.cancelled = true;
        if (runtime.disposePromise) {
          await runtime.disposePromise;
          return;
        }
        if (getRemoteDesktopHandle(rdId) === runtime) {
          removeRemoteDesktopHandle(rdId);
        }

        runtime.disposePromise = (async () => {
          await rejectPendingRdpCertificateForSession(rdId);

          // An SSH-backed tunnel can still be inside host-key/auth/dial before
          // OpenRemoteDesktopTunnel has returned an owned tunnel ID.
          const sshConnectId = runtime.sshConnectId;
          runtime.sshConnectId = null;
          if (sshConnectId) {
            await getEngine()
              .cancelConnect(sshConnectId)
              .catch(() => undefined);
          }

          await nativeDisconnect(rdId).catch(() => undefined);

          const tunnelId = runtime.tunnelId;
          runtime.tunnelId = null;
          if (tunnelId) {
            await closeRemoteDesktopTunnel(tunnelId).catch(() => undefined);
          }

          const ssmForward = runtime.ssmForward;
          runtime.ssmForward = null;
          await ssmForward?.stop().catch(() => undefined);

          const unsubscribe = runtime.eventUnsubscribe;
          runtime.eventUnsubscribe = null;
          unsubscribe?.();
        })();
        await runtime.disposePromise;
      };

      const persistRdpCertificateFingerprint = async (
        hostId: string,
        fingerprint: string,
      ) => {
        const current = get().hosts.find(item => item.id === hostId);
        if (!current || !isRdpHostRecord(current)) return;

        const record: RdpHostRecord = {
          ...current,
          certificateFingerprint: fingerprint,
          updatedAt: new Date().toISOString(),
        };
        set(state => ({
          hosts: sortHosts([
            ...state.hosts.filter(item => item.id !== record.id),
            record,
          ]),
          syncStatus: { ...state.syncStatus, pendingPush: true },
        }));

        // Trust is already explicit at this point. Keep the local pin even if the network is
        // down — 아웃박스가 다음 기회에 민다. 예전에는 pendingPush 만 세우고 재시도할 주체가
        // 없어서, 오프라인에서 신뢰한 인증서가 그 기기에만 남았다.
        enqueueAndDrain([{ kind: 'hosts', id: record.id, op: 'upsert' }]);
      };

      const handleRdpCertificateEvent = async (
        rdId: string,
        hostId: string,
        event: RemoteDesktopSessionEvent,
      ) => {
        const fingerprint = canonicalizeRdpFingerprint(event.fingerprint);
        if (!fingerprint) {
          await nativeTrustCertificate(rdId, false).catch(() => undefined);
          throw new Error(t('session.rdpCertificateMissing'));
        }

        const current = get().hosts.find(item => item.id === hostId);
        if (!current || !isRdpHostRecord(current)) {
          await nativeTrustCertificate(rdId, false).catch(() => undefined);
          return;
        }

        const previous = current.certificateFingerprint?.trim() || null;
        if (previous && canonicalizeRdpFingerprint(previous) === fingerprint) {
          await nativeTrustCertificate(rdId, true);
          return;
        }

        const pending = get().pendingRdpCertificatePrompt;
        if (pending?.sessionId === rdId) return;
        if (pending) {
          set({ pendingRdpCertificatePrompt: null });
          await nativeTrustCertificate(pending.sessionId, false).catch(
            () => undefined,
          );
        }

        // The Rust core is paused between TLS and CredSSP here. No credential
        // bytes are sent until one of the explicit actions supplies a verdict.
        set({
          pendingRdpCertificatePrompt: {
            sessionId: rdId,
            hostId: current.id,
            hostLabel: current.label,
            logicalHost: current.hostname,
            fingerprint,
            previousFingerprint: previous,
            subject: event.subject,
            issuer: event.issuer,
            notAfter: event.notAfter,
          },
        });
      };

      /**
       * 실패 문구의 `{{target}}` 에 넣을 이름.
       *
       * 주소를 쓰는 이유는 그것이 사용자가 확인할 것이기 때문이다(포트가 열렸는지, 주소가
       * 맞는지). 라벨은 화면 다른 곳에 이미 있다.
       */
      const rdFailureTarget = (host: RdpHostRecord | VncHostRecord): string =>
        `${host.hostname}:${host.port}`;

      const connectRemoteDesktopSession = async (
        rdId: string,
        host: RdpHostRecord | VncHostRecord,
      ) => {
        const protocol = host.kind;
        const runtime: RemoteDesktopRuntimeHandle = {
          sessionId: rdId,
          cancelled: false,
          nativeStarted: false,
          tunnelId: null,
          sshConnectId: null,
          ssmForward: null,
          eventUnsubscribe: null,
          disposePromise: null,
        };
        runtime.dispose = () => releaseRemoteDesktopRuntime(rdId, runtime);
        setRemoteDesktopHandle(rdId, runtime);

        const assertRuntimeCurrent = () => {
          if (runtime.cancelled || getRemoteDesktopHandle(rdId) !== runtime) {
            throw new Error(t('store.connectCancelled'));
          }
        };

        try {
          assertRuntimeCurrent();
          if (!(await isNativeSessionAvailable(protocol))) {
            throw new Error(t('session.remoteDesktopNativeUnavailable'));
          }
          assertRuntimeCurrent();

          const secret = host.secretRef
            ? get().secretsByRef[host.secretRef]
            : undefined;
          if (host.secretRef && !secret) {
            throw new Error(t('session.remoteDesktopCredentialsUnavailable'));
          }
          if (
            protocol === 'rdp' &&
            (!secret?.username?.trim() || !secret.password)
          ) {
            throw new Error(t('session.remoteDesktopCredentialsUnavailable'));
          }

          let endpoint: {
            host: string;
            port: number;
            tunnelAuthToken?: string;
          } = { host: host.hostname, port: host.port };
          const requestedTunnelId = `rd-tunnel:${rdId}`;
          const sshTunnelHostId =
            protocol === 'vnc' ? host.sshTunnelHostId?.trim() : undefined;

          if (protocol === 'vnc' && sshTunnelHostId) {
            const tunnelHostRecord = get().hosts.find(
              item => item.id === sshTunnelHostId,
            );
            if (!tunnelHostRecord || !isSshHostRecord(tunnelHostRecord)) {
              throw new Error(t('session.remoteDesktopTunnelHostMissing'));
            }
            let tunnelHost = tunnelHostRecord;
            if (
              tunnelHost.authType !== 'password' &&
              tunnelHost.authType !== 'privateKey' &&
              tunnelHost.authType !== 'certificate'
            ) {
              throw new Error(
                getUnsupportedAuthTypeMessage(
                  tunnelHost,
                  'store.authKindUnsupported',
                ),
              );
            }

            get().updateRemoteDesktopSession(rdId, {
              connectionStatusMessage: t(
                'session.remoteDesktopPreparingTunnel',
              ),
            });
            const credentials = await resolveHostCredentials(tunnelHost);
            if (!credentials) throw new Error(t('store.connectCancelled'));
            // 창에서 사용자명을 고쳤을 수 있다 — 고친 값으로 터널을 뚫어야 한다.
            tunnelHost = refreshSshHost(tunnelHost);
            const credential = buildEngineCredential(tunnelHost, credentials);
            if (!credential) {
              throw new Error(getMissingCredentialMessage(tunnelHost));
            }
            const validationMessage =
              await validateEngineCredential(credential);
            if (validationMessage) throw new Error(validationMessage);

            const route = resolveSyncedTailnetRoute(
              { tailnetId: resolveSshHostTailnetId(tunnelHost, get().hosts) },
              get().tailnets,
            );
            if (route.kind === 'missing') {
              throw new Error(t('store.tailnetMissing'));
            }
            beginConnectionView(rdId, {
              hostId: host.id,
              hasTailnet: route.kind === 'tailnet',
              targetAddress: tunnelHost.hostname,
              hostKind: protocol,
              stage: route.kind === 'tailnet' ? 'tailnet' : 'host-key-check',
              tunnelLabel: tunnelHost.label,
            });
            let tailnet:
              | { tailnetId: string; tailnetName?: string }
              | undefined;
            if (route.kind === 'tailnet') {
              const prepared = await prepareTailnetForConnection({
                kind: 'remoteDesktop',
                recordId: rdId,
                hostId: tunnelHost.id,
                resolution: route,
              });
              tailnet = {
                tailnetId: prepared.tailnetId,
                ...(prepared.tailnetName
                  ? { tailnetName: prepared.tailnetName }
                  : {}),
              };
            }

            const jump = await resolveJumpChain(tunnelHost);
            patchConnectionView(rdId, { stage: 'ssh-tunnel-gateway' });
            get().updateRemoteDesktopSession(rdId, {
              connectionStatusMessage: t(
                'session.remoteDesktopPreparingTunnel',
              ),
            });
            runtime.sshConnectId = requestedTunnelId;
            const opened = await openRemoteDesktopTunnel({
              tunnelId: requestedTunnelId,
              host: host.hostname,
              port: host.port,
              transport: 'ssh',
              ssh: {
                host: tunnelHost.hostname,
                port: tunnelHost.port,
                username: tunnelHost.username,
                credential,
                targetHost: host.hostname,
                targetPort: host.port,
                ...(tailnet ? { tailnet } : {}),
                onServerKey: async info =>
                  resolveKnownHostTrust(tunnelHost, info, rdId),
                onInteractiveChallenge: challenge =>
                  askInteractiveAuth(tunnelHost, challenge, rdId),
                onBanner: banner => patchConnectionView(rdId, { banner }),
                onHopProgress: hop => patchConnectionView(rdId, { hop }),
                trustedHostKeysBase64: trustedHostKeysFor(
                  tunnelHost.hostname,
                  tunnelHost.port,
                  tunnelHost.tailnetId,
                ),
                ...(jump ? { jump } : {}),
              },
            });
            runtime.sshConnectId = null;
            if (runtime.cancelled || getRemoteDesktopHandle(rdId) !== runtime) {
              await closeRemoteDesktopTunnel(opened.tunnelId).catch(
                () => undefined,
              );
              throw new Error(t('store.connectCancelled'));
            }
            endpoint = {
              host: opened.host,
              port: opened.port,
              tunnelAuthToken: opened.authToken,
            };
            runtime.tunnelId = opened.tunnelId;
            // 터널이 섰다 = 이 홉의 자격증명이 맞았다. 여기서 저장하지 않으면 VNC 를 열 때마다
            // 게이트웨이 비밀번호를 다시 묻는다.
            commitConnectionSecrets(tunnelHost);
          } else {
            const route = resolveSyncedTailnetRoute(
              { tailnetId: host.tailnetId?.trim() || undefined },
              get().tailnets,
            );
            if (route.kind === 'missing') {
              throw new Error(t('store.tailnetMissing'));
            }
            if (route.kind === 'tailnet') {
              beginConnectionView(rdId, {
                hostId: host.id,
                hasTailnet: true,
                targetAddress: host.hostname,
                hostKind: protocol,
                stage: 'tailnet',
              });
              const prepared = await prepareTailnetForConnection({
                kind: 'remoteDesktop',
                recordId: rdId,
                hostId: host.id,
                resolution: route,
              });
              const opened = await openRemoteDesktopTunnel({
                tunnelId: requestedTunnelId,
                host: host.hostname,
                port: host.port,
                transport: 'tailscale',
                tailscale: {
                  tailnetId: prepared.tailnetId,
                  ...(prepared.tailnetName
                    ? { tailnetName: prepared.tailnetName }
                    : {}),
                },
              });
              if (
                runtime.cancelled ||
                getRemoteDesktopHandle(rdId) !== runtime
              ) {
                await closeRemoteDesktopTunnel(opened.tunnelId).catch(
                  () => undefined,
                );
                throw new Error(t('store.connectCancelled'));
              }
              endpoint = {
                host: opened.host,
                port: opened.port,
                tunnelAuthToken: opened.authToken,
              };
              runtime.tunnelId = opened.tunnelId;
            } else if (protocol === 'rdp' && host.awsSsm) {
              beginConnectionView(rdId, {
                hostId: host.id,
                hasTailnet: false,
                targetAddress: host.hostname,
                hostKind: protocol,
                stage: 'ssm-tunnel',
                ssmTunnel: true,
              });
              get().updateRemoteDesktopSession(rdId, {
                connectionStatusMessage: t(
                  'session.remoteDesktopPreparingTunnel',
                ),
              });
              const awsSsm = host.awsSsm;
              const explicitProfileId = awsSsm.profileId?.trim() || null;
              const profile = explicitProfileId
                ? get().awsProfiles.find(item => item.id === explicitProfileId)
                : get().awsProfiles.find(
                    item => item.name === awsSsm.profileName,
                  );
              if (!profile) throw new Error(t('aws.profileNotFound'));

              const awsHost: AwsEc2HostRecord = {
                id: `rdp-ssm:${host.id}`,
                kind: 'aws-ec2',
                label: host.label,
                awsProfileId: profile.id,
                awsProfileName: awsSsm.profileName,
                awsRegion: awsSsm.region,
                awsInstanceId: awsSsm.instanceId,
                awsInstanceName: host.label,
                createdAt: host.createdAt,
                updatedAt: host.updatedAt,
              };
              let accessToken = get().auth.session?.tokens.accessToken;
              if (!accessToken) throw new Error(t('store.onlineOnly'));
              let resolvedSession: ResolvedAwsSessionResult | null = null;
              let retriedAuth = false;
              while (!resolvedSession) {
                try {
                  resolvedSession = await resolveAwsSessionForHost({
                    host: awsHost,
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
                    if (!refreshed) throw error;
                    accessToken = refreshed.tokens.accessToken;
                    retriedAuth = true;
                    continue;
                  }
                  if (isAuthExpiredError(error)) await expireAuthSession();
                  throw error;
                }
              }

              assertRuntimeCurrent();
              const token = await startSsmPortForwardSession({
                credentials: resolvedSession.credentials,
                region: resolvedSession.region,
                instanceId: awsSsm.instanceId,
                remotePort: host.port,
                localPort: 0,
              });
              assertRuntimeCurrent();
              const openedSsmForward = await getEngine().startSsmPortForward({
                forwardId: `ssm-rdp:${rdId}`,
                request: {
                  region: resolvedSession.region,
                  targetId: awsSsm.instanceId,
                  targetPort: host.port,
                  bindPort: 0,
                  streamUrl: token.streamUrl,
                  tokenValue: token.tokenValue,
                  ssmSessionId: token.sessionId,
                },
              });
              if (
                runtime.cancelled ||
                getRemoteDesktopHandle(rdId) !== runtime
              ) {
                await openedSsmForward.stop().catch(() => undefined);
                throw new Error(t('store.connectCancelled'));
              }
              runtime.ssmForward = openedSsmForward;

              const opened = await openRemoteDesktopTunnel({
                tunnelId: requestedTunnelId,
                host: host.hostname,
                port: host.port,
                transport: 'ssm',
                ssm: { localPort: openedSsmForward.bindPort },
              });
              if (
                runtime.cancelled ||
                getRemoteDesktopHandle(rdId) !== runtime
              ) {
                await closeRemoteDesktopTunnel(opened.tunnelId).catch(
                  () => undefined,
                );
                throw new Error(t('store.connectCancelled'));
              }
              endpoint = {
                host: opened.host,
                port: opened.port,
                tunnelAuthToken: opened.authToken,
              };
              runtime.tunnelId = opened.tunnelId;
            }
          }

          patchConnectionView(rdId, { stage: 'connecting' });
          runtime.eventUnsubscribe = subscribeToSessionEvents(event => {
            if (event.sessionId !== rdId) return;
            if (runtime.cancelled || getRemoteDesktopHandle(rdId) !== runtime) {
              return;
            }
            if (event.type === 'status') {
              get().updateRemoteDesktopSession(rdId, {
                status: event.status ?? 'connecting',
                connectionStatusMessage: null,
                ...(event.status === 'connected'
                  ? {
                      lastConnectedAt: new Date().toISOString(),
                      // **크기를 안 실은 이벤트는 크기에 손대지 않는다.** 예전에는
                      // `event.width ?? null` 이어서, 크기 없는 connected 가 한 번만 흘러도
                      // 이미 받아 둔 원격 해상도가 지워졌다. 그러면 좌표 변환의 기준이
                      // 뷰포트 크기로 폴백해 클릭이 엉뚱한 데로 가고 Fit 배율이 1 이 된다.
                      ...(event.width !== undefined
                        ? { desktopWidth: event.width }
                        : {}),
                      ...(event.height !== undefined
                        ? { desktopHeight: event.height }
                        : {}),
                      ...(event.name !== undefined
                        ? { desktopName: event.name }
                        : {}),
                    }
                  : {}),
              });
              if (event.status === 'connected') {
                clearConnectionView(rdId);
              }
              return;
            }
            if (event.type === 'resize') {
              get().updateRemoteDesktopSession(rdId, {
                desktopWidth: event.width ?? null,
                desktopHeight: event.height ?? null,
              });
              return;
            }
            if (event.type === 'clipboard' && event.text !== undefined) {
              const active = get().activeConnectionTab;
              if (active?.kind !== protocol || active.id !== rdId) return;
              Clipboard.setString(event.text);
              return;
            }
            if (event.type === 'certificate' && protocol === 'rdp') {
              void handleRdpCertificateEvent(rdId, host.id, event).catch(
                error => {
                  if (
                    runtime.cancelled ||
                    getRemoteDesktopHandle(rdId) !== runtime
                  ) {
                    return;
                  }
                  const errorMessage =
                    error instanceof Error
                      ? error.message
                      : t('session.remoteDesktopError');
                  get().updateRemoteDesktopSession(rdId, {
                    status: 'error',
                    errorMessage,
                    connectionStatusMessage: null,
                  });
                  patchConnectionView(rdId, {
                    failureLayer: null,
                    failureMessage: errorMessage,
                  });
                  void releaseRemoteDesktopRuntime(rdId, runtime);
                },
              );
              return;
            }
            if (event.type === 'error') {
              // 네이티브가 올려 보내는 문장도 같은 처지다 — 위 catch 와 같은 분류를 쓴다.
              const errorMessage = event.message?.trim()
                ? getConnectFailureMessage(event.message, rdFailureTarget(host))
                : t('session.remoteDesktopError');
              get().updateRemoteDesktopSession(rdId, {
                status: 'error',
                errorMessage,
                connectionStatusMessage: null,
                lastDisconnectedAt: new Date().toISOString(),
              });
              patchConnectionView(rdId, {
                // 어느 단계에 붙일지도 분류가 정한다 — null 로 고정하면 tailnet 계층에서 난
                // 실패까지 호스트 단계에 붙는다(SSH·SFTP 는 같은 분류를 쓴다).
                failureLayer: event.message
                  ? getConnectFailureLayer(event.message)
                  : null,
                failureMessage: errorMessage,
              });
              void (async () => {
                await releaseRemoteDesktopRuntime(rdId, runtime);
                get().updateRemoteDesktopSession(rdId, {
                  status: 'error',
                  errorMessage,
                  connectionStatusMessage: null,
                  lastDisconnectedAt: new Date().toISOString(),
                });
              })();
              return;
            }
            if (event.type === 'closed') {
              get().updateRemoteDesktopSession(rdId, {
                status: 'closed',
                connectionStatusMessage: null,
                lastDisconnectedAt: new Date().toISOString(),
              });
              clearConnectionView(rdId);
              void releaseRemoteDesktopRuntime(rdId, runtime);
            }
          });

          assertRuntimeCurrent();
          get().updateRemoteDesktopSession(rdId, {
            status: 'connecting',
            errorMessage: null,
            connectionStatusMessage: t('session.remoteDesktopConnecting'),
          });

          const connectOptions: RemoteDesktopConnectOptions =
            protocol === 'vnc'
              ? {
                  protocol,
                  host: endpoint.host,
                  port: endpoint.port,
                  password: secret?.password,
                  username: secret?.username,
                  viewOnly: host.viewOnly ?? false,
                  shared: host.shared ?? true,
                  imageQuality: host.imageQuality ?? undefined,
                  ...(endpoint.tunnelAuthToken
                    ? { tunnelAuthToken: endpoint.tunnelAuthToken }
                    : {}),
                }
              : {
                  protocol,
                  // TLS identity/pin always stays on the original logical host.
                  host: host.hostname,
                  port: endpoint.port,
                  ...(endpoint.host !== host.hostname ||
                  endpoint.port !== host.port
                    ? { dialAddress: endpoint.host }
                    : {}),
                  ...(endpoint.tunnelAuthToken
                    ? { tunnelAuthToken: endpoint.tunnelAuthToken }
                    : {}),
                  username: secret?.username?.trim(),
                  password: secret?.password,
                  domain: secret?.domain?.trim() || undefined,
                  audioEnabled: host.audioEnabled ?? true,
                  clipboardEnabled: host.clipboardEnabled ?? true,
                  microphoneEnabled: host.microphoneEnabled ?? false,
                  cameraEnabled: host.cameraEnabled ?? false,
                  adminSession: host.adminSession ?? false,
                  colorDepth: host.colorDepth ?? 32,
                  drives: describeRdpDrives(host.drives).map(drive => ({
                    label: drive.name,
                    path: drive.path,
                    readOnly: drive.readOnly,
                  })),
                };
          await nativeConnect(rdId, connectOptions);
          runtime.nativeStarted = true;
          if (runtime.cancelled || getRemoteDesktopHandle(rdId) !== runtime) {
            const currentRuntime = getRemoteDesktopHandle(rdId);
            // disconnect may have run while nativeConnect was still pending. If this generation
            // materialized afterwards, destroy it again. Never target a newer same-ID generation.
            if (!currentRuntime || currentRuntime === runtime) {
              await nativeDisconnect(rdId).catch(() => undefined);
            }
            await releaseRemoteDesktopRuntime(rdId, runtime);
          }
        } catch (error) {
          const wasCancelled =
            runtime.cancelled || getRemoteDesktopHandle(rdId) !== runtime;
          await releaseRemoteDesktopRuntime(rdId, runtime);
          if (wasCancelled) return;

          // **원문을 그대로 보여주지 않는다.** 코어가 올려 보내는 문장은 Go 원문이라
          // "rdtunnel: connect target: connect tcp 10.0.0.5:3389: connection was refused"
          // 처럼 나온다. SSH 경로와 같은 분류를 거쳐 사람이 읽는 문구로 바꾼다 — 분류되지
          // 않은 것만 원문으로 남는다(단서를 잃지 않으려고).
          const errorMessage =
            error instanceof Error && error.message.trim()
              ? getConnectFailureMessage(error.message, rdFailureTarget(host))
              : t('session.remoteDesktopError');
          get().updateRemoteDesktopSession(rdId, {
            status: 'error',
            errorMessage,
            connectionStatusMessage: null,
            lastDisconnectedAt: new Date().toISOString(),
          });
          const currentView = get().connectionViews[rdId];
          patchConnectionView(rdId, {
            // 분류가 계층을 알면 그것을 쓰고(문구가 tailnet 실패라고 말하는 경우),
            // 모르면 그 순간 어느 단계였는지로 떨어뜨린다.
            failureLayer:
              (error instanceof Error
                ? getConnectFailureLayer(error.message)
                : null) ??
              (currentView?.stage === 'tailnet' ? 'tailscale' : null),
            failureMessage: errorMessage,
            hostKeyPrompted: false,
            interactiveAuthPending: false,
          });
        } finally {
          pendingTailnetConnections.delete(rdId);
        }
      };

      const closeRemoteDesktopSession = async (rdId: string) => {
        get().updateRemoteDesktopSession(rdId, {
          status: 'disconnecting',
          connectionStatusMessage: t('session.remoteDesktopDisconnecting'),
        });
        const runtime = getRemoteDesktopHandle(rdId);
        if (runtime) runtime.cancelled = true;
        await cancelPendingTailnetConnection(rdId);
        if (runtime) {
          await releaseRemoteDesktopRuntime(rdId, runtime);
        } else {
          await nativeDisconnect(rdId).catch(() => undefined);
          await rejectPendingRdpCertificateForSession(rdId);
        }
        get().updateRemoteDesktopSession(rdId, {
          status: 'closed',
          connectionStatusMessage: null,
          lastDisconnectedAt: new Date().toISOString(),
        });
        clearConnectionView(rdId);
      };

      const connectSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: HostRecord,
        options?: {
          /**
           * startup command 스니펫에 변수가 있을 때 값을 물어도 되는지. 자동 재연결에서는
           * false 다 — 홈에서 돌아올 때마다 모달이 뜨면 쓸 수 없다.
           */
          promptForStartupVars?: boolean;
          /** 인증 실패 재시도 창이 방금 받아 온 자격증명. 저장된 값보다 우선한다. */
          credentialOverride?: HostSecretInput | null;
        },
      ) => {
        const promptForStartupVars = options?.promptForStartupVars ?? true;
        if (
          runtimeSessions.has(sessionRecord.id) ||
          pendingSessionConnections.has(sessionRecord.id)
        ) {
          return;
        }
        pendingSessionConnections.add(sessionRecord.id);
        // 다시 붙을 때 이전 화면을 이어서 쌓는다.
        //
        // **런타임 값이 있으면 그것을 쓴다.** 레코드의 사본은 세션이 끝나는 순간에 게시되므로
        // 그 경로를 지나지 않고 끊긴 세션에서는 낡아 있을 수 있고, 그걸로 덮으면 메모리에
        // 남아 있던 더 최신 화면을 잃는다. 콜드스타트에서는 런타임 Map 이 비어 있으므로
        // 레코드에서 시드한다(persist 는 스냅샷을 비워 저장하니 대개 빈 문자열이다).
        if (!runtimeSessionSnapshots.has(sessionRecord.id)) {
          runtimeSessionSnapshots.set(
            sessionRecord.id,
            get().sessions.find(item => item.id === sessionRecord.id)
              ?.lastViewportSnapshot ?? sessionRecord.lastViewportSnapshot,
          );
        }
        if (isAwsEc2HostRecord(host)) {
          void connectAwsSessionRecord(sessionRecord, host);
          return;
        }
        if (isSshHostRecord(host)) {
          void connectSshSessionRecord(
            sessionRecord,
            host,
            promptForStartupVars,
            options?.credentialOverride,
          );
          return;
        }
        // Explicit guard: remote desktop records are never terminal records, even
        // if a stale persisted session accidentally points at one.
        if (isRdpHostRecord(host) || isVncHostRecord(host)) {
          const engineError = guardRemoteDesktopEngine(
            host.kind as 'rdp' | 'vnc',
          );
          markSessionState(
            sessionRecord.id,
            'error',
            engineError?.message ?? t('store.hostKindUnsupported'),
          );
          pendingSessionConnections.delete(sessionRecord.id);
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
        /** false 면 startup command 스니펫 변수를 묻지 않는다(자동 재연결). */
        promptForStartupVars = true,
        /** 인증 실패 재시도 창이 방금 받아 온 자격증명. 저장된 값보다 우선한다. */
        credentialOverride?: HostSecretInput | null,
      ) => {
        let pendingConnection: EngineConnection | null = null;
        let pendingShell: EngineShell | null = null;
        let pendingBackgroundListenerId: number | null = null;
        let pendingStartupFlusher: StartupCommandFlusher | null = null;
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
              getUnsupportedAuthTypeMessage(host, 'store.authKindUnsupported'),
            );
            return;
          }

          const credentials = await resolveHostCredentials(
            host,
            credentialOverride,
          );
          if (!credentials) {
            markSessionState(
              sessionRecord.id,
              'closed',
              t('store.connectCancelled'),
            );
            return;
          }

          // 창에서 사용자명을 고쳤을 수 있다 — 고친 값으로 붙어야 한다. 이 줄이 없으면
          // 방금 고친 사람이 왜 또 실패하는지 알 수 없다(옛 사용자명으로 나간다).
          host = refreshSshHost(host);

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

          // 점프 체인이 있으면 올려야 하는 노드는 **첫 홉**의 것이다. 대상에서 읽으면
          // "tailnet 안의 베스천을 거쳐 사내 LAN 호스트로" 가 안 된다 — 판정은 shared-core 가
          // 데스크톱과 같은 규칙으로 한다.
          const tailnetResolution = resolveSyncedTailnetRoute(
            { tailnetId: resolveSshHostTailnetId(host, get().hosts) },
            get().tailnets,
          );
          if (tailnetResolution.kind === 'missing') {
            markSessionState(
              sessionRecord.id,
              'error',
              t('store.tailnetMissing'),
            );
            return;
          }
          let tailnet: { tailnetId: string; tailnetName?: string } | undefined;

          const connectionStartedAt = new Date().toISOString();
          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: 'connecting',
              errorMessage: null,
              connectionStatusMessage: null,
              lastEventAt: connectionStartedAt,
              connectionKind: 'ssh',
              connectionDetails: `${host.username}@${host.hostname}:${host.port}`,
            }),
          }));

          // tailnet 준비 **전에** 세운다. 그 뒤에 세우면 준비 중 올라온 상태가 전부 버려지고,
          // 화면은 "노드 시작 중" 에 얼어붙는다 — 어디까지 갔는지 보여 주려고 만든 화면이 정작
          // 가장 오래 걸리는 구간(사람이 브라우저에서 승인하는 구간이 여기 있다)을 못 보여 준다.
          // tailnet 준비 **전에** 세운다. 그 뒤에 세우면 준비 중 올라온 상태가 전부 버려지고,
          // 화면은 "노드 시작 중" 에 얼어붙는다 — 어디까지 갔는지 보여 주려고 만든 화면이 정작
          // 가장 오래 걸리는 구간(사람이 브라우저에서 승인하는 구간이 여기 있다)을 못 보여 준다.
          beginConnectionView(sessionRecord.id, {
            hostId: host.id,
            hasTailnet: tailnetResolution.kind === 'tailnet',
            targetAddress: host.hostname,
          });

          if (tailnetResolution.kind === 'tailnet') {
            const prepared = await prepareTailnetForConnection({
              kind: 'terminal',
              recordId: sessionRecord.id,
              hostId: host.id,
              resolution: tailnetResolution,
            });
            tailnet = {
              tailnetId: prepared.tailnetId,
              ...(prepared.tailnetName
                ? { tailnetName: prepared.tailnetName }
                : {}),
            };
          }

          const engine = getEngine();
          // Names the engine in the device log. With one engine left this reads
          // mostly as a session-start marker, but it stays because it is what
          // ties a device log back to a session id.
          console.info(
            `[mobile-ssh] engine=${engine.name} session=${sessionRecord.id}`,
          );
          // 끊김을 두 갈래로 나눈다. 전에는 한 핸들러가 두 콜백에 걸려 있어서 구분이 없었고,
          // 그래서 밖에서 끊긴 세션이 사용자가 끝낸 세션과 같은 'closed' 가 되어 탭에서 사라졌다.
          //
          //   onDisconnected — 전송이 죽었다. iOS 가 백그라운드에서 프로세스를 정지시킨 경우가
          //     이 경로다. 사용자 의도가 아니므로 탭을 남기고 자동 재연결 대상이 된다.
          //   onClosed — 셸 채널이 끝났다. 원격에서 `exit` 를 친 경우가 이 경로다. 의도된
          //     종료이므로 지금처럼 'closed' 다 — 여기서 자동 재연결하면 exit 한 셸이 되살아난다.
          const teardownRuntime = () => {
            closedDuringConnect = true;
            // 세션이 끝났으면 startup command 감시 타이머도 접는다. 안 그러면 이미 닫힌 셸에
            // 쓰기를 시도한다.
            pendingStartupFlusher?.dispose();
            pendingStartupFlusher = null;
            flushSessionSnapshot(sessionRecord.id, {
              markActivity: false,
            });
            if (runtimeSessions.has(sessionRecord.id)) {
              void disposeRuntimeSession(sessionRecord.id);
            }
          };
          const markDropped = () => {
            teardownRuntime();
            markSessionState(
              sessionRecord.id,
              'error',
              t('store.sessionDropped'),
              'dropped',
            );
          };
          const markClosed = () => {
            teardownRuntime();
            // 전송이 먼저 죽으면 채널 종료가 뒤따라 올 수 있다. 그때 'closed' 로 덮으면
            // 방금 남긴 dropped 표시가 지워지므로, 이미 dropped 면 그대로 둔다.
            const current = get().sessions.find(
              item => item.id === sessionRecord.id,
            );
            if (current?.disconnectReason === 'dropped') {
              return;
            }
            markSessionState(sessionRecord.id, 'closed');
          };

          const terminalSize = await resolvePtyTerminalGridSize();
          // 홉의 자격증명이 없으면 여기서 물어본다 — 아직 붙기 전이라 물어볼 자리가 있다.
          const jumpChain = await resolveJumpChain(host);
          const connection = await engine.connect({
            connectionId: sessionRecord.id,
            host: host.hostname,
            port: host.port,
            username: host.username,
            credential: security,
            ...(tailnet ? { tailnet } : {}),
            ...(jumpChain ? { jump: jumpChain } : {}),
            size: terminalSize,
            trustedHostKeysBase64: trustedHostKeysFor(
              host.hostname,
              host.port,
              host.tailnetId,
            ),
            onServerKey: async info =>
              resolveKnownHostTrust(host, info, sessionRecord.id),
            onInteractiveChallenge: challenge =>
              askInteractiveAuth(host, challenge, sessionRecord.id),
            // 서버가 인증 단계에 보낸 안내. 붙어 있는 동안 보여줘야 그 자리에서 끝난다 —
            // 실패한 뒤에 말해 주면 이미 끊긴 연결을 다시 시작해야 한다.
            onBanner: bannerText => {
              // 연결 진행 카드용(붙는 중에만 산다).
              patchConnectionView(sessionRecord.id, { banner: bannerText });
              // 터미널에는 직접 쓰지 않고 이 세션의 스냅샷에 합친다. 직접 쓰면 (1) 활성
              // 탭이 아닌 세션의 배너는 아무도 못 받고 (2) 다음 스냅샷 복원이 화면을
              // 지우면서 같이 지운다. 스냅샷에 넣으면 배경 탭·늦은 WebView 부팅·재접속이
              // 한 경로로 해결된다(lib/terminal-banner 주석 참고).
              const merged = appendSessionBanner(
                runtimeSessionSnapshots.get(sessionRecord.id),
                bannerText,
              );
              if (merged === null) {
                return;
              }
              runtimeSessionSnapshots.set(
                sessionRecord.id,
                trimSnapshot(merged),
              );
              // 배너는 지금 사용자가 행동해야 하는 안내일 수 있다(Tailscale 추가 인증 등).
              // 디바운스를 기다리지 않고 바로 반영한다.
              flushSessionSnapshot(sessionRecord.id);
            },
            onHopProgress: hop =>
              patchConnectionView(sessionRecord.id, { hop }),
            onDisconnected: markDropped,
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

          // 호스트에 startup command 가 설정돼 있으면 프롬프트가 뜬 뒤에 타이핑한다. 판단은
          // startup-command.ts 가 하고 여기서는 출력을 넘겨 주기만 한다.
          //
          // flusher 를 나중에 만들 수 있게 let 으로 둔다 — 스니펫 변수를 물어야 하면 값이
          // 들어온 뒤에야 보낼 명령이 정해진다. 그 사이 도착한 출력은 아래 onChunk 가
          // startupFlusher 를 매번 다시 읽으므로 그냥 흘려보내면 된다. 감시가 늦게 시작해도
          // createStartupCommandFlusher 의 최대 대기 타이머가 전송을 보장한다.
          let startupFlusher: StartupCommandFlusher | null = null;
          const beginStartupCommand = (command: string) => {
            startupFlusher = createStartupCommandFlusher(() => {
              void shell
                .sendData(Uint8Array.from(Buffer.from(`${command}\r`, 'utf8')))
                .catch(() => undefined);
            });
            pendingStartupFlusher = startupFlusher;
          };

          const startupPlan = resolveStartupCommand(host, get().snippets);
          if (startupPlan.kind === 'command') {
            beginStartupCommand(startupPlan.command);
          } else if (startupPlan.kind === 'variables') {
            const cached = startupVarsBySession.get(sessionRecord.id);
            if (cached) {
              // 자동 재연결(및 이전 값이 있는 재접속)은 묻지 않는다.
              beginStartupCommand(
                resolveSnippetCommand(startupPlan.command, cached),
              );
            } else if (promptForStartupVars) {
              // 사용자가 직접 시작한 접속에서만 묻는다. 값을 받는 동안에도 셸 출력은 계속
              // 흘러간다 — 모달이 접속을 막지는 않는다.
              void (async () => {
                const values = await new Promise<Record<string, string> | null>(
                  resolve => {
                    pendingStartupCommandResolver = resolve;
                    set({
                      pendingStartupCommandPrompt: {
                        sessionId: sessionRecord.id,
                        hostLabel: host.label,
                        snippetId: startupPlan.snippetId,
                        command: startupPlan.command,
                        variables: startupPlan.variables,
                      },
                    });
                  },
                );
                // 취소하면 startup command 없이 그대로 쓴다.
                if (!values || closedDuringConnect) {
                  return;
                }
                startupVarsBySession.set(sessionRecord.id, values);
                beginStartupCommand(
                  resolveSnippetCommand(startupPlan.command, values),
                );
              })();
            }
          }
          // kind 가 'missingSnippet'·'none' 이면 아무것도 보내지 않는다. 스니펫이 사라진 것은
          // 접속을 막을 일이 아니고, 폼에서 경고로 알린다.

          const backgroundListenerId = await shell.follow(
            {
              onChunk: chunk => {
                const text = Buffer.from(chunk.bytes).toString('utf8');
                startupFlusher?.noteOutput(text);
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
          // 연결에 성공했으니 방금 쓴 자격증명을 저장한다(데스크톱과 같은 시점).
          commitConnectionSecrets(host);
          pendingConnection = null;
          pendingShell = null;
          pendingBackgroundListenerId = null;

          set(state => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: 'connected',
              errorMessage: null,
              connectionStatusMessage: null,
              lastEventAt: new Date().toISOString(),
              lastConnectedAt: new Date().toISOString(),
              title: host.label,
              connectionKind: 'ssh',
              connectionDetails: `${host.username}@${host.hostname}:${host.port}`,
            }),
          }));
          clearConnectionView(sessionRecord.id);
        } catch (error) {
          await disposeRuntimeSession(sessionRecord.id);
          if (
            !closedDuringConnect &&
            !(error instanceof TailnetPreparationCancelledError)
          ) {
            // 코어가 올려 보내는 Go 원문("context deadline exceeded" 등)을 그대로 띄우지
            // 않는다 — 데스크톱과 같은 분류를 써서 사람이 읽는 문구로 바꾼다. 분류되지
            // 않은 오류는 원문을 남긴다(유일한 단서다).
            const message =
              error instanceof Error
                ? getConnectFailureMessage(
                    error.message,
                    `${host.username}@${host.hostname}:${host.port}`,
                  )
                : t('store.sshConnectFailed');
            markSessionState(sessionRecord.id, 'error', message);
            offerCredentialRetry(
              host,
              error,
              { kind: 'terminal', recordId: sessionRecord.id },
              message,
            );
            // 뷰는 지우지 않는다. 실패한 단계가 남아 있어야 사용자가 어디서 막혔는지 읽는다 —
            // 지우면 "실패했습니다" 한 줄만 남고 tailnet 인지 SSH 인지 알 수 없다.
            patchConnectionView(sessionRecord.id, {
              failureLayer:
                error instanceof Error
                  ? getConnectFailureLayer(error.message)
                  : null,
              failureMessage: message,
              hostKeyPrompted: false,
              interactiveAuthPending: false,
            });
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
                  dataFloorServerSupport: toServerSupport(
                    serverInfo.capabilities.sync.dataFloor,
                  ),
                },
              }));
            } catch {}
          }

          // **서버 프록시를 켠 호스트만 서버 능력에 묶인다.** 직접 붙는 호스트는 서버가
          // SSM 을 못 해도 상관없다 — 기기가 직접 AWS 를 부른다.
          if (
            usesAwsServerProxy(host) &&
            awsSsmServerSupport === 'unsupported'
          ) {
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

          // **서버 프록시를 끈 호스트는 기기에서 직접 붙는다.**
          //
          // 자격증명이 기기를 떠나지 않고, SSH over SSM 이 되면 실제 계정으로 들어간다.
          // 서버로 되돌아가는 폴백은 두지 않는다 — 접속 경로는 호스트 설정이 정하고, 실패는
          // 실패로 보여야 한다(조용히 다른 경로로 붙으면 왜 계정이 다른지 알 수 없다).
          if (!usesAwsServerProxy(host)) {
            // **어느 경로로 붙었는지는 로그로만 알 수 있다.** 두 경로 모두 결과가 "붙었다" 라서
            // 화면만 보면 구분되지 않는다(SSH 경로의 [mobile-ssh] 로그와 같은 이유로 남긴다).
            console.info(
              `[mobile-aws] path=direct host=${host.id} instance=${host.awsInstanceId}`,
            );
            try {
              await connectAwsEc2Directly({
                host,
                sessionRecordId: sessionRecord.id,
                resolved: resolvedSession,
                terminalSize,
                markClosed: () => {
                  void disposeRuntimeSession(sessionRecord.id);
                  markSessionState(sessionRecord.id, 'closed');
                },
                markDropped: () => {
                  void disposeRuntimeSession(sessionRecord.id);
                  markSessionState(
                    sessionRecord.id,
                    'error',
                    t('store.sessionDropped'),
                    'dropped',
                  );
                },
              });
            } catch (error) {
              await disposeRuntimeSession(sessionRecord.id);
              // 데스크톱과 같은 분류를 지난다 — 코어·SDK 원문("undefined is not a function",
              // Go 의 "context deadline exceeded" 등)을 그대로 띄우면 사용자가 할 수 있는 것이
              // 없다. 분류되지 않은 것은 원문을 남긴다(유일한 단서다).
              markSessionState(
                sessionRecord.id,
                'error',
                describeAwsConnectFailure(
                  error,
                  host.awsInstanceName?.trim() || host.awsInstanceId,
                ),
              );
            } finally {
              pendingSessionConnections.delete(sessionRecord.id);
            }
            return;
          }

          console.info(
            `[mobile-aws] path=server-proxy host=${host.id} instance=${host.awsInstanceId}`,
          );
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
                  connectionStatusMessage: t('store.ssmPathServerProxy'),
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
              ? getConnectFailureMessage(
                  error.message,
                  host.awsInstanceName?.trim() || host.awsInstanceId,
                )
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

          let currentSession = activeSession;
          try {
            // **당기기 전에 큐부터 민다.** 순서를 여기서 보장한다 — pull 을 부르는 곳이
            // 여럿이라(30초 폴링·포그라운드 복귀·수동·로그인) 호출부마다 지키게 했더니
            // 폴링이 빠졌고, 앱을 켜 둔 채 네트워크가 돌아오면 큐가 영영 안 밀렸다.
            //
            // 밀지 못해도 **막지 않는다.** 볼트가 잠겨 있으면 밀기는 잠금을 풀기 전까지
            // 절대 성공하지 않는데, 그때 당기기까지 멈추면 동기화가 통째로 죽는다.
            // 안 올라간 변경은 아래에서 다시 얹어 지켜 준다.
            // 당기기 전에 큐부터 민다. 다만 **막지는 않는다** — 밀지 못하는 이유가 볼트가
            // 아직 확정되지 않아서일 수 있고(그 확정을 pull 이 한다), 그때 pull 까지 멈추면
            // 서로를 기다리다 동기화가 영영 죽는다. 못 민 변경은 아래에서 다시 얹어 지킨다.
            await drainSyncOutbox();

            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                status: 'syncing',
                errorMessage: null,
              },
            }));

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
              dataFloorServerSupport: serverInfo
                ? toServerSupport(serverInfo.capabilities.sync.dataFloor)
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
              const currentState = get();
              if (currentState.secureStateReady) {
                if (isStaleSync()) {
                  return;
                }
                await configureSyncedTailnets({
                  serverUrl: currentState.settings.serverUrl,
                  userId: currentSession.user.id,
                  tailnets: currentState.tailnets,
                }).catch(error => {
                  console.warn('Failed to restore synced Tailnets.', error);
                });
              }
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
            let nextTailnets: TailnetPayload[];
            let nextSnippets: SnippetRecord[];
            let nextKnownHosts: KnownHostRecord[];
            let nextSecretsByRef: Record<string, LoadedManagedSecretPayload>;
            try {
              nextHosts = sortHosts(
                decodeSupportedHosts(payload, vaultKeyBase64),
              );
              nextGroups = sortGroups(decodeGroups(payload, vaultKeyBase64));
              nextAwsProfiles = decodeAwsProfiles(payload, vaultKeyBase64);
              nextTailnets = decodeTailnets(payload, vaultKeyBase64);
              nextSnippets = decodeSnippets(payload, vaultKeyBase64);
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
                // DEK 가 아니라 이 응답 자체다. 재잠금해 봐야 같은 DEK 를 다시 받을
                // 뿐이므로(무한 재입력 루프) 오류로 표시한다.
                //
                // 복호화 실패와 그 외를 구분해서 말한다. 응답 모양이 안 맞아 던진 것까지
                // "손상"이라고 하면 사용자는 복구 불가능한 문제로 오해하고, 원인 추적도
                // 암호 쪽으로 헛돈다(실제로 그랬다) — 그쪽은 앱을 올리면 풀린다.
                set({
                  vault: reconciled,
                  secureStateReady: true,
                  auth: reconciledAuth,
                  syncStatus: {
                    ...readySyncStatus,
                    status: 'error',
                    errorMessage: isSyncRecordDecryptError(decodeError)
                      ? t('store.syncDecryptFailed')
                      : t('store.syncPayloadUnreadable'),
                  },
                });
                // 이 상태에서도 폴링은 계속 돌아야 한다. 서버가 고쳐졌는데 앱이 다시 물어보지
                // 않으면 그 실행 내내 오류 화면에 갇힌다 — 타이머도 포그라운드 복귀 리스너도
                // 여기서만 만들어지므로, 안 부르면 앱을 죽였다 켜기 전까지 재시도가 없다.
                ensureSyncPollingLifecycle();
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
                  errorMessage: t('store.vaultResetElsewhere'),
                },
              });
              // 잠금해제 뒤 스스로 이어받게 폴링은 살려 둔다(잠긴 동안의 pull 은 게이트에서
              // 조용히 끝난다).
              ensureSyncPollingLifecycle();
              return;
            }
            if (isStaleSync()) {
              // 복호화는 성공했지만 그 사이 볼트 세대가 바뀌었다(잠금해제/설정/초기화)
              // — 이 결과는 이전 세대의 것이므로 적용하지 않는다. ETag 도 저장하지
              // 않아 새 세대의 첫 pull 이 304 로 가려지지 않는다.
              return;
            }

            // **비밀 복원이 끝나기 전에는 이 스냅샷을 손대지 않는다.**
            //
            // 아래 경로들은 전부 로컬 상태를 읽거나 쓴다 — 빈 서버 복구는 로컬을 통째로
            // 재업로드하고, 적용은 로컬과 병합한다. 그 시점 secretsByRef 가 비어 있으면
            // **호스트만 올라가고 비밀번호는 빠진 채** 리비전이 올라가고, 게다가 여기서
            // `secureStateReady: true` 가 켜져 밀기 가드까지 무력화된다. 실제로 그렇게 잃었다.
            if (!get().secureStateReady && secureStateRestorePromise) {
              await secureStateRestorePromise.catch(() => undefined);
            }
            if (!get().secureStateReady) {
              // 복원이 실패했다. 이 회차는 통째로 건너뛴다 — ensureSecureStateRestored 가
              // 포그라운드 복귀에서 다시 시도하고, 그때 이 회차가 다시 돈다.
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
              localState.tailnets.length > 0 ||
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
                    tailnets: localState.tailnets,
                  },
                  vaultKeyBase64,
                ),
                vaultState.status === 'unlocked' ? vaultState.epoch : null,
                resolveMobileSyncDataFloor(get().hosts),
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

            if (isStaleSync()) {
              return;
            }
            // 원격 스냅샷은 **한 입구로만** 적용한다. 종류마다 따로 덮어쓰면 아직 못 올린
            // 로컬 변경이 조용히 사라질 수 있고, 실제로 secrets 에서 그렇게 잃었다.
            // 규칙은 레코드마다 더 최신인 쪽 — 못 올린 변경은 정의상 최신이라 살아남는다.
            const localBeforeApply = get();
            const mergedState = mergeSyncedState({
              hosts: {
                local: localBeforeApply.hosts,
                remote: {
                  live: nextHosts,
                  tombstones: decodeSyncTombstones(payload.hosts),
                },
              },
              groups: {
                local: localBeforeApply.groups,
                remote: {
                  live: nextGroups,
                  tombstones: decodeSyncTombstones(payload.groups),
                },
              },
              knownHosts: {
                local: localBeforeApply.knownHosts,
                remote: {
                  live: nextKnownHosts,
                  tombstones: decodeSyncTombstones(payload.knownHosts),
                },
              },
              secrets: {
                local: Object.values(localBeforeApply.secretsByRef),
                remote: {
                  live: Object.values(nextSecretsByRef),
                  tombstones: decodeSyncTombstones(payload.secrets),
                },
              },
            });
            const mergedHosts = sortHosts(mergedState.hosts);
            const mergedGroups = sortGroups(mergedState.groups);
            const mergedKnownHosts = mergedState.knownHosts;
            const mergedSecretsByRef = Object.fromEntries(
              mergedState.secrets.map(record => [record.secretRef, record]),
            );
            // 서버에 없고 삭제된 적도 없는 로컬 레코드는 아직 안 올라간 것이다. 큐에 다시
            // 넣어 스스로 회복하게 한다 — 큐 항목이 어쩌다 사라져도(로컬 저장 직후 앱이
            // 죽는 등) 올라가지도 지워지지도 않는 유령 레코드가 남지 않는다.
            // 이미 큐에 있으면 enqueue 가 합치므로 중복되지 않는다.
            if (mergedState.unpushed.length > 0) {
              // **큐에 넣기만 한다.** 여기서 밀면 그 밀기가 아직 반영 전인 로컬을 읽는다 —
              // 큐에 남아 있던 다른 항목까지 함께 나가면서, 서버에 더 최신 값이 있는
              // 레코드를 옛 값으로 되돌린다(서버 upsert 는 타임스탬프를 비교하지 않는다).
              // 다음 회차가 밀면 그때는 병합된 로컬을 읽는다.
              set(state => {
                const next = enqueueManySyncOutbox(
                  state.syncOutbox,
                  mergedState.unpushed.map(entry => ({
                    kind: entry.kind,
                    id: entry.id,
                    op: 'upsert' as const,
                  })),
                );
                return {
                  syncOutbox: next,
                  syncStatus: {
                    ...state.syncStatus,
                    pendingPush: next.length > 0,
                  },
                };
              });
            }

            await updateSecretsState(mergedSecretsByRef, mergedHosts);

            if (isStaleSync()) {
              return;
            }
            await saveStoredAwsProfiles(nextAwsProfiles);
            if (isStaleSync()) {
              return;
            }
            await saveStoredTailnets(nextTailnets);
            if (isStaleSync()) {
              return;
            }
            await configureSyncedTailnets({
              serverUrl: get().settings.serverUrl,
              userId: currentSession.user.id,
              tailnets: nextTailnets,
            }).catch(error => {
              console.warn('Failed to configure synced Tailnets.', error);
            });
            if (isStaleSync()) {
              return;
            }
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
              groups: mergedGroups,
              hosts: mergedHosts,
              awsProfiles: nextAwsProfiles,
              tailnets: nextTailnets,
              snippets: nextSnippets,
              knownHosts: sortKnownHosts(mergedKnownHosts),
              secureStateReady: true,
              auth: authenticatedAuth,
              syncStatus: readySyncStatus,
            });
            // Keychain과 runtime 구성까지 적용된 뒤에만 revision을 저장한다. 중간 저장이
            // 실패했는데 304로 가려지면 해당 보안 설정을 다시 받을 기회가 사라진다.
            if (snapshotEtag) {
              lastSyncRevision = snapshotEtag;
            }
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
          throw new Error(t('store.vaultCancelledAccountChanged'));
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
            throw new Error(t('store.sessionExpiredRetry'));
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
        await Promise.allSettled([
          clearStoredAuthSession(),
          clearStoredSecrets(),
          clearStoredAwsProfiles(),
          clearStoredAwsSsoTokens(),
          clearStoredTailnets(),
          clearStoredVaultDek(),
          closeSyncedTailnets(),
        ]);
        set({
          auth: createUnauthenticatedState(),
          vault: { status: 'none' },
          vaultMigrationDeferred: false,
          groups: [],
          hosts: [],
          awsProfiles: [],
          tailnets: [],
          snippets: [],
          knownHosts: [],
          secretMetadata: [],
          secretsByRef: {},
          sessions: [],
          sftpSessions: [],
          sftpEditor: null,
          sftpTransfers: [],
          sftpCopyBuffer: null,
          remoteDesktopSessions: [],
          remoteDesktopImmersive: false,
          activeSessionTabId: null,
          activeConnectionTab: null,
          syncStatus: createDefaultSyncStatus(),
          // 큐도 계정과 함께 비운다. 남겨 두면 다음에 **다른 계정**으로 로그인했을 때
          // 그 계정으로 밀려 나간다 — 삭제 항목은 로컬 레코드 없이도 스스로 밀린다.
          syncOutbox: [],
          pendingBrowserLoginState: null,
          pendingAwsSsoLogin: null,
          pendingServerKeyPrompt: null,
          pendingRdpCertificatePrompt: null,
          pendingCredentialPrompt: null,
          pendingCredentialRetry: null,
          syncOutboxFailure: null,
          pendingInteractiveAuthPrompt: null,
          pendingStartupCommandPrompt: null,
          connectionViews: {},
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
          // **살아 있는 셸에도 알린다.** 이것이 없으면 원격 PTY 는 접속 순간의 크기에 갇힌다 —
          // xterm 은 화면에 맞춰 다시 fit 하지만 서버는 모르므로, 화면을 채우는 프로그램(htop·
          // vim·less)이 옛 행/열로 그려서 6.9" 화면의 절반이 비어 있었다. 화면을 돌리거나
          // 키보드를 여닫아 크기가 달라진 뒤에도 같은 문제가 남는다.
          //
          // 세션마다 카드 크기가 같으므로 살아 있는 SSH 셸 전부에 같은 크기를 보낸다(AWS SSM
          // 세션은 셸 채널이 아니라 WebSocket 이라 여기서 다루지 않는다).
          for (const runtime of runtimeSessions.values()) {
            if (runtime.kind !== 'ssh') {
              continue;
            }
            // 이미 닫힌 셸에 쓰면 거부된다 — 크기 알림이 실패해도 세션은 그대로 쓴다.
            void runtime.shell.resize(size).catch(() => undefined);
          }
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
        syncOutbox: [],
        hosts: [],
        awsProfiles: [],
        tailnets: [],
        snippets: [],
        knownHosts: [],
        secretMetadata: [],
        sessions: [],
        sftpSessions: [],
        sftpEditor: null,
        sftpTransfers: [],
        sftpCopyBuffer: null,
        // Remote desktop slice (spread into the single store)
        // Zustand's set/get for the full store is structurally compatible with the
        // slice's narrower view (contravariant set, covariant get) — no unsafe cast.
        ...createRemoteDesktopSlice(
          set as (
            partial:
              | Partial<RemoteDesktopSliceState>
              | ((
                  state: RemoteDesktopSliceState,
                ) => Partial<RemoteDesktopSliceState>),
          ) => void,
          get as () => RemoteDesktopSliceState,
        ),
        activeSessionTabId: null,
        activeConnectionTab: null,
        secretsByRef: {},
        pendingBrowserLoginState: null,
        pendingAwsSsoLogin: null,
        pendingServerKeyPrompt: null,
        pendingRdpCertificatePrompt: null,
        pendingCredentialPrompt: null,
        pendingCredentialRetry: null,
        syncOutboxFailure: null,
        pendingInteractiveAuthPrompt: null,
        pendingStartupCommandPrompt: null,
        connectionViews: {},
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
              secureStateRestorePromise = restoreStoredSecureStateInBackground(
                currentServerUrl,
                currentRestoreVersion,
              );
              void secureStateRestorePromise;
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
            throw new Error(t('store.deleteAccountOnlineOnly'));
          }

          // access 토큰 만료(401/403) 시 refresh 후 1회 재시도는 공통 래퍼가 처리한다.
          const tailnetsToForget = get().tailnets;
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

          // Account deletion is the one local lifecycle that also removes
          // control-plane nodes and persisted identities. Logout and server
          // switching deliberately preserve them for cheap reuse.
          await forgetSyncedTailnets(tailnetsToForget).catch(error => {
            console.warn('Failed to forget account Tailnets.', error);
          });

          await resetToSignedOutState();
        },
        changeAccountPassword: async (
          currentPassword: string,
          newPassword: string,
        ) => {
          const auth = get().auth;
          const session = auth.session;
          if (auth.status !== 'authenticated' || !session) {
            throw new Error(t('store.passwordOnlineOnly'));
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
            throw new Error(t('store.cancelledAccountOrServerChanged'));
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
                errorMessage: t('store.vaultKeyStoreFailed'),
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
            local.tailnets.length > 0 ||
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
                        tailnets: local.tailnets,
                      },
                      dekBase64,
                    ),
                    epoch,
                    resolveMobileSyncDataFloor(get().hosts),
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
            throw new Error(t('store.vaultKeyVerifyFailed'));
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
                errorMessage: t('store.vaultKeyStoreFailed'),
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
              throw new Error(t('store.vaultSetElsewhere'));
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
                errorMessage: t('store.vaultKeyStoreFailed'),
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
              : (get().auth.session?.vaultBootstrap.epoch ?? 0);
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
            throw new Error(t('store.vaultCacheMismatch'));
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
                errorMessage: t('store.vaultKeyStoreFailed'),
              },
            }));
          });
          assertVaultOperationContext(operationContext);
          // 새 wrapped/kdf 를 저장 세션 descriptor 에도 즉시 반영 — 재시작 시 잠금
          // 화면이 옛 wrapped(옛 암호) 기준으로 뜨지 않게 한다.
          await persistSynthesizedVaultDescriptor();
          assertVaultOperationContext(operationContext);
        },
        flushSyncOutbox: async () => {
          await drainSyncOutbox();
        },
        ensureSecureStateRestored: () => {
          const state = get();
          if (state.secureStateReady || !state.auth.session) {
            return;
          }
          const nextVersion = secureStateRestoreVersion + 1;
          secureStateRestoreVersion = nextVersion;
          secureStateRestorePromise = restoreStoredSecureStateInBackground(
            state.settings.serverUrl,
            nextVersion,
          );
          void secureStateRestorePromise;
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
            await Promise.allSettled([
              clearStoredAuthSession(),
              clearStoredSecrets(),
              clearStoredAwsProfiles(),
              clearStoredAwsSsoTokens(),
              clearStoredTailnets(),
              clearStoredVaultDek(),
              closeSyncedTailnets(),
            ]);
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
              tailnets: [],
              snippets: [],
              knownHosts: [],
              secretMetadata: [],
              secretsByRef: {},
              sessions: [],
              sftpSessions: [],
              sftpEditor: null,
              sftpTransfers: [],
              sftpCopyBuffer: null,
              activeSessionTabId: null,
              activeConnectionTab: null,
              syncStatus: createDefaultSyncStatus(),
              // 큐도 서버와 함께 비운다. 남겨 두면 옛 서버의 변경이 **새 서버**로 밀려
              // 나간다 — 삭제 항목은 로컬 레코드 없이도 스스로 밀린다.
              syncOutbox: [],
              syncOutboxFailure: null,
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
          if (
            input.startupCommand?.type === 'command' &&
            input.startupCommand.command.length >
              MAX_HOST_STARTUP_COMMAND_LENGTH
          ) {
            throw new Error(t('store.startupCommandTooLong'));
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
          const certificateText =
            input.credentials?.certificateText?.trim() || undefined;
          // 인증서 인증은 개인 키와 인증서가 한 쌍으로 있어야 성립한다 — 한쪽만으로
          // 시크릿을 만들면 연결 시점에 자격 증명이 없는 것과 같다.
          const hasReplacementCredential =
            input.authType === 'certificate'
              ? Boolean(privateKeyPem && certificateText)
              : Boolean(password || privateKeyPem);
          const credentialMode =
            input.credentialMode ??
            (existingSsh?.secretRef ? 'preserve' : 'replace');
          if (
            credentialMode === 'preserve' &&
            (!existingSsh?.secretRef || existingSsh.authType !== input.authType)
          ) {
            throw new Error(t('store.authChangeNeedsCredential'));
          }
          if (
            existingSsh?.secretRef &&
            credentialMode === 'replace' &&
            !hasReplacementCredential
          ) {
            throw new Error(t('store.replaceOrUnlink'));
          }
          // 자격증명을 **적다 만 것**은 거절한다. 인증서 방식인데 개인키만 있으면 연결이
          // 반드시 실패하는 호스트가 하나 생길 뿐이다. 아무것도 안 준 경우(접속할 때 묻는다)
          // 와 구분해야 하므로 "뭔가는 줬는데 모자란" 때만 막는다.
          if (
            credentialMode === 'replace' &&
            !hasReplacementCredential &&
            (password || privateKeyPem || certificateText)
          ) {
            throw new Error(t('store.replaceOrUnlink'));
          }
          const secretRef =
            credentialMode === 'preserve'
              ? existingSsh?.secretRef
              : credentialMode === 'replace' && hasReplacementCredential
                ? (existingSsh?.secretRef ?? createLocalId('secret'))
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
            // 조건부 스프레드여야 한다. `startupCommand: input.startupCommand` 로 두면
            // 생략했을 때 값이 undefined 로 덮이고, 직렬화에서 키가 통째로 빠져 데스크톱에서
            // 넣은 값이 지워진다. 위 `...(existingSsh ?? {})` 가 보존하는 것을 되돌리는 셈이다.
            ...(input.startupCommand !== undefined
              ? { startupCommand: input.startupCommand }
              : {}),
            // 같은 이유로 전부 조건부 스프레드다 — 생략은 보존이어야 한다.
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.agentForwarding !== undefined
              ? { agentForwarding: input.agentForwarding }
              : {}),
            ...(input.useMosh !== undefined ? { useMosh: input.useMosh } : {}),
            ...(input.jumpHostIds !== undefined
              ? {
                  jumpHostIds: input.jumpHostIds,
                  // **레거시 미러도 함께 쓴다.** 읽는 쪽(normalizeJumpHostIds)은 배열이 비면
                  // 이 값으로 폴백하므로, 배열만 비우면 방금 지운 홉을 계속 경유하고 폼을
                  // 다시 열면 칩이 되살아난다. 데스크톱 쓰기 경로와 같은 규칙이다
                  // (state-storage.ts / database.ts 의 `jumpHostId: jumpHostIds[0] ?? null`).
                  jumpHostId: input.jumpHostIds?.[0] ?? null,
                }
              : {}),
            ...(input.tailnetId !== undefined
              ? { tailnetId: input.tailnetId }
              : {}),
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
                    : input.authType === 'certificate'
                      ? { privateKeyPem, passphrase, certificateText }
                      : { privateKeyPem, passphrase }),
                  updatedAt: now,
                }
              : null;

          // **로컬 먼저.** 오프라인이어도 호스트가 저장되고, 큐가 다음 기회에 서버로 나른다.
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

          enqueueAndDrain([
            { kind: 'hosts', id: record.id, op: 'upsert' },
            ...(nextSecret
              ? [
                  {
                    kind: 'secrets' as const,
                    id: nextSecret.secretRef,
                    op: 'upsert' as const,
                  },
                ]
              : []),
          ]);
        },
        saveRemoteDesktopHost: async (
          input: MobileRemoteDesktopDraftInput,
        ) => {
          if (!get().secureStateReady) {
            throw new Error(getSecureStateLoadingMessage());
          }
          const existing = input.hostId
            ? get().hosts.find(item => item.id === input.hostId)
            : undefined;
          if (input.hostId && !existing) {
            throw new Error(t('store.hostToEditNotFound'));
          }
          // 종류를 바꾸는 편집은 없다. 섞이면 화면이 다루지 못하는 레코드가 생긴다.
          if (existing && existing.kind !== input.kind) {
            throw new Error(t('store.hostToEditNotFound'));
          }
          // **만드는 것은 서버가 데이터 수준을 판정할 때만 허용한다.** 화면도 같은 규칙으로
          // 칸을 막지만(resolveCreatableHostFormKinds) 그것은 UI 뿐이라, 라우트 파라미터로
          // 들어오거나 폼을 열어 둔 사이 서버 판정이 떨어지면 그대로 저장된다. 이 레코드는
          // 같은 계정의 옛 클라이언트가 받아 조용히 망가지므로 저장 자리에서 한 번 더 본다.
          // 고치는 것은 막지 않는다 — 다른 기기에서 만들어 동기화된 호스트를 손볼 길이 없어진다.
          if (
            !existing &&
            !LEGACY_TOLERATED_HOST_KINDS.has(input.kind) &&
            get().syncStatus.dataFloorServerSupport !== 'supported'
          ) {
            throw new Error(t('store.hostKindNeedsDataFloor'));
          }
          const previous =
            existing && (isRdpHostRecord(existing) || isVncHostRecord(existing))
              ? existing
              : undefined;

          const password = input.credentials?.password?.length
            ? input.credentials.password
            : undefined;
          const username = input.credentials?.username?.trim() || undefined;
          const domain = input.credentials?.domain?.trim() || undefined;
          const credentialMode =
            input.credentialMode ?? (previous?.secretRef ? 'preserve' : 'replace');
          const previousSecret = previous?.secretRef
            ? get().secretsByRef[previous.secretRef]
            : undefined;
          // RDP 는 계정이 자격증명에 딸린다 — 저장된 것이 없으면 비밀번호 없이는 만들 것이
          // 없다. 반대로 이미 있으면 계정만 바꾸는 것도 교체다(비밀번호는 아래에서 잇는다).
          const hasReplacement = Boolean(
            password || (previousSecret && (username || domain)),
          );
          // **연결을 끊는 것은 'remove' 뿐이다.** 계정만 바꾸는 것도 교체로 받게 되면서
          // 값이 하나도 안 실린 replace 가 들어올 수 있게 됐는데(계정을 비우고 저장), 그때
          // undefined 로 떨어뜨리면 자격증명이 통째로 떼어진다 — 지우려던 것은 계정이었다.
          const secretRef =
            credentialMode === 'remove'
              ? undefined
              : credentialMode === 'replace' && hasReplacement
                ? (previous?.secretRef ?? createLocalId('secret'))
                : previous?.secretRef;

          const now = new Date().toISOString();
          const base = {
            ...(previous ?? {}),
            id: previous?.id ?? createLocalId('host'),
            label: input.label.trim(),
            hostname: input.hostname.trim(),
            port: input.port,
            secretRef: secretRef ?? null,
            groupName: input.groupName?.trim() ? input.groupName.trim() : null,
            // 생략은 보존이다(SSH 와 같은 규약).
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.tailnetId !== undefined
              ? { tailnetId: input.tailnetId }
              : {}),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };
          const record: HostRecord =
            input.kind === 'vnc'
              ? ({
                  ...base,
                  kind: 'vnc',
                  // **기본값인 쪽은 null 로 쓴다.** shared 는 없으면 공유, viewOnly 는 없으면
                  // 꺼짐, imageQuality 는 없으면 무손실이다(VncHostRecord 주석). 기본값을
                  // 명시값으로 굳혀 두면 나중에 기본을 바꿀 여지가 사라지고, 데스크톱이
                  // 디스크에 쓰는 정규형과도 달라진다(state-storage.ts:1021-1035).
                  ...(input.shared !== undefined
                    ? { shared: input.shared === false ? false : null }
                    : {}),
                  ...(input.viewOnly !== undefined
                    ? { viewOnly: input.viewOnly === true ? true : null }
                    : {}),
                  ...(input.imageQuality !== undefined
                    ? {
                        imageQuality:
                          input.imageQuality === 'balanced' ||
                          input.imageQuality === 'fast'
                            ? input.imageQuality
                            : null,
                      }
                    : {}),
                  ...(input.sshTunnelHostId !== undefined
                    ? { sshTunnelHostId: input.sshTunnelHostId }
                    : {}),
                } as HostRecord)
              : ({ ...base, kind: 'rdp' } as HostRecord);

          // **저장된 시크릿을 잇는다.** 처음부터 다시 만들면 이번에 넘어오지 않은 항목이
          // 지워진다 — 비밀번호만 바꿨는데 계정이 사라지면 RDP 는 계정이 시크릿에만 있어
          // 다음 접속이 막힌다(연결 경로가 username 을 필수로 본다).
          const mergedUsername = username ?? previousSecret?.username;
          const mergedDomain = domain ?? previousSecret?.domain;
          const mergedPassword = password ?? previousSecret?.password;
          const nextSecret: LoadedManagedSecretPayload | null =
            credentialMode === 'replace' && secretRef && hasReplacement
              ? {
                  secretRef,
                  label:
                    get().secretsByRef[secretRef]?.label ??
                    `${record.label} credentials`,
                  kind: input.kind,
                  ...(mergedUsername ? { username: mergedUsername } : {}),
                  ...(mergedDomain ? { domain: mergedDomain } : {}),
                  ...(mergedPassword ? { password: mergedPassword } : {}),
                  updatedAt: now,
                }
              : null;

          // **로컬 먼저.** 오프라인이어도 저장되고 큐가 다음 기회에 나른다(SSH 와 같다).
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

          enqueueAndDrain([
            { kind: 'hosts', id: record.id, op: 'upsert' },
            ...(nextSecret
              ? [
                  {
                    kind: 'secrets' as const,
                    id: nextSecret.secretRef,
                    op: 'upsert' as const,
                  },
                ]
              : []),
          ]);
        },
        // 즐겨찾기 토글 — 데스크톱과 같은 host.favorite 필드를 뒤집는다. saveHost 와 같은
        // 경로(로컬 먼저 → 아웃박스)를 쓴다. 시크릿은 건드리지 않으므로 호스트만 큐에 넣는다.
        toggleHostFavorite: async (hostId: string) => {
          const host = get().hosts.find(item => item.id === hostId);
          if (!host) {
            throw new Error(t('store.hostToEditNotFound'));
          }
          const record: HostRecord = {
            ...host,
            favorite: host.favorite === true ? false : true,
            updatedAt: new Date().toISOString(),
          };

          // 즐겨찾기는 목록에서 곧바로 반응해야 한다. 로컬을 먼저 바꾸고 큐에 넣는다.
          const nextHosts = sortHosts([
            ...get().hosts.filter(item => item.id !== hostId),
            record,
          ]);
          set({
            hosts: nextHosts,
            secretMetadata: deriveSecretMetadata(nextHosts, get().secretsByRef),
          });
          enqueueAndDrain([{ kind: 'hosts', id: hostId, op: 'upsert' }]);
        },
        setAwsSsmServerProxyEnabled: async (
          hostId: string,
          enabled: boolean,
        ) => {
          const host = get().hosts.find(item => item.id === hostId);
          if (!host || host.kind !== 'aws-ec2') {
            throw new Error(t('store.hostToEditNotFound'));
          }
          const record: HostRecord = {
            ...host,
            awsSsmServerProxyEnabled: enabled ? true : undefined,
            updatedAt: new Date().toISOString(),
          };

          const nextHosts = sortHosts([
            ...get().hosts.filter(item => item.id !== hostId),
            record,
          ]);
          set({
            hosts: nextHosts,
            secretMetadata: deriveSecretMetadata(nextHosts, get().secretsByRef),
          });
          enqueueAndDrain([{ kind: 'hosts', id: hostId, op: 'upsert' }]);
        },
        deleteHost: async (hostId: string) => {
          const host = get().hosts.find(item => item.id === hostId);
          if (!host) {
            return;
          }

          // **로컬 먼저.** 오프라인이어도 지워지고, 큐가 다음 기회에 서버로 나른다.
          const deletedAt = new Date().toISOString();
          const nextHosts = get().hosts.filter(item => item.id !== hostId);
          set({
            hosts: nextHosts,
            secretMetadata: deriveSecretMetadata(nextHosts, get().secretsByRef),
          });
          enqueueAndDrain([
            { kind: 'hosts', id: hostId, op: 'delete', deletedAt },
          ]);
        },
        // ── 그룹 편집 ───────────────────────────────────────────────────────
        //
        // 규칙은 shared-core 의 순수 함수가 갖고 있다(데스크톱 메인도 같은 것을 쓴다).
        // 여기서는 **로컬을 먼저 바꾸고 아웃박스에 넣는다** — 오프라인이어도 편집이 되고,
        // 큐가 다음 기회에 서버로 나른다.
        //
        // 그룹 이름을 바꾸면 그 아래 호스트의 groupName(경로 문자열)이 전부 다시 쓰이므로
        // 바뀐 것만 골라 큐에 넣는다(updatedAt 대조).
        quickConnectSsh: async (input: ParsedQuickSshCommand) => {
          const existing = findExistingQuickSshHost(input, get().hosts);
          if (existing) {
            return get().connectToHost(existing.id);
          }

          await get().saveHost({
            label: buildQuickSshHostLabel(input, get().hosts, null),
            hostname: input.hostname,
            port: input.port,
            username: input.username,
            authType: 'password',
          });
          // saveHost 는 id 를 돌려주지 않는다. 같은 주소가 둘일 수 없으므로 다시 찾는다.
          const created = findExistingQuickSshHost(input, get().hosts);
          return created ? get().connectToHost(created.id) : null;
        },
        createGroup: async (name: string, parentPath: string | null) => {
          const timestamp = new Date().toISOString();
          const { groups, created } = createGroupIn(get().groups, {
            id: createLocalId('group'),
            name,
            parentPath,
            timestamp,
          });

          set({ groups: sortGroups(groups) });
          enqueueAndDrain([{ kind: 'groups', id: created.id, op: 'upsert' }]);
        },
        renameGroup: async (path: string, name: string) => {
          const timestamp = new Date().toISOString();
          const before = get();
          const result = renameGroupIn(before.groups, before.hosts, path, name, {
            timestamp,
          });

          const survivingIds = new Set(result.groups.map(record => record.id));
          const removedGroupIds = before.groups
            .filter(record => !survivingIds.has(record.id))
            .map(record => record.id);

          set({
            groups: sortGroups(result.groups),
            hosts: sortHosts(result.hosts),
            secretMetadata: deriveSecretMetadata(result.hosts, get().secretsByRef),
          });
          enqueueAndDrain([
            ...result.groups
              .filter(record => record.updatedAt === timestamp)
              .map(record => ({ kind: 'groups' as const, id: record.id, op: 'upsert' as const })),
            ...removedGroupIds.map(id => ({
              kind: 'groups' as const,
              id,
              op: 'delete' as const,
              deletedAt: timestamp,
            })),
            ...result.hosts
              .filter(record => record.updatedAt === timestamp)
              .map(record => ({ kind: 'hosts' as const, id: record.id, op: 'upsert' as const })),
          ]);
        },
        removeGroup: async (path: string, mode: GroupRemoveMode) => {
          const timestamp = new Date().toISOString();
          const before = get();
          const result = removeGroupFrom(before.groups, before.hosts, path, mode, {
            timestamp,
          });

          set({
            groups: sortGroups(result.groups),
            hosts: sortHosts(result.hosts),
            secretMetadata: deriveSecretMetadata(result.hosts, get().secretsByRef),
          });
          enqueueAndDrain([
            ...result.groups
              .filter(record => record.updatedAt === timestamp)
              .map(record => ({ kind: 'groups' as const, id: record.id, op: 'upsert' as const })),
            ...result.removedGroupIds.map(id => ({
              kind: 'groups' as const,
              id,
              op: 'delete' as const,
              deletedAt: timestamp,
            })),
            ...result.hosts
              .filter(record => record.updatedAt === timestamp)
              .map(record => ({ kind: 'hosts' as const, id: record.id, op: 'upsert' as const })),
            ...result.removedHostIds.map(id => ({
              kind: 'hosts' as const,
              id,
              op: 'delete' as const,
              deletedAt: timestamp,
            })),
          ]);
        },
        disconnectRemoteDesktopSession: async (sessionId: string) => {
          // 기록을 **지우지 않는다.** closeRemoteDesktopSession 이 status 를 'closed' 로
          // 내려 탭에서는 사라지고(탭은 live 만 본다), 최근 세션 목록에는 남는다. 지우면
          // RDP/VNC 는 재연결 목록에 아예 나타나지 않는다.
          await closeRemoteDesktopSession(sessionId);
        },
        reconnectRemoteDesktopSession: async (sessionId: string) => {
          if (!get().secureStateReady) {
            throw new Error(getSecureStateLoadingMessage());
          }
          const session = get().remoteDesktopSessions.find(
            item => item.id === sessionId,
          );
          if (!session) {
            return;
          }
          // 이미 붙어 있거나 붙는 중이면 아무 일도 하지 않는다 — 런타임 핸들이 그 사실이다.
          if (getRemoteDesktopHandle(sessionId)) {
            return;
          }
          const host = get().hosts.find(item => item.id === session.hostId);
          if (!host || !(isRdpHostRecord(host) || isVncHostRecord(host))) {
            // 호스트를 지웠거나 종류가 바뀐 경우. 붙을 곳이 없으니 이유를 남긴다.
            get().updateRemoteDesktopSession(sessionId, {
              status: 'error',
              errorMessage: t('store.sessionHostNotFound'),
              connectionStatusMessage: null,
            });
            return;
          }
          const engineError = guardRemoteDesktopEngine(host.kind);
          if (engineError) {
            get().updateRemoteDesktopSession(sessionId, {
              status: 'error',
              errorMessage: engineError.message,
              connectionStatusMessage: null,
            });
            return;
          }
          // 지난 오류를 먼저 지운다 — 남겨 두면 새 시도가 도는 동안 옛 실패 문구가 보인다.
          get().updateRemoteDesktopSession(sessionId, {
            status: 'connecting',
            errorMessage: null,
            connectionStatusMessage: t('session.remoteDesktopConnecting'),
          });
          // 만들 때와 같은 경로다(void). 실패는 그 안의 catch 가 상태로 남긴다.
          void connectRemoteDesktopSession(sessionId, host);
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

          // RDP/VNC hosts route to the remote desktop session path, never terminal.
          if (isRdpHostRecord(host) || isVncHostRecord(host)) {
            const protocol = host.kind as 'rdp' | 'vnc';
            // Check for an existing live RD session for this host.
            const liveRd = get().remoteDesktopSessions.find(
              session =>
                session.hostId === hostId && session.status !== 'closed',
            );
            if (liveRd) {
              get().setActiveConnectionTab({ kind: protocol, id: liveRd.id });
              return liveRd.id;
            }
            const rdId = createLocalId('rd');
            get().createRemoteDesktopSession({
              id: rdId,
              hostId: host.id,
              protocol,
              title: host.label,
            });
            const engineError = guardRemoteDesktopEngine(protocol);
            if (engineError) {
              get().updateRemoteDesktopSession(rdId, {
                status: 'error',
                errorMessage: engineError.message,
              });
              set(state => ({
                activeConnectionTab: normalizeActiveConnectionTab(
                  state.sessions,
                  state.sftpSessions,
                  state.activeConnectionTab,
                  { kind: protocol, id: rdId },
                  state.remoteDesktopSessions,
                ),
              }));
              return rdId;
            }
            set(state => ({
              activeConnectionTab: normalizeActiveConnectionTab(
                state.sessions,
                state.sftpSessions,
                state.activeConnectionTab,
                { kind: protocol, id: rdId },
                state.remoteDesktopSessions,
              ),
            }));
            void connectRemoteDesktopSession(rdId, host);
            return rdId;
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
              state.remoteDesktopSessions,
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
              state.remoteDesktopSessions,
            ),
          }));
        },
        resumeSession: async (
          sessionId: string,
          options?: { auto?: boolean; credentialOverride?: HostSecretInput },
        ) => {
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
                connectionStatusMessage: null,
                // 끊김 표시를 반드시 지운다. patch 는 명시한 키만 덮으므로 이걸 빼면 다시
                // 붙는 동안에도(그리고 붙은 뒤에도) 탭이 "Disconnected" 로 남고, 그 상태로
                // 탭하면 재연결이 또 걸린다.
                disconnectReason: undefined,
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
          void connectSessionRecord(session, host, {
            promptForStartupVars: !options?.auto,
            credentialOverride: options?.credentialOverride,
          });
          return session.id;
        },
        disconnectSession: async (sessionId: string) => {
          await cancelPendingTailnetConnection(sessionId);
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
          await cancelPendingTailnetConnection(sessionId);
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
                      // **런타임 값에서 읽는다.** 레코드의 사본은 세션이 끝나는 순간에만
                      // 게시되므로(주기 게시를 끊었다) 살아 있는 세션에서는 낡아 있다.
                      Buffer.from(
                        runtimeSessionSnapshots.get(sessionId) ??
                          get().sessions.find(item => item.id === sessionId)
                            ?.lastViewportSnapshot ??
                          '',
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
          return openSftpForHostId(sourceSession.hostId, sourceSession.id);
        },
        openSftpForHost: async (hostId: string) => openSftpForHostId(hostId),
        openSftpEditor: async (sftpSessionId: string, remotePath: string) => {
          const runtime = runtimeSftpSessions.get(sftpSessionId);
          const read = runtime?.connection.readTextFile;
          if (!read) {
            // AWS SFTP 는 sync-api 브로커를 지나 이 연산이 없다. 여기까지 오지 않게 UI 가
            // 동작을 감추지만, 세션 종류가 바뀌는 경합도 있으니 이유를 남긴다.
            set({
              sftpEditor: {
                sftpSessionId,
                path: remotePath,
                fileName: remoteFileName(remotePath),
                content: '',
                originalContent: '',
                size: 0,
                mtime: '',
                mode: 0,
                isLoading: false,
                isSaving: false,
                conflict: false,
                errorMessage: t('sftpEditor.unsupported'),
              },
            });
            return;
          }

          set({
            sftpEditor: {
              sftpSessionId,
              path: remotePath,
              fileName: remoteFileName(remotePath),
              content: '',
              originalContent: '',
              size: 0,
              mtime: '',
              mode: 0,
              isLoading: true,
              isSaving: false,
              conflict: false,
              errorMessage: null,
            },
          });

          try {
            const loaded = await read(remotePath);
            set(state =>
              // 불러오는 동안 사용자가 닫았거나 다른 파일을 열었으면 버린다.
              isSameEditorTarget(state.sftpEditor, {
                sftpSessionId,
                path: remotePath,
              })
                ? {
                    sftpEditor: {
                      ...state.sftpEditor,
                      content: loaded.content,
                      originalContent: loaded.content,
                      size: loaded.size,
                      mtime: loaded.mtime,
                      mode: loaded.mode,
                      isLoading: false,
                    },
                  }
                : state,
            );
          } catch (error) {
            set(state =>
              isSameEditorTarget(state.sftpEditor, {
                sftpSessionId,
                path: remotePath,
              })
                ? {
                    sftpEditor: {
                      ...state.sftpEditor,
                      isLoading: false,
                      errorMessage: getSftpEditorErrorMessage(error),
                    },
                  }
                : state,
            );
          }
        },
        setSftpEditorContent: (content: string) => {
          set(state =>
            state.sftpEditor
              ? {
                  sftpEditor: {
                    ...state.sftpEditor,
                    content,
                    // 내용을 고치면 이전 실패는 지운다 — 사용자가 이미 반응한 것이다.
                    errorMessage: null,
                    conflict: false,
                  },
                }
              : state,
          );
        },
        saveSftpEditor: async (options?: { force?: boolean }) => {
          const editor = get().sftpEditor;
          if (!editor || editor.isSaving || editor.isLoading) {
            return false;
          }
          const runtime = runtimeSftpSessions.get(editor.sftpSessionId);
          const write = runtime?.connection.writeTextFile;
          if (!write) {
            set(state =>
              state.sftpEditor
                ? {
                    sftpEditor: {
                      ...state.sftpEditor,
                      errorMessage: t('sftpEditor.unsupported'),
                    },
                  }
                : state,
            );
            return false;
          }

          set(state =>
            state.sftpEditor
              ? {
                  sftpEditor: {
                    ...state.sftpEditor,
                    isSaving: true,
                    errorMessage: null,
                    conflict: false,
                  },
                }
              : state,
          );

          const saved = editor.content;
          try {
            await write({
              path: editor.path,
              content: saved,
              // 덮어쓰기를 고른 경우엔 기준을 보내지 않는다 — 엔진이 force 로 검사를 건너뛴다.
              expectedSize: options?.force ? null : editor.size,
              expectedMtime: options?.force ? null : editor.mtime,
              mode: editor.mode || undefined,
              force: options?.force ?? false,
            });
          } catch (error) {
            const conflict = isSftpWriteConflictError(error);
            set(state =>
              isSameEditorTarget(state.sftpEditor, editor)
                ? {
                    sftpEditor: {
                      ...state.sftpEditor,
                      isSaving: false,
                      conflict,
                      errorMessage: conflict
                        ? t('sftpEditor.conflictBody')
                        : getSftpEditorErrorMessage(error),
                    },
                  }
                : state,
            );
            return false;
          }

          // 저장한 내용이 새 기준이 된다. 방금 쓴 파일을 다시 stat 해 size·mtime 을 맞춘다 —
          // 그러지 않으면 이어서 저장할 때 우리가 만든 변경을 충돌로 읽는다.
          let nextSize = utf8ByteLength(saved);
          let nextMtime = editor.mtime;
          try {
            const restated = await runtime?.connection.readTextFile?.(
              editor.path,
            );
            if (restated) {
              nextSize = restated.size;
              nextMtime = restated.mtime;
            }
          } catch {
            // 다시 읽지 못하면 방금 쓴 내용의 바이트 길이와 이전 mtime 을 남긴다. 그러면
            // 다음 저장이 충돌로 걸려 사용자에게 묻는다 — 조용히 덮어쓰는 쪽보다 안전하다.
            // (mtime 을 비우면 검사가 꺼지는 게 아니라 크기 검사만 남는다.)
          }

          set(state =>
            isSameEditorTarget(state.sftpEditor, editor)
              ? {
                  sftpEditor: {
                    ...state.sftpEditor,
                    isSaving: false,
                    originalContent: saved,
                    size: nextSize,
                    mtime: nextMtime,
                  },
                }
              : state,
          );
          await refreshSftpDirectory(editor.sftpSessionId);
          return true;
        },
        reloadSftpEditor: async () => {
          const editor = get().sftpEditor;
          if (!editor) {
            return;
          }
          await get().openSftpEditor(editor.sftpSessionId, editor.path);
        },
        closeSftpEditor: () => {
          set({ sftpEditor: null });
        },
        disconnectSftpSession: async (sftpSessionId: string) => {
          await cancelPendingTailnetConnection(sftpSessionId);
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
              error instanceof Error ? error.message : t('store.uploadFailed');
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
        acceptRdpCertificatePrompt: async () => {
          const prompt = get().pendingRdpCertificatePrompt;
          if (!prompt) return;
          const runtime = getRemoteDesktopHandle(prompt.sessionId);
          set({ pendingRdpCertificatePrompt: null });
          if (!runtime || runtime.cancelled) {
            await nativeTrustCertificate(prompt.sessionId, false).catch(
              () => undefined,
            );
            return;
          }
          const current = get().hosts.find(item => item.id === prompt.hostId);
          if (!current || !isRdpHostRecord(current)) {
            await nativeTrustCertificate(prompt.sessionId, false).catch(
              () => undefined,
            );
            return;
          }
          try {
            await nativeTrustCertificate(prompt.sessionId, true);
            if (
              runtime.cancelled ||
              getRemoteDesktopHandle(prompt.sessionId) !== runtime
            ) {
              return;
            }
            await persistRdpCertificateFingerprint(
              prompt.hostId,
              prompt.fingerprint,
            );
          } catch (error) {
            if (
              runtime.cancelled ||
              getRemoteDesktopHandle(prompt.sessionId) !== runtime
            ) {
              return;
            }
            await releaseRemoteDesktopRuntime(prompt.sessionId, runtime);
            get().updateRemoteDesktopSession(prompt.sessionId, {
              status: 'error',
              errorMessage:
                error instanceof Error
                  ? error.message
                  : t('session.remoteDesktopError'),
              connectionStatusMessage: null,
            });
          }
        },
        rejectRdpCertificatePrompt: async () => {
          const prompt = get().pendingRdpCertificatePrompt;
          if (!prompt) return;
          set({ pendingRdpCertificatePrompt: null });
          await nativeTrustCertificate(prompt.sessionId, false).catch(
            () => undefined,
          );
        },
        submitCredentialPrompt: async (
          input: HostSecretInput & { username?: string },
        ) => {
          const prompt = get().pendingCredentialPrompt;
          const host = prompt
            ? get().hosts.find(item => item.id === prompt.hostId)
            : undefined;
          const username = input.username?.trim();
          if (!username) {
            throw new Error(t('credentialRetry.usernameRequired'));
          }
          if (host && isSshHostRecord(host)) {
            applyHostUsername(host, username);
          }
          pendingCredentialResolver?.(input);
          pendingCredentialResolver = null;
          set({ pendingCredentialPrompt: null });
        },
        cancelCredentialPrompt: () => {
          pendingCredentialResolver?.(null);
          pendingCredentialResolver = null;
          set({ pendingCredentialPrompt: null });
        },
        submitCredentialRetry: async input => {
          const pending = get().pendingCredentialRetry;
          if (!pending) {
            return;
          }
          const host = get().hosts.find(item => item.id === pending.hostId);
          if (!host || !isSshHostRecord(host)) {
            set({ pendingCredentialRetry: null });
            return;
          }

          const username = input.username.trim();
          if (!username) {
            throw new Error(t('credentialRetry.usernameRequired'));
          }

          // 사용자명은 **먼저 저장한다**(데스크톱과 같다). 다시 붙는 것이 또 실패해도 사용자가
          // 고쳐 넣은 값은 남아야 한다 — 아니면 매번 같은 오타를 다시 쳐야 한다.
          applyHostUsername(host, username);

          // 비밀은 여기서 저장하지 않는다. 연결이 성공해야 저장하는 규칙을 그대로 탄다
          // (resolveHostCredentials → rememberPromptedSecret → commitPromptedSecret).
          // 틀린 비밀번호를 저장하면 이 창이 필요해진 원인(저장된 값이 틀렸는데 못 고침)을
          // 다시 만드는 셈이다.
          const credentialOverride: HostSecretInput = {
            password: input.password || undefined,
            passphrase: input.passphrase || undefined,
            privateKeyPem: input.privateKeyPem || undefined,
            certificateText: input.certificateText || undefined,
          };

          set({ pendingCredentialRetry: null });

          if (pending.target.kind === 'terminal') {
            await get().resumeSession(pending.target.recordId, {
              credentialOverride,
            });
            return;
          }

          const sftpSession = get().sftpSessions.find(
            item => item.id === pending.target.recordId,
          );
          const sftpHost = get().hosts.find(
            item => item.id === pending.hostId,
          );
          if (
            !sftpSession ||
            !sftpHost ||
            (!isSshHostRecord(sftpHost) && !isAwsEc2HostRecord(sftpHost))
          ) {
            return;
          }
          void connectSftpSessionRecord(sftpSession, sftpHost, {
            credentialOverride,
          });
        },
        cancelCredentialRetry: () => {
          set({ pendingCredentialRetry: null });
        },
        submitInteractiveAuthPrompt: (answer: EngineInteractiveAnswer) => {
          pendingInteractiveAuthResolver?.(answer);
          pendingInteractiveAuthResolver = null;
          set({ pendingInteractiveAuthPrompt: null });
        },
        cancelInteractiveAuthPrompt: () => {
          pendingInteractiveAuthResolver?.(null);
          pendingInteractiveAuthResolver = null;
          set({ pendingInteractiveAuthPrompt: null });
        },
        submitStartupCommandPrompt: (values: Record<string, string>) => {
          pendingStartupCommandResolver?.(values);
          pendingStartupCommandResolver = null;
          set({ pendingStartupCommandPrompt: null });
        },
        cancelStartupCommandPrompt: () => {
          pendingStartupCommandResolver?.(null);
          pendingStartupCommandResolver = null;
          set({ pendingStartupCommandPrompt: null });
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
        // 못 민 변경은 앱을 껐다 켜도 남아야 한다. 안 그러면 비행기 모드에서 고친 것이
        // 앱을 내리는 순간 사라진다.
        syncOutbox: state.syncOutbox,
        // 콜드스타트 첫 접속에도 스니펫이 필요하다 — pull 이 끝나기 전에 붙으면 startup
        // command 가 미해결로 건너뛰어진다.
        //
        // 명령 문자열이 AsyncStorage 에 평문으로 남는다. 노출 수준은 이미 persist 되는
        // 호스트의 startupCommand 와 같고, secrets 는 여전히 persist 하지 않는다.
        snippets: state.snippets,
        knownHosts: state.knownHosts,
        sessions: compactPersistedSessions(state.sessions),
        // 닫힌 RD 기록만 남는다 — 최근 세션에서 재연결할 근거다.
        remoteDesktopSessions: compactPersistedRemoteDesktopSessions(
          state.remoteDesktopSessions,
        ),
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
            new Date().toISOString(),
            t('store.sessionDropped'),
          );
          useMobileAppStore.setState(state => ({
            hydrated: true,
            sessions: nextSessions,
            // RD 는 자동 재연결이 없다. 살아 있는 것처럼 남으면 붙지 않는 유령 탭이 되므로
            // 전부 닫힌 기록으로 둔다 — 최근 세션에서 사용자가 눌러 새로 붙는다.
            remoteDesktopSessions: compactPersistedRemoteDesktopSessions(
              state.remoteDesktopSessions,
            ),
            remoteDesktopImmersive: false,
            sftpSessions: [],
            sftpEditor: null,
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

/**
 * 테스트에서 SFTP 런타임을 심는다. 편집기 동작(충돌 판정·저장 후 기준 갱신)은 이 런타임의
 * 연결을 지나므로, 실제 엔진을 띄우지 않고 검증하려면 주입할 자리가 필요하다.
 */
export function registerSftpRuntimeForTests(
  recordId: string,
  hostId: string,
  connection: MobileSftpConnection,
): void {
  runtimeSftpSessions.set(recordId, { recordId, hostId, connection });
}

export function resetMobileStoreRuntimeForTests(): void {
  resetSyncedTailnetRuntimeForTests();
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
  const pendingRdpCertificate =
    useMobileAppStore.getState().pendingRdpCertificatePrompt;
  if (pendingRdpCertificate) {
    void nativeTrustCertificate(pendingRdpCertificate.sessionId, false).catch(
      () => undefined,
    );
    useMobileAppStore.setState({ pendingRdpCertificatePrompt: null });
  }
  pendingServerKeyResolver = null;
  pendingCredentialResolver = null;
  pendingStartupCommandResolver = null;
  startupVarsBySession.clear();
  pendingAwsSsoCancelHandler = null;
  for (const runtime of runtimeSessions.values()) {
    try {
      if (runtime.kind === 'ssh') {
        void runtime.shell.close();
        // 직접 연 SSM 셸에는 SSH 연결이 없다(셸만 있다).
        void runtime.connection?.disconnect();
        void runtime.ssmForward?.stop();
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
  for (const [sessionId, handle] of [...getAllRemoteDesktopHandles()]) {
    handle.cancelled = true;
    if (handle.dispose) {
      void handle.dispose();
      continue;
    }
    removeRemoteDesktopHandle(sessionId);
    handle.eventUnsubscribe?.();
    void nativeDisconnect(sessionId).catch(() => undefined);
    if (handle.tunnelId) {
      void closeRemoteDesktopTunnel(handle.tunnelId).catch(() => undefined);
    }
    void handle.ssmForward?.stop().catch(() => undefined);
  }
  pendingSessionConnections.clear();
  pendingSftpConnections.clear();
  pendingTailnetConnections.clear();
  activeTailnetAuthorization = null;
  tailnetRequestCounter = 0;
  runtimeSessionSnapshots.clear();
  for (const timer of runtimeSnapshotFlushTimers.values()) {
    clearTimeout(timer);
  }
  runtimeSnapshotFlushTimers.clear();
}

export type {
  MobileAppState,
  PendingCredentialPromptState,
  PendingRdpCertificatePromptState,
  PendingServerKeyPromptState,
  PendingStartupCommandPromptState,
};
