declare module 'xterm-addon-fit/lib/xterm-addon-fit.js' {
  export class FitAddon {
    activate(terminal: unknown): void;
    dispose(): void;
    fit(): void;
  }
}

declare module 'xterm-addon-search/lib/xterm-addon-search.js' {
  export class SearchAddon {
    constructor(options?: unknown);
    activate(terminal: unknown): void;
    dispose(): void;
    findNext(term: string, options?: unknown): boolean;
    findPrevious(term: string, options?: unknown): boolean;
    clearDecorations(): void;
    clearActiveDecoration(): void;
  }
}

declare module 'xterm-addon-serialize/lib/xterm-addon-serialize.js' {
  export interface ISerializeOptions {
    scrollback?: number;
    excludeAltBuffer?: boolean;
    excludeModes?: boolean;
  }

  export class SerializeAddon {
    activate(terminal: unknown): void;
    dispose(): void;
    serialize(options?: ISerializeOptions): string;
  }
}

declare module 'xterm-addon-unicode11/lib/xterm-addon-unicode11.js' {
  export class Unicode11Addon {
    activate(terminal: unknown): void;
    dispose(): void;
  }
}

declare module 'xterm-addon-webgl/lib/xterm-addon-webgl.js' {
  export class WebglAddon {
    constructor(preserveDrawingBuffer?: boolean);
    activate(terminal: unknown): void;
    onContextLoss(listener: () => void): { dispose(): void };
    clearTextureAtlas?(): void;
    dispose(): void;
  }
}

declare module 'xterm-addon-image/lib/xterm-addon-image.js' {
  export interface IImageAddonOptions {
    enableSizeReports?: boolean;
    pixelLimit?: number;
    storageLimit?: number;
    showPlaceholder?: boolean;
    sixelSupport?: boolean;
    sixelScrolling?: boolean;
    sixelPaletteLimit?: number;
    sixelSizeLimit?: number;
    iipSupport?: boolean;
    iipSizeLimit?: number;
  }

  export class ImageAddon {
    constructor(options?: IImageAddonOptions);
    activate(terminal: unknown): void;
    dispose(): void;
    reset(): void;
    storageLimit: number;
    readonly storageUsage: number;
    showPlaceholder: boolean;
  }
}
