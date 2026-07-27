import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AppTheme,
  SessionReplayRecording,
  TerminalThemeId,
} from "@shared";
import { useSessionReplayController } from "../controllers/useSessionReplayController";
import {
  SessionReplayCommandPanel,
  findActiveBlockId,
} from "./SessionReplayCommandPanel";
import { SessionReplayScrubberMarkers } from "./SessionReplayScrubberMarkers";
import {
  scanReplayCommands,
  type ReplayCommandBlock,
  type ReplayCommandScanResult,
} from "../lib/replay-command-scan";
import { createTerminalRuntime, type TerminalRuntime } from "../lib/terminal-runtime";
import {
  getTerminalFontOption,
  getTerminalThemePreset,
  resolveGlobalTerminalThemeId,
} from "../lib/terminal-presets";
import { Badge, Button, EmptyState } from '../ui';
import { ChevronDown, ChevronLeft, ChevronRight } from '../ui/icons';
import { useTranslation } from "react-i18next";
import { t } from "../i18n";

/** 스캔 전에도 자식 memo 가 깨지지 않도록 빈 목록은 고정 참조를 쓴다. */
const NO_COMMAND_BLOCKS: readonly ReplayCommandBlock[] = [];

const MIN_REPLAY_ZOOM_PERCENT = 60;
const MAX_REPLAY_ZOOM_PERCENT = 180;
const REPLAY_ZOOM_STEP_PERCENT = 10;
const REPLAY_SPEED_OPTIONS = [0.5, 1, 2, 4] as const;
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
  if (kind === "local") {
    return "Local";
  }
  if (kind === "aws-ssm") {
    return "AWS SSM";
  }
  if (kind === "aws-ecs-exec") {
    return "AWS ECS Exec";
  }
  if (kind === "serial") {
    return "Serial";
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

/**
 * detail 을 즉시 값이 아니라 팩토리로 받는다. 이 상태는 재생 중 매 프레임 갱신되는데,
 * detail 에 terminalText(captureSnapshot = 화면 전체 직렬화)가 들어 있어 값으로 받으면
 * E2E 가 꺼진 프로덕션에서도 프레임마다 직렬화가 돌아간다. 팩토리면 E2E 일 때만 만든다.
 */
function publishReplayE2EState(
  buildDetail: () => Record<string, unknown> | null,
): void {
  const maybeE2EWindow = window as Window & {
    __dolsshE2E?: unknown;
  };
  if (!maybeE2EWindow.__dolsshE2E) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("dolssh:e2e-replay-state", {
      detail: buildDetail(),
    }),
  );
}

