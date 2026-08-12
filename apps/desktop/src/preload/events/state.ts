import type {
  AiChatEvent,
  AiTerminalOutputRequest,
  AuthState,
  ContainerConnectionProgressEvent,
  CoreEvent,
  DesktopWindowState,
  PortForwardRuntimeEvent,
  SessionShareChatEvent,
  SessionShareEvent,
  SftpConnectionProgressEvent,
  TailnetStatus,
  TabCommandPayload,
  TransferJobEvent,
  RdpAudioPayload,
  RdpFramePayload,
  VncCursorPayload,
  VncFramePayload,
  VncSessionEvent,
  RdpSessionEvent,
  UpdateEvent,
  WarpgateImportEvent,
} from "@shared";

type Listener<T> = (payload: T) => void;

function createListenerHub<T>() {
  const listeners = new Set<Listener<T>>();

  return {
    emit(payload: T): void {
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch (err) {
          // 한 리스너의 throw 가 다른 리스너/후속 이벤트 dispatch 를 막지 않게 격리한다.
          console.error("event listener failed", err);
        }
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
const rdpEventHub = createListenerHub<RdpSessionEvent>();
// 프레임은 세션 단위로 흘려보낸다. 창마다 다른 세션을 그리므로 전역 팬아웃은 낭비다.
const rdpFrameListeners = new Map<string, Set<Listener<RdpFramePayload>>>();
const rdpAudioListeners = new Map<string, Set<Listener<RdpAudioPayload>>>();
const vncEventHub = createListenerHub<VncSessionEvent>();
const vncFrameListeners = new Map<string, Set<Listener<VncFramePayload>>>();
const vncCursorListeners = new Map<string, Set<Listener<VncCursorPayload>>>();
const transferEventHub = createListenerHub<TransferJobEvent>();
const sftpConnectionProgressHub =
  createListenerHub<SftpConnectionProgressEvent>();
const containerConnectionProgressHub =
  createListenerHub<ContainerConnectionProgressEvent>();
const tailnetStatusHub = createListenerHub<TailnetStatus>();
const activityLogsChangedHub = createListenerHub<void>();
const portForwardEventHub = createListenerHub<PortForwardRuntimeEvent>();
const updateEventHub = createListenerHub<UpdateEvent>();
const authEventHub = createListenerHub<AuthState>();
const workspaceChangedHub = createListenerHub<void>();
const windowStateHub = createListenerHub<DesktopWindowState>();
const warpgateImportEventHub = createListenerHub<WarpgateImportEvent>();
const sessionShareEventHub = createListenerHub<SessionShareEvent>();
const sessionShareChatEventHub = createListenerHub<SessionShareChatEvent>();
const systemResumeHub = createListenerHub<void>();
const closeActiveTabHub = createListenerHub<void>();
const tabCommandHub = createListenerHub<TabCommandPayload>();
const aiChatEventHub = createListenerHub<AiChatEvent>();
const aiTerminalOutputRequestHub = createListenerHub<AiTerminalOutputRequest>();

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

export function emitRdpEvent(payload: RdpSessionEvent): void {
  rdpEventHub.emit(payload);
}

export function subscribeRdpEvent(listener: Listener<RdpSessionEvent>): () => void {
  return rdpEventHub.subscribe(listener);
}

export function emitRdpFrame(payload: RdpFramePayload): void {
  const listeners = rdpFrameListeners.get(payload.sessionId);
  if (!listeners) {
    // 캔버스가 아직 안 붙었으면 버린다. 픽셀은 backlog로 쌓아둘 값이 아니고, 다음 갱신이
    // 어차피 덮어쓴다.
    return;
  }
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      console.error("rdp frame listener failed", err);
    }
  }
}

export function emitRdpAudio(payload: RdpAudioPayload): void {
  const listeners = rdpAudioListeners.get(payload.sessionId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      console.error("rdp audio listener failed", err);
    }
  }
}

export function subscribeRdpAudio(
  sessionId: string,
  listener: Listener<RdpAudioPayload>,
): () => void {
  const listeners = rdpAudioListeners.get(sessionId) ?? new Set<Listener<RdpAudioPayload>>();
  listeners.add(listener);
  rdpAudioListeners.set(sessionId, listeners);

  return () => {
    const current = rdpAudioListeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      rdpAudioListeners.delete(sessionId);
    }
  };
}

/**
 * 이 창이 어느 세션의 픽셀을 원하는지 메인 프로세스에 알린다.
 *
 * 프레임은 IPC structured clone 이라 창마다 전체 복사본이 생긴다. 안 보내도 되는 창까지
 * 뿌리면 창 수만큼 픽셀 트래픽이 곱해진다 — 1920x1080 전체 갱신 한 번이 8.3MB 다.
 */
export function emitVncEvent(payload: VncSessionEvent): void {
  vncEventHub.emit(payload);
}

export function subscribeVncEvent(listener: Listener<VncSessionEvent>): () => void {
  return vncEventHub.subscribe(listener);
}

