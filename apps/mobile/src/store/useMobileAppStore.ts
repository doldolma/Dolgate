import { Buffer } from "buffer";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { Linking } from "react-native";
import { RnRussh } from "@fressh/react-native-uniffi-russh";
import type {
  AwsEc2HostRecord,
  AwsSsmSessionClientMessage,
  AwsSsmSessionServerMessage,
  AuthSession,
  AuthState,
  GroupRecord,
  HostRecord,
  HostSecretInput,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  ManagedAwsProfilePayload,
  MobileSessionRecord,
  MobileSettings,
  SecretMetadataRecord,
  SshHostRecord,
  SyncStatus,
} from "@dolssh/shared-core";
import { isAwsEc2HostRecord, isSshHostRecord } from "@dolssh/shared-core";
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
} from "../lib/mobile";
import {
  getAuthCallbackStateErrorMessage,
  getSyncFailureMessage,
} from "../lib/auth-flow";
import {
  type AwsSsoBrowserLoginPrompt,
  resolveAwsSessionForHost,
} from "../lib/aws-session";
import { openAwsSsoBrowser } from "../lib/aws-sso-bridge";
import {
  getCurrentWindowTerminalGridSize,
  toRusshTerminalSize,
} from "../lib/terminal-size";

const MAX_TERMINAL_SNAPSHOT_CHARS = 8_000;
const MAX_PERSISTED_SESSIONS = 24;
const SESSION_SNAPSHOT_FLUSH_MS = 750;
const STARTUP_REFRESH_TIMEOUT_MS = 3_000;
const STARTUP_REFRESH_TIMEOUT_MESSAGE =
  "서버 응답이 지연되고 있습니다. 다시 시도해 주세요.";
const OFFLINE_RECOVERY_RETRY_DELAYS_MS = [2_000, 5_000, 5_000, 5_000] as const;
const SECURE_STATE_LOADING_MESSAGE =
  "저장된 보안 정보를 복구하는 중입니다. 잠시 후 다시 시도해 주세요.";
interface PendingServerKeyPromptState {
  hostId: string;
  hostLabel: string;
  status: "untrusted" | "mismatch";
  info: MobileServerPublicKeyInfo;
  existing?: KnownHostRecord | null;
}

interface PendingCredentialPromptState {
  hostId: string;
  hostLabel: string;
  authType: "password" | "privateKey";
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

interface SshRuntimeSession {
  kind: "ssh";
  recordId: string;
  hostId: string;
  connection: Awaited<ReturnType<typeof RnRussh.connect>>;
  shell: Awaited<
    ReturnType<Awaited<ReturnType<typeof RnRussh.connect>>["startShell"]>
  >;
  backgroundListenerId: bigint | null;
}

interface AwsRuntimeSession {
  kind: "aws-ssm";
  recordId: string;
  hostId: string;
  socket: WebSocket;
  replayChunks: Uint8Array[];
  subscribers: Map<string, SessionTerminalSubscription>;
}

type RuntimeSession = SshRuntimeSession | AwsRuntimeSession;

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
  activeSessionTabId: string | null;
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
}

const runtimeSessions = new Map<string, RuntimeSession>();
const pendingSessionConnections = new Set<string>();
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
let pendingServerKeyResolver: ((accepted: boolean) => void) | null = null;
let pendingCredentialResolver:
  | ((value: HostSecretInput | null) => void)
  | null = null;
let pendingAwsSsoCancelHandler: (() => void) | null = null;

function sortHosts(hosts: HostRecord[]): HostRecord[] {
  return [...hosts].sort((left, right) => left.label.localeCompare(right.label));
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
  return session.status !== "closed";
}

function getLiveSessions(sessions: MobileSessionRecord[]): MobileSessionRecord[] {
  return sortSessions(sessions).filter(isLiveSession);
}

function resolveActiveSessionTabId(
  sessions: MobileSessionRecord[],
  currentActiveSessionTabId: string | null,
  preferredSessionId?: string | null,
): string | null {
  const liveSessions = getLiveSessions(sessions);
  if (preferredSessionId) {
    const preferredSession = liveSessions.find(
      (session) => session.id === preferredSessionId,
    );
    if (preferredSession) {
      return preferredSession.id;
    }
  }

  if (currentActiveSessionTabId) {
    const currentSession = liveSessions.find(
      (session) => session.id === currentActiveSessionTabId,
    );
    if (currentSession) {
      return currentSession.id;
    }
  }

  return liveSessions[0]?.id ?? null;
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
    sessions.map((session) =>
      session.id === sessionId ? { ...session, ...patch } : session,
    ),
  );
}

function upsertSessionRecord(
  sessions: MobileSessionRecord[],
  nextRecord: MobileSessionRecord,
): MobileSessionRecord[] {
  const existingIndex = sessions.findIndex((session) => session.id === nextRecord.id);
  if (existingIndex === -1) {
    return sortSessions([nextRecord, ...sessions]);
  }

  const nextSessions = [...sessions];
  nextSessions[existingIndex] = nextRecord;
  return sortSessions(nextSessions);
}

