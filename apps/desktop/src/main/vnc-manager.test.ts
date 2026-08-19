import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { VncManager, type VncLaunchConfig } from "./vnc-manager";
import { encodeControlFrameOf } from "./core-framing";
import { ipcChannels } from "../common/ipc-channels";

// 가짜 사이드카. stdin 으로 받은 제어 프레임을 그대로 모아 두고, stdout 으로는 우리가 넣어 주는
// 프레임을 흘린다 — 프로토콜 계층은 vnc-core 의 테스트가 보고, 여기서는 배관만 본다.
function fakeCore(): {
  child: ChildProcessWithoutNullStreams;
  written: Buffer[];
  emit: (frame: Buffer) => void;
  exit: (code: number) => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => written.push(chunk));

  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const child = {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    on: (event: string, handler: (value: unknown) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return child;
    },
  } as unknown as ChildProcessWithoutNullStreams;

  return {
    child,
    written,
    emit: (frame: Buffer) => stdout.write(frame),
    exit: (code: number) => {
      for (const handler of listeners.get("exit") ?? []) {
        handler(code);
      }
    },
  };
}

/** 코어가 보내는 stream frame(픽셀). 9바이트 헤더는 core-framing 과 같은 계약이다. */
function streamFrame(metadata: object, payload: Buffer): Buffer {
  const meta = Buffer.from(JSON.stringify(metadata), "utf8");
  const header = Buffer.alloc(9);
  header.writeUInt8(2, 0); // kind = stream
  header.writeUInt32BE(meta.length, 1);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, meta, payload]);
}

function requestsIn(written: Buffer[]): Array<Record<string, unknown>> {
  const combined = Buffer.concat(written);
  const requests: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (offset + 9 <= combined.length) {
    const metaLength = combined.readUInt32BE(offset + 1);
    const payloadLength = combined.readUInt32BE(offset + 5);
    const meta = combined.subarray(offset + 9, offset + 9 + metaLength);
    requests.push(JSON.parse(meta.toString("utf8")));
    offset += 9 + metaLength + payloadLength;
  }
  return requests;
}

function windowStub(id: number) {
  return {
    id,
    isDestroyed: () => false,
    webContents: { id, send: vi.fn() },
  };
}

function managerWith(core: ReturnType<typeof fakeCore>, windows: ReturnType<typeof windowStub>[]) {
  const launch: VncLaunchConfig = { command: "vnc-core", args: [], cwd: "." };
  return new VncManager({
    getWindows: () => windows,
    resolveLaunchConfig: () => launch,
    spawnProcess: () => core.child,
  });
}

