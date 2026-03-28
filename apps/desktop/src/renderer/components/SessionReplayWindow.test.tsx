import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeRecords: [] as Array<{
    terminal: {
      options: Record<string, unknown>;
      reset: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };
    write: ReturnType<typeof vi.fn>;
    setAppearance: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  rafCallbacks: [] as FrameRequestCallback[],
  currentNow: 0,
}));

vi.mock("../lib/terminal-runtime", () => ({
  createTerminalRuntime: vi.fn(() => {
    const runtime = {
      terminal: {
        options: {},
        reset: vi.fn(),
        resize: vi.fn(),
        clear: vi.fn(),
      },
      fitAddon: { fit: vi.fn() },
      write: vi.fn(),
      scheduleAfterWriteDrain: vi.fn(),
      captureSnapshot: vi.fn(() => ""),
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
        sessionReplays: {
          get: vi.fn().mockResolvedValue({
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
          }),
        },
      },
    });
  });

  it("renders replay summary and restores output when seeking with the scrubber", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() =>
      expect(screen.getByText("doldolma.com · 22 · doyoung")).toBeInTheDocument(),
    );
    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    const runtime = mocks.runtimeRecords[0]!;
    runtime.terminal.reset.mockClear();
    runtime.terminal.resize.mockClear();
    runtime.terminal.clear.mockClear();
    runtime.write.mockClear();
    const replayTerminal = document.querySelector(
      ".session-replay-window__terminal",
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

  it("starts playing immediately and keeps paused state when seeking after pause", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    const runtime = mocks.runtimeRecords[0]!;
    runtime.write.mockClear();

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
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

  it("adjusts replay zoom with the plus and minus controls", async () => {
    render(<SessionReplayWindow recordingId="recording-1" />);

    await waitFor(() => expect(mocks.runtimeRecords).toHaveLength(1));
    const runtime = mocks.runtimeRecords[0]!;
    const replayTerminal = document.querySelector(
      ".session-replay-window__terminal",
    ) as HTMLDivElement | null;
    const initialWidth = replayTerminal?.style.width;
    const initialHeight = replayTerminal?.style.height;

    expect(screen.getByText("100%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByText("110%")).toBeInTheDocument();
    await act(async () => {
      const callback = mocks.rafCallbacks.pop();
      callback?.(0);
    });
    expect(replayTerminal?.style.width).not.toBe(initialWidth);
    expect(replayTerminal?.style.height).not.toBe(initialHeight);

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));

    expect(screen.getByText("100%")).toBeInTheDocument();
    await act(async () => {
      const callback = mocks.rafCallbacks.pop();
      callback?.(0);
    });
    expect(replayTerminal?.style.width).toBe(initialWidth);
    expect(replayTerminal?.style.height).toBe(initialHeight);

    fireEvent.change(screen.getByLabelText("Replay scrubber"), {
      target: { value: "1250" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const pausedWidth = replayTerminal?.style.width;
    const pausedHeight = replayTerminal?.style.height;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(screen.getByText("110%")).toBeInTheDocument();
    await act(async () => {
      const callback = mocks.rafCallbacks.pop();
      callback?.(0);
    });
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(replayTerminal?.style.width).not.toBe(pausedWidth);
    expect(replayTerminal?.style.height).not.toBe(pausedHeight);
  });
});
