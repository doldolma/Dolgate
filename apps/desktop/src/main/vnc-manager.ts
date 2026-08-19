import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

import type {
  ActivityLogRecord,
  SessionLifecycleLogMetadata,
  VncConnectedPayload,
  VncInputEvent,
  VncConnectStage,
  VncSessionEvent,
} from "@shared";

import { CoreFrameParser, encodeControlFrameOf } from "./core-framing";
import { ipcChannels } from "../common/ipc-channels";
import { logMessage } from "./activity-log-message";

// vnc-core 사이드카를 다루는 얇은 계층.
//
// rdp-manager 와 같은 모양이다 — 같은 9바이트 프레이밍(core-framing)을 쓰고, 픽셀은 stream
// frame 으로 오고, 나머지는 control frame 이다. 다른 점은 프로토콜뿐이라 구조를 그대로 맞춰
// 두 파일을 나란히 읽을 수 있게 한다.
//
// **VNC 에 없는 것:** 오디오·드라이브 리다이렉션·다중 모니터 협상. RFB 에는 그런 채널이 없고
// 프레임버퍼가 하나뿐이다(모니터별 창은 그 하나를 잘라 쓴다).

/** 코어가 stream frame 메타데이터에 실어 보내는 사각형. */
interface VncFrameMetadata {
  type: "vncFrame";
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 커서 모양. 픽셀과 같은 stream 경로로 오고 `type` 으로 갈린다.
 *
 * 코어가 Cursor 의사 인코딩을 선언했으면 서버는 커서를 화면에 그려 주지 않는다 — 이걸 렌더러까지
 * 전달하지 않으면 원격 커서가 아예 보이지 않는다.
 */
interface VncCursorMetadata {
  type: "vncCursor";
  sessionId: string;
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
}


export interface VncConnectOptions {
  sessionId: string;
  host: string;
  port: number;
  password?: string;
  /**
   * 계정. VeNCrypt 의 Plain 계열에서만 쓰인다(코어가 판단한다).
   *
   * 비어 있으면 코어가 계정을 요구하는 방식을 고르지 않는다 — 빈 계정으로 붙으려다 실패하면 그
   * 이유가 비밀번호 오류와 구분되지 않는다.
   */
  username?: string;
  /** 화면 압축 화질. 없으면 무손실(JPEG 없음). */
  imageQuality?: string;
  shared?: boolean;
}

export interface VncLaunchConfig {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** 연결 하나를 로그로 남기는 데 필요한 호스트 정체. IPC 계층이 호스트 레코드에서 채운다. */
export interface VncSessionLifecycleInfo {
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails: string | null;
}

interface VncLifecycleState extends VncSessionLifecycleInfo {
  /**
   * 로그 행의 id. 자동 재연결이 sessionId 를 재사용하므로 세션 id 로만 잡으면 재연결마다 이전
   * 기록이 덮어써진다 — 시도마다 고유한 requestId 를 붙여 시도 하나 = 로그 행 하나로 만든다
   * (rdp-manager 와 같은 이유·같은 방식).
   */
  logId: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
}

export interface VncManagerOptions {
  /** 프레임·이벤트를 받을 창들. 창 목록은 바뀌므로 매번 조회한다. */
  getWindows: () => Array<{
    isDestroyed: () => boolean;
    webContents: {
      id: number;
      send: (channel: string, payload: unknown) => void;
    };
  }>;
  /** 테스트에서 실제 프로세스 대신 가짜를 넣기 위한 구멍. */
  spawnProcess?: (config: VncLaunchConfig) => ChildProcessWithoutNullStreams;
  resolveLaunchConfig?: () => VncLaunchConfig;
  /**
   * 세션 lifecycle 을 활동 로그로 남길 싱크.
   *
   * CoreManager 가 SSH 에 쓰는 것과 같은 저장소를 물려받는다 — 그래야 VNC 도 로그 화면과 **최근
   * 접속 시각**에 함께 보인다(최근 접속은 category 'session' 로그에서 계산된다).
   */
  upsertLogRecord?: (record: ActivityLogRecord) => void;
}

interface PendingConnect {
  resolve: (payload: VncConnectedPayload) => void;
  reject: (error: Error) => void;
}

export class VncManager {
  private process: ChildProcessWithoutNullStreams | null = null;
  private parser = new CoreFrameParser();
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingConnect>();
  private readonly sessions = new Set<string>();
  private readonly connectedBySession = new Map<string, VncConnectedPayload>();
  /**
   * 세션별 픽셀 구독자(webContents id).
   *
   * 프레임을 모든 창에 뿌리지 않는 이유는 rdp-manager 와 같다 — 화면 한 장이 수 MB 라 관심 없는
   * 창에 보내면 그만큼 직렬화·복사가 늘고, 그 비용은 메인 프로세스 이벤트 루프에서 나간다.
   */
  private readonly watchersBySession = new Map<string, Set<number>>();
  private readonly lifecycleBySession = new Map<string, VncLifecycleState>();

