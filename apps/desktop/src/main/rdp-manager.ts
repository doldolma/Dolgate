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
  ActivityLogRecord,
  RdpCertificateInfo,
  RdpConnectOptions,
  RdpInputEvent,
  RdpConnectedPayload,
  RdpMonitorPlacement,
  RdpFramePayload,
  RdpSessionEvent,
  SessionLifecycleLogMetadata,
} from "@shared";
import { logMessage } from "./activity-log-message";
import {
  CoreFrameParser,
  encodeControlFrameOf,
  encodeControlFrameWithPayload,
} from "./core-framing";

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
  /** 코어에 넘길 추가 환경변수. 로그 수준처럼 실행 방식만 바꾸는 값이다. */
  env?: Record<string, string>;
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
  // 세션 lifecycle 을 활동 로그로 남길 싱크. CoreManager 가 SSH 세션에 쓰는 것과 같은
  // 저장소를 물려받아, RDP 도 로그 화면·최근 접속에 함께 보인다.
  upsertLogRecord?: (record: ActivityLogRecord) => void;
}

/** 연결 하나를 로그로 남기는 데 필요한 호스트 정체. IPC 계층이 호스트 레코드에서 채운다. */
export interface RdpSessionLifecycleInfo {
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails: string | null;
}

interface RdpLifecycleState extends RdpSessionLifecycleInfo {
  /**
   * 로그 행의 id. SSH 는 세션당 하나(`session:<id>`)지만 RDP 자동 재연결은 sessionId 를
   * 재사용하므로, 세션 id 로만 잡으면 재연결마다 이전 연결 기록이 덮어써진다. 연결 시도마다
   * 고유한 requestId 를 붙여 시도 하나 = 로그 행 하나로 만든다.
   */
  logId: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
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
  private readonly lifecycleBySession = new Map<string, RdpLifecycleState>();

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

  /**
   * 창에 뿌리는 세션 이벤트를 메인 프로세스에서도 본다.
   *
   * 크기가 바뀌면 각 창이 맡을 영역도 다시 정해야 하는데, 그 계산은 창을 들고 있는 쪽
   * (ipc/rdp.ts)만 할 수 있다.
   */
  onSessionEvent: ((event: RdpSessionEvent) => void) | null = null;

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
    lifecycle?: RdpSessionLifecycleInfo,
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

