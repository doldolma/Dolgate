import { BrowserWindow, app, shell } from "electron";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthSession } from "@shared";
import type { AuthState } from "@shared";
import type { PasskeyCredential } from "@shared";
import type { VaultMutationResponse } from "@shared";
import {
  assertValidNewVaultPassphrase,
  computeVaultDekVerifier,
  createVaultDek,
  createVaultKdfDescriptor,
  decideVaultAccess,
  deriveVaultKek,
  parseVaultCacheRecord,
  resolveVaultDescriptorState,
  unwrapVaultDek,
  wrapVaultDek,
  type VaultCacheRecord,
  type VaultCacheOwner,
  type VaultKdfDescriptor,
} from "@dolssh/shared-core";
import { fromByteArray, toByteArray } from "base64-js";
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
import {
  extractApiErrorMessage,
  normalizeAuthInvalidErrorMessage,
} from "./auth-error-message";
import { desktopArgon2idDerive } from "./vault-crypto";

const REFRESH_TOKEN_ACCOUNT = "auth:refresh-token";
const OFFLINE_SESSION_CACHE_ACCOUNT = "auth:offline-session-cache";
// E2EE 볼트(v2)의 잠금해제된 DEK 캐시 — 동기화 암호 입력 후 저장해 재입력을 없앤다.
// v2 값은 DEK/epoch/wrapper/KDF/verifier 를 한 JSON 레코드로 저장한다. 이전 포맷
// ({dekBase64, epoch} 또는 base64 원문)도 읽어 점진적으로 마이그레이션한다.
const VAULT_DEK_ACCOUNT = "auth:vault-dek";
// dekId 시절의 잔재 엔트리 — 더 이상 쓰지 않으므로 발견 시 지운다.
const LEGACY_VAULT_DEK_ID_ACCOUNT = "auth:vault-dek-id";
const LOOPBACK_CALLBACK_HOST = "127.0.0.1";
const OFFLINE_RETRY_INITIAL_DELAY_MS = 30_000;
const OFFLINE_RETRY_MAX_DELAY_MS = 15 * 60_000;
const VAULT_API_REQUEST_TIMEOUT_MS = 30_000;
const VAULT_API_REQUEST_TIMEOUT_MESSAGE =
  "동기화 암호 요청 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
const ACCOUNT_PASSWORD_REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_PASSWORD_REQUEST_TIMEOUT_MESSAGE =
  "비밀번호 변경 요청 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
const CLIENT_HEADER_NAME = "X-Dolgate-Client";
const CLIENT_VERSION_HEADER_NAME = "X-Dolgate-Client-Version";
const CLIENT_PLATFORM_HEADER_NAME = "X-Dolgate-Platform";
const CLIENT_INSTALLATION_ID_HEADER_NAME = "X-Dolgate-Client-Installation-Id";

function resolveDesktopClientPlatform(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function createDefaultAuthState(): AuthState {
  return {
    status: "loading",
    session: null,
    offline: null,
    errorMessage: null,
  };
}

// E2EE 볼트(v2)의 메인 프로세스 상태 머신. 렌더러에는 status 만 내보낸다(AuthState.vault).
// legacy: v1 — 세션의 keyBase64 사용 / setup-required: 신규 유저 / locked: 암호 필요 /
// unlocked: DEK 확보. none 은 미인증 등 볼트를 논할 수 없는 상태.
//
// unlocked 는 항상 verifier(정체성 증명) 또는 암호 unwrap(암호학적 증명)을 거친 상태다 —
// "미검증 임시 신뢰" 같은 중간 상태가 없다. epoch 은 push fence 헤더와 낡은 descriptor
// 무시 판정에 쓴다(구서버 = 0).
type InternalVaultState =
  | { status: "none" }
  | { status: "legacy"; epoch: number; migrationRequired: boolean }
  | { status: "setup-required"; epoch: number }
  | { status: "error"; errorMessage: string }
  | {
      status: "locked";
      wrappedDekBase64: string;
      kdf: VaultKdfDescriptor;
      epoch: number;
      wrapRevision: number;
      // descriptor 의 verifier. 없으면 verifier 도입 이전 볼트 — 잠금해제 성공 시
      // 서버에 지연 백필한다(암호로 DEK 를 증명한 시점에만 안전하다).
      dekVerifierBase64?: string;
    }
  | {
      status: "unlocked";
      dekBase64: string;
      // 구형 캐시는 wrapper/KDF 를 보관하지 않았다. 해당 캐시를 낡은 descriptor 와
      // 결합하지 않고 DEK-only unlocked 로 복원하며, 최신 descriptor 수신 시 채운다.
      wrappedDekBase64?: string;
      kdf?: VaultKdfDescriptor;
      epoch: number;
      wrapRevision: number;
      owner?: VaultCacheOwner;
      dekVerifierBase64?: string;
    };

type StoredVaultDek = {
  dekBase64: string;
  epoch: number | null;
  wrapRevision: number | null;
  owner?: VaultCacheOwner;
  wrappedDekBase64?: string;
  kdf?: VaultKdfDescriptor;
  dekVerifierBase64?: string;
};

type VaultOperationContext = {
  userId: string;
  serverUrl: string;
};

function hasCoherentVaultDescriptor(
  vault: InternalVaultState,
): vault is Extract<InternalVaultState, { status: "unlocked" }> & {
  wrappedDekBase64: string;
  kdf: VaultKdfDescriptor;
} {
  return (
    vault.status === "unlocked" &&
    typeof vault.wrappedDekBase64 === "string" &&
    vault.wrappedDekBase64.length > 0 &&
    vault.kdf !== undefined
  );
}

// VAULT_DEK_ACCOUNT 캐시 값 파싱 — JSON {dekBase64, epoch} 또는 이전 포맷(base64 원문).
// base64 는 "{" 로 시작할 수 없으므로 구분이 안전하다.
function parseStoredVaultDek(raw: string | null): StoredVaultDek | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed
      ? { dekBase64: trimmed, epoch: null, wrapRevision: null }
      : null;
  }
  try {
    const cacheRecord = parseVaultCacheRecord(trimmed);
    if (cacheRecord) {
      return {
        dekBase64: cacheRecord.dekBase64,
        epoch: cacheRecord.epoch,
        wrapRevision: cacheRecord.wrapRevision ?? 0,
        owner: cacheRecord.owner,
        wrappedDekBase64: cacheRecord.wrappedDekBase64,
        kdf: cacheRecord.kdf,
        dekVerifierBase64: cacheRecord.dekVerifierBase64,
      };
    }
    const parsed = JSON.parse(trimmed) as {
      version?: unknown;
      dekBase64?: unknown;
      epoch?: unknown;
    };
    // 손상된 v2 레코드를 구형 캐시로 강등해 신뢰하지 않는다.
    if (parsed.version === 2) {
      return null;
    }
    if (typeof parsed.dekBase64 !== "string" || !parsed.dekBase64) {
      return null;
    }
    return {
      dekBase64: parsed.dekBase64,
      epoch:
        typeof parsed.epoch === "number" && Number.isSafeInteger(parsed.epoch)
          ? parsed.epoch
          : null,
      wrapRevision: null,
    };
  } catch {
    return null;
  }
}

function vaultCacheOwnersEqual(
  left: VaultCacheOwner | undefined,
  right: VaultCacheOwner,
): boolean {
  return left?.userId === right.userId && left.serverUrl === right.serverUrl;
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

function unlockedVaultStateFromCache(
  cached: StoredVaultDek,
): Extract<InternalVaultState, { status: "unlocked" }> {
  return {
    status: "unlocked",
    dekBase64: cached.dekBase64,
    epoch: cached.epoch ?? 0,
    wrapRevision: cached.wrapRevision ?? 0,
    ...(cached.owner ? { owner: cached.owner } : {}),
    ...(cached.wrappedDekBase64 && cached.kdf
      ? {
          wrappedDekBase64: cached.wrappedDekBase64,
          kdf: cached.kdf,
          dekVerifierBase64: cached.dekVerifierBase64,
        }
      : {}),
  };
}

class VaultApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VaultApiError";
  }
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

  const extracted = extractApiErrorMessage(text);
  return extracted || `${fallback} (${response.status})`;
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
  reason:
    | "logout"
    | "auth-invalid"
    | "offline-expired"
    | "account-changed"
    | "account-deleted";
  purgeSyncedCache: boolean;
  // 회원 탈퇴 — 동기화 캐시 외에 이 기기의 로컬 흔적(세션 리플레이·활동 로그·AI 키)까지
  // 함께 지운다. 로그아웃(false)과 탈퇴(true)를 구분하는 플래그.
  purgeLocalData?: boolean;
};

