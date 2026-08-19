import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpSessionEvent } from "@shared";

// 마이크는 **협상된 사양대로** 잡아야 하고(그러지 않으면 원격에서 소리가 빠르거나 느리다),
// 열지 못했으면 그 사실이 사용자에게 보여야 한다(조용히 실패하면 말하는 사람만 모른다).

const listeners = new Set<(event: RdpSessionEvent) => void>();
const sent: ArrayBuffer[] = [];

vi.mock("../../services/desktop/rdp", () => ({
  subscribeRdpEvents: (listener: (event: RdpSessionEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  sendRdpMicrophoneAudio: (_sessionId: string, chunk: ArrayBuffer) => {
    sent.push(chunk);
  },
}));

const { useRdpMicrophone } = await import("./useRdpMicrophone");

let constraints: MediaTrackConstraints | undefined;
let getUserMediaError: DOMException | null = null;
let contextRates: (number | undefined)[] = [];
let processorCallback: ((event: unknown) => void) | null = null;
const stoppedTracks: string[] = [];

function stubAudioStack(inputRate = 44100) {
  constraints = undefined;
  getUserMediaError = null;
  contextRates = [];
  processorCallback = null;
  stoppedTracks.length = 0;
  sent.length = 0;

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async (options: { audio: MediaTrackConstraints }) => {
        if (getUserMediaError) {
          throw getUserMediaError;
        }
        constraints = options.audio;
        return {
          getTracks: () => [{ stop: () => stoppedTracks.push("mic") }],
        } as unknown as MediaStream;
      }),
    },
  });

  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate: number;
      destination = {};
      constructor(options?: { sampleRate?: number }) {
        contextRates.push(options?.sampleRate);
        this.sampleRate = options?.sampleRate ?? inputRate;
      }
      createMediaStreamSource() {
        return { connect: () => undefined, disconnect: () => undefined };
      }
      createScriptProcessor() {
        return {
          set onaudioprocess(callback: ((event: unknown) => void) | null) {
            processorCallback = callback;
          },
          connect: () => undefined,
          disconnect: () => undefined,
        };
      }
      createGain() {
        return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
      }
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
    },
  );
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const { problem } = useRdpMicrophone("rdp-1", enabled);
  return <span data-testid="problem">{problem ?? "none"}</span>;
}

