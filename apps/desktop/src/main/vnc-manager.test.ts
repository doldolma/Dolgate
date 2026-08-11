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
