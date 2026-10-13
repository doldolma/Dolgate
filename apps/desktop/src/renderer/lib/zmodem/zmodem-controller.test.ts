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
  it('reads late connection capabilities without replacing its sentry', () => {
    let enabled = false;
    const deps = makeDeps({ enabled: () => enabled });
    const controller = createZmodemController(deps);
    const original = captured;
    // 시작 신호의 첫 글자('*'). 그냥 글자는 감지기를 건너뛰므로 감지기까지 가는 바이트로 본다.
    const chunk = Uint8Array.of(42);
    controller.consume(chunk);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(chunk);
    expect(captured?.consume).not.toHaveBeenCalled();
    enabled = true;
    controller.consume(chunk);
    expect(captured).toBe(original);
    expect(captured?.consume).toHaveBeenCalledWith(chunk);
    controller.dispose();
  });
  it('drains a skipped transfer without awaiting accept or leaking bytes', async () => {
    let enabled = true;
    const deps = makeDeps({ enabled: () => enabled });
    const controller = createZmodemController(deps);
    let input: (bytes: number[]) => void = () => {};
    let finishSkip: () => void = () => {};
    let endSession: () => void = () => {};
    const offer = {
      get_details: () => ({ name: 'large.bin', size: 100 * 1024 * 1024 }),
      on: (_: string, handler: typeof input) => { input = handler; },
      accept: () => new Promise(() => {}),
      skip: vi.fn(() => new Promise<void>(resolve => { finishSkip = resolve; })),
    };
    const session = {
      type: 'receive',
      on: (event: string, handler: any) => {
        if (event === 'offer') handler(offer);
        if (event === 'session_end') endSession = handler;
      },
      start: vi.fn(), abort: vi.fn(),
    };
    captured?.options.on_detect({ confirm: () => session });
    // 메타데이터 변경은 이미 진행 중인 수신/취소 파서를 끊으면 안 된다.
    enabled = false;
    controller.consume(Uint8Array.of(1, 2, 3));
    expect(captured?.consume).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
    const cancel = vi.mocked(deps.registerAbort).mock.calls[0][1];
    cancel(); cancel();
    input([1, 2, 3]);
    captured?.options.to_terminal([4, 5, 6]);
    expect(offer.skip).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).not.toHaveBeenCalled();
    endSession(); finishSkip();
    await flush();
    expect(vi.mocked(deps.upsertJob).mock.lastCall?.[0].status).toBe('cancelled');
    expect(deps.saveDownload).not.toHaveBeenCalled();
    captured?.options.to_terminal([36, 32]);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(Uint8Array.of(36, 32));
    controller.dispose();
  });
  it("passes raw output to the terminal when Zmodem is unavailable", () => {
    delete (window as unknown as { Zmodem?: unknown }).Zmodem;
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const chunk = new Uint8Array([1, 2, 3]);
    controller.consume(chunk);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(chunk);
  });

  // 감지기는 조각마다 바이트를 숫자 배열로 바꿔 쌓아서, 출력이 쏟아지면 화면이 따라가지 못했다.
  // 전송이 시작될 수 없는 조각('*'·ZDLE 가 없다)은 감지기를 건너뛴다.
  it("feeds only chunks that could start a transfer to the sentry, and writes the rest directly", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const plain = new Uint8Array([97]);
    controller.consume(plain);
    expect(captured?.consume).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).toHaveBeenCalledWith(plain);

    controller.consume(new Uint8Array([42]));
    expect(captured?.consume).toHaveBeenCalledTimes(1);
    captured?.options.to_terminal([104, 105]);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(new Uint8Array([104, 105]));
  });

  // 시작 신호는 ZDLE 뒤로 20바이트 남짓이 더 이어지고, 그 꼬리가 다음 조각으로 넘어가면 꼬리에는
  // '*'·ZDLE 가 없다. 그래도 감지기에 넣어야 전송을 놓치지 않는다.
  it("keeps feeding the sentry right after a chunk that may start a transfer", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    controller.consume(new Uint8Array([42, 42, 24]));
    const tail = new TextEncoder().encode("B00000000000000\r\n");
    controller.consume(tail);
    expect(captured?.consume).toHaveBeenLastCalledWith(tail);

    // 꼬리 몫(64바이트)이 지나면 다시 바로 화면으로 간다.
    controller.consume(new Uint8Array(64).fill(97));
    const after = new Uint8Array([98]);
    controller.consume(after);
    expect(captured?.consume).not.toHaveBeenCalledWith(after);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(after);
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
    const failing = captured;
    consumeShouldThrow = true;
    // ZDLE 가 든 조각이라야 감지기까지 간다(그냥 글자는 감지기를 건너뛴다).
    const chunk = new Uint8Array([5, 24, 7]);
    controller.consume(chunk);
    expect(failing?.consume).toHaveBeenCalledWith(chunk);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(chunk);
  });
});
