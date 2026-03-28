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
  const settings = {
    get: () => ({
      serverUrl,
    }),
  };

  return {
    secretStore,
    service: new AuthService(
      secretStore,
      configService as never,
      settings as never,
    ),
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
  it("enters offline-authenticated when refresh fails but a valid offline lease is cached", async () => {
    const serverUrl = "https://ssh.doldolma.com";
    const { service, secretStore } = await createService(serverUrl);
    const session = createSession(serverUrl);

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
});
