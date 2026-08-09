import { describe, expect, it, vi } from "vitest";
import type { RdpCertificateInfo } from "@shared";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, (...args: unknown[]) => unknown>();

const displays = [
  { id: 1, label: "Built-in", bounds: { x: 0, y: 0, width: 3008, height: 1692 } },
  { id: 2, label: "LG", bounds: { x: 3008, y: 0, width: 1920, height: 1080 } },
];

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
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
  monitors: Array<{ id: number; label: string; width: number; height: number }> | null = null,
) {
  const host = {
    monitors,
    id: "rdp-1",
    kind: "rdp" as const,
    label: "Win Box",
    hostname: "10.0.0.1",
    port: 3389,
    username: "user",
    domain: null,
    secretRef: "secret:1",
    desktopWidth: 1920,
    desktopHeight: 1080,
    certificateFingerprint: fingerprint,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const ctx = {
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
      desktopWidth: 1920,
      desktopHeight: 1080,
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
  it("uses the app resolution when a single monitor is chosen", async () => {
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
    );
  });
});
