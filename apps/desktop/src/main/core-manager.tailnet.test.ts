import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent } from "@shared";
import { encodeControlFrame } from "./core-framing";

const { spawnMock, openExternalMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  openExternalMock: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/tmp/dolssh", getPath: () => "/tmp/dolssh-data", isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: openExternalMock },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CoreManager } from "./core-manager";

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();

  const child = new EventEmitter() as EventEmitter & {
    stdin: {
      writable: boolean;
      destroyed: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdin = {
    writable: true,
    destroyed: false,
    write: vi.fn(() => true),
    end: vi.fn(() => {
      child.stdin.writable = false;
    }),
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  child.exitCode = null;
  child.killed = false;

  return {
    child,
    emitControl(event: CoreEvent<Record<string, unknown>>) {
      child.stdout.emit("data", encodeControlFrame(event));
    },
  };
}

// 요청 프레임은 헤더 뒤에 JSON 이 붙은 바이너리다. 여기서는 어떤 요청에 응답할지만 알면 된다.
async function lastRequestId(child: { stdin: { write: { mock: { calls: unknown[][] } } } }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame = child.stdin.write.mock.calls.at(-1)?.[0];
    const id = /"id":"([^"]+)"/.exec(String(frame ?? ""))?.[1];
    if (id) {
      return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("core 로 요청이 나가지 않았다");
}

async function startManager() {
  const fake = createFakeChildProcess();
  spawnMock.mockReturnValue(fake.child);
  const manager = new CoreManager();
  await manager.start();
  return { manager, ...fake };
}

let nextWebContentsId = 1;

// registerWindow 는 webContents.id 와 closed 이벤트를 쓴다. 브로드캐스트만 볼 것이므로
// 그 두 가지만 갖춘 최소 대체물을 쓴다.
function fakeWindow(send: ReturnType<typeof vi.fn>, destroyed: boolean) {
  nextWebContentsId += 1;
  return {
    isDestroyed: () => destroyed,
    webContents: { id: nextWebContentsId, send },
    on: vi.fn(),
  } as unknown as Parameters<CoreManager["registerWindow"]>[0];
}

// 코어가 스스로 하는 일(만료 자동 복구, 취소로 끝난 시도의 마지막 상태)도 화면에 닿아야 한다.
//
// 전에는 화면이 자기가 시작한 시도의 진행만 볼 수 있었다(testTailnet 의 onStatus 콜백뿐).
// 그래서 취소를 눌러도 코어는 제대로 접는데 화면은 낡은 상태를 계속 그려서, 사용자에게는 취소가
// 먹통인 것으로 보였다.
describe("tailnet status broadcast", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    openExternalMock.mockClear();
  });

  it("요청과 무관한 상태도 창으로 흘려보낸다", async () => {
    const { manager, emitControl } = await startManager();
    const send = vi.fn();
    manager.registerWindow(fakeWindow(send, false));

    // requestID 가 없는 상태 = 코어가 스스로 시작한 복구, 또는 취소로 끝난 시도의 마지막 상태.
    emitControl({
      type: "tailnetStatus",
      payload: { id: "net-1", state: "stopped", cancelled: true },
    } as CoreEvent<Record<string, unknown>>);

    const statusCalls = send.mock.calls.filter(([channel]) => channel === "tailnet:status");
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0]?.[1]).toMatchObject({ id: "net-1", cancelled: true });
  });

  it("닫힌 창으로는 보내지 않는다", async () => {
    const { manager, emitControl } = await startManager();
    const send = vi.fn();
    manager.registerWindow(fakeWindow(send, true));

    emitControl({
      type: "tailnetStatus",
      payload: { id: "net-1", state: "stopped" },
    } as CoreEvent<Record<string, unknown>>);

    expect(send).not.toHaveBeenCalled();
  });
});

// 인증 링크가 와도 브라우저가 열리지 않으면 사용자는 인증을 마칠 방법이 없다. 그리고 여는 곳은
// 한 군데여야 한다 — 설정 화면과 호스트 연결 양쪽에서 열면 탭이 두 개 열리고, 설정 화면이 닫혀
// 있으면 아무도 열지 않는다.
describe("tailnet auth url", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    openExternalMock.mockClear();
  });

  it("opens the login page when the core reports one", async () => {
    const { emitControl } = await startManager();

    emitControl({
      type: "tailnetStatus",
      payload: { id: "net-1", state: "needsAuth", authUrl: "https://login.example.com/a/x" },
    } as CoreEvent<Record<string, unknown>>);

    expect(openExternalMock).toHaveBeenCalledWith("https://login.example.com/a/x");
  });

  // 연결을 여러 번 시도하면 같은 URL 이 반복해서 온다.
  it("opens each login page once", async () => {
    const { emitControl } = await startManager();
    const event = {
      type: "tailnetStatus",
      payload: { id: "net-1", state: "needsAuth", authUrl: "https://login.example.com/a/x" },
    } as CoreEvent<Record<string, unknown>>;

    emitControl(event);
    emitControl(event);

    expect(openExternalMock).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for states that carry no login url", async () => {
    const { emitControl } = await startManager();

    emitControl({
      type: "tailnetStatus",
      payload: { id: "net-1", state: "needsAuth" },
    } as CoreEvent<Record<string, unknown>>);

    expect(openExternalMock).not.toHaveBeenCalled();
  });
});

