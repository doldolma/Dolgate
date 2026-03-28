import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  AppTheme,
  SessionReplayRecording,
  TerminalThemeId,
} from "@shared";
import { createTerminalRuntime, type TerminalRuntime } from "../lib/terminal-runtime";
import {
  getTerminalFontOption,
  getTerminalThemePreset,
  resolveGlobalTerminalThemeId,
} from "../lib/terminal-presets";

const MIN_REPLAY_ZOOM_PERCENT = 60;
const MAX_REPLAY_ZOOM_PERCENT = 180;
const REPLAY_ZOOM_STEP_PERCENT = 10;
const FALLBACK_TERMINAL_SETTINGS = {
  fontFamily: getTerminalFontOption("sf-mono").stack,
  fontSize: 13,
  scrollbackLines: 5000,
  lineHeight: 1,
  letterSpacing: 0,
  minimumContrastRatio: 1,
  terminalThemeId: "dolssh-dark" as TerminalThemeId,
  altIsMeta: false,
};

function detectDesktopPlatform(): "darwin" | "win32" | "linux" | "unknown" {
  const userAgent = navigator.userAgent.toLowerCase();
  const userAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = (
    userAgentData.userAgentData?.platform ??
    navigator.platform ??
    ""
  ).toLowerCase();

  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "darwin";
  }
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "win32";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "linux";
  }
  return "unknown";
}

function resolveTheme(theme: AppTheme, prefersDark: boolean): "light" | "dark" {
  if (theme === "light" || theme === "dark") {
    return theme;
  }
  return prefersDark ? "dark" : "light";
}

function formatPlaybackDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ko-KR");
}

function getConnectionKindLabel(kind: SessionReplayRecording["connectionKind"]): string {
  if (kind === "aws-ssm") {
    return "AWS SSM";
  }
  if (kind === "warpgate") {
    return "Warpgate";
  }
  return "SSH";
}

