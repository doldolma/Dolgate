import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { AuthSession } from "@shared";

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === "userData" ? tempDir : os.tmpdir(),
    ),
    getVersion: vi.fn(() => "1.6.1-test"),
    isPackaged: false,
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) =>
      Buffer.from(value).toString("utf8"),
    ),
  },
}));

// 상태 머신 테스트는 Argon2 구현 자체가 아니라 descriptor/cache 전이를 검증한다.
// 프로덕션 지원 프로필(64MiB/3/1)은 유지하되 KDF primitive만 빠른 결정 함수로 대체한다.
vi.mock("./vault-crypto", () => ({
  desktopArgon2idDerive: vi.fn(
    async (
      passphrase: Uint8Array,
      salt: Uint8Array,
      params: { outputLength: number },
    ) => {
      const output = new Uint8Array(params.outputLength);
      [...passphrase, ...salt].forEach((value, index) => {
        const target = index % output.length;
        output[target] = (output[target] + value + index) & 0xff;
      });
      return output;
    },
  ),
}));

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signOfflineLease(
  serverUrl: string,
  userId: string,
  expiresAt: Date,
): AuthSession["offlineLease"] {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const issuedAt = new Date();
  const payload = base64url(
    JSON.stringify({
      iss: new URL(serverUrl).origin,
      sub: userId,
      aud: ["dolgate-desktop"],
      iat: Math.floor(issuedAt.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  return {
    token: `${signingInput}.${signer.sign(privateKey).toString("base64url")}`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    verificationPublicKeyPem: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  };
}

// DEK 캐시 키는 계정별이다. 문자열을 테스트에 흩어 두면 키가 바뀔 때마다 전부 깨지므로
// 여기 한 곳에서 만든다.
function dekAccount(userId = "user-1"): string {
  return `auth:vault-dek:${userId}`;
}

function createSession(serverUrl: string, userId = "user-1"): AuthSession {
  return {
    user: {
      id: userId,
      email: "user@example.com",
    },
    tokens: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 900,
    },
    vaultBootstrap: {
      keyBase64: Buffer.alloc(32, 1).toString("base64"),
    },
    offlineLease: signOfflineLease(
      serverUrl,
      userId,
      new Date(Date.now() + 72 * 60 * 60 * 1000),
    ),
    syncServerTime: new Date().toISOString(),
  };
}

function expectedDesktopPlatform(): string {
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

async function createService(serverUrl = "https://ssh.doldolma.com") {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();

  const stateStorageModule = await import("./state-storage");
  stateStorageModule.resetDesktopStateStorageForTests();
  const { SecretStore } = await import("./secret-store");
  const { AuthService } = await import("./auth-service");

  const secretStore = new SecretStore();
  const configService = {
    getConfig: () => ({
      sync: {
        desktopClientId: "dolgate-desktop",
        redirectUri: "dolgate://auth/callback",
      },
    }),
  };
  let currentServerUrl = serverUrl;
  const settings = {
    get: () => ({
      serverUrl: currentServerUrl,
    }),
  };

  return {
    secretStore,
    service: new AuthService(
      secretStore,
      configService as never,
      settings as never,
    ),
    setServerUrl: (nextServerUrl: string) => {
      currentServerUrl = nextServerUrl;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolssh-auth-service-"));
});

describe("AuthService offline bootstrap", () => {
  it("captures the account, server, DEK and epoch as one sync context", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore, setServerUrl } =
      await createService(serverUrl);
    const session = createSession(serverUrl);
    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await service.bootstrap();
    const context = service.captureSyncContext();

    expect(context).toEqual({
      userId: session.user.id,
      serverUrl: `${serverUrl}/`,
      accessToken: session.tokens.accessToken,
      vaultKeyBase64: session.vaultBootstrap.keyBase64,
      vaultEpoch: null,
    });
    expect(service.isSyncContextCurrent(context)).toBe(true);
    expect(
      service.isSyncContextCurrent({
        ...context,
        vaultKeyBase64: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toBe(false);
    expect(
      service.isSyncContextCurrent({
        ...context,
        vaultEpoch: 1,
      }),
    ).toBe(false);
    setServerUrl("https://other.example.com");
    expect(service.isSyncContextCurrent(context)).toBe(false);
  });

  it("enters offline-authenticated when refresh fails but a valid offline lease is cached", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);
    const onSessionActivated = vi.fn();
    service.setOnSessionActivated(onSessionActivated);

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      "auth:offline-session-cache",
      JSON.stringify({
        serverUrl: `${serverUrl}/`,
        user: session.user,
        vaultBootstrap: session.vaultBootstrap,
        offlineLease: session.offlineLease,
        lastOnlineAt: session.syncServerTime,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const state = await service.bootstrap();

    expect(state.status).toBe("offline-authenticated");
    expect(state.session?.user.id).toBe(session.user.id);
    expect(
      Math.abs(
        new Date(state.offline?.expiresAt ?? 0).getTime() -
          new Date(session.offlineLease.expiresAt).getTime(),
      ),
    ).toBeLessThan(1_500);
    expect(service.getVaultKeyBase64()).toBe(session.vaultBootstrap.keyBase64);
    expect(() => service.getAccessToken()).toThrow(
      "오프라인 모드에서는 서버 연결이 필요한 기능을 사용할 수 없습니다.",
    );
    expect(onSessionActivated).toHaveBeenCalledWith({
      userId: session.user.id,
      serverUrl: `${serverUrl}/`,
    });
  });

  // 화면은 capabilities.dataFloor 로 RDP 호스트 추가를 열고 닫는다. 그 판정이 이번 실행의
  // /api/info 응답에만 있으면, 오프라인으로 앱을 켠 사용자에게는 어제 있던 기능이 사라진다.
  describe("dataFloor 능력", () => {
    async function bootstrapOffline(serverUrl: string) {
      const created = await createService(serverUrl);
      const session = createSession(serverUrl);
      await created.secretStore.save(
        "auth:refresh-token",
        session.tokens.refreshToken,
      );
      await created.secretStore.save(
        "auth:offline-session-cache",
        JSON.stringify({
          serverUrl: `${serverUrl}/`,
          user: session.user,
          vaultBootstrap: session.vaultBootstrap,
          offlineLease: session.offlineLease,
          lastOnlineAt: session.syncServerTime,
        }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("network down")),
      );
      const state = await created.service.bootstrap();
      expect(state.status).toBe("offline-authenticated");
      return created.service;
    }

    it("오프라인 리스에서도 열려 있다", async () => {
      // 오프라인에서 만든 호스트도 연결이 돌아올 때 수준 헤더와 함께 push 되므로 보호는 성립한다.
      const service = await bootstrapOffline("https://ssh.doldolma.com");

      service.noteServerDataFloorSupport(true);

      expect(service.getState().status).toBe("offline-authenticated");
      expect(service.getState().capabilities?.dataFloor).toBe(true);
    });

    it("오프라인으로 켜도 지난 판정을 기억한다", async () => {
      const serverUrl = "https://ssh.doldolma.com";
      const online = await createService(serverUrl);
      online.service.noteServerDataFloorSupport(true);

      // 같은 사용자 데이터 디렉터리로 앱을 다시 켠다. 이번에는 /api/info 를 못 받는다.
      const service = await bootstrapOffline(serverUrl);

      expect(service.getState().capabilities?.dataFloor).toBe(true);
    });

    it("다른 서버의 판정은 쓰지 않는다", async () => {
      const online = await createService("https://ssh.doldolma.com");
      online.service.noteServerDataFloorSupport(true);

      // 자체 호스팅 서버로 갈아탔다. 그 서버가 이 장치를 갖췄는지는 아직 모른다.
      const service = await bootstrapOffline("https://self.hosted.example.com");

      expect(service.getState().capabilities?.dataFloor).toBe(false);
    });

    it("지원하지 않는다는 답도 기억한다", async () => {
      const serverUrl = "https://ssh.doldolma.com";
      const online = await createService(serverUrl);
      online.service.noteServerDataFloorSupport(false);

      const service = await bootstrapOffline(serverUrl);

      expect(service.getState().capabilities?.dataFloor).toBe(false);
    });
  });

  it("restores a persisted version-0 reset descriptor as setup-required", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);
    const resetSession: AuthSession = {
      ...session,
      vaultBootstrap: { version: 0, epoch: 6 },
    };
    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      "auth:offline-session-cache",
      JSON.stringify({
        serverUrl: `${serverUrl}/`,
        user: session.user,
        vaultBootstrap: resetSession.vaultBootstrap,
        offlineLease: session.offlineLease,
        lastOnlineAt: session.syncServerTime,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const state = await service.bootstrap();

    expect(state.status).toBe("offline-authenticated");
    expect(state.vault?.status).toBe("setup-required");
    expect(state.session?.vaultBootstrap).toEqual({ version: 0, epoch: 6 });
  });

  it("activates local account history on login and invalidates it on logout", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    const session = createSession(serverUrl);
    const onSessionActivated = vi.fn();
    const onSessionInvalidated = vi.fn();
    service.setOnSessionActivated(onSessionActivated);
    service.setOnSessionInvalidated(onSessionInvalidated);

    await (
      service as unknown as {
        persistSession: (value: AuthSession) => Promise<void>;
      }
    ).persistSession(session);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await service.logout();

    expect(onSessionActivated).toHaveBeenCalledWith({
      userId: session.user.id,
      serverUrl: `${serverUrl}/`,
    });
    expect(onSessionInvalidated).toHaveBeenCalledWith({
      reason: "logout",
      purgeSyncedCache: true,
      // 로그아웃은 로컬 데이터(리플레이·로그·AI 키)를 보존한다 — 와이프는 탈퇴 전용.
      purgeLocalData: false,
    });
  });

  it("reconnects back to authenticated when retryOnline succeeds", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const cachedSession = createSession(serverUrl);
    const refreshedSession = createSession(serverUrl);

    await secretStore.save(
      "auth:refresh-token",
      cachedSession.tokens.refreshToken,
    );
    await secretStore.save(
      "auth:offline-session-cache",
      JSON.stringify({
        serverUrl: `${serverUrl}/`,
        user: cachedSession.user,
        vaultBootstrap: cachedSession.vaultBootstrap,
        offlineLease: cachedSession.offlineLease,
        lastOnlineAt: cachedSession.syncServerTime,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(refreshedSession), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
        ),
    );

    await service.bootstrap();
    const state = await service.retryOnline();

    expect(state.status).toBe("authenticated");
    expect(state.session?.tokens.accessToken).toBe(
      refreshedSession.tokens.accessToken,
    );
  });

  it("normalizes refresh auth failures from JSON payloads into a Korean guidance message", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "unsupported_client",
            msg: "허용되지 않은 접근입니다.",
            detail: null,
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    );

    const state = await service.bootstrap();

    expect(state.status).toBe("unauthenticated");
    expect(state.errorMessage).toBe(
      "세션이 만료되었거나 로그인 정보가 유효하지 않습니다. 다시 로그인해 주세요.",
    );
  });

  it("keeps network refresh failures using the existing error message", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const state = await service.bootstrap();

    expect(state.status).toBe("unauthenticated");
    expect(state.errorMessage).toBe("network down");
  });

  it("enters loading while retrying refresh from the unauthenticated login gate", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    (
      service as unknown as {
        state: {
          status: "unauthenticated";
          session: null;
          offline: null;
          errorMessage: string | null;
        };
      }
    ).state = {
      status: "unauthenticated",
      session: null,
      offline: null,
      errorMessage: "세션이 만료되었습니다.",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
      ),
    );

    const refreshPromise = service.refreshSession();

    expect(service.getState().status).toBe("loading");
    expect(service.getState().errorMessage).toBeNull();

    const state = await refreshPromise;

    expect(state.status).toBe("authenticated");
    expect(state.session?.tokens.accessToken).toBe(session.tokens.accessToken);
  });

  it("rejects stale offline cache when the configured server URL changed", async () => {
    const { service, secretStore } = await createService(
      "https://new.example.com",
    );
    const cachedSession = createSession("https://ssh.doldolma.com");

    await secretStore.save(
      "auth:refresh-token",
      cachedSession.tokens.refreshToken,
    );
    await secretStore.save(
      "auth:offline-session-cache",
      JSON.stringify({
        serverUrl: "https://ssh.doldolma.com/",
        user: cachedSession.user,
        vaultBootstrap: cachedSession.vaultBootstrap,
        offlineLease: cachedSession.offlineLease,
        lastOnlineAt: cachedSession.syncServerTime,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const state = await service.bootstrap();

    expect(state.status).toBe("unauthenticated");
    await expect(secretStore.load("auth:refresh-token")).resolves.toBeNull();
  });

  it("keeps the current session authenticated when secure persistence is unavailable", async () => {
    const electron = await import("electron");
    vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(
      false,
    );

    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);

    await expect(
      (
        service as unknown as {
          persistSession: (value: AuthSession) => Promise<void>;
        }
      ).persistSession(session),
    ).resolves.toBeUndefined();

    const state = service.getState();
    expect(state.status).toBe("authenticated");
    expect(state.session?.tokens.accessToken).toBe(session.tokens.accessToken);
    expect(state.errorMessage).toContain("안전한 저장소");
    await expect(secretStore.load("auth:refresh-token")).resolves.toBeNull();
  });

  it("adds client observation headers and reuses one installation id across auth requests", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);
    const stateStorageModule = await import("./state-storage");

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(session), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await service.bootstrap();
    await (
      service as unknown as {
        requestSessionWithClassification: (
          pathname: string,
          payload: Record<string, unknown>,
        ) => Promise<AuthSession>;
      }
    ).requestSessionWithClassification("/auth/exchange", {
      code: "exchange-code",
    });

    const refreshHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const exchangeHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    const installationId = refreshHeaders["X-Dolgate-Client-Installation-Id"];

    expect(refreshHeaders["X-Dolgate-Client"]).toBe("desktop");
    expect(refreshHeaders["X-Dolgate-Client-Version"]).toBe("1.6.1-test");
    expect(refreshHeaders["X-Dolgate-Platform"]).toBe(
      expectedDesktopPlatform(),
    );
    expect(installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(exchangeHeaders["X-Dolgate-Client-Installation-Id"]).toBe(
      installationId,
    );
    expect(
      stateStorageModule.getDesktopStateStorage().getState().client
        .installationId,
    ).toBe(installationId);
  });
});

describe("AuthService browser login recovery", () => {
  it("reopens browser login by reopening the same pending browser login URL", async () => {
    const { service } = await createService();
    const electron = await import("electron");
    const openExternal = vi.mocked(electron.shell.openExternal);
    openExternal.mockReset().mockResolvedValue(undefined);

    await service.beginBrowserLogin();
    expect(service.getState().status).toBe("authenticating");
    const firstLoginUrl = openExternal.mock.calls[0]?.[0];
    expect(typeof firstLoginUrl).toBe("string");

    await service.reopenBrowserLogin();

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal.mock.calls[1]?.[0]).toBe(firstLoginUrl);
  });

  it("cancels the pending browser login and returns to unauthenticated", async () => {
    const { service } = await createService();
    const electron = await import("electron");
    vi.mocked(electron.shell.openExternal)
      .mockReset()
      .mockResolvedValue(undefined);

    await service.beginBrowserLogin();
    await service.cancelBrowserLogin();

    const state = service.getState();
    expect(state.status).toBe("unauthenticated");
    expect(state.errorMessage).toBeNull();
  });

  it("deletes the account on the server and clears the local session", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);
    await (
      service as unknown as {
        persistSession: (value: AuthSession) => Promise<void>;
      }
    ).persistSession(session);
    const onSessionInvalidated = vi.fn();
    service.setOnSessionInvalidated(onSessionInvalidated);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await service.deleteAccount();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/auth/account");
    expect(init?.method).toBe("DELETE");
    expect((init?.headers as Record<string, string>).Authorization).toContain(
      "Bearer ",
    );
    expect(service.getState().status).toBe("unauthenticated");
    await expect(secretStore.load("auth:refresh-token")).resolves.toBeNull();
    // 탈퇴는 로그아웃과 달리 로컬 흔적(리플레이·로그·AI 키) 와이프까지 요청해야 한다.
    expect(onSessionInvalidated).toHaveBeenCalledWith({
      reason: "account-deleted",
      purgeSyncedCache: true,
      purgeLocalData: true,
    });
  });

  it("keeps the session when account deletion fails on the server", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    const session = createSession(serverUrl);
    await (
      service as unknown as {
        persistSession: (value: AuthSession) => Promise<void>;
      }
    ).persistSession(session);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "서버 오류가 발생했습니다." }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(service.deleteAccount()).rejects.toThrow(
      "서버 오류가 발생했습니다.",
    );
    expect(service.getState().status).toBe("authenticated");
  });
});

