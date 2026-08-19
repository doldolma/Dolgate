import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ActivityLogRecord, SessionLifecycleLogMetadata } from "@shared";
import { CoreFrameParser, encodeControlFrame, encodeStreamFrame } from "./core-framing";
import { RdpManager, type RdpLaunchConfig } from "./rdp-manager";

// rdp-core 대역. stdin 으로 들어온 프레임을 모아두고, stdout 으로는 원하는 프레임을 밀어넣는다.
function createFakeCore() {
  const stdin = {
    written: [] as Buffer[],
    write(chunk: Buffer) {
      stdin.written.push(chunk);
      return true;
    },
    end: vi.fn(),
  };
  const stdout = new EventEmitter();
  // 매니저가 stderr 를 읽는다(파이프가 차면 코어가 멈추므로). 대역에도 있어야 한다.
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
  });

  return {
    child: child as never,
    stdin,
    emit(frame: Buffer) {
      stdout.emit("data", frame);
    },
    exit(code: number) {
      child.emit("exit", code);
    },
    // 매니저가 stdin 으로 보낸 control 요청들을 되읽는다.
    requests() {
      const parser = new CoreFrameParser();
      return stdin.written.flatMap((chunk) => parser.push(chunk));
    },
  };
}

function createManager() {
  const core = createFakeCore();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const otherSent: Array<{ channel: string; payload: unknown }> = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
      id: 1,
    },
  };

  const other = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        otherSent.push({ channel, payload });
      },
      id: 2,
    },
  };

  const launch: RdpLaunchConfig = { command: "rdp-core", args: [], cwd: "." };
  const logs: ActivityLogRecord[] = [];
  const manager = new RdpManager({
    getWindows: () => [window, other],
    resolveLaunchConfig: () => launch,
    spawnProcess: () => core.child,
    upsertLogRecord: (record) => logs.push(record),
  });

  return { manager, core, sent, otherSent, logs };
}

const CONNECT = {
  host: "10.0.0.1",
  username: "user",
  password: "secret",
  monitors: [{ width: 1920, height: 1080, primary: true }],
};

function connectedFrame(requestId: string, sessionId: string) {
  return encodeControlFrame({
    type: "connected",
    requestId,
    sessionId,
    payload: {
      desktopWidth: 1920,
      desktopHeight: 1080,
      monitors: [{ index: 0, left: 0, top: 0, width: 1920, height: 1080 }],
    },
  } as never);
}

