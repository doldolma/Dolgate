// rdp-core(services/rdp-core) 사이드카를 띄우고 세션을 관리한다.
//
// core-manager 가 ssh-core 를 다루는 방식과 같은 모양이다. 다른 점은 stream frame 이 터미널
// 바이트가 아니라 픽셀이라는 것뿐이고, 프레이밍(9바이트 헤더)은 동일해서 CoreFrameParser 를
// 그대로 쓴다.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  RdpCertificateInfo,
  RdpConnectOptions,
  RdpInputEvent,
  RdpConnectedPayload,
  RdpMonitorPlacement,
  RdpFramePayload,
  RdpSessionEvent,
} from "@shared";
import { CoreFrameParser, encodeControlFrameOf } from "./core-framing";

// rdp-core 가 오디오 stream frame 에 실어 보내는 형식 정보.
interface RdpAudioMetadata {
  type: string;
  sessionId: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestamp: number;
}

// rdp-core 가 stream frame 메타데이터에 실어 보내는 사각형 정보.
interface RdpFrameMetadata {
  type: string;
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RdpLaunchConfig {
  command: string;
  args: string[];
  cwd: string;
}

export interface RdpManagerOptions {
  // 프레임/이벤트를 받을 창들. 창 목록은 바뀌므로 매번 조회한다.
  getWindows: () => Array<{
    isDestroyed: () => boolean;
    webContents: {
      /** 픽셀을 보낼 창을 고르는 키. 구독 등록도 같은 id 로 들어온다. */
      id: number;
      send: (channel: string, payload: unknown) => void;
    };
  }>;
  // 테스트에서 실제 프로세스 대신 가짜를 넣기 위한 구멍.
  spawnProcess?: (config: RdpLaunchConfig) => ChildProcessWithoutNullStreams;
  resolveLaunchConfig?: () => RdpLaunchConfig;
}

interface PendingConnect {
  resolve: (payload: RdpConnectedPayload) => void;
  reject: (error: Error) => void;
}

export class RdpManager {
  private process: ChildProcessWithoutNullStreams | null = null;
  private parser = new CoreFrameParser();
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingConnect>();
  private readonly sessions = new Set<string>();

  /**
   * 세션마다 마지막으로 알린 접속 정보(데스크톱 크기 + 모니터 배치).
   *
   * 모니터별 창은 이미 붙어 있는 세션에 얹히므로 connected 이벤트를 놓친다. 물어보면 이 값을
   * 준다 — 없으면 창이 영원히 "기다리는 중"에 머문다.
   */
  private readonly connectedBySession = new Map<string, RdpConnectedPayload>();

  /** 세션마다 픽셀을 보고 있는 창(webContents id). 프레임은 여기 있는 창에만 간다. */
  private readonly watchersBySession = new Map<string, Set<number>>();

  /** 이 세션이 지금 쓰고 있는 접속 정보. 아직 안 붙었으면 null. */
  describeSession(sessionId: string): RdpConnectedPayload | null {
    return this.connectedBySession.get(sessionId) ?? null;
  }

  /**
   * 이 세션의 창들이 맡을 영역을 알린다. null 이면 데스크톱 전체.
   *
   * 모든 창에 뿌린다 — 메인 창은 자기 몫으로 좁히고, 이미 영역을 받아 열린 보조 창은 무시한다.
   */
  emitMonitorRegion(
    sessionId: string,
    region: RdpMonitorPlacement | null,
  ): void {
    this.emitEvent({ type: "monitorRegion", sessionId, region });
  }

  /**
   * 서버 인증서를 판정한다. 이 호출이 끝날 때까지 rdp-core 는 CredSSP 를 시작하지 않으므로,
   * 여기서 거절하면 자격증명은 전송되지 않는다.
   */
  private verifyCertificate:
    | ((sessionId: string, certificate: RdpCertificateInfo) => Promise<boolean>)
    | null = null;

  constructor(private readonly options: RdpManagerOptions) {}

  /** 원격에서 복사된 텍스트를 받는다. 로컬 클립보드에 넣는 것은 호출자의 몫이다. */
  onRemoteClipboardText: ((text: string) => void) | null = null;

  setCertificateVerifier(
    verify: (sessionId: string, certificate: RdpCertificateInfo) => Promise<boolean>,
  ): void {
    this.verifyCertificate = verify;
  }

