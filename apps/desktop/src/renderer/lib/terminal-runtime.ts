import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  Terminal,
  type IBufferRange,
  type IDisposable,
  type ILink,
  type ILinkProvider,
  type ITerminalAddon,
  type ITerminalOptions,
  type ITheme
} from '@xterm/xterm';

const WRITE_FLUSH_THRESHOLD_BYTES = 64 * 1024;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

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
  write: (data: Uint8Array | string) => void;
  setAppearance: (appearance: TerminalRuntimeAppearance) => void;
  setWebglEnabled: (enabled: boolean) => Promise<void>;
  syncDisplayMetrics: () => void;
  focus: () => void;
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
  createUnicode11Addon?: () => Unicode11Addon;
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
  dependencies?: CreateTerminalRuntimeDependencies;
}

let webglAddonModulePromise: Promise<WebglAddonModuleLike> | null = null;

function loadDefaultWebglAddonModule(): Promise<WebglAddonModuleLike> {
  if (!webglAddonModulePromise) {
    webglAddonModulePromise = import('@xterm/addon-webgl');
  }
  return webglAddonModulePromise;
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
  return window.dolssh.shell.openExternal(url);
}

function buildTerminalOptions(appearance: TerminalRuntimeAppearance): ITerminalOptions {
  return {
    cursorBlink: true,
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    theme: appearance.theme,
    scrollback: appearance.scrollbackLines,
    lineHeight: appearance.lineHeight,
    letterSpacing: appearance.letterSpacing,
    minimumContrastRatio: appearance.minimumContrastRatio,
    macOptionIsMeta: appearance.macOptionIsMeta
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

function toTerminalTextChunk(decoder: TextDecoder, data: Uint8Array | string): { text: string; size: number } {
  if (typeof data === 'string') {
    return {
      text: data,
      size: data.length
    };
  }

  return {
    text: decoder.decode(data, { stream: true }),
    size: data.byteLength
  };
}

function createTerminalLinkProvider(
  terminal: Terminal,
  openExternal: (url: string) => void | Promise<void>,
  logger: Pick<Console, 'warn'>
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const links: ILink[] = [];

      for (const match of text.matchAll(URL_PATTERN)) {
        const url = match[0];
        const startIndex = match.index ?? -1;
        if (!url || startIndex < 0) {
          continue;
        }

        const range: IBufferRange = {
          start: {
            x: startIndex + 1,
            y: bufferLineNumber
          },
          end: {
            x: startIndex + url.length,
            y: bufferLineNumber
          }
        };

        links.push({
          text: url,
          range,
          decorations: {
            underline: true,
            pointerCursor: true
          },
          activate: (_event, linkText) => {
            Promise.resolve(openExternal(linkText)).catch((error: unknown) => {
              logger.warn?.('Failed to open terminal link.', error);
            });
          }
        });
      }

      callback(links.length > 0 ? links : undefined);
    }
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

export function createTerminalRuntime({
  container,
  appearance,
  onData,
  onBinary,
  dependencies = {}
}: CreateTerminalRuntimeOptions): TerminalRuntime {
  const terminal = (dependencies.createTerminal ?? ((options) => new Terminal(options)))(buildTerminalOptions(appearance));
  const fitAddon = (dependencies.createFitAddon ?? (() => new FitAddon()))();
  let searchAddon: SearchAddon | null = null;
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
  let searchAddonLoaded = false;
  const queuedChunks: string[] = [];
  const decoder = new TextDecoder();

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
    unicode11Addon = (dependencies.createUnicode11Addon ?? (() => new Unicode11Addon()))();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11';
  } catch (error) {
    unicode11Addon = null;
    safeWarn(logger, 'Unicode11 addon unavailable, continuing with the default unicode width handling.', error);
  }
  terminal.open(container);
  fitAddon.fit();
  let linkProviderDisposable: IDisposable | null = null;
  try {
    linkProviderDisposable = terminal.registerLinkProvider(createTerminalLinkProvider(terminal, openExternal, logger));
  } catch (error) {
    safeWarn(logger, 'Link detection unavailable, continuing without clickable terminal links.', error);
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

  const flushWriteQueue = () => {
    if (disposed || writeInFlight || queuedChunks.length === 0) {
      return;
    }

    if (pendingFrameHandle !== null) {
      cancelScheduledAnimationFrame(pendingFrameHandle);
      pendingFrameHandle = null;
    }

    const nextChunk = queuedChunks.join('');
    queuedChunks.length = 0;
    queuedSize = 0;
    writeInFlight = true;
    terminal.write(nextChunk, () => {
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
      }
    });
  };

  const scheduleFlush = () => {
    if (disposed || pendingFrameHandle !== null || writeInFlight || queuedChunks.length === 0) {
      return;
    }
    pendingFrameHandle = scheduleAnimationFrame(() => {
      pendingFrameHandle = null;
      flushWriteQueue();
    });
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
    write(data) {
      if (disposed) {
        return;
      }

      const nextChunk = toTerminalTextChunk(decoder, data);
      if (!nextChunk.text) {
        return;
      }

      queuedChunks.push(nextChunk.text);
      queuedSize += nextChunk.size;

      if (queuedSize >= WRITE_FLUSH_THRESHOLD_BYTES) {
        flushWriteQueue();
        return;
      }

      scheduleFlush();
    },
    setAppearance(nextAppearance) {
      applyTerminalAppearance(terminal, nextAppearance);
    },
    async setWebglEnabled(enabled) {
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
      queuedChunks.length = 0;
      queuedSize = 0;
      clearWebglAddon();
      linkProviderDisposable?.dispose();
      disposeBinarySubscription.dispose();
      disposeDataSubscription.dispose();
      terminal.dispose();
    }
  };
}
