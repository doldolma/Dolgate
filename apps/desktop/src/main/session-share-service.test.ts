import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { browserWindowInstances } = vi.hoisted(() => ({
  browserWindowInstances: [] as any[],
}));

vi.mock("electron", () => {
  class MockBrowserWindow {
    static fromWebContents = vi.fn();

    readonly options: Record<string, unknown>;
    readonly loadURL = vi.fn(async (url: string) => {
      this.loadedURL = url;
    });
    readonly focus = vi.fn();
    readonly show = vi.fn(() => {
      this.visible = true;
    });
    readonly close = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
    readonly restore = vi.fn(() => {
      this.minimized = false;
    });
    readonly isDestroyed = vi.fn(() => this.destroyed);
    readonly isMinimized = vi.fn(() => this.minimized);
    readonly isVisible = vi.fn(() => this.visible);
    readonly webContents = {
      send: vi.fn(),
      getURL: vi.fn(() => this.loadedURL),
    };

    loadedURL = "https://app.example.com/";
    minimized = false;
    visible = false;
    destroyed = false;
    private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      browserWindowInstances.push(this);
    }

    on(eventName: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(eventName) ?? [];
      listeners.push(listener);
      this.listeners.set(eventName, listeners);
      return this;
    }

    once(eventName: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        this.removeListener(eventName, wrapped);
        listener(...args);
      };
      return this.on(eventName, wrapped);
    }

    removeListener(eventName: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(eventName) ?? [];
      this.listeners.set(
        eventName,
        listeners.filter((candidate) => candidate !== listener),
      );
      return this;
    }

    emit(eventName: string, ...args: any[]) {
      const listeners = this.listeners.get(eventName) ?? [];
      for (const listener of listeners) {
        listener(...args);
      }
      return listeners.length > 0;
    }
  }

  return {
    BrowserWindow: MockBrowserWindow,
  };
});

import {
  SESSION_SHARE_CHAT_HISTORY_LIMIT,
  type SessionShareChatMessage,
} from "@shared";
import { SessionShareService } from "./session-share-service";

const terminalAppearance = {
  fontFamily: "sf-mono",
  fontSize: 13,
  lineHeight: 1,
  letterSpacing: 0,
};

function createShare(): any {
  return {
    sessionId: "session-1",
    title: "Host Session",
    hostLabel: "Host Session",
    shareId: "",
    shareUrl: "https://sync.example.com/share/share-1/token-1",
    ownerToken: "owner-token-1",
    transport: "aws-ssm" as const,
    inputEnabled: true,
    viewerCount: 0,
    latestSnapshot: "",
    cols: 80,
    rows: 24,
    terminalAppearance: null,
    viewportPx: null,
    socket: null,
    ownerSocketOpen: false,
    closedByOwner: false,
    pendingMessages: [],
    ownerChatMessages: [] as SessionShareChatMessage[],
    state: {
      status: "active",
      shareUrl: "https://sync.example.com/share/share-1/token-1",
      inputEnabled: true,
      viewerCount: 0,
      errorMessage: null,
    },
  };
}

function createServiceHarness() {
  const authService = {
    getServerUrl: vi.fn(() => "https://sync.example.com"),
    getAccessToken: vi.fn(() => "access-token"),
    refreshSession: vi.fn().mockResolvedValue({
      status: "authenticated",
    }),
  };
  const coreManager = {
    write: vi.fn(),
    writeBinary: vi.fn(),
    sendControlSignal: vi.fn(),
  };

  const service = new SessionShareService(
    authService as never,
    coreManager as never,
  );
  const share = createShare();
  (service as any).shares.set(share.sessionId, share);

  return { service, authService, coreManager, share };
}