function decodeBase64Chunk(dataBase64: string): Uint8Array {
  const binary = window.atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function SessionReplayWindow({
  recordingId,
}: {
  recordingId: string;
}) {
  const [recording, setRecording] = useState<SessionReplayRecording | null>(null);
  const [settingsTheme, setSettingsTheme] = useState<AppTheme>("system");
  const [prefersDark, setPrefersDark] = useState(() => {
    if (typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [terminalSettings, setTerminalSettings] = useState<{
    fontFamily: string;
    fontSize: number;
    scrollbackLines: number;
    lineHeight: number;
    letterSpacing: number;
    minimumContrastRatio: number;
    terminalThemeId: TerminalThemeId;
    altIsMeta: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(null);
  const [terminalContainer, setTerminalContainer] = useState<HTMLDivElement | null>(null);
  const [terminalViewport, setTerminalViewport] = useState<{
    cols: number;
    rows: number;
  } | null>(null);
  const [runtimeErrorMessage, setRuntimeErrorMessage] = useState<string | null>(null);
  const runtimeRef = useRef<TerminalRuntime | null>(null);
  const isPlayingRef = useRef(false);
  const appliedIndexRef = useRef(-1);
  const appliedPositionRef = useRef(0);
  const positionMsRef = useRef(0);
  const initializedRecordingIdRef = useRef<string | null>(null);
  const appliedViewportRef = useRef<{
    cols: number;
    rows: number;
  } | null>(null);
  const desktopPlatform = useMemo(() => detectDesktopPlatform(), []);

  const totalDurationMs = recording?.durationMs ?? 0;
  const progressPercent =
    totalDurationMs > 0
      ? Math.max(0, Math.min(100, (Math.min(positionMs, totalDurationMs) / totalDurationMs) * 100))
      : 0;
  const resolvedTheme = useMemo(
    () => resolveTheme(settingsTheme, prefersDark),
    [prefersDark, settingsTheme],
  );
  const zoomScale = zoomPercent / 100;
  const effectiveTerminalSettings = useMemo(() => {
    if (!terminalSettings) {
      return null;
    }
    return {
      ...terminalSettings,
      fontSize: Math.max(8, Math.round(terminalSettings.fontSize * zoomScale * 10) / 10),
    };
  }, [terminalSettings, zoomScale]);
  const terminalRef = useCallback((node: HTMLDivElement | null) => {
    setTerminalContainer(node);
  }, []);
  const terminalSurfaceStyle = useMemo<CSSProperties | undefined>(() => {
    if (!terminalViewport || !effectiveTerminalSettings) {
      return undefined;
    }

    const approximateCellWidth =
      effectiveTerminalSettings.fontSize * (desktopPlatform === "darwin" ? 0.61 : 0.6) +
      Math.max(0, effectiveTerminalSettings.letterSpacing);
    const approximateCellHeight =
      effectiveTerminalSettings.fontSize * effectiveTerminalSettings.lineHeight;

    return {
      width: `${Math.ceil(terminalViewport.cols * approximateCellWidth + 32)}px`,
      height: `${Math.ceil(terminalViewport.rows * approximateCellHeight + 32)}px`,
    };
  }, [desktopPlatform, effectiveTerminalSettings, terminalViewport]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = settingsTheme;
    document.documentElement.dataset.platform = desktopPlatform;
  }, [desktopPlatform, resolvedTheme, settingsTheme]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.dolssh.settings
      .get()
      .then((settings) => {
        if (disposed) {
          return;
        }
        setSettingsTheme(settings.theme);
        const themeId = resolveGlobalTerminalThemeId(
          settings.globalTerminalThemeId,
          prefersDark,
        );
        setTerminalSettings({
          fontFamily: getTerminalFontOption(settings.terminalFontFamily).stack,
          fontSize: settings.terminalFontSize,
          scrollbackLines: settings.terminalScrollbackLines,
          lineHeight: settings.terminalLineHeight,
          letterSpacing: settings.terminalLetterSpacing,
          minimumContrastRatio: settings.terminalMinimumContrastRatio,
          terminalThemeId: themeId,
          altIsMeta: settings.terminalAltIsMeta,
        });
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        setTerminalSettings(FALLBACK_TERMINAL_SETTINGS);
      });
    return () => {
      disposed = true;
    };
  }, [prefersDark]);

  useEffect(() => {
    let disposed = false;
    void window.dolssh.sessionReplays
      .get(recordingId)
      .then((nextRecording) => {
        if (disposed) {
          return;
        }
        setRecording(nextRecording);
        setErrorMessage(null);
        setRuntimeErrorMessage(null);
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "세션 replay를 불러오지 못했습니다.",
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [recordingId]);

  useEffect(() => {
    if (!recording || !terminalContainer || runtimeRef.current || !effectiveTerminalSettings) {
      return;
    }
    try {
      const themePreset = getTerminalThemePreset(effectiveTerminalSettings.terminalThemeId);
      const nextRuntime = createTerminalRuntime({
        container: terminalContainer,
        appearance: {
          theme: themePreset.theme,
          fontFamily: effectiveTerminalSettings.fontFamily,
          fontSize: effectiveTerminalSettings.fontSize,
          scrollbackLines: effectiveTerminalSettings.scrollbackLines,
          lineHeight: effectiveTerminalSettings.lineHeight,
          letterSpacing: effectiveTerminalSettings.letterSpacing,
          minimumContrastRatio: effectiveTerminalSettings.minimumContrastRatio,
          macOptionIsMeta: effectiveTerminalSettings.altIsMeta,
        },
        onData: () => undefined,
        onBinary: () => undefined,
      });
      runtimeRef.current = nextRuntime;
      setRuntime(nextRuntime);
      setRuntimeErrorMessage(null);
      nextRuntime.terminal.options.disableStdin = true;
      return () => {
        nextRuntime.dispose();
        runtimeRef.current = null;
        setRuntime(null);
      };
    } catch (error) {
      runtimeRef.current = null;
      setRuntime(null);
      setRuntimeErrorMessage(
        error instanceof Error
          ? `세션 replay 터미널을 초기화하지 못했습니다. ${error.message}`
          : "세션 replay 터미널을 초기화하지 못했습니다.",
      );
      return undefined;
    }
  }, [effectiveTerminalSettings, recording, terminalContainer]);

  useEffect(() => {
    positionMsRef.current = positionMs;
  }, [positionMs]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!runtime || !effectiveTerminalSettings) {
      return;
    }
    const themePreset = getTerminalThemePreset(effectiveTerminalSettings.terminalThemeId);
    runtime.setAppearance({
      theme: themePreset.theme,
      fontFamily: effectiveTerminalSettings.fontFamily,
      fontSize: effectiveTerminalSettings.fontSize,
      scrollbackLines: effectiveTerminalSettings.scrollbackLines,
      lineHeight: effectiveTerminalSettings.lineHeight,
      letterSpacing: effectiveTerminalSettings.letterSpacing,
      minimumContrastRatio: effectiveTerminalSettings.minimumContrastRatio,
      macOptionIsMeta: effectiveTerminalSettings.altIsMeta,
    });
  }, [effectiveTerminalSettings, runtime]);

  const syncTerminalViewport = useCallback((cols: number, rows: number) => {
    const current = appliedViewportRef.current;
    if (current && current.cols === cols && current.rows === rows) {
      return;
    }
    const nextViewport = { cols, rows };
    appliedViewportRef.current = nextViewport;
    setTerminalViewport(nextViewport);
  }, []);

  const resetTerminal = useCallback(() => {
    if (!runtime || !recording) {
      return;
    }
    runtime.terminal.reset();
    runtime.terminal.resize(
      recording.initialCols,
      recording.initialRows,
    );
    runtime.terminal.clear();
    appliedIndexRef.current = -1;
    appliedPositionRef.current = 0;
    syncTerminalViewport(recording.initialCols, recording.initialRows);
  }, [recording, runtime, syncTerminalViewport]);

  const applyUntil = useCallback(
    (targetMs: number) => {
      if (!recording || !runtime) {
        return;
      }

      if (targetMs < appliedPositionRef.current) {
        resetTerminal();
      }

      let latestViewport: { cols: number; rows: number } | null = null;

      for (
        let index = appliedIndexRef.current + 1;
        index < recording.entries.length;
        index += 1
      ) {
        const entry = recording.entries[index];
        if (entry.atMs > targetMs) {
          break;
        }
        if (entry.type === "resize") {
          runtime.terminal.resize(entry.cols, entry.rows);
          latestViewport = { cols: entry.cols, rows: entry.rows };
        } else {
          runtime.write(decodeBase64Chunk(entry.dataBase64));
        }
        appliedIndexRef.current = index;
      }

      appliedPositionRef.current = targetMs;
      if (latestViewport) {
        syncTerminalViewport(latestViewport.cols, latestViewport.rows);
      }
    },
    [recording, resetTerminal, runtime, syncTerminalViewport],
  );

  useEffect(() => {
    if (!recording || !runtime) {
      return;
    }
    if (initializedRecordingIdRef.current === recording.recordingId) {
      return;
    }
    resetTerminal();
    applyUntil(0);
    setPositionMs(0);
    setIsPlaying(true);
    initializedRecordingIdRef.current = recording.recordingId;
  }, [applyUntil, recording, resetTerminal, runtime]);

  useEffect(() => {
    if (!isPlaying || !recording) {
      return;
    }

    const startPosition = positionMs;
    const startAt = performance.now();
    let frameHandle = 0;

    const tick = () => {
      if (!isPlayingRef.current) {
        return;
      }
      const elapsedMs = (performance.now() - startAt) * playbackSpeed;
      const nextPosition = Math.min(
        recording.durationMs,
        startPosition + elapsedMs,
      );
      applyUntil(nextPosition);
      setPositionMs(nextPosition);

      if (nextPosition >= recording.durationMs) {
        setIsPlaying(false);
        return;
      }

      frameHandle = window.requestAnimationFrame(tick);
    };

    frameHandle = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frameHandle);
    };
  }, [applyUntil, isPlaying, playbackSpeed, positionMs, recording]);

  useEffect(() => {
    if (!recording) {
      document.title = "세션 Replay";
      return;
    }
    document.title = recording.title
      ? `세션 Replay · ${recording.title}`
      : "세션 Replay";
  }, [recording]);

  const handleSeek = useCallback(
    (nextPosition: number) => {
      const clamped = Math.max(0, Math.min(totalDurationMs, nextPosition));
      applyUntil(clamped);
      setPositionMs(clamped);
    },
    [applyUntil, totalDurationMs],
  );

  const togglePlayback = useCallback(() => {
    if (!recording) {
      return;
    }
    if (positionMs >= totalDurationMs) {
      handleSeek(0);
    }
    setIsPlaying((current) => !current);
  }, [handleSeek, positionMs, recording, totalDurationMs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.code !== "Space") {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (((target.tagName === "INPUT" &&
          (target as HTMLInputElement).type !== "range") ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "BUTTON" ||
          target.isContentEditable))
      ) {
        return;
      }

      event.preventDefault();
      togglePlayback();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [togglePlayback]);

  const handleZoomChange = useCallback((delta: number) => {
    setZoomPercent((current) => {
      const next = Math.max(
        MIN_REPLAY_ZOOM_PERCENT,
        Math.min(MAX_REPLAY_ZOOM_PERCENT, current + delta),
      );
      if (next !== current && recording && runtimeRef.current) {
        window.requestAnimationFrame(() => {
          if (!runtimeRef.current) {
            return;
          }
          const targetPosition = Math.min(
            positionMsRef.current,
            recording.durationMs,
          );
          resetTerminal();
          applyUntil(targetPosition);
        });
      }
      return next;
    });
  }, [applyUntil, recording, resetTerminal]);

  return (
    <div className="session-replay-window">
      <header className="session-replay-window__header">
        <div>
          <div className="session-replay-window__eyebrow">Session Replay</div>
          <strong>{recording?.hostLabel || "세션 Replay"}</strong>
          {recording?.connectionDetails ? (
            <div className="session-replay-window__subtitle">
              {recording.connectionDetails}
            </div>
          ) : null}
        </div>
        {recording ? (
          <div className="session-replay-window__badges">
            <span className="status-pill status-pill--paused">
              {getConnectionKindLabel(recording.connectionKind)}
            </span>
            <span className="status-pill status-pill--stopped">Replay</span>
          </div>
        ) : null}
      </header>

      {loading ? (
        <div className="empty-callout">
          <strong>세션 replay를 불러오는 중입니다.</strong>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="empty-callout">
          <strong>{errorMessage}</strong>
        </div>
      ) : null}

      {runtimeErrorMessage ? (
        <div className="empty-callout">
          <strong>{runtimeErrorMessage}</strong>
        </div>
      ) : null}

      {recording ? (
        <>
          <section className="session-replay-window__summary">
            <div className="session-replay-window__summary-item">
              <span>연결 시작</span>
              <strong>{formatTimestamp(recording.connectedAt)}</strong>
            </div>
            <div className="session-replay-window__summary-item">
              <span>연결 종료</span>
              <strong>{formatTimestamp(recording.disconnectedAt)}</strong>
            </div>
            <div className="session-replay-window__summary-item">
              <span>총 재생 길이</span>
              <strong>{formatPlaybackDuration(recording.durationMs)}</strong>
            </div>
          </section>

          <section className="session-replay-window__controls">
            <button
              type="button"
              className="secondary-button session-replay-window__play-toggle"
              onClick={togglePlayback}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>
            <input
              aria-label="Replay scrubber"
              className="session-replay-window__scrubber"
              style={
                {
                  "--session-replay-progress": `${progressPercent}%`,
                } as CSSProperties
              }
              type="range"
              min={0}
              max={Math.max(0, totalDurationMs)}
              step={100}
              value={Math.min(positionMs, totalDurationMs)}
              onChange={(event) => {
                handleSeek(Number(event.target.value));
              }}
            />
            <div className="session-replay-window__time">
              <span>{formatPlaybackDuration(positionMs)}</span>
              <span>/</span>
              <span>{formatPlaybackDuration(totalDurationMs)}</span>
            </div>
            <div className="session-replay-window__zoom" aria-label="Replay zoom controls">
              <button
                type="button"
                className="session-replay-window__zoom-button"
                aria-label="Zoom out"
                disabled={zoomPercent <= MIN_REPLAY_ZOOM_PERCENT}
                onClick={() => handleZoomChange(-REPLAY_ZOOM_STEP_PERCENT)}
              >
                -
              </button>
              <span className="session-replay-window__zoom-value">{zoomPercent}%</span>
              <button
                type="button"
                className="session-replay-window__zoom-button"
                aria-label="Zoom in"
                disabled={zoomPercent >= MAX_REPLAY_ZOOM_PERCENT}
                onClick={() => handleZoomChange(REPLAY_ZOOM_STEP_PERCENT)}
              >
                +
              </button>
            </div>
            <label className="session-replay-window__speed">
              <span className="session-replay-window__speed-label">속도</span>
              <select
                aria-label="Replay speed"
                value={String(playbackSpeed)}
                onChange={(event) =>
                  setPlaybackSpeed(Number(event.target.value))
                }
              >
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
              </select>
            </label>
          </section>

          <div className="session-replay-window__terminal-shell">
            <div
              className="session-replay-window__terminal"
              ref={terminalRef}
              style={terminalSurfaceStyle}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
