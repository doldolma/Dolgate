import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IDisposable, type ITerminalAddon, type ITerminalOptions, type ITheme } from '@xterm/xterm';

export interface TerminalRuntimeAppearance {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
}

export interface TerminalRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  setAppearance: (appearance: TerminalRuntimeAppearance) => void;
  setWebglEnabled: (enabled: boolean) => Promise<void>;
  dispose: () => void;
}

interface WebglAddonLike extends ITerminalAddon {
  onContextLoss: (listener: () => void) => IDisposable;
  dispose: () => void;
}

interface WebglAddonModuleLike {
  WebglAddon: new (preserveDrawingBuffer?: boolean) => WebglAddonLike;
}

interface CreateTerminalRuntimeDependencies {
  createTerminal?: (options: ITerminalOptions) => Terminal;
  createFitAddon?: () => FitAddon;
  loadWebglAddonModule?: () => Promise<WebglAddonModuleLike>;
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

export function createTerminalRuntime({
  container,
  appearance,
  onData,
  onBinary,
  dependencies = {}
}: CreateTerminalRuntimeOptions): TerminalRuntime {
  const terminal = (dependencies.createTerminal ?? ((options) => new Terminal(options)))({
    cursorBlink: true,
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    theme: appearance.theme
  });
  const fitAddon = (dependencies.createFitAddon ?? (() => new FitAddon()))();
  const loadWebglAddonModule = dependencies.loadWebglAddonModule ?? loadDefaultWebglAddonModule;
  const logger = dependencies.logger ?? console;

  let disposed = false;
  let webglAddon: WebglAddonLike | null = null;
  let webglContextLossDisposable: IDisposable | null = null;
  let webglRequestId = 0;
  let webglDesiredEnabled = false;

  const disposeDataSubscription = terminal.onData(onData);
  const disposeBinarySubscription = terminal.onBinary(onBinary);

  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  const clearWebglAddon = () => {
    webglContextLossDisposable?.dispose();
    webglContextLossDisposable = null;
    webglAddon?.dispose();
    webglAddon = null;
  };

  const warnFallback = (message: string, error?: unknown) => {
    if (!logger.warn) {
      return;
    }

    if (error) {
      logger.warn(message, error);
      return;
    }

    logger.warn(message);
  };

  return {
    terminal,
    fitAddon,
    setAppearance(nextAppearance) {
      terminal.options.theme = nextAppearance.theme;
      terminal.options.fontFamily = nextAppearance.fontFamily;
      terminal.options.fontSize = nextAppearance.fontSize;
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

        webglAddon = nextAddon;
        webglContextLossDisposable = contextLossDisposable;
      } catch (error) {
        warnFallback('WebGL renderer unavailable, falling back to the default terminal renderer.', error);
      }
    },
    dispose() {
      disposed = true;
      webglRequestId += 1;
      clearWebglAddon();
      disposeBinarySubscription.dispose();
      disposeDataSubscription.dispose();
      terminal.dispose();
    }
  };
}