describe("SessionShareService viewer input relay", () => {
  const originalFakeShareEnv = process.env.DOLSSH_E2E_FAKE_SESSION_SHARE;

  beforeEach(() => {
    vi.clearAllMocks();
    browserWindowInstances.length = 0;
    delete process.env.DOLSSH_E2E_FAKE_SESSION_SHARE;
  });

  afterEach(() => {
    if (originalFakeShareEnv == null) {
      delete process.env.DOLSSH_E2E_FAKE_SESSION_SHARE;
      return;
    }
    process.env.DOLSSH_E2E_FAKE_SESSION_SHARE = originalFakeShareEnv;
  });

  it("relays binary viewer input through writeBinary", () => {
    const { service, coreManager, share } = createServiceHarness();

    (service as any).handleOwnerServerMessage(share, {
      type: "viewer-input",
      encoding: "binary",
      data: Buffer.from([0x1b, 0x5b, 0x41]).toString("base64"),
    });

    expect(coreManager.writeBinary).toHaveBeenCalledTimes(1);
    expect(coreManager.write).not.toHaveBeenCalled();
    const [, payload] = coreManager.writeBinary.mock.calls[0];
    expect(Array.from(payload as Uint8Array)).toEqual([0x1b, 0x5b, 0x41]);
  });

  it("relays utf8 viewer input through writeBinary as utf8 bytes", () => {
    const { service, coreManager, share } = createServiceHarness();

    (service as any).handleOwnerServerMessage(share, {
      type: "viewer-input",
      encoding: "utf8",
      data: "한a",
    });

    expect(coreManager.writeBinary).toHaveBeenCalledTimes(1);
    expect(coreManager.write).not.toHaveBeenCalled();
    const [, payload] = coreManager.writeBinary.mock.calls[0];
    expect(Buffer.from(payload as Uint8Array).toString("utf8")).toBe("한a");
  });

  it("ignores viewer input when session share input is disabled", () => {
    const { service, coreManager, share } = createServiceHarness();
    share.inputEnabled = false;

    (service as any).handleOwnerServerMessage(share, {
      type: "viewer-input",
      encoding: "binary",
      data: Buffer.from("a").toString("base64"),
    });

    expect(coreManager.writeBinary).not.toHaveBeenCalled();
    expect(coreManager.write).not.toHaveBeenCalled();
  });

  it("routes AWS control signals through sendControlSignal without writing bytes", () => {
    const { service, coreManager, share } = createServiceHarness();

    (service as any).handleOwnerServerMessage(share, {
      type: "control-signal",
      signal: "interrupt",
    });

    expect(coreManager.sendControlSignal).toHaveBeenCalledTimes(1);
    expect(coreManager.sendControlSignal).toHaveBeenCalledWith(
      "session-1",
      "interrupt",
    );
    expect(coreManager.writeBinary).not.toHaveBeenCalled();
    expect(coreManager.write).not.toHaveBeenCalled();
  });

  it("ignores control signals when session share input is disabled", () => {
    const { service, coreManager, share } = createServiceHarness();
    share.inputEnabled = false;

    (service as any).handleOwnerServerMessage(share, {
      type: "control-signal",
      signal: "interrupt",
    });

    expect(coreManager.sendControlSignal).not.toHaveBeenCalled();
    expect(coreManager.writeBinary).not.toHaveBeenCalled();
  });

  it("broadcasts owner chat messages to renderer windows and stores them in history", () => {
    const { service, share } = createServiceHarness();
    const send = vi.fn();
    (service as any).windows.add({
      isDestroyed: () => false,
      webContents: { send },
    });

    (service as any).handleOwnerServerMessage(share, {
      type: "chat-message",
      message: {
        id: "chat-1",
        nickname: "맑은 여우",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(send).toHaveBeenCalledWith("session-shares:chat-event", {
      sessionId: "session-1",
      message: {
        id: "chat-1",
        nickname: "맑은 여우",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });
    expect(service.getOwnerChatSnapshot("session-1").messages).toEqual([
      {
        id: "chat-1",
        nickname: "맑은 여우",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    ]);
  });

  it("caps owner chat history to the latest 50 messages", () => {
    const { service, share } = createServiceHarness();

    for (let index = 0; index < SESSION_SHARE_CHAT_HISTORY_LIMIT + 5; index += 1) {
      (service as any).handleOwnerServerMessage(share, {
        type: "chat-message",
        message: {
          id: `chat-${index + 1}`,
          nickname: "맑은 여우",
          text: `메시지 ${index + 1}`,
          sentAt: `2026-03-27T00:${String(index).padStart(2, "0")}:00.000Z`,
        },
      });
    }

    const snapshot = service.getOwnerChatSnapshot("session-1");
    expect(snapshot.messages).toHaveLength(SESSION_SHARE_CHAT_HISTORY_LIMIT);
    expect(snapshot.messages[0]?.id).toBe("chat-6");
    expect(snapshot.messages.at(-1)?.id).toBe("chat-55");
  });

  it("reuses the same owner chat window for the same session", async () => {
    const { service } = createServiceHarness();
    const sourceWindow = {
      webContents: {
        getURL: () => "https://app.example.com/index.html",
      },
    };

    await service.openOwnerChatWindow("session-1", sourceWindow as never);

    expect(browserWindowInstances).toHaveLength(1);
    expect(browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
      "https://app.example.com/index.html?window=session-share-chat&sessionId=session-1",
    );

    browserWindowInstances[0]!.minimized = true;
    await service.openOwnerChatWindow("session-1", sourceWindow as never);

    expect(browserWindowInstances).toHaveLength(1);
    expect(browserWindowInstances[0]?.restore).toHaveBeenCalledTimes(1);
    expect(browserWindowInstances[0]?.focus).toHaveBeenCalledTimes(2);
  });

  it("does not open an owner chat window for inactive shares", async () => {
    const { service, share } = createServiceHarness();
    share.state.status = "inactive";

    await service.openOwnerChatWindow("session-1", {
      webContents: {
        getURL: () => "https://app.example.com/index.html",
      },
    } as never);

    expect(browserWindowInstances).toHaveLength(0);
  });

  it("starts an active fake share in E2E mode without hitting the network", async () => {
    process.env.DOLSSH_E2E_FAKE_SESSION_SHARE = "1";
    const authService = {
      getServerUrl: vi.fn(() => "https://sync.example.com"),
      getAccessToken: vi.fn(() => "access-token"),
      refreshSession: vi.fn(),
    };
    const coreManager = {
      write: vi.fn(),
      writeBinary: vi.fn(),
      sendControlSignal: vi.fn(),
    };
    const service = new SessionShareService(
      authService as never,
      coreManager as never,
    );

    const state = await service.start({
      sessionId: "session-1",
      title: "Host Session",
      transport: "ssh",
      cols: 80,
      rows: 24,
      snapshot: "",
      terminalAppearance,
      viewportPx: null,
    });

    expect(state).toEqual({
      status: "active",
      shareUrl:
        "https://sync.example.com/share/e2e-share-session-1/e2e-viewer-token-session-1",
      inputEnabled: false,
      viewerCount: 0,
      errorMessage: null,
    });
    expect(service.getOwnerChatSnapshot("session-1").state).toEqual(state);
  });

  it("updates fake share input mode locally in E2E mode", async () => {
    process.env.DOLSSH_E2E_FAKE_SESSION_SHARE = "1";
    const authService = {
      getServerUrl: vi.fn(() => "https://sync.example.com"),
      getAccessToken: vi.fn(() => "access-token"),
      refreshSession: vi.fn(),
    };
    const coreManager = {
      write: vi.fn(),
      writeBinary: vi.fn(),
      sendControlSignal: vi.fn(),
    };
    const service = new SessionShareService(
      authService as never,
      coreManager as never,
    );

    await service.start({
      sessionId: "session-1",
      title: "Host Session",
      transport: "ssh",
      cols: 80,
      rows: 24,
      snapshot: "",
      terminalAppearance,
      viewportPx: null,
    });

    const state = await service.setInputEnabled({
      sessionId: "session-1",
      inputEnabled: true,
    });

    expect(state.inputEnabled).toBe(true);
    expect(service.getOwnerChatSnapshot("session-1").state.inputEnabled).toBe(
      true,
    );
  });

  it("clears owner history and closes the detached window when the share stops", async () => {
    const { service, share } = createServiceHarness();
    share.ownerChatMessages = [
      {
        id: "chat-1",
        nickname: "맑은 다람쥐",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    ];

    await service.openOwnerChatWindow("session-1", {
      webContents: {
        getURL: () => "https://app.example.com/index.html",
      },
    } as never);

    const chatWindow = browserWindowInstances[0]!;
    await service.stop("session-1");

    expect(chatWindow.close).toHaveBeenCalledTimes(1);
    expect(service.getOwnerChatSnapshot("session-1")).toEqual({
      sessionId: "session-1",
      title: "",
      state: {
        status: "inactive",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
      messages: [],
    });
  });

  it("clears owner history and closes the detached window when the server ends the share", async () => {
    const { service, share } = createServiceHarness();
    share.ownerChatMessages = [
      {
        id: "chat-1",
        nickname: "맑은 다람쥐",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    ];

    await service.openOwnerChatWindow("session-1", {
      webContents: {
        getURL: () => "https://app.example.com/index.html",
      },
    } as never);

    const chatWindow = browserWindowInstances[0]!;
    (service as any).handleOwnerServerMessage(share, {
      type: "share-ended",
      message: "세션 공유가 종료되었습니다.",
    });

    expect(chatWindow.close).toHaveBeenCalledTimes(1);
    expect(service.getOwnerChatSnapshot("session-1").messages).toEqual([]);
  });
});