describe("AuthService account password", () => {
  it("sends the current session token and updates the password state", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    const session = createSession(serverUrl);
    session.user.passwordState = "unset";
    await (
      service as unknown as {
        persistSession: (value: AuthSession) => Promise<void>;
      }
    ).persistSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ passwordState: "set" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await service.changeAccountPassword("", "new-password");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/auth/account/password");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      currentPassword: "",
      newPassword: "new-password",
      refreshToken: session.tokens.refreshToken,
    });
    expect(service.getState().session?.user.passwordState).toBe("set");
  });

  it("times out a stalled password change request", async () => {
    vi.useFakeTimers();
    try {
      const serverUrl = "https://ssh.doldolma.com";
      const { service } = await createService(serverUrl);
      await (
        service as unknown as {
          persistSession: (value: AuthSession) => Promise<void>;
        }
      ).persistSession(createSession(serverUrl));
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

      const request = service.changeAccountPassword("old-password", "new-password");
      const rejection = expect(request).rejects.toThrow(
        "비밀번호 변경 요청 시간이 초과되었습니다.",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AuthService E2EE vault", () => {
  const VAULT_TEST_KDF = {
    algorithm: "argon2id",
    saltBase64: Buffer.alloc(16, 0xb2).toString("base64"),
    memoryKib: 64 * 1024,
    timeCost: 3,
    parallelism: 1,
  };

  // 계정별 키에 들어가는 값은 항상 owner 를 갖는다 — 그것이 이 캐시의 불변식이다.
  //
  // descriptor 필드(wrappedDekBase64·kdf·dekVerifierBase64)는 전부 있거나 전부 없어야 한다.
  // 파서가 부분 조합을 손상으로 보고 레코드를 버린다.
  function dekCacheRecord(
    serverUrl: string,
    vault: {
      dekBase64: string;
      wrappedDekBase64?: string;
      dekVerifierBase64?: string;
    },
    options: { epoch: number; wrapRevision?: number; userId?: string },
  ): string {
    const withDescriptor =
      vault.wrappedDekBase64 !== undefined && vault.dekVerifierBase64 !== undefined;
    return JSON.stringify({
      version: 2,
      owner: {
        serverUrl: `${serverUrl}/`,
        userId: options.userId ?? "user-1",
      },
      dekBase64: vault.dekBase64,
      epoch: options.epoch,
      wrapRevision: options.wrapRevision ?? 0,
      ...(withDescriptor
        ? {
            wrappedDekBase64: vault.wrappedDekBase64,
            dekVerifierBase64: vault.dekVerifierBase64,
            kdf: VAULT_TEST_KDF,
          }
        : {}),
    });
  }

  async function buildWrappedDek(passphrase: string): Promise<{
    wrappedDekBase64: string;
    dekBase64: string;
    dekVerifierBase64: string;
  }> {
    const {
      deriveVaultKek,
      wrapVaultDek,
      createVaultDek,
      computeVaultDekVerifier,
    } = await import("@dolssh/shared-core");
    const { desktopArgon2idDerive } = await import("./vault-crypto");
    const dek = createVaultDek();
    const kek = await deriveVaultKek(
      desktopArgon2idDerive,
      passphrase,
      VAULT_TEST_KDF,
    );
    return {
      wrappedDekBase64: wrapVaultDek(dek, kek),
      dekBase64: Buffer.from(dek).toString("base64"),
      dekVerifierBase64: computeVaultDekVerifier(dek),
    };
  }

  function createV2Session(
    serverUrl: string,
    wrappedDekBase64: string,
    options?: {
      epoch?: number;
      wrapRevision?: number;
      dekVerifierBase64?: string;
    },
  ): AuthSession {
    const session = createSession(serverUrl);
    return {
      ...session,
      vaultBootstrap: {
        version: 2,
        wrappedDekBase64,
        kdf: VAULT_TEST_KDF,
        ...(options?.epoch !== undefined ? { epoch: options.epoch } : {}),
        ...(options?.wrapRevision !== undefined
          ? { wrapRevision: options.wrapRevision }
          : {}),
        ...(options?.dekVerifierBase64
          ? { dekVerifierBase64: options.dekVerifierBase64 }
          : {}),
      },
    };
  }

  // JSON 캐시({dekBase64, epoch})에서 DEK 만 뽑는다. 이전 포맷(base64 원문)도 지원.
  function cachedDekOf(raw: string | null): string | null {
    if (!raw) {
      return null;
    }
    if (!raw.trim().startsWith("{")) {
      return raw;
    }
    return (JSON.parse(raw) as { dekBase64?: string }).dekBase64 ?? null;
  }

  function stubSessionRefresh(session: AuthSession): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/auth/refresh") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => session,
          text: async () => JSON.stringify(session),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("gates a v2 session as locked and unlocks with the correct passphrase", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const passphrase = "correct horse battery";
    const { wrappedDekBase64, dekBase64 } = await buildWrappedDek(passphrase);
    const session = createV2Session(serverUrl, wrappedDekBase64);

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    stubSessionRefresh(session);

    const state = await service.bootstrap();
    expect(state.status).toBe("authenticated");
    expect(state.vault?.status).toBe("locked");
    expect(service.isVaultReadyForSync()).toBe(false);
    expect(() => service.getVaultKeyBase64()).toThrow(
      "동기화 잠금 해제가 필요합니다.",
    );

    await expect(service.unlockVault("wrong-passphrase")).rejects.toThrow(
      "동기화 암호가 올바르지 않습니다.",
    );
    expect(service.getState().vault?.status).toBe("locked");

    await service.unlockVault(passphrase);
    expect(service.getState().vault?.status).toBe("unlocked");
    expect(service.isVaultReadyForSync()).toBe(true);
    expect(service.getVaultKeyBase64()).toBe(dekBase64);
    expect(cachedDekOf(await secretStore.load(dekAccount()))).toBe(
      dekBase64,
    );
    expect(
      JSON.parse((await secretStore.load(dekAccount())) as string),
    ).toMatchObject({
      owner: { serverUrl: `${serverUrl}/`, userId: session.user.id },
      wrapRevision: 0,
    });
  });

  it("rejects an unwrapped DEK that does not match the descriptor verifier", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const wrappedVault = await buildWrappedDek("correct-passphrase");
    const differentVault = await buildWrappedDek("different-passphrase");
    const session = createV2Session(serverUrl, wrappedVault.wrappedDekBase64, {
      epoch: 4,
      dekVerifierBase64: differentVault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    stubSessionRefresh(session);
    await service.bootstrap();

    await expect(service.unlockVault("correct-passphrase")).rejects.toThrow(
      "동기화 볼트의 키 검증에 실패했습니다.",
    );
    expect(service.getState().vault?.status).toBe("locked");
    await expect(secretStore.load(dekAccount())).resolves.toBeNull();
  });

  it("keeps the unlocked memory state when secure cache persistence fails", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const passphrase = "correct-passphrase";
    const vault = await buildWrappedDek(passphrase);
    const session = createV2Session(serverUrl, vault.wrappedDekBase64, {
      epoch: 2,
      dekVerifierBase64: vault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    stubSessionRefresh(session);
    await service.bootstrap();
    const originalSave = secretStore.save.bind(secretStore);
    vi.spyOn(secretStore, "save").mockImplementation(
      async (account: string, value: string) => {
        if (account === dekAccount()) {
          throw new Error("secure storage unavailable");
        }
        return originalSave(account, value);
      },
    );

    await service.unlockVault(passphrase);

    expect(service.getState().vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(vault.dekBase64);
  });

  it("rejects a desktop DEK cache owned by another account", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const currentVault = await buildWrappedDek("current-passphrase");
    const foreignVault = await buildWrappedDek("foreign-passphrase");
    const session = createV2Session(serverUrl, currentVault.wrappedDekBase64, {
      epoch: 2,
      wrapRevision: 1,
      dekVerifierBase64: currentVault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      dekAccount(),
      JSON.stringify({
        version: 2,
        owner: { serverUrl: `${serverUrl}/`, userId: "other-user" },
        dekBase64: foreignVault.dekBase64,
        epoch: 9,
        wrapRevision: 4,
        wrappedDekBase64: foreignVault.wrappedDekBase64,
        kdf: VAULT_TEST_KDF,
        dekVerifierBase64: foreignVault.dekVerifierBase64,
      }),
    );
    stubSessionRefresh(session);

    const state = await service.bootstrap();

    expect(state.vault?.status).toBe("locked");
    await expect(secretStore.load(dekAccount())).resolves.toBeNull();
  });

  it("blocks legacy sync when the server requires E2EE migration", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session: AuthSession = {
      ...createSession(serverUrl),
      vaultBootstrap: {
        version: 1,
        keyBase64: Buffer.alloc(32, 1).toString("base64"),
        epoch: 3,
        e2eeRequired: true,
      },
    };
    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    stubSessionRefresh(session);

    const state = await service.bootstrap();

    expect(state.vault).toMatchObject({
      status: "legacy",
      migrationRequired: true,
    });
    expect(service.isVaultReadyForSync()).toBe(false);
    expect(() => service.getVaultKeyBase64()).toThrow(
      "동기화 잠금 해제가 필요합니다.",
    );
  });

  it("blocks sync with an explicit error when the vault descriptor is unsupported", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = {
      ...createSession(serverUrl),
      vaultBootstrap: { version: 99 },
    } as unknown as AuthSession;

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    stubSessionRefresh(session);

    const state = await service.bootstrap();
    expect(state.vault).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("앱을 업데이트"),
    });
    expect(service.isVaultReadyForSync()).toBe(false);
    expect(() => service.getVaultKeyBase64()).toThrow("앱을 업데이트");
  });

  it("rejects a new vault passphrase shorter than four characters", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session: AuthSession = {
      ...createSession(serverUrl),
      vaultBootstrap: { version: 0, epoch: 0 },
    };
    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    const fetchMock = stubSessionRefresh(session);

    await service.bootstrap();
    await expect(service.setupVault("abc")).rejects.toThrow(
      "동기화 암호는 4자 이상이어야 합니다.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.getState().vault?.status).toBe("setup-required");
  });

  it("restores the unlocked state from the cached DEK without a passphrase", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const { wrappedDekBase64, dekBase64, dekVerifierBase64 } =
      await buildWrappedDek("any-passphrase");
    const session = createV2Session(serverUrl, wrappedDekBase64, {
      epoch: 1,
      dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    // 캐시된 DEK 가 서버 verifier 와 일치하면 재입력 없이 unlocked 로 복원된다.
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(
        serverUrl,
        { dekBase64, wrappedDekBase64, dekVerifierBase64 },
        { epoch: 1 },
      ),
    );
    stubSessionRefresh(session);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(dekBase64);
    expect(service.getVaultEpoch()).toBe(1);
    // verifier가 확인된 descriptor와 함께 coherent v2 cache로 승격된다.
    expect(
      JSON.parse((await secretStore.load(dekAccount())) as string),
    ).toMatchObject({
      version: 2,
      dekBase64,
      epoch: 1,
      wrappedDekBase64,
      dekVerifierBase64,
    });
  });

  it("refuses to rewrap when the cached DEK and wrapped descriptor disagree", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const cachedVault = await buildWrappedDek("cached-pass");
    const wrappedVault = await buildWrappedDek("descriptor-pass");
    const corruptSession = createV2Session(
      serverUrl,
      wrappedVault.wrappedDekBase64,
      {
        epoch: 2,
        // 서버 verifier는 캐시 DEK를 가리키지만 wrapped 값은 다른 DEK를 푸는 비정상 조합.
        dekVerifierBase64: cachedVault.dekVerifierBase64,
      },
    );

    await secretStore.save(
      "auth:refresh-token",
      corruptSession.tokens.refreshToken,
    );
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(serverUrl, cachedVault, { epoch: 2 }),
    );
    stubSessionRefresh(corruptSession);
    await service.bootstrap();

    await expect(
      service.changeVaultPassphrase("descriptor-pass", "next-pass"),
    ).rejects.toThrow("로컬 볼트 캐시와 서버 키가 일치하지 않습니다.");
  });

  it("changes the passphrase with a wrapper revision CAS", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const currentPassphrase = "current-passphrase";
    const vault = await buildWrappedDek(currentPassphrase);
    const session = createV2Session(serverUrl, vault.wrappedDekBase64, {
      epoch: 2,
      wrapRevision: 3,
      dekVerifierBase64: vault.dekVerifierBase64,
    });
    let rewrapBody: Record<string, unknown> | null = null;
    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/auth/refresh") {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => session,
            text: async () => JSON.stringify(session),
          } as Response;
        }
        if (pathname === "/auth/vault" && init?.method === "PUT") {
          rewrapBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ epoch: 2, wrapRevision: 4 }),
            text: async () => JSON.stringify({ epoch: 2, wrapRevision: 4 }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${pathname}`);
      }),
    );

    await service.bootstrap();
    await service.unlockVault(currentPassphrase);
    await service.changeVaultPassphrase(currentPassphrase, "next-passphrase");

    expect(rewrapBody).toMatchObject({
      expectedEpoch: 2,
      expectedWrapRevision: 3,
      expectedDekVerifierBase64: vault.dekVerifierBase64,
    });
    expect(
      JSON.parse((await secretStore.load(dekAccount())) as string),
    ).toMatchObject({
      epoch: 2,
      wrapRevision: 4,
      owner: { serverUrl: `${serverUrl}/`, userId: session.user.id },
    });
    const offlineCache = JSON.parse(
      (await secretStore.load("auth:offline-session-cache")) as string,
    ) as { vaultBootstrap: AuthSession["vaultBootstrap"] };
    expect(offlineCache.vaultBootstrap.wrapRevision).toBe(4);
  });

  it("times out a stalled vault mutation request", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);
    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    stubSessionRefresh(session);
    await service.bootstrap();

    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }),
      );
      const request = (
        service as unknown as {
          requestVaultApi: (method: string, pathname: string) => Promise<unknown>;
        }
      ).requestVaultApi("PUT", "/auth/vault");
      const rejection = expect(request).rejects.toThrow(
        "동기화 암호 요청 시간이 초과되었습니다.",
      );

      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("relocks via handleVaultDekRejected when the refreshed descriptor proves a new DEK generation", async () => {
    // sync-service 가 push 409(vault_reset/vault_dek_mismatch) 또는 pull 복호화 실패를
    // 만나면 이 훅을 부른다 — 세션을 갱신해 최신 descriptor 의 epoch/verifier 로 재판정
    // 하고, 진짜 세대 교체면 캐시를 버리고 잠금으로 되돌려 새 동기화 암호를 받게 한다.
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const oldVault = await buildWrappedDek("old-pass");
    const newVault = await buildWrappedDek("new-pass");
    const oldSession = createV2Session(serverUrl, oldVault.wrappedDekBase64, {
      epoch: 1,
      dekVerifierBase64: oldVault.dekVerifierBase64,
    });

    await secretStore.save(
      "auth:refresh-token",
      oldSession.tokens.refreshToken,
    );
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(serverUrl, oldVault, { epoch: 1 }),
    );
    stubSessionRefresh(oldSession);

    await service.bootstrap();
    expect(service.getState().vault?.status).toBe("unlocked");

    // 다른 기기가 초기화+재설정 — 서버는 epoch 3 + 새 verifier 를 내려준다.
    stubSessionRefresh(
      createV2Session(serverUrl, newVault.wrappedDekBase64, {
        epoch: 3,
        dekVerifierBase64: newVault.dekVerifierBase64,
      }),
    );
    await service.handleVaultDekRejected();

    expect(service.getState().vault?.status).toBe("locked");
    expect(service.isVaultReadyForSync()).toBe(false);
    expect(await secretStore.load(dekAccount())).toBeNull();
  });

  it("does not destroy the DEK cache when handleVaultDekRejected cannot refresh (non-destructive)", async () => {
    // 재판정의 근거(새 descriptor)를 얻지 못했으면 캐시를 파괴하지 않는다 — 파괴하면
    // 옛 wrapped 기준의 잘못된 잠금 화면(새 암호가 거부되는 루프)이 생긴다. 인증 상태는
    // 기존 refresh 실패 경로(오프라인 폴백 등)를 그대로 따르되, DEK 캐시는 살아남아
    // 다음 성공 refresh 의 verifier 재판정이 재입력 없이 unlocked 로 복원할 수 있어야 한다.
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const vault = await buildWrappedDek("any-pass");
    const session = createV2Session(serverUrl, vault.wrappedDekBase64, {
      epoch: 1,
      dekVerifierBase64: vault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(serverUrl, vault, { epoch: 1 }),
    );
    stubSessionRefresh(session);
    await service.bootstrap();
    expect(service.getState().vault?.status).toBe("unlocked");

    // refresh 실패(네트워크 두절) — DEK 캐시가 지워지면 안 된다.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await service.handleVaultDekRejected();

    expect(cachedDekOf(await secretStore.load(dekAccount()))).toBe(
      vault.dekBase64,
    );
  });

  it("relocks and drops the cached DEK when the descriptor verifier changes (reset on another device)", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const staleVault = await buildWrappedDek("old-pass");
    const freshVault = await buildWrappedDek("new-pass");
    const freshSession = createV2Session(
      serverUrl,
      freshVault.wrappedDekBase64,
      { epoch: 3, dekVerifierBase64: freshVault.dekVerifierBase64 },
    );

    await secretStore.save(
      "auth:refresh-token",
      freshSession.tokens.refreshToken,
    );
    // 다른 기기의 초기화 이전에 캐시된 옛 DEK(옛 세대 epoch 1).
    await secretStore.save(
      dekAccount(),
      JSON.stringify({ dekBase64: staleVault.dekBase64, epoch: 1 }),
    );
    stubSessionRefresh(freshSession);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("locked");
    expect(service.isVaultReadyForSync()).toBe(false);
    // 옛 DEK 로 push 하지 못하도록 캐시가 비워져야 한다.
    expect(await secretStore.load(dekAccount())).toBeNull();
  });

  it("keeps the freshly unlocked state when a later session descriptor epoch lags (own re-setup)", async () => {
    // 회귀: 로컬이 새 세대(epoch 5)로 unlocked 인데 refresh 가 낡은 세대(epoch 3)
    // descriptor 를 실어오면 재잠금하면 안 된다 — epoch 규칙(낮으면 무시)이 방금 만든
    // DEK 를 보호한다. 하드 경로 보호는 서버 push fence 가 맡는다.
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const passphrase = "correct horse battery";
    const currentVault = await buildWrappedDek(passphrase);
    const staleVault = await buildWrappedDek("stale-pass");
    const freshSession = createV2Session(
      serverUrl,
      currentVault.wrappedDekBase64,
      { epoch: 5, dekVerifierBase64: currentVault.dekVerifierBase64 },
    );
    const staleSession = createV2Session(
      serverUrl,
      staleVault.wrappedDekBase64,
      { epoch: 3, dekVerifierBase64: staleVault.dekVerifierBase64 },
    );

    await secretStore.save(
      "auth:refresh-token",
      freshSession.tokens.refreshToken,
    );
    stubSessionRefresh(freshSession);

    await service.bootstrap();
    await service.unlockVault(passphrase);
    expect(service.getState().vault?.status).toBe("unlocked");
    expect(service.getVaultEpoch()).toBe(5);

    // 낡은 epoch descriptor 로 refresh 가 돌아와도 unlocked 유지, DEK 캐시 보존.
    stubSessionRefresh(staleSession);
    await service.refreshSession();
    expect(service.getState().vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(currentVault.dekBase64);
    expect(cachedDekOf(await secretStore.load(dekAccount()))).toBe(
      currentVault.dekBase64,
    );
  });

  it("persists the floored descriptor when a stale refresh arrives after own re-setup", async () => {
    // 서버 epoch 은 단조 — 내 unlocked epoch(5)보다 낮은 v2 descriptor(3)는 증명
    // 가능하게 낡은 in-flight 응답이다. 그대로 저장하면 저장 세션이 캐시보다 낡아져
    // 콜드 부팅이 "새 DEK + 옛 wrapped" 조합을 만든다 — 게시·저장 모두 합성 descriptor
    // 로 치환(floor)되어야 한다.
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const passphrase = "correct horse battery";
    const currentVault = await buildWrappedDek(passphrase);
    const staleVault = await buildWrappedDek("stale-pass");
    const freshSession = createV2Session(
      serverUrl,
      currentVault.wrappedDekBase64,
      { epoch: 5, dekVerifierBase64: currentVault.dekVerifierBase64 },
    );
    const staleSession = createV2Session(
      serverUrl,
      staleVault.wrappedDekBase64,
      { epoch: 3, dekVerifierBase64: staleVault.dekVerifierBase64 },
    );

    await secretStore.save(
      "auth:refresh-token",
      freshSession.tokens.refreshToken,
    );
    stubSessionRefresh(freshSession);
    await service.bootstrap();
    await service.unlockVault(passphrase);
    expect(service.getVaultEpoch()).toBe(5);

    stubSessionRefresh(staleSession);
    await service.refreshSession();

    // 게시된 세션과 오프라인 캐시 모두 낡은 descriptor 가 아니라 합성(epoch 5,
    // 현재 wrapped)이어야 한다.
    const published = service.getState().session;
    expect(published?.vaultBootstrap.epoch).toBe(5);
    expect(published?.vaultBootstrap.wrappedDekBase64).toBe(
      currentVault.wrappedDekBase64,
    );
    const offlineCacheRaw = await secretStore.load(
      "auth:offline-session-cache",
    );
    expect(offlineCacheRaw).toBeTruthy();
    const offlineCache = JSON.parse(offlineCacheRaw as string) as {
      vaultBootstrap?: { epoch?: number; wrappedDekBase64?: string };
    };
    expect(offlineCache.vaultBootstrap?.epoch).toBe(5);
    expect(offlineCache.vaultBootstrap?.wrappedDekBase64).toBe(
      currentVault.wrappedDekBase64,
    );
  });

  it("keeps the latest wrapper when a stale rewrap descriptor arrives", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const passphrase = "latest-passphrase";
    const currentVault = await buildWrappedDek(passphrase);
    const staleVault = await buildWrappedDek("stale-passphrase");
    const currentSession = createV2Session(
      serverUrl,
      currentVault.wrappedDekBase64,
      {
        epoch: 5,
        wrapRevision: 2,
        dekVerifierBase64: currentVault.dekVerifierBase64,
      },
    );
    const staleSession = createV2Session(
      serverUrl,
      staleVault.wrappedDekBase64,
      {
        epoch: 5,
        wrapRevision: 1,
        dekVerifierBase64: currentVault.dekVerifierBase64,
      },
    );

    await secretStore.save(
      "auth:refresh-token",
      currentSession.tokens.refreshToken,
    );
    stubSessionRefresh(currentSession);
    await service.bootstrap();
    await service.unlockVault(passphrase);

    stubSessionRefresh(staleSession);
    await service.refreshSession();

    expect(service.getState().vault?.status).toBe("unlocked");
    const cache = JSON.parse(
      (await secretStore.load(dekAccount())) as string,
    ) as { wrappedDekBase64: string; wrapRevision: number };
    expect(cache).toMatchObject({
      wrappedDekBase64: currentVault.wrappedDekBase64,
      wrapRevision: 2,
    });
    const offlineCache = JSON.parse(
      (await secretStore.load("auth:offline-session-cache")) as string,
    ) as { vaultBootstrap: AuthSession["vaultBootstrap"] };
    expect(offlineCache.vaultBootstrap).toMatchObject({
      wrappedDekBase64: currentVault.wrappedDekBase64,
      wrapRevision: 2,
    });
  });

  // 업데이트 직후가 이 코드의 존재 이유다. 옮기지 않으면 이미 로그인된 앱을 켰을 때 갑자기
  // 동기화 암호를 묻게 되고, 그건 사용자가 보안 사고로 오해하는 순간이다.
  it("migrates the legacy shared cache to the per-account key on first launch", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const vault = await buildWrappedDek("any-passphrase");
    const session = createV2Session(serverUrl, vault.wrappedDekBase64, {
      epoch: 2,
      dekVerifierBase64: vault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    // 계정 구분이 없던 빌드가 남긴 값(owner 없음, base64 원문).
    await secretStore.save("auth:vault-dek", vault.dekBase64);
    stubSessionRefresh(session);

    const state = await service.bootstrap();

    // 재입력 없이 열리고, 값은 계정별 키로 옮겨진다.
    expect(state.vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(vault.dekBase64);
    expect(
      JSON.parse((await secretStore.load(dekAccount())) as string),
    ).toMatchObject({
      version: 2,
      owner: { userId: "user-1", serverUrl: `${serverUrl}/` },
      dekBase64: vault.dekBase64,
      epoch: 2,
    });
    // 옛 슬롯은 비운다 — 아무도 읽지 않는 DEK 를 남기지 않는다.
    expect(await secretStore.load("auth:vault-dek")).toBeNull();
  });

  // 증명되지 않는 값은 옮기지 않는다. 옛 슬롯의 값이 이 계정 것이라는 보장이 없기 때문이다.
  it("drops a legacy cache it cannot prove belongs to this account", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const foreignVault = await buildWrappedDek("foreign-pass");
    const myVault = await buildWrappedDek("my-pass");
    const session = createV2Session(serverUrl, myVault.wrappedDekBase64, {
      epoch: 2,
      dekVerifierBase64: myVault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save("auth:vault-dek", foreignVault.dekBase64);
    stubSessionRefresh(session);

    const state = await service.bootstrap();

    expect(state.vault?.status).toBe("locked");
    expect(await secretStore.load(dekAccount())).toBeNull();
    expect(await secretStore.load("auth:vault-dek")).toBeNull();
  });
  it("discards an owner-less cache and asks for the passphrase again", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const vault = await buildWrappedDek("any-passphrase");
    const session = createV2Session(serverUrl, vault.wrappedDekBase64, {
      epoch: 2,
      dekVerifierBase64: vault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    // DEK 자체는 서버 verifier 와 일치한다 — 그래도 owner 가 없으면 버린다.
    await secretStore.save(dekAccount(), vault.dekBase64);
    stubSessionRefresh(session);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("locked");
    expect(await secretStore.load(dekAccount())).toBeNull();
  });
  it("restores unlocked from the cache when the stored descriptor lags the cached epoch (cold boot)", async () => {
    // 재설정 성공 직후 descriptor refresh 가 실패한 채 재시작한 경우: 저장 세션의
    // descriptor 는 옛 세대(epoch 1)인데 캐시는 새 세대(epoch 3)다. epoch 규칙이
    // 낡은 descriptor 를 무시하되, 콜드 부팅에서는 캐시를 진실로 삼아 unlocked 로
    // 복원해야 한다(none 으로 뜨면 오프라인 복원이 깨진다).
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const staleVault = await buildWrappedDek("old-pass");
    const freshVault = await buildWrappedDek("new-pass");
    const staleSession = createV2Session(
      serverUrl,
      staleVault.wrappedDekBase64,
      {
        epoch: 1,
        dekVerifierBase64: staleVault.dekVerifierBase64,
      },
    );

    await secretStore.save(
      "auth:refresh-token",
      staleSession.tokens.refreshToken,
    );
    await secretStore.save(
      dekAccount(),
      JSON.stringify({
        version: 2,
        owner: { serverUrl: `${serverUrl}/`, userId: staleSession.user.id },
        dekBase64: freshVault.dekBase64,
        epoch: 3,
        wrapRevision: 0,
        wrappedDekBase64: freshVault.wrappedDekBase64,
        kdf: VAULT_TEST_KDF,
        dekVerifierBase64: freshVault.dekVerifierBase64,
      }),
    );
    stubSessionRefresh(staleSession);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(freshVault.dekBase64);
    expect(service.getVaultEpoch()).toBe(3);
    // 캐시(새 세대)는 파괴되지 않는다.
    expect(cachedDekOf(await secretStore.load(dekAccount()))).toBe(
      freshVault.dekBase64,
    );
    // 최신 캐시의 wrapper/KDF도 함께 복원되어 낡은 descriptor와 섞이지 않는다.
    await expect(
      service.changeVaultPassphrase("old-pass", "next-pass"),
    ).rejects.toThrow("현재 동기화 암호가 올바르지 않습니다.");
  });

  it("locks a pre-epoch cache whose DEK does not match the descriptor verifier", async () => {
    // 옛 오염 시나리오의 결정판: pre-epoch 캐시가 실제로는 초기화 이전의 죽은 DEK 인
    // 경우 — verifier 불일치로 즉시 판별돼 잠기고 캐시가 정리된다(과거 adopt 는 이
    // 경우를 구분하지 못해 미검증 상태 기계가 필요했다).
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const deadVault = await buildWrappedDek("dead-pass");
    const liveVault = await buildWrappedDek("live-pass");
    const session = createV2Session(serverUrl, liveVault.wrappedDekBase64, {
      epoch: 2,
      dekVerifierBase64: liveVault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(serverUrl, deadVault, { epoch: 2 }),
    );
    stubSessionRefresh(session);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("locked");
    expect(await secretStore.load(dekAccount())).toBeNull();
  });

  it("sets up a new vault for a version-0 session and uploads the wrapped DEK", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);
    const setupSession: AuthSession = {
      ...session,
      vaultBootstrap: { version: 0, epoch: 0 },
    };

    await secretStore.save(
      "auth:refresh-token",
      setupSession.tokens.refreshToken,
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/auth/refresh") {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => setupSession,
            text: async () => JSON.stringify(setupSession),
          } as Response;
        }
        if (pathname === "/auth/vault" && init?.method === "POST") {
          capturedBodies.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ epoch: 1 }),
            text: async () => JSON.stringify({ epoch: 1 }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("setup-required");
    expect(service.isVaultReadyForSync()).toBe(false);

    await service.setupVault("new-sync-passphrase");
    expect(service.getState().vault?.status).toBe("unlocked");
    expect(service.isVaultReadyForSync()).toBe(true);
    // setup 직후 늦게 도착한 v0(epoch 0)는 로컬 v2(epoch 1)를 덮지 않는다.
    expect(service.getState().session?.vaultBootstrap).toMatchObject({
      version: 2,
      epoch: 1,
    });

    const body = capturedBodies[0] as {
      wrappedDekBase64: string;
      dekVerifierBase64: string;
      kdf: { algorithm: string };
    };
    expect(body.wrappedDekBase64).toBeTruthy();
    // 다른 기기들이 캐시 DEK 를 로컬 검증할 근거 — 설정 요청에 반드시 실린다.
    expect(body.dekVerifierBase64).toBeTruthy();
    expect(body.kdf.algorithm).toBe("argon2id");
    // 업로드된 wrapped DEK 를 같은 암호로 풀면 로컬 키와 일치해야 한다.
    const { deriveVaultKek, unwrapVaultDek } =
      await import("@dolssh/shared-core");
    const { desktopArgon2idDerive } = await import("./vault-crypto");
    const kek = await deriveVaultKek(
      desktopArgon2idDerive,
      "new-sync-passphrase",
      body.kdf as typeof VAULT_TEST_KDF,
    );
    const unwrapped = unwrapVaultDek(body.wrappedDekBase64, kek);
    expect(Buffer.from(unwrapped).toString("base64")).toBe(
      service.getVaultKeyBase64(),
    );
  });

  it("does not apply an in-flight vault setup after the server changes", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore, setServerUrl } =
      await createService(serverUrl);
    const setupSession: AuthSession = {
      ...createSession(serverUrl),
      vaultBootstrap: { version: 0, epoch: 0 },
    };
    await secretStore.save(
      "auth:refresh-token",
      setupSession.tokens.refreshToken,
    );

    let resolveVaultResponse!: (response: Response) => void;
    const vaultResponse = new Promise<Response>((resolve) => {
      resolveVaultResponse = resolve;
    });
    let markVaultRequestStarted!: () => void;
    const vaultRequestStarted = new Promise<void>((resolve) => {
      markVaultRequestStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/auth/refresh") {
          return new Response(JSON.stringify(setupSession), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/auth/vault" && init?.method === "POST") {
          markVaultRequestStarted();
          return vaultResponse;
        }
        throw new Error(`unexpected fetch: ${pathname}`);
      }),
    );

    await service.bootstrap();
    const setupPromise = service.setupVault("new-sync-passphrase");
    await vaultRequestStarted;
    setServerUrl("https://other.example.com");
    resolveVaultResponse(
      new Response(JSON.stringify({ epoch: 1, wrapRevision: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(setupPromise).rejects.toThrow(
      "로그인 계정 또는 서버가 변경되어 동기화 볼트 작업을 취소했습니다.",
    );
    expect(service.getState().vault?.status).toBe("setup-required");
    expect(await secretStore.load(dekAccount())).toBeNull();
  });

  it("persists the reset epoch as a version-0 descriptor before the next refresh", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const vault = await buildWrappedDek("forgotten-passphrase");
    const session = createV2Session(serverUrl, vault.wrappedDekBase64, {
      epoch: 5,
      dekVerifierBase64: vault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      dekAccount(),
      JSON.stringify({ dekBase64: vault.dekBase64, epoch: 5 }),
    );
    let resetExpectedEpoch: number | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/auth/refresh") {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => session,
            text: async () => JSON.stringify(session),
          } as Response;
        }
        if (pathname === "/auth/vault/reset" && init?.method === "POST") {
          resetExpectedEpoch = (
            JSON.parse(String(init.body)) as { expectedEpoch?: number }
          ).expectedEpoch;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ epoch: 6 }),
            text: async () => JSON.stringify({ epoch: 6 }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${pathname}`);
      }),
    );

    await service.bootstrap();
    await service.resetVault();

    expect(service.getState().vault?.status).toBe("setup-required");
    expect(resetExpectedEpoch).toBe(5);
    expect(service.getState().session?.vaultBootstrap).toEqual({
      version: 0,
      epoch: 6,
    });
    expect(await secretStore.load(dekAccount())).toBeNull();
    const offlineCache = JSON.parse(
      (await secretStore.load("auth:offline-session-cache")) as string,
    ) as { vaultBootstrap: AuthSession["vaultBootstrap"] };
    expect(offlineCache.vaultBootstrap).toEqual({ version: 0, epoch: 6 });
  });

  // 이 두 테스트가 계정별 키의 이유다. 키가 하나였을 때는 B 로 로그인하면 A 의 DEK 가 덮여,
  // A 로 돌아올 때 동기화 암호를 다시 물었다.
  it("does not touch another account's cached DEK", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const otherVault = await buildWrappedDek("other-pass");
    const myVault = await buildWrappedDek("my-pass");
    const session = createV2Session(serverUrl, myVault.wrappedDekBase64, {
      epoch: 1,
      dekVerifierBase64: myVault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      dekAccount("user-2"),
      dekCacheRecord(serverUrl, otherVault, { epoch: 1, userId: "user-2" }),
    );
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(serverUrl, myVault, { epoch: 1 }),
    );
    stubSessionRefresh(session);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(myVault.dekBase64);
    // 남의 캐시는 읽지도 지우지도 않는다.
    expect(await secretStore.load(dekAccount("user-2"))).not.toBeNull();
  });

  it("keeps the cached DEK across logout so re-login needs no passphrase", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const otherVault = await buildWrappedDek("other-pass");
    const myVault = await buildWrappedDek("my-pass");
    const session = createV2Session(serverUrl, myVault.wrappedDekBase64, {
      epoch: 1,
      dekVerifierBase64: myVault.dekVerifierBase64,
    });

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    await secretStore.save(
      dekAccount("user-2"),
      dekCacheRecord(serverUrl, otherVault, { epoch: 1, userId: "user-2" }),
    );
    await secretStore.save(
      dekAccount(),
      dekCacheRecord(serverUrl, myVault, { epoch: 1 }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/auth/refresh") {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => session,
            text: async () => JSON.stringify(session),
          } as Response;
        }
        if (pathname === "/auth/logout") {
          return {
            ok: true,
            status: 204,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => "",
          } as Response;
        }
        throw new Error(`unexpected fetch: ${pathname}`);
      }),
    );

    await service.bootstrap();
    await service.logout();

    // 한 번 동기화한 기기는 같은 계정·같은 볼트로 돌아오므로 캐시를 남긴다.
    expect(await secretStore.load(dekAccount())).not.toBeNull();
    expect(await secretStore.load(dekAccount("user-2"))).not.toBeNull();
  });

  it("keeps legacy v1 sessions untouched and drops the legacy shared cache on logout", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore, setServerUrl } =
      await createService(serverUrl);
    const session = createSession(serverUrl);

    await secretStore.save("auth:refresh-token", session.tokens.refreshToken);
    // 이 계정 것이라는 증거가 없는 캐시(owner 없음) — 채택되지 않아야 v1 세션이 legacy 로 남는다.
    await secretStore.save(dekAccount(), "stale-dek");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/auth/refresh") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => session,
          text: async () => JSON.stringify(session),
        } as Response;
      }
      if (pathname === "/auth/logout") {
        return {
          ok: true,
          status: 204,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => "",
        } as Response;
      }
      throw new Error(`unexpected fetch: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await service.bootstrap();
    // v1 세션은 legacy — 캐시된 DEK 가 있어도 세션의 keyBase64 를 그대로 쓴다.
    expect(state.vault?.status).toBe("legacy");
    expect(service.getVaultKeyBase64()).toBe(session.vaultBootstrap.keyBase64);
    expect(service.isVaultReadyForSync()).toBe(true);
    // 서버의 E2EE 지원이 확인되기 전에는 전환 프롬프트 대상이 아니다
    // (셀프호스팅 구버전 서버 배려). sync 가 /api/info 로 확인해 주면 켜진다.
    expect(state.vault?.canMigrate).toBe(false);
    service.noteServerVaultSupport(true);
    expect(service.getState().vault?.canMigrate).toBe(true);
    setServerUrl("https://legacy.example.com");
    service.resetServerVaultSupport();
    expect(service.getState().vault?.canMigrate).toBe(false);
    service.noteServerVaultSupport(true);
    expect(service.getState().vault?.canMigrate).toBe(true);
    service.noteServerVaultSupport(false);
    expect(service.getState().vault?.canMigrate).toBe(false);

    await service.logout();
    expect(service.getState().vault ?? null).toBeNull();
    // 캐시는 남는다 — 같은 계정으로 다시 로그인할 때 동기화 암호를 다시 묻지 않는다.
    expect(await secretStore.load(dekAccount())).not.toBeNull();
  });

  it("pre-seeds the legacy key and migrates the vault by wrapping the same DEK", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const legacySession = createSession(serverUrl);
    const legacyKeyBase64 = legacySession.vaultBootstrap.keyBase64 as string;
    const passphrase = "migration-passphrase";

    await secretStore.save(
      "auth:refresh-token",
      legacySession.tokens.refreshToken,
    );

    let migrated = false;
    let capturedBody: {
      wrappedDekBase64: string;
      kdf: typeof VAULT_TEST_KDF;
    } | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/auth/refresh") {
          const session = migrated
            ? {
                ...legacySession,
                vaultBootstrap: {
                  version: 2,
                  wrappedDekBase64: capturedBody?.wrappedDekBase64 ?? "",
                  kdf: capturedBody?.kdf ?? VAULT_TEST_KDF,
                },
              }
            : legacySession;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => session,
            text: async () => JSON.stringify(session),
          } as Response;
        }
        if (pathname === "/auth/vault" && init?.method === "POST") {
          capturedBody = JSON.parse(String(init.body)) as typeof capturedBody;
          migrated = true;
          return {
            ok: true,
            status: 204,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => "",
          } as Response;
        }
        throw new Error(`unexpected fetch: ${pathname}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const state = await service.bootstrap();
    expect(state.vault?.status).toBe("legacy");
    // pre-seeding — v1 키가 DEK 캐시에 선저장된다(비동기라 한 틱 대기).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cachedDekOf(await secretStore.load(dekAccount()))).toBe(
      legacyKeyBase64,
    );

    await service.migrateVault(passphrase);

    expect(service.getState().vault?.status).toBe("unlocked");
    expect(service.getVaultKeyBase64()).toBe(legacyKeyBase64);
    // 업로드된 wrapped 를 같은 암호로 풀면 기존 DEK 가 나와야 한다(로테이션 없음).
    const { deriveVaultKek, unwrapVaultDek } =
      await import("@dolssh/shared-core");
    const { desktopArgon2idDerive } = await import("./vault-crypto");
    const kek = await deriveVaultKek(
      desktopArgon2idDerive,
      passphrase,
      capturedBody!.kdf,
    );
    expect(
      Buffer.from(unwrapVaultDek(capturedBody!.wrappedDekBase64, kek)).toString(
        "base64",
      ),
    ).toBe(legacyKeyBase64);
    // 전환 후 refresh 로 v2 세션을 받아도 unlocked 가 유지된다.
    expect(service.getState().session?.vaultBootstrap.version).toBe(2);
  });
});