function createSessionRecord(host: HostRecord): MobileSessionRecord {
  const now = new Date().toISOString();
  const id = createLocalId("session");
  const connectionKind = host.kind === "aws-ec2" ? "aws-ssm" : "ssh";
  const connectionDetails =
    host.kind === "aws-ec2"
      ? [host.awsProfileName, host.awsRegion, host.awsInstanceId]
          .filter(Boolean)
          .join(" · ")
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
    status: "connecting",
    hasReceivedOutput: false,
    isRestorable: true,
    lastViewportSnapshot: "",
    lastEventAt: now,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    errorMessage: null,
  };
}

function compactPersistedSessions(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  return sortSessions(sessions)
    .slice(0, MAX_PERSISTED_SESSIONS)
    .map((session) => ({
      ...session,
      lastViewportSnapshot:
        session.status === "closed" || session.status === "error"
          ? trimSnapshot(session.lastViewportSnapshot)
          : "",
    }));
}

function normalizePersistedSessionsForColdStart(
  sessions: MobileSessionRecord[],
): MobileSessionRecord[] {
  const now = new Date().toISOString();
  return sortSessions(
    sessions.map((session) => {
      if (!isLiveSession(session)) {
        return session;
      }

      return {
        ...session,
        status: "closed",
        errorMessage: null,
        lastEventAt: now,
        lastDisconnectedAt: session.lastDisconnectedAt ?? now,
      };
    }),
  );
}

function buildOfflineState(session: AuthSession, reason: string) {
  return {
    expiresAt: session.offlineLease.expiresAt,
    lastOnlineAt: new Date().toISOString(),
    reason,
  };
}

function isOfflineLeaseActive(session: AuthSession | null | undefined): boolean {
  if (!session?.offlineLease.expiresAt) {
    return false;
  }
  return new Date(session.offlineLease.expiresAt).getTime() > Date.now();
}

function isLikelyNetworkError(error: unknown): boolean {
  return !(error instanceof ApiError) || typeof error.status !== "number";
}

function buildOfflineRecoveryKey(
  session: AuthSession,
  serverUrl: string,
): string {
  return `${serverUrl.trim()}::${session.tokens.refreshToken}`;
}

function createEmptyProtectedState(): Pick<
  MobileAppState,
  | "groups"
  | "hosts"
  | "awsProfiles"
  | "knownHosts"
  | "secretMetadata"
  | "secretsByRef"
  | "sessions"
  | "activeSessionTabId"
> {
  return {
    groups: [],
    hosts: [],
    awsProfiles: [],
    knownHosts: [],
    secretMetadata: [],
    secretsByRef: {},
    sessions: [],
    activeSessionTabId: null,
  };
}

function parseAuthCallbackUrl(
  url: string,
): { code: string; state?: string | null } | null {
  if (!url.startsWith("dolgate://auth/callback")) {
    return null;
  }

  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return null;
  }

  const rawQuery = url.slice(queryIndex + 1);
  const searchParams = new URLSearchParams(rawQuery);
  const code = searchParams.get("code");
  if (!code) {
    return null;
  }

  return {
    code,
    state: searchParams.get("state"),
  };
}