export function SessionReplayWindow({
  recordingId,
}: {
  recordingId: string;
}) {
  const { t: translate } = useTranslation();
  const { getDesktopSettings, getSessionReplay } = useSessionReplayController();
  const [recording, setRecording] = useState<SessionReplayRecording | null>(null);
  // 명령 목록은 녹화 로드 직후 한 번의 사전 스캔으로 채운다(재생을 기다리지 않는다).
  const [commandScan, setCommandScan] = useState<ReplayCommandScanResult | null>(
    null,
  );
  // 스크럽바 hover 로 "그 시점의 명령"을 미리 보여주기 위한 감지 대상.
  const scrubberWrapperRef = useRef<HTMLDivElement>(null);
  // 명령 목록은 기본으로 열어 두되, 터미널을 넓게 보고 싶을 때 접을 수 있다.
  const [commandPanelOpen, setCommandPanelOpen] = useState(true);
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
  const hasTerminalSettings = Boolean(effectiveTerminalSettings);
  const effectiveTerminalSettingsRef = useRef(effectiveTerminalSettings);
  effectiveTerminalSettingsRef.current = effectiveTerminalSettings;
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
    void getDesktopSettings()
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

  const commandBlocks = commandScan?.blocks ?? NO_COMMAND_BLOCKS;
  // 재생 위치로 "지금 그 명령"을 정하는 건 숫자 비교라 프레임마다 돌아도 싸다. 대신 결과가
  // 바뀔 때만 패널이 리렌더되도록 id 만 내려보낸다.
  const activeCommandBlockId = useMemo(
    () => findActiveBlockId(commandBlocks, positionMs),
    [commandBlocks, positionMs],
  );

  // 패널을 접거나 펼치면 터미널 컨테이너 폭이 바뀐다. 리플레이는 녹화 원본 크기를 유지하려고
  // 컨테이너에 맞춘 fit() 을 하지 않기 때문에, 레이아웃만 바뀌고 재렌더가 안 걸리면 화면이
  // 깨진 채로 남는다. 셀 크기는 cols/rows 로 정해져 컨테이너 폭과 무관하므로 레이아웃 측정을
  // 기다릴 필요 없이 바로 다시 그린다(rAF 를 쓰면 재생 루프의 프레임 큐와 섞인다).
  // useEffect 는 페인트 이후라 한 프레임 동안 깨진 화면이 보인다 → useLayoutEffect.
  useLayoutEffect(() => {
    runtimeRef.current?.repaint();
  }, [commandPanelOpen]);

  // 녹화가 준비되면 명령 블록을 한 번 스캔한다. 실패해도 재생 자체는 계속 가능해야 하므로
  // 결과가 없으면 목록만 비워 둔다.
  useEffect(() => {
    if (!recording) {
      setCommandScan(null);
      return;
    }
    let disposed = false;
    // 언마운트/녹화 교체 시 스캔 루프도 멈춘다(수 초짜리 작업이라 그냥 두면 CPU 와 메모리를
    // 계속 문다). 실패해도 재생은 되어야 하므로 catch 로 목록만 비운다.
    void scanReplayCommands(recording, { isCancelled: () => disposed })
      .then((result) => {
        if (!disposed) {
          setCommandScan(result);
        }
      })
      .catch((error: unknown) => {
        console.error('[replay]', t('replay.scanFailed'), error);
        if (!disposed) {
          setCommandScan({ blocks: [], shellIntegrationDetected: false });
        }
      });
    return () => {
      disposed = true;
    };
  }, [recording]);

  useEffect(() => {
    let disposed = false;
    void getSessionReplay(recordingId)
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
            : translate('replay.loadFailed'),
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
    const initialSettings = effectiveTerminalSettingsRef.current;
    if (!recording || !terminalContainer || runtimeRef.current || !initialSettings) {
      return;
    }
    try {
      const themePreset = getTerminalThemePreset(initialSettings.terminalThemeId);
      const nextRuntime = createTerminalRuntime({
        container: terminalContainer,
        appearance: {
          theme: themePreset.theme,
          fontFamily: initialSettings.fontFamily,
          fontSize: initialSettings.fontSize,
          scrollbackLines: initialSettings.scrollbackLines,
          lineHeight: initialSettings.lineHeight,
          letterSpacing: initialSettings.letterSpacing,
          minimumContrastRatio: initialSettings.minimumContrastRatio,
          macOptionIsMeta: initialSettings.altIsMeta,
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
          ? translate('replay.terminalInitFailedWith', { message: error.message })
          : translate('replay.terminalInitFailed'),
      );
      return undefined;
    }
  }, [hasTerminalSettings, recording, terminalContainer]);

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
      document.title = translate('replay.windowTitle');
      return;
    }
    document.title = recording.title
      ? translate('replay.windowTitleWith', { title: recording.title })
      : translate('replay.windowTitle');
  }, [recording]);

  useEffect(() => {
    publishReplayE2EState(() => ({
      recordingId,
      loading,
      isPlaying,
      positionMs,
      durationMs: totalDurationMs,
      zoomPercent,
      errorMessage,
      runtimeErrorMessage,
      terminalText: runtime ? runtime.captureSnapshot() : "",
    }));

    return () => {
      publishReplayE2EState(() => null);
    };
  }, [
    errorMessage,
    isPlaying,
    loading,
    positionMs,
    recordingId,
    runtime,
    runtimeErrorMessage,
    totalDurationMs,
    zoomPercent,
  ]);

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
    setZoomPercent((current) =>
      Math.max(
        MIN_REPLAY_ZOOM_PERCENT,
        Math.min(MAX_REPLAY_ZOOM_PERCENT, current + delta),
      ),
    );
  }, []);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-[0.9rem] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-elevated)_97%,white_3%),color-mix(in_srgb,var(--surface)_96%,var(--app-bg)_4%))] p-[0.7rem] text-[var(--text)]">
      <header className="flex items-start justify-between gap-4">
        {/* 호스트명은 창 타이틀바("세션 Replay · <호스트>")에 이미 있어 중복이라 뺀다. */}
        <div className="min-w-0">
          {recording?.connectionDetails ? (
            <div className="truncate text-[0.85rem] text-[var(--text-soft)]">
              {recording.connectionDetails}
            </div>
          ) : null}
        </div>
        {recording ? (
          <div className="inline-flex flex-wrap items-center gap-2">
            <Badge tone="paused">
              {getConnectionKindLabel(recording.connectionKind)}
            </Badge>
            <Badge tone="stopped">Replay</Badge>
          </div>
        ) : null}
      </header>

      {loading ? (
        <EmptyState title={translate('replay.loading')} />
      ) : null}

      {errorMessage ? (
        <EmptyState title={errorMessage} />
      ) : null}

      {runtimeErrorMessage ? (
        <EmptyState title={runtimeErrorMessage} />
      ) : null}

      {recording ? (
        <>
          {/* 터미널에 세로 공간을 주려고 여백을 줄였다. 총 재생 길이는 재생바의
              "00:01 / 03:36" 과 중복이라 카드로 두지 않는다. */}
          <section className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.6rem]">
            {[
              { label: translate('replay.connectStarted'), value: formatTimestamp(recording.connectedAt) },
              { label: translate('replay.connectEnded'), value: formatTimestamp(recording.disconnectedAt) },
            ].map((stat) => (
              <div
                key={stat.label}
                className="flex min-w-0 flex-col gap-[0.1rem] rounded-[10px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.5rem]"
              >
                <span className="text-[0.74rem] text-[var(--text-soft)]">
                  {stat.label}
                </span>
                <strong className="min-w-0 truncate text-[0.92rem] tabular-nums">
                  {stat.value}
                </strong>
              </div>
            ))}
          </section>

          <section className="flex flex-wrap items-center gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-muted)_96%,white_4%),color-mix(in_srgb,var(--surface)_94%,transparent_6%))] px-[0.9rem] py-[0.5rem] shadow-[inset_0_1px_0_color-mix(in_srgb,white_8%,transparent_92%),0_14px_30px_color-mix(in_srgb,black_10%,transparent_90%)]">
            <Button
              variant="secondary"
              size="sm"
              className="w-[5rem] shrink-0 justify-center px-0 font-bold"
              onClick={togglePlayback}
            >
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <div
              ref={scrubberWrapperRef}
              className="relative min-w-[14rem] flex-[1_1_18rem]"
            >
              <SessionReplayScrubberMarkers
                blocks={commandBlocks}
                durationMs={totalDurationMs}
                hoverTargetRef={scrubberWrapperRef}
              />
              <input
                aria-label="Replay scrubber"
                data-replay-scrubber="true"
                className="w-full"
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
            </div>
            <div className="inline-flex shrink-0 items-center gap-[0.4rem] whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[0.9rem] py-[0.55rem] text-[0.82rem] text-[var(--text-soft)] [font-variant-numeric:tabular-nums]">
              <span>{formatPlaybackDuration(positionMs)}</span>
              <span>/</span>
              <span>{formatPlaybackDuration(totalDurationMs)}</span>
            </div>
            <div className="inline-flex shrink-0 items-center gap-[0.4rem] rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[0.4rem] py-[0.4rem]" aria-label="Replay zoom controls">
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] text-base font-bold leading-none text-[var(--text)] disabled:cursor-default disabled:opacity-45"
                aria-label="Zoom out"
                disabled={zoomPercent <= MIN_REPLAY_ZOOM_PERCENT}
                onClick={() => handleZoomChange(-REPLAY_ZOOM_STEP_PERCENT)}
              >
                -
              </button>
              <span className="min-w-[3.1rem] text-center text-[0.82rem] font-bold text-[var(--text-soft)] [font-variant-numeric:tabular-nums]">{zoomPercent}%</span>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] text-base font-bold leading-none text-[var(--text)] disabled:cursor-default disabled:opacity-45"
                aria-label="Zoom in"
                disabled={zoomPercent >= MAX_REPLAY_ZOOM_PERCENT}
                onClick={() => handleZoomChange(REPLAY_ZOOM_STEP_PERCENT)}
              >
                +
              </button>
            </div>
            <label className="inline-flex shrink-0 items-center gap-[0.55rem] text-[0.82rem] text-[var(--text-soft)]">
              <span className="whitespace-nowrap text-[0.82rem] font-semibold tracking-[0.01em]">{translate('replay.speed')}</span>
              <span className="relative inline-flex focus-within:rounded-full focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--accent-strong)_16%,transparent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--app-bg)]">
                <select
                  aria-label="Replay speed"
                  className="absolute inset-0 z-[1] h-[2.8rem] min-w-[5.35rem] cursor-pointer appearance-none rounded-full opacity-0"
                  value={String(playbackSpeed)}
                  onChange={(event) =>
                    setPlaybackSpeed(Number(event.target.value))
                  }
                >
                  {REPLAY_SPEED_OPTIONS.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}x
                    </option>
                  ))}
                </select>
                <span
                  aria-hidden="true"
                  className="inline-flex h-[2.8rem] min-w-[5.35rem] items-center justify-between gap-[0.55rem] rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[0.9rem] pr-[0.9rem] text-[0.9rem] font-semibold text-[var(--text)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_5%,transparent_95%)]"
                >
                  <span>{playbackSpeed}x</span>
                  <ChevronDown className="h-[0.7rem] w-[0.7rem] text-[var(--text-soft)]" aria-hidden="true" />
                </span>
              </span>
            </label>
          </section>

          {/* 접기 버튼은 터미널과 목록 사이에 둔다 — 그 자리에서 무엇을 접는지가 바로 읽힌다.
              헤더에 두면 배지들과 섞여 버튼인지조차 알기 어렵다. */}
          <div
            className={
              commandPanelOpen
                ? "grid min-h-0 grid-cols-[minmax(0,1fr)_auto_19rem] gap-[0.25rem] max-[900px]:grid-cols-[minmax(0,1fr)_auto]"
                : "grid min-h-0 grid-cols-[minmax(0,1fr)_auto] gap-[0.25rem]"
            }
          >
            <div className="min-h-0 overflow-auto rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_94%,transparent_6%)] p-4">
              <div
                data-testid="session-replay-terminal"
                className="min-h-full min-w-full [&_.xterm]:min-h-full [&_.xterm]:h-full [&_.xterm]:w-full [&_.xterm-viewport]:min-h-full [&_.xterm-viewport]:h-full [&_.xterm-viewport]:w-full [&_.xterm-viewport]:bg-transparent"
                ref={terminalRef}
                style={terminalSurfaceStyle}
              />
            </div>
            <button
              type="button"
              onClick={() => setCommandPanelOpen((current) => !current)}
              aria-expanded={commandPanelOpen}
              aria-label={translate(commandPanelOpen ? 'replay.collapseCommands' : 'replay.expandCommands')}
              title={translate(commandPanelOpen ? 'replay.collapseCommands' : 'replay.expandCommands')}
              className="flex h-12 w-[16px] shrink-0 items-center justify-center self-center rounded-[6px] border border-transparent text-[var(--text-soft)] transition-colors duration-150 hover:border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
            >
              {commandPanelOpen ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronLeft className="h-3.5 w-3.5" />
              )}
            </button>
            {commandPanelOpen ? (
              <SessionReplayCommandPanel
                blocks={commandBlocks}
                scanning={commandScan === null}
                shellIntegrationDetected={
                  commandScan?.shellIntegrationDetected ?? false
                }
                activeBlockId={activeCommandBlockId}
                onSeek={handleSeek}
                className="max-[900px]:hidden"
              />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
