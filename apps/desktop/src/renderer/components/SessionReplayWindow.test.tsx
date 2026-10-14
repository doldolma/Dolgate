import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionReplayEntry, SessionReplayIndex } from "@shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { segmentReplayEntries } from "../lib/replay-segments.test-support";

type RecordingFixture = Omit<SessionReplayIndex, "segments"> & {
  entries: SessionReplayEntry[];
};

/** 녹화를 메인이 넘기는 꼴(정보 + 구간)로 나눠 sessionReplays API 로 꾸민다. */
function replayApiFor(
  recording: RecordingFixture,
  entriesPerSegment = Number.POSITIVE_INFINITY,
) {
  const { entries, ...meta } = recording;
  const { segments, readSegment } = segmentReplayEntries(entries, entriesPerSegment);
  const index: SessionReplayIndex = { ...meta, segments };
  return {
    index,
    load: vi.fn().mockResolvedValue(index),
    readSegment: vi.fn((_recordingId: string, segmentIndex: number) =>
      readSegment(segmentIndex),
    ),
  };
}

function useRecording(recording: RecordingFixture, entriesPerSegment?: number) {
  const api = replayApiFor(recording, entriesPerSegment);
  window.dolssh.sessionReplays.load = api.load;
  window.dolssh.sessionReplays.readSegment = api.readSegment;
  return api;
}

const DEFAULT_RECORDING: RecordingFixture = {
  recordingId: "recording-1",
  sessionId: "session-1",
  hostId: "host-1",
  hostLabel: "nas",
  title: "NAS",
  connectionDetails: "doldolma.com · 22 · doyoung",
  connectionKind: "ssh",
  connectedAt: "2026-03-29T00:00:00.000Z",
  disconnectedAt: "2026-03-29T00:00:02.000Z",
  durationMs: 2000,
  initialCols: 80,
  initialRows: 24,
  entries: [
    {
      type: "output",
      atMs: 100,
      dataBase64: btoa("hello\n"),
    },
    {
      type: "resize",
      atMs: 500,
      cols: 100,
      rows: 40,
    },
    {
      type: "output",
      atMs: 1200,
      dataBase64: btoa("world\n"),
    },
  ],
};