type SessionActivatedContext = {
  userId: string;
  serverUrl: string;
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

  // 볼트 descriptor 검증 — v2 도입 이전 서버는 version 없이 keyBase64 만 내려준다(v1).
  // version 이 있으면 0(설정 필요)/1(레거시)/2(E2EE) 모두 유효한 세션이다.
  const hasLegacyVaultKey = typeof vaultBootstrap?.keyBase64 === "string";
  const hasVersionedVault = typeof vaultBootstrap?.version === "number";

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
    (!hasLegacyVaultKey && !hasVersionedVault)
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

  const normalizedKdf = (() => {
    const kdf = vaultBootstrap.kdf as Record<string, unknown> | undefined;
    if (
      kdf == null ||
      typeof kdf.algorithm !== "string" ||
      typeof kdf.saltBase64 !== "string" ||
      typeof kdf.memoryKib !== "number" ||
      typeof kdf.timeCost !== "number" ||
      typeof kdf.parallelism !== "number"
    ) {
      return undefined;
    }
    return {
      algorithm: kdf.algorithm,
      saltBase64: kdf.saltBase64,
      memoryKib: kdf.memoryKib,
      timeCost: kdf.timeCost,
      parallelism: kdf.parallelism,
    };
  })();

  return {
    user: {
      id: user.id,
      email: user.email,
      ...(user.passwordState === "unset" ||
      user.passwordState === "set" ||
      user.passwordState === "unavailable"
        ? { passwordState: user.passwordState }
        : {}),
    },
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
    },
    vaultBootstrap: {
      ...(hasVersionedVault
        ? { version: vaultBootstrap.version as number }
        : {}),
      ...(hasLegacyVaultKey
        ? { keyBase64: vaultBootstrap.keyBase64 as string }
        : {}),
      ...(typeof vaultBootstrap.wrappedDekBase64 === "string"
        ? { wrappedDekBase64: vaultBootstrap.wrappedDekBase64 }
        : {}),
      ...(typeof vaultBootstrap.epoch === "number" &&
      Number.isSafeInteger(vaultBootstrap.epoch)
        ? { epoch: vaultBootstrap.epoch }
        : {}),
      ...(typeof vaultBootstrap.wrapRevision === "number" &&
      Number.isSafeInteger(vaultBootstrap.wrapRevision) &&
      vaultBootstrap.wrapRevision >= 0
        ? { wrapRevision: vaultBootstrap.wrapRevision }
        : {}),
      ...(typeof vaultBootstrap.dekVerifierBase64 === "string" &&
      vaultBootstrap.dekVerifierBase64
        ? { dekVerifierBase64: vaultBootstrap.dekVerifierBase64 }
        : {}),
      ...(vaultBootstrap.e2eeRequired === true ? { e2eeRequired: true } : {}),
      ...(normalizedKdf ? { kdf: normalizedKdf } : {}),
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

export interface AuthSyncContext {
  userId: string;
  serverUrl: string;
  accessToken: string;
  vaultKeyBase64: string;
  vaultEpoch: number | null;
}

export class AuthService {
  private readonly stateStorage = getDesktopStateStorage();
  private readonly windows = new Set<BrowserWindow>();
  private readonly processedExchangeCodes = new Set<string>();
  private state: AuthState = createDefaultAuthState();
  private vaultState: InternalVaultState = { status: "none" };
  // 서버(/api/info)가 E2EE 볼트를 지원하는지 — sync-service 가 서버 정보를 가져올 때
  // 알려준다. null 은 아직 미확인(전환 프롬프트를 띄우지 않는다).
  private serverVaultE2eeSupported: boolean | null = null;
  private serverVaultE2eeSupportServerUrl: string | null = null;
  // 서버(/api/info)가 패스키(WebAuthn) 로그인을 지원하는지 — sync-service 가 알려준다.
  // 서버 URL과 함께 보관해 서버가 바뀌면 이전 판정을 그대로 쓰지 않는다.
  private serverWebauthnSupported: boolean | null = null;
  private serverWebauthnSupportServerUrl: string | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private offlineRetryTimer: NodeJS.Timeout | null = null;
  private offlineLeaseExpiryTimer: NodeJS.Timeout | null = null;
  private offlineRetryDelayMs = OFFLINE_RETRY_INITIAL_DELAY_MS;
  private refreshPromise: Promise<AuthState> | null = null;
  private pendingBrowserLoginState: string | null = null;
  private pendingBrowserLoginUrl: string | null = null;
  private exchangeInFlightCode: string | null = null;
  private onSessionInvalidated:
    | ((context: SessionInvalidationContext) => Promise<void> | void)
    | null = null;
  private onSessionActivated:
    | ((context: SessionActivatedContext) => Promise<void> | void)
    | null = null;
  private loopbackCallbackServer: Server | null = null;
  private clientInstallationId: string | null = null;

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

  private getClientInstallationId(): string {
    if (!this.clientInstallationId) {
      this.clientInstallationId =
        this.stateStorage.getOrCreateClientInstallationId(randomUUID);
    }
    return this.clientInstallationId;
  }

  // 클라이언트 식별 헤더 — 세션 발급뿐 아니라 /sync 에도 실어, 서버의 v2 push 버전
  // 게이트(426)가 최신 클라이언트를 구버전으로 오인하지 않게 한다.
  getClientIdentificationHeaders(): Record<string, string> {
    const version =
      typeof app.getVersion === "function" ? app.getVersion().trim() : "";

    return {
      [CLIENT_HEADER_NAME]: "desktop",
      [CLIENT_VERSION_HEADER_NAME]: version || "unknown",
      [CLIENT_PLATFORM_HEADER_NAME]: resolveDesktopClientPlatform(),
      [CLIENT_INSTALLATION_ID_HEADER_NAME]: this.getClientInstallationId(),
    };
  }

  private buildAuthHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...this.getClientIdentificationHeaders(),
    };
  }

  getState(): AuthState {
    return this.state;
  }

  setOnSessionInvalidated(
    callback: (context: SessionInvalidationContext) => Promise<void> | void,
  ): void {
    this.onSessionInvalidated = callback;
  }

  setOnSessionActivated(
    callback: (context: SessionActivatedContext) => Promise<void> | void,
  ): void {
    this.onSessionActivated = callback;
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
      await this.notifySessionActivated({
        userId: e2eSession.user.id,
        serverUrl: this.getServerUrl(),
      });
      this.stateStorage.updateAuthStatus("authenticated");
      this.vaultState = await this.resolveVaultStateForSession(e2eSession);
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

    if (
      this.state.status === "unauthenticated" ||
      this.state.status === "error"
    ) {
      this.patchState({
        status: "loading",
        errorMessage: null,
      });
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
      const normalizedAuthErrorMessage =
        error instanceof SessionRequestError
          ? normalizeAuthInvalidErrorMessage({
              status: error.status,
              message: error.message,
            })
          : null;
      if (this.isTransientSessionError(error)) {
        const restoredOffline = await this.restoreOfflineSession(
          normalizedAuthErrorMessage ?? toErrorMessage(error, fallbackMessage),
        );
        if (restoredOffline) {
          return restoredOffline;
        }
      }

      await this.clearSession(
        {
          status: "unauthenticated",
          errorMessage:
            normalizedAuthErrorMessage ??
            toErrorMessage(error, fallbackMessage),
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
    const redirectUri = await this.prepareBrowserRedirectUri();
    const browserState = randomUUID();
    const loginUrl = new URL("/login", this.getServerUrl());
    loginUrl.searchParams.set("client", this.getDesktopClientId());
    loginUrl.searchParams.set("redirect_uri", redirectUri);
    loginUrl.searchParams.set("state", browserState);

    // openExternal 은 OS 핸들러를 부르므로 http(s) 만 허용한다. 설정 파일의 serverUrl 은
    // "비어 있지 않은 문자열" 검사만 받아서, file:/smb: 같은 스킴이 들어오면 파인더가 열리거나
    // 원격 공유가 마운트될 수 있다(패스키 등록 경로엔 이미 같은 가드가 있다).
    if (loginUrl.protocol !== "https:" && loginUrl.protocol !== "http:") {
      throw new Error("로그인 서버 주소가 올바르지 않습니다.");
    }

    this.pendingBrowserLoginState = browserState;
    this.pendingBrowserLoginUrl = loginUrl.toString();
    this.patchState({
      status: "authenticating",
      errorMessage: null,
    });

    try {
      await shell.openExternal(this.pendingBrowserLoginUrl);
    } catch (error) {
      await this.closeLoopbackCallbackServer();
      this.pendingBrowserLoginState = null;
      this.pendingBrowserLoginUrl = null;
      this.stateStorage.updateAuthStatus("unauthenticated");
      this.patchState({
        status: "unauthenticated",
        errorMessage: null,
      });
      throw error;
    }
  }

  async reopenBrowserLogin(): Promise<void> {
    if (this.pendingBrowserLoginUrl) {
      await shell.openExternal(this.pendingBrowserLoginUrl);
      return;
    }
    await this.beginBrowserLogin();
  }

  async cancelBrowserLogin(): Promise<void> {
    if (
      !this.pendingBrowserLoginState &&
      this.state.status !== "authenticating"
    ) {
      return;
    }

    await this.closeLoopbackCallbackServer();
    this.pendingBrowserLoginState = null;
    this.pendingBrowserLoginUrl = null;
    this.exchangeInFlightCode = null;
    this.stateStorage.updateAuthStatus("unauthenticated");
    this.patchState({
      status: "unauthenticated",
      session: null,
      offline: null,
      errorMessage: null,
    });
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
    this.pendingBrowserLoginUrl = null;
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

  // 회원 탈퇴 — 서버의 모든 사용자 데이터를 즉시 영구 삭제한 뒤(DELETE /auth/account),
  // 로컬 세션을 로그아웃과 동일하게 정리한다. access 토큰이 마침 만료된 경우를 위해
  // 401/403 이면 refresh 후 1회 재시도한다.
  async deleteAccount(): Promise<void> {
    const sessionUser =
      this.state.status === "authenticated" ? this.state.session?.user : null;
    const requestDelete = (): Promise<Response> =>
      fetch(new URL("/auth/account", this.getServerUrl()), {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.getAccessToken()}`,
        },
      });

    let response = await requestDelete();
    if (response.status === 401 || response.status === 403) {
      const refreshed = await this.refreshSession();
      if (refreshed.status !== "authenticated") {
        throw new Error(
          "세션이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.",
        );
      }
      response = await requestDelete();
    }
    if (!response.ok) {
      const fallback = `회원 탈퇴에 실패했습니다. (${response.status})`;
      const message = await response
        .json()
        .then((body: { error?: unknown }) =>
          typeof body.error === "string" && body.error.trim()
            ? body.error
            : fallback,
        )
        .catch(() => fallback);
      throw new Error(message);
    }

    if (sessionUser) {
      this.log({
        level: "info",
        category: "audit",
        message: "회원 탈퇴로 서버 계정과 데이터가 삭제되었습니다.",
        metadata: {
          userId: sessionUser.id,
          email: sessionUser.email,
        },
      });
    }
    await this.clearSession(
      {
        status: "unauthenticated",
        errorMessage: null,
      },
      {
        reason: "account-deleted",
        purgeSyncedCache: true,
        removeRefreshToken: true,
        removeOfflineCache: true,
        // 탈퇴는 이 기기의 로컬 흔적(리플레이·로그·AI 키)까지 함께 지운다.
        purgeLocalData: true,
      },
    );
  }

  async changeAccountPassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (this.state.status !== "authenticated" || !this.state.session) {
      throw new Error(
        "온라인 로그인 상태에서만 비밀번호를 설정할 수 있습니다.",
      );
    }

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;
    const timeoutError = new Error(ACCOUNT_PASSWORD_REQUEST_TIMEOUT_MESSAGE);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, ACCOUNT_PASSWORD_REQUEST_TIMEOUT_MS);
    });
    const requestChange = async (): Promise<Response> => {
      const refreshToken = await this.secretStore.load(REFRESH_TOKEN_ACCOUNT);
      if (!refreshToken) {
        throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
      }
      return fetch(new URL("/auth/account/password", this.getServerUrl()), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ currentPassword, newPassword, refreshToken }),
        signal: controller.signal,
      });
    };

    try {
      await Promise.race([
        (async () => {
          let response = await requestChange();
          if (response.status === 401 || response.status === 403) {
            const refreshed = await this.refreshSession();
            if (refreshed.status !== "authenticated") {
              throw new Error(
                "세션이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.",
              );
            }
            response = await requestChange();
          }
          if (!response.ok) {
            throw new Error(
              await toApiErrorMessage(
                response,
                "로그인 비밀번호를 변경하지 못했습니다.",
              ),
            );
          }
        })(),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    const session =
      this.state.status === "authenticated" ? this.state.session : null;
    if (!session) {
      throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
    await this.persistSession({
      ...session,
      user: { ...session.user, passwordState: "set" },
    });
    this.log({
      level: "info",
      category: "audit",
      message: "로그인 비밀번호가 설정되었습니다.",
      metadata: { userId: session.user.id, email: session.user.email },
    });
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
      this.state.status !== "authenticated" &&
      this.state.status !== "offline-authenticated"
    ) {
      throw new Error("세션 vault key가 없습니다.");
    }
    if (this.vaultState.status === "unlocked") {
      return this.vaultState.dekBase64;
    }
    if (this.vaultState.status === "error") {
      throw new Error(this.vaultState.errorMessage);
    }
    if (
      this.vaultState.status !== "legacy" ||
      this.vaultState.migrationRequired
    ) {
      throw new Error("동기화 잠금 해제가 필요합니다.");
    }
    if (!this.state.session?.vaultBootstrap.keyBase64) {
      throw new Error("세션 vault key가 없습니다.");
    }
    return this.state.session.vaultBootstrap.keyBase64;
  }

  // 한 번의 sync가 사용할 계정/서버/DEK 세대를 원자적으로 캡처한다. SyncService는
  // 비동기 작업 중 이 값들을 다시 읽지 않아 reset/setup 사이에 서로 다른 세대의
  // DEK와 epoch이 섞이지 않게 한다.
  captureSyncContext(): AuthSyncContext {
    const session = this.state.session;
    if (this.state.status !== "authenticated" || !session) {
      throw new Error("온라인 로그인 상태에서만 동기화할 수 있습니다.");
    }
    return {
      userId: session.user.id,
      serverUrl: normalizeServerUrl(this.getServerUrl()),
      accessToken: session.tokens.accessToken,
      vaultKeyBase64: this.getVaultKeyBase64(),
      vaultEpoch:
        this.vaultState.status === "unlocked" ? this.vaultState.epoch : null,
    };
  }

  // access token은 같은 계정에서 refresh될 수 있으므로 정체성 비교에서 제외한다.
  // 계정/서버/DEK/epoch 중 하나라도 바뀌면 이전 sync context는 폐기 대상이다.
  isSyncContextCurrent(context: AuthSyncContext): boolean {
    try {
      const current = this.captureSyncContext();
      return (
        current.userId === context.userId &&
        current.serverUrl === context.serverUrl &&
        current.vaultKeyBase64 === context.vaultKeyBase64 &&
        current.vaultEpoch === context.vaultEpoch
      );
    } catch {
      return false;
    }
  }

  // sync-service 게이트 — 볼트가 잠겨 있으면 동기화를 시작하지 않는다.
  isVaultReadyForSync(): boolean {
    return (
      (this.vaultState.status === "legacy" &&
        !this.vaultState.migrationRequired) ||
      this.vaultState.status === "unlocked"
    );
  }

  private async requestVaultApi(
    method: string,
    pathname: string,
    body?: unknown,
    operationContext?: VaultOperationContext,
  ): Promise<VaultMutationResponse | null> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | null = null;
    const timeoutError = new Error(VAULT_API_REQUEST_TIMEOUT_MESSAGE);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, VAULT_API_REQUEST_TIMEOUT_MS);
    });
    const operation = async (): Promise<VaultMutationResponse | null> => {
      const requestOnce = (): Promise<Response> => {
        if (operationContext) {
          this.assertVaultOperationContext(operationContext);
        }
        return fetch(
          new URL(pathname, operationContext?.serverUrl ?? this.getServerUrl()),
          {
            method,
            headers: {
              Authorization: `Bearer ${this.getAccessToken()}`,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          },
        );
      };

      // access 토큰이 마침 만료된 경우를 위해 401/403 이면 refresh 후 1회 재시도한다.
      let response = await requestOnce();
      if (operationContext) {
        this.assertVaultOperationContext(operationContext);
      }
      if (response.status === 401 || response.status === 403) {
        const refreshed = await this.refreshSession();
        if (operationContext) {
          this.assertVaultOperationContext(operationContext);
        }
        if (refreshed.status !== "authenticated") {
          throw new VaultApiError(
            "세션이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.",
          );
        }
        response = await requestOnce();
      }
      if (operationContext) {
        this.assertVaultOperationContext(operationContext);
      }
      if (!response.ok) {
        const message = await toApiErrorMessage(
          response,
          `요청이 실패했습니다. (${response.status})`,
        );
        if (operationContext) {
          this.assertVaultOperationContext(operationContext);
        }
        throw new VaultApiError(message, response.status);
      }
      // 설정/변경/초기화는 새 descriptor에 사용할 {epoch}를 돌려준다. 이전 서버의
      // 204 응답도 허용해 롤링 업데이트 중에는 호출 자체가 깨지지 않게 한다.
      if (response.status === 204) {
        return null;
      }
      try {
        const result = (await response.json()) as VaultMutationResponse;
        if (operationContext) {
          this.assertVaultOperationContext(operationContext);
        }
        return result;
      } catch {
        return null;
      }
    };

    try {
      return await Promise.race([operation(), timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  getVaultStatus(): InternalVaultState["status"] {
    return this.vaultState.status;
  }

  private getCurrentVaultCacheOwner(): VaultCacheOwner {
    const session = this.state.session;
    if (!session) {
      throw new Error("로그인이 필요합니다.");
    }
    return createVaultCacheOwner(session, this.getServerUrl());
  }

  private captureVaultOperationContext(): VaultOperationContext {
    const session = this.state.session;
    if (this.state.status !== "authenticated" || !session) {
      throw new Error("온라인 로그인 상태에서만 사용할 수 있습니다.");
    }
    return {
      userId: session.user.id,
      serverUrl: normalizeServerUrl(this.getServerUrl()),
    };
  }

  private assertVaultOperationContext(context: VaultOperationContext): void {
    const session = this.state.session;
    if (
      this.state.status !== "authenticated" ||
      !session ||
      session.user.id !== context.userId ||
      normalizeServerUrl(this.getServerUrl()) !== context.serverUrl
    ) {
      throw new Error(
        "로그인 계정 또는 서버가 변경되어 동기화 볼트 작업을 취소했습니다.",
      );
    }
  }

  // 동기화 암호 최초 설정(신규 유저) — DEK 를 이 기기에서 만들고 암호로 감싸 서버에
  // 올린다. 서버는 감싼 DEK 만 보관하므로 어떤 시점에도 복호화할 수 없다.
  async setupVault(passphrase: string): Promise<void> {
    if (this.vaultState.status !== "setup-required") {
      throw new Error("이미 동기화 암호가 설정되어 있습니다.");
    }
    const setupState = this.vaultState;
    const operationContext = this.captureVaultOperationContext();
    assertValidNewVaultPassphrase(passphrase);

    const dek = createVaultDek();
    const kdf = createVaultKdfDescriptor();
    const kek = await deriveVaultKek(desktopArgon2idDerive, passphrase, kdf);
    const wrappedDekBase64 = wrapVaultDek(dek, kek);
    const dekVerifierBase64 = computeVaultDekVerifier(dek);

    let mutation: VaultMutationResponse | null = null;
    try {
      mutation = await this.requestVaultApi(
        "POST",
        "/auth/vault",
        {
          wrappedDekBase64,
          dekVerifierBase64,
          kdf,
          expectedEpoch: setupState.epoch,
        },
        operationContext,
      );
    } catch (error) {
      if (error instanceof VaultApiError && error.status === 409) {
        // 다른 기기가 먼저 설정했다 — 세션을 갱신해 descriptor 를 받아
        // 잠금해제 플로우로 전환한다(refresh 가 vaultState 를 다시 계산한다).
        await this.refreshSession().catch(() => undefined);
      }
      throw error;
    }
    this.assertVaultOperationContext(operationContext);

    const dekBase64 = fromByteArray(dek);
    const epoch = mutation?.epoch ?? 0;
    const wrapRevision = mutation?.wrapRevision ?? 0;
    const owner = this.getCurrentVaultCacheOwner();
    await this.persistVaultDekCache(dekBase64, epoch, wrapRevision, owner, {
      wrappedDekBase64,
      kdf,
      dekVerifierBase64,
    });
    this.assertVaultOperationContext(operationContext);
    this.vaultState = {
      status: "unlocked",
      dekBase64,
      wrappedDekBase64,
      kdf,
      epoch,
      wrapRevision,
      owner,
      dekVerifierBase64,
    };
    this.log({
      level: "info",
      category: "audit",
      message: "동기화 암호를 설정했습니다(종단간 암호화 활성).",
      metadata: { userId: this.state.session?.user.id ?? null },
    });
    this.patchState({});
    // 알고 있는 값으로 저장 세션의 descriptor 를 즉시 합성 — 아래 refresh 가 실패해도
    // 재시작 시 콜드 복원이 어긋나지 않는다.
    await this.persistSynthesizedVaultDescriptor();
    this.assertVaultOperationContext(operationContext);
    // 세션 descriptor 를 서버 기준으로도 갱신한다. 갱신 전에 낡은 descriptor 가
    // 도착해도 epoch 규칙(내 epoch 보다 낮으면 무시)이 방금 만든 DEK 를 보호한다.
    await this.refreshSession().catch(() => undefined);
    this.assertVaultOperationContext(operationContext);
  }

  // 동기화 암호 입력(새 기기) — 오답이면 GCM 인증 실패로 unwrap 이 던져진다.
  async unlockVault(passphrase: string): Promise<void> {
    if (this.vaultState.status !== "locked") {
      return;
    }

    const operationContext = this.captureVaultOperationContext();
    let dek: Uint8Array;
    try {
      const kek = await deriveVaultKek(
        desktopArgon2idDerive,
        passphrase,
        this.vaultState.kdf,
      );
      dek = unwrapVaultDek(this.vaultState.wrappedDekBase64, kek);
    } catch {
      throw new Error("동기화 암호가 올바르지 않습니다.");
    }
    this.assertVaultOperationContext(operationContext);

    const locked = this.vaultState;
    const dekBase64 = fromByteArray(dek);
    const dekVerifierBase64 = computeVaultDekVerifier(dek);
    if (
      locked.dekVerifierBase64 &&
      locked.dekVerifierBase64 !== dekVerifierBase64
    ) {
      await this.refreshSession().catch(() => undefined);
      throw new Error(
        "동기화 볼트의 키 검증에 실패했습니다. 세션을 새로고침한 뒤 다시 시도해 주세요.",
      );
    }
    const owner = this.getCurrentVaultCacheOwner();
    await this.persistVaultDekCache(
      dekBase64,
      locked.epoch,
      locked.wrapRevision,
      owner,
      {
        wrappedDekBase64: locked.wrappedDekBase64,
        kdf: locked.kdf,
        dekVerifierBase64,
      },
    );
    this.assertVaultOperationContext(operationContext);
    // unlock 은 현재 wrapped DEK 를 실제로 풀었으므로 암호학적으로 검증된 상태다.
    this.vaultState = {
      status: "unlocked",
      dekBase64,
      wrappedDekBase64: locked.wrappedDekBase64,
      kdf: locked.kdf,
      epoch: locked.epoch,
      wrapRevision: locked.wrapRevision,
      owner,
      dekVerifierBase64,
    };
    this.patchState({});
    // verifier 도입 이전 볼트(descriptor 에 verifier 없음)는 여기서 지연 백필한다 —
    // 방금 암호로 DEK 를 증명했으므로 이 시점의 verifier 계산만이 안전하다(캐시 신뢰
    // 경로에서 백필하면 낡은 DEK 의 verifier 가 볼트에 박힐 수 있다). 같은 wrapped/kdf
    // 를 그대로 보내는 no-op rewrap 이며, 실패해도 다음 잠금해제가 다시 시도한다.
    if (!locked.dekVerifierBase64) {
      void this.requestVaultApi(
        "PUT",
        "/auth/vault",
        {
          wrappedDekBase64: locked.wrappedDekBase64,
          dekVerifierBase64,
          kdf: locked.kdf,
          expectedEpoch: locked.epoch,
          expectedDekVerifierBase64: "",
          expectedWrapRevision: locked.wrapRevision,
        },
        operationContext,
      ).catch(() => undefined);
    }
  }

  // 볼트 초기화 — 동기화 암호 분실 최후 수단. 서버의 볼트와 sync 데이터를 지우고 새
  // 설정부터 다시 시작한다. 이 기기의 로컬 데이터(state-storage)는 남으므로, 새 암호
  // 설정 후 첫 push 때 로컬 데이터가 서버로 다시 올라간다(자연 복구 경로).
  async resetVault(): Promise<void> {
    const operationContext = this.captureVaultOperationContext();
    const expectedEpoch =
      "epoch" in this.vaultState
        ? this.vaultState.epoch
        : (this.state.session?.vaultBootstrap.epoch ?? 0);
    let mutation: VaultMutationResponse | null;
    try {
      mutation = await this.requestVaultApi(
        "POST",
        "/auth/vault/reset",
        { expectedEpoch },
        operationContext,
      );
    } catch (error) {
      if (error instanceof VaultApiError && error.status === 409) {
        await this.refreshSession().catch(() => undefined);
      }
      throw error;
    }
    this.assertVaultOperationContext(operationContext);
    await this.secretStore.remove(VAULT_DEK_ACCOUNT).catch(() => undefined);
    this.assertVaultOperationContext(operationContext);
    const session = this.state.session;
    const previousEpoch = session?.vaultBootstrap.epoch ?? 0;
    const epoch = mutation?.epoch ?? previousEpoch + 1;
    this.vaultState = { status: "setup-required", epoch };
    if (session) {
      const resetSession: AuthSession = {
        ...session,
        vaultBootstrap: { version: 0, epoch },
      };
      this.patchState({ session: resetSession });
      await this.persistOfflineSessionCache(resetSession).catch(
        () => undefined,
      );
      this.assertVaultOperationContext(operationContext);
    }
    this.log({
      level: "warn",
      category: "audit",
      message: "동기화 볼트를 초기화했습니다(서버 동기화 데이터 삭제).",
      metadata: { userId: this.state.session?.user.id ?? null },
    });
    this.patchState({});
  }

  // 기존(v1) 유저의 E2EE 전환 — 서버가 알고 있던 기존 DEK 를 동기화 암호로 감싸
  // 올리고, 서버는 같은 트랜잭션에서 원문을 삭제한다. DEK 가 그대로라 데이터
  // 재암호화가 없고, pre-seeding 된 다른 기기들도 재입력 없이 이어진다.
  async migrateVault(passphrase: string): Promise<void> {
    if (this.vaultState.status !== "legacy") {
      throw new Error("전환할 수 있는 상태가 아닙니다.");
    }
    const legacyState = this.vaultState;
    const operationContext = this.captureVaultOperationContext();
    assertValidNewVaultPassphrase(passphrase);
    const keyBase64 = this.state.session?.vaultBootstrap.keyBase64;
    if (!keyBase64) {
      throw new Error("세션 vault key가 없습니다.");
    }

    const kdf = createVaultKdfDescriptor();
    const kek = await deriveVaultKek(desktopArgon2idDerive, passphrase, kdf);
    const dek = toByteArray(keyBase64);
    const wrappedDekBase64 = wrapVaultDek(dek, kek);

    let mutation: VaultMutationResponse | null = null;
    try {
      mutation = await this.requestVaultApi(
        "POST",
        "/auth/vault",
        {
          wrappedDekBase64,
          dekVerifierBase64: computeVaultDekVerifier(dek),
          kdf,
          expectedEpoch: legacyState.epoch,
        },
        operationContext,
      );
    } catch (error) {
      if (error instanceof VaultApiError && error.status === 409) {
        // 다른 기기가 먼저 전환했다 — 세션을 갱신하면 v2 descriptor 를 받고,
        // pre-seeding 된 DEK 캐시가 verifier 검증을 통과해 곧바로 unlocked 로 이어진다.
        await this.refreshSession().catch(() => undefined);
        throw new VaultApiError(
          "다른 기기에서 이미 동기화 암호를 설정했습니다. 잠시 후 자동으로 이어집니다.",
          error.status,
        );
      }
      throw error;
    }
    this.assertVaultOperationContext(operationContext);

    const epoch = mutation?.epoch ?? 0;
    const wrapRevision = mutation?.wrapRevision ?? 0;
    const owner = this.getCurrentVaultCacheOwner();
    await this.persistVaultDekCache(keyBase64, epoch, wrapRevision, owner, {
      wrappedDekBase64,
      kdf,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    });
    this.assertVaultOperationContext(operationContext);
    // migrate 는 서버가 검증한 기존 DEK 를 이 기기가 직접 감싼 것 — 검증된 상태다.
    this.vaultState = {
      status: "unlocked",
      dekBase64: keyBase64,
      wrappedDekBase64,
      kdf,
      epoch,
      wrapRevision,
      owner,
      dekVerifierBase64: computeVaultDekVerifier(dek),
    };
    this.log({
      level: "info",
      category: "audit",
      message: "기존 계정을 종단간 암호화로 전환했습니다.",
      metadata: { userId: this.state.session?.user.id ?? null },
    });
    this.patchState({});
    // 알고 있는 값으로 저장 세션의 descriptor 를 즉시 합성(아래 refresh 실패 대비).
    await this.persistSynthesizedVaultDescriptor();
    this.assertVaultOperationContext(operationContext);
    // 세션 descriptor 를 서버 기준으로도 갱신 — 실패해도 다음 refresh 에서 따라온다.
    await this.refreshSession().catch(() => undefined);
    this.assertVaultOperationContext(operationContext);
  }

  // 동기화 암호 변경(rewrap) — DEK 는 그대로라 데이터 재암호화도, 다른 기기의
  // 재입력도 필요 없다.
  async changeVaultPassphrase(
    currentPassphrase: string,
    nextPassphrase: string,
  ): Promise<void> {
    if (!hasCoherentVaultDescriptor(this.vaultState)) {
      throw new Error("동기화 잠금을 해제한 뒤 변경할 수 있습니다.");
    }
    const operationContext = this.captureVaultOperationContext();
    assertValidNewVaultPassphrase(nextPassphrase);

    let unwrappedDek: Uint8Array;
    try {
      const currentKek = await deriveVaultKek(
        desktopArgon2idDerive,
        currentPassphrase,
        this.vaultState.kdf,
      );
      unwrappedDek = unwrapVaultDek(
        this.vaultState.wrappedDekBase64,
        currentKek,
      );
    } catch {
      throw new Error("현재 동기화 암호가 올바르지 않습니다.");
    }
    this.assertVaultOperationContext(operationContext);
    if (fromByteArray(unwrappedDek) !== this.vaultState.dekBase64) {
      throw new Error(
        "로컬 볼트 캐시와 서버 키가 일치하지 않습니다. 세션을 새로고침한 뒤 다시 시도해 주세요.",
      );
    }

    const nextKdf = createVaultKdfDescriptor();
    const nextKek = await deriveVaultKek(
      desktopArgon2idDerive,
      nextPassphrase,
      nextKdf,
    );
    const nextWrappedDekBase64 = wrapVaultDek(
      toByteArray(this.vaultState.dekBase64),
      nextKek,
    );
    this.assertVaultOperationContext(operationContext);

    // 암호 변경은 DEK 를 안 바꾸므로 epoch 도 그대로다(서버가 확인차 돌려준다).
    // verifier 를 함께 보내 verifier 도입 이전 볼트라면 이 기회에 백필한다(unlocked =
    // DEK 증명 완료 시점이므로 안전).
    const currentVerifier =
      this.vaultState.dekVerifierBase64 ??
      computeVaultDekVerifier(toByteArray(this.vaultState.dekBase64));
    let mutation: VaultMutationResponse | null;
    try {
      mutation = await this.requestVaultApi(
        "PUT",
        "/auth/vault",
        {
          wrappedDekBase64: nextWrappedDekBase64,
          dekVerifierBase64: computeVaultDekVerifier(
            toByteArray(this.vaultState.dekBase64),
          ),
          kdf: nextKdf,
          expectedEpoch: this.vaultState.epoch,
          expectedDekVerifierBase64: this.vaultState.dekVerifierBase64 ?? "",
          expectedWrapRevision: this.vaultState.wrapRevision,
        },
        operationContext,
      );
    } catch (error) {
      if (error instanceof VaultApiError && error.status === 409) {
        await this.refreshSession().catch(() => undefined);
      }
      throw error;
    }
    this.assertVaultOperationContext(operationContext);
    const epoch = mutation?.epoch ?? this.vaultState.epoch;
    const wrapRevision =
      mutation?.wrapRevision ?? this.vaultState.wrapRevision + 1;
    const dekVerifierBase64 = computeVaultDekVerifier(
      toByteArray(this.vaultState.dekBase64),
    );
    const owner = this.getCurrentVaultCacheOwner();
    await this.persistVaultDekCache(
      this.vaultState.dekBase64,
      epoch,
      wrapRevision,
      owner,
      {
        wrappedDekBase64: nextWrappedDekBase64,
        kdf: nextKdf,
        dekVerifierBase64,
      },
    );
    this.assertVaultOperationContext(operationContext);
    this.vaultState = {
      status: "unlocked",
      dekBase64: this.vaultState.dekBase64,
      wrappedDekBase64: nextWrappedDekBase64,
      kdf: nextKdf,
      epoch,
      wrapRevision,
      owner,
      dekVerifierBase64: currentVerifier,
    };
    this.patchState({});
    // 새 wrapped/kdf 를 저장 세션 descriptor 에도 즉시 반영 — 재시작 시 잠금 화면이
    // 옛 wrapped(옛 암호) 기준으로 뜨지 않게 한다.
    await this.persistSynthesizedVaultDescriptor();
    this.assertVaultOperationContext(operationContext);
  }

  // 볼트 변이(설정/전환/암호변경) 성공 직후, 네트워크 refresh 에 기대지 않고 알고 있는
  // 값(wrapped/kdf/epoch/verifier)으로 세션 descriptor 를 즉시 합성해 저장한다 —
  // 직후의 refresh 가 실패한 채 재시작(특히 오프라인)해도 저장 세션과 DEK 캐시의
  // epoch 이 어긋나 콜드 복원이 깨지지 않게 한다.
  private async persistSynthesizedVaultDescriptor(): Promise<void> {
    const session = this.state.session;
    if (!session || !hasCoherentVaultDescriptor(this.vaultState)) {
      return;
    }
    const synthesized: AuthSession = {
      ...session,
      vaultBootstrap: {
        version: 2,
        wrappedDekBase64: this.vaultState.wrappedDekBase64,
        epoch: this.vaultState.epoch,
        wrapRevision: this.vaultState.wrapRevision,
        dekVerifierBase64: computeVaultDekVerifier(
          toByteArray(this.vaultState.dekBase64),
        ),
        kdf: this.vaultState.kdf,
      },
    };
    this.patchState({ session: synthesized });
    await this.persistOfflineSessionCache(synthesized).catch(() => undefined);
  }

  // DEK 캐시를 갱신한다 — DEK 와 epoch 을 단일 엔트리(JSON)로 원자적으로 저장한다.
  private async persistVaultDekCache(
    dekBase64: string,
    epoch: number,
    wrapRevision: number,
    owner: VaultCacheOwner,
    descriptor?: {
      wrappedDekBase64: string;
      kdf: VaultKdfDescriptor;
      dekVerifierBase64?: string;
    },
  ): Promise<void> {
    const serialized = JSON.stringify({
      version: 2,
      owner,
      dekBase64,
      epoch,
      wrapRevision,
      ...(descriptor
        ? {
            wrappedDekBase64: descriptor.wrappedDekBase64,
            kdf: descriptor.kdf,
            dekVerifierBase64:
              descriptor.dekVerifierBase64 ??
              computeVaultDekVerifier(toByteArray(dekBase64)),
          }
        : {}),
    } satisfies VaultCacheRecord);
    try {
      await this.secretStore.save(VAULT_DEK_ACCOUNT, serialized);
    } catch (error) {
      this.log({
        level: "warn",
        category: "audit",
        message:
          "동기화 키를 보안 저장소에 저장하지 못했습니다. 이번 실행에서는 잠금 해제 상태를 유지합니다.",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    // dekId 시절의 잔재 엔트리 정리(더 이상 읽지 않는다).
    await this.secretStore
      .remove(LEGACY_VAULT_DEK_ID_ACCOUNT)
      .catch(() => undefined);
  }

  // push fence 헤더에 실을 DEK 세대. unlocked 가 아니면 null(push 자체가 불가).
  getVaultEpoch(): number | null {
    return this.vaultState.status === "unlocked" ? this.vaultState.epoch : null;
  }

  // 서버가 push 를 볼트 세대 문제로 거부(409 vault_reset/vault_dek_mismatch)했거나 pull
  // 복호화가 실패했을 때 sync-service 가 부른다. 여기서 캐시를 지우지 않는다 — 세션을
  // 갱신해 새 descriptor 를 받으면 resolve 의 epoch/verifier 판정이 정확히 결정한다:
  // 진짜 세대 교체면 locked 경로가 캐시를 정리하고, 자기 재설정 직후의 낡은 응답이면
  // epoch 규칙이 무시한다. refresh 가 실패하면 상태를 바꾸지 않는다(비파괴) — 다음
  // 폴링/refresh 재시도가 다시 이 경로를 밟는다.
  async handleVaultDekRejected(): Promise<void> {
    if (this.vaultState.status === "none") {
      return;
    }
    const statusBefore = this.vaultState.status;
    await this.refreshSession().catch(() => undefined);
    const statusAfter = (this.vaultState as InternalVaultState).status;
    if (statusBefore === "unlocked" && statusAfter === "locked") {
      this.log({
        level: "warn",
        category: "audit",
        message:
          "다른 기기에서 동기화 암호가 초기화되어 이 기기의 잠금을 해제해야 합니다.",
        metadata: { userId: this.state.session?.user.id ?? null },
      });
    }
    this.patchState({});
  }

  private async requestSession(
    pathname: string,
    payload: Record<string, unknown>,
  ): Promise<AuthSession> {
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.getServerUrl()), {
        method: "POST",
        headers: this.buildAuthHeaders(),
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
        headers: this.buildAuthHeaders(),
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
      const normalizedAuthMessage = normalizeAuthInvalidErrorMessage({
        status: response.status,
        message,
      });
      if (response.status === 401 || response.status === 403) {
        throw new SessionRequestError(
          normalizedAuthMessage ?? message,
          "auth",
          response.status,
        );
      }
      if (response.status >= 500) {
        throw new SessionRequestError(message, "server", response.status);
      }
      throw new SessionRequestError(
        normalizedAuthMessage ?? message,
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
      // 이전 계정의 DEK 가 새 계정으로 흘러가지 않게 지운다 — 저장 캐시와 메모리 모두.
      // (메모리를 남기면 아래 판정의 hot-path/floor 가 이전 계정의 DEK 를 새 계정
      // 세션에 결합시킬 수 있다.)
      await this.secretStore.remove(VAULT_DEK_ACCOUNT).catch(() => undefined);
      this.vaultState = { status: "none" };
    }

    await this.notifySessionActivated({
      userId: session.user.id,
      serverUrl: normalizedServerUrl,
    });

    // 저장(offline cache)·게시 전에 판정을 먼저 수행하고 epoch floor 를 적용한다 —
    // 판정 결과보다 낡은 descriptor(자기 재설정 직후의 in-flight 응답)를 그대로
    // 저장하면 저장 세션이 keychain 캐시보다 낡아져, 콜드 부팅이 "새 DEK + 옛
    // wrapped/kdf" 조합의 unlocked 를 만들어 암호 변경의 현재암호 확인이 어긋난다.
    this.vaultState = await this.resolveVaultStateForSession(session);
    const flooredSession = this.applyVaultEpochFloor(session);

    let persistenceDisabledMessage: string | null = null;
    try {
      await this.secretStore.save(
        REFRESH_TOKEN_ACCOUNT,
        session.tokens.refreshToken,
      );
      await this.persistOfflineSessionCache(flooredSession);
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
      session: flooredSession,
      offline: null,
      errorMessage: persistenceDisabledMessage,
    });
    this.offlineRetryDelayMs = OFFLINE_RETRY_INITIAL_DELAY_MS;
    this.scheduleRefresh(session.tokens.expiresInSeconds);
  }

  // epoch floor: 서버 epoch 은 단조이므로 버전과 무관하게 내 coherent cache 보다 낮은
  // descriptor 는 낡은 응답이다. v0에도 epoch을 싣는 신서버에서는 실제 reset(높은 epoch)
  // 과 자기 설정 직후 늦게 도착한 v0(낮은 epoch)을 정확히 구분할 수 있다.
  private applyVaultEpochFloor(session: AuthSession): AuthSession {
    const vault = this.vaultState;
    if (!hasCoherentVaultDescriptor(vault)) {
      return session;
    }
    const bootstrap = session.vaultBootstrap;
    const descriptorEpoch =
      typeof bootstrap.epoch === "number" ? bootstrap.epoch : 0;
    const legacyVersionZeroWithoutEpoch =
      bootstrap.version === 0 && bootstrap.epoch === undefined;
    const descriptorWrapRevision =
      typeof bootstrap.wrapRevision === "number" ? bootstrap.wrapRevision : 0;
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
  }

  // 세션 descriptor 와 캐시된 DEK 로 볼트 상태를 결정한다. 판정은 shared-core 의
  // decideVaultAccess(epoch 순서 + verifier 정체성 증명) 하나뿐이다 — 로컬 unlocked
  // 신뢰 휴리스틱이나 미검증 임시 채택 없이, 어느 시점의 재해석이든 같은 규칙을 탄다.
  private async resolveVaultStateForSession(
    session: AuthSession,
  ): Promise<InternalVaultState> {
    try {
      const descriptor = resolveVaultDescriptorState(session.vaultBootstrap);
      const owner = createVaultCacheOwner(session, this.getServerUrl());
      const local =
        this.vaultState.status === "unlocked"
          ? {
              dekBase64: this.vaultState.dekBase64,
              epoch: this.vaultState.epoch as number | null,
              wrapRevision: this.vaultState.wrapRevision as number | null,
              owner: this.vaultState.owner,
              ...(hasCoherentVaultDescriptor(this.vaultState)
                ? {
                    wrappedDekBase64: this.vaultState.wrappedDekBase64,
                    kdf: this.vaultState.kdf,
                    dekVerifierBase64:
                      verifierOfCachedDek(this.vaultState.dekBase64) ??
                      undefined,
                  }
                : {}),
            }
          : null;
      let cached =
        local ??
        parseStoredVaultDek(
          await this.secretStore.load(VAULT_DEK_ACCOUNT).catch(() => null),
        );

      if (cached?.owner && !vaultCacheOwnersEqual(cached.owner, owner)) {
        await this.secretStore.remove(VAULT_DEK_ACCOUNT).catch(() => undefined);
        cached = null;
      } else if (cached && !cached.owner) {
        const ownerProven =
          (descriptor.kind === "legacy" &&
            descriptor.keyBase64 === cached.dekBase64) ||
          (descriptor.kind === "e2ee" &&
            Boolean(descriptor.dekVerifierBase64) &&
            descriptor.dekVerifierBase64 ===
              verifierOfCachedDek(cached.dekBase64));
        if (!ownerProven) {
          await this.secretStore
            .remove(VAULT_DEK_ACCOUNT)
            .catch(() => undefined);
          cached = null;
        }
      }

      if (
        descriptor.kind === "setup-required" ||
        descriptor.kind === "legacy"
      ) {
        const descriptorEpoch = descriptor.epoch ?? 0;
        if (
          cached?.epoch !== null &&
          cached?.epoch !== undefined &&
          descriptorEpoch < cached.epoch
        ) {
          return unlockedVaultStateFromCache(cached);
        }
        if (
          descriptor.kind === "setup-required" &&
          descriptor.epoch === undefined &&
          cached?.wrappedDekBase64 &&
          cached.kdf
        ) {
          // epoch 도입 전 v0 응답은 E2EE 설정 직후의 늦은 응답일 수 있다. 완전한 로컬
          // descriptor가 있을 때만 보존하며, DEK-only 구형 캐시에는 이 예외를 주지 않는다.
          return unlockedVaultStateFromCache(cached);
        }
      }

      if (descriptor.kind === "legacy") {
        // v1 키를 DEK 캐시에 선저장(pre-seeding) — 나중에 이 계정이 어느 기기에서든
        // E2EE 로 전환돼도(DEK 동일 → verifier 일치) 이 기기는 재입력 없이 잠금이 풀린다.
        void this.persistVaultDekCache(
          descriptor.keyBase64,
          descriptor.epoch ?? 0,
          0,
          owner,
        );
        return {
          status: "legacy",
          epoch: descriptor.epoch ?? 0,
          migrationRequired: descriptor.e2eeRequired === true,
        };
      }
      if (descriptor.kind === "setup-required") {
        // 같은/높은 epoch 의 v0는 실제 reset 상태다. 옛 DEK 캐시를 지우고 재설정한다.
        if (cached) {
          await this.secretStore
            .remove(VAULT_DEK_ACCOUNT)
            .catch(() => undefined);
        }
        return { status: "setup-required", epoch: descriptor.epoch ?? 0 };
      }

      const decision = decideVaultAccess({
        descriptorEpoch: descriptor.epoch,
        descriptorVerifier: descriptor.dekVerifierBase64,
        cachedDekVerifier: verifierOfCachedDek(cached?.dekBase64),
        cachedEpoch: cached?.epoch ?? null,
        descriptorWrapRevision: descriptor.wrapRevision,
        cachedWrapRevision: cached?.wrapRevision ?? null,
      });
      switch (decision.kind) {
        case "ignore-descriptor": {
          // descriptor 가 내 캐시 epoch 보다 낡았다(자기 재설정 직후의 in-flight 응답,
          // 또는 재설정 후 갱신되지 못한 저장 세션). 살아있는 unlocked 상태가 있으면
          // 그대로 유지하고, 콜드 부팅(none 등)이면 캐시가 진실이므로 캐시로 복원한다
          // — 안 하면 오프라인 재시작에서 볼트가 none 으로 떠 복원이 깨진다.
          if (this.vaultState.status === "unlocked") {
            return this.vaultState;
          }
          return unlockedVaultStateFromCache(cached as StoredVaultDek);
        }
        case "locked":
          if (cached) {
            // verifier 불일치 = DEK 세대 교체(다른 기기의 초기화+재설정). 옛 캐시를
            // 버리고 새 암호를 받는다.
            await this.secretStore
              .remove(VAULT_DEK_ACCOUNT)
              .catch(() => undefined);
          }
          return {
            status: "locked",
            wrappedDekBase64: descriptor.wrappedDekBase64,
            kdf: descriptor.kdf,
            epoch: descriptor.epoch ?? 0,
            wrapRevision: descriptor.wrapRevision ?? 0,
            dekVerifierBase64: descriptor.dekVerifierBase64,
          };
        case "unlocked":
        case "unlocked-unverifiable": {
          // unlocked: verifier 일치 — 캐시 DEK 가 이 볼트의 DEK 임이 증명됐다.
          // unlocked-unverifiable: verifier 이전 볼트/구서버 — 검증 수단이 없어 기존
          // 신뢰를 유지한다(잠금해제 시 verifier 백필로 점차 사라지는 상태).
          const dekBase64 = (cached as { dekBase64: string }).dekBase64;
          // descriptor 와 DEK 정체성이 확인된 시점에 구형 캐시도 coherent v2 레코드로
          // 승격한다. 이후 콜드 부팅은 낡은 descriptor 의 wrapper를 빌리지 않는다.
          await this.persistVaultDekCache(
            dekBase64,
            decision.epoch,
            descriptor.wrapRevision ?? 0,
            owner,
            {
              wrappedDekBase64: descriptor.wrappedDekBase64,
              kdf: descriptor.kdf,
              dekVerifierBase64:
                descriptor.dekVerifierBase64 ??
                verifierOfCachedDek(dekBase64) ??
                undefined,
            },
          );
          return {
            status: "unlocked",
            dekBase64,
            wrappedDekBase64: descriptor.wrappedDekBase64,
            kdf: descriptor.kdf,
            epoch: decision.epoch,
            wrapRevision: descriptor.wrapRevision ?? 0,
            owner,
            dekVerifierBase64:
              descriptor.dekVerifierBase64 ??
              verifierOfCachedDek(dekBase64) ??
              undefined,
          };
        }
      }
      // switch 가 전 케이스를 다루므로 도달 불가 — 타입 좁히기용.
      return this.vaultState;
    } catch (error) {
      return {
        status: "error",
        errorMessage:
          error instanceof Error && error.message.trim()
            ? error.message
            : "동기화 볼트 상태를 복원할 수 없습니다.",
      };
    }
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
      purgeLocalData?: boolean;
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
    // 잠금해제된 DEK 는 명시적 이탈(로그아웃·탈퇴·계정 교체)에서만 지운다.
    // 세션 만료(auth-invalid)는 재로그인 시 같은 계정이므로 캐시를 유지해
    // 동기화 암호 재입력을 피한다.
    if (
      options.reason === "logout" ||
      options.reason === "account-deleted" ||
      options.reason === "account-changed"
    ) {
      await this.secretStore.remove(VAULT_DEK_ACCOUNT).catch(() => undefined);
      await this.secretStore
        .remove(LEGACY_VAULT_DEK_ID_ACCOUNT)
        .catch(() => undefined);
    }
    this.vaultState = { status: "none" };
    this.serverVaultE2eeSupported = null;
    this.serverVaultE2eeSupportServerUrl = null;
    this.exchangeInFlightCode = null;
    this.pendingBrowserLoginState = null;
    this.pendingBrowserLoginUrl = null;
    this.state = {
      status: nextState.status,
      session: null,
      offline: null,
      errorMessage: nextState.errorMessage ?? null,
      vault: null,
    };
    this.stateStorage.updateAuthStatus(
      nextState.status === "offline-authenticated"
        ? "offline-authenticated"
        : "unauthenticated",
    );
    await this.notifySessionInvalidated({
      reason: options.reason,
      purgeSyncedCache: options.purgeSyncedCache,
      purgeLocalData: options.purgeLocalData === true,
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
    await this.notifySessionActivated({
      userId: offlineSession.user.id,
      serverUrl: cache.serverUrl,
    });
    this.stateStorage.updateAuthStatus("offline-authenticated");
    // E2EE 잠금해제는 서버 없이도 가능하다 — 캐시 descriptor + 저장된 DEK 로 복원.
    this.vaultState = await this.resolveVaultStateForSession(offlineSession);
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

  private async notifySessionActivated(
    context: SessionActivatedContext,
  ): Promise<void> {
    if (!this.onSessionActivated) {
      return;
    }
    await this.onSessionActivated(context);
  }

  // sync-service 가 /api/info 를 읽을 때 서버의 E2EE 지원 여부를 알려준다.
  // 셀프호스팅 구버전 서버에서는 전환 프롬프트를 띄우지 않기 위한 신호.
  noteServerVaultSupport(supported: boolean): void {
    const serverUrl = normalizeServerUrl(this.getServerUrl());
    if (
      this.serverVaultE2eeSupported === supported &&
      this.serverVaultE2eeSupportServerUrl === serverUrl
    ) {
      return;
    }
    this.serverVaultE2eeSupported = supported;
    this.serverVaultE2eeSupportServerUrl = serverUrl;
    this.patchState({});
  }

  resetServerVaultSupport(): void {
    if (
      this.serverVaultE2eeSupported === null &&
      this.serverVaultE2eeSupportServerUrl === null
    ) {
      return;
    }
    this.serverVaultE2eeSupported = null;
    this.serverVaultE2eeSupportServerUrl = null;
    this.patchState({});
  }

  // sync-service 가 /api/info 를 읽을 때 서버의 패스키(WebAuthn) 지원 여부를 알려준다.
  // 설정 화면의 패스키 섹션 노출 게이트로만 쓰인다.
  noteServerWebauthnSupport(supported: boolean): void {
    const serverUrl = normalizeServerUrl(this.getServerUrl());
    if (
      this.serverWebauthnSupported === supported &&
      this.serverWebauthnSupportServerUrl === serverUrl
    ) {
      return;
    }
    this.serverWebauthnSupported = supported;
    this.serverWebauthnSupportServerUrl = serverUrl;
    this.patchState({});
  }

  resetServerWebauthnSupport(): void {
    if (
      this.serverWebauthnSupported === null &&
      this.serverWebauthnSupportServerUrl === null
    ) {
      return;
    }
    this.serverWebauthnSupported = null;
    this.serverWebauthnSupportServerUrl = null;
    this.patchState({});
  }

  // 패스키(WebAuthn) 등록/관리 요청 — Bearer 인증 + access 토큰 만료(401/403) 시 refresh 후
  // 1회 재시도. 회원탈퇴/비밀번호 변경과 동일한 인증 패턴이다.
  private async requestWebauthnApi(
    method: string,
    pathname: string,
  ): Promise<unknown> {
    const requestOnce = (): Promise<Response> =>
      fetch(new URL(pathname, this.getServerUrl()), {
        method,
        headers: {
          Authorization: `Bearer ${this.getAccessToken()}`,
        },
      });

    let response = await requestOnce();
    if (response.status === 401 || response.status === 403) {
      const refreshed = await this.refreshSession();
      if (refreshed.status !== "authenticated") {
        throw new Error(
          "세션이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.",
        );
      }
      response = await requestOnce();
    }
    if (!response.ok) {
      const fallback = `요청이 실패했습니다. (${response.status})`;
      const message = await response
        .json()
        .then((body: { error?: unknown }) =>
          typeof body.error === "string" && body.error.trim()
            ? body.error
            : fallback,
        )
        .catch(() => fallback);
      throw new Error(message);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json().catch(() => null);
  }

  // 설정의 "패스키 추가" — 등록 티켓을 받아 시스템 브라우저로 등록 페이지를 연다.
  // 실제 등록(Touch ID 등 ceremony)은 서버 도메인 origin 의 브라우저에서만 가능하다.
  async beginPasskeyRegistration(): Promise<void> {
    const result = (await this.requestWebauthnApi(
      "POST",
      "/api/webauthn/registration-ticket",
    )) as { ticket?: unknown } | null;
    const ticket = result?.ticket;
    if (typeof ticket !== "string" || !ticket) {
      throw new Error("패스키 등록을 시작할 수 없습니다.");
    }
    // 서버가 준 URL 을 그대로 열지 않고 설정된 serverUrl 로 직접 조립한다 — 침해/오설정 서버가
    // file:// 같은 임의 URL 을 shell.openExternal 로 열게 하는 것을 차단한다. 티켓은 fragment 로
    // 실어 서버 로그·브라우저 히스토리에 남지 않게 한다.
    const registerUrl = new URL("/auth/webauthn/register", this.getServerUrl());
    registerUrl.hash = "ticket=" + encodeURIComponent(ticket);
    if (registerUrl.protocol !== "https:" && registerUrl.protocol !== "http:") {
      throw new Error("등록 링크가 올바르지 않습니다.");
    }
    await shell.openExternal(registerUrl.toString());
  }

  async listPasskeys(): Promise<PasskeyCredential[]> {
    const result = (await this.requestWebauthnApi(
      "GET",
      "/api/webauthn/credentials",
    )) as { credentials?: unknown } | null;
    return Array.isArray(result?.credentials)
      ? (result.credentials as PasskeyCredential[])
      : [];
  }

  async deletePasskey(credentialId: string): Promise<void> {
    await this.requestWebauthnApi(
      "DELETE",
      `/api/webauthn/credentials/${encodeURIComponent(credentialId)}`,
    );
  }

  private patchState(patch: Partial<AuthState>): void {
    // 패치 적용 후의 status 를 미리 계산한다(capabilities 게이트가 최신 status 를 봐야 하므로).
    const nextStatus = patch.status ?? this.state.status;
    this.state = {
      ...this.state,
      ...patch,
      // 렌더러 게이트가 읽는 볼트 상태 — 민감 재료 없이 status 만 내보낸다.
      vault:
        this.vaultState.status === "none"
          ? null
          : {
              status: this.vaultState.status,
              ...(this.vaultState.status === "error"
                ? { errorMessage: this.vaultState.errorMessage }
                : {}),
              canMigrate:
                this.vaultState.status === "legacy" &&
                this.serverVaultE2eeSupported === true &&
                this.serverVaultE2eeSupportServerUrl ===
                  normalizeServerUrl(this.getServerUrl()),
              migrationRequired:
                this.vaultState.status === "legacy" &&
                this.vaultState.migrationRequired,
            },
      // 온라인 인증 상태 + 현재 서버 URL 일치일 때만 지원으로 노출한다 — 서버가 바뀌면 재조회
      // 전까지 false, 오프라인이면 등록/조회 자체가 불가하므로 숨긴다(섹션이 떠서 버튼마다
      // 오프라인 에러가 나는 것을 막는다).
      capabilities: {
        webauthn:
          nextStatus === "authenticated" &&
          this.serverWebauthnSupported === true &&
          this.serverWebauthnSupportServerUrl ===
            normalizeServerUrl(this.getServerUrl()),
      },
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
          true,
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

// autoClose: 성공 화면에서만 탭을 닫는다. 실패 화면을 닫으면 에러 메시지를 못 보게 된다.
// 브라우저는 세션 히스토리 항목이 1개인 탭만 스크립트로 닫도록 허용하므로, 로그인 페이지가
// location.replace 로 이 콜백에 도달한 경우(패스키 로그인)에만 실제로 닫힌다. 비밀번호/OIDC
// 로그인은 항목이 여러 개라 닫기가 무시되고, 아래 안내문이 그대로 남는다.
function renderLoopbackCallbackPage(
  title: string,
  message: string,
  autoClose = false,
): string {
  const autoCloseScript = autoClose
    ? `<script>setTimeout(function () { try { window.close(); } catch (error) {} }, 600);</script>`
    : "";
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
    ${autoCloseScript}
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
