import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZmodemController } from "./zmodem-controller";
import type { ZmodemControllerDeps } from "./zmodem-controller";

// 실제 라이브러리 대신 테스트가 주입하는 가짜 Sentry(window.Zmodem)를 쓰도록 정적
// import는 undefined로 모킹한다. 이러면 window.Zmodem 미주입 시 passthrough도 검증된다.
vi.mock("nora-zmodemjs/index.js", () => ({ default: undefined }));

// 테스트가 Sentry 콜백(to_terminal/sender/on_detect)을 직접 구동할 수 있도록 캡처하는
// 가짜 Zmodem.Sentry. window.Zmodem에 주입한다(컨트롤러가 호출 시점에 읽음).
interface CapturedSentry {
  options: {
    to_terminal: (octets: number[] | Uint8Array) => void;
    sender: (octets: number[]) => void;
    on_detect: (detection: unknown) => void;
    on_retract: () => void;
  };
  consume: ReturnType<typeof vi.fn>;
}

let captured: CapturedSentry | null = null;
let consumeShouldThrow = false;

class FakeSentry {
  consume = vi.fn((input: unknown) => {
    if (consumeShouldThrow) {
      consumeShouldThrow = false;
      throw new Error("boom");
    }
    void input;
  });

  constructor(options: CapturedSentry["options"]) {
    captured = { options, consume: this.consume };
  }
}

function makeDeps(
  overrides: Partial<ZmodemControllerDeps> = {},
): ZmodemControllerDeps {
  return {
    sessionId: "s1",
    hostLabel: "host-a",
    writeToTerminal: vi.fn(),
    sendToRemote: vi.fn(),
    saveDownload: vi.fn().mockResolvedValue({ savedPath: "/dl/file.txt" }),
    upsertJob: vi.fn(),
    registerAbort: vi.fn(),
    clearAbort: vi.fn(),
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  captured = null;
  consumeShouldThrow = false;
  (window as unknown as { Zmodem?: unknown }).Zmodem = { Sentry: FakeSentry };
});

afterEach(() => {
  delete (window as unknown as { Zmodem?: unknown }).Zmodem;
});

describe("createZmodemController", () => {
  it("passes raw output to the terminal when Zmodem is unavailable", () => {
    delete (window as unknown as { Zmodem?: unknown }).Zmodem;
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const chunk = new Uint8Array([1, 2, 3]);
    controller.consume(chunk);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(chunk);
  });

  it("feeds chunks to the sentry and forwards normal output via to_terminal", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    controller.consume(new Uint8Array([97]));
    expect(captured?.consume).toHaveBeenCalledTimes(1);
    captured?.options.to_terminal([104, 105]);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(new Uint8Array([104, 105]));
  });

  it("routes ZMODEM replies through sendToRemote", () => {
    const deps = makeDeps();
    createZmodemController(deps);
    captured?.options.sender([24, 66]);
    expect(deps.sendToRemote).toHaveBeenCalledWith(new Uint8Array([24, 66]));
  });

  it("accepts a receive offer, saves merged bytes, and reports completion", async () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);

    let inputHandler: (octets: number[]) => void = () => {};
    let resolveAccept: () => void = () => {};
    const acceptPromise = new Promise<void>((resolve) => {
      resolveAccept = resolve;
    });
    const offer = {
      get_details: () => ({ name: "file.txt", size: 4 }),
      get_offset: () => 0,
      get_payloads: () => [],
      on: (event: string, handler: (octets: number[]) => void) => {
        if (event === "input") inputHandler = handler;
      },
      accept: () => acceptPromise,
      skip: vi.fn(),
    };
    const session = {
      type: "receive" as const,
      on: (event: string, handler: (offer: unknown) => void) => {
        if (event === "offer") handler(offer);
      },
      start: vi.fn(),
      abort: vi.fn(),
      close: vi.fn(),
    };

    controller.consume(new Uint8Array([1]));
    captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });

    inputHandler([1, 2]);
    inputHandler([3, 4]);
    resolveAccept();
    await flush();

    expect(deps.saveDownload).toHaveBeenCalledTimes(1);
    const saveArg = (deps.saveDownload as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(saveArg.name).toBe("file.txt");
    expect(Array.from(saveArg.bytes)).toEqual([1, 2, 3, 4]);

    const jobs = (deps.upsertJob as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    const lastJob = jobs[jobs.length - 1];
    expect(lastJob.status).toBe("completed");
    expect(lastJob.detailMessage).toBe("/dl/file.txt");
    expect(session.start).toHaveBeenCalled();
  });

  it("skips oversized offers and marks them failed", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const skip = vi.fn();
    const offer = {
      get_details: () => ({ name: "huge.bin", size: 600 * 1024 * 1024 }),
      get_offset: () => 0,
      get_payloads: () => [],
      on: vi.fn(),
      accept: vi.fn(),
      skip,
    };
    const session = {
      type: "receive" as const,
      on: (event: string, handler: (offer: unknown) => void) => {
        if (event === "offer") handler(offer);
      },
      start: vi.fn(),
      abort: vi.fn(),
      close: vi.fn(),
    };
    controller.consume(new Uint8Array([1]));
    captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });
    expect(skip).toHaveBeenCalled();
    const jobs = (deps.upsertJob as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    expect(jobs[jobs.length - 1].status).toBe("failed");
  });

  it("aborts send (rz) sessions because upload is handled by SFTP drag", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const session = {
      type: "send" as const,
      on: vi.fn(),
      start: vi.fn(),
      abort: vi.fn(),
      close: vi.fn(),
    };
    controller.consume(new Uint8Array([1]));
    captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });
    expect(session.abort).toHaveBeenCalled();
    expect(session.start).not.toHaveBeenCalled();
  });

  it("aborts the active session on dispose", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const session = {
      type: "receive" as const,
      on: vi.fn(),
      start: vi.fn(),
      abort: vi.fn(),
      close: vi.fn(),
    };
    controller.consume(new Uint8Array([1]));
    captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });
    controller.dispose();
    expect(session.abort).toHaveBeenCalled();
  });

  it("falls back to a raw terminal write when consume throws", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    consumeShouldThrow = true;
    const chunk = new Uint8Array([5, 6, 7]);
    controller.consume(chunk);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(chunk);
  });
});