  constructor(private readonly options: VncManagerOptions) {}

  describeSession(sessionId: string): VncConnectedPayload | null {
    return this.connectedBySession.get(sessionId) ?? null;
  }

  async connect(
    options: VncConnectOptions,
    lifecycle?: VncSessionLifecycleInfo,
  ): Promise<VncConnectedPayload> {
    const child = this.ensureProcess();
    const id = `vnc-${++this.requestSeq}`;
    this.sessions.add(options.sessionId);

    if (lifecycle) {
      this.lifecycleBySession.set(options.sessionId, {
        ...lifecycle,
        logId: `session:${options.sessionId}:${id}`,
        connectedAt: null,
        disconnectedAt: null,
      });
    }

    return await new Promise<VncConnectedPayload>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(
        encodeControlFrameOf({
          id,
          type: "connectVnc",
          sessionId: options.sessionId,
          payload: {
            host: options.host,
            port: options.port,
            password: options.password ?? "",
            username: options.username ?? "",
            imageQuality: options.imageQuality ?? "",
            // 기본은 공유다. 끄면 서버가 기존 클라이언트를 끊는다.
            shared: options.shared !== false,
          },
        }),
      );
    })
      .catch((error) => {
        // 연결에 이르지 못한 시도는 로그를 남기지 않는다 — 자동 재연결이 백오프로 반복하는 동안
        // 실패 행이 로그를 채운다(rdp-manager 와 같은 규칙). 실패는 세션 오버레이가 보여준다.
        this.lifecycleBySession.delete(options.sessionId);
        throw error;
      });
  }

  /**
   * 이 세션을 연 창. 그 창이 닫히면 세션도 끊는다.
   *
   * **픽셀을 보는 창(watcher)과 다르다** — watcher 는 프레임을 받는 창이고, 주인은 접속을 시작한
   * 창 하나다.
   */
  private readonly ownerBySession = new Map<string, number>();

  /** 세션의 주인 창을 기록한다. 접속을 시작한 창이 주인이다. */
  setSessionOwner(sessionId: string, webContentsId: number): void {
    this.ownerBySession.set(sessionId, webContentsId);
  }

  /**
   * 그 창이 열었던 세션을 모두 끊는다. 창이 닫힐 때 부른다.
   *
   * 이것이 없으면 멀티윈도우에서 창 하나를 닫아도 그 창의 VNC 세션이 코어에 남는다 — 서버 쪽
   * 화면 세션까지 잡은 채로 앱이 끝날 때까지 살아 있었다.
   */
  disconnectSessionsOwnedBy(webContentsId: number): void {
    for (const [sessionId, ownerId] of Array.from(this.ownerBySession)) {
      if (ownerId !== webContentsId) {
        continue;
      }
      this.disconnect(sessionId);
    }
  }

