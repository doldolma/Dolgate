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