describe("VncManager", () => {
  // **창이 닫히면 그 창이 연 세션은 끊어야 한다.**
  //
  // 예전에는 창을 닫아도 코어의 세션이 그대로 남아, 서버 쪽 화면까지 잡은 채 앱이 끝날 때까지
  // 살아 있었다. 멀티윈도우에서 창 하나만 닫는 경우가 그랬다.
  it("주인 창이 닫히면 그 창의 세션을 끊는다", () => {
    const core = fakeCore();
    const manager = managerWith(core, [windowStub(1), windowStub(2)]);

    void manager.connect({ sessionId: "sess-1", host: "10.0.0.5", port: 5901, password: "" });
    void manager.connect({ sessionId: "sess-2", host: "10.0.0.6", port: 5901, password: "" });
    manager.setSessionOwner("sess-1", 1);
    manager.setSessionOwner("sess-2", 2);

    manager.disconnectSessionsOwnedBy(1);

    const closed = requestsIn(core.written)
      .filter((request) => request.type === "disconnectVnc")
      .map((request) => request.sessionId);
    expect(closed).toEqual(["sess-1"]);
  });

  // 모니터별 창처럼 **보기만 하는 창**이 닫혀도 세션은 살아 있어야 한다. 주인과 watcher 를
  // 뒤섞으면 부속 창을 닫는 것만으로 본 탭이 죽는다.
  it("보기만 하는 창이 닫혀도 세션은 끊지 않는다", () => {
    const core = fakeCore();
    const manager = managerWith(core, [windowStub(1), windowStub(2)]);

    void manager.connect({ sessionId: "sess-1", host: "10.0.0.5", port: 5901, password: "" });
    manager.setSessionOwner("sess-1", 1);
    manager.watchSession("sess-1", 2);

    manager.disconnectSessionsOwnedBy(2);

    const closed = requestsIn(core.written).filter(
      (request) => request.type === "disconnectVnc",
    );
    expect(closed).toEqual([]);
  });

  it("connect 요청에 기본 포트·공유 설정을 실어 보낸다", async () => {
    const core = fakeCore();
    const window = windowStub(1);
    const manager = managerWith(core, [window]);

    const connecting = manager.connect({
      sessionId: "sess-1",
      host: "10.0.0.5",
      port: 5901,
      password: "vncpass",
    });

    const [request] = requestsIn(core.written);
    expect(request.type).toBe("connectVnc");
    expect(request.sessionId).toBe("sess-1");
    expect(request.payload).toEqual({
      host: "10.0.0.5",
      port: 5901,
      password: "vncpass",
      // 계정은 VeNCrypt Plain 계열에서만 쓰인다. 비어 있으면 코어가 그 방식을 고르지 않는다.
      username: "",
      // 화질도 비어 있으면 무손실이다 — 코어가 품질을 선언하지 않으므로 서버가 JPEG 를 안 쓴다.
      imageQuality: "",
      // 기본은 공유다 — 끄면 서버가 남의 세션을 끊는다.
      shared: true,
    });

    core.emit(
      encodeControlFrameOf({
        type: "connected",
        requestId: request.id,
        sessionId: "sess-1",
        payload: { desktopWidth: 1280, desktopHeight: 800, name: "lab" },
      }),
    );

    await expect(connecting).resolves.toEqual({
      desktopWidth: 1280,
      desktopHeight: 800,
      name: "lab",
    });
    expect(manager.describeSession("sess-1")).toEqual({
      desktopWidth: 1280,
      desktopHeight: 800,
      name: "lab",
    });
  });

  // 오류를 약속으로 되돌리지 않으면 호출부가 영원히 기다린다. 인증 실패가 이 경로로 온다.
  it("연결 중 오류는 connect 약속을 깨뜨린다", async () => {
    const core = fakeCore();
    const manager = managerWith(core, [windowStub(1)]);

    const connecting = manager.connect({
      sessionId: "sess-1",
      host: "10.0.0.5",
      port: 5900,
    });
    const [request] = requestsIn(core.written);
    core.emit(
      encodeControlFrameOf({
        type: "error",
        requestId: request.id,
        sessionId: "sess-1",
        payload: { message: "authentication failed" },
      }),
    );

    await expect(connecting).rejects.toThrow("authentication failed");
  });

  // 화면 한 장이 수 MB 다. 구독하지 않은 창에 보내면 그만큼 직렬화·복사가 메인에서 나간다.
  it("픽셀은 구독한 창에만 보낸다", () => {
    const core = fakeCore();
    const watching = windowStub(1);
    const idle = windowStub(2);
    const manager = managerWith(core, [watching, idle]);

    void manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });
    manager.watchSession("sess-1", 1);

    core.emit(
      streamFrame(
        {
          type: "vncFrame",
          sessionId: "sess-1",
          x: 4,
          y: 8,
          width: 2,
          height: 1,
        },
        Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]),
      ),
    );

    const frameCalls = watching.webContents.send.mock.calls.filter(
      (call) => call[0] === ipcChannels.vnc.frame,
    );
    expect(frameCalls).toHaveLength(1);
    expect(frameCalls[0][1]).toMatchObject({ sessionId: "sess-1", x: 4, y: 8, width: 2, height: 1 });
    expect(
      idle.webContents.send.mock.calls.filter((call) => call[0] === ipcChannels.vnc.frame),
    ).toHaveLength(0);
  });

  // 접속 기록이 없으면 로그 화면에도, **최근 접속 시각**에도 VNC 가 나타나지 않는다(최근 접속은
  // category 'session' 로그에서 계산된다). RDP 와 같은 모양으로 남긴다.
  it("연결과 종료를 세션 로그로 남긴다", () => {
    const core = fakeCore();
    const records: Array<Record<string, unknown>> = [];
    const manager = new VncManager({
      getWindows: () => [windowStub(1)],
      spawnProcess: () => core.child,
      resolveLaunchConfig: () => ({ command: "vnc-core", args: [], cwd: "." }),
      upsertLogRecord: (record) => records.push(record as unknown as Record<string, unknown>),
    });

    void manager.connect(
      { sessionId: "sess-1", host: "10.0.0.6", port: 5900 },
      {
        hostId: "h1",
        hostLabel: "Lab VNC",
        title: "Lab VNC",
        connectionDetails: "10.0.0.6 · 5900",
      },
    );
    const [request] = requestsIn(core.written);

    core.emit(
      encodeControlFrameOf({
        type: "connected",
        requestId: request.id,
        sessionId: "sess-1",
        payload: { desktopWidth: 1024, desktopHeight: 768, name: "lab" },
      }),
    );

    expect(records).toHaveLength(1);
    const connected = records[0] as { category: string; kind: string; metadata: Record<string, unknown> };
    expect(connected.category).toBe("session");
    expect(connected.kind).toBe("session-lifecycle");
    expect(connected.metadata).toMatchObject({
      hostId: "h1",
      hostLabel: "Lab VNC",
      // 종류가 'rdp' 로 굳어 있으면 로그 표에서 VNC 세션이 RDP 로 보인다.
      connectionKind: "vnc",
      status: "connected",
    });
    expect(typeof connected.metadata.connectedAt).toBe("string");

    core.emit(encodeControlFrameOf({ type: "closed", sessionId: "sess-1" }));

    // 같은 행을 갱신한다(연결 하나 = 로그 한 줄). 새 행을 만들면 표가 두 배로 늘어난다.
    expect(records).toHaveLength(2);
    const closed = records[1] as { id: string; metadata: Record<string, unknown> };
    expect(closed.id).toBe((records[0] as { id: string }).id);
    expect(closed.metadata).toMatchObject({ status: "closed" });
    expect(typeof closed.metadata.disconnectedAt).toBe("string");
    expect(typeof closed.metadata.durationMs).toBe("number");
  });

  // 커서는 픽셀과 같은 stream 경로로 오고 `type` 으로만 갈린다. 이 분기가 없으면(또는 이름이
  // 어긋나면) 커서 프레임이 조용히 버려지고, 서버는 커서를 화면에 그려 주지 않으므로 원격
  // 포인터가 아예 보이지 않는다.
  it("커서 모양을 커서 채널로 보낸다", () => {
    const core = fakeCore();
    const watching = windowStub(1);
    const manager = managerWith(core, [watching]);

    void manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });
    manager.watchSession("sess-1", 1);

    core.emit(
      streamFrame(
        {
          type: "vncCursor",
          sessionId: "sess-1",
          hotspotX: 3,
          hotspotY: 4,
          width: 2,
          height: 1,
        },
        Buffer.from([9, 8, 7, 255, 6, 5, 4, 0]),
      ),
    );

    const cursorCalls = watching.webContents.send.mock.calls.filter(
      (call) => call[0] === ipcChannels.vnc.cursor,
    );
    expect(cursorCalls).toHaveLength(1);
    expect(cursorCalls[0][1]).toMatchObject({
      sessionId: "sess-1",
      hotspotX: 3,
      hotspotY: 4,
      width: 2,
      height: 1,
    });
    // 화면 채널로는 가지 않아야 한다 — 갔으면 커서가 화면 사각형으로 그려진다.
    expect(
      watching.webContents.send.mock.calls.filter(
        (call) => call[0] === ipcChannels.vnc.frame,
      ),
    ).toHaveLength(0);
  });

  it("구독을 끊으면 픽셀이 더 가지 않는다", () => {
    const core = fakeCore();
    const window = windowStub(1);
    const manager = managerWith(core, [window]);
    void manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });

    manager.watchSession("sess-1", 1);
    manager.unwatchSession("sess-1", 1);
    core.emit(
      streamFrame(
        { type: "vncFrame", sessionId: "sess-1", x: 0, y: 0, width: 1, height: 1 },
        Buffer.from([0, 0, 0, 255]),
      ),
    );

    expect(
      window.webContents.send.mock.calls.filter((call) => call[0] === ipcChannels.vnc.frame),
    ).toHaveLength(0);
  });

  // 필드를 하나씩 옮겨 적는 자리다 — 이 저장소에서 가장 자주 새는 모양이라 값으로 고정한다.
  it("협상 결과를 그대로 렌더러에 올린다", () => {
    const core = fakeCore();
    const window = windowStub(1);
    const manager = managerWith(core, [window]);
    void manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });

    core.emit(
      encodeControlFrameOf({
        type: "capabilities",
        sessionId: "sess-1",
        payload: {
          extendedClipboard: false,
          desktopResize: true,
          cursor: true,
          continuousUpdates: true,
          qemuKeys: true,
          tls: false,
          encoding: "zrle",
        },
      }),
    );

    const events = window.webContents.send.mock.calls.filter(
      (call) => call[0] === ipcChannels.vnc.event,
    );
    expect(events.at(-1)?.[1]).toEqual({
      type: "capabilities",
      sessionId: "sess-1",
      payload: {
        extendedClipboard: false,
        desktopResize: true,
        cursor: true,
        continuousUpdates: true,
        qemuKeys: true,
        tls: false,
        encoding: "zrle",
      },
    });
  });

  it("resized 는 저장된 화면 크기를 갱신한다", () => {
    const core = fakeCore();
    const manager = managerWith(core, [windowStub(1)]);
    void manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });
    const [request] = requestsIn(core.written);

    core.emit(
      encodeControlFrameOf({
        type: "connected",
        requestId: request.id,
        sessionId: "sess-1",
        payload: { desktopWidth: 800, desktopHeight: 600, name: "vm" },
      }),
    );
    core.emit(
      encodeControlFrameOf({
        type: "resized",
        sessionId: "sess-1",
        payload: { desktopWidth: 1024, desktopHeight: 768 },
      }),
    );

    // VM 콘솔은 부팅 중에 해상도가 여러 번 바뀐다. 뒤늦게 붙는 창이 이 값을 물어본다.
    expect(manager.describeSession("sess-1")).toEqual({
      desktopWidth: 1024,
      desktopHeight: 768,
      name: "vm",
    });
  });

  // 죽은 세션에 입력을 보내면 코어가 버리기는 하지만, 그 왕복 자체가 낭비다.
  it("끝난 세션에는 입력을 보내지 않는다", () => {
    const core = fakeCore();
    const manager = managerWith(core, [windowStub(1)]);
    void manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });
    core.written.length = 0;

    manager.sendInput("sess-1", [{ kind: "mouseMove", x: 1, y: 2 }]);
    expect(requestsIn(core.written)).toHaveLength(1);

    core.written.length = 0;
    manager.disconnect("sess-1");
    core.written.length = 0;
    manager.sendInput("sess-1", [{ kind: "mouseMove", x: 3, y: 4 }]);
    expect(requestsIn(core.written)).toHaveLength(0);
  });

  // 코어가 죽으면 붙어 있던 세션은 전부 끝난 것으로 알려야 한다. 안 그러면 탭이 살아 있는 척한다.
  it("코어가 죽으면 세션을 닫고 기다리는 약속을 깨뜨린다", async () => {
    const core = fakeCore();
    const window = windowStub(1);
    const manager = managerWith(core, [window]);

    const connecting = manager.connect({ sessionId: "sess-1", host: "h", port: 5900 });
    core.exit(1);

    await expect(connecting).rejects.toThrow(/exited/);
    const closed = window.webContents.send.mock.calls.filter(
      (call) => call[0] === ipcChannels.vnc.event && (call[1] as { type: string }).type === "closed",
    );
    expect(closed).toHaveLength(1);
  });
});