function getKnownHostStatus(
  knownHosts: KnownHostRecord[],
  info: MobileServerPublicKeyInfo,
): {
  status: "trusted" | "untrusted" | "mismatch";
  existing: KnownHostRecord | null;
} {
  const exactMatch =
    knownHosts.find(
      (record) =>
        record.host === info.host &&
        record.port === info.port &&
        record.publicKeyBase64 === info.keyBase64,
    ) ?? null;
  if (exactMatch) {
    return { status: "trusted", existing: exactMatch };
  }

  const sameTarget =
    knownHosts.find(
      (record) => record.host === info.host && record.port === info.port,
    ) ?? null;
  if (sameTarget) {
    return { status: "mismatch", existing: sameTarget };
  }

  return { status: "untrusted", existing: null };
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

  if (runtime.kind === "ssh") {
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

async function disconnectAllRuntimeSessions(): Promise<void> {
  for (const session of [...runtimeSessions.values()]) {
    if (session.kind === "ssh") {
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

      const clearPersistedSecureState = async (
        options?: {
          clearStoredAuthSession?: boolean;
        },
      ) => {
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

      const resolveAuthGate = (
        nextState: Partial<
          Pick<
            MobileAppState,
            | "auth"
            | "syncStatus"
            | "secretsByRef"
            | "secretMetadata"
            | "awsProfiles"
            | "groups"
            | "hosts"
            | "knownHosts"
            | "sessions"
            | "activeSessionTabId"
          >
        >,
      ) => {
        set({
          ...nextState,
          bootstrapping: false,
          authGateResolved: true,
          secureStateReady: true,
        });
      };

      const ensureRusshInitialized = async () => {
        if (russhInitPromise) {
          return russhInitPromise;
        }

        russhInitPromise = RnRussh.uniffiInitAsync().catch((error) => {
          russhInitPromise = null;
          throw error;
        });
        return russhInitPromise;
      };

      const retrySessionRecoveryInBackground = async (
        session: AuthSession,
        serverUrl: string,
      ): Promise<"recovered" | "retry" | "stop"> => {
        try {
          const refreshed = await refreshAuthSession(serverUrl, session);
          const currentSession = get().auth.session;
          if (
            !currentSession ||
            currentSession.tokens.refreshToken !== session.tokens.refreshToken ||
            get().settings.serverUrl !== serverUrl
          ) {
            return "stop";
          }

          await saveStoredAuthSession(refreshed);
          set((state) => ({
            auth: {
              status: "authenticated",
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
            return "stop";
          }
          if (postRecoveryAuth.status === "offline-authenticated") {
            return "retry";
          }
          return postRecoveryAuth.status === "authenticated"
            ? "recovered"
            : "stop";
        } catch (error) {
          const currentSession = get().auth.session;
          if (
            !currentSession ||
            currentSession.tokens.refreshToken !== session.tokens.refreshToken ||
            get().settings.serverUrl !== serverUrl
          ) {
            return "stop";
          }

          if (error instanceof ApiError && error.status === 401) {
            await clearPersistedSecureState();
            clearOfflineRecoveryLoop();
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: "세션이 만료되어 다시 로그인해야 합니다.",
              },
              syncStatus: {
                ...createDefaultSyncStatus(),
                status: "error",
                errorMessage: "세션이 만료되었습니다.",
              },
              ...createEmptyProtectedState(),
              authGateResolved: true,
              secureStateReady: true,
              bootstrapping: false,
            });
            return "stop";
          }

          set((state) => ({
            syncStatus: {
              ...state.syncStatus,
              status: "paused",
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "네트워크에 연결할 수 없습니다.",
            },
          }));
          return "retry";
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
            if (result === "recovered" || result === "stop") {
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
          set((state) => ({
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
          set((state) => ({
            syncStatus: {
              ...state.syncStatus,
              pendingPush: false,
              errorMessage: null,
              status: "ready",
              lastSuccessfulSyncAt: new Date().toISOString(),
            },
          }));
        } catch (error) {
          set((state) => ({
            syncStatus: {
              ...state.syncStatus,
              pendingPush: true,
              status: "error",
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "known host 동기화에 실패했습니다.",
            },
          }));
        }
      };

      const resolveKnownHostTrust = async (
        host: SshHostRecord,
        info: MobileServerPublicKeyInfo,
      ): Promise<boolean> => {
        const { status, existing } = getKnownHostStatus(get().knownHosts, info);
        if (status === "trusted") {
          const refreshedRecord = buildKnownHostRecord(info, existing);
          set((state) => ({
            knownHosts: sortKnownHosts(
              state.knownHosts.map((record) =>
                record.id === refreshedRecord.id ? refreshedRecord : record,
              ),
            ),
          }));
          return true;
        }

        const accepted = await new Promise<boolean>((resolve) => {
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
          get().knownHosts.filter((record) => record.id !== trustedRecord.id),
        );
        const mergedKnownHosts = sortKnownHosts([
          ...nextKnownHosts,
          trustedRecord,
        ]);

        set((state) => ({
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
        new Promise<HostSecretInput | null>((resolve) => {
          pendingCredentialResolver = resolve;
          set({
            pendingCredentialPrompt: {
              hostId: host.id,
              hostLabel: host.label,
              authType: host.authType === "privateKey" ? "privateKey" : "password",
              message,
              initialValue,
            },
          });
        });

      const resolveHostCredentials = async (
        host: SshHostRecord,
      ): Promise<HostSecretInput | null> => {
        const existing = host.secretRef ? get().secretsByRef[host.secretRef] : undefined;
        const promptBase: HostSecretInput = {
          password: existing?.password,
          passphrase: existing?.passphrase,
          privateKeyPem: existing?.privateKeyPem,
          certificateText: existing?.certificateText,
        };

        if (host.authType === "password") {
          if (promptBase.password) {
            return promptBase;
          }

          const prompted = await promptForCredentials(
            host,
            promptBase,
            "비밀번호를 입력해 주세요.",
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

        if (host.authType === "privateKey") {
          if (promptBase.privateKeyPem) {
            return promptBase;
          }

          const prompted = await promptForCredentials(
            host,
            promptBase,
            host.privateKeyPath
              ? "데스크톱 파일 경로 대신 PEM 개인키를 붙여넣거나 가져와 주세요."
              : "개인키 PEM을 입력하거나 파일에서 가져와 주세요.",
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

        set((state) => {
          const current = state.sessions.find((session) => session.id === sessionId);
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

          const nextSessions = patchSessionRecord(state.sessions, sessionId, patch);
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
        status: MobileSessionRecord["status"],
        errorMessage?: string | null,
      ) => {
        const now = new Date().toISOString();
        set((state) => {
          const nextSessions = patchSessionRecord(state.sessions, sessionId, {
            status,
            errorMessage: errorMessage ?? null,
            isRestorable: true,
            lastEventAt: now,
            lastDisconnectedAt:
              status === "closed" || status === "error" ? now : undefined,
          });
          return {
            sessions: nextSessions,
            activeSessionTabId: resolveActiveSessionTabId(
              nextSessions,
              state.activeSessionTabId === sessionId && status === "closed"
                ? null
                : state.activeSessionTabId,
            ),
          };
        });
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
          get().sessions.find((item) => item.id === sessionRecord.id)
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
          "error",
          "이 호스트 종류는 모바일에서 아직 지원하지 않습니다.",
        );
        pendingSessionConnections.delete(sessionRecord.id);
      };

      const connectSshSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: SshHostRecord,
      ) => {
        try {
          if (host.authType !== "password" && host.authType !== "privateKey") {
            markSessionState(
              sessionRecord.id,
              "error",
              "이 인증 방식은 모바일 v1에서 아직 지원하지 않습니다.",
              );
              return;
            }

          await ensureRusshInitialized();
          const credentials = await resolveHostCredentials(host);
          if (!credentials) {
            markSessionState(sessionRecord.id, "closed", "연결이 취소되었습니다.");
            return;
          }

          const security =
            host.authType === "password"
              ? credentials.password
                ? {
                    type: "password" as const,
                    password: credentials.password,
                  }
                : null
              : credentials.privateKeyPem
                ? {
                    type: "key" as const,
                    privateKey: credentials.privateKeyPem,
                  }
                : null;

          if (!security) {
            markSessionState(
              sessionRecord.id,
              "error",
              host.authType === "password"
                ? "비밀번호가 필요합니다."
                : "개인키 PEM이 필요합니다.",
            );
            return;
          }

          if (security.type === "key") {
            const validation = RnRussh.validatePrivateKey(security.privateKey);
            if (!validation.valid) {
              markSessionState(
                sessionRecord.id,
                "error",
                "개인키 형식을 확인해 주세요. 암호화된 개인키는 아직 지원하지 않을 수 있습니다.",
              );
              return;
            }
          }

          const connectionStartedAt = new Date().toISOString();
          set((state) => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: "connecting",
              errorMessage: null,
              lastEventAt: connectionStartedAt,
              connectionKind: "ssh",
              connectionDetails: `${host.username}@${host.hostname}:${host.port}`,
            }),
          }));

          const connection = await RnRussh.connect({
            host: host.hostname,
            port: host.port,
            username: host.username,
            security,
            onServerKey: async (info) => resolveKnownHostTrust(host, info),
            onDisconnected: () => {
              flushSessionSnapshot(sessionRecord.id, {
                markActivity: false,
              });
              disconnectRuntimeSession(sessionRecord.id);
              markSessionState(sessionRecord.id, "closed");
            },
          });
          const terminalSize = getCurrentWindowTerminalGridSize();
          const shell = await connection.startShell({
            term: "Xterm",
            terminalSize: toRusshTerminalSize(terminalSize),
            onClosed: () => {
              flushSessionSnapshot(sessionRecord.id, {
                markActivity: false,
              });
              disconnectRuntimeSession(sessionRecord.id);
              markSessionState(sessionRecord.id, "closed");
            },
          });

          const backgroundListenerId = shell.addListener(
            (event) => {
              if ("kind" in event) {
                return;
              }
              const text = Buffer.from(event.bytes).toString("utf8");
              const currentSnapshot =
                runtimeSessionSnapshots.get(sessionRecord.id) ?? "";
              runtimeSessionSnapshots.set(
                sessionRecord.id,
                trimSnapshot(`${currentSnapshot}${text}`),
              );
              scheduleSessionSnapshotFlush(sessionRecord.id);
            },
            {
              cursor: { mode: "live" },
              coalesceMs: 20,
            },
          );

          runtimeSessions.set(sessionRecord.id, {
            kind: "ssh",
            recordId: sessionRecord.id,
            hostId: host.id,
            connection,
            shell,
            backgroundListenerId,
          });

          set((state) => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: "connected",
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
              lastConnectedAt: new Date().toISOString(),
              title: host.label,
              connectionKind: "ssh",
              connectionDetails: `${host.username}@${host.hostname}:${host.port}`,
            }),
          }));
        } catch (error) {
          disconnectRuntimeSession(sessionRecord.id);
          markSessionState(
            sessionRecord.id,
            "error",
            error instanceof Error ? error.message : "SSH 연결에 실패했습니다.",
          );
        } finally {
          pendingSessionConnections.delete(sessionRecord.id);
        }
      };

      const connectAwsSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: AwsEc2HostRecord,
      ) => {
        try {
          const accessToken = get().auth.session?.tokens.accessToken;
          if (!accessToken) {
            markSessionState(
              sessionRecord.id,
              "error",
              "AWS 세션을 시작하려면 다시 로그인해야 합니다.",
            );
            return;
          }

          let awsSsmServerSupport = get().syncStatus.awsSsmServerSupport;
          if (awsSsmServerSupport === "unknown") {
            try {
              const serverInfo = await fetchServerInfo(get().settings.serverUrl);
              awsSsmServerSupport = serverInfo.capabilities.sessions.awsSsm
                ? "supported"
                : "unsupported";
              set((state) => ({
                syncStatus: {
                  ...state.syncStatus,
                  awsProfilesServerSupport: serverInfo.capabilities.sync
                    .awsProfiles
                    ? "supported"
                    : "unsupported",
                  awsSsmServerSupport,
                },
              }));
            } catch {}
          }

          if (awsSsmServerSupport === "unsupported") {
            markSessionState(
              sessionRecord.id,
              "error",
              "이 서버는 AWS SSM 세션을 지원하지 않습니다.",
            );
            return;
          }

          const resolvedSession = await resolveAwsSessionForHost({
            host,
            profiles: get().awsProfiles,
            serverUrl: get().settings.serverUrl,
            authAccessToken: accessToken,
            presentLoginPrompt: (prompt) => {
              pendingAwsSsoCancelHandler = prompt.onCancel;
              set({ pendingAwsSsoLogin: prompt });
            },
            dismissLoginPrompt: () => {
              pendingAwsSsoCancelHandler = null;
              set({ pendingAwsSsoLogin: null });
            },
          });
          const terminalSize = getCurrentWindowTerminalGridSize();
          const wsUrl = new URL(
            "/api/aws-sessions/ws",
            get().settings.serverUrl,
          );
          wsUrl.searchParams.set("access_token", accessToken);
          const wsProtocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
          const wsEndpoint = `${wsProtocol}//${wsUrl.host}${wsUrl.pathname}${wsUrl.search}`;

          const socket = new (WebSocket as unknown as ReactNativeWebSocketConstructor)(
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
            kind: "aws-ssm",
            recordId: sessionRecord.id,
            hostId: host.id,
            socket,
            replayChunks: [],
            subscribers: new Map<string, SessionTerminalSubscription>(),
          };
          runtimeSessions.set(sessionRecord.id, nextRuntime);

          set((state) => ({
            sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
              status: "connecting",
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
              title: host.label,
              connectionKind: "aws-ssm",
              connectionDetails: resolvedSession.connectionDetails,
            }),
          }));

          socket.onopen = () => {
            socketOpened = true;
            const message: AwsSsmSessionClientMessage = {
              type: "start",
              payload: {
                hostId: host.id,
                label: host.label,
                // Mobile sends resolved env credentials, so the server should not
                // depend on a matching profile file being present in the container.
                profileName: "",
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

          socket.onmessage = (event) => {
            receivedServerMessage = true;
            const message = JSON.parse(
              String(event.data),
            ) as AwsSsmSessionServerMessage;
            if (message.type === "ready") {
              pendingSessionConnections.delete(sessionRecord.id);
              set((state) => ({
                sessions: patchSessionRecord(state.sessions, sessionRecord.id, {
                  status: "connected",
                  errorMessage: null,
                  lastEventAt: new Date().toISOString(),
                  lastConnectedAt: new Date().toISOString(),
                  title: host.label,
                  connectionKind: "aws-ssm",
                  connectionDetails: resolvedSession.connectionDetails,
                }),
              }));
              return;
            }

            if (message.type === "output" && message.dataBase64) {
              const chunk = Uint8Array.from(
                Buffer.from(message.dataBase64, "base64"),
              );
              const text = Buffer.from(chunk).toString("utf8");
              const currentSnapshot =
                runtimeSessionSnapshots.get(sessionRecord.id) ?? "";
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

            if (message.type === "error") {
              pendingSessionConnections.delete(sessionRecord.id);
              markSessionState(
                sessionRecord.id,
                "error",
                message.message || "AWS SSM 연결에 실패했습니다.",
              );
              return;
            }

            if (message.type === "exit") {
              flushSessionSnapshot(sessionRecord.id, {
                markActivity: false,
              });
              disconnectRuntimeSession(sessionRecord.id);
              const currentSession = get().sessions.find(
                (item) => item.id === sessionRecord.id,
              );
              if (currentSession?.status === "error") {
                return;
              }

              if (
                currentSession &&
                currentSession.status !== "disconnecting" &&
                (currentSession.status === "connecting" ||
                  !currentSession.hasReceivedOutput)
              ) {
                markSessionState(
                  sessionRecord.id,
                  "error",
                  message.message || "AWS SSM 세션이 시작 직후 종료되었습니다.",
                );
                return;
              }

              markSessionState(
                sessionRecord.id,
                "closed",
                message.message || null,
              );
            }
          };

          socket.onerror = () => {
            pendingSessionConnections.delete(sessionRecord.id);
            if (socketOpened || receivedServerMessage) {
              return;
            }
            markSessionState(
              sessionRecord.id,
              "error",
              "AWS SSM WebSocket 연결에 실패했습니다.",
            );
          };

          socket.onclose = () => {
            flushSessionSnapshot(sessionRecord.id, {
              markActivity: false,
            });
            disconnectRuntimeSession(sessionRecord.id);
            const currentSession = get().sessions.find(
              (item) => item.id === sessionRecord.id,
            );
            if (
              currentSession &&
              currentSession.status !== "closed" &&
              currentSession.status !== "error"
            ) {
              if (
                currentSession.status !== "disconnecting" &&
                (currentSession.status === "connecting" ||
                  !currentSession.hasReceivedOutput)
              ) {
                markSessionState(
                  sessionRecord.id,
                  "error",
                  "AWS SSM 세션이 예기치 않게 종료되었습니다.",
                );
                return;
              }
              markSessionState(sessionRecord.id, "closed");
            }
          };
        } catch (error) {
          disconnectRuntimeSession(sessionRecord.id);
          markSessionState(
            sessionRecord.id,
            "error",
            error instanceof Error
              ? error.message
              : "AWS SSM 연결에 실패했습니다.",
          );
        } finally {
          pendingSessionConnections.delete(sessionRecord.id);
        }
      };

      const syncWithSession = async (
        sessionOverride?: AuthSession | null,
        options?: {
          context?: "login" | "sync";
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
          set((state) => ({
            syncStatus: {
              ...state.syncStatus,
              status: "syncing",
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
                    status: "authenticated",
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
              auth: {
                status: "authenticated",
                session: currentSession,
                offline: null,
                errorMessage: null,
              },
              syncStatus: {
                status: "ready",
                pendingPush: false,
                errorMessage: null,
                lastSuccessfulSyncAt: new Date().toISOString(),
                awsProfilesServerSupport:
                  serverInfo?.capabilities.sync.awsProfiles === true
                    ? "supported"
                    : serverInfo?.capabilities.sync.awsProfiles === false
                      ? "unsupported"
                      : "unknown",
                awsSsmServerSupport:
                  serverInfo?.capabilities.sessions.awsSsm === true
                    ? "supported"
                    : serverInfo?.capabilities.sessions.awsSsm === false
                      ? "unsupported"
                      : "unknown",
              },
            });
          } catch (error) {
            if (isLikelyNetworkError(error) && isOfflineLeaseActive(currentSession)) {
              set({
                auth: {
                  status: "offline-authenticated",
                  session: currentSession,
                  offline: buildOfflineState(
                    currentSession,
                    "네트워크 없이 캐시된 데이터를 사용하고 있습니다.",
                  ),
                  errorMessage: null,
                },
                syncStatus: {
                  ...get().syncStatus,
                  status: "paused",
                  errorMessage:
                    error instanceof Error
                      ? error.message
                      : "네트워크에 연결할 수 없습니다.",
                },
              });
              scheduleOfflineRecoveryRetry(currentSession, get().settings.serverUrl, {
                reset: true,
              });
              return;
            }

            if (error instanceof ApiError && error.status === 401) {
              await clearPersistedSecureState();
              clearOfflineRecoveryLoop();
              set({
                auth: {
                  ...createUnauthenticatedState(),
                  errorMessage: "세션이 만료되어 다시 로그인해야 합니다.",
                },
                syncStatus: {
                  ...createDefaultSyncStatus(),
                  status: "error",
                  errorMessage: "세션이 만료되었습니다.",
                },
                ...createEmptyProtectedState(),
              });
              return;
            }

            set((state) => ({
              syncStatus: {
                ...state.syncStatus,
                status: "error",
                errorMessage: getSyncFailureMessage(
                  error,
                  options?.context ?? "sync",
                ),
              },
            }));
          } finally {
            syncPromise = null;
          }
        })();

        return syncPromise;
      };

      const clearPrompts = () => {
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
        activeSessionTabId: null,
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
              const storedSessionPromise = loadStoredAuthSession();
              const storedSecretsPromise = loadStoredSecrets().then((secretsByRef) => {
                set((state) => ({
                  secretsByRef,
                  secretMetadata: deriveSecretMetadata(state.hosts, secretsByRef),
                }));
                return secretsByRef;
              });
              const storedAwsProfilesPromise = loadStoredAwsProfiles().then((awsProfiles) => {
                set({
                  awsProfiles,
                });
                return awsProfiles;
              });

              const [storedSession] = await Promise.all([
                storedSessionPromise,
                storedSecretsPromise,
                storedAwsProfilesPromise,
              ]);
              if (!storedSession) {
                clearOfflineRecoveryLoop();
                resolveAuthGate({
                  auth: createUnauthenticatedState(),
                  syncStatus: createDefaultSyncStatus(),
                  ...createEmptyProtectedState(),
                });
                void clearPersistedSecureState();
                return;
              }

              const currentServerUrl = get().settings.serverUrl;
              try {
                const refreshed = await refreshAuthSession(
                  currentServerUrl,
                  storedSession,
                  {
                    timeoutMs: STARTUP_REFRESH_TIMEOUT_MS,
                    timeoutMessage: STARTUP_REFRESH_TIMEOUT_MESSAGE,
                  },
                );
                clearOfflineRecoveryLoop();
                resolveAuthGate({
                  auth: {
                    status: "authenticated",
                    session: refreshed,
                    offline: null,
                    errorMessage: null,
                  },
                  syncStatus: {
                    ...get().syncStatus,
                    errorMessage: null,
                  },
                });
                void saveStoredAuthSession(refreshed);
                void syncWithSession(refreshed);
              } catch (error) {
                if (isLikelyNetworkError(error) && isOfflineLeaseActive(storedSession)) {
                  resolveAuthGate({
                    auth: {
                      status: "offline-authenticated",
                      session: storedSession,
                      offline: buildOfflineState(
                        storedSession,
                        "네트워크 없이 저장된 세션을 복구했습니다.",
                      ),
                      errorMessage: null,
                    },
                    syncStatus: {
                      ...get().syncStatus,
                      status: "paused",
                      errorMessage:
                        error instanceof Error
                          ? error.message
                          : "네트워크에 연결할 수 없습니다.",
                    },
                  });
                  scheduleOfflineRecoveryRetry(
                    storedSession,
                    currentServerUrl,
                    {
                      immediate: true,
                      reset: true,
                    },
                  );
                  return;
                }

                const shouldClearStoredAuthSession =
                  error instanceof ApiError && error.status === 401;
                clearOfflineRecoveryLoop();
                resolveAuthGate({
                  auth: {
                    ...createUnauthenticatedState(),
                    errorMessage:
                      error instanceof Error
                        ? error.message
                        : "로그인 세션을 복구하지 못했습니다.",
                  },
                  syncStatus: createDefaultSyncStatus(),
                  ...createEmptyProtectedState(),
                });
                void clearPersistedSecureState({
                  clearStoredAuthSession: shouldClearStoredAuthSession,
                });
              }
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

          set((state) => ({
            auth: {
              ...state.auth,
              status: "authenticating",
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
                status: "authenticated",
                session,
                offline: null,
                errorMessage: null,
              },
              pendingBrowserLoginState: null,
            });
            await syncWithSession(session, { context: "login" });
          } catch (error) {
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : "로그인 교환에 실패했습니다.",
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
              status: "authenticating",
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
                    : "브라우저 로그인을 시작하지 못했습니다.",
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
            set((state) => ({
              auth: {
                ...state.auth,
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : "브라우저를 다시 열지 못했습니다.",
              },
            }));
          }
        },
        logout: async () => {
          clearOfflineRecoveryLoop();
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
            activeSessionTabId: null,
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

          if (typeof input.serverUrl === "string") {
            const validationMessage = getSettingsValidationMessage(input.serverUrl);
            if (validationMessage) {
              set((state) => ({
                auth: {
                  ...state.auth,
                  errorMessage: validationMessage,
                },
              }));
              return;
            }
          }

          const serverChanged =
            typeof input.serverUrl === "string" &&
            input.serverUrl.trim() !== get().settings.serverUrl;

          if (serverChanged) {
            clearOfflineRecoveryLoop();
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
                  ? "서버 주소가 변경되어 다시 로그인해 주세요."
                  : null,
              },
              groups: [],
              hosts: [],
              awsProfiles: [],
              knownHosts: [],
              secretMetadata: [],
              secretsByRef: {},
              sessions: [],
              activeSessionTabId: null,
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
            set((state) => ({
              syncStatus: {
                ...state.syncStatus,
                errorMessage: SECURE_STATE_LOADING_MESSAGE,
              },
            }));
            return null;
          }

          const host = get().hosts.find((item) => item.id === hostId);
          if (!host) {
            return null;
          }

          const liveSession = get().sessions.find(
            (session) => session.hostId === hostId && isLiveSession(session),
          );
          if (liveSession) {
            get().setActiveSessionTab(liveSession.id);
            if (
              !runtimeSessions.has(liveSession.id) &&
              !pendingSessionConnections.has(liveSession.id) &&
              liveSession.status !== "connecting" &&
              liveSession.status !== "disconnecting"
            ) {
              void get().resumeSession(liveSession.id);
            }
            return liveSession.id;
          }

          const nextSession = createSessionRecord(host);
          set((state) => {
            const nextSessions = upsertSessionRecord(state.sessions, nextSession);
            return {
              sessions: nextSessions,
              activeSessionTabId: resolveActiveSessionTabId(
                nextSessions,
                state.activeSessionTabId,
                nextSession.id,
              ),
            };
          });
          void connectSessionRecord(nextSession, host);
          return nextSession.id;
        },
        setActiveSessionTab: (sessionId: string | null) => {
          set((state) => ({
            activeSessionTabId: resolveActiveSessionTabId(
              state.sessions,
              state.activeSessionTabId,
              sessionId,
            ),
          }));
        },
        resumeSession: async (sessionId: string) => {
          const session = get().sessions.find((item) => item.id === sessionId);
          if (!session) {
            return null;
          }

          get().setActiveSessionTab(session.id);

          if (
            runtimeSessions.has(session.id) ||
            pendingSessionConnections.has(session.id) ||
            session.status === "connecting" ||
            session.status === "disconnecting"
          ) {
            return session.id;
          }

          const host = get().hosts.find((item) => item.id === session.hostId);
          if (!host) {
            markSessionState(
              session.id,
              "error",
              "이 세션의 호스트 정보를 찾을 수 없습니다.",
            );
            return session.id;
          }

          set((state) => {
            const nextSessions = patchSessionRecord(state.sessions, session.id, {
              status: "connecting",
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
            });
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
            markSessionState(sessionId, "closed");
            return;
          }

          set((state) => ({
            sessions: patchSessionRecord(state.sessions, sessionId, {
              status: "disconnecting",
              lastEventAt: new Date().toISOString(),
            }),
          }));

          if (runtime.kind === "ssh") {
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
          markSessionState(sessionId, "closed");
        },
        removeSession: async (sessionId: string) => {
          const runtime = runtimeSessions.get(sessionId);

          set((state) => {
            const nextSessions = sortSessions(
              state.sessions.filter((session) => session.id !== sessionId),
            );
            return {
              sessions: nextSessions,
              activeSessionTabId: resolveActiveSessionTabId(
                nextSessions,
                state.activeSessionTabId === sessionId
                  ? null
                  : state.activeSessionTabId,
              ),
            };
          });

          if (!runtime) {
            pendingSessionConnections.delete(sessionId);
            disconnectRuntimeSession(sessionId);
            return;
          }

          disconnectRuntimeSession(sessionId);

          if (runtime.kind === "ssh") {
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
          const bytes = Buffer.from(data, "utf8");
          if (runtime.kind === "ssh") {
            await runtime.shell.sendData(
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ),
            );
            return;
          }

          const message: AwsSsmSessionClientMessage = {
            type: "input",
            dataBase64: bytes.toString("base64"),
          };
          runtime.socket.send(JSON.stringify(message));
        },
        subscribeToSessionTerminal: (sessionId, handlers) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            return () => {};
          }

          if (runtime.kind === "ssh") {
            const replay = runtime.shell.readBuffer({ mode: "head" });
            handlers.onReplay(
              replay.chunks.map((chunk) => new Uint8Array(chunk.bytes)),
            );

            const listenerId = runtime.shell.addListener(
              (event) => {
                if ("kind" in event) {
                  return;
                }
                handlers.onData(new Uint8Array(event.bytes));
              },
              {
                cursor: { mode: "seq", seq: replay.nextSeq },
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
                        get().sessions.find((item) => item.id === sessionId)
                          ?.lastViewportSnapshot ?? "",
                        "utf8",
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
      name: "dolgate-mobile-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        settings: state.settings,
        syncStatus: state.syncStatus,
        groups: state.groups,
        hosts: state.hosts,
        knownHosts: state.knownHosts,
        secretMetadata: state.secretMetadata,
        sessions: compactPersistedSessions(state.sessions),
        activeSessionTabId: resolveActiveSessionTabId(
          state.sessions,
          state.activeSessionTabId,
        ),
      }),
      onRehydrateStorage: () => () => {
        const nextSessions = normalizePersistedSessionsForColdStart(
          useMobileAppStore.getState().sessions,
        );
        useMobileAppStore.setState((state) => ({
          hydrated: true,
          sessions: nextSessions,
          activeSessionTabId: resolveActiveSessionTabId(nextSessions, null),
        }));
      },
    },
  ),
);

export function resetMobileStoreRuntimeForTests(): void {
  initializePromise = null;
  syncPromise = null;
  russhInitPromise = null;
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
      if (runtime.kind === "ssh") {
        void runtime.connection.disconnect();
      } else {
        runtime.socket.close();
      }
    } catch {}
  }
  runtimeSessions.clear();
  pendingSessionConnections.clear();
  runtimeSessionSnapshots.clear();
  for (const timer of runtimeSnapshotFlushTimers.values()) {
    clearTimeout(timer);
  }
  runtimeSnapshotFlushTimers.clear();
}

export type { MobileAppState, PendingCredentialPromptState, PendingServerKeyPromptState };
