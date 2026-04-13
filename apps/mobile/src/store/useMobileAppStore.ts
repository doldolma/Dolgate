import { Buffer } from "buffer";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { Linking } from "react-native";
import { RnRussh } from "@fressh/react-native-uniffi-russh";
import type {
  AuthSession,
  AuthState,
  HostSecretInput,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  MobileSessionRecord,
  MobileSettings,
  SecretMetadataRecord,
  SshHostRecord,
  SyncStatus,
} from "@dolssh/shared-core";
import {
  buildBrowserLoginUrl,
  buildKnownHostRecord,
  buildKnownHostsSyncPayload,
  clearStoredAuthSession,
  clearStoredSecrets,
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createLocalId,
  createRandomStateToken,
  createUnauthenticatedState,
  decodeKnownHosts,
  decodeManagedSecrets,
  decodeSshHosts,
  deriveSecretMetadata,
  fetchExchangeSession,
  fetchSyncSnapshot,
  getSettingsValidationMessage,
  logoutRemoteSession,
  mergePromptedSecrets,
  MobileServerPublicKeyInfo,
  postSyncSnapshot,
  refreshAuthSession,
  sanitizeTerminalSnapshot,
  saveStoredAuthSession,
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

const MAX_TERMINAL_SNAPSHOT_CHARS = 8_000;
const MAX_PERSISTED_SESSIONS = 24;
const SESSION_SNAPSHOT_FLUSH_MS = 750;
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

interface RuntimeSession {
  recordId: string;
  hostId: string;
  connection: Awaited<ReturnType<typeof RnRussh.connect>>;
  shell: Awaited<
    ReturnType<Awaited<ReturnType<typeof RnRussh.connect>>["startShell"]>
  >;
  backgroundListenerId: bigint | null;
}

interface SessionTerminalSubscription {
  onReplay: (chunks: Uint8Array[]) => void;
  onData: (chunk: Uint8Array) => void;
}

interface MobileAppState {
  hydrated: boolean;
  bootstrapping: boolean;
  auth: AuthState;
  settings: MobileSettings;
  syncStatus: SyncStatus;
  hosts: SshHostRecord[];
  knownHosts: KnownHostRecord[];
  secretMetadata: SecretMetadataRecord[];
  sessions: MobileSessionRecord[];
  secretsByRef: Record<string, LoadedManagedSecretPayload>;
  pendingBrowserLoginState: string | null;
  pendingServerKeyPrompt: PendingServerKeyPromptState | null;
  pendingCredentialPrompt: PendingCredentialPromptState | null;
  initializeApp: () => Promise<void>;
  handleAuthCallbackUrl: (url: string) => Promise<void>;
  startBrowserLogin: () => Promise<void>;
  cancelBrowserLogin: () => void;
  logout: () => Promise<void>;
  syncNow: () => Promise<void>;
  updateSettings: (input: Partial<MobileSettings>) => Promise<void>;
  connectToHost: (hostId: string) => Promise<string | null>;
  resumeSession: (sessionId: string) => Promise<string | null>;
  disconnectSession: (sessionId: string) => Promise<void>;
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

let initializePromise: Promise<void> | null = null;
let syncPromise: Promise<void> | null = null;
let pendingServerKeyResolver: ((accepted: boolean) => void) | null = null;
let pendingCredentialResolver:
  | ((value: HostSecretInput | null) => void)
  | null = null;

function sortHosts(hosts: SshHostRecord[]): SshHostRecord[] {
  return [...hosts].sort((left, right) => left.label.localeCompare(right.label));
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

function createSessionRecord(host: SshHostRecord): MobileSessionRecord {
  const now = new Date().toISOString();
  const id = createLocalId("session");
  return {
    id,
    sessionId: id,
    hostId: host.id,
    title: host.label,
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

  try {
    if (runtime.backgroundListenerId !== null) {
      runtime.shell.removeListener(runtime.backgroundListenerId);
    }
  } catch {}

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
    try {
      await session.connection.disconnect();
    } catch {}
    disconnectRuntimeSession(session.recordId);
  }
}

export const useMobileAppStore = create<MobileAppState>()(
  persist(
    (set, get) => {
      const updateSecretsState = async (
        secretsByRef: Record<string, LoadedManagedSecretPayload>,
        hostsOverride?: SshHostRecord[],
      ) => {
        await saveStoredSecrets(secretsByRef);
        const nextHosts = hostsOverride ?? get().hosts;
        set({
          secretsByRef,
          secretMetadata: deriveSecretMetadata(nextHosts, secretsByRef),
        });
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

          return {
            sessions: patchSessionRecord(state.sessions, sessionId, patch),
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
        set((state) => ({
          sessions: patchSessionRecord(state.sessions, sessionId, {
            status,
            errorMessage: errorMessage ?? null,
            isRestorable: true,
            lastEventAt: now,
            lastDisconnectedAt:
              status === "closed" || status === "error" ? now : undefined,
          }),
        }));
      };

      const connectSessionRecord = async (
        sessionRecord: MobileSessionRecord,
        host: SshHostRecord,
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
        try {
          if (host.authType !== "password" && host.authType !== "privateKey") {
            markSessionState(
              sessionRecord.id,
              "error",
              "이 인증 방식은 모바일 v1에서 아직 지원하지 않습니다.",
            );
            return;
          }

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
          const shell = await connection.startShell({
            term: "Xterm",
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

      const syncWithSession = async (
        sessionOverride?: AuthSession | null,
        options?: {
          context?: "login" | "sync";
        },
      ) => {
        const activeSession = sessionOverride ?? get().auth.session ?? null;
        if (!activeSession) {
          set({
            auth: createUnauthenticatedState(),
            syncStatus: createDefaultSyncStatus(),
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

            const nextHosts = sortHosts(
              decodeSshHosts(payload, currentSession.vaultBootstrap.keyBase64),
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
            set({
              hosts: nextHosts,
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
                awsProfilesServerSupport: "unknown",
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
              return;
            }

            if (error instanceof ApiError && error.status === 401) {
              await clearStoredAuthSession();
              await clearStoredSecrets();
              set({
                auth: {
                  ...createUnauthenticatedState(),
                  errorMessage: "세션이 만료되어 다시 로그인해야 합니다.",
                },
                hosts: [],
                knownHosts: [],
                secretMetadata: [],
                secretsByRef: {},
                sessions: [],
                syncStatus: {
                  ...createDefaultSyncStatus(),
                  status: "error",
                  errorMessage: "세션이 만료되었습니다.",
                },
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
        set({
          pendingServerKeyPrompt: null,
          pendingCredentialPrompt: null,
        });
      };

      return {
        hydrated: false,
        bootstrapping: false,
        auth: createUnauthenticatedState(),
        settings: createDefaultMobileSettings(),
        syncStatus: createDefaultSyncStatus(),
        hosts: [],
        knownHosts: [],
        secretMetadata: [],
        sessions: [],
        secretsByRef: {},
        pendingBrowserLoginState: null,
        pendingServerKeyPrompt: null,
        pendingCredentialPrompt: null,
        initializeApp: async () => {
          if (initializePromise) {
            return initializePromise;
          }

          initializePromise = (async () => {
            set({ bootstrapping: true });

            try {
              await RnRussh.uniffiInitAsync();
            } catch (error) {
              set((state) => ({
                syncStatus: {
                  ...state.syncStatus,
                  status: "error",
                  errorMessage:
                    error instanceof Error
                      ? error.message
                      : "SSH 모듈 초기화에 실패했습니다.",
                },
              }));
            }

            try {
              const secretsByRef = await loadStoredSecrets();
              set((state) => ({
                secretsByRef,
                secretMetadata: deriveSecretMetadata(state.hosts, secretsByRef),
              }));

              const storedSession = await loadStoredAuthSession();
              if (!storedSession) {
                set({
                  auth: createUnauthenticatedState(),
                });
                return;
              }

              try {
                const refreshed = await refreshAuthSession(
                  get().settings.serverUrl,
                  storedSession,
                );
                await saveStoredAuthSession(refreshed);
                set({
                  auth: {
                    status: "authenticated",
                    session: refreshed,
                    offline: null,
                    errorMessage: null,
                  },
                });
                await syncWithSession(refreshed);
              } catch (error) {
                if (isLikelyNetworkError(error) && isOfflineLeaseActive(storedSession)) {
                  set({
                    auth: {
                      status: "offline-authenticated",
                      session: storedSession,
                      offline: buildOfflineState(
                        storedSession,
                        "네트워크 없이 저장된 세션을 복구했습니다.",
                      ),
                      errorMessage: null,
                    },
                  });
                  return;
                }

                await clearStoredAuthSession();
                set({
                  auth: {
                    ...createUnauthenticatedState(),
                    errorMessage:
                      error instanceof Error
                        ? error.message
                        : "로그인 세션을 복구하지 못했습니다.",
                  },
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
        logout: async () => {
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

          set({
            auth: createUnauthenticatedState(),
            hosts: [],
            knownHosts: [],
            secretMetadata: [],
            secretsByRef: {},
            sessions: [],
            syncStatus: createDefaultSyncStatus(),
            pendingBrowserLoginState: null,
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
            await disconnectAllRuntimeSessions();
          }

          if (serverChanged) {
            await clearStoredAuthSession();
            await clearStoredSecrets();
            set({
              auth: {
                ...createUnauthenticatedState(),
                errorMessage: get().auth.session
                  ? "서버 주소가 변경되어 다시 로그인해 주세요."
                  : null,
              },
              hosts: [],
              knownHosts: [],
              secretMetadata: [],
              secretsByRef: {},
              sessions: [],
              syncStatus: createDefaultSyncStatus(),
              pendingBrowserLoginState: null,
            });
          }

          set({
            settings: nextSettings,
          });
        },
        connectToHost: async (hostId: string) => {
          const host = get().hosts.find((item) => item.id === hostId);
          if (!host) {
            return null;
          }

          const liveSession = get().sessions.find(
            (session) =>
              session.hostId === hostId && runtimeSessions.has(session.id),
          );
          if (liveSession) {
            return liveSession.id;
          }

          const latestRestorable = get().sessions.find(
            (session) => session.hostId === hostId && session.isRestorable,
          );
          if (latestRestorable) {
            return get().resumeSession(latestRestorable.id);
          }

          const nextSession = createSessionRecord(host);
          set((state) => ({
            sessions: upsertSessionRecord(state.sessions, nextSession),
          }));
          void connectSessionRecord(nextSession, host);
          return nextSession.id;
        },
        resumeSession: async (sessionId: string) => {
          const session = get().sessions.find((item) => item.id === sessionId);
          if (!session) {
            return null;
          }

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

          set((state) => ({
            sessions: patchSessionRecord(state.sessions, session.id, {
              status: "connecting",
              errorMessage: null,
              lastEventAt: new Date().toISOString(),
            }),
          }));
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

          try {
            await runtime.connection.disconnect();
          } catch {}

          flushSessionSnapshot(sessionId, {
            markActivity: false,
          });
          disconnectRuntimeSession(sessionId);
          markSessionState(sessionId, "closed");
        },
        writeToSession: async (sessionId: string, data: string) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            return;
          }
          const bytes = Buffer.from(data, "utf8");
          await runtime.shell.sendData(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          );
        },
        subscribeToSessionTerminal: (sessionId, handlers) => {
          const runtime = runtimeSessions.get(sessionId);
          if (!runtime) {
            return () => {};
          }

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
        hosts: state.hosts,
        knownHosts: state.knownHosts,
        secretMetadata: state.secretMetadata,
        sessions: compactPersistedSessions(state.sessions),
      }),
      onRehydrateStorage: () => () => {
        useMobileAppStore.setState({ hydrated: true });
      },
    },
  ),
);

export type { MobileAppState, PendingCredentialPromptState, PendingServerKeyPromptState };
