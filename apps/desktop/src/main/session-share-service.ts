import { BrowserWindow } from "electron";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SESSION_SHARE_CHAT_HISTORY_LIMIT,
  type CoreEvent,
  type SessionShareChatEvent,
  type SessionShareOwnerChatSnapshot,
  type SessionShareControlSignal,
  type SessionShareEvent,
  type SessionShareInputToggleInput,
  type SessionShareChatMessage,
  type SessionShareOwnerMessage,
  type SessionShareSnapshotInput,
  type SessionShareStartInput,
  type SessionShareState,
} from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import { AuthService } from "./auth-service";
import { CoreManager } from "./core-manager";

const MAX_PENDING_OWNER_MESSAGES = 512;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CreateShareResponse {
  shareId: string;
  viewerUrl: string;
  ownerToken: string;
}

interface OwnerServerMessageViewerInput {
  type: "viewer-input";
  encoding: "utf8" | "binary";
  data: string;
}

interface OwnerServerMessageControlSignal {
  type: "control-signal";
  signal: SessionShareControlSignal;
}

interface OwnerServerMessageViewerCount {
  type: "viewer-count";
  viewerCount: number;
}

interface OwnerServerMessageInputEnabled {
  type: "input-enabled";
  inputEnabled: boolean;
}

interface OwnerServerMessageChatMessage {
  type: "chat-message";
  message: SessionShareChatMessage;
}

interface OwnerServerMessageShareEnded {
  type: "share-ended";
  message?: string;
}

type OwnerServerMessage =
  | OwnerServerMessageViewerInput
  | OwnerServerMessageControlSignal
  | OwnerServerMessageViewerCount
  | OwnerServerMessageInputEnabled
  | OwnerServerMessageChatMessage
  | OwnerServerMessageShareEnded;

interface ActiveSessionShare {
  sessionId: string;
  title: string;
  hostLabel: string;
  shareId: string;
  shareUrl: string;
  ownerToken: string;
  transport: SessionShareStartInput["transport"];
  inputEnabled: boolean;
  viewerCount: number;
  latestSnapshot: string;
  cols: number;
  rows: number;
  terminalAppearance: SessionShareStartInput["terminalAppearance"];
  viewportPx: SessionShareStartInput["viewportPx"];
  socket: WebSocket | null;
  ownerSocketOpen: boolean;
  closedByOwner: boolean;
  pendingMessages: string[];
  ownerChatMessages: SessionShareChatMessage[];
  isE2EFake: boolean;
  state: SessionShareState;
}

function isE2EFakeSessionShareEnabled(): boolean {
  return process.env.DOLSSH_E2E_FAKE_SESSION_SHARE === "1";
}

function toApiErrorMessage(response: Response, fallback: string): Promise<string> {
  return response
    .text()
    .then((text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return `${fallback} (${response.status})`;
      }

      try {
        const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          return parsed.error;
        }
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          return parsed.message;
        }
      } catch {
        // ignore JSON parse failure
      }

      return trimmed;
    })
    .catch(() => `${fallback} (${response.status})`);
}

function isLikelyAuthError(response: Response, message: string): boolean {
  if (response.status === 401 || response.status === 403) {
    return true;
  }

  return /token is expired|invalid claims|unauthorized|forbidden|jwt|로그인이 필요합니다|세션이 만료/i.test(
    message,
  );
}

