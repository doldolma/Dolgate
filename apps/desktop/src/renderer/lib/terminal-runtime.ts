import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon, type ISerializeOptions } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  Terminal,
  type IDisposable,
  type ITerminalAddon,
  type ITerminalOptions,
  type ITheme
} from '@xterm/xterm';
import { openTerminalExternalUrl } from '../services/desktop/terminal';

const WRITE_FLUSH_THRESHOLD_BYTES = 64 * 1024;

export interface TerminalRuntimeAppearance {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  scrollbackLines: number;
  lineHeight: number;
  letterSpacing: number;
  minimumContrastRatio: number;
  macOptionIsMeta?: boolean;
}

export interface TerminalRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** 현재 셀(글자 1칸) 픽셀 크기. 워크스페이스 단위 tmux client 리사이즈 계산용. */
  getCellSize: () => { width: number; height: number } | null;
  write: (data: Uint8Array | string) => void;
  scheduleAfterWriteDrain: (callback: () => void) => void;
  captureSnapshot: () => string;
  /** 스크롤백까지 포함해 직렬화한다. 터미널 재생성 시 버퍼 복원용. */
  captureRestoreSnapshot: () => string;
  setAppearance: (appearance: TerminalRuntimeAppearance) => void;
  setWebglEnabled: (enabled: boolean) => Promise<void>;
  /** GPU/WebGL 컨텍스트 손실(절전·깨우기 등) 후 강제 재렌더 + 필요 시 WebGL 재생성. */
  repaint: () => void;
  syncDisplayMetrics: () => void;
  focus: () => void;
  /** xterm 현재 선택 텍스트(없으면 ""). AI 컨텍스트 첨부용. */
  getSelection: () => string;
  /** 커서 기준 최근 maxLines 줄의 버퍼 텍스트(후행 빈 줄 제거). AI 컨텍스트 첨부용. */
  captureRecentText: (maxLines: number) => string;
  /** 현재 커서 기준 전체 scrollback 텍스트 라인 snapshot. AI anchored scrollback 조회용. */
  captureTextSnapshot: () => string[];
  findNext: (term: string) => boolean;
  findPrevious: (term: string) => boolean;
  clearSearch: () => void;
  blurSearch: () => void;
  dispose: () => void;
}

interface WebglAddonLike extends ITerminalAddon {
  onContextLoss: (listener: () => void) => IDisposable;
  clearTextureAtlas?: () => void;
  dispose: () => void;
}

interface WebglAddonModuleLike {
  WebglAddon: new (preserveDrawingBuffer?: boolean) => WebglAddonLike;
}

interface CreateTerminalRuntimeDependencies {
  createTerminal?: (options: ITerminalOptions) => Terminal;
  createFitAddon?: () => FitAddon;
  createSearchAddon?: () => SearchAddon;
  createSerializeAddon?: () => SerializeAddon;
  createUnicode11Addon?: () => Unicode11Addon;
  createWebLinksAddon?: (handler: (event: MouseEvent, uri: string) => void) => WebLinksAddon;
  loadWebglAddonModule?: () => Promise<WebglAddonModuleLike>;
  scheduleAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelScheduledAnimationFrame?: (handle: number) => void;
  openExternal?: (url: string) => void | Promise<void>;
  readDevicePixelRatio?: () => number;
  logger?: Pick<Console, 'warn'>;
}

interface CreateTerminalRuntimeOptions {
  container: HTMLElement;
  appearance: TerminalRuntimeAppearance;
  onData: (data: string) => void;
  onBinary: (data: string) => void;
  /**
   * Called with the payload of each OSC 133 shell-integration sequence
   * (`A`, `B`, `C`, `D;<exit>`) emitted by the remote shell. The handler
   * consumes the sequence so it never reaches the screen.
   */
  onShellIntegration?: (marker: string) => void;
  /**
   * Called with the payload of each OSC 7 cwd report (`file://host/path`)
   * emitted by the remote shell.
   */
  onCwd?: (data: string) => void;
  dependencies?: CreateTerminalRuntimeDependencies;
}

let webglAddonModulePromise: Promise<WebglAddonModuleLike> | null = null;

function loadDefaultWebglAddonModule(): Promise<WebglAddonModuleLike> {
  if (!webglAddonModulePromise) {
    webglAddonModulePromise = import('@xterm/addon-webgl') as Promise<WebglAddonModuleLike>;
  }
  return webglAddonModulePromise as Promise<WebglAddonModuleLike>;
}

function scheduleDefaultAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
}

function cancelDefaultAnimationFrame(handle: number): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}

function readDefaultDevicePixelRatio(): number {
  if (typeof window === 'undefined' || typeof window.devicePixelRatio !== 'number' || Number.isNaN(window.devicePixelRatio)) {
    return 1;
  }
  return window.devicePixelRatio;
}

function defaultOpenExternal(url: string): void | Promise<void> {
  return openTerminalExternalUrl(url);
}

function buildTerminalOptions(appearance: TerminalRuntimeAppearance): ITerminalOptions {
  return {
    // 명령 블록 오버레이가 쓰는 marker/decoration 은 xterm 5.x 에서 proposed API 라
    // 이 옵션이 없으면 registerDecoration 이 예외를 던진다(OSC 핸들러 안이라 파싱 루프가
    // 끊겨 터미널이 그 자리에서 멈춘다). unicode11 addon 등록에도 필요하다.
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    theme: appearance.theme,
    scrollback: appearance.scrollbackLines,
    lineHeight: appearance.lineHeight,
    letterSpacing: appearance.letterSpacing,
    minimumContrastRatio: appearance.minimumContrastRatio,
    macOptionIsMeta: appearance.macOptionIsMeta,
    macOptionClickForcesSelection: true
  };
}

function applyTerminalAppearance(terminal: Terminal, appearance: TerminalRuntimeAppearance): void {
  terminal.options.theme = appearance.theme;
  terminal.options.fontFamily = appearance.fontFamily;
  terminal.options.fontSize = appearance.fontSize;
  terminal.options.scrollback = appearance.scrollbackLines;
  terminal.options.lineHeight = appearance.lineHeight;
  terminal.options.letterSpacing = appearance.letterSpacing;
  terminal.options.minimumContrastRatio = appearance.minimumContrastRatio;
  if (typeof appearance.macOptionIsMeta === 'boolean') {
    terminal.options.macOptionIsMeta = appearance.macOptionIsMeta;
  }
}

type QueuedTerminalChunk =
  | {
      kind: 'text';
      value: string;
      size: number;
    }
  | {
      kind: 'binary';
      value: Uint8Array;
      size: number;
    };

function toTerminalChunk(data: Uint8Array | string): QueuedTerminalChunk {
  if (typeof data === 'string') {
    return {
      kind: 'text',
      value: data,
      size: data.length
    };
  }

  return {
    kind: 'binary',
    value: data,
    size: data.byteLength
  };
}

function mergeQueuedChunks(chunks: QueuedTerminalChunk[]): string | Uint8Array {
  const [firstChunk] = chunks;
  if (!firstChunk) {
    return '';
  }

  if (firstChunk.kind === 'text') {
    return chunks.map((chunk) => chunk.value as string).join('');
  }

  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.value as Uint8Array, offset);
    offset += chunk.size;
  }
  return merged;
}

// 링크 탐지는 공식 애드온에 맡긴다. 직접 구현하던 버전은 두 가지를 놓쳤다 — 문자열 인덱스를
// 버퍼 열로 그대로 써서 URL 앞에 와이드 문자(한글·CJK)가 있으면 밑줄/클릭 범위가 어긋났고,
// 한 줄만 조회해서 줄바꿈으로 감싸진 URL 을 잡지 못했다. 애드온은 문자열 인덱스를 버퍼 좌표로
// 역매핑하고(_mapStrIdx) wrap 연속 줄을 이어붙여 처리하며, new URL() 로 오탐도 걸러낸다.
//
// 여는 동작만 우리가 잡는다 — main 프로세스가 스킴을 http(s) 로 제한해 검증하기 때문에
// 애드온 기본 동작(window.open) 대신 이 핸들러를 통과시켜야 한다.
function createLinkActivationHandler(
  openExternal: (url: string) => void | Promise<void>,
  logger: Pick<Console, 'warn'>
): (event: MouseEvent, uri: string) => void {
  return (_event, uri) => {
    Promise.resolve(openExternal(uri)).catch((error: unknown) => {
      logger.warn?.('Failed to open terminal link.', error);
    });
  };
}

function safeWarn(logger: Pick<Console, 'warn'>, message: string, error?: unknown): void {
  if (!logger.warn) {
    return;
  }

  if (error) {
    logger.warn(message, error);
    return;
  }

  logger.warn(message);
}

