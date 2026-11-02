import { beforeEach, describe, expect, it, vi } from "vitest";

// Electron 44 부터 클립보드 읽기·쓰기는 Promise 다. 테스트마다 값을 바꿔 끼운다.
const { handlers, listeners, clipboardMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  clipboardMock: {
    readText: vi.fn(async (): Promise<string> => ""),
    writeText: vi.fn(async (_text: string) => {}),
  },
}));

vi.mock("electron", () => ({
  clipboard: clipboardMock,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener);
    },
  },
}));

const { registerVncIpcHandlers } = await import("./vnc");
const { PERSONAL_VAULT_ID } = await import("../vault-catalog");
const { VncConnectError } = await import("../vnc-manager");

function createHarness() {
  const vncManager = {
    onRemoteClipboardText: null as ((text: string) => void) | null,
    sendClipboardText: vi.fn(),
  };
  registerVncIpcHandlers({} as never, vncManager as never);
  return { vncManager };
}

describe("registerVncIpcHandlers clipboard", () => {
  beforeEach(() => {
    clipboardMock.readText.mockReset();
    clipboardMock.writeText.mockReset();
  });

  it("원격 값이 로컬 클립보드와 같으면 다시 쓰지 않는다", async () => {
    const { vncManager } = createHarness();
    clipboardMock.readText.mockResolvedValue("same");

    vncManager.onRemoteClipboardText!("same");
    await vi.waitFor(() => expect(clipboardMock.readText).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("원격 값이 다르면 로컬 클립보드에 쓴다", async () => {
    const { vncManager } = createHarness();
    clipboardMock.readText.mockResolvedValue("old");

    vncManager.onRemoteClipboardText!("new");

    await vi.waitFor(() => expect(clipboardMock.writeText).toHaveBeenCalledWith("new"));
  });

  it("포커스 때 로컬 클립보드를 원격으로 올리고, 비어 있으면 보내지 않는다", async () => {
    const { vncManager } = createHarness();
    const sync = listeners.get("vnc:sync-clipboard")!;

    clipboardMock.readText.mockResolvedValue("local text");
    sync({}, "sess-1");
    await vi.waitFor(() =>
      expect(vncManager.sendClipboardText).toHaveBeenCalledWith("sess-1", "local text"),
    );

    vncManager.sendClipboardText.mockClear();
    clipboardMock.readText.mockResolvedValue("");
    sync({}, "sess-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vncManager.sendClipboardText).not.toHaveBeenCalled();
  });
});

// 비밀값·통로를 기다리는 사이 팀에서 빠지면(지우면) 그 세션은 아직 VNC 관리자에 적히지 않아 '팀 연결 닫기'가 닿지 않는다.
// 기다린 뒤 붙기 전에 호스트가 아직 있는지 본다 — 없으면 붙지 않고, 연 통로는 닫는다.
describe("registerVncIpcHandlers when the host leaves its vault while connecting", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function createConnectHarness(hostOverrides: Record<string, unknown> = {}) {
    const host = {
      id: "vnc-1",
      kind: "vnc" as const,
      label: "Console",
      hostname: "10.0.0.5",
      port: 5900,
      secretRef: null,
      ...hostOverrides,
    };
    const gateway = {
      id: "gw-1",
      kind: "ssh" as const,
      label: "Gateway",
      hostname: "gw.example.com",
      port: 22,
      username: "ops",
      authType: "password" as const,
    };
    let present = true;
    const ctx = {
      vaults: {
        getHost: vi.fn((hostId: string) =>
          hostId === host.id ? (present ? host : null) : hostId === gateway.id ? gateway : null,
        ),
        scopeOfHost: vi.fn(() => ({ id: PERSONAL_VAULT_ID })),
      },
      loadHostSecrets: vi.fn(async () => ({ password: "pw" })),
      coreManager: {
        openTailnetForward: vi.fn(async () => "127.0.0.1:55900"),
        closeTailnetForward: vi.fn(),
        startPortForward: vi.fn(async () => ({ bindAddress: "127.0.0.1", bindPort: 55901 })),
        stopPortForward: vi.fn(async () => {}),
      },
      resolveTrustedHostKeys: vi.fn(() => []),
      resolveSshAuth: vi.fn(async () => ({
        username: "ops",
        authType: "password",
        secrets: { password: "gw-pw" },
      })),
      ensureCertificateAuthReady: vi.fn(async () => {}),
      resolveJumpHostTarget: vi.fn(async () => null),
      resolveTailnetRoute: vi.fn(() => ({})),
    };
    const vncManager = {
      onRemoteClipboardText: null as ((text: string) => void) | null,
      sendClipboardText: vi.fn(),
      watchSession: vi.fn(),
      unwatchSession: vi.fn(),
      reportProgress: vi.fn(),
      setSessionOwner: vi.fn(),
      connect: vi.fn(async () => ({ width: 1024, height: 768 })),
      disconnect: vi.fn(),
    };
    registerVncIpcHandlers(ctx as never, vncManager as never);
    return {
      ctx,
      vncManager,
      gone: () => {
        present = false;
      },
      connect: () =>
        handlers.get("vnc:connect")!({ sender: { id: 7 } }, "sess-v", host.id) as Promise<unknown>,
    };
  }

  it("does not open the SSH tunnel when the host left while the credential was read", async () => {
    const harness = createConnectHarness({ sshTunnelHostId: "gw-1" });
    const secrets = deferred<{ password: string }>();
    harness.ctx.loadHostSecrets.mockReturnValue(secrets.promise);

    const pending = harness.connect();
    await vi.waitFor(() => expect(harness.ctx.loadHostSecrets).toHaveBeenCalled());
    harness.gone();
    secrets.resolve({ password: "pw" });

    await expect(pending).rejects.toThrow("Host not found");
    expect(harness.ctx.coreManager.startPortForward).not.toHaveBeenCalled();
    expect(harness.vncManager.connect).not.toHaveBeenCalled();
  });

  it("does not dial, and closes the SSH tunnel, when the host left while the tunnel opened", async () => {
    const harness = createConnectHarness({ sshTunnelHostId: "gw-1" });
    const tunnel = deferred<{ bindAddress: string; bindPort: number }>();
    harness.ctx.coreManager.startPortForward.mockReturnValue(tunnel.promise);

    const pending = harness.connect();
    await vi.waitFor(() => expect(harness.ctx.coreManager.startPortForward).toHaveBeenCalled());
    harness.gone();
    tunnel.resolve({ bindAddress: "127.0.0.1", bindPort: 55901 });

    await expect(pending).rejects.toThrow("Host not found");
    expect(harness.vncManager.connect).not.toHaveBeenCalled();
    expect(harness.ctx.coreManager.stopPortForward).toHaveBeenCalledWith("vnc:sess-v");
  });

  // 팀에서 빠지면 메인이 팀 게이트웨이의 터널(포워딩)을 먼저 멈춘다 — 통로가 열리기 전에 취소 오류로 끝난다. 그 오류 대신 까닭으로.
  it("ends with the reason, not the tunnel's cancel error, when the host left while the tunnel opened", async () => {
    const harness = createConnectHarness({ sshTunnelHostId: "gw-1" });
    harness.ctx.coreManager.startPortForward.mockImplementation(async () => {
      harness.gone();
      throw new Error("ssh handshake failed: host key trust prompt was cancelled: context canceled");
    });

    await expect(harness.connect()).rejects.toThrow("Host not found");
    expect(harness.vncManager.connect).not.toHaveBeenCalled();
    expect(harness.vncManager.unwatchSession).toHaveBeenCalledWith("sess-v", 7);
  });

  it("keeps the tunnel's own failure when the host is still there", async () => {
    const harness = createConnectHarness({ sshTunnelHostId: "gw-1" });
    harness.ctx.coreManager.startPortForward.mockRejectedValue(new Error("dial tcp: connection refused"));

    await expect(harness.connect()).rejects.toThrow("dial tcp: connection refused");
  });

  it("does not dial, and closes the tailnet forward, when the host left while the forward opened", async () => {
    const harness = createConnectHarness({ tailnetId: "net-a" });
    const forward = deferred<string>();
    harness.ctx.coreManager.openTailnetForward.mockReturnValue(forward.promise);

    const pending = harness.connect();
    await vi.waitFor(() => expect(harness.ctx.coreManager.openTailnetForward).toHaveBeenCalled());
    harness.gone();
    forward.resolve("127.0.0.1:55900");

    await expect(pending).rejects.toThrow("Host not found");
    expect(harness.vncManager.connect).not.toHaveBeenCalled();
    expect(harness.ctx.coreManager.closeTailnetForward).toHaveBeenCalledWith("sess-v");
  });
});

// 다듬기 2단계 — SSH 터널 호스트의 비밀번호가 빠지면 VNC 연결 대신 그 홉을 묻는다. 전에는 코어가 붙기 전에
// "password auth requires a password" 로 멈췄고, 그 문구는 VNC 비밀번호 문제로 읽혔다.
describe("registerVncIpcHandlers asks for the SSH tunnel host's password", () => {
  function createTunnelHarness(storedGatewayPassword?: string) {
    const host = {
      id: "vnc-1",
      kind: "vnc" as const,
      label: "Console",
      hostname: "10.0.0.5",
      port: 5900,
      secretRef: null,
      sshTunnelHostId: "gw-1",
    };
    const gateway = {
      id: "gw-1",
      kind: "ssh" as const,
      label: "Gateway",
      hostname: "gw.example.com",
      port: 22,
      username: "ops",
      authType: "password" as const,
    };
    const ctx = {
      vaults: {
        getHost: vi.fn((hostId: string) => (hostId === host.id ? host : hostId === gateway.id ? gateway : null)),
        getHostInSameVault: vi.fn(() => null),
        scopeOfHost: vi.fn(() => ({ id: PERSONAL_VAULT_ID })),
      },
      loadHostSecrets: vi.fn(async () => ({ password: "vnc-pw" })),
      coreManager: {
        startPortForward: vi.fn(async () => ({ bindAddress: "127.0.0.1", bindPort: 55901 })),
        stopPortForward: vi.fn(async () => {}),
      },
      resolveTrustedHostKeys: vi.fn(() => []),
      // 저장된 터널 비밀번호(storedGatewayPassword)보다 이번에 넣은 값이 먼저다.
      resolveSshAuth: vi.fn(async (_host: unknown, provided?: { password?: string }) => ({
        username: "ops",
        authType: "password",
        secrets: provided?.password
          ? { password: provided.password }
          : storedGatewayPassword
            ? { password: storedGatewayPassword }
            : {},
        shouldPersistHostSecret: Boolean(provided?.password),
        typedUsername: null,
      })),
      ensureCertificateAuthReady: vi.fn(async () => {}),
      resolveJumpHostTarget: vi.fn(async () => null),
      resolveTailnetRoute: vi.fn(() => ({})),
      persistHostSpecificSecret: vi.fn(async () => "ref"),
    };
    const vncManager = {
      onRemoteClipboardText: null as ((text: string) => void) | null,
      sendClipboardText: vi.fn(),
      watchSession: vi.fn(),
      unwatchSession: vi.fn(),
      reportProgress: vi.fn(),
      setSessionOwner: vi.fn(),
      connect: vi.fn(async () => ({ width: 1024, height: 768 })),
      disconnect: vi.fn(),
    };
    registerVncIpcHandlers(ctx as never, vncManager as never);
    return {
      ctx,
      vncManager,
      connect: (attempt?: unknown) =>
        handlers.get("vnc:connect")!({ sender: { id: 7 } }, "sess-v", host.id, attempt) as Promise<unknown>,
    };
  }

  it("names the tunnel host and opens nothing when its password is missing", async () => {
    const harness = createTunnelHarness();
    await expect(harness.connect()).resolves.toEqual({ credentialsNeeded: { hostId: "gw-1", reason: "missing" } });
    expect(harness.vncManager.watchSession).not.toHaveBeenCalled();
    expect(harness.ctx.coreManager.startPortForward).not.toHaveBeenCalled();
  });

  it("opens the tunnel with the typed value and saves it once the tunnel is up", async () => {
    const harness = createTunnelHarness();
    await expect(harness.connect({ secrets: { password: "gw-typed" } })).resolves.toEqual({ width: 1024, height: 768 });
    expect(harness.ctx.coreManager.startPortForward).toHaveBeenCalledWith(expect.objectContaining({ password: "gw-typed" }));
    expect(harness.ctx.persistHostSpecificSecret).toHaveBeenCalledWith("gw-1", "Gateway", { password: "gw-typed" }, null);
    // VNC 자체의 비밀번호는 그대로 VNC 에 간다.
    expect(harness.vncManager.connect).toHaveBeenCalledWith(expect.objectContaining({ password: "vnc-pw" }), expect.anything());
  });

  it("asks the tunnel host again when it rejects the typed value, saving nothing", async () => {
    const harness = createTunnelHarness();
    const rejected = new Error("ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]");
    harness.ctx.coreManager.startPortForward.mockRejectedValue(rejected);
    await expect(harness.connect({ secrets: { password: "wrong" } })).resolves.toEqual({
      credentialsNeeded: { hostId: "gw-1", reason: "rejected", message: rejected.message },
    });
    expect(harness.ctx.persistHostSpecificSecret).not.toHaveBeenCalled();
    expect(harness.vncManager.unwatchSession).toHaveBeenCalledWith("sess-v", 7);
    expect(harness.vncManager.connect).not.toHaveBeenCalled();
  });

  it("saves nothing when the stored value opened the tunnel", async () => {
    const harness = createTunnelHarness("gw-stored");
    await expect(harness.connect()).resolves.toEqual({ width: 1024, height: 768 });
    expect(harness.ctx.persistHostSpecificSecret).not.toHaveBeenCalled();
  });
});

describe("registerVncIpcHandlers asks for the VNC host's own credentials", () => {
  function createDirectHarness(stored: { username?: string; password?: string } = {}) {
    const host = {
      id: "vnc-1",
      kind: "vnc" as const,
      label: "Console",
      hostname: "10.0.0.5",
      port: 5900,
      secretRef: null,
    };
    const ctx = {
      vaults: {
        getHost: vi.fn((hostId: string) => (hostId === host.id ? host : null)),
        getHostInSameVault: vi.fn(() => null),
        scopeOfHost: vi.fn(() => ({ id: PERSONAL_VAULT_ID })),
      },
      loadHostSecrets: vi.fn(async () => stored),
      coreManager: {
        startPortForward: vi.fn(),
        stopPortForward: vi.fn(async () => {}),
      },
      persistHostSpecificSecret: vi.fn(async (): Promise<string | null> => "ref"),
    };
    const vncManager = {
      onRemoteClipboardText: null as ((text: string) => void) | null,
      sendClipboardText: vi.fn(),
      watchSession: vi.fn(),
      unwatchSession: vi.fn(),
      reportProgress: vi.fn(),
      setSessionOwner: vi.fn(),
      connect: vi.fn(async (): Promise<unknown> => ({ width: 1024, height: 768 })),
      disconnect: vi.fn(),
    };
    registerVncIpcHandlers(ctx as never, vncManager as never);
    return {
      ctx,
      vncManager,
      connect: (attempt?: unknown) =>
        handlers.get("vnc:connect")!({ sender: { id: 7 } }, "sess-v", host.id, attempt) as Promise<unknown>,
    };
  }

  it("asks for the VNC password when the server wants one and none was stored", async () => {
    const harness = createDirectHarness();
    harness.vncManager.connect.mockRejectedValue(
      new VncConnectError("the server requires a password and none was stored", "password-required", false),
    );
    await expect(harness.connect()).resolves.toEqual({
      credentialsNeeded: {
        hostId: "vnc-1",
        reason: "missing",
        message: "the server requires a password and none was stored",
        failure: "password-required",
      },
    });
    expect(harness.vncManager.unwatchSession).toHaveBeenCalledWith("sess-v", 7);
    expect(harness.ctx.persistHostSpecificSecret).not.toHaveBeenCalled();
  });

  // 계정까지 묻는 창은 방금 쓴 계정을 미리 채운다 — 비밀번호만 고치면 되는 일이 대부분이다.
  it("asks again with the account it used when the server rejects the account", async () => {
    const harness = createDirectHarness({ username: "alice", password: "old" });
    harness.vncManager.connect.mockRejectedValue(new VncConnectError("rejected", "account-auth-rejected", false));
    await expect(harness.connect()).resolves.toEqual({
      credentialsNeeded: {
        hostId: "vnc-1",
        reason: "rejected",
        message: "rejected",
        failure: "account-auth-rejected",
        username: "alice",
      },
    });
  });

  // 계정을 요구하는 서버(macOS 화면 공유)에 계정이 없었다 — 거절이 아니라 아직 안 넣은 것이다.
  it("says the account is missing when the server wants one and none was stored", async () => {
    const harness = createDirectHarness({ password: "pw" });
    harness.vncManager.connect.mockRejectedValue(
      new VncConnectError("the server requires an account name and none was stored", "account-required", false),
    );
    await expect(harness.connect()).resolves.toMatchObject({
      credentialsNeeded: { hostId: "vnc-1", reason: "missing", failure: "account-required" },
    });
  });

  // 비밀번호로 풀리지 않는 실패는 코어가 이미 화면에 알렸다 — 그렇다고만 돌려준다. 오류로 던지면 화면 흐름이 그 표시
  // (Retry·재연결 예약)를 덮는다. 연 것은 닫는다.
  it("says a failure the core already showed was reported, closing what it opened", async () => {
    const harness = createDirectHarness({ password: "pw" });
    harness.vncManager.connect.mockRejectedValue(new VncConnectError("connection refused", "refused", true));
    await expect(harness.connect()).resolves.toEqual({ failureReported: true });
    expect(harness.vncManager.unwatchSession).toHaveBeenCalledWith("sess-v", 7);
  });

  // 화면이 모르는 실패(세션 없는 코어 응답·코어가 꺼짐)는 지금처럼 오류다 — 화면 흐름이 그것을 그린다.
  it("throws a failure the screen has not been told about", async () => {
    const harness = createDirectHarness({ password: "pw" });
    harness.vncManager.connect.mockRejectedValueOnce(new VncConnectError("bad request", null, false));
    await expect(harness.connect()).rejects.toThrow("bad request");
    harness.vncManager.connect.mockRejectedValueOnce(new Error("vnc-core exited"));
    await expect(harness.connect()).rejects.toThrow("vnc-core exited");
  });

  it("connects with the typed password over the stored one and saves what it connected with", async () => {
    const harness = createDirectHarness({ username: "alice", password: "old" });
    await expect(harness.connect({ vncSecrets: { password: "typed" } })).resolves.toEqual({ width: 1024, height: 768 });
    expect(harness.vncManager.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "typed", username: "alice" }),
      expect.anything(),
    );
    expect(harness.ctx.persistHostSpecificSecret).toHaveBeenCalledWith("vnc-1", "Console", {
      kind: "vnc",
      username: "alice",
      password: "typed",
    });
  });

  // 계정이 거절된 서버(macOS 화면 공유)에서 계정을 비우면 VNC 암호로 붙는다 — 저장도 계정 없이.
  it("connects with a typed empty account as no account, and saves without one", async () => {
    const harness = createDirectHarness({ username: "alice", password: "old" });
    await harness.connect({ vncSecrets: { username: "", password: "typed" } });
    expect(harness.vncManager.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "typed", username: "" }),
      expect.anything(),
    );
    const saved = harness.ctx.persistHostSpecificSecret.mock.calls[0] as unknown[];
    expect(saved[2]).toEqual({ kind: "vnc", password: "typed" });
    expect((saved[2] as { username?: string }).username).toBeUndefined();
  });

  it("saves nothing when the stored values connected", async () => {
    const harness = createDirectHarness({ password: "stored" });
    await expect(harness.connect()).resolves.toEqual({ width: 1024, height: 768 });
    expect(harness.ctx.persistHostSpecificSecret).not.toHaveBeenCalled();
  });

  it("saves nothing when the typed value is rejected", async () => {
    const harness = createDirectHarness();
    harness.vncManager.connect.mockRejectedValue(new VncConnectError("the server rejected the credentials", "auth-rejected", false));
    await expect(harness.connect({ vncSecrets: { password: "wrong" } })).resolves.toMatchObject({
      credentialsNeeded: { hostId: "vnc-1", reason: "rejected", failure: "auth-rejected" },
    });
    expect(harness.ctx.persistHostSpecificSecret).not.toHaveBeenCalled();
  });

  // 붙은 연결은 저장이 실패해도 그대로 둔다 — 다음에 다시 물을 뿐이다.
  it("keeps the connection when saving fails", async () => {
    const harness = createDirectHarness();
    harness.ctx.persistHostSpecificSecret.mockRejectedValue(new Error("keychain locked"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(harness.connect({ vncSecrets: { password: "typed" } })).resolves.toEqual({ width: 1024, height: 768 });
    expect(harness.vncManager.unwatchSession).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
