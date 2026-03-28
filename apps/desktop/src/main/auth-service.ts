import { BrowserWindow, app, shell } from "electron";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthSession } from "@shared";
import type { AuthState } from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import type { DesktopConfigService } from "./app-config";
import type { SettingsRepository } from "./database";
import {
  normalizeServerUrl,
  type OfflineSessionCache,
  isOfflineSessionCache,
  verifyOfflineLease,
} from "./offline-auth";
import { SecretStore, SecureStorageUnavailableError } from "./secret-store";
import { getDesktopStateStorage } from "./state-storage";

const REFRESH_TOKEN_ACCOUNT = "auth:refresh-token";
const OFFLINE_SESSION_CACHE_ACCOUNT = "auth:offline-session-cache";
const LOOPBACK_CALLBACK_HOST = "127.0.0.1";
const OFFLINE_RETRY_INITIAL_DELAY_MS = 30_000;
const OFFLINE_RETRY_MAX_DELAY_MS = 15 * 60_000;

function createDefaultAuthState(): AuthState {
  return {
    status: "loading",
    session: null,
    offline: null,
    errorMessage: null,
  };
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  return normalizeAuthSession(value) !== null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

async function toApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = (await response.text()).trim();
  const looksLikeHtml =
    contentType.includes("text/html") ||
    text.startsWith("<!DOCTYPE html") ||
    text.startsWith("<html") ||
    text.includes("<body>");

  if (looksLikeHtml) {
    return `${fallback} 서버가 API 응답 대신 HTML 페이지를 반환했습니다. 배포 주소 또는 리버스 프록시 설정을 확인해 주세요. (${response.status})`;
  }

  return text || `${fallback} (${response.status})`;
}

type SessionRequestErrorKind =
  | "network"
  | "auth"
  | "server"
  | "invalid-response";

class SessionRequestError extends Error {
  constructor(
    message: string,
    readonly kind: SessionRequestErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SessionRequestError";
  }
}

type SessionInvalidationContext = {
  reason: "logout" | "auth-invalid" | "offline-expired" | "account-changed";
  purgeSyncedCache: boolean;
};

function createFallbackOfflineLease(): AuthSession["offlineLease"] {
  return {
    token: "",
    issuedAt: "",
    expiresAt: "",
    verificationPublicKeyPem: "",
  };
}

function normalizeAuthSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const user = candidate.user as Record<string, unknown> | undefined;
  const tokens = candidate.tokens as Record<string, unknown> | undefined;
  const vaultBootstrap = candidate.vaultBootstrap as
    | Record<string, unknown>
    | undefined;
  const offlineLease = candidate.offlineLease as
    | Record<string, unknown>
    | undefined;

  if (
    typeof candidate.syncServerTime !== "string" ||
    user == null ||
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    tokens == null ||
    typeof tokens.accessToken !== "string" ||
    typeof tokens.refreshToken !== "string" ||
    typeof tokens.expiresInSeconds !== "number" ||
    vaultBootstrap == null ||
    typeof vaultBootstrap.keyBase64 !== "string"
  ) {
    return null;
  }

  const normalizedOfflineLease =
    offlineLease != null &&
    typeof offlineLease.token === "string" &&
    typeof offlineLease.issuedAt === "string" &&
    typeof offlineLease.expiresAt === "string" &&
    typeof offlineLease.verificationPublicKeyPem === "string"
      ? {
          token: offlineLease.token,
          issuedAt: offlineLease.issuedAt,
          expiresAt: offlineLease.expiresAt,
          verificationPublicKeyPem: offlineLease.verificationPublicKeyPem,
        }
      : createFallbackOfflineLease();

  return {
    user: {
      id: user.id,
      email: user.email,
    },
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
    },
    vaultBootstrap: {
      keyBase64: vaultBootstrap.keyBase64,
    },
    offlineLease: normalizedOfflineLease,
    syncServerTime: candidate.syncServerTime,
  };
}

function hasUsableOfflineLease(
  session: Pick<AuthSession, "offlineLease">,
): boolean {
  return Boolean(
    session.offlineLease.token &&
    session.offlineLease.issuedAt &&
    session.offlineLease.expiresAt &&
    session.offlineLease.verificationPublicKeyPem,
  );
}