    if (lifecycle) {
      this.lifecycleBySession.set(sessionId, {
        ...lifecycle,
        logId: `session:${sessionId}:${requestId}`,
        connectedAt: null,
        disconnectedAt: null,
      });
    }

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
      // 연결에 이르지 못한 시도는 로그를 남기지 않는다 — 자동 재연결이 백오프로 반복 시도하는
      // 동안 실패 행이 로그를 채우기 때문이다. 실패는 세션 오버레이가 실시간으로 보여준다.
      this.lifecycleBySession.delete(sessionId);
      throw error;
    }
  }

  /**
   * 이 세션을 연 창. 그 창이 닫히면 세션도 끊는다.
   *
   * **픽셀을 보는 창(watcher)과 다르다.** 모니터별 창은 같은 세션을 같이 보지만 세션의 주인이
   * 아니다 — 모니터 창을 닫았다고 세션을 끊으면 본 탭이 죽는다.
   */
  private readonly ownerBySession = new Map<string, number>();

  /** 세션의 주인 창을 기록한다. 접속을 시작한 창이 주인이다. */
  setSessionOwner(sessionId: string, webContentsId: number): void {
    this.ownerBySession.set(sessionId, webContentsId);
  }

  /**
   * 그 창이 열었던 세션을 모두 끊는다. 창이 닫힐 때 부른다.
   *
   * 이것이 없으면 멀티윈도우에서 창 하나를 닫아도 그 창의 원격 화면 세션이 코어에 남는다 —
   * 프레임 전달만 멈추고(watcher 해제) TCP·원격 세션은 앱이 끝날 때까지 살아 있었다.
   */
  disconnectSessionsOwnedBy(webContentsId: number): void {
    for (const [sessionId, ownerId] of Array.from(this.ownerBySession)) {
      if (ownerId !== webContentsId) {
        continue;
      }
      this.ownerBySession.delete(sessionId);
      this.disconnect(sessionId);
    }
  }

  disconnect(sessionId: string): void {
    this.ownerBySession.delete(sessionId);
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

  /**
   * 캡처한 마이크 PCM 을 코어로 넘긴다.
   *
   * 입력과 같은 fire-and-forget 이다 — 초당 수십 번 오고, 늦게 도착한 소리는 값이 없다. 세션이
   * 없거나 마이크를 끈 세션이면 코어가 조용히 버린다.
   *
   * 바이트는 JSON 이 아니라 프레임의 payload 자리로 간다(base64 로 부풀리지 않는다).
   */
  sendMicrophoneAudio(sessionId: string, chunk: Uint8Array): void {
    if (!this.process || !this.sessions.has(sessionId) || chunk.byteLength === 0) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameWithPayload(
        {
          id: `rdp-${++this.requestSeq}`,
          type: "rdpMicAudio",
          sessionId,
          payload: {},
        },
        chunk,
      ),
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

  /**
   * 모니터 배치를 다시 선언한다.
   *
   * 접속할 때는 디스플레이 크기로 선언하는데, 창이 실제로 그릴 수 있는 크기는 그보다 작을 수
   * 있다(노치 있는 맥북은 전체화면이어도 33px 을 못 쓴다). 창을 다 펼친 뒤 실측값으로 다시
   * 선언해야 원격 화면이 그 창에 꼭 맞는다.
   */
  requestLayout(
    sessionId: string,
    monitors: readonly {
      width: number;
      height: number;
      left: number;
      top: number;
      primary: boolean;
    }[],
  ): void {
    if (!this.process || !this.sessions.has(sessionId) || monitors.length === 0) {
      return;
    }
    this.process.stdin.write(
      encodeControlFrameOf({
        id: `rdp-${++this.requestSeq}`,
        type: "rdpSetLayout",
        sessionId,
        payload: { monitors },
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

      // 마이크 협상 결과와 실패 사유는 **렌더러가 받아야** 한다. 사양이 있어야 그 사양대로
      // 마이크를 잡고(코어는 캡처를 안 한다), 실패는 화면에 보여야 한다 — 조용히 실패하면
      // 사용자는 마이크가 켜진 줄 알고 원격에서 말한다.
      //
      // 이 두 케이스가 없던 동안 아래 `default` 가 둘 다 버렸고, 그래서 협상이 서버까지 다
      // 끝났는데도 렌더러는 마이크를 열지 않았다(코어에 PCM 이 한 조각도 오지 않았다).
      case "microphoneFormat": {
        // 이벤트 타입에서 그대로 뽑아 쓴다 — 모양이 바뀌면 여기가 먼저 깨진다.
        const payload = event.payload as Extract<
          RdpSessionEvent,
          { type: "microphoneFormat" }
        >["payload"];
        if (event.sessionId) {
          this.emitEvent({ type: "microphoneFormat", sessionId: event.sessionId, payload });
        }
        return;
      }

      case "microphoneUnavailable": {
        const payload = event.payload as { reason?: "serverRefused" };
        if (event.sessionId) {
          this.emitEvent({
            type: "microphoneUnavailable",
            sessionId: event.sessionId,
            payload: { reason: payload?.reason ?? "serverRefused" },
          });
        }
        return;
      }

      case "resized": {
        const payload = event.payload as {
          desktopWidth: number;
          desktopHeight: number;
          monitors?: RdpMonitorPlacement[];
        };
        if (event.sessionId) {
          const cached = this.connectedBySession.get(event.sessionId);
          // 크기가 바뀌면 각 모니터 몫도 바뀐다. 배치를 안 옮기면 나눠 그리는 창들이 새 크기의
          // 프레임을 옛 사각형으로 잘라, 화면이 어긋난 채로 남는다.
          const monitors = payload.monitors?.length
            ? payload.monitors
            : (cached?.monitors ?? []);
          if (cached) {
            // 나중에 열리는 창이 옛 크기를 받지 않게 캐시도 같이 옮긴다.
            this.connectedBySession.set(event.sessionId, {
              ...cached,
              desktopWidth: payload.desktopWidth,
              desktopHeight: payload.desktopHeight,
              monitors,
            });
          }
          this.emitEvent({
            type: "resized",
            sessionId: event.sessionId,
            desktopWidth: payload.desktopWidth,
            desktopHeight: payload.desktopHeight,
            monitors,
          });
        }
        return;
      }

      case "closed": {
        if (event.sessionId) {
          const payload = event.payload as {
            graceful?: boolean;
            reason?: string;
          };
          this.sessions.delete(event.sessionId);
          // graceful 이면 자동 재연결을 하지 않는다. 이 값을 흘리면 사용자가 로그오프한
          // 세션이 되살아난다.
          this.emitEvent({
            type: "closed",
            sessionId: event.sessionId,
            graceful: payload?.graceful === true,
            reason: payload?.reason ?? null,
          });
        }
        return;
      }

      default:
        return;
    }
  }

  private emitEvent(event: RdpSessionEvent): void {
    // 프로세스 사망이 만드는 합성 closed 까지 전부 이 함수를 지나므로, lifecycle 로그는
    // 여기서 한 번에 처리한다.
    if (event.type === "connected") {
      this.markLifecycleConnected(event.sessionId);
    } else if (event.type === "error") {
      this.finalizeLifecycle(event.sessionId, "error", event.message);
    } else if (event.type === "closed") {
      this.finalizeLifecycle(event.sessionId, "closed", event.reason ?? null);
      this.lifecycleBySession.delete(event.sessionId);
      this.ownerBySession.delete(event.sessionId);
    }
    this.onSessionEvent?.(event);
    this.broadcast("rdp:event", event);
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
    // 연결에 이르지 못했거나(connectedAt 없음) 이미 마감된 시도는 건너뛴다 — error 뒤에
    // closed 가 따라와도 행 하나로 끝난다.
    if (!lifecycle || !lifecycle.connectedAt || lifecycle.disconnectedAt) {
      return;
    }
    const disconnectedAt = new Date().toISOString();
    lifecycle.disconnectedAt = disconnectedAt;
    const durationMs = Math.max(
      0,
      new Date(disconnectedAt).getTime() -
        new Date(lifecycle.connectedAt).getTime(),
    );
    this.upsertLifecycleLog(sessionId, lifecycle, {
      status,
      disconnectedAt,
      durationMs,
      disconnectReason,
      updatedAt: disconnectedAt,
    });
  }

  private upsertLifecycleLog(
    sessionId: string,
    lifecycle: RdpLifecycleState,
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
      connectionKind: "rdp",
      connectedAt: lifecycle.connectedAt,
      disconnectedAt: state.disconnectedAt,
      durationMs: state.durationMs,
      status: state.status,
      disconnectReason: state.disconnectReason,
      recordingId: null,
      hasReplay: false,
    };
    this.options.upsertLogRecord({
      id: lifecycle.logId,
      level: state.status === "error" ? "error" : "info",
      category: "session",
      kind: "session-lifecycle",
      ...logMessage("core.sessionLog", { kind: "RDP" }),
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: lifecycle.connectedAt,
      updatedAt: state.updatedAt,
    });
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
    env: config.env ? { ...process.env, ...config.env } : process.env,
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
      return {
        command: candidate,
        args: [],
        cwd: serviceDir,
        // 개발 중에는 접속 경로까지 보이게 한다.
        //
        // 기본값이 WARN 이라 "어느 주소로 붙었는지" 같은 줄이 안 남고, 붙지 않을 때 tailnet
        // 포워드를 탔는지 원래 주소로 직접 갔는지 구분할 수 없다. 겉으로 쓰는 값은 그대로
        // 존중한다 — DOLGATE_RDP_LOG=debug 로 더 올릴 수 있다.
        env: process.env.DOLGATE_RDP_LOG
          ? undefined
          : { DOLGATE_RDP_LOG: "info" },
      };
    }
  }

  throw new Error(
    "rdp-core binary not found. Build it first: cd services/rdp-core && cargo build",
  );
}
