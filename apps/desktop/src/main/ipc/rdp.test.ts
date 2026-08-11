import { describe, expect, it, vi } from "vitest";
import type { RdpCertificateInfo } from "@shared";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, (...args: unknown[]) => unknown>();

const displays = [
  { id: 1, label: "Built-in", bounds: { x: 0, y: 0, width: 3008, height: 1692 } },
  { id: 2, label: "LG", bounds: { x: 3008, y: 0, width: 1920, height: 1080 } },
];

// 펼치기 요청을 보낸 창. 기본은 없음(펼치기가 그냥 빠져나온다) — 그 경로를 쓰는 테스트만 채운다.
const { sender, monitorWindowsInstances } = vi.hoisted(() => ({
  sender: { window: null as unknown },
  monitorWindowsInstances: [] as Array<{
    onCollapseRequested: ((sessionId: string) => void) | null;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../rdp-monitor-windows", () => {
  class MockRdpMonitorWindows {
    onGeometryChanged: ((sessionId: string) => void) | null = null;
    onCollapseRequested: ((sessionId: string) => void) | null = null;
    // 메인 창이 0번 모니터를 맡았다고 본다.
    open = vi.fn(async () => 0);
    close = vi.fn(async () => {});
    closeAll = vi.fn(async () => {});
    entries = vi.fn(() => []);
    isOpen = vi.fn(() => false);

    constructor() {
      monitorWindowsInstances.push(this as never);
    }
  }
  return { RdpMonitorWindows: MockRdpMonitorWindows };
});

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: () => sender.window },
  screen: {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: () => displays[0],
    on: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readText: () => "", writeText: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener);
    },
  },
}));

const { registerRdpIpcHandlers } = await import("./rdp");

const CERT: RdpCertificateInfo = {
  fingerprint: "AA:BB:CC",
  subject: "CN=win-box",
  issuer: "CN=win-box",
  notAfter: "2027-01-01T00:00:00Z",
};

function createHarness(
  fingerprint: string | null,
  /** 이 기기에서 골라 둔 모니터. 호스트 레코드가 아니라 기기 로컬 설정에 있다. */
  monitors: Array<{ id: number; label: string; width: number; height: number }> | null = null,
  hostOverrides: Record<string, unknown> = {},
) {
  const host = {
    id: "rdp-1",
    kind: "rdp" as const,
    label: "Win Box",
    hostname: "10.0.0.1",
    port: 3389,
    username: "user",
    domain: null,
    secretRef: "secret:1",
    certificateFingerprint: fingerprint,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...hostOverrides,
  };

  const ctx = {
    coreManager: {
      openTailnetForward: vi.fn(async () => "127.0.0.1:52341"),
      closeTailnetForward: vi.fn(),
    },
    settings: {
      get: vi.fn(() => ({
        rdpMonitorsByHostId: monitors ? { "rdp-1": monitors } : {},
      })),
    },
    hosts: {
      getById: vi.fn(() => host),
      updateRdpCertificateFingerprint: vi.fn((_id: string, next: string) => {
        host.certificateFingerprint = next;
        return host;
      }),
    },
    loadSecrets: vi.fn(async () => ({ password: "secret" })),
    activityLogs: { append: vi.fn() },
    queueSync: vi.fn(),
  };

  let verifier:
    | ((sessionId: string, certificate: RdpCertificateInfo) => Promise<boolean>)
    | null = null;

  const rdpManager = {
    setCertificateVerifier: vi.fn((fn: typeof verifier) => {
      verifier = fn;
    }),
    connect: vi.fn(async () => ({
      monitors: [],
    })),
    disconnect: vi.fn(),
    sendInput: vi.fn(),
    requestResize: vi.fn(),
  };

  const askCertificate = vi.fn(async () => true);

  registerRdpIpcHandlers(ctx as never, rdpManager as never, { askCertificate });

  return {
    ctx,
    rdpManager,
    askCertificate,
    host,
    // 인증서 판정은 connect 가 진행되는 도중에 불린다. 그 순서를 그대로 재현한다.
    async connectAndVerify() {
      const connect = handlers.get("rdp:connect")!;
      const pending = connect({}, "sess-1", "rdp-1");
      // 시크릿 로딩이 한 틱 소비한다. 실제로는 TCP/TLS 뒤라 훨씬 늦게 오지만, 여기서는
      // 등록이 await 앞에 있는지를 이 한 틱으로 검증한다.
      await Promise.resolve();
      const accepted = await verifier!("sess-1", CERT);
      await pending;
      return accepted;
    },
  };
}

