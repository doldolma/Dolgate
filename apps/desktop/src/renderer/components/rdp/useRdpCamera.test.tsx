import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpSessionEvent } from "@shared";

// 카메라는 **서버가 당겨 간다**. 허락(credit)이 없을 때 인코딩하면 H.264 프레임이 쌓이거나
// 버려지는데, 버리면 원격 디코더의 참조 사슬이 끊긴다. 그래서 이 테스트의 중심은 "허락만큼만
// 인코딩한다" 다.

const listeners = new Set<(event: RdpSessionEvent) => void>();
const sent: ArrayBuffer[] = [];

vi.mock("../../services/desktop/rdp", () => ({
  subscribeRdpEvents: (listener: (event: RdpSessionEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  sendRdpCameraFrame: (_sessionId: string, chunk: ArrayBuffer) => {
    sent.push(chunk);
  },
}));

const { useRdpCamera } = await import("./useRdpCamera");

let getUserMediaError: DOMException | null = null;
let constraints: MediaTrackConstraints | undefined;
let encoderConfig: Record<string, unknown> | undefined;
/** 인코더에 들어간 프레임의 keyFrame 옵션 이력. */
let encodeCalls: Array<{ keyFrame: boolean }> = [];
const stoppedTracks: string[] = [];
/** 카메라가 낼 프레임을 여기에 넣으면 훅의 리더가 한 장씩 가져간다. */
let frameQueue: Array<{ close: () => void }> = [];
/** 카메라가 실제로 준 사양. 요청한 것과 다를 수 있고, 인코더는 이 값에 맞춰야 한다. */
let trackSettings = { width: 640, height: 480, frameRate: 15 };
let resolveNextRead: (() => void) | null = null;

function stubCameraStack() {
  getUserMediaError = null;
  constraints = undefined;
  encoderConfig = undefined;
  encodeCalls = [];
  stoppedTracks.length = 0;
  sent.length = 0;
  frameQueue = [];
  resolveNextRead = null;
  trackSettings = { width: 640, height: 480, frameRate: 15 };

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async (options: { video: MediaTrackConstraints }) => {
        if (getUserMediaError) {
          throw getUserMediaError;
        }
        constraints = options.video;
        return {
          getVideoTracks: () => [{ getSettings: () => trackSettings }],
          getTracks: () => [{ stop: () => stoppedTracks.push("cam") }],
        } as unknown as MediaStream;
      }),
    },
  });

  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readable = {
        getReader: () => ({
          read: async () => {
            const frame = frameQueue.shift();
            if (frame) {
              return { value: frame, done: false };
            }
            // 큐가 비면 다음 프레임을 넣을 때까지 기다린다(실제 카메라와 같은 모양).
            await new Promise<void>((resolve) => {
              resolveNextRead = resolve;
            });
            const next = frameQueue.shift();
            return next ? { value: next, done: false } : { value: undefined, done: true };
          },
          cancel: async () => undefined,
        }),
      };
    },
  );

  vi.stubGlobal(
    "VideoEncoder",
    class {
      state = "configured";
      constructor(private readonly init: { output: (chunk: unknown) => void }) {}
      configure(config: Record<string, unknown>) {
        encoderConfig = config;
      }
      encode(_frame: unknown, options?: { keyFrame?: boolean }) {
        encodeCalls.push({ keyFrame: options?.keyFrame === true });
        this.init.output({
          byteLength: 4,
          copyTo: (target: Uint8Array) => target.set([0, 0, 0, 1]),
        });
      }
      close() {
        this.state = "closed";
      }
    },
  );
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const { problem } = useRdpCamera("rdp-1", enabled);
  return <span data-testid="problem">{problem ?? "none"}</span>;
}

