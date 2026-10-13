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
  type ITheme,
  type IWindowsPty
} from '@xterm/xterm';
import { openTerminalExternalUrl } from '../services/desktop/terminal';

const WRITE_FLUSH_THRESHOLD_BYTES = 64 * 1024;

/**
 * 한 번에 xterm 에 넘기는 출력의 상한. 쌓인 큐를 이 크기씩 나눠 넘긴다.
 *
 * xterm 은 넘겨받은 조각을 통째로 파싱하고, 화면이 멈추지 않게 쉬어 가는 것은 조각 **사이**에서다
 * (12ms 마다). 큐를 한 조각으로 합치면 대량 출력에서 그 조각이 수십 MB 가 되어, 파싱이 끝날 때까지
 * 렌더러가 통째로 멈췄다 — `yes` 를 10초 흘리자 58MB 한 조각에 앱 전체가 18초 동안 굳었다(실측).
 *
 * 그 크기는 탭을 영영 멈추게도 했다. xterm 은 밀린 양이 50MB 를 넘으면 새 쓰기를 예외로 거부하는데,
 * 끝난 조각의 크기를 빼기 **전에** 완료 콜백을 부른다. 그 콜백에서 다음 조각을 넘기는 순간 거부당했고,
 * 예외가 xterm 의 처리 루프를 빠져나가 다음 처리가 예약되지 않았다(아래 flushWriteQueue 의 catch).
 *
 * 한 번에 하나만 넘기므로(writeInFlight) xterm 에 밀리는 양은 이 크기 남짓을 넘지 않는다. 코어가
 * 출력을 4KB 씩 읽어 보내므로 청크 하나가 이보다 큰 일은 없다 — 청크는 쪼개지 않는다.
 */
const MAX_WRITE_BATCH_BYTES = 256 * 1024;

/**
 * Windows ConPTY 를 거치는 세션(isConptyHostedTab)의 xterm 에 주는 값.
 *
 * ConPTY 는 행이 늘면 자기 화면을 위쪽 정렬로 다시 그리고 아래에 빈 행을 붙인다. xterm 은 기본으로
 * 스크롤백을 끌어내려 화면을 채우는데, 그 위에 ConPTY 의 재그리기가 덮이면 글자는 늘어난 행 수만큼
 * 위로 올라가고 마커(명령 블록 점)는 제자리에 남으며, 그 사이 스크롤백 줄이 덮여 사라진다(실측:
 * 39→53행에서 14행 어긋남, 14줄 소실). backend 를 주면 xterm 도 ConPTY 처럼 아래에 빈 행만 붙인다.
 *
 * buildNumber 는 주지 않는다. 그 값이 바꾸는 것은 21376 미만(Windows 10)에서 reflow 를 끄고 줄 끝
 * 글자로 접힘을 추정하는 것뿐인데, 그게 우리 앱에 나은지 확인할 수 없어서 지금의 reflow 를 유지한다.
 */
