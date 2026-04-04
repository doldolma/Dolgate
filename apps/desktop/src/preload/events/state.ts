import type {
  AuthState,
  ContainerConnectionProgressEvent,
  CoreEvent,
  DesktopWindowState,
  PortForwardRuntimeEvent,
  SessionShareChatEvent,
  SessionShareEvent,
  SftpConnectionProgressEvent,
  TransferJobEvent,
  UpdateEvent,
  WarpgateImportEvent,
} from "@shared";

type Listener<T> = (payload: T) => void;

function createListenerHub<T>() {
  const listeners = new Set<Listener<T>>();

  return {
    emit(payload: T): void {
      for (const listener of listeners) {
        listener(payload);
      }
    },
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const coreEventHub = createListenerHub<CoreEvent>();
const transferEventHub = createListenerHub<TransferJobEvent>();
const sftpConnectionProgressHub =
  createListenerHub<SftpConnectionProgressEvent>();
const containerConnectionProgressHub =
  createListenerHub<ContainerConnectionProgressEvent>();
const portForwardEventHub = createListenerHub<PortForwardRuntimeEvent>();
const updateEventHub = createListenerHub<UpdateEvent>();
const authEventHub = createListenerHub<AuthState>();
const windowStateHub = createListenerHub<DesktopWindowState>();
const warpgateImportEventHub = createListenerHub<WarpgateImportEvent>();
const sessionShareEventHub = createListenerHub<SessionShareEvent>();
const sessionShareChatEventHub = createListenerHub<SessionShareChatEvent>();

const streamListeners = new Map<string, Set<(chunk: Uint8Array) => void>>();
const sessionBacklog = new Map<string, Uint8Array[]>();
const backlogBytes = new Map<string, number>();
const e2eTerminalCaptureEnabled =
  process.env.DOLSSH_E2E_CAPTURE_TERMINAL === "1";
const e2eTerminalDecoder = new TextDecoder();
const e2eTerminalOutputBySession = new Map<string, string>();
const e2eTerminalStateBySession = new Map<string, Record<string, unknown>>();
let e2eReplayState: Record<string, unknown> | null = null;

const MAX_SESSION_BACKLOG_BYTES = 1024 * 1024;

function cloneChunk(chunk: Uint8Array): Uint8Array {
  return new Uint8Array(chunk);
}

function appendBacklog(sessionId: string, chunk: Uint8Array): void {
  const queue = sessionBacklog.get(sessionId) ?? [];
  queue.push(cloneChunk(chunk));
  sessionBacklog.set(sessionId, queue);

  const nextBytes = (backlogBytes.get(sessionId) ?? 0) + chunk.byteLength;
  backlogBytes.set(sessionId, nextBytes);

  let currentBytes = backlogBytes.get(sessionId) ?? 0;
  while (currentBytes > MAX_SESSION_BACKLOG_BYTES && queue.length > 1) {
    const removed = queue.shift();
    if (!removed) {
      break;
    }
    currentBytes -= removed.byteLength;
  }
  backlogBytes.set(sessionId, currentBytes);
}

function clearSessionRuntimeState(sessionId: string): void {
  sessionBacklog.delete(sessionId);
  backlogBytes.delete(sessionId);
  e2eTerminalStateBySession.delete(sessionId);
}

export function emitCoreEvent(payload: CoreEvent): void {
  if (payload.type === "closed" && payload.sessionId) {
    clearSessionRuntimeState(payload.sessionId);
  }
  coreEventHub.emit(payload);
}

export function emitSshData(payload: {
  sessionId: string;
  chunk: Uint8Array;
}): void {
  appendBacklog(payload.sessionId, payload.chunk);
  if (e2eTerminalCaptureEnabled) {
    const current = e2eTerminalOutputBySession.get(payload.sessionId) ?? "";
    e2eTerminalOutputBySession.set(
      payload.sessionId,
      current + e2eTerminalDecoder.decode(payload.chunk, { stream: true }),
    );
  }

  const listeners = streamListeners.get(payload.sessionId);
  if (!listeners || listeners.size === 0) {
    return;
  }

  for (const listener of listeners) {
    listener(payload.chunk);
  }
}

export function subscribeCoreEvent(listener: Listener<CoreEvent>): () => void {
  return coreEventHub.subscribe(listener);
}

export function subscribeSshData(
  sessionId: string,
  listener: (chunk: Uint8Array) => void,
): () => void {
  const listeners =
    streamListeners.get(sessionId) ?? new Set<(chunk: Uint8Array) => void>();
  listeners.add(listener);
  streamListeners.set(sessionId, listeners);

  const queued = sessionBacklog.get(sessionId) ?? [];
  for (const chunk of queued) {
    listener(chunk);
  }

  return () => {
    const currentListeners = streamListeners.get(sessionId);
    if (!currentListeners) {
      return;
    }
    currentListeners.delete(listener);
    if (currentListeners.size === 0) {
      streamListeners.delete(sessionId);
    }
  };
}

export function emitTransferEvent(payload: TransferJobEvent): void {
  transferEventHub.emit(payload);
}

export function subscribeTransferEvent(
  listener: Listener<TransferJobEvent>,
): () => void {
  return transferEventHub.subscribe(listener);
}

export function emitSftpConnectionProgress(
  payload: SftpConnectionProgressEvent,
): void {
  sftpConnectionProgressHub.emit(payload);
}

export function subscribeSftpConnectionProgress(
  listener: Listener<SftpConnectionProgressEvent>,
): () => void {
  return sftpConnectionProgressHub.subscribe(listener);
}

export function emitContainerConnectionProgress(
  payload: ContainerConnectionProgressEvent,
): void {
  containerConnectionProgressHub.emit(payload);
}

export function subscribeContainerConnectionProgress(
  listener: Listener<ContainerConnectionProgressEvent>,
): () => void {
  return containerConnectionProgressHub.subscribe(listener);
}

export function emitPortForwardEvent(payload: PortForwardRuntimeEvent): void {
  portForwardEventHub.emit(payload);
}

export function subscribePortForwardEvent(
  listener: Listener<PortForwardRuntimeEvent>,
): () => void {
  return portForwardEventHub.subscribe(listener);
}

export function emitUpdateEvent(payload: UpdateEvent): void {
  updateEventHub.emit(payload);
}

export function subscribeUpdateEvent(
  listener: Listener<UpdateEvent>,
): () => void {
  return updateEventHub.subscribe(listener);
}

export function emitAuthEvent(payload: AuthState): void {
  authEventHub.emit(payload);
}

export function subscribeAuthEvent(
  listener: Listener<AuthState>,
): () => void {
  return authEventHub.subscribe(listener);
}

export function emitWindowState(payload: DesktopWindowState): void {
  windowStateHub.emit(payload);
}

export function subscribeWindowState(
  listener: Listener<DesktopWindowState>,
): () => void {
  return windowStateHub.subscribe(listener);
}

export function emitWarpgateImportEvent(payload: WarpgateImportEvent): void {
  warpgateImportEventHub.emit(payload);
}

export function subscribeWarpgateImportEvent(
  listener: Listener<WarpgateImportEvent>,
): () => void {
  return warpgateImportEventHub.subscribe(listener);
}

export function emitSessionShareEvent(payload: SessionShareEvent): void {
  sessionShareEventHub.emit(payload);
}

export function subscribeSessionShareEvent(
  listener: Listener<SessionShareEvent>,
): () => void {
  return sessionShareEventHub.subscribe(listener);
}

export function emitSessionShareChatEvent(
  payload: SessionShareChatEvent,
): void {
  sessionShareChatEventHub.emit(payload);
}

export function subscribeSessionShareChatEvent(
  listener: Listener<SessionShareChatEvent>,
): () => void {
  return sessionShareChatEventHub.subscribe(listener);
}

export function registerE2EWindowEvents(): void {
  if (!e2eTerminalCaptureEnabled) {
    return;
  }

  window.addEventListener("dolssh:e2e-terminal-state", (event: Event) => {
    const customEvent = event as CustomEvent<{
      sessionId?: string;
      state?: Record<string, unknown> | null;
    } | null>;
    const detail = customEvent.detail;
    if (
      !detail ||
      typeof detail.sessionId !== "string" ||
      detail.sessionId.length === 0
    ) {
      return;
    }

    if (detail.state && typeof detail.state === "object") {
      e2eTerminalStateBySession.set(detail.sessionId, detail.state);
      return;
    }

    e2eTerminalStateBySession.delete(detail.sessionId);
  });

  window.addEventListener("dolssh:e2e-replay-state", (event: Event) => {
    const customEvent = event as CustomEvent<Record<string, unknown> | null>;
    if (customEvent.detail && typeof customEvent.detail === "object") {
      e2eReplayState = customEvent.detail;
      return;
    }

    e2eReplayState = null;
  });
}

export function isE2ETerminalCaptureEnabled(): boolean {
  return e2eTerminalCaptureEnabled;
}

export function getE2EBridge() {
  return {
    getTerminalOutput(sessionId: string): string {
      return e2eTerminalOutputBySession.get(sessionId) ?? "";
    },
    getTerminalOutputs(): Record<string, string> {
      return Object.fromEntries(e2eTerminalOutputBySession.entries());
    },
    getSessionTerminalState(sessionId: string): Record<string, unknown> | null {
      return e2eTerminalStateBySession.get(sessionId) ?? null;
    },
    getReplayState(): Record<string, unknown> | null {
      return e2eReplayState;
    },
    emitSessionShareEvent,
    emitSessionShareChatEvent,
  };
}