function resolveWebSocketURL(baseUrl: string, pathname: string, params: Record<string, string>): string {
  const target = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function encodeOwnerMessage(message: SessionShareOwnerMessage): string {
  return JSON.stringify(message);
}

function createInactiveShareState(): SessionShareState {
  return {
    status: "inactive",
    shareUrl: null,
    inputEnabled: false,
    viewerCount: 0,
    errorMessage: null,
  };
}

function appendOwnerChatMessage(
  messages: SessionShareChatMessage[],
  message: SessionShareChatMessage,
): SessionShareChatMessage[] {
  const nextMessages = [...messages.filter((entry) => entry.id !== message.id), message];
  if (nextMessages.length <= SESSION_SHARE_CHAT_HISTORY_LIMIT) {
    return nextMessages;
  }

  return nextMessages.slice(-SESSION_SHARE_CHAT_HISTORY_LIMIT);
}

export class SessionShareService {
  private readonly windows = new Set<BrowserWindow>();
  private readonly shares = new Map<string, ActiveSessionShare>();
  private readonly ownerChatWindows = new Map<string, BrowserWindow>();

  constructor(
    private readonly authService: AuthService,
    private readonly coreManager: CoreManager,
  ) {}

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => {
      this.windows.delete(window);
    });
  }

  async shutdown(): Promise<void> {
    const sessionIds = Array.from(this.shares.keys());
    for (const sessionId of sessionIds) {
      await this.stop(sessionId).catch(() => undefined);
    }
  }

  async start(input: SessionShareStartInput): Promise<SessionShareState> {
    const existing = this.shares.get(input.sessionId);
    if (existing && (existing.state.status === "starting" || existing.state.status === "active")) {
      return existing.state;
    }
    if (existing) {
      await this.stop(input.sessionId).catch(() => undefined);
    }

    const provisional: ActiveSessionShare = {
      sessionId: input.sessionId,
      title: input.title,
      hostLabel: input.title,
      shareId: "",
      shareUrl: "",
      ownerToken: "",
      transport: input.transport,
      inputEnabled: false,
      viewerCount: 0,
      latestSnapshot: input.snapshot,
      cols: input.cols,
      rows: input.rows,
      terminalAppearance: input.terminalAppearance,
      viewportPx: input.viewportPx,
      socket: null,
      ownerSocketOpen: false,
      closedByOwner: false,
      pendingMessages: [],
      ownerChatMessages: [],
      isE2EFake: false,
      state: {
        status: "starting",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    };
    this.shares.set(input.sessionId, provisional);
    this.broadcastState(input.sessionId, provisional.state);

    try {
      if (isE2EFakeSessionShareEnabled()) {
        provisional.shareId = `e2e-share-${input.sessionId}`;
        provisional.shareUrl = `${this.authService.getServerUrl().replace(/\/$/, "")}/share/${provisional.shareId}/e2e-viewer-token-${input.sessionId}`;
        provisional.ownerToken = `e2e-owner-token-${input.sessionId}`;
        provisional.isE2EFake = true;
        provisional.state = {
          status: "active",
          shareUrl: provisional.shareUrl,
          inputEnabled: false,
          viewerCount: 0,
          errorMessage: null,
        };
        this.broadcastState(input.sessionId, provisional.state);
        return provisional.state;
      }

      const created = await this.createShare(input);
      provisional.shareId = created.shareId;
      provisional.shareUrl = created.viewerUrl;
      provisional.ownerToken = created.ownerToken;
      provisional.state = {
        status: "starting",
        shareUrl: created.viewerUrl,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      };
      this.broadcastState(input.sessionId, provisional.state);
      this.attachOwnerSocket(provisional);
      return provisional.state;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "세션 공유를 시작하지 못했습니다.";
      provisional.state = {
        status: "error",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: message,
      };
      this.broadcastState(input.sessionId, provisional.state);
      return provisional.state;
    }
  }

  async openOwnerChatWindow(
    sessionId: string,
    sourceWindow: BrowserWindow,
  ): Promise<void> {
    const share = this.shares.get(sessionId);
    if (!share || share.state.status !== "active") {
      return;
    }

    const existingWindow = this.ownerChatWindows.get(sessionId);
    if (existingWindow && !existingWindow.isDestroyed()) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
      return;
    }

    const chatWindow = new BrowserWindow({
      width: 400,
      height: 560,
      minWidth: 320,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#eef3f7",
      title: this.buildOwnerChatWindowTitle(share.title),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.ownerChatWindows.set(sessionId, chatWindow);
    this.registerWindow(chatWindow);
    chatWindow.on("closed", () => {
      if (this.ownerChatWindows.get(sessionId) === chatWindow) {
        this.ownerChatWindows.delete(sessionId);
      }
    });
    chatWindow.once("ready-to-show", () => {
      chatWindow.show();
      chatWindow.focus();
    });

    try {
      const targetUrl = this.buildOwnerChatWindowURL(sourceWindow, sessionId);
      await chatWindow.loadURL(targetUrl);
    } catch (error) {
      this.ownerChatWindows.delete(sessionId);
      if (!chatWindow.isDestroyed()) {
        chatWindow.close();
      }
      throw error;
    }

    if (!chatWindow.isVisible()) {
      chatWindow.show();
    }
    chatWindow.focus();
  }

  getOwnerChatSnapshot(sessionId: string): SessionShareOwnerChatSnapshot {
    const share = this.shares.get(sessionId);
    if (!share) {
      return {
        sessionId,
        title: "",
        state: createInactiveShareState(),
        messages: [],
      };
    }

    return {
      sessionId,
      title: share.title,
      state: { ...share.state },
      messages: [...share.ownerChatMessages],
    };
  }

  async updateSnapshot(input: SessionShareSnapshotInput): Promise<void> {
    const share = this.shares.get(input.sessionId);
    if (!share) {
      return;
    }

    share.latestSnapshot = input.snapshot;
    share.cols = input.cols;
    share.rows = input.rows;
    share.terminalAppearance = input.terminalAppearance;
    share.viewportPx = input.viewportPx;
    this.enqueueOrSend(share, {
      type: "snapshot",
      snapshot: input.snapshot,
      cols: input.cols,
      rows: input.rows,
      snapshotKind: input.kind,
      terminalAppearance: input.terminalAppearance,
      viewportPx: input.viewportPx,
    });
  }

  async setInputEnabled(
    input: SessionShareInputToggleInput,
  ): Promise<SessionShareState> {
    const share = this.shares.get(input.sessionId);
    if (!share || !share.shareId) {
      return createInactiveShareState();
    }

    if (!share.isE2EFake) {
      await this.fetchWithAuthRetry(
        new URL(`/api/session-shares/${share.shareId}/input`, this.authService.getServerUrl()),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputEnabled: input.inputEnabled,
          }),
        },
        "공유 입력 허용 상태를 저장하지 못했습니다.",
      );
    }

    share.inputEnabled = input.inputEnabled;
    share.state = {
      ...share.state,
      inputEnabled: input.inputEnabled,
      errorMessage: null,
    };
    this.broadcastState(input.sessionId, share.state);
    return share.state;
  }

  async stop(sessionId: string): Promise<void> {
    const share = this.shares.get(sessionId);
    if (!share) {
      this.broadcastState(sessionId, createInactiveShareState());
      return;
    }

    share.closedByOwner = true;
    this.shares.delete(sessionId);
    try {
      if (share.shareId && !share.isE2EFake) {
        await this.fetchWithAuthRetry(
          new URL(`/api/session-shares/${share.shareId}`, this.authService.getServerUrl()),
          {
            method: "DELETE",
          },
          "세션 공유를 종료하지 못했습니다.",
        );
      }
    } finally {
      share.socket?.close();
      this.broadcastState(sessionId, createInactiveShareState());
    }
  }

  handleTerminalEvent(event: CoreEvent<Record<string, unknown>>): void {
    if (!event.sessionId) {
      return;
    }

    const share = this.shares.get(event.sessionId);
    if (!share) {
      return;
    }

    if (event.type === "closed" || event.type === "error") {
      this.enqueueOrSend(share, { type: "session-ended" });
      void this.stop(event.sessionId).catch(() => undefined);
      return;
    }

    if (event.type === "connected") {
      share.state = {
        ...share.state,
        status: "active",
        shareUrl: share.shareUrl,
        inputEnabled: share.inputEnabled,
        viewerCount: share.viewerCount,
        errorMessage: null,
      };
      this.broadcastState(event.sessionId, share.state);
      return;
    }
  }

  handleTerminalStream(sessionId: string, chunk: Uint8Array): void {
    const share = this.shares.get(sessionId);
    if (!share || chunk.byteLength === 0) {
      return;
    }

    this.enqueueOrSend(share, {
      type: "output",
      data: Buffer.from(chunk).toString("base64"),
    });
  }

  private async createShare(
    input: SessionShareStartInput,
  ): Promise<CreateShareResponse> {
    const response = await this.fetchWithAuthRetry(
      new URL("/api/session-shares", this.authService.getServerUrl()),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          title: input.title,
          hostLabel: input.title,
          transport: input.transport,
          cols: input.cols,
          rows: input.rows,
          snapshot: input.snapshot,
          terminalAppearance: input.terminalAppearance,
          viewportPx: input.viewportPx,
        }),
      },
      "세션 공유 링크를 만들지 못했습니다.",
    );

    return (await response.json()) as CreateShareResponse;
  }

  private async fetchWithAuthRetry(
    url: URL,
    init: RequestInit,
    fallback: string,
  ): Promise<Response> {
    let response = await fetch(url, this.withAccessToken(init, this.authService.getAccessToken()));
    if (response.ok) {
      return response;
    }

    const firstFailureMessage = await toApiErrorMessage(response, fallback);
    if (!isLikelyAuthError(response, firstFailureMessage)) {
      throw new Error(firstFailureMessage);
    }

    const refreshed = await this.authService.refreshSession();
    if (refreshed.status !== "authenticated") {
      throw new Error(firstFailureMessage || "로그인이 필요합니다.");
    }

    response = await fetch(url, this.withAccessToken(init, this.authService.getAccessToken()));
    if (!response.ok) {
      throw new Error(await toApiErrorMessage(response, fallback));
    }
    return response;
  }

  private withAccessToken(init: RequestInit | undefined, accessToken: string): RequestInit {
    const headers = new Headers(init?.headers ?? {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    return {
      ...init,
      headers,
    };
  }

  private attachOwnerSocket(share: ActiveSessionShare): void {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== "function") {
      throw new Error("WebSocket is not available in the desktop main process.");
    }

    const socket = new WebSocketCtor(
      resolveWebSocketURL(this.authService.getServerUrl(), `/api/session-shares/${share.shareId}/owner/ws`, {
        token: share.ownerToken,
      }),
    );
    share.socket = socket;

    socket.addEventListener("open", () => {
      const current = this.shares.get(share.sessionId);
      if (!current || current !== share) {
        socket.close();
        return;
      }

      share.ownerSocketOpen = true;
      share.state = {
        status: "active",
        shareUrl: share.shareUrl,
        inputEnabled: share.inputEnabled,
        viewerCount: share.viewerCount,
        errorMessage: null,
      };
      this.broadcastState(share.sessionId, share.state);
      this.sendOwnerMessage(share, {
        type: "hello",
        title: share.title,
        hostLabel: share.hostLabel,
        transport: share.transport,
        cols: share.cols,
        rows: share.rows,
        snapshot: share.latestSnapshot,
        terminalAppearance: share.terminalAppearance,
        viewportPx: share.viewportPx,
      });

      while (share.pendingMessages.length > 0) {
        const message = share.pendingMessages.shift();
        if (message) {
          socket.send(message);
        }
      }
    });

    socket.addEventListener("message", (event) => {
      const current = this.shares.get(share.sessionId);
      if (!current || current !== share) {
        return;
      }

      try {
        const payload = JSON.parse(String(event.data)) as OwnerServerMessage;
        this.handleOwnerServerMessage(share, payload);
      } catch (error) {
        share.state = {
          ...share.state,
          status: "error",
          errorMessage:
            error instanceof Error
              ? error.message
              : "세션 공유 메시지를 처리하지 못했습니다.",
        };
        this.broadcastState(share.sessionId, share.state);
      }
    });

    socket.addEventListener("close", () => {
      if (share.closedByOwner) {
        return;
      }
      if (!this.shares.has(share.sessionId)) {
        return;
      }
      share.state = {
        ...share.state,
        status: "error",
        errorMessage: "세션 공유 연결이 종료되었습니다.",
      };
      this.broadcastState(share.sessionId, share.state);
    });

    socket.addEventListener("error", () => {
      if (!this.shares.has(share.sessionId)) {
        return;
      }
      share.state = {
        ...share.state,
        status: "error",
        errorMessage: "세션 공유 연결을 열지 못했습니다.",
      };
      this.broadcastState(share.sessionId, share.state);
    });
  }

  private handleOwnerServerMessage(
    share: ActiveSessionShare,
    message: OwnerServerMessage,
  ): void {
    if (message.type === "viewer-count") {
      share.viewerCount = Math.max(0, Number(message.viewerCount ?? 0));
      share.state = {
        ...share.state,
        viewerCount: share.viewerCount,
      };
      this.broadcastState(share.sessionId, share.state);
      return;
    }

    if (message.type === "input-enabled") {
      share.inputEnabled = Boolean(message.inputEnabled);
      share.state = {
        ...share.state,
        inputEnabled: share.inputEnabled,
      };
      this.broadcastState(share.sessionId, share.state);
      return;
    }

    if (message.type === "share-ended") {
      share.state = {
        ...share.state,
        status: "error",
        errorMessage: message.message ?? "세션 공유가 종료되었습니다.",
      };
      this.broadcastState(share.sessionId, share.state);
      this.shares.delete(share.sessionId);
      share.closedByOwner = true;
      share.socket?.close();
      return;
    }

    if (message.type === "chat-message") {
      share.ownerChatMessages = appendOwnerChatMessage(
        share.ownerChatMessages,
        message.message,
      );
      this.broadcastChatEvent(share.sessionId, message.message);
      return;
    }

    if (message.type === "control-signal") {
      if (!share.inputEnabled || share.transport !== "aws-ssm") {
        return;
      }

      try {
        this.coreManager.sendControlSignal(share.sessionId, message.signal);
      } catch {
        // viewer control signals should never crash the relay loop
      }
      return;
    }

    if (message.type !== "viewer-input") {
      return;
    }

    if (!share.inputEnabled) {
      return;
    }

    let payload: Uint8Array;
    if (message.encoding === "binary") {
      try {
        payload = Uint8Array.from(Buffer.from(message.data, "base64"));
      } catch {
        return;
      }
    } else {
      payload = Uint8Array.from(Buffer.from(message.data, "utf8"));
    }

    try {
      this.coreManager.writeBinary(share.sessionId, payload);
    } catch {
      // viewer input should never crash the relay loop
    }
  }

  private enqueueOrSend(
    share: ActiveSessionShare,
    message: SessionShareOwnerMessage,
  ): void {
    const encoded = encodeOwnerMessage(message);
    if (share.ownerSocketOpen && share.socket?.readyState === WebSocket.OPEN) {
      this.sendOwnerMessage(share, message);
      return;
    }

    share.pendingMessages.push(encoded);
    while (share.pendingMessages.length > MAX_PENDING_OWNER_MESSAGES) {
      share.pendingMessages.shift();
    }
  }

  private sendOwnerMessage(
    share: ActiveSessionShare,
    message: SessionShareOwnerMessage,
  ): void {
    if (!share.socket || share.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    share.socket.send(encodeOwnerMessage(message));
  }

  private broadcastState(sessionId: string, state: SessionShareState): void {
    const event: SessionShareEvent = {
      sessionId,
      state,
    };
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.sessionShares.event, event);
      }
    }

    if (state.status !== "active") {
      const share = this.shares.get(sessionId);
      if (share) {
        share.ownerChatMessages = [];
      }
      this.closeOwnerChatWindow(sessionId);
    }
  }

  private broadcastChatEvent(
    sessionId: string,
    message: SessionShareChatMessage,
  ): void {
    const event: SessionShareChatEvent = {
      sessionId,
      message,
    };
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.sessionShares.chatEvent, event);
      }
    }
  }

  private closeOwnerChatWindow(sessionId: string): void {
    const chatWindow = this.ownerChatWindows.get(sessionId);
    if (!chatWindow || chatWindow.isDestroyed()) {
      this.ownerChatWindows.delete(sessionId);
      return;
    }

    this.ownerChatWindows.delete(sessionId);
    chatWindow.close();
  }

  private buildOwnerChatWindowTitle(title: string): string {
    const normalized = title.trim();
    return normalized ? `채팅 기록 · ${normalized}` : "채팅 기록";
  }

  private buildOwnerChatWindowURL(
    sourceWindow: BrowserWindow,
    sessionId: string,
  ): string {
    const sourceUrl = sourceWindow.webContents.getURL();
    if (!sourceUrl) {
      throw new Error("채팅 기록 창을 열 기준 URL을 찾지 못했습니다.");
    }

    const targetUrl = new URL(sourceUrl);
    targetUrl.searchParams.set("window", "session-share-chat");
    targetUrl.searchParams.set("sessionId", sessionId);
    return targetUrl.toString();
  }
}