async function announceFormat(
  overrides: Partial<{ sampleRate: number; channels: number; bitsPerSample: number }> = {},
) {
  // 이벤트는 React 밖(preload 브리지)에서 온다. 테스트에서는 act 로 감싸야 상태 갱신과 그에
  // 딸린 effect(마이크 열기)가 흐른다.
  await act(async () => {
    for (const listener of listeners) {
      listener({
        type: "microphoneFormat",
        sessionId: "rdp-1",
        payload: {
          sampleRate: 22050,
          channels: 1,
          bitsPerSample: 16,
          framesPerPacket: 441,
          ...overrides,
        },
      } as RdpSessionEvent);
    }
    // 마이크 열기는 비동기다. 한 틱 넘겨 그 체인이 끝나게 한다.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 캡처 콜백을 한 번 돌린다. 프레임 수만큼의 무음 아닌 신호를 넣는다. */
function pumpAudio(frames: number, inputRate = 22050) {
  const data = new Float32Array(frames).fill(0.5);
  processorCallback?.({
    inputBuffer: {
      length: frames,
      numberOfChannels: 1,
      sampleRate: inputRate,
      getChannelData: () => data,
    },
  });
}

/** 채널마다 다른 값을 넣어 돌린다. 인터리브·다운믹스를 값으로 구분할 수 있다. */
function pumpChannels(frames: number, values: number[], inputRate = 44100) {
  const data = values.map((value) => new Float32Array(frames).fill(value));
  processorCallback?.({
    inputBuffer: {
      length: frames,
      numberOfChannels: values.length,
      sampleRate: inputRate,
      getChannelData: (channel: number) => data[channel],
    },
  });
}

describe("useRdpMicrophone", () => {
  beforeEach(() => {
    listeners.clear();
    stubAudioStack();
  });

  // 사양이 오기 전에 열면 사용자에게 권한을 묻고도 쓰지 못한 채 다시 열어야 한다.
  it("협상 사양이 오기 전에는 마이크를 열지 않는다", async () => {
    render(<Probe />);
    await Promise.resolve();

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("서버가 고른 사양으로 마이크와 오디오 컨텍스트를 연다", async () => {
    render(<Probe />);
    await announceFormat({ sampleRate: 22050, channels: 1 });

    expect(constraints).toMatchObject({ sampleRate: 22050, channelCount: 1 });
    expect(contextRates).toEqual([22050]);
    // 에코 제거를 끄면 원격으로 자기 소리가 되돌아간다.
    expect(constraints).toMatchObject({ echoCancellation: true });
  });

  // 16-bit PCM 만 광고하므로 다른 값이 오면 해석이 달라져 잡음이 된다.
  it("16-bit 가 아닌 사양은 무시한다", async () => {
    render(<Probe />);
    await announceFormat({ bitsPerSample: 8 });

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("Float32 를 16-bit PCM 으로 바꿔 보낸다", async () => {
    render(<Probe />);
    await announceFormat({ sampleRate: 22050 });

    // 40ms 미만은 모아 두고 보내지 않는다 — IPC 왕복이 캡처보다 비싸진다.
    pumpAudio(256);
    expect(sent).toHaveLength(0);

    pumpAudio(1024);
    expect(sent).toHaveLength(1);
    const samples = new Int16Array(sent[0]);
    expect(samples.length).toBe(1280);
    // 0.5 → 0x4000 근처. 정수로 바뀌었는지만 본다(반올림 한 칸은 문제가 아니다).
    expect(samples[0]).toBeGreaterThan(16000);
    expect(samples[0]).toBeLessThan(17000);
  });

  // 서버가 스테레오로 여는 경우가 실제로 있었다(실측: 44100Hz 2ch). 그때 모노로 보내면 프레임당
  // 바이트 수가 절반이라 원격에서 소리로 성립하지 않는다.
  it("원격이 스테레오를 고르면 두 채널로 인터리브해 보낸다", async () => {
    render(<Probe />);
    await announceFormat({ sampleRate: 44100, channels: 2 });

    // 좌우를 다른 값으로 넣어 자리가 섞이지 않았는지 본다.
    pumpChannels(2000, [0.5, -0.5]);

    expect(sent).toHaveLength(1);
    const samples = new Int16Array(sent[0]);
    expect(samples.length).toBe(4000);
    expect(samples[0]).toBeGreaterThan(16000);
    expect(samples[1]).toBeLessThan(-16000);
    expect(samples[2]).toBe(samples[0]);
    expect(samples[3]).toBe(samples[1]);
  });

  // 마이크가 모노인데 원격이 스테레오를 고르면 있는 채널을 양쪽에 넣는다 — 한쪽만 채우면 원격에서
  // 한쪽 스피커로만 들린다.
  it("모노 마이크로도 스테레오 프레임을 채운다", async () => {
    render(<Probe />);
    await announceFormat({ sampleRate: 44100, channels: 2 });

    pumpAudio(2000, 44100);

    expect(sent).toHaveLength(1);
    const samples = new Int16Array(sent[0]);
    expect(samples.length).toBe(4000);
    expect(samples[0]).toBe(samples[1]);
  });

  // 원격이 모노를 고르면 채널을 평균한다. 한쪽만 쓰면 그 채널이 조용한 기기에서 소리가 사라진다.
  it("원격이 모노를 고르면 채널을 평균해 보낸다", async () => {
    render(<Probe />);
    await announceFormat({ sampleRate: 44100, channels: 1 });

    // 좌 0.5 / 우 0.1 → 평균 0.3
    pumpChannels(2000, [0.5, 0.1]);

    expect(sent).toHaveLength(1);
    const samples = new Int16Array(sent[0]);
    expect(samples.length).toBe(2000);
    expect(samples[0]).toBeGreaterThan(9000);
    expect(samples[0]).toBeLessThan(10800);
  });

  it("권한이 거부되면 그 사실을 알린다", async () => {
    getUserMediaError = new DOMException("denied", "NotAllowedError");
    const view = render(<Probe />);
    await announceFormat();

    expect(view.getByTestId("problem").textContent).toBe("denied");
  });

  it("마이크가 없으면 권한 거부와 다르게 알린다", async () => {
    getUserMediaError = new DOMException("none", "NotFoundError");
    const view = render(<Probe />);
    await announceFormat();

    expect(view.getByTestId("problem").textContent).toBe("noDevice");
  });

  // 서버가 채널을 열지 않으면 우리가 할 수 있는 일이 없다. **그 사실을 말해야 한다** — 침묵하면
  // 사용자는 마이크가 켜진 줄 알고 원격에서 말한다(실제로 그랬다).
  it("서버가 마이크를 거부하면 그 이유를 알리고 권한을 묻지 않는다", async () => {
    const view = render(<Probe />);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "microphoneUnavailable",
          sessionId: "rdp-1",
          payload: { reason: "serverRefused" },
        } as RdpSessionEvent);
      }
    });

    expect(view.getByTestId("problem").textContent).toBe("serverRefused");
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  // 세션이 끝났는데 마이크가 켜져 있으면 표시등이 남고, 사용자는 뭐가 듣고 있는지 알 수 없다.
  it("언마운트하면 마이크 트랙을 멈춘다", async () => {
    const view = render(<Probe />);
    await announceFormat();

    view.unmount();

    expect(stoppedTracks).toEqual(["mic"]);
  });
});