describe("registerRdpIpcHandlers certificate trust", () => {
  it("queues a sync after pinning so the next pull cannot wipe it", async () => {
    const harness = createHarness(null);

    await expect(harness.connectAndVerify()).resolves.toBe(true);

    expect(harness.ctx.hosts.updateRdpCertificateFingerprint).toHaveBeenCalledWith(
      "rdp-1",
      "AA:BB:CC",
    );
    // sync pull 은 호스트 목록을 서버 사본으로 통째로 교체한다. 밀어 올리지 않으면 핀이
    // 로컬에만 남아 다음 실행에서 조용히 사라진다.
    expect(harness.ctx.queueSync).toHaveBeenCalled();
  });

  it("accepts a matching pin without prompting or re-syncing", async () => {
    const harness = createHarness("AA:BB:CC");

    await expect(harness.connectAndVerify()).resolves.toBe(true);

    expect(harness.askCertificate).not.toHaveBeenCalled();
    expect(harness.ctx.queueSync).not.toHaveBeenCalled();
  });

  it("does not pin anything when the user refuses", async () => {
    const harness = createHarness(null);
    harness.askCertificate.mockResolvedValueOnce(false);

    await expect(harness.connectAndVerify()).resolves.toBe(false);

    expect(harness.ctx.hosts.updateRdpCertificateFingerprint).not.toHaveBeenCalled();
    expect(harness.ctx.queueSync).not.toHaveBeenCalled();
  });
});