  // 렌더러로 세션 이벤트를 내보낸다. 인증서 프롬프트도 같은 채널을 탄다.
  emitSessionEvent(event: RdpSessionEvent): void {
    this.emitEvent(event);
  }

  async connect(
    sessionId: string,
    connectOptions: RdpConnectOptions,
  ): Promise<RdpConnectedPayload> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`RDP session already exists: ${sessionId}`);
    }

    // [MS-RDPBCGR] 2.2.1.3.6 은 모니터를 16개까지만 허용한다. 코어도 거절하지만, 여기서
    // 막으면 프로세스를 왕복하지 않고 호출부가 바로 안다.
    if (connectOptions.monitors.length === 0) {
      throw new Error("RDP needs at least one monitor");
    }
    if (connectOptions.monitors.length > 16) {
      throw new Error(
        `RDP supports at most 16 monitors (got ${connectOptions.monitors.length})`,
      );
    }

    const child = this.ensureProcess();
    const requestId = `rdp-${++this.requestSeq}`;

    const connected = new Promise<RdpConnectedPayload>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    this.sessions.add(sessionId);
    child.stdin.write(
      encodeControlFrameOf({
        id: requestId,
        type: "connectRdp",
        sessionId,
        payload: connectOptions,
      }),
    );

    try {
      return await connected;
    } catch (error) {
      this.sessions.delete(sessionId);
      this.connectedBySession.delete(sessionId);
      throw error;
    }
  }

  disconnect(sessionId: string): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `rdp-${++this.requestSeq}`,
        type: "disconnect",
        sessionId,
        payload: {},
      }),
    );
  }

  // 입력은 fire-and-forget 이다. 세션이 이미 사라졌으면 되돌릴 것이 없고, 마우스 이동마다
  // 예외를 던지면 렌더러가 그것만 처리하게 된다.
  sendInput(sessionId: string, events: RdpInputEvent[]): void {
    if (!this.process || !this.sessions.has(sessionId) || events.length === 0) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `rdp-${++this.requestSeq}`,
        type: "rdpInput",
        sessionId,
        payload: { events },
      }),
    );
  }

  // 리사이즈도 fire-and-forget 이다. 창을 끄는 동안 초당 수십 번 오고, 코어가 최신 것만 쓴다.
  /**
   * 지금 화면 전체를 한 번 더 보내게 한다.
   *
   * RDP 는 바뀐 부분만 보낸다. 세션 도중에 새로 붙는 창은 그동안의 화면을 못 받아 정지한 영역이
   * 검은 채로 남는다 — 서버는 다시 보내주지 않으므로 사이드카가 들고 있는 프레임버퍼를 다시
   * 흘려주는 수밖에 없다.
   */
  requestRefresh(sessionId: string): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `rdp-${++this.requestSeq}`,
        type: "rdpRefresh",
        sessionId,
        payload: {},
      }),
    );
  }

  requestResize(sessionId: string, width: number, height: number): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `rdp-${++this.requestSeq}`,
        type: "rdpResize",
        sessionId,
        payload: { width, height },
      }),
    );
  }

  // 로컬에서 복사한 텍스트를 원격이 붙여넣을 수 있게 코어에 넘긴다.
  sendClipboardText(sessionId: string, text: string): void {
    if (!this.process || !this.sessions.has(sessionId)) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `rdp-${++this.requestSeq}`,
        type: "rdpClipboard",
        sessionId,
        payload: { text },
      }),
    );
  }

  // 앱 종료 시 사이드카를 남기지 않는다.
  shutdown(): void {
    this.rejectAllPending(new Error("RDP core shutting down"));
    this.sessions.clear();
    this.process?.stdin.end();
    this.process?.kill();
    this.process = null;
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process) {
      return this.process;
    }

    const config = (this.options.resolveLaunchConfig ?? resolveRdpLaunchConfig)();
    const child = (this.options.spawnProcess ?? defaultSpawn)(config);

    child.stdout.on("data", (chunk: Buffer) => {
      this.consume(chunk);
    });

    // 읽지 않으면 파이프 버퍼가 차서 코어가 쓰기에서 멈춘다. 진단 로그도 여기로만 나온다
    // (DOLGATE_RDP_LOG=debug 로 상세도를 올릴 수 있다).
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          console.error(`[rdp-core] ${line}`);
        }
      }
    });

    child.on("exit", (code) => {
      // 프로세스가 죽으면 붙어 있던 세션은 전부 끝난 것으로 본다.
      for (const sessionId of this.sessions) {
        this.emitEvent({ type: "closed", sessionId });
      }
      this.sessions.clear();
      this.rejectAllPending(new Error(`RDP core exited (code ${code ?? "unknown"})`));
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
      // 프레이밍이 어긋나면 이후 바이트는 신뢰할 수 없다. 파서를 버리고 프로세스를 내린다.
      this.rejectAllPending(
        error instanceof Error ? error : new Error("RDP frame parse failed"),
      );
      this.process?.kill();
      return;
    }

    for (const frame of frames) {
      if (frame.kind === "stream") {
        const meta = frame.metadata as unknown as { type?: string };
        if (meta.type === "rdpAudio") {
          this.handleAudio(
            frame.metadata as unknown as RdpAudioMetadata,
            frame.payload,
          );
        } else {
          this.handleFrame(frame.metadata as unknown as RdpFrameMetadata, frame.payload);
        }
      } else {
        this.handleEvent(frame.metadata as unknown as {
          type: string;
          requestId?: string;
          sessionId?: string;
          payload?: unknown;
        });
      }
    }
  }

  private handleAudio(metadata: RdpAudioMetadata, pcm: Uint8Array): void {
    this.broadcast("rdp:audio", {
      sessionId: metadata.sessionId,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      bitsPerSample: metadata.bitsPerSample,
      timestamp: metadata.timestamp,
      pcm,
    });
  }

  private handleFrame(metadata: RdpFrameMetadata, pixels: Uint8Array): void {
    const payload: RdpFramePayload = {
      sessionId: metadata.sessionId,
      x: metadata.x,
      y: metadata.y,
      width: metadata.width,
      height: metadata.height,
      pixels,
    };
    this.sendToWatchers("rdp:frame", metadata.sessionId, payload);
  }

  private handleEvent(event: {
    type: string;
    requestId?: string;
    sessionId?: string;
    payload?: unknown;
  }): void {
    const pending = event.requestId ? this.pending.get(event.requestId) : undefined;

    switch (event.type) {
      case "ready":
        return;

      case "connected": {
        const payload = event.payload as RdpConnectedPayload;
        if (pending && event.requestId) {
          this.pending.delete(event.requestId);
          pending.resolve(payload);
        }
        if (event.sessionId) {
          // 모니터별 창은 접속이 끝난 뒤에 열린다 — 이 이벤트를 놓치므로 마지막 값을 들고 있다가
          // 물어보면 준다.
          this.connectedBySession.set(event.sessionId, payload);
          this.emitEvent({ type: "connected", sessionId: event.sessionId, payload });
        }
        return;
      }

      case "error": {
        const message =
          (event.payload as { message?: string } | undefined)?.message ??
          "unknown RDP error";
        if (pending && event.requestId) {
          this.pending.delete(event.requestId);
          pending.reject(new Error(message));
        }
        if (event.sessionId) {
          this.emitEvent({ type: "error", sessionId: event.sessionId, message });
        }
        return;
      }

      case "certificateCheck": {
        const certificate = event.payload as RdpCertificateInfo;
        const sessionId = event.sessionId;
        if (!sessionId) {
          return;
        }

        const verify = this.verifyCertificate;
        // 판정기가 없으면 거절한다. 검증 없이 통과시키면 핀 고정이 있다는 착각만 남는다.
        const decision = verify
          ? verify(sessionId, certificate).catch(() => false)
          : Promise.resolve(false);

        void decision.then((accept) => {
          this.process?.stdin.write(
            encodeControlFrameOf({
              id: `rdp-${++this.requestSeq}`,
              type: "rdpTrustCertificate",
              sessionId,
              payload: { accept },
            }),
          );
        });
        return;
      }

      case "clipboardText": {
        const payload = event.payload as { text?: string };
        if (typeof payload?.text === "string") {
          this.onRemoteClipboardText?.(payload.text);
        }
        return;
      }

      case "resized": {
        const payload = event.payload as {
          desktopWidth: number;
          desktopHeight: number;
        };
        if (event.sessionId) {
          const cached = this.connectedBySession.get(event.sessionId);
          if (cached) {
            // 나중에 열리는 창이 옛 크기를 받지 않게 캐시도 같이 옮긴다.
            this.connectedBySession.set(event.sessionId, {
              ...cached,
              desktopWidth: payload.desktopWidth,
              desktopHeight: payload.desktopHeight,
            });
          }
          this.emitEvent({
            type: "resized",
            sessionId: event.sessionId,
            desktopWidth: payload.desktopWidth,
            desktopHeight: payload.desktopHeight,
          });
        }
        return;
      }

      case "closed": {
        if (event.sessionId) {
          this.sessions.delete(event.sessionId);
          this.emitEvent({ type: "closed", sessionId: event.sessionId });
        }
        return;
      }

      default:
        return;
    }
  }

  private emitEvent(event: RdpSessionEvent): void {
    this.broadcast("rdp:event", event);
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const window of this.options.getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }

  /**
   * 이 세션의 픽셀을 보는 창에만 보낸다.
   *
   * IPC 는 structured clone 이라 창마다 전체 복사본이 생긴다. 1920x1080 전체 갱신 한 번이
   * 8.3MB 라, 상관없는 창까지 뿌리면 창 수만큼 그대로 곱해진다.
   *
   * 아직 아무도 등록하지 않았으면 모든 창에 보낸다 — 접속 직후 첫 프레임이 구독보다 먼저 올 수
   * 있고, 그때 버리면 화면이 검은 채로 남는다.
   */
  private sendToWatchers(
    channel: string,
    sessionId: string,
    payload: unknown,
  ): void {
    const watchers = this.watchersBySession.get(sessionId);
    if (!watchers || watchers.size === 0) {
      this.broadcast(channel, payload);
      return;
    }

    for (const window of this.options.getWindows()) {
      if (!window.isDestroyed() && watchers.has(window.webContents.id)) {
        window.webContents.send(channel, payload);
      }
    }
  }

  /** 이 창이 이 세션의 픽셀을 원한다고 등록한다. */
  watchSession(sessionId: string, webContentsId: number): void {
    const watchers =
      this.watchersBySession.get(sessionId) ?? new Set<number>();
    watchers.add(webContentsId);
    this.watchersBySession.set(sessionId, watchers);

    // 여기서 전체 화면 재전송을 부르지 않는다. 창이 붙을 때마다 8MB 를 흘리면 등록이 조금만
    // 잦아도 그것만으로 파이프를 다 먹는다 — 화면이 초당 한두 장으로 떨어지고, stdout 을 같이
    // 쓰는 오디오까지 끊긴다. 도중에 붙는 창의 검은 화면은 창당 정확히 한 번만 부르는 방식으로
    // 따로 풀어야 한다.
  }

  /** 등록을 뺀다. 창이 닫힐 때도 불러야 죽은 id 가 남지 않는다. */
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

  /** 창이 닫혔다. 그 창의 등록을 전부 지운다. */
  forgetWatcher(webContentsId: number): void {
    for (const [sessionId, watchers] of this.watchersBySession) {
      watchers.delete(webContentsId);
      if (watchers.size === 0) {
        this.watchersBySession.delete(sessionId);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultSpawn(config: RdpLaunchConfig): ChildProcessWithoutNullStreams {
  return spawn(config.command, config.args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function resolveRdpLaunchConfig(): RdpLaunchConfig {
  const binaryName = process.platform === "win32" ? "rdp-core.exe" : "rdp-core";

  // 패키징된 앱은 ssh-core 와 같은 자리(resources/bin)에서 찾는다.
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "bin", binaryName);
    if (!existsSync(bundled)) {
      throw new Error(`Bundled rdp-core binary not found: ${bundled}`);
    }
    return { command: bundled, args: [], cwd: path.dirname(bundled) };
  }

  // 개발 중에는 cargo 산출물을 직접 쓴다. cargo run 은 매 기동마다 재확인이 들어가 느리다.
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const serviceDir = path.join(repoRoot, "services", "rdp-core");

  for (const profile of ["release", "debug"]) {
    const candidate = path.join(serviceDir, "target", profile, binaryName);
    if (existsSync(candidate)) {
      return { command: candidate, args: [], cwd: serviceDir };
    }
  }

  throw new Error(
    "rdp-core binary not found. Build it first: cd services/rdp-core && cargo build",
  );
}