function readE2EAuthSessionFromEnv(): AuthSession | null {
  const raw = process.env.DOLSSH_E2E_AUTH_SESSION_JSON?.trim();
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as unknown;
  const session = normalizeAuthSession(parsed);
  if (!session) {
    throw new Error(
      "DOLSSH_E2E_AUTH_SESSION_JSON 값이 올바른 AuthSession 형식이 아닙니다.",
    );
  }

  return session;
}

interface ActivityLogInput {
  level: "info" | "warn" | "error";
  category: "audit";
  message: string;
  metadata?: Record<string, unknown> | null;
}

export class AuthService {
  private readonly stateStorage = getDesktopStateStorage();
  private readonly windows = new Set<BrowserWindow>();
  private readonly processedExchangeCodes = new Set<string>();
  private state: AuthState = createDefaultAuthState();
  private refreshTimer: NodeJS.Timeout | null = null;
  private offlineRetryTimer: NodeJS.Timeout | null = null;
  private offlineLeaseExpiryTimer: NodeJS.Timeout | null = null;
  private offlineRetryDelayMs = OFFLINE_RETRY_INITIAL_DELAY_MS;
  private refreshPromise: Promise<AuthState> | null = null;
  private pendingBrowserLoginState: string | null = null;
  private exchangeInFlightCode: string | null = null;
  private onSessionInvalidated:
    | ((context: SessionInvalidationContext) => Promise<void> | void)
    | null = null;
  private loopbackCallbackServer: Server | null = null;