// 취소는 실패가 아니라서 코어가 오류 없이 끝낸다. 그래서 마지막 상태 이벤트가 시도의 끝을
// 말해 주지 않으면 요청이 타임아웃까지 매달리고, 화면에서는 취소를 눌러도 아무 일이 없다.
describe("tailnet test completion", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    openExternalMock.mockClear();
  });

  // 코어는 이 config 로 저장된 설정을 통째로 덮어쓴다(TailnetTest → configs.set). 그래서 여기서
  // 필드를 빠뜨리면 그 값이 지워지고, 다음에 만들어지는 노드가 옛 설정으로 뜬다. 노드 이름이
  // 그렇게 세 번 유실됐다 — 설정 읽기·연결 테스트 IPC·이 페이로드 조립 세 곳 모두 화이트리스트라,
  // 새 필드를 더할 때 한 곳만 빠뜨려도 화면에는 저장된 것처럼 보이면서 반영만 안 된다.
  it("carries the whole config into the core, including the node name", async () => {
    const { manager, child } = await startManager();

    void manager.testTailnet(
      {
        id: "net-1",
        controlUrl: "https://headscale.example.com",
        authKey: "tskey-abc",
        ephemeral: false,
        hostname: "work-laptop",
      },
      () => {},
    );
    await lastRequestId(child);

    const frame = String(child.stdin.write.mock.calls.at(-1)?.[0]);
    const sent = JSON.parse(/(\{.*\})\s*$/s.exec(frame)?.[1] ?? "{}");
    expect(sent.payload.config).toMatchObject({
      id: "net-1",
      controlUrl: "https://headscale.example.com",
      authKey: "tskey-abc",
      ephemeral: false,
      hostname: "work-laptop",
    });
  });

  it("settles when the core reports the attempt was cancelled", async () => {
    const { manager, child, emitControl } = await startManager();

    const test = manager.testTailnet(
      { id: "net-1", controlUrl: "", hostname: undefined },
      () => {},
    );

    const requestId = await lastRequestId(child);

    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: { id: "net-1", state: "needsAuth" },
    } as CoreEvent<Record<string, unknown>>);
    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: { id: "net-1", state: "stopped", cancelled: true },
    } as CoreEvent<Record<string, unknown>>);

    const final = await test;
    expect(final.state).toBe("stopped");
    expect(final.cancelled).toBe(true);
  });

  it("keeps waiting while the node is still coming up", async () => {
    const { manager, child, emitControl } = await startManager();

    const test = manager.testTailnet(
      { id: "net-1", controlUrl: "", hostname: undefined },
      () => {},
    );
    const requestId = await lastRequestId(child);

    // 노드가 아직 안 올라온 구간에서도 stopped 가 온다 — 그것만으로 끝내면 즉시 실패한다.
    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: { id: "net-1", state: "stopped" },
    } as CoreEvent<Record<string, unknown>>);

    let settled = false;
    void test.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: { id: "net-1", state: "running", ready: true },
    } as CoreEvent<Record<string, unknown>>);
    expect((await test).state).toBe("running");
  });

  // 코어는 폴링마다 상태를 흘려보내고, 그중에 "running 이지만 아직 준비 안 됨"이 섞여 있다
  // (컨트롤 플레인과 동기화 전, 만료 확인 전). 그것을 종료로 보면 관문이 준비되기 전에 실패를
  // 받고, 화면은 잠시 뒤 전부 정상으로 보인다 — "설정에서는 연결됐다는데 연결이 안 된다".
  it("running 이어도 준비되지 않았으면 끝내지 않는다", async () => {
    const { manager, child, emitControl } = await startManager();

    const test = manager.testTailnet(
      { id: "net-1", controlUrl: "", hostname: undefined },
      () => {},
    );
    const requestId = await lastRequestId(child);

    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: { id: "net-1", state: "running", ready: false, online: false },
    } as CoreEvent<Record<string, unknown>>);

    let settled = false;
    void test.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: { id: "net-1", state: "running", ready: true, online: true },
    } as CoreEvent<Record<string, unknown>>);

    const final = await test;
    expect(final.ready).toBe(true);
  });

  // 코어는 동기화가 끊긴 채로 진행하기로 결정할 수 있다(degraded). 그것이 마지막 이벤트이고 뒤로는
  // 아무것도 오지 않으므로, 종료로 보지 않으면 통과한 요청이 한도(3분)까지 매달린다 — 화면에는
  // 스피너만 남고, 실제로는 연결이 진행될 수 있었던 상태다.
  it("동기화가 끊긴 채 진행하기로 한 것도 종료로 본다", async () => {
    const { manager, child, emitControl } = await startManager();

    const test = manager.testTailnet(
      { id: "net-1", controlUrl: "", hostname: undefined },
      () => {},
    );
    const requestId = await lastRequestId(child);

    emitControl({
      type: "tailnetStatus",
      requestId,
      payload: {
        id: "net-1",
        state: "running",
        ready: false,
        authorized: true,
        online: false,
        degraded: true,
      },
    } as CoreEvent<Record<string, unknown>>);

    const final = await test;
    expect(final.degraded).toBe(true);
    // ready 라고 뒤집지 않는다. 다른 판정이고, 화면은 이 차이로 경고를 그린다.
    expect(final.ready).toBe(false);
    expect(final.authorized).toBe(true);
  });
});
