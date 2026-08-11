import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

import type {
  VncConnectedPayload,
  VncInputEvent,
  VncSessionEvent,
} from "@shared";

import { CoreFrameParser, encodeControlFrameOf } from "./core-framing";
import { ipcChannels } from "../common/ipc-channels";

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


export interface VncConnectOptions {
  sessionId: string;
  host: string;
  port: number;
  password?: string;
  shared?: boolean;
}

export interface VncLaunchConfig {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
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

  constructor(private readonly options: VncManagerOptions) {}

  describeSession(sessionId: string): VncConnectedPayload | null {
    return this.connectedBySession.get(sessionId) ?? null;
  }

  async connect(options: VncConnectOptions): Promise<VncConnectedPayload> {
    const child = this.ensureProcess();
    const id = `vnc-${++this.requestSeq}`;
    this.sessions.add(options.sessionId);

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
            // 기본은 공유다. 끄면 서버가 기존 클라이언트를 끊는다.
            shared: options.shared !== false,
          },
        }),
      );
    });
  }

  disconnect(sessionId: string): void {
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
    // (DOLGATE_VNC_LOG=vnc_core=debug 로 인코딩별 계수까지 볼 수 있다).
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
        this.emitEvent({ type: "closed", sessionId });
      }
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
        const metadata = frame.metadata as unknown as VncFrameMetadata;
        if (metadata?.type === "vncFrame") {
          this.handleFrame(metadata, frame.payload);
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
        this.emitEvent({ type: "closed", sessionId });
        return;
      }
      default:
        return;
    }
  }

  private emitEvent(event: VncSessionEvent): void {
    this.broadcast(ipcChannels.vnc.event, event);
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
        // 개발 중에는 인코딩별 계수가 보이게 한다. 압축이 실제로 쓰이는지 확인할 유일한 자리다
        // (rdp-core 의 DOLGATE_RDP_LOG 와 같은 이유). 겉으로 쓰는 값은 그대로 존중한다.
        env: process.env.DOLGATE_VNC_LOG
          ? undefined
          : { DOLGATE_VNC_LOG: "vnc_core=debug" },
      };
    }
  }

  throw new Error(
    "vnc-core binary not found. Build it first: cd services/vnc-core && cargo build",
  );
}