describe("RdpManager", () => {
  it("sends a connectRdp request and resolves once the core confirms", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);

    const requests = core.requests();
    expect(requests).toHaveLength(1);
    const request = requests[0].metadata as unknown as {
      id: string;
      type: string;
      sessionId: string;
      payload: typeof CONNECT;
    };
    expect(request.type).toBe("connectRdp");
    expect(request.sessionId).toBe("sess-1");
    expect(request.payload.host).toBe("10.0.0.1");

    core.emit(connectedFrame(request.id, "sess-1"));

    await expect(pending).resolves.toEqual({
      desktopWidth: 1920,
      desktopHeight: 1080,
      monitors: [{ index: 0, left: 0, top: 0, width: 1920, height: 1080 }],
    });
  });

  // **마이크 이벤트를 렌더러까지 보내야 한다.** 캡처는 렌더러가 하고, 그 사양은 서버가 정한다 —
  // 이 이벤트가 중간에서 사라지면 협상이 서버까지 다 끝나도 마이크가 열리지 않는다(실측: 코어에
  // PCM 이 한 조각도 오지 않았다). 실패 사유도 같은 이유로 보여야 한다.
  it("forwards the microphone format and unavailability to the renderer", async () => {
    const { manager, core, sent } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    core.emit(
      encodeControlFrame({
        type: "microphoneFormat",
        sessionId: "sess-1",
        payload: { sampleRate: 44100, channels: 2, bitsPerSample: 16, framesPerPacket: 441 },
      } as never),
    );
    core.emit(
      encodeControlFrame({
        type: "microphoneUnavailable",
        sessionId: "sess-1",
        payload: { reason: "serverRefused" },
      } as never),
    );

    const events = sent.map((entry) => entry.payload as { type: string; payload?: unknown });
    expect(events.find((event) => event.type === "microphoneFormat")?.payload).toEqual({
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16,
      framesPerPacket: 441,
    });
    expect(events.find((event) => event.type === "microphoneUnavailable")?.payload).toEqual({
      reason: "serverRefused",
    });
  });

  // **창이 닫히면 그 창이 연 세션은 끊어야 한다.** 예전에는 프레임 전달만 멈추고(watcher 해제)
  // 코어의 세션은 그대로 남아, 원격 윈도우 세션까지 잡은 채 앱이 끝날 때까지 살아 있었다.
  it("disconnects the sessions owned by a window that closed", async () => {
    const { manager, core } = createManager();

    const first = manager.connect("sess-1", CONNECT);
    core.emit(connectedFrame((core.requests()[0].metadata as unknown as { id: string }).id, "sess-1"));
    await first;
    manager.setSessionOwner("sess-1", 1);

    const second = manager.connect("sess-2", CONNECT);
    const secondId = (core.requests().at(-1)!.metadata as unknown as { id: string }).id;
    core.emit(connectedFrame(secondId, "sess-2"));
    await second;
    manager.setSessionOwner("sess-2", 2);

    manager.disconnectSessionsOwnedBy(1);

    const closed = core
      .requests()
      .map((request) => request.metadata as unknown as { type: string; sessionId?: string })
      .filter((request) => request.type === "disconnect")
      .map((request) => request.sessionId);
    expect(closed).toEqual(["sess-1"]);
  });

  // 모니터별 창처럼 **보기만 하는 창**이 닫혀도 세션은 살아 있어야 한다. 주인과 watcher 를
  // 뒤섞으면 모니터 창을 닫는 것만으로 본 탭이 죽는다.
  it("keeps the session when a window that only watches it closes", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    core.emit(connectedFrame((core.requests()[0].metadata as unknown as { id: string }).id, "sess-1"));
    await pending;
    manager.setSessionOwner("sess-1", 1);
    manager.watchSession("sess-1", 2);

    manager.disconnectSessionsOwnedBy(2);

    const closed = core
      .requests()
      .map((request) => request.metadata as unknown as { type: string })
      .filter((request) => request.type === "disconnect");
    expect(closed).toEqual([]);
  });

  it("rejects the connect when the core reports an error", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };

    core.emit(
      encodeControlFrame({
        type: "error",
        requestId: request.id,
        sessionId: "sess-1",
        payload: { message: "auth failed" },
      } as never),
    );

    await expect(pending).rejects.toThrow("auth failed");

    // 실패한 세션은 등록이 풀려야 같은 id 로 다시 붙일 수 있다.
    const retry = manager.connect("sess-1", CONNECT);
    expect(core.requests()).toHaveLength(2);
    retry.catch(() => {});
  });

  it("forwards pixel frames on the dedicated channel", async () => {
    const { manager, core, sent } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    core.emit(
      encodeStreamFrame(
        {
          type: "rdpFrame",
          sessionId: "sess-1",
          x: 16,
          y: 32,
          width: 2,
          height: 1,
        } as never,
        pixels,
      ),
    );

    const frame = sent.find((entry) => entry.channel === "rdp:frame");
    expect(frame?.payload).toEqual({
      sessionId: "sess-1",
      x: 16,
      y: 32,
      width: 2,
      height: 1,
      pixels,
    });
  });

  it("sends pixels only to the windows watching that session", async () => {
    // IPC 는 structured clone 이라 창마다 전체 복사본이 생긴다. 1920x1080 전체 갱신 한 번이
    // 8.3MB 라, 상관없는 창까지 뿌리면 창 수만큼 그대로 곱해진다.
    const { manager, core, sent, otherSent } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    manager.watchSession("sess-1", 1);
    sent.length = 0;
    otherSent.length = 0;

    core.emit(
      encodeStreamFrame(
        {
          type: "rdpFrame",
          sessionId: "sess-1",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        } as never,
        new Uint8Array([1, 2, 3, 4]),
      ),
    );

    expect(sent.filter((e) => e.channel === "rdp:frame")).toHaveLength(1);
    expect(otherSent.filter((e) => e.channel === "rdp:frame")).toHaveLength(0);
  });

  it("stops sending once the last watcher goes away", async () => {
    const { manager, core, sent, otherSent } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    manager.watchSession("sess-1", 1);
    manager.unwatchSession("sess-1", 1);
    sent.length = 0;
    otherSent.length = 0;

    core.emit(
      encodeStreamFrame(
        { type: "rdpFrame", sessionId: "sess-1", x: 0, y: 0, width: 1, height: 1 } as never,
        new Uint8Array([1, 2, 3, 4]),
      ),
    );

    // 아무도 안 보면 등록이 비고, 그때는 다시 전체로 떨어진다(첫 프레임을 놓치지 않기 위해).
    expect(sent.filter((e) => e.channel === "rdp:frame")).toHaveLength(1);
    expect(otherSent.filter((e) => e.channel === "rdp:frame")).toHaveLength(1);
  });

  it("drops a closed window from every session", async () => {
    const { manager, core, sent, otherSent } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    manager.watchSession("sess-1", 1);
    manager.watchSession("sess-1", 2);
    // 창이 닫히면 죽은 id 가 남지 않아야 한다.
    manager.forgetWatcher(2);
    sent.length = 0;
    otherSent.length = 0;

    core.emit(
      encodeStreamFrame(
        { type: "rdpFrame", sessionId: "sess-1", x: 0, y: 0, width: 1, height: 1 } as never,
        new Uint8Array([1, 2, 3, 4]),
      ),
    );

    expect(sent.filter((e) => e.channel === "rdp:frame")).toHaveLength(1);
    expect(otherSent.filter((e) => e.channel === "rdp:frame")).toHaveLength(0);
  });

  it("does not repaint just because a window started watching", async () => {
    // 창이 붙을 때마다 전체 화면(8MB)을 흘리면 등록이 조금만 잦아도 파이프를 다 먹는다 —
    // 화면이 초당 한두 장으로 떨어지고 stdout 을 같이 쓰는 오디오까지 끊긴다.
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    const before = core.requests().length;
    manager.watchSession("sess-1", 2);

    expect(core.requests()).toHaveLength(before);
  });

  it("accepts a multi-monitor layout", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", {
      ...CONNECT,
      monitors: [
        { width: 1920, height: 1080, primary: true },
        { width: 1920, height: 1080, left: 1920 },
      ],
    });

    const request = core.requests()[0].metadata as unknown as {
      id: string;
      payload: { monitors: unknown[] };
    };
    expect(request.payload.monitors).toHaveLength(2);

    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;
  });

  it("refuses a layout larger than the protocol allows", async () => {
    const { manager } = createManager();

    await expect(
      manager.connect("sess-1", {
        ...CONNECT,
        monitors: Array.from({ length: 17 }, (_, index) => ({
          width: 1920,
          height: 1080,
          left: index * 1920,
          primary: index === 0,
        })),
      }),
    ).rejects.toThrow(/at most 16 monitors/);
  });

  it("refuses an empty layout", async () => {
    const { manager } = createManager();

    await expect(
      manager.connect("sess-1", { ...CONNECT, monitors: [] }),
    ).rejects.toThrow(/at least one monitor/);
  });

  it("rejects a duplicate session id", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    await expect(manager.connect("sess-1", CONNECT)).rejects.toThrow(/already exists/);
  });

  it("closes every live session when the core exits", async () => {
    const { manager, core, sent } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    core.exit(1);

    const closed = sent.filter(
      (entry) =>
        entry.channel === "rdp:event" &&
        (entry.payload as { type: string }).type === "closed",
    );
    expect(closed).toHaveLength(1);
    expect((closed[0].payload as { sessionId: string }).sessionId).toBe("sess-1");
  });

  it("fails an in-flight connect when the core dies mid-handshake", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    core.exit(101);

    await expect(pending).rejects.toThrow(/exited/);
  });

  it("sends a disconnect request for a live session", async () => {
    const { manager, core } = createManager();

    const pending = manager.connect("sess-1", CONNECT);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    manager.disconnect("sess-1");

    const kinds = core.requests().map((frame) => (frame.metadata as unknown as { type: string }).type);
    expect(kinds).toEqual(["connectRdp", "disconnect"]);
  });

  it("ignores a disconnect for a session it does not know", () => {
    const { manager, core } = createManager();

    manager.disconnect("ghost");

    expect(core.requests()).toHaveLength(0);
  });
});