describe("registerRdpIpcHandlers monitor layout", () => {
  it("uses the app resolution when a single monitor is chosen on this device", async () => {
    // 하나만 고른 건 "펼치지 않는다"는 뜻이다. 그 화면의 물리 해상도로 붙으면 창은 훨씬 작은데
    // 프레임만 큰 화면 기준으로 와서 낭비가 크다.
    const harness = createHarness("AA:BB:CC", [
      { id: 1, label: "Built-in", width: 3008, height: 1692 },
    ]);

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        monitors: [{ width: 1920, height: 1080, primary: true }],
      }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("borrows the real layout once more than one monitor is chosen", async () => {
    const harness = createHarness("AA:BB:CC", [
      { id: 1, label: "Built-in", width: 3008, height: 1692 },
      { id: 2, label: "LG", width: 1920, height: 1080 },
    ]);

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        monitors: expect.arrayContaining([
          expect.objectContaining({ width: 3008, height: 1692 }),
          expect.objectContaining({ width: 1920, height: 1080 }),
        ]),
      }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("uses every display when the host asks for all monitors", async () => {
    // 이 기기에서 따로 고른 것이 없으면 호스트의 "전체 모니터 사용"이 결정한다. 화면이 하나뿐인
    // 테스트 환경에서는 그 하나로 붙는 것이 맞다.
    const harness = createHarness("AA:BB:CC", null, { useAllMonitors: true });

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ monitors: expect.any(Array) }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("passes the audio, clipboard and color options to the core", async () => {
    // 없거나 null 이 "켜짐"이다. 옛 호스트가 조용해지거나 클립보드를 잃으면 안 된다.
    const on = createHarness("AA:BB:CC");
    await on.connectAndVerify();
    expect(on.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ audio: true, clipboard: true, colorDepth: undefined }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );

    const off = createHarness("AA:BB:CC", null, {
      audioEnabled: false,
      clipboardEnabled: false,
      colorDepth: 16,
    });
    await off.connectAndVerify();
    expect(off.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ audio: false, clipboard: false, colorDepth: 16 }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("sends every shared folder with the name the form shows", async () => {
    // 이름을 코어가 다시 만들면 편집 화면에 보여준 이름과 원격에 뜨는 이름이 갈린다.
    const harness = createHarness("AA:BB:CC", null, {
      drives: [
        { path: "/Users/me/docs", readOnly: null },
        { path: "/Volumes/backup/docs", readOnly: true },
      ],
    });

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        drives: [
          { label: "docs", path: "/Users/me/docs", readOnly: false },
          // 이름이 겹치면 원격에서 하나가 안 보인다.
          { label: "docs 2", path: "/Volumes/backup/docs", readOnly: true },
        ],
      }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("sends no drives when none are shared", async () => {
    const harness = createHarness("AA:BB:CC");
    await harness.connectAndVerify();
    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ drives: [] }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("takes the account from the credential", async () => {
    // 계정은 자격증명에 딸린다. 호스트 레코드에서 읽으면 자격증명을 바꿔도 안 따라온다.
    const harness = createHarness("AA:BB:CC", null, { username: undefined, domain: null });
    harness.ctx.loadSecrets = vi.fn(async () => ({
      username: "Administrator",
      domain: "CORP",
      password: "secret",
    }));

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        username: "Administrator",
        domain: "CORP",
        password: "secret",
      }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("sends an empty account when the credential has none", async () => {
    // 계정은 자격증명에만 있다. 호스트 레코드에는 계정 필드가 없으므로 폴백도 없다 —
    // 계정 없는 자격증명이면 서버가 인증을 거절하고, 그게 맞는 결과다.
    const harness = createHarness("AA:BB:CC");
    harness.ctx.loadSecrets = vi.fn(async () => ({ password: "secret" }));

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ username: "", domain: null }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("routes a tailnet host through a local forward", async () => {
    // rdp-core 는 Rust 라서 tailnet 을 직접 쓸 수 없다. ssh-core 가 연 로컬 주소로 붙는다.
    const harness = createHarness("AA:BB:CC", null, { tailnetId: "net-a" });

    await harness.connectAndVerify();

    expect(harness.ctx.coreManager.openTailnetForward).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sess-1",
        tailnetId: "net-a",
        host: "10.0.0.1",
        port: 3389,
      }),
    );
    // 붙는 주소는 로컬 포워드지만 **호스트 이름은 그대로** 가야 한다 — TLS 서버 이름과 인증서
    // 지문 핀의 키가 그것이라, 여기서 로컬 주소로 바꾸면 서로 다른 tailnet 호스트가 모두 같은
    // 서버로 보인다.
    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        dialAddress: "127.0.0.1:52341",
        host: "10.0.0.1",
      }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("does not open a forward for a plain host", async () => {
    const harness = createHarness("AA:BB:CC");

    await harness.connectAndVerify();

    expect(harness.ctx.coreManager.openTailnetForward).not.toHaveBeenCalled();
    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ dialAddress: undefined }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });

  it("falls back to the app resolution when nothing is chosen", async () => {
    const harness = createHarness("AA:BB:CC", null);

    await harness.connectAndVerify();

    expect(harness.rdpManager.connect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        monitors: [{ width: 1920, height: 1080, primary: true }],
      }),
      expect.objectContaining({ hostId: "rdp-1" }),
    );
  });
});

// 세션이 끝나는 길은 두 갈래다 — 사용자가 탭을 닫으면 disconnect IPC 가 오지만, 원격 로그오프나
// 서버가 끊은 경우는 코어의 closed 이벤트만 온다. 뒤쪽에서 정리하지 않으면 tailnet 포워드가 남아,
// 세션은 이미 없는데 그 loopback 포트에 붙는 아무 로컬 프로세스나 tailnet 호스트로 나갈 수 있다.
describe("registerRdpIpcHandlers session teardown", () => {
  /** 코어가 올린 세션 이벤트를 그대로 흘려보낸다. 등록은 registerRdpIpcHandlers 가 한다. */
  function emit(
    harness: ReturnType<typeof createHarness>,
    event: Record<string, unknown>,
  ) {
    (
      harness.rdpManager as unknown as {
        onSessionEvent: (event: Record<string, unknown>) => void;
      }
    ).onSessionEvent(event);
  }

  it("원격이 세션을 끝내면 tailnet 포워드를 닫는다", async () => {
    const harness = createHarness("AA:BB:CC", null, { tailnetId: "net-a" });
    await harness.connectAndVerify();

    emit(harness, { type: "closed", sessionId: "sess-1", graceful: true });

    expect(harness.ctx.coreManager.closeTailnetForward).toHaveBeenCalledWith(
      "sess-1",
    );
  });

  it("error 만으로는 닫지 않는다", async () => {
    // 코어는 error 뒤에 항상 closed 를 보낸다. 여기서도 닫으면 정리가 두 곳으로 갈린다.
    const harness = createHarness("AA:BB:CC", null, { tailnetId: "net-a" });
    await harness.connectAndVerify();

    emit(harness, { type: "closed", sessionId: "다른-세션" });
    emit(harness, { type: "error", sessionId: "sess-1", message: "boom" });

    expect(harness.ctx.coreManager.closeTailnetForward).not.toHaveBeenCalled();
  });

  it("disconnect 와 겹쳐도 포워드를 한 번만 닫는다", async () => {
    // 사용자가 탭을 닫는 순간 서버도 세션을 끊으면 두 경로가 같이 온다.
    const harness = createHarness("AA:BB:CC", null, { tailnetId: "net-a" });
    await harness.connectAndVerify();

    await handlers.get("rdp:disconnect")!({}, "sess-1");
    emit(harness, { type: "closed", sessionId: "sess-1" });

    expect(harness.ctx.coreManager.closeTailnetForward).toHaveBeenCalledTimes(1);
  });

  it("포워드를 쓰지 않은 세션은 코어를 부르지 않는다", async () => {
    const harness = createHarness("AA:BB:CC");
    await harness.connectAndVerify();

    emit(harness, { type: "closed", sessionId: "sess-1" });

    expect(harness.ctx.coreManager.closeTailnetForward).not.toHaveBeenCalled();
  });
});

// 펼침은 창 여러 개가 한 덩어리다. 보조 창 하나에서 빠져나왔는데 메인 창이 전체화면으로 남으면,
// 원격은 여전히 여러 모니터인데 보이는 화면은 하나뿐이라 되돌릴 곳이 없다.
describe("registerRdpIpcHandlers monitor spread", () => {
  function createSpreadHarness() {
    const mainWindow = {
      fullScreen: true,
      destroyed: false,
      setFullScreen: vi.fn(function (this: void, value: boolean) {
        mainWindow.fullScreen = value;
      }),
      isFullScreen: () => mainWindow.fullScreen,
      isDestroyed: () => mainWindow.destroyed,
      on: vi.fn(),
      removeListener: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 3008, height: 1692 }),
      getContentBounds: () => ({ x: 0, y: 0, width: 3008, height: 1692 }),
    };

    const host = {
      id: "rdp-1",
      kind: "rdp" as const,
      label: "Win Box",
      hostname: "10.0.0.1",
      port: 3389,
      username: "",
      secretRef: null,
      certificateFingerprint: "AA:BB:CC",
      useAllMonitors: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const monitors = [
      { width: 3008, height: 1692, left: 0, top: 0, primary: true },
      { width: 1920, height: 1080, left: 3008, top: 0, primary: false },
    ];

    const ctx = {
      coreManager: { openTailnetForward: vi.fn(), closeTailnetForward: vi.fn() },
      settings: { get: vi.fn(() => ({ rdpMonitorsByHostId: {} })) },
      hosts: {
        getById: vi.fn(() => host),
        updateRdpCertificateFingerprint: vi.fn(),
      },
      loadSecrets: vi.fn(async () => ({ password: "secret" })),
      activityLogs: { append: vi.fn() },
      queueSync: vi.fn(),
    };

    const rdpManager = {
      setCertificateVerifier: vi.fn(),
      connect: vi.fn(async () => ({ monitors })),
      describeSession: vi.fn(() => ({ monitors })),
      emitMonitorRegion: vi.fn(),
      declareMonitorLayout: vi.fn(),
      disconnect: vi.fn(),
      sendInput: vi.fn(),
      requestResize: vi.fn(),
    };

    monitorWindowsInstances.length = 0;
    registerRdpIpcHandlers(ctx as never, rdpManager as never, {
      askCertificate: vi.fn(async () => true),
    });
    const monitorWindows = monitorWindowsInstances.at(-1)!;

    return {
      mainWindow,
      rdpManager,
      monitorWindows,
      async spread() {
        // 접속이 원격 모니터 ↔ 물리 화면 대응을 기록한다. 그것이 없으면 펼치기가 빈손으로 끝난다.
        await handlers.get("rdp:connect")!({}, "sess-1", "rdp-1");
        sender.window = mainWindow;
        return handlers.get("rdp:spread-monitors")!({}, "sess-1");
      },
    };
  }

  it("보조 창에서 빠져나오면 메인 창의 전체화면도 끝낸다", async () => {
    const harness = createSpreadHarness();
    await harness.spread();

    harness.monitorWindows.onCollapseRequested?.("sess-1");

    expect(harness.mainWindow.setFullScreen).toHaveBeenCalledWith(false);
    // 남은 보조 창도 같이 닫고, 메인 창은 다시 전체 데스크톱을 그린다.
    expect(harness.monitorWindows.close).toHaveBeenCalledWith("sess-1");
    expect(harness.rdpManager.emitMonitorRegion).toHaveBeenLastCalledWith(
      "sess-1",
      null,
    );
  });

  it("메인 창이 이미 전체화면이 아니면 건드리지 않고 정리만 한다", async () => {
    // 이 경우 leave-full-screen 이 오지 않으므로, 그 이벤트만 믿으면 정리가 아예 안 된다.
    const harness = createSpreadHarness();
    await harness.spread();
    harness.mainWindow.fullScreen = false;
    harness.mainWindow.setFullScreen.mockClear();

    harness.monitorWindows.onCollapseRequested?.("sess-1");

    expect(harness.mainWindow.setFullScreen).not.toHaveBeenCalled();
    expect(harness.monitorWindows.close).toHaveBeenCalledWith("sess-1");
  });

  it("펼치지 않은 세션에 대한 요청은 무시한다", async () => {
    const harness = createSpreadHarness();

    harness.monitorWindows.onCollapseRequested?.("sess-없음");

    expect(harness.mainWindow.setFullScreen).not.toHaveBeenCalled();
  });
});