/**
 * 커서 모양.
 *
 * 픽셀과 달리 watch 알림을 걸지 않는다 — 커서는 프레임과 같은 구독자 목록으로 오므로, 캔버스가
 * 프레임을 구독하는 것으로 이미 켜져 있다. 여기서 또 알리면 같은 세션을 두 번 세게 된다.
 */
export function emitVncCursor(payload: VncCursorPayload): void {
  const listeners = vncCursorListeners.get(payload.sessionId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // 한 구독자가 던져도 나머지에게는 전달돼야 한다.
    }
  }
}

export function subscribeVncCursor(
  sessionId: string,
  listener: Listener<VncCursorPayload>,
): () => void {
  const listeners =
    vncCursorListeners.get(sessionId) ?? new Set<Listener<VncCursorPayload>>();
  listeners.add(listener);
  vncCursorListeners.set(sessionId, listeners);

  return () => {
    const current = vncCursorListeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      vncCursorListeners.delete(sessionId);
    }
  };
}

export function emitVncFrame(payload: VncFramePayload): void {
  const listeners = vncFrameListeners.get(payload.sessionId);
  if (!listeners) {
    // 캔버스가 아직 안 붙었으면 버린다(RDP 와 같은 이유). 픽셀은 쌓아 둘 값이 아니다.
    return;
  }
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // 한 구독자가 던져도 나머지에게는 전달돼야 한다.
    }
  }
}

let watchSession: ((sessionId: string, watching: boolean) => void) | null = null;
let watchVncSession: ((sessionId: string, watching: boolean) => void) | null = null;

export function setRdpFrameWatchNotifier(
  notify: (sessionId: string, watching: boolean) => void,
): void {
  watchSession = notify;
}

export function setVncFrameWatchNotifier(
  notify: (sessionId: string, watching: boolean) => void,
): void {
  watchVncSession = notify;
}

/**
 * 이 창이 이 세션의 픽셀을 원한다고 알린다.
 *
 * RDP 와 같은 이유로 세션 단위다 — 프레임은 IPC structured clone 이라 창마다 전체 복사본이 생긴다.
 */
export function subscribeVncFrame(
  sessionId: string,
  listener: Listener<VncFramePayload>,
): () => void {
  const listeners =
    vncFrameListeners.get(sessionId) ?? new Set<Listener<VncFramePayload>>();
  const first = listeners.size === 0;
  listeners.add(listener);
  vncFrameListeners.set(sessionId, listeners);
  if (first) {
    watchVncSession?.(sessionId, true);
  }

  return () => {
    const current = vncFrameListeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      vncFrameListeners.delete(sessionId);
      watchVncSession?.(sessionId, false);
    }
  };
}

export function subscribeRdpFrame(
  sessionId: string,
  listener: Listener<RdpFramePayload>,
): () => void {
  const listeners = rdpFrameListeners.get(sessionId) ?? new Set<Listener<RdpFramePayload>>();
  const first = listeners.size === 0;
  listeners.add(listener);
  rdpFrameListeners.set(sessionId, listeners);
  if (first) {
    watchSession?.(sessionId, true);
  }

  return () => {
    const current = rdpFrameListeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      rdpFrameListeners.delete(sessionId);
      watchSession?.(sessionId, false);
    }
  };
}

export function emitWorkspaceChanged(): void {
  workspaceChangedHub.emit(undefined);
}

export function subscribeWorkspaceChanged(listener: () => void): () => void {
  return workspaceChangedHub.subscribe(listener);
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

export function emitTailnetStatus(payload: TailnetStatus): void {
  tailnetStatusHub.emit(payload);
}

export function subscribeTailnetStatus(
  listener: Listener<TailnetStatus>,
): () => void {
  return tailnetStatusHub.subscribe(listener);
}

export function emitActivityLogsChanged(): void {
  activityLogsChangedHub.emit();
}

export function subscribeActivityLogsChanged(listener: () => void): () => void {
  return activityLogsChangedHub.subscribe(listener);
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

export function emitSystemResume(): void {
  systemResumeHub.emit(undefined);
}

export function subscribeSystemResume(listener: () => void): () => void {
  return systemResumeHub.subscribe(listener);
}

export function emitCloseActiveTab(): void {
  closeActiveTabHub.emit(undefined);
}

export function subscribeCloseActiveTab(listener: () => void): () => void {
  return closeActiveTabHub.subscribe(listener);
}

export function emitTabCommand(payload: TabCommandPayload): void {
  tabCommandHub.emit(payload);
}

export function subscribeTabCommand(
  listener: (payload: TabCommandPayload) => void,
): () => void {
  return tabCommandHub.subscribe(listener);
}

export function emitAiChatEvent(payload: AiChatEvent): void {
  aiChatEventHub.emit(payload);
}

export function subscribeAiChatEvent(
  listener: Listener<AiChatEvent>,
): () => void {
  return aiChatEventHub.subscribe(listener);
}

export function emitAiTerminalOutputRequest(payload: AiTerminalOutputRequest): void {
  aiTerminalOutputRequestHub.emit(payload);
}

export function subscribeAiTerminalOutputRequest(
  listener: Listener<AiTerminalOutputRequest>,
): () => void {
  return aiTerminalOutputRequestHub.subscribe(listener);
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