function sanitizeTerminalLine(line: string): string {
  return line.replace(/\u00a0/g, ' ');
}

function buildViewportSnapshot(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const viewportY = buffer.viewportY;
  const lines: string[] = [];

  for (let index = 0; index < terminal.rows; index += 1) {
    const line = buffer.getLine(viewportY + index);
    lines.push(sanitizeTerminalLine(line?.translateToString(true) ?? ''));
  }

  const cursorRow = Math.min(terminal.rows, Math.max(1, buffer.cursorY + 1));
  const cursorCol = Math.min(terminal.cols, Math.max(1, buffer.cursorX + 1));
  return `\u001b[2J\u001b[H${lines.join('\r\n')}\u001b[${cursorRow};${cursorCol}H`;
}

// 커서 기준 최근 maxLines 줄을 스크롤백 포함 버퍼에서 읽는다(후행 빈 줄 제거). AI 컨텍스트용.
function buildRecentText(terminal: Terminal, maxLines: number): string {
  const buffer = terminal.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  const start = Math.max(0, end - Math.max(1, maxLines) + 1);
  const lines: string[] = [];
  for (let y = start; y <= end; y += 1) {
    lines.push(sanitizeTerminalLine(buffer.getLine(y)?.translateToString(true) ?? ''));
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}

function buildTextSnapshot(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let y = 0; y <= end; y += 1) {
    lines.push(sanitizeTerminalLine(buffer.getLine(y)?.translateToString(true) ?? ''));
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }
  return lines;
}

const VIEWPORT_SERIALIZE_OPTIONS: ISerializeOptions = {
  scrollback: 0,
};