export const CONPTY_WINDOWS_PTY: IWindowsPty = { backend: 'conpty' };

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
  /** 넘겨받았지만 xterm 이 아직 처리를 끝내지 않은 출력의 크기(큐 + 쓰는 중인 묶음). */
  pendingOutputSize: () => number;
  scheduleAfterWriteDrain: (callback: () => void) => void;
  captureSnapshot: () => string;
  /** 스크롤백까지 포함해 직렬화한다. 터미널 재생성 시 버퍼 복원용. */
  captureRestoreSnapshot: () => string;
  setAppearance: (appearance: TerminalRuntimeAppearance) => void;
  /** 만든 뒤 세션이 ConPTY 를 거치는지가 바뀌면 부른다(CONPTY_WINDOWS_PTY). undefined 면 해제. */
  setWindowsPty: (windowsPty: IWindowsPty | undefined) => void;
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
  /**
   * 처음부터 이 격자로 만든다. 주지 않으면 xterm 기본(80x24)으로 만들어지고 fit/resize 가 뒤에 온다.
   *
   * tmux pane 에 필요하다. 마운트되면 백로그(재연결 복원 바이트 포함)가 **같은 커밋에서 즉시**
   * 재생되는데, tmux 칸 수로 맞추는 resize 는 다음 애니메이션 프레임에 온다. 그 사이 80칸
   * xterm 에 들어온 줄은 잘리고, 나중에 101칸으로 늘어나도 잘린 칸은 돌아오지 않는다 — 사용자
   * 화면에 `tmux delete-i` 로 끊긴 줄이 남은 것이 이것이다. 크기는 tmux 가 방금 보낸 레이아웃
   * (%layout-change)에서 오며, 어디에도 기억해 두지 않는다.
   */
  /**
   * 칸 수를 밖에서 정하는 터미널(tmux pane)의 격자. 주면 이 크기로 만들고 **컨테이너에 fit 하지
   * 않는다** — 만들 때도, 화면 배율이 바뀔 때도. tmux pane 의 크기는 tmux 가 정하고 컨트롤러가
   * `terminal.resize` 로 따라간다. 컨테이너 픽셀로 재면 한두 칸 어긋난 격자가 나오는데, 그 위에
   * 쓰인 내용은 뒤에 칸 수를 바로잡아도 되돌아오지 않는다(줄이 감기고 밀린 채 다시 흐른다).
   */
  initialSize?: { cols: number; rows: number };
  /** 세션이 Windows ConPTY 를 거치면 CONPTY_WINDOWS_PTY. 그 밖에는 주지 않는다(xterm 기본값). */
  windowsPty?: IWindowsPty;
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
  /**
   * 화면 전체 지우기(ED2, `ESC[2J`)가 적용되기 **직전**에 불린다. 지우기 자체는 그대로 일어난다 —
   * 명령 블록이 지워질 줄을 계속 자기 범위로 잡지 않게 알려 주는 용도다(Ctrl+L·clear·cls).
   */
  onScreenErase?: () => void;
  /**
   * xterm 이 묶음 하나를 처리할 때마다 불린다. 실시간 세션이 출력 흐름 제어에 처리한 양을 알리는
   * 데 쓴다(pendingOutputSize 와 함께) — 리플레이는 넘기지 않는다.
   */
  onWriteSettled?: () => void;
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

