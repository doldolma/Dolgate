import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpAudioPayload } from "@shared";

const listeners = new Map<string, (audio: RdpAudioPayload) => void>();

vi.mock("../../services/desktop/rdp", () => ({
  subscribeRdpAudio: (sessionId: string, listener: (audio: RdpAudioPayload) => void) => {
    listeners.set(sessionId, listener);
    return () => listeners.delete(sessionId);
  },
}));

const { useRdpAudio } = await import("./useRdpAudio");

interface StubContext {
  state: string;
  currentTime: number;
  sampleRate: number;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destination: unknown;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
}

let contexts: StubContext[] = [];
let started: number[] = [];
/** 이 값이 있으면 그 샘플레이트를 요청할 때 생성자가 던진다(장치가 못 받는 경우). */
let rejectRate: number | null = null;

function installAudioContext() {
  contexts = [];
  started = [];
  rejectRate = null;

  vi.stubGlobal(
    "AudioContext",
    class {
      constructor(options?: { sampleRate?: number }) {
        if (rejectRate !== null && options?.sampleRate === rejectRate) {
          throw new Error("sample rate not supported");
        }
        const context: StubContext = {
          state: "suspended",
          currentTime: 0,
          sampleRate: options?.sampleRate ?? 44100,
          resume: vi.fn(() => Promise.resolve()),
          close: vi.fn(() => Promise.resolve()),
          destination: {},
          createBuffer: vi.fn((channels: number, frames: number) => ({
            duration: frames / 48000,
            getChannelData: () => new Float32Array(frames * channels),
          })),
          createBufferSource: vi.fn(() => ({
            buffer: null,
            connect: vi.fn(),
            start: vi.fn((at: number) => started.push(at)),
          })),
        };
        contexts.push(context);
        // eslint-disable-next-line no-constructor-return
        return context as unknown as AudioContext;
      }
    },
  );
}

function Harness({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  useRdpAudio(sessionId, enabled);
  return null;
}

function emit(sessionId: string, sampleRate = 48000) {
  listeners.get(sessionId)?.({
    sessionId,
    sampleRate,
    channels: 2,
    bitsPerSample: 16,
    timestamp: 0,
    pcm: new Uint8Array(8),
  });
}

describe("useRdpAudio", () => {
  beforeEach(() => {
    installAudioContext();
    listeners.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wakes the context up", () => {
    // 사용자 조작 없이 만든 컨텍스트는 멈춘 채로 시작한다. 깨우지 않으면 조각을 아무리 이어
    // 붙여도 소리가 나지 않는다.
    render(<Harness sessionId="s1" enabled />);

    emit("s1");

    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalled();
    expect(started).toHaveLength(1);
  });

  it("still plays when the device refuses the remote sample rate", () => {
    // 요청한 샘플레이트를 출력 장치가 못 받으면 생성자가 던진다. 거기서 멈추면 소리가 아예
    // 나지 않으므로, 기본값으로 열고 재생 쪽에서 변환하게 둔다.
    rejectRate = 48000;
    render(<Harness sessionId="s1" enabled />);

    emit("s1", 48000);

    expect(contexts).toHaveLength(1);
    expect(contexts[0].sampleRate).toBe(44100);
    expect(started).toHaveLength(1);
  });

  it("drops samples it cannot interpret", () => {
    render(<Harness sessionId="s1" enabled />);

    listeners.get("s1")?.({
      sessionId: "s1",
      sampleRate: 48000,
      channels: 2,
      // 우리는 16비트만 광고한다. 다른 값을 그대로 읽으면 잡음이 된다.
      bitsPerSample: 8,
      timestamp: 0,
      pcm: new Uint8Array(8),
    });

    expect(contexts).toHaveLength(0);
  });
});