const mocks = vi.hoisted(() => ({
  runtimeRecords: [] as Array<{
    terminal: {
      options: Record<string, unknown>;
      reset: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };
    write: ReturnType<typeof vi.fn>;
    pendingOutputSize: ReturnType<typeof vi.fn>;
    setAppearance: ReturnType<typeof vi.fn>;
    // 화면 전체 직렬화 — 재생 중 프레임마다 불리면 안 되므로 테스트에서 호출 여부를 본다.
    captureSnapshot: ReturnType<typeof vi.fn>;
    repaint: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  rafCallbacks: [] as FrameRequestCallback[],
  currentNow: 0,
  throwOnCreateRuntime: false,
}));

vi.mock("../lib/terminal-runtime", () => ({
  createTerminalRuntime: vi.fn(() => {
    if (mocks.throwOnCreateRuntime) {
      throw new Error("runtime boom");
    }
    const runtime = {
      terminal: {
        options: {},
        reset: vi.fn(),
        resize: vi.fn(),
        clear: vi.fn(),
      },
      fitAddon: { fit: vi.fn() },
      write: vi.fn(),
      pendingOutputSize: vi.fn(() => 0),
      scheduleAfterWriteDrain: vi.fn(),
      captureSnapshot: vi.fn(() => ""),
      // 패널 토글 등 레이아웃 변경 후 컨트롤러가 다시 그리게 한다.
      repaint: vi.fn(),
      setAppearance: vi.fn(),
      setWebglEnabled: vi.fn().mockResolvedValue(undefined),
      syncDisplayMetrics: vi.fn(),
      focus: vi.fn(),
      findNext: vi.fn(() => false),
      findPrevious: vi.fn(() => false),
      clearSearch: vi.fn(),
      blurSearch: vi.fn(),
      dispose: vi.fn(),
    };
    mocks.runtimeRecords.push(runtime);
    return runtime;
  }),
}));

import { SessionReplayWindow } from "./SessionReplayWindow";

describe("SessionReplayWindow", () => {
  beforeEach(() => {
    mocks.runtimeRecords.length = 0;
    mocks.rafCallbacks.length = 0;
    mocks.currentNow = 0;
    mocks.throwOnCreateRuntime = false;
    vi.restoreAllMocks();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        mocks.rafCallbacks.push(callback);
        return mocks.rafCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(performance, "now").mockImplementation(() => mocks.currentNow);

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    Object.defineProperty(window, "dolssh", {
      configurable: true,
      value: {
        settings: {
          get: vi.fn().mockResolvedValue({
            theme: "system",
            globalTerminalThemeId: "dolssh-dark",
            terminalFontFamily: "sf-mono",
            terminalFontSize: 13,
            terminalScrollbackLines: 5000,
            terminalLineHeight: 1,
            terminalLetterSpacing: 0,
            terminalMinimumContrastRatio: 1,
            terminalAltIsMeta: false,
            terminalWebglEnabled: true,
            sftpBrowserColumnWidths: {
              name: 360,
              dateModified: 168,
              size: 96,
              kind: 96,
            },
            sessionReplayRetentionCount: 100,
            serverUrl: "https://example.test",
            serverUrlOverride: null,
            dismissedUpdateVersion: null,
            updatedAt: "2026-03-29T00:00:00.000Z",
          }),
        },
        sessionReplays: {},
      },
    });
    useRecording(DEFAULT_RECORDING);
  });

  it("lists scanned commands and seeks to one when clicked", async () => {
    useRecording({
      recordingId: "recording-cmds",
      sessionId: "session-cmds",
      hostId: "host-1",
      hostLabel: "nas",
      title: "NAS",
      connectionKind: "ssh",
      connectedAt: "2026-03-29T00:00:00.000Z",
      disconnectedAt: "2026-03-29T00:00:02.000Z",
      durationMs: 2000,
      initialCols: 80,
      initialRows: 24,
      entries: [
        { type: "output", atMs: 0, dataBase64: btoa("$ \x1b]133;B\x07") },
        { type: "output", atMs: 300, dataBase64: btoa("ls -la\r\n\x1b]133;C\x07") },
        { type: "output", atMs: 800, dataBase64: btoa("out\r\n\x1b]133;D;0\x07") },
        { type: "output", atMs: 900, dataBase64: btoa("$ \x1b]133;B\x07") },
        { type: "output", atMs: 1000, dataBase64: btoa("boom\r\n\x1b]133;C\x07") },
        { type: "output", atMs: 1500, dataBase64: btoa("\x1b]133;D;127\x07") },
      ],
    });

    render(<SessionReplayWindow recordingId="recording-cmds" />);

    // 사전 스캔이 끝나면 두 명령이 목록에 뜬다.
    const failedRow = await screen.findByTitle("boom");
    expect(await screen.findByTitle("ls -la")).toBeInTheDocument();
    // 실패한 명령은 종료 코드를 함께 보여준다.
    expect(within(failedRow).getByText("127")).toBeInTheDocument();

    const runtime = mocks.runtimeRecords[0]!;
    runtime.terminal.reset.mockClear();

    // 두 번째 명령(1000ms)으로 이동 — 현재 위치보다 뒤이므로 되감기 없이 진행한다.
    fireEvent.click(failedRow);

    expect(
      (screen.getByLabelText("Replay scrubber") as HTMLInputElement).value,
    ).toBe("1000");
  });

  it("does not serialize the terminal when E2E state publishing is off", async () => {
    // terminalText 는 captureSnapshot(화면 전체 직렬화)이라 비싸다. E2E 훅이 꺼진
    // 프로덕션에서는 재생 중 프레임마다 이게 돌면 안 된다.
    expect(
      (window as Window & { __dolsshE2E?: unknown }).__dolsshE2E,
    ).toBeUndefined();

    render(<SessionReplayWindow recordingId="recording-1" />);
    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));

    const runtime = mocks.runtimeRecords[0]!;
    runtime.captureSnapshot.mockClear();

    // 재생 프레임 한 번 = positionMs 변경 = E2E 상태 effect 재실행.
    await act(async () => {
      mocks.currentNow = 150;
      mocks.rafCallbacks.shift()?.(150);
    });

    expect(runtime.captureSnapshot).not.toHaveBeenCalled();
  });

  it("renders replay summary and restores output when seeking with the scrubber", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() =>
      expect(screen.getByText("doldolma.com · 22 · doyoung")).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );

    const runtime = mocks.runtimeRecords[0]!;
    runtime.terminal.reset.mockClear();
    runtime.terminal.resize.mockClear();
    runtime.terminal.clear.mockClear();
    runtime.write.mockClear();
    const replayTerminal = screen.getByTestId(
      "session-replay-terminal",
    ) as HTMLDivElement | null;
    const initialWidth = replayTerminal?.style.width;
    const initialHeight = replayTerminal?.style.height;
    expect(initialWidth).not.toBe("");
    expect(initialHeight).not.toBe("");

    fireEvent.change(screen.getByLabelText("Replay scrubber"), {
      target: { value: "1250" },
    });

    expect(runtime.terminal.reset).not.toHaveBeenCalled();
    expect(runtime.terminal.clear).not.toHaveBeenCalled();
    expect(runtime.terminal.resize).toHaveBeenCalledTimes(1);
    expect(runtime.terminal.resize).toHaveBeenNthCalledWith(1, 100, 40);
    expect(runtime.write).toHaveBeenCalledTimes(2);
    expect(replayTerminal?.style.width).not.toBe(initialWidth);
    expect(replayTerminal?.style.height).not.toBe(initialHeight);
    expect(
      new TextDecoder().decode(runtime.write.mock.calls[0]?.[0] as Uint8Array),
    ).toBe("hello\n");
    expect(
      new TextDecoder().decode(runtime.write.mock.calls[1]?.[0] as Uint8Array),
    ).toBe("world\n");

    runtime.terminal.reset.mockClear();
    runtime.terminal.resize.mockClear();
    runtime.terminal.clear.mockClear();
    runtime.write.mockClear();

    fireEvent.change(screen.getByLabelText("Replay scrubber"), {
      target: { value: "200" },
    });

    expect(runtime.terminal.reset).toHaveBeenCalledTimes(1);
    expect(runtime.terminal.clear).toHaveBeenCalledTimes(1);
    expect(runtime.terminal.resize).toHaveBeenCalledTimes(1);
    expect(runtime.terminal.resize).toHaveBeenNthCalledWith(1, 80, 24);
    expect(runtime.write).toHaveBeenCalledTimes(1);
    expect(replayTerminal?.style.width).toBe(initialWidth);
    expect(replayTerminal?.style.height).toBe(initialHeight);
    expect(
      new TextDecoder().decode(runtime.write.mock.calls[0]?.[0] as Uint8Array),
    ).toBe("hello\n");
  });

  it.each([
    ["local", "Local"],
    ["aws-ecs-exec", "AWS ECS Exec"],
  ] as const)("renders the %s replay connection kind label", async (connectionKind, label) => {
    useRecording({
      recordingId: "recording-kind",
      sessionId: "session-kind",
      hostId: "host-kind",
      hostLabel: connectionKind === "local" ? "Local Terminal" : "prod",
      title: "Terminal",
      connectionDetails: null,
      connectionKind,
      connectedAt: "2026-03-29T00:00:00.000Z",
      disconnectedAt: "2026-03-29T00:00:01.000Z",
      durationMs: 1000,
      initialCols: 80,
      initialRows: 24,
      entries: [],
    });

    render(<SessionReplayWindow recordingId="recording-kind" />);

    await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
  });

  it("starts playing immediately and keeps paused state when seeking after pause", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    const runtime = mocks.runtimeRecords[0]!;
    runtime.write.mockClear();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.rafCallbacks).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("Replay speed"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Replay scrubber"), {
      target: { value: "800" },
    });

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(
      screen.getByLabelText("Replay scrubber"),
    ).toHaveValue("800");
  });

  // 재생 루프를 React 상태(positionMs)로 다시 걸면, 그 상태가 이미 적용한 위치보다 늦게 반영될 때 위치가
  // 뒤로 가서 터미널을 지우고 처음부터 다시 썼다(출력 77MB 녹화가 16초에 1.8GB 를 다시 씀, 실측).
  it("never rewinds or rewrites while playing, even when frames and renders interleave", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    const runtime = mocks.runtimeRecords[0]!;
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));
    runtime.terminal.reset.mockClear();
    runtime.write.mockClear();

    // 프레임을 돈 뒤 렌더·효과가 비워지기 전에 시간이 흐르게 한다. 취소된 프레임(여기서는
    // cancelAnimationFrame 이 아무것도 안 한다)도 그대로 부른다 — 늦게 도는 옛 프레임이다.
    for (let frame = 1; frame <= 45; frame += 1) {
      await act(async () => {
        mocks.currentNow = frame * 50;
        for (const callback of mocks.rafCallbacks.splice(0)) {
          callback(mocks.currentNow);
        }
        mocks.currentNow += 20;
      });
    }

    expect(runtime.terminal.reset).not.toHaveBeenCalled();
    // 출력 항목 둘이 한 번씩만 쓰인다.
    expect(runtime.write).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  // 재생 터미널이 다 그리지 못하면 시계를 세운다. 다 그리면 멈춘 자리에서 잇는다(건너뛰지 않는다).
  it("holds the playback clock while the terminal has a backlog to draw", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    const runtime = mocks.runtimeRecords[0]!;
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));
    runtime.write.mockClear();
    runtime.pendingOutputSize.mockReturnValue(2 * 1024 * 1024);

    const runFrame = async (now: number) => {
      await act(async () => {
        mocks.currentNow = now;
        for (const callback of mocks.rafCallbacks.splice(0)) {
          callback(now);
        }
      });
    };
    for (let now = 100; now <= 1500; now += 100) {
      await runFrame(now);
    }
    expect(runtime.write).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Replay scrubber")).toHaveValue("0");

    runtime.pendingOutputSize.mockReturnValue(0);
    await runFrame(1600);
    // 세운 동안의 1.5초를 건너뛰지 않고 멈춘 자리(0)에서 한 프레임(100ms)만 흘렀다.
    expect(screen.getByLabelText("Replay scrubber")).toHaveValue("100");
    expect(runtime.write).toHaveBeenCalledTimes(1);
  });

  it("initializes replay even when terminal settings resolve after the recording", async () => {
    type ReplaySettingsPayload = {
      theme: "system" | "light" | "dark";
      globalTerminalThemeId: string;
      terminalFontFamily: string;
      terminalFontSize: number;
      terminalScrollbackLines: number;
      terminalLineHeight: number;
      terminalLetterSpacing: number;
      terminalMinimumContrastRatio: number;
      terminalAltIsMeta: boolean;
    };
    let resolveSettings!: (value: ReplaySettingsPayload) => void;
    const delayedSettings = new Promise<ReplaySettingsPayload>((resolve) => {
      resolveSettings = resolve;
    });
    window.dolssh.settings.get = vi.fn().mockReturnValue(delayedSettings);

    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() =>
      expect(window.dolssh.sessionReplays.load).toHaveBeenCalledWith("recording-1"),
    );
    expect(mocks.runtimeRecords).toHaveLength(0);

    resolveSettings({
      theme: "system",
      globalTerminalThemeId: "dolssh-dark",
      terminalFontFamily: "sf-mono",
      terminalFontSize: 13,
      terminalScrollbackLines: 5000,
      terminalLineHeight: 1,
      terminalLetterSpacing: 0,
      terminalMinimumContrastRatio: 1,
      terminalAltIsMeta: false,
    });

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));

    const runtime = mocks.runtimeRecords[0]!;
    runtime.write.mockClear();

    await act(async () => {
      mocks.currentNow = 150;
      const callback = mocks.rafCallbacks.shift();
      callback?.(150);
    });

    expect(runtime.write).toHaveBeenCalledTimes(1);
    expect(
      new TextDecoder().decode(runtime.write.mock.calls[0]?.[0] as Uint8Array),
    ).toBe("hello\n");
  });

  it("initializes replay when recording resolves after terminal settings", async () => {
    const api = useRecording({
      ...DEFAULT_RECORDING,
      entries: [
        {
          type: "output",
          atMs: 100,
          dataBase64: btoa("hello\n"),
        },
      ],
    });
    let resolveRecording!: (value: SessionReplayIndex) => void;
    window.dolssh.sessionReplays.load = vi.fn().mockReturnValue(
      new Promise<SessionReplayIndex>((resolve) => {
        resolveRecording = resolve;
      }),
    );

    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(window.dolssh.settings.get).toHaveBeenCalled());
    expect(mocks.runtimeRecords).toHaveLength(0);

    resolveRecording(api.index);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));

    const runtime = mocks.runtimeRecords[0]!;
    runtime.write.mockClear();

    await act(async () => {
      mocks.currentNow = 150;
      const callback = mocks.rafCallbacks.shift();
      callback?.(150);
    });

    expect(runtime.write).toHaveBeenCalledTimes(1);
    expect(
      new TextDecoder().decode(runtime.write.mock.calls[0]?.[0] as Uint8Array),
    ).toBe("hello\n");
  });

  it("surfaces a runtime initialization error instead of leaving the replay blank", async () => {
    mocks.throwOnCreateRuntime = true;

    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() =>
      expect(
        screen.getByText(/세션 replay 터미널을 초기화하지 못했습니다\./),
      ).toBeInTheDocument(),
    );
  });

  it("toggles playback with the space key when focus is not in a form control", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );

    fireEvent.keyDown(window, { code: "Space" });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();

    fireEvent.keyDown(window, { code: "Space" });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("toggles playback with the space key while the scrubber is focused", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );

    const scrubber = screen.getByLabelText("Replay scrubber");
    scrubber.focus();

    fireEvent.keyDown(scrubber, { code: "Space" });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();

    fireEvent.keyDown(scrubber, { code: "Space" });
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("adjusts zoom in place without recreating the terminal or blanking it", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument(),
    );
    const runtime = mocks.runtimeRecords[0]!;
    const replayTerminal = screen.getByTestId(
      "session-replay-terminal",
    ) as HTMLDivElement | null;
    const initialWidth = replayTerminal?.style.width;
    const initialHeight = replayTerminal?.style.height;

    // Pause so the assertions are isolated from playback animation frames.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    runtime.setAppearance.mockClear();
    runtime.terminal.reset.mockClear();
    runtime.terminal.clear.mockClear();
    expect(screen.getByText("100%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByText("110%")).toBeInTheDocument();
    // Regression: zooming must NOT tear down and rebuild the terminal
    // (that left the replay blank until the user scrubbed elsewhere).
    expect(mocks.runtimeRecords).toHaveLength(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    // The font size is updated in place (13 * 1.1 = 14.3), keeping the buffer.
    expect(runtime.setAppearance).toHaveBeenCalled();
    expect(runtime.setAppearance.mock.calls.at(-1)?.[0]).toMatchObject({
      fontSize: 14.3,
    });
    // The surrounding surface still re-sizes for the new zoom level.
    expect(replayTerminal?.style.width).not.toBe(initialWidth);
    expect(replayTerminal?.style.height).not.toBe(initialHeight);
    // No content re-application is scheduled (no reset/clear, no rewrite).
    expect(runtime.terminal.reset).not.toHaveBeenCalled();
    expect(runtime.terminal.clear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));

    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(mocks.runtimeRecords).toHaveLength(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(replayTerminal?.style.width).toBe(initialWidth);
    expect(replayTerminal?.style.height).toBe(initialHeight);

    // Zooming does not resume playback.
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  // 녹화를 통째로 받지 않고 구간 단위로 받는다. 구간 경계를 지나도 출력이 빠짐없이 차례로 그려져야 한다.
  it("plays a recording split into segments to the end, in order", async () => {
    const outputs = Array.from({ length: 12 }, (_, index) => `line-${index}\n`);
    useRecording(
      {
        ...DEFAULT_RECORDING,
        durationMs: 1300,
        entries: outputs.map((text, index) => ({
          type: "output" as const,
          atMs: 100 * (index + 1),
          dataBase64: btoa(text),
        })),
      },
      1,
    );

    render(<SessionReplayWindow recordingId="recording-1" />);
    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));
    const runtime = mocks.runtimeRecords[0]!;

    for (let now = 50; now <= 1400; now += 50) {
      await act(async () => {
        mocks.currentNow = now;
        for (const callback of mocks.rafCallbacks.splice(0)) {
          callback(now);
        }
      });
    }

    const written = runtime.write.mock.calls
      .map(([data]) => new TextDecoder().decode(data as Uint8Array))
      .join("");
    expect(written).toBe(outputs.join(""));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  // 다음 구간을 받는 동안에는 재생 시계를 세운다. 받으면 멈춘 자리에서 잇는다(그 사이 출력을 건너뛰지 않는다).
  it("holds the playback clock while the next segment is still loading", async () => {
    const api = useRecording(
      {
        ...DEFAULT_RECORDING,
        entries: [
          { type: "output", atMs: 100, dataBase64: btoa("first\n") },
          { type: "output", atMs: 200, dataBase64: btoa("second\n") },
        ],
      },
      1,
    );
    let releaseSecond!: () => void;
    const secondArrived = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    window.dolssh.sessionReplays.readSegment = vi.fn(
      async (recordingId: string, segmentIndex: number) => {
        if (segmentIndex === 1) {
          await secondArrived;
        }
        return api.readSegment(recordingId, segmentIndex);
      },
    );

    render(<SessionReplayWindow recordingId="recording-1" />);
    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    await waitFor(() => expect(mocks.rafCallbacks.length).toBeGreaterThan(0));
    const runtime = mocks.runtimeRecords[0]!;

    const runFrame = async (now: number) => {
      await act(async () => {
        mocks.currentNow = now;
        for (const callback of mocks.rafCallbacks.splice(0)) {
          callback(now);
        }
      });
    };
    await runFrame(150);
    expect(runtime.write).toHaveBeenCalledTimes(1);
    await runFrame(250);
    await runFrame(400);
    await runFrame(800);
    // 둘째 구간이 없어서 250 에서 섰다.
    expect(screen.getByLabelText("Replay scrubber")).toHaveValue("250");
    expect(runtime.write).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseSecond();
    });
    await runFrame(850);
    expect(runtime.write).toHaveBeenCalledTimes(2);
    expect(
      new TextDecoder().decode(runtime.write.mock.calls[1]?.[0] as Uint8Array),
    ).toBe("second\n");
    // 멈춘 자리에서 한 프레임(50ms)만 흘렀다.
    expect(screen.getByLabelText("Replay scrubber")).toHaveValue("300");
  });
});