export function createTerminalRuntime({
  container,
  appearance,
  onData,
  onBinary,
  onShellIntegration,
  onCwd,
  dependencies = {}
}: CreateTerminalRuntimeOptions): TerminalRuntime {
  const terminal = (dependencies.createTerminal ?? ((options) => new Terminal(options)))(buildTerminalOptions(appearance));
  const fitAddon = (dependencies.createFitAddon ?? (() => new FitAddon()))();
  let searchAddon: SearchAddon | null = null;
  let serializeAddon: SerializeAddon | null = null;
  let unicode11Addon: Unicode11Addon | null = null;
  const loadWebglAddonModule = dependencies.loadWebglAddonModule ?? loadDefaultWebglAddonModule;
  const scheduleAnimationFrame = dependencies.scheduleAnimationFrame ?? scheduleDefaultAnimationFrame;
  const cancelScheduledAnimationFrame = dependencies.cancelScheduledAnimationFrame ?? cancelDefaultAnimationFrame;
  const openExternal = dependencies.openExternal ?? defaultOpenExternal;
  const readDevicePixelRatio = dependencies.readDevicePixelRatio ?? readDefaultDevicePixelRatio;
  const logger = dependencies.logger ?? console;

  let disposed = false;
  let webglAddon: WebglAddonLike | null = null;
  let webglContextLossDisposable: IDisposable | null = null;
  let webglRequestId = 0;
  let webglDesiredEnabled = false;
  let lastDevicePixelRatio = readDevicePixelRatio();
  let pendingFrameHandle: number | null = null;
  let writeInFlight = false;
  let queuedSize = 0;
  let pendingWriteDrainCallback: (() => void) | null = null;
  let searchAddonLoaded = false;
  const queuedChunks: QueuedTerminalChunk[] = [];

  const disposeDataSubscription = terminal.onData(onData);
  const disposeBinarySubscription = terminal.onBinary(onBinary);

  terminal.loadAddon(fitAddon);
  try {
    searchAddon = (dependencies.createSearchAddon ?? (() => new SearchAddon({ highlightLimit: 500 })))();
    terminal.loadAddon(searchAddon);
    searchAddonLoaded = true;
  } catch (error) {
    searchAddon = null;
    safeWarn(logger, 'Search addon unavailable, continuing without in-terminal search support.', error);
  }
  try {
    serializeAddon = (dependencies.createSerializeAddon ?? (() => new SerializeAddon()))();
    terminal.loadAddon(serializeAddon);
  } catch (error) {
    serializeAddon = null;
    safeWarn(
      logger,
      'Serialize addon unavailable, continuing with the fallback terminal snapshot implementation.',
      error,
    );
  }
  try {
    unicode11Addon = (dependencies.createUnicode11Addon ?? (() => new Unicode11Addon()))();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11';
  } catch (error) {
    unicode11Addon = null;
    safeWarn(logger, 'Unicode11 addon unavailable, continuing with the default unicode width handling.', error);
  }
  try {
    // 인라인 이미지(Sixel + iTerm2 IIP) 렌더링. 항상 활성. SSH 스트림에 들어온 이미지
    // escape sequence를 xterm이 디코드해 그린다. 백엔드 변경은 필요 없다.
    terminal.loadAddon(new ImageAddon({ storageLimit: 128 }));
  } catch (error) {
    safeWarn(logger, 'Image addon unavailable, continuing without inline image (sixel/iip) support.', error);
  }
  terminal.open(container);
  fitAddon.fit();
  // terminal.open() 뒤에 로드한다 — 애드온이 activate 에서 링크 프로바이더를 등록하려면
  // 터미널이 DOM 에 붙어 있어야 한다.
  let webLinksAddon: WebLinksAddon | null = null;
  try {
    const activateLink = createLinkActivationHandler(openExternal, logger);
    webLinksAddon = (dependencies.createWebLinksAddon ?? ((handler) => new WebLinksAddon(handler)))(activateLink);
    terminal.loadAddon(webLinksAddon);
  } catch (error) {
    webLinksAddon = null;
    safeWarn(logger, 'Link detection unavailable, continuing without clickable terminal links.', error);
  }

  let shellIntegrationDisposable: IDisposable | null = null;
  if (onShellIntegration) {
    try {
      // OSC 133 prompt/command lifecycle markers (A/B/C/D). Returning true
      // consumes the sequence so it is never rendered.
      shellIntegrationDisposable = terminal.parser.registerOscHandler(133, (data) => {
        onShellIntegration(data);
        return true;
      });
    } catch (error) {
      safeWarn(logger, 'OSC 133 shell integration unavailable, continuing without prompt markers.', error);
    }
  }

  let cwdDisposable: IDisposable | null = null;
  if (onCwd) {
    try {
      // OSC 7 cwd report (file://host/path). Consumed; not rendered.
      cwdDisposable = terminal.parser.registerOscHandler(7, (data) => {
        onCwd(data);
        return true;
      });
    } catch (error) {
      safeWarn(logger, 'OSC 7 cwd reporting unavailable, continuing without directory context.', error);
    }
  }

  const clearWebglAddon = () => {
    webglContextLossDisposable?.dispose();
    webglContextLossDisposable = null;
    webglAddon?.dispose();
    webglAddon = null;
  };

  const warnFallback = (message: string, error?: unknown) => {
    safeWarn(logger, message, error);
  };

  const applyWebglEnabled = async (enabled: boolean): Promise<void> => {
    webglDesiredEnabled = enabled;
    webglRequestId += 1;
    const requestId = webglRequestId;

    if (!enabled) {
      clearWebglAddon();
      return;
    }

    if (disposed || webglAddon) {
      return;
    }

    try {
      const { WebglAddon } = await loadWebglAddonModule();
      if (disposed || requestId !== webglRequestId || !webglDesiredEnabled || webglAddon) {
        return;
      }

      const nextAddon = new WebglAddon();
      const contextLossDisposable = nextAddon.onContextLoss(() => {
        if (webglAddon !== nextAddon) {
          return;
        }
        clearWebglAddon();
        warnFallback('WebGL renderer context lost, falling back to the default terminal renderer.');
        // macOS 절전/깨우기 등으로 GPU 컨텍스트를 잃으면 WebGL addon을 dispose한 뒤
        // 기본(DOM) 렌더러로 즉시 다시 그려야 화면이 빈 채로 남지 않는다.
        if (!disposed && terminal.rows > 0) {
          terminal.refresh(0, terminal.rows - 1);
        }
      });

      try {
        terminal.loadAddon(nextAddon as never);
      } catch (error) {
        contextLossDisposable.dispose();
        nextAddon.dispose();
        throw error;
      }

      if (disposed || requestId !== webglRequestId || !webglDesiredEnabled) {
        contextLossDisposable.dispose();
        nextAddon.dispose();
        return;
      }

      lastDevicePixelRatio = readDevicePixelRatio();
      webglAddon = nextAddon;
      webglContextLossDisposable = contextLossDisposable;
    } catch (error) {
      warnFallback('WebGL renderer unavailable, falling back to the default terminal renderer.', error);
    }
  };

  const flushPendingWriteDrainCallback = () => {
    if (disposed || writeInFlight || queuedChunks.length > 0) {
      return;
    }

    const nextCallback = pendingWriteDrainCallback;
    pendingWriteDrainCallback = null;
    nextCallback?.();
  };

  const flushWriteQueue = () => {
    if (disposed || writeInFlight || queuedChunks.length === 0) {
      return;
    }

    if (pendingFrameHandle !== null) {
      cancelScheduledAnimationFrame(pendingFrameHandle);
      pendingFrameHandle = null;
    }

    const firstChunk = queuedChunks[0];
    if (!firstChunk) {
      return;
    }
    const chunkKind = firstChunk.kind;
    const nextChunks: QueuedTerminalChunk[] = [];
    let drainedSize = 0;
    while (queuedChunks.length > 0 && queuedChunks[0]?.kind === chunkKind) {
      const drained = queuedChunks.shift();
      if (!drained) {
        break;
      }
      nextChunks.push(drained);
      drainedSize += drained.size;
    }
    queuedSize = Math.max(0, queuedSize - drainedSize);
    writeInFlight = true;
    terminal.write(mergeQueuedChunks(nextChunks), () => {
      writeInFlight = false;
      if (disposed) {
        return;
      }
      if (queuedChunks.length > 0) {
        if (queuedSize >= WRITE_FLUSH_THRESHOLD_BYTES) {
          flushWriteQueue();
          return;
        }
        pendingFrameHandle = scheduleAnimationFrame(() => {
          pendingFrameHandle = null;
          flushWriteQueue();
        });
        return;
      }
      flushPendingWriteDrainCallback();
    });
  };

  /**
   * 대기 중인 출력을 쓴다. 쓸 수 있으면 **지금** 쓰고, 쓰는 중이면 프레임 뒤로 미룬다.
   *
   * 예전에는 모든 출력이 requestAnimationFrame 을 한 번 기다렸다. 대량 출력에서는 그게 맞다 —
   * 여러 청크를 한 번에 합쳐 써서 레이아웃 스래싱을 막는다. 그런데 키 하나 눌러 에코 하나가
   * 오는 상호작용에서는 모을 것이 없는데도 프레임을 기다려, 매 왕복에 8~17ms(60Hz 기준
   * 평균 반 프레임~한 프레임)가 그냥 붙었다.
   *
   * 이 지연은 전송 방식과 무관하게 xterm 에 쓰는 모든 경로에 걸리므로, 네트워크가 빠를수록
   * 비중이 커진다 — LAN·localhost 에서는 체감 지연의 대부분이 이것이었다.
   *
   * 배칭은 그대로 유지된다. 쓰기가 진행되는 동안(writeInFlight) 도착한 청크는 큐에 모이고,
   * 쓰기 완료 콜백이 그것들을 합쳐 쓴다. 즉 부하가 있을 때는 자동으로 모이고, 한가할 때만
   * 즉시 쓴다 — 상호작용에서 이득을 보고 대량 출력은 손해가 없다.
   */
  const scheduleFlush = () => {
    if (disposed || queuedChunks.length === 0) {
      return;
    }
    // 쓰는 중이면 아무것도 하지 않는다. 완료 콜백이 남은 큐를 이어서 비우고, 그 사이 도착한
    // 청크들은 거기서 한 번에 합쳐진다 — 부하가 있을 때의 배칭이 이 경로다.
    if (writeInFlight) {
      return;
    }
    // 이미 예약된 배칭 창이 있으면 그것을 기다린다. 여기서 또 쓰면 창이 무의미해진다.
    if (pendingFrameHandle !== null) {
      return;
    }
    flushWriteQueue();
  };

  const syncDisplayMetrics = () => {
    const nextDevicePixelRatio = readDevicePixelRatio();
    if (!webglAddon || nextDevicePixelRatio === lastDevicePixelRatio) {
      lastDevicePixelRatio = nextDevicePixelRatio;
      return;
    }

    lastDevicePixelRatio = nextDevicePixelRatio;
    try {
      webglAddon.clearTextureAtlas?.();
      fitAddon.fit();
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    } catch (error) {
      clearWebglAddon();
      warnFallback('WebGL renderer failed to refresh after a display scale change, falling back to the default terminal renderer.', error);
    }
  };

  return {
    terminal,
    fitAddon,
    getCellSize: () => {
      const core = (
        terminal as unknown as {
          _core?: {
            _renderService?: {
              dimensions?: {
                css?: { cell?: { width?: number; height?: number } };
              };
            };
          };
        }
      )._core;
      const cell = core?._renderService?.dimensions?.css?.cell;
      if (!cell?.width || !cell?.height) {
        return null;
      }
      return { width: cell.width, height: cell.height };
    },
    getSelection: () => terminal.getSelection(),
    captureRecentText: (maxLines: number) => buildRecentText(terminal, maxLines),
    captureTextSnapshot: () => buildTextSnapshot(terminal),
    write(data) {
      if (disposed) {
        return;
      }

      const nextChunk = toTerminalChunk(data);
      if (nextChunk.size <= 0) {
        return;
      }

      queuedChunks.push(nextChunk);
      queuedSize += nextChunk.size;

      if (queuedSize >= WRITE_FLUSH_THRESHOLD_BYTES) {
        flushWriteQueue();
        return;
      }

      scheduleFlush();
    },
    scheduleAfterWriteDrain(callback) {
      if (disposed) {
        return;
      }

      pendingWriteDrainCallback = callback;
      flushPendingWriteDrainCallback();
    },
    captureSnapshot() {
      if (serializeAddon) {
        try {
          return serializeAddon.serialize(VIEWPORT_SERIALIZE_OPTIONS);
        } catch (error) {
          safeWarn(
            logger,
            'Serialize addon failed to capture the terminal state, falling back to the viewport snapshot.',
            error,
          );
        }
      }
      return buildViewportSnapshot(terminal);
    },
    captureRestoreSnapshot() {
      // 스크롤백까지 포함해 직렬화한다(재생성 시 이전 출력 복원용). 실패하면 빈 문자열.
      if (!serializeAddon) {
        return '';
      }
      try {
        return serializeAddon.serialize({
          scrollback: terminal.options.scrollback ?? 0,
        });
      } catch (error) {
        safeWarn(
          logger,
          'Serialize addon failed to capture the restore snapshot.',
          error,
        );
        return '';
      }
    },
    setAppearance(nextAppearance) {
      applyTerminalAppearance(terminal, nextAppearance);
    },
    setWebglEnabled(enabled) {
      return applyWebglEnabled(enabled);
    },
    repaint() {
      if (disposed) {
        return;
      }
      // 절전/깨우기 후 GL 컨텍스트는 (1)손실되어 addon이 dispose됐거나 (2)손실 이벤트
      // 없이 stale 상태로 남아 빈 화면을 그릴 수 있다. 두 경우 모두 안전하게 복구하려고
      // WebGL을 강제로 재생성한다(원래 켜져 있던 경우). DOM 렌더러면 즉시 refresh만.
      if (webglDesiredEnabled) {
        clearWebglAddon();
        void applyWebglEnabled(true);
      }
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
    },
    syncDisplayMetrics,
    focus() {
      terminal.focus();
    },
    findNext(term) {
      if (!searchAddonLoaded) {
        return false;
      }
      if (!term.trim()) {
        searchAddon?.clearDecorations();
        return false;
      }
      return searchAddon?.findNext(term, { incremental: true }) ?? false;
    },
    findPrevious(term) {
      if (!searchAddonLoaded) {
        return false;
      }
      if (!term.trim()) {
        searchAddon?.clearDecorations();
        return false;
      }
      return searchAddon?.findPrevious(term) ?? false;
    },
    clearSearch() {
      if (!searchAddonLoaded) {
        return;
      }
      searchAddon?.clearDecorations();
    },
    blurSearch() {
      if (!searchAddonLoaded) {
        return;
      }
      searchAddon?.clearActiveDecoration();
    },
    dispose() {
      disposed = true;
      webglRequestId += 1;
      if (pendingFrameHandle !== null) {
        cancelScheduledAnimationFrame(pendingFrameHandle);
        pendingFrameHandle = null;
      }
      pendingWriteDrainCallback = null;
      queuedChunks.length = 0;
      queuedSize = 0;
      clearWebglAddon();
      webLinksAddon?.dispose();
      shellIntegrationDisposable?.dispose();
      cwdDisposable?.dispose();
      disposeBinarySubscription.dispose();
      disposeDataSubscription.dispose();
      terminal.dispose();
    }
  };
}