function buildTerminalOptions(
  appearance: TerminalRuntimeAppearance,
  initialSize?: { cols: number; rows: number },
  windowsPty?: IWindowsPty,
): ITerminalOptions {
  return {
    ...(initialSize && initialSize.cols > 0 && initialSize.rows > 0
      ? { cols: initialSize.cols, rows: initialSize.rows }
      : {}),
    ...(windowsPty ? { windowsPty } : {}),
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
  onScreenErase,
  onWriteSettled,
  dependencies = {},
  initialSize,
  windowsPty,
}: CreateTerminalRuntimeOptions): TerminalRuntime {
  const terminal = (dependencies.createTerminal ?? ((options) => new Terminal(options)))(
    buildTerminalOptions(appearance, initialSize, windowsPty),
  );
  // 격자가 밖에서 고정된 터미널인가(initialSize 주석). 이 값이 true 면 어디서도 컨테이너에 fit 하지
  // 않는다.
  const fixedGrid = Boolean(initialSize && initialSize.cols > 0 && initialSize.rows > 0);
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
  // 쓰는 중인 묶음의 크기. 처리 안 된 출력(pendingOutputSize)은 큐와 이것의 합이다.
  let inFlightSize = 0;
  let queuedSize = 0;
  let pendingWriteDrainCallback: (() => void) | null = null;
  let searchAddonLoaded = false;
  const queuedChunks: QueuedTerminalChunk[] = [];
  // 큐에서 다음에 꺼낼 자리. Array.shift 는 큰 배열에서 매번 나머지 전체를 옮겨서, 대량 출력이 쌓였을 때
  // 꺼내는 일이 그리는 구간 CPU 의 82% 를 먹었다(실측, 38,000 청크). 머리 자리만 옮기고, 꺼낸 앞부분이
  // 절반을 넘으면 한 번에 잘라 낸다.
  let queueHead = 0;
  const queuedCount = () => queuedChunks.length - queueHead;

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
  // 고정 격자(tmux pane)는 만들 때 준 칸 수 그대로 둔다. 여기서 fit 하면 initialSize 를 준 뜻이
  // 없어진다 — 마운트 직후 들어오는 백로그(재연결 복원)가 컨테이너 크기로 어긋난 격자에 쓰인다.
  if (!fixedGrid) {
    fitAddon.fit();
  }
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

  let screenEraseDisposable: IDisposable | null = null;
  if (onScreenErase) {
    try {
      // CSI 2 J (ED2). false 를 돌려 xterm 의 기본 처리(실제 지우기)는 그대로 이어지게 한다. 이
      // 핸들러가 먼저 불리므로 지워질 줄의 번호를 지우기 전 그대로 읽을 수 있다.
      screenEraseDisposable = terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
        if (params[0] === 2) {
          onScreenErase();
        }
        return false;
      });
    } catch (error) {
      safeWarn(logger, 'Screen erase hook unavailable, continuing without command block trimming.', error);
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
    if (disposed || writeInFlight || queuedCount() > 0) {
      return;
    }

    const nextCallback = pendingWriteDrainCallback;
    pendingWriteDrainCallback = null;
    nextCallback?.();
  };

  // xterm 의 완료 콜백 안에서 불린다. 여기서 던지면 xterm 의 처리 루프가 멈추므로(위 catch 주석) 삼킨다.
  const notifyWriteSettled = () => {
    if (!onWriteSettled) {
      return;
    }
    try {
      onWriteSettled();
    } catch (error) {
      safeWarn(logger, 'Terminal write-settled handler failed.', error);
    }
  };

  const flushWriteQueue = () => {
    if (disposed || writeInFlight || queuedCount() === 0) {
      return;
    }

    if (pendingFrameHandle !== null) {
      cancelScheduledAnimationFrame(pendingFrameHandle);
      pendingFrameHandle = null;
    }

    const firstChunk = queuedChunks[queueHead];
    if (!firstChunk) {
      return;
    }
    const chunkKind = firstChunk.kind;
    const nextChunks: QueuedTerminalChunk[] = [];
    let drainedSize = 0;
    for (let next = queuedChunks[queueHead]; next && next.kind === chunkKind; next = queuedChunks[queueHead]) {
      // 상한을 넘으면 나머지는 다음 쓰기로 넘긴다(MAX_WRITE_BATCH_BYTES). 첫 청크는 크기와 상관없이 넣는다.
      if (nextChunks.length > 0 && drainedSize + next.size > MAX_WRITE_BATCH_BYTES) {
        break;
      }
      queueHead += 1;
      nextChunks.push(next);
      drainedSize += next.size;
    }
    if (queueHead === queuedChunks.length) {
      queuedChunks.length = 0;
      queueHead = 0;
    } else if (queueHead >= 1024 && queueHead * 2 >= queuedChunks.length) {
      queuedChunks.splice(0, queueHead);
      queueHead = 0;
    }
    queuedSize = Math.max(0, queuedSize - drainedSize);
    writeInFlight = true;
    inFlightSize = drainedSize;
    try {
      terminal.write(mergeQueuedChunks(nextChunks), () => {
        writeInFlight = false;
        inFlightSize = 0;
        if (disposed) {
          return;
        }
        if (queuedCount() > 0) {
          if (queuedSize >= WRITE_FLUSH_THRESHOLD_BYTES) {
            flushWriteQueue();
          } else {
            pendingFrameHandle = scheduleAnimationFrame(() => {
              pendingFrameHandle = null;
              flushWriteQueue();
            });
          }
        } else {
          flushPendingWriteDrainCallback();
        }
        notifyWriteSettled();
      });
    } catch (error) {
      // xterm 이 쓰기를 거부했다(밀린 양이 한도를 넘었다). 이 함수는 xterm 의 완료 콜백 안에서도 불리므로,
      // 예외를 그대로 올리면 xterm 의 처리 루프가 다음 처리를 예약하지 못하고 멈춘다 — 그 탭은 다시는
      // 아무것도 그리지 않는다. 출력을 큐 앞에 되돌리고 다음 프레임에 다시 넘긴다.
      writeInFlight = false;
      inFlightSize = 0;
      queuedChunks.splice(queueHead, 0, ...nextChunks);
      queuedSize += drainedSize;
      safeWarn(logger, 'xterm rejected a terminal write, retrying on the next frame.', error);
      pendingFrameHandle = scheduleAnimationFrame(() => {
        pendingFrameHandle = null;
        flushWriteQueue();
      });
    }
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
    if (disposed || queuedCount() === 0) {
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
      // 배율이 바뀌어도 격자는 그대로다. 고정 격자는 컨테이너에 다시 맞추지 않는다(위 initialSize).
      if (!fixedGrid) {
        fitAddon.fit();
      }
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
    pendingOutputSize: () => (disposed ? 0 : queuedSize + inFlightSize),
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
    setWindowsPty(nextWindowsPty) {
      // 빈 객체가 xterm 기본값이다(ConPTY 아님).
      terminal.options.windowsPty = nextWindowsPty ?? {};
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
      queueHead = 0;
      queuedSize = 0;
      clearWebglAddon();
      webLinksAddon?.dispose();
      shellIntegrationDisposable?.dispose();
      cwdDisposable?.dispose();
      screenEraseDisposable?.dispose();
      disposeBinarySubscription.dispose();
      disposeDataSubscription.dispose();
      terminal.dispose();
    }
  };
}
