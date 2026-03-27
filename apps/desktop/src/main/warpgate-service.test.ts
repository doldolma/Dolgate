import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../common/ipc-channels";

type FakeSession = {
  fetch: ReturnType<typeof vi.fn>;
  clearStorageData: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
};

const {
  browserWindowInstances,
  sessionPlans,
  sessionByPartition,
  FakeBrowserWindow,
} = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const browserWindowInstances: any[] = [];
  const sessionPlans: Array<Array<Response | Error>> = [];
  const sessionByPartition = new Map<string, FakeSession>();

  class FakeBrowserWindow extends EventEmitter {
    readonly webContents: { send: ReturnType<typeof vi.fn>; session: FakeSession };
    readonly options: Record<string, unknown>;
    readonly loadURL: ReturnType<typeof vi.fn>;
    readonly show: ReturnType<typeof vi.fn>;
    readonly focus: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    readonly isDestroyed: ReturnType<typeof vi.fn>;
    destroyed = false;

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      const partition = (options.webPreferences as { partition?: string } | undefined)
        ?.partition;
      this.webContents = {
        send: vi.fn(),
        session:
          sessionByPartition.get(partition ?? "") ??
          ({
            fetch: vi.fn(),
            clearStorageData: vi.fn().mockResolvedValue(undefined),
            clearCache: vi.fn().mockResolvedValue(undefined),
          } as FakeSession),
      };
      this.loadURL = vi.fn(async (_url: string) => {
        this.emit("ready-to-show");
      });
      this.show = vi.fn();
      this.focus = vi.fn();
      this.close = vi.fn(() => {
        if (this.destroyed) {
          return;
        }
        this.destroyed = true;
        this.emit("closed");
      });
      this.isDestroyed = vi.fn(() => this.destroyed);
      browserWindowInstances.push(this);
    }
  }

  return {
    browserWindowInstances,
    sessionPlans,
    sessionByPartition,
    FakeBrowserWindow,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: FakeBrowserWindow,
  session: {
    fromPartition: vi.fn((partition: string) => {
      const existing = sessionByPartition.get(partition);
      if (existing) {
        return existing;
      }
      const plan = sessionPlans.shift() ?? [];
      const queue = [...plan];
      const fakeSession: FakeSession = {
        fetch: vi.fn(async () => {
          const next = queue.shift();
          if (next instanceof Error) {
            throw next;
          }
          return next ?? new Response("", { status: 401 });
        }),
        clearStorageData: vi.fn().mockResolvedValue(undefined),
        clearCache: vi.fn().mockResolvedValue(undefined),
      };
      sessionByPartition.set(partition, fakeSession);
      return fakeSession;
    }),
  },
}));

import { WarpgateService } from "./warpgate-service";

function createRegisteredWindow() {
  const emitter = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    webContents: { send: ReturnType<typeof vi.fn> };
    isDestroyed: ReturnType<typeof vi.fn>;
  };
  emitter.destroyed = false;
  emitter.webContents = { send: vi.fn() };
  emitter.isDestroyed = vi.fn(() => emitter.destroyed);
  return emitter;
}

function contentResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("WarpgateService browser import", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    browserWindowInstances.length = 0;
    sessionPlans.length = 0;
    sessionByPartition.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a modal auth window, polls until login completes, and broadcasts targets", async () => {
    sessionPlans.push([
      new Response("", { status: 401 }),
      new Response("", { status: 404 }),
      contentResponse([
        {
          name: "prod-db",
          kind: "Ssh",
          group: { id: "group-1" },
        },
      ]),
      contentResponse({
        username: "alice",
        external_host: "ssh.warpgate.example.com",
        ports: { ssh: 2222 },
      }),
    ]);

    const service = new WarpgateService({} as never);
    const rendererWindow = createRegisteredWindow();
    const parentWindow = createRegisteredWindow();
    service.registerWindow(rendererWindow as never);

    const { attemptId } = await service.startBrowserImport(
      "https://warpgate.example.com",
      parentWindow as never,
    );

    const authWindow = browserWindowInstances[0] as InstanceType<
      typeof FakeBrowserWindow
    >;
    expect(authWindow).toBeTruthy();
    expect(authWindow.options.parent).toBe(parentWindow);
    expect(authWindow.options.modal).toBe(true);
    expect(
      (authWindow.options.webPreferences as { partition: string }).partition,
    ).toBe(`warpgate-import:${attemptId}`);
    expect(
      (authWindow.options.webPreferences as { sandbox: boolean }).sandbox,
    ).toBe(true);

    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const partition = (
      authWindow.options.webPreferences as { partition: string }
    ).partition;
    const authSession = sessionByPartition.get(partition)!;
    expect(authSession.clearStorageData).toHaveBeenCalledTimes(1);
    expect(authSession.clearCache).toHaveBeenCalledTimes(1);

    const payloads = rendererWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === ipcChannels.warpgate.event)
      .map(([, payload]) => payload);

    expect(payloads).toEqual([
      {
        attemptId,
        status: "opening-browser",
        errorMessage: null,
      },
      {
        attemptId,
        status: "waiting-for-login",
        errorMessage: null,
      },
      {
        attemptId,
        status: "loading-targets",
        errorMessage: null,
      },
      {
        attemptId,
        status: "completed",
        connectionInfo: {
          baseUrl: "https://warpgate.example.com",
          sshHost: "ssh.warpgate.example.com",
          sshPort: 2222,
          username: "alice",
        },
        targets: [
          {
            id: "group-1:prod-db",
            kind: "ssh",
            name: "prod-db",
          },
        ],
        errorMessage: null,
      },
    ]);
  });

  it("broadcasts cancelled and clears session storage when the auth window is closed", async () => {
    sessionPlans.push([new Response("", { status: 401 })]);

    const service = new WarpgateService({} as never);
    const rendererWindow = createRegisteredWindow();
    service.registerWindow(rendererWindow as never);

    const { attemptId } = await service.startBrowserImport(
      "https://warpgate.example.com",
      null,
    );

    const authWindow = browserWindowInstances[0] as InstanceType<
      typeof FakeBrowserWindow
    >;
    const partition = (
      authWindow.options.webPreferences as { partition: string }
    ).partition;
    const authSession = sessionByPartition.get(partition)!;

    await Promise.resolve();
    authWindow.close();
    await Promise.resolve();

    const payloads = rendererWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === ipcChannels.warpgate.event)
      .map(([, payload]) => payload);

    expect(payloads.at(-1)).toEqual({
      attemptId,
      status: "cancelled",
      errorMessage: "Warpgate 로그인 창이 닫혔습니다.",
    });
    expect(authSession.clearStorageData).toHaveBeenCalledTimes(1);
  });

  it("broadcasts errors and cleans up when the Warpgate API returns a failure", async () => {
    sessionPlans.push([new Response("nope", { status: 500 })]);

    const service = new WarpgateService({} as never);
    const rendererWindow = createRegisteredWindow();
    service.registerWindow(rendererWindow as never);

    const { attemptId } = await service.startBrowserImport(
      "https://warpgate.example.com",
      null,
    );

    const authWindow = browserWindowInstances[0] as InstanceType<
      typeof FakeBrowserWindow
    >;
    const partition = (
      authWindow.options.webPreferences as { partition: string }
    ).partition;
    const authSession = sessionByPartition.get(partition)!;

    await vi.waitFor(() => {
      const payloads = rendererWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === ipcChannels.warpgate.event)
        .map(([, payload]) => payload);

      expect(payloads.at(-1)).toEqual({
        attemptId,
        status: "error",
        errorMessage: "nope",
      });
    });
    expect(authSession.clearStorageData).toHaveBeenCalledTimes(1);
  });
});
