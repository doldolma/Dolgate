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
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdin = { write: vi.fn(() => true), end: vi.fn() };
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

  it("settles when the core reports the attempt was cancelled", async () => {
    const { manager, child, emitControl } = await startManager();

    const test = manager.testTailnet({ id: "net-1", controlUrl: "" }, () => {});

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

    const test = manager.testTailnet({ id: "net-1", controlUrl: "" }, () => {});
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
      payload: { id: "net-1", state: "running" },
    } as CoreEvent<Record<string, unknown>>);
    expect((await test).state).toBe("running");
  });
});
