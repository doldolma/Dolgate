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

  // 코어가 출력을 32KB 까지 합쳐 보내면 '*' 는 아무 출력에나 들어 있다. 시작 신호는 늘 ZDLE 를 품으므로,
  // ZDLE 가 없고 '*' 로 끝나지도 않는 조각은 '*' 가 있어도 감지기를 건너뛴다.
  it("writes a chunk with asterisks straight to the terminal when it can't start a transfer", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const code = new TextEncoder().encode("/* comment */\nint *p = &x;\n");
    controller.consume(code);
    expect(captured?.consume).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).toHaveBeenCalledWith(code);

    // '*' 로 끝나면 다음 조각에서 신호가 이어질 수 있어 감지기로 간다.
    const trailing = new TextEncoder().encode("ready **");
    controller.consume(trailing);
    expect(captured?.consume).toHaveBeenCalledWith(trailing);
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

  // 이스케이프 요청은 라이브러리 내부 메서드(_send_ZRINIT)를 덮어서 건다. 그 메서드가 없는 세션(판이 바뀜)은
  // 덮지 않고 예전처럼 시작한다.
  it("starts a session without library internals as before, without asking for escapes", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const session = { type: "receive" as const, on: vi.fn(), start: vi.fn(), abort: vi.fn() };
    controller.consume(new Uint8Array([1]));
    captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session).not.toHaveProperty("_send_ZRINIT");
    controller.dispose();
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

  // 원격 sz(lrzsz)가 "OO" 없이 끝나면 라이브러리는 ZFIN 뒤에 온 셸 프롬프트에 예외를 던진다. 파일은 이미
  // 다 받았으므로 정상 종료로 다루고 그 프롬프트를 화면에 보낸다 — 예전에는 그 탭의 출력이 영영 버려졌다.
  it("finishes the session and shows the shell output when the sender ends without OO", () => {
    const deps = makeDeps();
    const controller = createZmodemController(deps);
    const session = {
      type: "receive" as const,
      _got_ZFIN: false,
      _input_buffer: [] as number[],
      on: vi.fn(),
      start: vi.fn(),
      abort: vi.fn(),
    };
    controller.consume(new Uint8Array([24]));
    captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });

    const prompt = new TextEncoder().encode("\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    session._got_ZFIN = true;
    session._input_buffer = Array.from(prompt);
    captured?.consume.mockImplementationOnce(() => {
      throw "PROTOCOL: Only thing after ZFIN should be “OO” (79,79), not: 27,93";
    });
    controller.consume(prompt);

    // 받을 sz 가 없으니 취소 바이트를 보내지 않는다(셸에 ^X 로 들어간다).
    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.sendToRemote).not.toHaveBeenCalled();
    const written = vi.mocked(deps.writeToTerminal).mock.calls.map((call) => new TextDecoder().decode(call[0]));
    expect(written).toEqual([new TextDecoder().decode(prompt)]);

    // 그 뒤 출력은 감지기를 거치지 않고 그대로 화면으로 간다.
    const next = new TextEncoder().encode("ls\r\n");
    controller.consume(next);
    expect(deps.writeToTerminal).toHaveBeenLastCalledWith(next);
  });

  // 전송 중 파싱이 깨지면 세션을 끊고 남은 이진 조각은 버린다. 그것이 그치고 셸 출력이 오면 다시 화면에
  // 보낸다 — 예전에는 격리가 끝나지 않아 그 탭이 굳었다.
  describe("after a broken transfer (quarantine)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function breakTransfer() {
      const deps = makeDeps();
      const controller = createZmodemController(deps);
      const session = { type: "receive" as const, on: vi.fn(), start: vi.fn(), abort: vi.fn() };
      controller.consume(new Uint8Array([24]));
      captured?.options.on_detect({ confirm: () => session, deny: vi.fn() });
      consumeShouldThrow = true;
      controller.consume(new Uint8Array([24, 1, 2]));
      expect(session.abort).toHaveBeenCalled();
      vi.mocked(deps.writeToTerminal).mockClear();
      return { deps, controller };
    }

    it("lifts the quarantine once plain output resumes", () => {
      const { deps, controller } = breakTransfer();

      controller.consume(new Uint8Array([24, 9, 9]));
      expect(deps.writeToTerminal).not.toHaveBeenCalled();

      // 바로 내보내지 않고 잠깐 붙잡아 둔다 — 아직 오는 전송 데이터일 수 있다.
      const prompt = new TextEncoder().encode("$ ");
      controller.consume(prompt);
      expect(deps.writeToTerminal).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(deps.writeToTerminal).toHaveBeenCalledWith(prompt);

      // 격리가 끝났으니 그 뒤 출력은 바로 간다.
      const next = new TextEncoder().encode("ls\r\n");
      controller.consume(next);
      expect(deps.writeToTerminal).toHaveBeenLastCalledWith(next);
    });

    // 프레임이 큰 전송(sz -8)은 데이터 조각에도 ZDLE 가 없다. 첫 조각에서 바로 풀어 파일 내용이 화면에
    // 쏟아졌다(실측).
    it("drops plain-looking chunks when transfer data follows them", () => {
      const { deps, controller } = breakTransfer();

      controller.consume(new TextEncoder().encode("12345\n12346\n"));
      vi.advanceTimersByTime(100);
      controller.consume(new Uint8Array([0x31, 24, 0x68, 0x32]));
      vi.advanceTimersByTime(1000);
      expect(deps.writeToTerminal).not.toHaveBeenCalled();
    });

    // 셸 통합의 "명령 끝" 표시(OSC 133;D)부터는 셸 출력이다. 그 앞에 같이 온 전송 찌꺼기는 버린다(실측: 멈춘
    // sz 를 끝낸 뒤 파일 데이터 조각이 프롬프트 앞에 풀려 나왔다).
    it.each([
      ["in one chunk", [[0x20, 0x3d, 0x7a, 0x5e, 0x2d, ...new TextEncoder().encode("\x1b]133;D;128\x07$ ")]]],
      [
        "with the marker split across chunks",
        [[0x20, 0x3d, 0x7a, 0x5e, 0x2d, 0x1b, 0x5d, 0x31], [...new TextEncoder().encode("33;D;128\x07$ ")]],
      ],
    ])("drops transfer residue before the shell's command-finished marker (%s)", (_label, chunks) => {
      const { deps, controller } = breakTransfer();

      for (const chunk of chunks) {
        controller.consume(Uint8Array.from(chunk));
      }
      vi.advanceTimersByTime(1000);
      const written = vi.mocked(deps.writeToTerminal).mock.calls.map(([bytes]) => new TextDecoder().decode(bytes));
      expect(written.join("")).toBe("\x1b]133;D;128\x07$ ");
    });

    // sz 는 취소를 받으면 CAN 10개 + BS 10개를 보내고 끝난다. 그 뒤는 셸 출력이다 — 같은 조각에 붙어 와도
    // 버리지 않고 바로 보낸다(예전에는 조각째 버려 프롬프트가 사라졌다).
    it.each([
      ["in one chunk", [[...Array(10).fill(24), ...Array(10).fill(8), 0x24, 0x20]]],
      ["split across chunks", [[0x31, 24, 0x32, ...Array(10).fill(24), 8, 8, 8], [...Array(7).fill(8), 0x24, 0x20]]],
    ])("shows the shell output right after sz's cancel signal (%s)", (_label, chunks) => {
      const { deps, controller } = breakTransfer();

      for (const chunk of chunks) {
        controller.consume(Uint8Array.from(chunk));
      }
      const written = vi.mocked(deps.writeToTerminal).mock.calls.map(([bytes]) => new TextDecoder().decode(bytes));
      expect(written).toEqual(["$ "]);
    });
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