// 로그인 없이 이 기기에서만 쓰는 상태. 데스크톱 전용이다 — 폰에서는 계정이 곧 백업이다.
describe("AuthService 로컬 전용", () => {
  it("계정 없이 시작하면 그 상태로 서고, 다음 실행에도 이어진다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);

    const started = await service.startLocalOnly();
    expect(started.status).toBe("local-only");
    expect(started.session ?? null).toBeNull();

    // 다시 켠 것과 같다 — 리프레시 토큰을 찾지 않고 그 상태로 연다. 이미 결정한 사람에게
    // 로그인 화면을 다시 보여 주지 않는다.
    const { service: restarted } = await createService(serverUrl);
    const restored = await restarted.bootstrap();
    expect(restored.status).toBe("local-only");
  });

  // 기록(활동 로그·세션 리플레이)은 활성화된 범위에만 쌓인다. 계정 없이 쓰는 동안 이 알림이
  // 오지 않으면 범위가 없어 append 가 조용히 아무것도 하지 않았다 — 로그아웃하고 쓰면 로그가
  // 한 줄도 남지 않았고, 화면에는 오류도 뜨지 않았다.
  it("계정 없이 시작해도 기록 자리를 연다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    const onSessionActivated = vi.fn();
    service.setOnSessionActivated(onSessionActivated);

    await service.startLocalOnly();
    expect(onSessionActivated).toHaveBeenCalledWith({ kind: "local-only" });

    // 다시 켤 때도 마찬가지다. 이 길로 들어오면 로그인 화면을 거치지 않는다.
    const { service: restarted } = await createService(serverUrl);
    const onRestartActivated = vi.fn();
    restarted.setOnSessionActivated(onRestartActivated);
    expect((await restarted.bootstrap()).status).toBe("local-only");
    expect(onRestartActivated).toHaveBeenCalledWith({ kind: "local-only" });
  });

  // 로그아웃하면 로그인 화면으로 돌아가야 한다. 고른 기억이 남아 있으면 텅 빈 워크스페이스로
  // 떨어져 "내 데이터가 어디 갔나" 가 된다.
  it("로그아웃하면 고른 기억이 지워진다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    await service.startLocalOnly();
    await service.logout();

    const { service: restarted } = await createService(serverUrl);
    const restored = await restarted.bootstrap();
    expect(restored.status).not.toBe("local-only");
  });

  // 브라우저로 보냈다가 로그인을 다 끝내고 돌아온 뒤 "이 서버는 안 됩니다" 라고 하는 것이
  // 최악이다. /api/info 는 토큰이 필요 없으므로 열기 전에 본다.
  it("데이터 수준을 판정 못 하는 서버로는 브라우저를 열지 않는다", async () => {
    const serverUrl = "https://old.example.com";
    const { service } = await createService(serverUrl);
    const { shell } = await import("electron");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            serverVersion: "1.8.9",
            capabilities: { sync: { awsProfiles: true } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(service.beginBrowserLogin()).rejects.toThrow();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  // 네트워크가 끊겼거나 프록시가 가로챈 것을 "옛 서버" 로 오인하면 멀쩡한 계정에 못 들어간다.
  it("서버 정보를 읽지 못하면 막지 않는다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    const { shell } = await import("electron");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await service.beginBrowserLogin();
    expect(shell.openExternal).toHaveBeenCalled();
  });

  // 취소하면 로그인을 시작하기 전으로 돌아가야 한다. `unauthenticated` 로 떨어뜨리면 열어 둔
  // 터미널과 로컬 데이터가 화면에서 사라지고 다음 실행에도 로그인 화면이 뜬다 — 아무것도 안
  // 했는데 잃은 것처럼 보인다.
  it("로그인을 취소하면 계정 없이 쓰던 자리로 돌아온다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            serverVersion: "1.9.5",
            capabilities: { sync: { dataFloor: true } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await service.startLocalOnly();
    await service.beginBrowserLogin();
    expect(service.getState().status).toBe("authenticating");

    await service.cancelBrowserLogin();
    expect(service.getState().status).toBe("local-only");

    // 다음 실행에도 이어진다.
    const { service: restarted } = await createService(serverUrl);
    expect((await restarted.bootstrap()).status).toBe("local-only");
  });

  // 서버를 거치는 기능(AWS 서버 프록시)이 "로그인이 필요합니다" 를 던지면, 만료 판정이 그것을
  // 세션이 끊긴 것으로 읽어 상태를 통째로 지웠다 — 연결 한 번 실패했을 뿐인데 다음 실행에
  // 로그인 화면이 떴다.
  it("연결이 로그인을 요구해도 계정 없이 쓰던 상태를 지우지 않는다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    await service.startLocalOnly();

    await service.forceUnauthenticated("로그인이 필요합니다.");
    expect(service.getState().status).toBe("local-only");

    const { service: restarted } = await createService(serverUrl);
    expect((await restarted.bootstrap()).status).toBe("local-only");
  });

  // 그 문구 자체도 만료 판정(forceUnauthenticated 의 정규식)에 걸리지 않는 말이어야 한다 —
  // 걸리면 다른 경로에서 같은 일이 되풀이된다.
  it("계정이 필요한 기능은 만료로 읽히지 않는 문구로 거절한다", async () => {
    const { service } = await createService("https://ssh.doldolma.com");
    await service.startLocalOnly();

    let message = "";
    try {
      service.getAccessToken();
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toBe("");
    expect(message).not.toMatch(
      /세션이 만료|session has expired|token is expired|invalid claims|로그인이 필요|sign-in is required/i,
    );
  });

  // 서버를 거치는 기능이 토큰을 못 얻으면 세션 되살리기를 시도한다
  // (aws-ws-proxy 의 runWithAwsServerProxyAuthRetry). 계정 없이 쓰는 중에는 되살릴 세션이
  // 없는데, 그 시도가 실패하면서 `unauthenticated` 를 디스크에 적어 선택까지 지웠다.
  it("세션 되살리기가 계정 없이 쓰던 상태를 지우지 않는다", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service } = await createService(serverUrl);
    await service.startLocalOnly();

    const refreshed = await service.refreshSession();
    expect(refreshed.status).toBe("local-only");

    const { service: restarted } = await createService(serverUrl);
    expect((await restarted.bootstrap()).status).toBe("local-only");
  });
});
