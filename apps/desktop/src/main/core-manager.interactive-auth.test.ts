import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEvent, CoreRequest } from "@shared";
import { encodeControlFrame } from "./core-framing";

const { appGetPathMock, existsSyncMock, spawnMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => "/tmp/dolgate-test-user-data"),
  existsSyncMock: vi.fn(() => true),
  spawnMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/dolssh",
    getPath: appGetPathMock,
    isPackaged: false,
  },
  BrowserWindow: class {},
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { CoreManager } from "./core-manager";

function decodeControlFrame(
  buffer: Buffer,
): CoreRequest<Record<string, unknown>> {
  const metadataLength = buffer.readUInt32BE(1);
  return JSON.parse(
    buffer.subarray(9, 9 + metadataLength).toString("utf8"),
  ) as CoreRequest<Record<string, unknown>>;
}

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();

  const writes: Buffer[] = [];
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
  // 실제 stdin 과 같은 성질을 준다 — 종료는 stdin 을 먼저 닫고, 코어 매니저는 그것을 보고
  // 프레임 보내기를 멈춘다(writableCoreStdin).
  child.stdin = {
    writable: true,
    destroyed: false,
    write: vi.fn((chunk: Uint8Array) => {
      // 닫힌 뒤의 쓰기는 실제 스트림처럼 던진다. 조용히 받아 주면 "종료 중에는 안 보낸다" 를
      // 테스트가 통과시켜 버린다(실기기에서 터진 그 오류를 못 잡는다).
      if (!child.stdin.writable) {
        const error = new Error("write after end") as Error & { code?: string };
        error.code = "ERR_STREAM_WRITE_AFTER_END";
        throw error;
      }
      writes.push(Buffer.from(chunk));
      return true;
    }),
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
    writes,
    emitControl(event: CoreEvent<Record<string, unknown>>) {
      child.stdout.emit("data", encodeControlFrame(event));
    },
  };
}

/**
 * 코어에 프로브 요청을 띄우고, 그 요청 프레임을 돌려준다.
 *
 * 프로브를 쓰는 이유: 요청·응답 한 번짜리 작업이면서 도중에 사람에게 물을 수 있는 대표 경로다
 * (점프 호스트가 OTP 를 요구하는 경우).
 */
async function startProbe(fakeProcess: ReturnType<typeof createFakeChildProcess>) {
  spawnMock.mockReturnValue(fakeProcess.child);
  const manager = new CoreManager();
  const probe = manager.probeHostKey({ host: "192.168.200.4", port: 2733 });
  const outcome = { settled: "pending" as "pending" | "resolved" | "rejected", error: "" };
  const tracked = probe.then(
    (value) => {
      outcome.settled = "resolved";
      return value;
    },
    (error: Error) => {
      outcome.settled = "rejected";
      outcome.error = error.message;
      return undefined;
    },
  );

  for (let attempt = 0; attempt < 50 && fakeProcess.writes.length < 1; attempt += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
  const request = decodeControlFrame(
    // 첫 프레임은 tailnet 설정일 수 있다 — 프로브 프레임을 찾아 쓴다.
    fakeProcess.writes.find(
      (buffer) => decodeControlFrame(buffer).type === "probeHostKey",
    ) as Buffer,
  );
  return { manager, tracked, outcome, request };
}

describe("CoreManager interactive auth budgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    appGetPathMock.mockReturnValue("/tmp/dolgate-test-user-data");
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 실기기 증상: OTP 를 요구하는 점프 호스트 뒤의 호스트에 연결하면, 인증 카드가 뜬 뒤 8초
  // (요청 기본 예산) 만에 "연결 시간 초과" 가 떴다. 사용자가 핸드폰에서 코드를 보고 넣는 동안
  // 요청이 죽어 있어서, 뒤늦게 누른 "응답 보내기" 는 받을 곳이 없었다.
  it("stops counting machine time while the core is asking the user", async () => {
    const fakeProcess = createFakeChildProcess();
    const { tracked, outcome, request } = await startProbe(fakeProcess);

    fakeProcess.emitControl({
      type: "keyboardInteractiveChallenge",
      requestId: request.id,
      payload: {
        challengeId: "hostkey-1",
        prompts: [{ label: "Verification code:", echo: false }],
      },
    });

    // 기본 예산(8초)의 몇 배를 지나도 살아 있어야 한다.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(outcome.settled).toBe("pending");

    fakeProcess.emitControl({
      type: "keyboardInteractiveResolved",
      requestId: request.id,
      payload: { challengeId: "hostkey-1" },
    });
    fakeProcess.emitControl({
      type: "hostKeyProbed",
      requestId: request.id,
      payload: {
        algorithm: "ecdsa-sha2-nistp256",
        publicKeyBase64: "AAAATEST",
        fingerprintSha256: "SHA256:test",
      },
    });

    await expect(tracked).resolves.toMatchObject({
      algorithm: "ecdsa-sha2-nistp256",
      publicKeyBase64: "AAAATEST",
    });
  });

  // 상한은 있다. 다만 코어의 대기 한도(5분)보다 길어서, 사람이 끝내 답하지 않은 경우는 코어가
  // 이유를 붙여 실패로 올려 보낸다 — 여기서 먼저 끊으면 아무도 이유를 설명하지 못한다.
  it("still gives up eventually, after the core's own wait", async () => {
    const fakeProcess = createFakeChildProcess();
    const { tracked, outcome, request } = await startProbe(fakeProcess);

    fakeProcess.emitControl({
      type: "keyboardInteractiveChallenge",
      requestId: request.id,
      payload: { challengeId: "hostkey-1", prompts: [] },
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(outcome.settled).toBe("pending");

    await vi.advanceTimersByTimeAsync(70_000);
    await tracked;
    expect(outcome.settled).toBe("rejected");
    expect(outcome.error).toContain("probeHostKey");
  });

  // 답을 받은 뒤로는 다시 기계 시간이다. 사람 예산을 그대로 두면 멈춘 프로브를 6분 동안 기다린다.
  it("goes back to machine time once the answer is in", async () => {
    const fakeProcess = createFakeChildProcess();
    const { tracked, outcome, request } = await startProbe(fakeProcess);

    fakeProcess.emitControl({
      type: "keyboardInteractiveChallenge",
      requestId: request.id,
      payload: { challengeId: "hostkey-1", prompts: [] },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    fakeProcess.emitControl({
      type: "keyboardInteractiveResolved",
      requestId: request.id,
      payload: { challengeId: "hostkey-1" },
    });

    await vi.advanceTimersByTimeAsync(31_000);
    await tracked;
    expect(outcome.settled).toBe("rejected");
  });
});