async function emit(event: RdpSessionEvent) {
  await act(async () => {
    for (const listener of listeners) {
      listener(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const startEvent = (
  payload: Partial<{ width: number; height: number; fps: number }> = {},
): RdpSessionEvent =>
  ({
    type: "cameraStart",
    sessionId: "rdp-1",
    payload: { width: 640, height: 480, fps: 15, ...payload },
  }) as RdpSessionEvent;

const creditEvent = (credit = 1): RdpSessionEvent =>
  ({ type: "cameraCredit", sessionId: "rdp-1", payload: { credit } }) as RdpSessionEvent;

/** 프레임 한 장을 카메라가 냈다고 알린다. */
async function pushFrame() {
  const closed: string[] = [];
  frameQueue.push({ close: () => closed.push("closed") });
  await act(async () => {
    resolveNextRead?.();
    resolveNextRead = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return closed;
}

describe("useRdpCamera", () => {
  beforeEach(() => {
    listeners.clear();
    stubCameraStack();
  });

  // 서버가 시작하라고 하기 전에 카메라를 열면 표시등이 켜지고 사용자는 이유를 알 수 없다.
  it("서버가 시작하라고 할 때까지 카메라를 열지 않는다", async () => {
    render(<Probe />);
    await Promise.resolve();

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("서버가 정한 사양으로 카메라와 인코더를 잡는다", async () => {
    render(<Probe />);
    await emit(startEvent({ width: 1280, height: 720, fps: 30 }));

    expect(constraints).toMatchObject({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
    // 실제 트랙이 준 크기(640x480@15)로 인코더를 맞춘다 — 요청과 다를 수 있다.
    expect(encoderConfig).toMatchObject({
      // 640x480@15 는 Level 3.1 로 충분하다.
      codec: "avc1.42E01F",
      width: 640,
      height: 480,
      framerate: 15,
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });
  });

  // **이 규칙이 이 훅의 존재 이유다.** 허락이 없으면 인코딩하지 않고 원본을 버린다.
  it("허락이 없으면 인코딩하지 않고 원본 프레임을 버린다", async () => {
    render(<Probe />);
    await emit(startEvent());

    const closed = await pushFrame();

    expect(encodeCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // 원본을 닫지 않으면 프레임이 새어 메모리가 쌓인다.
    expect(closed).toEqual(["closed"]);
  });

  it("허락 한 장에 정확히 한 장을 인코딩해 보낸다", async () => {
    render(<Probe />);
    await emit(startEvent());
    await emit(creditEvent());

    await pushFrame();
    expect(encodeCalls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(Array.from(new Uint8Array(sent[0]))).toEqual([0, 0, 0, 1]);

    // 허락을 다 썼으므로 다음 장은 인코딩하지 않는다.
    await pushFrame();
    expect(encodeCalls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  // **레벨을 크기에 맞춰야 한다.** Level 3.0 은 720p30 을 담지 못해 인코더가 설정을 거부한다.
  it("실제 캡처 크기에 맞는 H.264 레벨을 고른다", async () => {
    trackSettings = { width: 1920, height: 1080, frameRate: 30 };
    render(<Probe />);
    await emit(startEvent({ width: 1920, height: 1080, fps: 30 }));

    // 1080p30 은 Level 3.1(1F) 한도를 넘어 4.0(28) 이어야 한다.
    expect(encoderConfig?.codec).toBe("avc1.42E028");
    expect(encoderConfig).toMatchObject({ width: 1920, height: 1080, framerate: 30 });
  });

  // 첫 장은 키프레임이어야 한다 — 원격이 그 전 프레임을 본 적이 없다.
  it("첫 장을 키프레임으로 보낸다", async () => {
    render(<Probe />);
    await emit(startEvent());
    await emit(creditEvent(2));

    await pushFrame();
    await pushFrame();

    expect(encodeCalls[0]?.keyFrame).toBe(true);
    expect(encodeCalls[1]?.keyFrame).toBe(false);
  });

  it("권한이 거부되면 그 사실을 알린다", async () => {
    getUserMediaError = new DOMException("no", "NotAllowedError");
    const view = render(<Probe />);
    await emit(startEvent());

    expect(view.getByTestId("problem").textContent).toBe("denied");
  });

  it("카메라가 없으면 권한 거부와 다르게 알린다", async () => {
    getUserMediaError = new DOMException("none", "NotFoundError");
    const view = render(<Probe />);
    await emit(startEvent());

    expect(view.getByTestId("problem").textContent).toBe("noDevice");
  });

  // 서버가 멈추라고 하면 카메라를 놓아야 한다 — 표시등이 켜진 채로 남으면 사용자는 우리가 계속
  // 보고 있다고 생각한다.
  it("서버가 멈추라고 하면 카메라를 놓는다", async () => {
    render(<Probe />);
    await emit(startEvent());
    expect(stoppedTracks).toHaveLength(0);

    await emit({ type: "cameraStop", sessionId: "rdp-1", payload: {} } as RdpSessionEvent);

    expect(stoppedTracks).toEqual(["cam"]);
  });

  it("언마운트하면 카메라를 놓는다", async () => {
    const view = render(<Probe />);
    await emit(startEvent());

    await act(async () => {
      view.unmount();
    });

    expect(stoppedTracks).toEqual(["cam"]);
  });
});