describe("session lifecycle logs", () => {
  const LIFECYCLE = {
    hostId: "host-1",
    hostLabel: "Work PC",
    title: "Work PC",
    connectionDetails: "10.0.0.1 · 3389 · user",
  };

  function closedFrame(sessionId: string, reason: string | null = null) {
    return encodeControlFrame({
      type: "closed",
      sessionId,
      payload: { graceful: true, reason },
    } as never);
  }

  function metadataOf(record: ActivityLogRecord): SessionLifecycleLogMetadata {
    return record.metadata as unknown as SessionLifecycleLogMetadata;
  }

  it("records connect and close on one row, with the duration", async () => {
    const { manager, core, logs } = createManager();

    const pending = manager.connect("sess-1", CONNECT, LIFECYCLE);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe(`session:sess-1:${request.id}`);
    expect(logs[0].category).toBe("session");
    expect(logs[0].kind).toBe("session-lifecycle");
    const connected = metadataOf(logs[0]);
    expect(connected.status).toBe("connected");
    expect(connected.connectionKind).toBe("rdp");
    expect(connected.hostId).toBe("host-1");
    expect(connected.durationMs).toBeNull();

    core.emit(closedFrame("sess-1", "logoff"));

    expect(logs).toHaveLength(2);
    expect(logs[1].id).toBe(logs[0].id);
    const closed = metadataOf(logs[1]);
    expect(closed.status).toBe("closed");
    expect(closed.disconnectedAt).toBeTruthy();
    expect(typeof closed.durationMs).toBe("number");
    expect(closed.disconnectReason).toBe("logoff");
  });

  it("does not log attempts that never connected", async () => {
    const { manager, core, logs } = createManager();

    const pending = manager.connect("sess-1", CONNECT, LIFECYCLE);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(
      encodeControlFrame({
        type: "error",
        requestId: request.id,
        sessionId: "sess-1",
        payload: { message: "auth failed" },
      } as never),
    );

    await expect(pending).rejects.toThrow("auth failed");
    expect(logs).toHaveLength(0);
  });

  it("records a core death as a closed session", async () => {
    const { manager, core, logs } = createManager();

    const pending = manager.connect("sess-1", CONNECT, LIFECYCLE);
    const request = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(request.id, "sess-1"));
    await pending;

    core.exit(1);

    expect(logs).toHaveLength(2);
    const closed = metadataOf(logs[1]);
    expect(closed.status).toBe("closed");
    expect(typeof closed.durationMs).toBe("number");
  });

  it("gives each reconnect attempt its own log row", async () => {
    const { manager, core, logs } = createManager();

    const first = manager.connect("sess-1", CONNECT, LIFECYCLE);
    const firstRequest = core.requests()[0].metadata as unknown as { id: string };
    core.emit(connectedFrame(firstRequest.id, "sess-1"));
    await first;
    core.emit(closedFrame("sess-1"));

    // 자동 재연결은 같은 sessionId 로 다시 붙는다 — 이전 연결의 기록이 덮어써지면 안 된다.
    const second = manager.connect("sess-1", CONNECT, LIFECYCLE);
    const secondRequest = core.requests()[1].metadata as unknown as { id: string };
    core.emit(connectedFrame(secondRequest.id, "sess-1"));
    await second;

    expect(logs).toHaveLength(3);
    expect(logs[2].id).not.toBe(logs[0].id);
    expect(metadataOf(logs[2]).status).toBe("connected");
  });
});