  constructor(
    private readonly secretStore: SecretStore,
    private readonly configService: DesktopConfigService,
    private readonly settings: SettingsRepository,
    private readonly appendLog?: (entry: ActivityLogInput) => void,
  ) {}

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => {
      this.windows.delete(window);
    });
  }

  getServerUrl(): string {
    return this.settings.get().serverUrl;
  }

  getDesktopClientId(): string {
    return this.configService.getConfig().sync.desktopClientId;
  }

  getRedirectUri(): string {
    return this.configService.getConfig().sync.redirectUri;
  }

  getState(): AuthState {
    return this.state;
  }

  setOnSessionInvalidated(
    callback: (context: SessionInvalidationContext) => Promise<void> | void,
  ): void {
    this.onSessionInvalidated = callback;
  }

  async bootstrap(): Promise<AuthState> {
    if (
      this.state.status === "authenticated" ||
      this.state.status === "offline-authenticated"
    ) {
      return this.state;
    }

    const e2eSession = readE2EAuthSessionFromEnv();
    if (e2eSession) {
      this.stateStorage.updateAuthStatus("authenticated");
      this.patchState({
        status: "authenticated",
        session: e2eSession,
        offline: null,
        errorMessage: null,
      });
      return this.state;
    }

    this.patchState({
      status: "loading",
      errorMessage: null,
    });

    return this.restoreSessionFromRefreshToken("세션을 복구하지 못했습니다.");
  }

  async refreshSession(): Promise<AuthState> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.restoreSessionFromRefreshToken(
      "세션이 만료되었습니다. 다시 로그인해 주세요.",
    );
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async retryOnline(): Promise<AuthState> {
    return this.refreshSession();
  }

  private async restoreSessionFromRefreshToken(
    fallbackMessage: string,
  ): Promise<AuthState> {
    const refreshToken = await this.secretStore.load(REFRESH_TOKEN_ACCOUNT);
    if (!refreshToken) {
      this.stateStorage.updateAuthStatus("unauthenticated");
      this.patchState({
        status: "unauthenticated",
        session: null,
        offline: null,
        errorMessage: null,
      });
      return this.state;
    }

    try {
      const session = await this.requestSessionWithClassification(
        "/auth/refresh",
        {
          refreshToken,
        },
      );
      await this.persistSession(session);
      return this.state;
    } catch (error) {
      if (this.isTransientSessionError(error)) {
        const restoredOffline = await this.restoreOfflineSession(
          toErrorMessage(error, fallbackMessage),
        );
        if (restoredOffline) {
          return restoredOffline;
        }
      }

      await this.clearSession(
        {
          status: "unauthenticated",
          errorMessage: toErrorMessage(error, fallbackMessage),
        },
        {
          reason: "auth-invalid",
          purgeSyncedCache: false,
          removeRefreshToken: true,
          removeOfflineCache: true,
        },
      );
      return this.state;
    }
  }

  async beginBrowserLogin(): Promise<void> {
    const browserState = randomUUID();
    this.pendingBrowserLoginState = browserState;
    this.patchState({
      status: "authenticating",
      errorMessage: null,
    });

    const redirectUri = await this.prepareBrowserRedirectUri();

    const loginUrl = new URL("/login", this.getServerUrl());
    loginUrl.searchParams.set("client", this.getDesktopClientId());
    loginUrl.searchParams.set("redirect_uri", redirectUri);
    loginUrl.searchParams.set("state", browserState);

    try {
      await shell.openExternal(loginUrl.toString());
    } catch (error) {
      await this.closeLoopbackCallbackServer();
      throw error;
    }
  }

  async handleCallbackUrl(rawUrl: string): Promise<void> {
    const callbackUrl = new URL(rawUrl);
    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    if (!code) {
      throw new Error("로그인 콜백에 code가 없습니다.");
    }
    if (
      this.processedExchangeCodes.has(code) ||
      this.exchangeInFlightCode === code
    ) {
      return;
    }
    if (
      this.pendingBrowserLoginState &&
      state &&
      this.pendingBrowserLoginState !== state
    ) {
      throw new Error("로그인 상태 값이 일치하지 않습니다.");
    }
    this.pendingBrowserLoginState = null;
    this.exchangeInFlightCode = code;

    try {
      const session = await this.requestSessionWithClassification(
        "/auth/exchange",
        {
          code,
        },
      );
      this.processedExchangeCodes.add(code);
      await this.persistSession(session);
      this.log({
        level: "info",
        category: "audit",
        message: "로그인되었습니다.",
        metadata: {
          userId: session.user.id,
          email: session.user.email,
        },
      });
    } finally {
      if (this.exchangeInFlightCode === code) {
        this.exchangeInFlightCode = null;
      }
    }
  }

  async logout(): Promise<void> {
    const refreshToken = await this.secretStore.load(REFRESH_TOKEN_ACCOUNT);
    if (refreshToken) {
      await fetch(new URL("/auth/logout", this.getServerUrl()), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          refreshToken,
        }),
      }).catch(() => undefined);
    }
    if (
      (this.state.status === "authenticated" ||
        this.state.status === "offline-authenticated") &&
      this.state.session
    ) {
      this.log({
        level: "info",
        category: "audit",
        message: "로그아웃되었습니다.",
        metadata: {
          userId: this.state.session.user.id,
          email: this.state.session.user.email,
        },
      });
    }
    await this.clearSession(
      {
        status: "unauthenticated",
        errorMessage: null,
      },
      {
        reason: "logout",
        purgeSyncedCache: true,
        removeRefreshToken: true,
        removeOfflineCache: true,
      },
    );
  }

  async forceUnauthenticated(errorMessage?: string): Promise<void> {
    if (
      errorMessage &&
      /세션이 만료|token is expired|invalid claims|로그인이 필요/i.test(
        errorMessage,
      )
    ) {
      this.log({
        level: "warn",
        category: "audit",
        message: "세션이 만료되어 로그아웃되었습니다.",
        metadata: {
          errorMessage,
        },
      });
    }
    await this.clearSession(
      {
        status: "unauthenticated",
        errorMessage: errorMessage ?? null,
      },
      {
        reason: "auth-invalid",
        purgeSyncedCache: false,
        removeRefreshToken: true,
        removeOfflineCache: true,
      },
    );
  }

  getAccessToken(): string {
    if (this.state.status === "offline-authenticated") {
      throw new Error(
        "오프라인 모드에서는 서버 연결이 필요한 기능을 사용할 수 없습니다.",
      );
    }
    if (
      this.state.status !== "authenticated" ||
      !this.state.session?.tokens.accessToken
    ) {
      throw new Error("로그인이 필요합니다.");
    }
    return this.state.session.tokens.accessToken;
  }

  getVaultKeyBase64(): string {
    if (
      (this.state.status !== "authenticated" &&
        this.state.status !== "offline-authenticated") ||
      !this.state.session?.vaultBootstrap.keyBase64
    ) {
      throw new Error("세션 vault key가 없습니다.");
    }
    return this.state.session.vaultBootstrap.keyBase64;
  }

  private async requestSession(
    pathname: string,
    payload: Record<string, unknown>,
  ): Promise<AuthSession> {
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.getServerUrl()), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new SessionRequestError(
        toErrorMessage(error, "서버에 연결하지 못했습니다."),
        "network",
      );
    }

    if (!response.ok) {
      throw new Error(
        await toApiErrorMessage(response, "인증 요청에 실패했습니다."),
      );
    }

    const json = (await response.json()) as unknown;
    if (!isAuthSession(json)) {
      throw new Error("인증 응답 형식이 올바르지 않습니다.");
    }
    return json;
  }

  private async requestSessionWithClassification(
    pathname: string,
    payload: Record<string, unknown>,
  ): Promise<AuthSession> {
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.getServerUrl()), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new SessionRequestError(
        toErrorMessage(error, "서버에 연결하지 못했습니다."),
        "network",
      );
    }

    if (!response.ok) {
      const message = await toApiErrorMessage(
        response,
        "인증 요청에 실패했습니다.",
      );
      if (response.status === 401 || response.status === 403) {
        throw new SessionRequestError(message, "auth", response.status);
      }
      if (response.status >= 500) {
        throw new SessionRequestError(message, "server", response.status);
      }
      throw new SessionRequestError(
        message,
        "invalid-response",
        response.status,
      );
    }

    const json = (await response.json()) as unknown;
    const session = normalizeAuthSession(json);
    if (!session) {
      throw new SessionRequestError(
        "인증 응답 형식이 올바르지 않습니다.",
        "invalid-response",
      );
    }
    return session;
  }

  private async persistSession(session: AuthSession): Promise<void> {
    const normalizedServerUrl = normalizeServerUrl(this.getServerUrl());
    const owner = this.stateStorage.getSyncDataOwner();
    const ownerChanged =
      Boolean(owner.userId || owner.serverUrl) &&
      (owner.userId !== session.user.id ||
        owner.serverUrl !== normalizedServerUrl);

    if (ownerChanged) {
      await this.notifySessionInvalidated({
        reason: "account-changed",
        purgeSyncedCache: true,
      });
    }

    let persistenceDisabledMessage: string | null = null;
    try {
      await this.secretStore.save(
        REFRESH_TOKEN_ACCOUNT,
        session.tokens.refreshToken,
      );
      await this.persistOfflineSessionCache(session);
    } catch (error) {
      if (!(error instanceof SecureStorageUnavailableError)) {
        throw error;
      }

      persistenceDisabledMessage = error.message;
      await this.secretStore
        .remove(REFRESH_TOKEN_ACCOUNT)
        .catch(() => undefined);
      await this.secretStore
        .remove(OFFLINE_SESSION_CACHE_ACCOUNT)
        .catch(() => undefined);
      this.log({
        level: "warn",
        category: "audit",
        message: persistenceDisabledMessage,
        metadata: {
          persistence: "disabled",
        },
      });
    }
    this.stateStorage.updateAuthStatus("authenticated");
    this.stateStorage.updateSyncDataOwner({
      userId: session.user.id,
      serverUrl: normalizedServerUrl,
    });
    this.patchState({
      status: "authenticated",
      session,
      offline: null,
      errorMessage: persistenceDisabledMessage,
    });
    this.offlineRetryDelayMs = OFFLINE_RETRY_INITIAL_DELAY_MS;
    this.scheduleRefresh(session.tokens.expiresInSeconds);
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.clearOfflineTimers();
    const delay = Math.max(15_000, (expiresInSeconds - 60) * 1000);
    this.refreshTimer = setTimeout(() => {
      void this.refreshSession();
    }, delay);
  }

  private async clearSession(
    nextState: Pick<AuthState, "status" | "errorMessage">,
    options: {
      reason: SessionInvalidationContext["reason"];
      purgeSyncedCache: boolean;
      removeRefreshToken: boolean;
      removeOfflineCache: boolean;
    },
  ): Promise<void> {
    this.clearRefreshTimer();
    this.clearOfflineTimers();
    await this.closeLoopbackCallbackServer();
    if (options.removeRefreshToken) {
      await this.secretStore
        .remove(REFRESH_TOKEN_ACCOUNT)
        .catch(() => undefined);
    }
    if (options.removeOfflineCache) {
      await this.secretStore
        .remove(OFFLINE_SESSION_CACHE_ACCOUNT)
        .catch(() => undefined);
    }
    this.exchangeInFlightCode = null;
    this.pendingBrowserLoginState = null;
    this.state = {
      status: nextState.status,
      session: null,
      offline: null,
      errorMessage: nextState.errorMessage ?? null,
    };
    this.stateStorage.updateAuthStatus(
      nextState.status === "offline-authenticated"
        ? "offline-authenticated"
        : "unauthenticated",
    );
    await this.notifySessionInvalidated({
      reason: options.reason,
      purgeSyncedCache: options.purgeSyncedCache,
    });
    this.broadcast(this.state);
  }

  private isTransientSessionError(error: unknown): boolean {
    return (
      error instanceof SessionRequestError &&
      (error.kind === "network" || error.kind === "server")
    );
  }

  private async restoreOfflineSession(
    reasonMessage: string,
  ): Promise<AuthState | null> {
    const cache = await this.loadOfflineSessionCache();
    if (!cache) {
      return null;
    }

    const verification = verifyOfflineLease(cache, this.getServerUrl());
    if (!verification.ok) {
      await this.clearSession(
        {
          status: "unauthenticated",
          errorMessage:
            "오프라인 사용 가능 시간이 만료되어 다시 로그인이 필요합니다.",
        },
        {
          reason: "offline-expired",
          purgeSyncedCache: false,
          removeRefreshToken: true,
          removeOfflineCache: true,
        },
      );
      return this.state;
    }

    const offlineSession: AuthSession = {
      user: cache.user,
      tokens: {
        accessToken: "",
        refreshToken: "",
        expiresInSeconds: 0,
      },
      vaultBootstrap: cache.vaultBootstrap,
      offlineLease: cache.offlineLease,
      syncServerTime: cache.lastOnlineAt,
    };

    this.clearRefreshTimer();
    this.clearOfflineTimers();
    this.stateStorage.updateAuthStatus("offline-authenticated");
    this.patchState({
      status: "offline-authenticated",
      session: offlineSession,
      offline: {
        expiresAt: verification.expiresAt,
        lastOnlineAt: cache.lastOnlineAt,
        reason: reasonMessage,
      },
      errorMessage: null,
    });
    this.scheduleOfflineLeaseExpiry(verification.expiresAt);
    this.scheduleOfflineRetry();
    return this.state;
  }

  private async persistOfflineSessionCache(
    session: AuthSession,
  ): Promise<void> {
    if (
      !this.secretStore.isEncryptionAvailable() ||
      !hasUsableOfflineLease(session)
    ) {
      await this.secretStore
        .remove(OFFLINE_SESSION_CACHE_ACCOUNT)
        .catch(() => undefined);
      return;
    }

    const cache: OfflineSessionCache = {
      serverUrl: normalizeServerUrl(this.getServerUrl()),
      user: session.user,
      vaultBootstrap: session.vaultBootstrap,
      offlineLease: session.offlineLease,
      lastOnlineAt: new Date().toISOString(),
    };
    await this.secretStore.save(
      OFFLINE_SESSION_CACHE_ACCOUNT,
      JSON.stringify(cache),
    );
  }

  private async loadOfflineSessionCache(): Promise<OfflineSessionCache | null> {
    if (!this.secretStore.isEncryptionAvailable()) {
      return null;
    }

    const raw = await this.secretStore.load(OFFLINE_SESSION_CACHE_ACCOUNT);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isOfflineSessionCache(parsed)) {
        return null;
      }
      if (parsed.serverUrl !== normalizeServerUrl(this.getServerUrl())) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private clearOfflineTimers(): void {
    if (this.offlineRetryTimer) {
      clearTimeout(this.offlineRetryTimer);
      this.offlineRetryTimer = null;
    }
    if (this.offlineLeaseExpiryTimer) {
      clearTimeout(this.offlineLeaseExpiryTimer);
      this.offlineLeaseExpiryTimer = null;
    }
  }

  private scheduleOfflineRetry(): void {
    if (this.state.status !== "offline-authenticated") {
      return;
    }

    if (this.offlineRetryTimer) {
      clearTimeout(this.offlineRetryTimer);
    }

    const delay = this.offlineRetryDelayMs;
    this.offlineRetryTimer = setTimeout(() => {
      void this.retryOnline()
        .catch(() => undefined)
        .finally(() => {
          if (this.state.status === "offline-authenticated") {
            this.offlineRetryDelayMs = Math.min(
              this.offlineRetryDelayMs * 2,
              OFFLINE_RETRY_MAX_DELAY_MS,
            );
            this.scheduleOfflineRetry();
          }
        });
    }, delay);
  }

  private scheduleOfflineLeaseExpiry(expiresAt: string): void {
    if (this.offlineLeaseExpiryTimer) {
      clearTimeout(this.offlineLeaseExpiryTimer);
    }

    const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
    this.offlineLeaseExpiryTimer = setTimeout(() => {
      void this.clearSession(
        {
          status: "unauthenticated",
          errorMessage:
            "오프라인 사용 가능 시간이 만료되어 다시 로그인이 필요합니다.",
        },
        {
          reason: "offline-expired",
          purgeSyncedCache: false,
          removeRefreshToken: true,
          removeOfflineCache: true,
        },
      );
    }, delay);
  }

  private async notifySessionInvalidated(
    context: SessionInvalidationContext,
  ): Promise<void> {
    if (!this.onSessionInvalidated) {
      return;
    }
    await this.onSessionInvalidated(context);
  }

  private patchState(patch: Partial<AuthState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.broadcast(this.state);
  }

  private broadcast(state: AuthState): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.auth.event, state);
      }
    }
  }

  private log(entry: ActivityLogInput): void {
    this.appendLog?.(entry);
  }

  registerProtocolClient(): void {
    if (!app.isPackaged) {
      return;
    }
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("dolgate", process.execPath, [
        process.argv[1]!,
      ]);
      return;
    }
    app.setAsDefaultProtocolClient("dolgate");
  }

  private async prepareBrowserRedirectUri(): Promise<string> {
    return this.startLoopbackCallbackServer();
  }

  private async startLoopbackCallbackServer(): Promise<string> {
    await this.closeLoopbackCallbackServer();

    const server = createServer((request, response) => {
      void this.handleLoopbackCallbackRequest(request.url ?? "/", response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_CALLBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.loopbackCallbackServer = server;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("로컬 로그인 콜백 포트를 열지 못했습니다.");
    }
    return `http://${LOOPBACK_CALLBACK_HOST}:${(address as AddressInfo).port}/auth/callback`;
  }

  private async handleLoopbackCallbackRequest(
    requestUrl: string,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(requestUrl, `http://${LOOPBACK_CALLBACK_HOST}`);
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("not found");
      return;
    }

    try {
      await this.handleCallbackUrl(url.toString());
      this.focusWindows();
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(
        renderLoopbackCallbackPage(
          "로그인이 완료되었습니다.",
          "Dolgate 앱으로 돌아갑니다. 이 탭은 닫아도 됩니다.",
        ),
      );
    } catch (error) {
      const message = toErrorMessage(
        error,
        "브라우저 로그인 교환에 실패했습니다.",
      );
      response.writeHead(500, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(
        renderLoopbackCallbackPage("로그인에 실패했습니다.", message),
      );
      await this.forceUnauthenticated(message);
    } finally {
      await this.closeLoopbackCallbackServer();
    }
  }

  private focusWindows(): void {
    for (const window of this.windows) {
      if (window.isDestroyed()) {
        continue;
      }
      if (!window.isVisible()) {
        window.show();
      }
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
    app.focus();
  }

  private async closeLoopbackCallbackServer(): Promise<void> {
    const server = this.loopbackCallbackServer;
    this.loopbackCallbackServer = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function renderLoopbackCallbackPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1726; color:#f5f7fb; }
      .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px; }
      .card { width:100%; max-width:420px; background:#162133; border:1px solid rgba(255,255,255,.08); border-radius:24px; box-shadow:0 18px 48px rgba(0,0,0,.35); padding:32px; }
      .eyebrow { letter-spacing:.2em; font-size:12px; text-transform:uppercase; color:#9fb0d3; margin-bottom:10px; }
      h1 { margin:0 0 12px; font-size:34px; line-height:1.08; }
      p { color:#9fb0d3; margin:0; line-height:1.55; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="eyebrow">Dolgate</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