  disconnect(sessionId: string): void {
    this.ownerBySession.delete(sessionId);
    this.sessions.delete(sessionId);
    this.connectedBySession.delete(sessionId);
    this.watchersBySession.delete(sessionId);
    if (!this.process) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `vnc-${++this.requestSeq}`,
        type: "disconnectVnc",
        sessionId,
      }),
    );
  }

  /**
   * 화면 전체를 다시 받는다.
   *
   * 캔버스는 크기가 바뀌면 내용이 지워지는데, 그 리사이즈는 프레임 도착과 순서가 보장되지 않는다
   * (React 상태를 거친다). 그 사이에 온 프레임은 버려지고 서버는 정적인 영역을 다시 보내지 않아
   * 그 자리가 검게 남는다 — 잃은 쪽이 다시 달라고 해야 한다.
   */
  refreshScreen(sessionId: string): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `vnc-${++this.requestSeq}`,
        type: "vncRefresh",
        sessionId,
      }),
    );
  }

  sendInput(sessionId: string, events: VncInputEvent[]): void {
    if (!this.process || events.length === 0) {
      return;
    }
    // 세션이 이미 끝났으면 보내지 않는다. 코어도 무시하지만, 죽은 세션에 프레임을 만들어 보내는
    // 왕복을 줄인다.
    if (!this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `vnc-${++this.requestSeq}`,
        type: "vncInput",
        sessionId,
        payload: { events },
      }),
    );
  }

  /**
   * 로컬 클립보드를 원격에 알린다.
   *
   * 클립보드는 메인 프로세스가 소유한다(RDP 와 같은 규칙) — 코어는 OS 클립보드를 만지지 않고
   * 받은 문자열만 전송한다. 빈 문자열도 보낸다: 원격에서 "비웠다" 도 상태 변화다.
   */
  /**
   * 창 크기에 맞춰 원격 화면 크기를 요청한다.
   *
   * 서버가 `ExtendedDesktopSize` 를 쓰지 않으면 코어가 조용히 버린다 — 크기를 못 바꾸는 서버가
   * 정상적으로 존재하므로(x11vnc 로 실제 화면을 미러링하는 경우 등) 오류로 다루지 않는다.
   */
  requestDesktopSize(sessionId: string, width: number, height: number): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    if (width <= 0 || height <= 0) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `vnc-${++this.requestSeq}`,
        type: "vncSetDesktopSize",
        sessionId,
        payload: { width: Math.round(width), height: Math.round(height) },
      }),
    );
  }

  /**
   * 원격에서 복사된 텍스트. 메인 프로세스가 로컬 클립보드에 넣는다.
   *
   * 이벤트로 렌더러까지 보내지 않는 이유: 클립보드 소유자가 둘이 되면 같은 값이 원격↔로컬을
   * 왕복한다.
   */
  onRemoteClipboardText: ((text: string) => void) | null = null;

  sendClipboardText(sessionId: string, text: string): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `vnc-${++this.requestSeq}`,
        type: "vncClipboard",
        sessionId,
        payload: { text },
      }),
    );
  }

  shutdown(): void {
    if (!this.process) {
      return;
    }
    this.process.stdin.end();
    this.process.kill();
    this.process = null;
  }

  watchSession(sessionId: string, webContentsId: number): void {
    const watchers = this.watchersBySession.get(sessionId) ?? new Set<number>();
    watchers.add(webContentsId);
    this.watchersBySession.set(sessionId, watchers);
  }

  unwatchSession(sessionId: string, webContentsId: number): void {
    const watchers = this.watchersBySession.get(sessionId);
    if (!watchers) {
      return;
    }
    watchers.delete(webContentsId);
    if (watchers.size === 0) {
      this.watchersBySession.delete(sessionId);
    }
  }

  forgetWatcher(webContentsId: number): void {
    for (const [sessionId, watchers] of this.watchersBySession) {
      watchers.delete(webContentsId);
      if (watchers.size === 0) {
        this.watchersBySession.delete(sessionId);
      }
    }
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process) {
      return this.process;
    }

    const config = (this.options.resolveLaunchConfig ?? resolveVncLaunchConfig)();
    const child = (this.options.spawnProcess ?? defaultSpawn)(config);

    child.stdout.on("data", (chunk: Buffer) => {
      this.consume(chunk);
    });

    // 읽지 않으면 파이프 버퍼가 차서 코어가 쓰기에서 멈춘다. 진단도 여기로만 나온다
    // (DOLGATE_VNC_LOG=vnc_core=debug 로 협상·인코딩 요약, trace 로 갱신 하나하나).
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          console.error(`[vnc-core] ${line}`);
        }
      }
    });

    child.on("exit", (code) => {
      for (const sessionId of this.sessions) {
        // 코어가 죽으면 closed 이벤트가 오지 않는다. 마감하지 않으면 그 연결이 로그에 "접속 중" 인
        // 채로 영구히 남는다.
        this.finalizeLifecycle(sessionId, "error", `VNC core exited (code ${code ?? "unknown"})`);
        this.emitEvent({ type: "closed", sessionId });
      }
      this.lifecycleBySession.clear();
      this.sessions.clear();
      this.connectedBySession.clear();
      this.rejectAllPending(new Error(`VNC core exited (code ${code ?? "unknown"})`));
      this.parser = new CoreFrameParser();
      this.process = null;
    });

    this.process = child;
    return child;
  }

  private consume(chunk: Buffer): void {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      // 프레임 경계가 깨지면 그 뒤를 신뢰할 수 없다. 파서를 새로 만들고 붙어 있던 세션을 끝낸다.
      this.rejectAllPending(
        error instanceof Error ? error : new Error("VNC frame parse failed"),
      );
      for (const sessionId of this.sessions) {
        this.emitEvent({
          type: "error",
          sessionId,
          message: "VNC 코어와의 통신이 깨졌습니다",
        });
      }
      this.sessions.clear();
      this.parser = new CoreFrameParser();
      return;
    }

    for (const frame of frames) {
      if (frame.kind === "stream") {
        const metadata = frame.metadata as unknown as
          | VncFrameMetadata
          | VncCursorMetadata;
        if (metadata?.type === "vncFrame") {
          this.handleFrame(metadata, frame.payload);
        } else if (metadata?.type === "vncCursor") {
          this.handleCursor(metadata, frame.payload);
        }
        continue;
      }
      this.handleEvent(frame.metadata as unknown as Record<string, unknown>);
    }
  }

  private handleFrame(metadata: VncFrameMetadata, pixels: Uint8Array): void {
    this.sendToWatchers(metadata.sessionId, ipcChannels.vnc.frame, {
      sessionId: metadata.sessionId,
      x: metadata.x,
      y: metadata.y,
      width: metadata.width,
      height: metadata.height,
      // 픽셀은 그대로 넘긴다. 여기서 형변환하면 화면 한 장마다 복사가 한 번 더 붙는다.
      pixels,
    });
  }

  private handleCursor(metadata: VncCursorMetadata, pixels: Uint8Array): void {
    this.sendToWatchers(metadata.sessionId, ipcChannels.vnc.cursor, {
      sessionId: metadata.sessionId,
      hotspotX: metadata.hotspotX,
      hotspotY: metadata.hotspotY,
      width: metadata.width,
      height: metadata.height,
      pixels,
    });
  }

  private handleEvent(metadata: Record<string, unknown>): void {
    const kind = typeof metadata.type === "string" ? metadata.type : "";
    const sessionId =
      typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
    const requestId =
      typeof metadata.requestId === "string" ? metadata.requestId : undefined;
    const payload = (metadata.payload ?? {}) as Record<string, unknown>;

    switch (kind) {
      case "ready":
        return;
      case "connected": {
        if (!sessionId) {
          return;
        }
        const connected: VncConnectedPayload = {
          desktopWidth: Number(payload.desktopWidth ?? 0),
          desktopHeight: Number(payload.desktopHeight ?? 0),
          name: typeof payload.name === "string" ? payload.name : "",
        };
        this.connectedBySession.set(sessionId, connected);
        this.markLifecycleConnected(sessionId);
        this.emitEvent({ type: "connected", sessionId, payload: connected });
        if (requestId) {
          this.pending.get(requestId)?.resolve(connected);
          this.pending.delete(requestId);
        }
        return;
      }
      case "resized": {
        if (!sessionId) {
          return;
        }
        const width = Number(payload.desktopWidth ?? 0);
        const height = Number(payload.desktopHeight ?? 0);
        const previous = this.connectedBySession.get(sessionId);
        if (previous) {
          this.connectedBySession.set(sessionId, {
            ...previous,
            desktopWidth: width,
            desktopHeight: height,
          });
        }
        this.emitEvent({
          type: "resized",
          sessionId,
          desktopWidth: width,
          desktopHeight: height,
        });
        return;
      }
      case "capabilities": {
        if (!sessionId) {
          return;
        }
        // 협상 결과는 접속 뒤에 하나씩 드러난다(어떤 것은 서버가 그 기능을 실제로 쓸 때 비로소).
        // 코어가 바뀔 때만 보내므로 여기서 걸러낼 것이 없다.
        this.emitEvent({
          type: "capabilities",
          sessionId,
          payload: {
            extendedClipboard: Boolean(payload.extendedClipboard),
            desktopResize: Boolean(payload.desktopResize),
            cursor: Boolean(payload.cursor),
            continuousUpdates: Boolean(payload.continuousUpdates),
            qemuKeys: Boolean(payload.qemuKeys),
            tls: Boolean(payload.tls),
            encoding: typeof payload.encoding === "string" ? payload.encoding : "",
          },
        });
        return;
      }
      case "clipboardLossy": {
        if (!sessionId) {
          return;
        }
        this.emitEvent({
          type: "clipboardLossy",
          sessionId,
          replaced: Number(payload.replaced ?? 0),
        });
        return;
      }
      case "clipboard": {
        // 렌더러로 보내지 않는다 — 클립보드는 메인 프로세스가 소유하고, 두 곳에서 쓰면 값이
        // 왕복한다(RDP 와 같은 규칙: onRemoteClipboardText 훅 하나만 둔다).
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text) {
          this.onRemoteClipboardText?.(text);
        }
        return;
      }
      case "error": {
        const message =
          typeof payload.message === "string" && payload.message.trim()
            ? payload.message
            : "VNC 연결에 실패했습니다";
        // 연결 시도 중이면 그 약속을 깨뜨려야 한다. 안 그러면 호출부가 영원히 기다린다.
        if (requestId && this.pending.has(requestId)) {
          this.pending.get(requestId)?.reject(new Error(message));
          this.pending.delete(requestId);
        }
        if (sessionId) {
          this.sessions.delete(sessionId);
          this.finalizeLifecycle(sessionId, "error", message);
          this.emitEvent({ type: "error", sessionId, message });
        }
        return;
      }
      case "closed": {
        if (!sessionId) {
          return;
        }
        this.sessions.delete(sessionId);
        this.connectedBySession.delete(sessionId);
        this.ownerBySession.delete(sessionId);
        this.finalizeLifecycle(sessionId, "closed", null);
        this.lifecycleBySession.delete(sessionId);
        this.emitEvent({ type: "closed", sessionId });
        return;
      }
      default:
        return;
    }
  }

  /**
   * 붙는 동안 지금 어느 관문에 있는지 알린다.
   *
   * 경유(tailnet·SSH 터널) 배선은 이 클래스가 아니라 IPC 계층에 있다 — 거기서 호스트 설정을 읽고
   * ssh-core 에 통로를 여는데, 그 시간이 실제로 길고 거기서 막히는 일이 흔하다. 그래서 이 창구만
   * 열어 준다.
   */
  reportProgress(sessionId: string, stage: VncConnectStage, message: string): void {
    this.emitEvent({ type: "progress", sessionId, stage, message });
  }

  private emitEvent(event: VncSessionEvent): void {
    this.broadcast(ipcChannels.vnc.event, event);
  }

  private markLifecycleConnected(sessionId: string): void {
    const lifecycle = this.lifecycleBySession.get(sessionId);
    if (!lifecycle || lifecycle.connectedAt) {
      return;
    }
    const connectedAt = new Date().toISOString();
    lifecycle.connectedAt = connectedAt;
    this.upsertLifecycleLog(sessionId, lifecycle, {
      status: "connected",
      disconnectedAt: null,
      durationMs: null,
      disconnectReason: null,
      updatedAt: connectedAt,
    });
  }

  private finalizeLifecycle(
    sessionId: string,
    status: "closed" | "error",
    disconnectReason: string | null,
  ): void {
    const lifecycle = this.lifecycleBySession.get(sessionId);
    // 연결에 이르지 못했거나(connectedAt 없음) 이미 마감된 시도는 건너뛴다 — error 뒤에 closed 가
    // 따라와도 행 하나로 끝난다.
    if (!lifecycle || !lifecycle.connectedAt || lifecycle.disconnectedAt) {
      return;
    }
    const disconnectedAt = new Date().toISOString();
    lifecycle.disconnectedAt = disconnectedAt;
    this.upsertLifecycleLog(sessionId, lifecycle, {
      status,
      disconnectedAt,
      durationMs: Math.max(
        0,
        new Date(disconnectedAt).getTime() - new Date(lifecycle.connectedAt).getTime(),
      ),
      disconnectReason,
      updatedAt: disconnectedAt,
    });
  }

  private upsertLifecycleLog(
    sessionId: string,
    lifecycle: VncLifecycleState,
    state: {
      status: "connected" | "closed" | "error";
      disconnectedAt: string | null;
      durationMs: number | null;
      disconnectReason: string | null;
      updatedAt: string;
    },
  ): void {
    if (!this.options.upsertLogRecord || !lifecycle.connectedAt) {
      return;
    }
    const metadata: SessionLifecycleLogMetadata = {
      sessionId,
      hostId: lifecycle.hostId,
      hostLabel: lifecycle.hostLabel,
      title: lifecycle.title,
      connectionDetails: lifecycle.connectionDetails,
      connectionKind: "vnc",
      connectedAt: lifecycle.connectedAt,
      disconnectedAt: state.disconnectedAt,
      durationMs: state.durationMs,
      status: state.status,
      disconnectReason: state.disconnectReason,
      // 화면 녹화는 터미널 세션만 남긴다(원격 화면은 프레임이라 그 저장소를 쓰지 않는다).
      recordingId: null,
      hasReplay: false,
    };
    this.options.upsertLogRecord({
      id: lifecycle.logId,
      level: state.status === "error" ? "error" : "info",
      category: "session",
      kind: "session-lifecycle",
      ...logMessage("core.sessionLog", { kind: "VNC" }),
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: lifecycle.connectedAt,
      updatedAt: state.updatedAt,
    });
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const window of this.options.getWindows()) {
      if (window.isDestroyed()) {
        continue;
      }
      window.webContents.send(channel, payload);
    }
  }

  private sendToWatchers(
    sessionId: string,
    channel: string,
    payload: unknown,
  ): void {
    const watchers = this.watchersBySession.get(sessionId);
    if (!watchers || watchers.size === 0) {
      // 아직 구독자가 없으면 버린다. 화면은 다음 갱신에서 다시 온다 — 여기서 쌓아 두면 탭을 열지
      // 않은 세션의 프레임이 메모리에 남는다.
      return;
    }
    for (const window of this.options.getWindows()) {
      if (window.isDestroyed() || !watchers.has(window.webContents.id)) {
        continue;
      }
      window.webContents.send(channel, payload);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultSpawn(config: VncLaunchConfig): ChildProcessWithoutNullStreams {
  return spawn(config.command, config.args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: config.env ? { ...process.env, ...config.env } : process.env,
  });
}

export function resolveVncLaunchConfig(): VncLaunchConfig {
  const binaryName = process.platform === "win32" ? "vnc-core.exe" : "vnc-core";

  // 패키징된 앱은 ssh-core·rdp-core 와 같은 자리(resources/bin)에서 찾는다.
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "bin", binaryName);
    if (!existsSync(bundled)) {
      throw new Error(`Bundled vnc-core binary not found: ${bundled}`);
    }
    return { command: bundled, args: [], cwd: path.dirname(bundled) };
  }

  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const serviceDir = path.join(repoRoot, "services", "vnc-core");

  for (const profile of ["release", "debug"]) {
    const candidate = path.join(serviceDir, "target", profile, binaryName);
    if (existsSync(candidate)) {
      return {
        command: candidate,
        args: [],
        cwd: serviceDir,
        // **로그 수준을 여기서 정하지 않는다.** 예전에는 개발 중 `vnc_core=debug` 를 넣었는데,
        // 화면 갱신 로그가 초당 수십 줄이라 정작 무언가 잘못됐을 때 그 줄을 찾을 수 없었다.
        // 코어 기본값(warn)이 평시에 맞고, 필요하면 겉에서 켠다:
        //
        //   DOLGATE_VNC_LOG=vnc_core=debug npm run dev     협상·인코딩 요약·클립보드
        //   DOLGATE_VNC_LOG=vnc_core=trace npm run dev     갱신 하나하나
        //
        // env 를 넘기지 않으면 spawn 이 process.env 를 그대로 물려주므로 그 값이 코어까지 간다.
      };
    }
  }

  throw new Error(
    "vnc-core binary not found. Build it first: cd services/vnc-core && cargo build",
  );
}
