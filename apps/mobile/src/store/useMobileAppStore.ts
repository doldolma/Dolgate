import { Buffer } from 'buffer';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { Linking } from 'react-native';
import {
  RnRussh,
  type ConnectionDetails as RusshConnectionDetails,
} from '@fressh/react-native-uniffi-russh';
import type {
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
  SyncStatus,
} from '@dolssh/shared-core';
import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSftpDisabledReason,
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
  isSshHostRecord,
} from '@dolssh/shared-core';
import {
  buildBrowserLoginUrl,
  clearStoredAwsProfiles,
  clearStoredAwsSsoTokens,
  buildKnownHostRecord,
  buildKnownHostsSyncPayload,
  clearStoredAuthSession,
  clearStoredSecrets,
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
  deriveSecretMetadata,
  fetchExchangeSession,
  fetchServerInfo,
  fetchSyncSnapshot,
  getSettingsValidationMessage,
  loadStoredAwsProfiles,
  logoutRemoteSession,
  mergePromptedSecrets,
  MobileServerPublicKeyInfo,
  postSyncSnapshot,
  refreshAuthSession,
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
import {
  type AwsSsoBrowserLoginPrompt,
  resolveAwsSessionForHost,
} from '../lib/aws-session';
import {
  AwsSftpHostKeyChallengeError,
  connectAwsSftp,
} from '../lib/aws-sftp';
import { openAwsSsoBrowser } from '../lib/aws-sso-bridge';
import {
  getCurrentWindowTerminalGridSize,
  toRusshTerminalSize,
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

const MAX_TERMINAL_SNAPSHOT_CHARS = 8_000;
const MAX_PERSISTED_SESSIONS = 24;
const SFTP_TRANSFER_CHUNK_SIZE = 256 * 1024;
const SESSION_SNAPSHOT_FLUSH_MS = 750;
const STARTUP_REFRESH_TIMEOUT_MS = 3_000;
const STARTUP_REFRESH_TIMEOUT_MESSAGE =
  '서버 응답이 지연되고 있습니다. 다시 시도해 주세요.';
const OFFLINE_RECOVERY_RETRY_DELAYS_MS = [2_000, 5_000, 5_000, 5_000] as const;
const SECURE_STATE_LOADING_MESSAGE =
  '저장된 보안 정보를 복구하는 중입니다. 잠시 후 다시 시도해 주세요.';

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

type NativeSftpConnectionHandle = Awaited<
  ReturnType<typeof RnRussh.connectSftp>
>;

interface SshRuntimeSession {
  kind: 'ssh';
  recordId: string;
  hostId: string;
  connection: Awaited<ReturnType<typeof RnRussh.connect>>;
  shell: Awaited<
    ReturnType<Awaited<ReturnType<typeof RnRussh.connect>>['startShell']>
  >;
  backgroundListenerId: bigint | null;
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

type RusshSecurity = RusshConnectionDetails['security'];

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

function buildRusshSecurity(
  host: SshHostRecord,
  credentials: HostSecretInput,
): RusshSecurity | null {
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
    return '비밀번호가 필요합니다.';
  }
  if (host.authType === 'certificate') {
    return '개인키 PEM과 SSH 인증서가 필요합니다.';
  }
  return '개인키 PEM이 필요합니다.';
}

function validateRusshSecurity(security: RusshSecurity): string | null {
  if (security.type === 'key' || security.type === 'certificate') {
    const validation = RnRussh.validatePrivateKey(
      security.privateKey,
      security.passphrase,
    );
    if (!validation.valid) {
      return '개인키 형식 또는 passphrase를 확인해 주세요.';
    }
  }

  if (security.type === 'certificate') {
    const validation = RnRussh.validateCertificate(security.certificate);
    if (!validation.valid) {
      return 'SSH 인증서 형식을 확인해 주세요.';
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

interface MobileAppState {
  hydrated: boolean;
  bootstrapping: boolean;
  authGateResolved: boolean;
  secureStateReady: boolean;
  auth: AuthState;
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
  syncNow: () => Promise<void>;
  updateSettings: (input: Partial<MobileSettings>) => Promise<void>;
  connectToHost: (hostId: string) => Promise<string | null>;
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
let russhInitPromise: Promise<void> | null = null;
let offlineRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let offlineRecoveryAttempt = 0;
let offlineRecoveryInFlight = false;
let offlineRecoveryKey: string | null = null;
let secureStateRestoreVersion = 0;
let pendingServerKeyResolver: ((accepted: boolean) => void) | null = null;
let pendingCredentialResolver:
  | ((value: HostSecretInput | null) => void)
  | null = null;
let pendingAwsSsoCancelHandler: (() => void) | null = null;

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

function sortSessions(sessions: MobileSessionRecord[]): MobileSessionRecord[] {
  return [...sessions].sort((left, right) =>
    right.lastEventAt.localeCompare(left.lastEventAt),
  );
}

function isLiveSession(session: MobileSessionRecord): boolean {
  return session.status !== 'closed';
}

function getLiveSessions(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  return sortSessions(sessions).filter(isLiveSession);
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
  return sortSessions(
    sessions.map(session =>
      session.id === sessionId ? { ...session, ...patch } : session,
    ),
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
    return sortSessions([nextRecord, ...sessions]);
  }

  const nextSessions = [...sessions];
  nextSessions[existingIndex] = nextRecord;
  return sortSessions(nextSessions);
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

function toDirectoryListing(
  listing: Awaited<
    ReturnType<NativeSftpConnectionHandle['listDirectory']>
  >,
): DirectoryListing {
  return {
    path: listing.path,
    entries: listing.entries.map(entry => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
      mtime: entry.mtime ?? '',
      kind:
        entry.kind === 'directory'
          ? 'folder'
          : entry.kind === 'file' || entry.kind === 'symlink'
            ? entry.kind
            : 'unknown',
      permissions: entry.permissions ?? undefined,
    })),
  };
}

function wrapNativeSftpConnection(
  connection: NativeSftpConnectionHandle,
): MobileSftpConnection {
  return {
    listDirectory: async path =>
      toDirectoryListing(await connection.listDirectory(path)),
    readFileChunk: (path, offset, length) =>
      connection.readFileChunk(path, offset, length),
    writeFileChunk: (path, offset, data) =>
      connection.writeFileChunk(path, offset, data),
    mkdir: path => connection.mkdir(path),
    rename: (sourcePath, targetPath) =>
      connection.rename(sourcePath, targetPath),
    chmod: (path, permissions) => connection.chmod(path, permissions),
    delete: path => connection.delete(path),
    close: () => connection.close(),
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
    throw new Error('권한은 644 또는 0755 같은 8진수로 입력해 주세요.');
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
  const currentEntry = currentListing?.entries.find(entry => entry.path === path);
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
    await writeDownloadChunk(destinationUri, bytes.toString('base64'), offset > 0);
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
  return sortSessions(sessions)
    .slice(0, MAX_PERSISTED_SESSIONS)
    .map(session => ({
      ...session,
      lastViewportSnapshot: '',
    }));
}

function normalizePersistedSessionsForColdStart(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  const now = new Date().toISOString();
  return sortSessions(
    sessions.map(session => {
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
    }),
  );
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
  return (
    message.includes('token has invalid claims') ||
    message.includes('invalid claims') ||
    (message.includes('jwt') && message.includes('expired')) ||
    message.includes('세션이 만료')
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
  if (!runtime) {
    pendingSessionConnections.delete(sessionId);
    runtimeSessionSnapshots.delete(sessionId);
    const pendingFlush = runtimeSnapshotFlushTimers.get(sessionId);
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      runtimeSnapshotFlushTimers.delete(sessionId);
    }
    return;
  }

  if (runtime.kind === 'ssh') {
    try {
      if (runtime.backgroundListenerId !== null) {
        runtime.shell.removeListener(runtime.backgroundListenerId);
      }
    } catch {}
  } else {
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

function disconnectRuntimeSftpSession(sessionId: string): void {
  runtimeSftpSessions.delete(sessionId);
  pendingSftpConnections.delete(sessionId);
}

async function disconnectAllRuntimeSessions(): Promise<void> {
  for (const session of [...runtimeSessions.values()]) {
    if (session.kind === 'ssh') {
      try {
        await session.connection.disconnect();
      } catch {}
    } else {
      try {
        session.socket.close();
      } catch {}
    }
    disconnectRuntimeSession(session.recordId);
  }
  for (const session of [...runtimeSftpSessions.values()]) {
    try {
      await session.connection.close();
    } catch {}
    disconnectRuntimeSftpSession(session.recordId);
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
        errorMessage = '세션이 만료되어 다시 로그인해야 합니다.',
      ) => {
        clearOfflineRecoveryLoop();
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
            errorMessage: '세션이 만료되었습니다.',
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

      const refreshAuthForConnection = async (): Promise<AuthSession | null> => {
        const currentSession = get().auth.session;
        if (!currentSession) {
          await expireAuthSession();
          return null;
        }

        try {
          const refreshed = await refreshAuthSession(
            get().settings.serverUrl,
            currentSession,
          );
          await saveStoredAuthSession(refreshed);
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

      const ensureRusshInitialized = async () => {
        if (russhInitPromise) {
          return russhInitPromise;
        }

        russhInitPromise = RnRussh.uniffiInitAsync().catch(error => {
          russhInitPromise = null;
          throw error;
        });
        return russhInitPromise;
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
          const refreshed = await refreshAuthSession(serverUrl, session, {
            timeoutMs: STARTUP_REFRESH_TIMEOUT_MS,
            timeoutMessage: STARTUP_REFRESH_TIMEOUT_MESSAGE,
          });
          if (!isSessionRecoveryContextCurrent(session, serverUrl)) {
            return;
          }

          clearOfflineRecoveryLoop();
          await saveStoredAuthSession(refreshed);
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
            set({
              auth: {
                status: 'offline-authenticated',
                session,
                offline: buildOfflineState(
                  session,
                  '네트워크 없이 저장된 세션을 복구했습니다.',
                ),
                errorMessage: null,
              },
              syncStatus: {
                ...get().syncStatus,
                status: 'paused',
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : '네트워크에 연결할 수 없습니다.',
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
                  : '로그인 세션을 복구하지 못했습니다.',
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
          const refreshed = await refreshAuthSession(serverUrl, session);
          if (!isSessionRecoveryContextCurrent(session, serverUrl)) {
            return 'stop';
          }

          await saveStoredAuthSession(refreshed);
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
                errorMessage: '세션이 만료되어 다시 로그인해야 합니다.',
              },
              syncStatus: {
                ...createDefaultSyncStatus(),
                status: 'error',
                errorMessage: '세션이 만료되었습니다.',
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
                  : '네트워크에 연결할 수 없습니다.',
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
          await postSyncSnapshot(
            get().settings.serverUrl,
            session.tokens.accessToken,
            buildKnownHostsSyncPayload(
              knownHosts,
              session.vaultBootstrap.keyBase64,
            ),
          );
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
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              pendingPush: true,
              status: 'error',
              errorMessage:
                error instanceof Error
                  ? error.message
                  : 'known host 동기화에 실패했습니다.',
            },
          }));
        }
      };

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
            '비밀번호를 입력해 주세요.',
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
            '개인키 PEM을 입력하거나 파일에서 가져와 주세요.',
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
            '개인키 PEM과 SSH 인증서를 입력하거나 파일에서 가져와 주세요.',
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
            'SFTP 연결을 찾지 못했습니다.',
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
              : 'SFTP 폴더 목록을 불러오지 못했습니다.',
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
              'SFTP는 모바일 v1에서 비밀번호, 개인키, 인증서 인증만 지원합니다.',
            );
            return;
          }

          await ensureRusshInitialized();
          const credentials = await resolveHostCredentials(host);
          if (!credentials) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'closed',
              'SFTP 연결이 취소되었습니다.',
            );
            return;
          }

          const security = buildRusshSecurity(host, credentials);

          if (!security) {
            markSftpSessionState(
              sftpSessionRecord.id,
              'error',
              getMissingCredentialMessage(host),
            );
            return;
          }

          const validationMessage = validateRusshSecurity(security);
          if (validationMessage) {
            markSftpSessionState(sftpSessionRecord.id, 'error', validationMessage);
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

          const nativeConnection = await RnRussh.connectSftp({
            host: host.hostname,
            port: host.port,
            username: host.username,
            security,
            onServerKey: async info => resolveKnownHostTrust(host, info),
            onDisconnected: () => {
              disconnectRuntimeSftpSession(sftpSessionRecord.id);
              markSftpSessionState(sftpSessionRecord.id, 'closed');
            },
          });
          const connection = wrapNativeSftpConnection(nativeConnection);

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
        } catch (error) {
          disconnectRuntimeSftpSession(sftpSessionRecord.id);
          if (isAuthExpiredError(error)) {
            await expireAuthSession();
            return;
          }
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            error instanceof Error
              ? error.message
              : 'SFTP 연결에 실패했습니다.',
          );
        } finally {
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

        const disabledReason = getAwsEc2HostSftpDisabledReason(host);
        if (disabledReason) {
          markSftpSessionState(sftpSessionRecord.id, 'error', disabledReason);
          return;
        }

        let awsSftpServerSupport = get().syncStatus.awsSftpServerSupport;
        if (awsSftpServerSupport === 'unknown') {
          try {
            const serverInfo = await fetchServerInfo(get().settings.serverUrl);
            awsSftpServerSupport = serverInfo.capabilities.sessions.awsSftp
              ? 'supported'
              : 'unsupported';
            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                awsProfilesServerSupport: serverInfo.capabilities.sync
                  .awsProfiles
                  ? 'supported'
                  : 'unsupported',
                awsSsmServerSupport: serverInfo.capabilities.sessions.awsSsm
                  ? 'supported'
                  : 'unsupported',
                awsSftpServerSupport,
              },
            }));
          } catch {}
        }

        if (awsSftpServerSupport === 'unsupported') {
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            '이 서버는 AWS SFTP를 지원하지 않습니다.',
          );
          return;
        }

        const sshUsername = host.awsSshUsername?.trim();
        if (!sshUsername) {
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            host.awsSshMetadataError ||
              'AWS SFTP에 사용할 SSH 사용자명이 필요합니다.',
          );
          return;
        }
        const availabilityZone = host.awsAvailabilityZone?.trim();
        if (!availabilityZone) {
          markSftpSessionState(
            sftpSessionRecord.id,
            'error',
            'AWS SFTP에 사용할 Availability Zone 정보가 필요합니다.',
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
            record =>
              record.host === knownHostName && record.port === sshPort,
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
                  'SFTP 연결이 취소되었습니다.',
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
          'AWS SFTP 호스트 키를 확인하지 못했습니다.',
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
          '이 호스트 종류는 모바일에서 아직 지원하지 않습니다.',
        );
        pendingSessionConnections.delete(sessionRecord.id);
      };

      const connectSshSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: SshHostRecord,
      ) => {
        try {
          if (
            host.authType !== 'password' &&
            host.authType !== 'privateKey' &&
            host.authType !== 'certificate'
          ) {
            markSessionState(
              sessionRecord.id,
              'error',
              '이 인증 방식은 모바일 v1에서 아직 지원하지 않습니다.',
            );
            return;
          }

          await ensureRusshInitialized();
          const credentials = await resolveHostCredentials(host);
          if (!credentials) {
            markSessionState(
              sessionRecord.id,
              'closed',
              '연결이 취소되었습니다.',
            );
            return;
          }

          const security = buildRusshSecurity(host, credentials);

          if (!security) {
            markSessionState(
              sessionRecord.id,
              'error',
              getMissingCredentialMessage(host),
            );
            return;
          }

          const validationMessage = validateRusshSecurity(security);
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

          const connection = await RnRussh.connect({
            host: host.hostname,
            port: host.port,
            username: host.username,
            security,
            onServerKey: async info => resolveKnownHostTrust(host, info),
            onDisconnected: () => {
              flushSessionSnapshot(sessionRecord.id, {
                markActivity: false,
              });
              disconnectRuntimeSession(sessionRecord.id);
              markSessionState(sessionRecord.id, 'closed');
            },
          });
          const terminalSize = getCurrentWindowTerminalGridSize();
          const shell = await connection.startShell({
            term: 'Xterm',
            terminalSize: toRusshTerminalSize(terminalSize),
            onClosed: () => {
              flushSessionSnapshot(sessionRecord.id, {
                markActivity: false,
              });
              disconnectRuntimeSession(sessionRecord.id);
              markSessionState(sessionRecord.id, 'closed');
            },
          });

          const backgroundListenerId = shell.addListener(
            event => {
              if ('kind' in event) {
                return;
              }
              const text = Buffer.from(event.bytes).toString('utf8');
              const currentSnapshot =
                runtimeSessionSnapshots.get(sessionRecord.id) ?? '';
              runtimeSessionSnapshots.set(
                sessionRecord.id,
                trimSnapshot(`${currentSnapshot}${text}`),
              );
              scheduleSessionSnapshotFlush(sessionRecord.id);
            },
            {
              cursor: { mode: 'live' },
              coalesceMs: 20,
            },
          );

          runtimeSessions.set(sessionRecord.id, {
            kind: 'ssh',
            recordId: sessionRecord.id,
            hostId: host.id,
            connection,
            shell,
            backgroundListenerId,
          });

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
          disconnectRuntimeSession(sessionRecord.id);
          markSessionState(
            sessionRecord.id,
            'error',
            error instanceof Error ? error.message : 'SSH 연결에 실패했습니다.',
          );
        } finally {
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
              awsSsmServerSupport = serverInfo.capabilities.sessions.awsSsm
                ? 'supported'
                : 'unsupported';
              set(state => ({
                syncStatus: {
                  ...state.syncStatus,
                  awsProfilesServerSupport: serverInfo.capabilities.sync
                    .awsProfiles
                    ? 'supported'
                    : 'unsupported',
                  awsSsmServerSupport,
                  awsSftpServerSupport: serverInfo.capabilities.sessions.awsSftp
                    ? 'supported'
                    : 'unsupported',
                },
              }));
            } catch {}
          }

          if (awsSsmServerSupport === 'unsupported') {
            markSessionState(
              sessionRecord.id,
              'error',
              '이 서버는 AWS SSM 세션을 지원하지 않습니다.',
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
          const terminalSize = getCurrentWindowTerminalGridSize();
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
                message.message || 'AWS SSM 연결에 실패했습니다.',
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
                  message.message || 'AWS SSM 세션이 시작 직후 종료되었습니다.',
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
              'AWS SSM WebSocket 연결에 실패했습니다.',
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
                  'AWS SSM 세션이 예기치 않게 종료되었습니다.',
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
              : 'AWS SSM 연결에 실패했습니다.',
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
          return syncPromise;
        }

        syncPromise = (async () => {
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

            let payload;
            try {
              payload = await fetchSyncSnapshot(
                get().settings.serverUrl,
                currentSession.tokens.accessToken,
              );
            } catch (error) {
              if (error instanceof ApiError && error.status === 401) {
                currentSession = await refreshAuthSession(
                  get().settings.serverUrl,
                  currentSession,
                );
                await saveStoredAuthSession(currentSession);
                set({
                  auth: {
                    status: 'authenticated',
                    session: currentSession,
                    offline: null,
                    errorMessage: null,
                  },
                });
                payload = await fetchSyncSnapshot(
                  get().settings.serverUrl,
                  currentSession.tokens.accessToken,
                );
              } else {
                throw error;
              }
            }
            const serverInfo = await serverInfoPromise;

            const nextHosts = sortHosts(
              decodeSupportedHosts(
                payload,
                currentSession.vaultBootstrap.keyBase64,
              ),
            );
            const nextGroups = sortGroups(
              decodeGroups(payload, currentSession.vaultBootstrap.keyBase64),
            );
            const nextAwsProfiles = decodeAwsProfiles(
              payload,
              currentSession.vaultBootstrap.keyBase64,
            );
            const nextKnownHosts = decodeKnownHosts(
              payload,
              currentSession.vaultBootstrap.keyBase64,
            );
            const nextSecretsByRef = decodeManagedSecrets(
              payload,
              currentSession.vaultBootstrap.keyBase64,
            );

            await updateSecretsState(nextSecretsByRef, nextHosts);
            await saveStoredAwsProfiles(nextAwsProfiles);
            clearOfflineRecoveryLoop();
            set({
              groups: nextGroups,
              hosts: nextHosts,
              awsProfiles: nextAwsProfiles,
              knownHosts: sortKnownHosts(nextKnownHosts),
              secureStateReady: true,
              auth: {
                status: 'authenticated',
                session: currentSession,
                offline: null,
                errorMessage: null,
              },
              syncStatus: {
                status: 'ready',
                pendingPush: false,
                errorMessage: null,
                lastSuccessfulSyncAt: new Date().toISOString(),
                awsProfilesServerSupport:
                  serverInfo?.capabilities.sync.awsProfiles === true
                    ? 'supported'
                    : serverInfo?.capabilities.sync.awsProfiles === false
                      ? 'unsupported'
                      : 'unknown',
                awsSsmServerSupport:
                  serverInfo?.capabilities.sessions.awsSsm === true
                    ? 'supported'
                    : serverInfo?.capabilities.sessions.awsSsm === false
                      ? 'unsupported'
                      : 'unknown',
                awsSftpServerSupport:
                  serverInfo?.capabilities.sessions.awsSftp === true
                    ? 'supported'
                    : serverInfo?.capabilities.sessions.awsSftp === false
                      ? 'unsupported'
                      : 'unknown',
              },
            });
          } catch (error) {
            if (
              isLikelyNetworkError(error) &&
              isOfflineLeaseActive(currentSession)
            ) {
              set({
                auth: {
                  status: 'offline-authenticated',
                  session: currentSession,
                  offline: buildOfflineState(
                    currentSession,
                    '네트워크 없이 캐시된 데이터를 사용하고 있습니다.',
                  ),
                  errorMessage: null,
                },
                syncStatus: {
                  ...get().syncStatus,
                  status: 'paused',
                  errorMessage:
                    error instanceof Error
                      ? error.message
                      : '네트워크에 연결할 수 없습니다.',
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
                  errorMessage: '세션이 만료되어 다시 로그인해야 합니다.',
                },
                syncStatus: {
                  ...createDefaultSyncStatus(),
                  status: 'error',
                  errorMessage: '세션이 만료되었습니다.',
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

      return {
        hydrated: false,
        bootstrapping: false,
        authGateResolved: false,
        secureStateReady: false,
        auth: createUnauthenticatedState(),
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
            const session = await fetchExchangeSession(
              get().settings.serverUrl,
              payload.code,
            );
            await saveStoredAuthSession(session);
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
                    : '로그인 교환에 실패했습니다.',
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
            await Linking.openURL(
              buildBrowserLoginUrl(get().settings.serverUrl, stateToken),
            );
          } catch (error) {
            set({
              pendingBrowserLoginState: null,
              auth: {
                ...createUnauthenticatedState(),
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : '브라우저 로그인을 시작하지 못했습니다.',
              },
            });
          }
        },
        cancelBrowserLogin: () => {
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
          } catch (error) {
            set(state => ({
              auth: {
                ...state.auth,
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : '브라우저를 다시 열지 못했습니다.',
              },
            }));
          }
        },
        logout: async () => {
          clearOfflineRecoveryLoop();
          secureStateRestoreVersion += 1;
          clearPrompts();
          await disconnectAllRuntimeSessions();

          try {
            await logoutRemoteSession(
              get().settings.serverUrl,
              get().auth.session ?? null,
            );
          } catch {}

          await clearStoredAuthSession();
          await clearStoredSecrets();
          await clearStoredAwsProfiles();
          await clearStoredAwsSsoTokens();

          set({
            auth: createUnauthenticatedState(),
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
            secureStateRestoreVersion += 1;
            await disconnectAllRuntimeSessions();
          }

          if (serverChanged) {
            await clearStoredAuthSession();
            await clearStoredSecrets();
            await clearStoredAwsProfiles();
            await clearStoredAwsSsoTokens();
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: get().auth.session
                  ? '서버 주소가 변경되어 다시 로그인해 주세요.'
                  : null,
              },
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
        connectToHost: async (hostId: string) => {
          if (!get().secureStateReady) {
            set(state => ({
              syncStatus: {
                ...state.syncStatus,
                errorMessage: SECURE_STATE_LOADING_MESSAGE,
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
                errorMessage: SECURE_STATE_LOADING_MESSAGE,
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
              '이 세션의 호스트 정보를 찾을 수 없습니다.',
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

          if (runtime.kind === 'ssh') {
            try {
              await runtime.connection.disconnect();
            } catch {}
          } else {
            try {
              runtime.socket.close();
            } catch {}
          }

          flushSessionSnapshot(sessionId, {
            markActivity: false,
          });
          disconnectRuntimeSession(sessionId);
          markSessionState(sessionId, 'closed');
        },
        removeSession: async (sessionId: string) => {
          const runtime = runtimeSessions.get(sessionId);

          set(state => {
            const nextSessions = sortSessions(
              state.sessions.filter(session => session.id !== sessionId),
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

          disconnectRuntimeSession(sessionId);

          if (runtime.kind === 'ssh') {
            try {
              await runtime.connection.disconnect();
            } catch {}
          } else {
            try {
              runtime.socket.close();
            } catch {}
          }
        },
        writeToSession: async (sessionId: string, data: string) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            return;
          }
          const bytes = Buffer.from(data, 'utf8');
          if (runtime.kind === 'ssh') {
            await runtime.shell.sendData(
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ),
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
            const replay = runtime.shell.readBuffer({ mode: 'head' });
            handlers.onReplay(
              replay.chunks.map(chunk => new Uint8Array(chunk.bytes)),
            );

            const listenerId = runtime.shell.addListener(
              event => {
                if ('kind' in event) {
                  return;
                }
                handlers.onData(new Uint8Array(event.bytes));
              },
              {
                cursor: { mode: 'seq', seq: replay.nextSeq },
                coalesceMs: 16,
              },
            );

            return () => {
              try {
                runtime.shell.removeListener(listenerId);
              } catch {}
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
          if (
            !host ||
            (!isSshHostRecord(host) && !isAwsEc2HostRecord(host))
          ) {
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
          const runtime = runtimeSftpSessions.get(sftpSessionId);
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

          if (runtime) {
            try {
              await runtime.connection.close();
            } catch {}
          }
          disconnectRuntimeSftpSession(sftpSessionId);
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
                : '파일 다운로드에 실패했습니다.';
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
                  : '파일 다운로드에 실패했습니다.';
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
                    patchSftpTransferRecord(nextTransfers, completion.transferId, {
                      status: 'completed',
                      bytesTransferred: completion.bytesTransferred,
                    }),
                  state.sftpTransfers,
                ),
              }));
            } catch (error) {
              try {
                await deleteDownloadDestination(destinationDirectory.uri);
              } catch {}
              const message =
                error instanceof Error ? error.message : '저장에 실패했습니다.';
              set(state => ({
                sftpTransfers: pendingExportCompletions.reduce(
                  (nextTransfers, completion) =>
                    patchSftpTransferRecord(nextTransfers, completion.transferId, {
                      status: 'error',
                      errorMessage: message,
                      bytesTransferred: completion.bytesTransferred,
                    }),
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
                : '파일 업로드에 실패했습니다.';
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
              error instanceof Error ? error.message : '삭제에 실패했습니다.';
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
                error instanceof Error ? error.message : '복사에 실패했습니다.';
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
  russhInitPromise = null;
  secureStateRestoreVersion = 0;
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
