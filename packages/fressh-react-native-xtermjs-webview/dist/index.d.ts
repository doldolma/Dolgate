import { default as React } from 'react';
import { WebView } from 'react-native-webview';
import { binaryToBStr, bStrToBinary } from './bridge';
export { bStrToBinary, binaryToBStr };
type StrictOmit<T, K extends keyof T> = Omit<T, K>;
type ITerminalOptions = import('@xterm/xterm').ITerminalOptions;
type WebViewOptions = React.ComponentProps<typeof WebView>;
/**
 * Message from this pkg to calling RN
 */
export type XtermInbound = {
    type: 'initialized';
} | {
    type: 'data';
    data: Uint8Array;
} | {
    type: 'debug';
    message: string;
};
export type XtermWebViewHandle = {
    write: (data: Uint8Array) => void;
    writeMany: (chunks: Uint8Array[]) => void;
    flush: () => void;
    clear: () => void;
    focus: () => void;
    resize: (size: {
        cols: number;
        rows: number;
    }) => void;
    fit: () => void;
};
type UserControllableWebViewProps = StrictOmit<WebViewOptions, 'source' | 'style' | 'injectedJavaScriptBeforeContentLoaded'>;
export type XtermJsWebViewProps = {
    ref: React.RefObject<XtermWebViewHandle | null>;
    style?: WebViewOptions['style'];
    webViewOptions?: UserControllableWebViewProps;
    xtermOptions?: Partial<ITerminalOptions>;
    onInitialized?: () => void;
    onData?: (data: string) => void;
    logger?: {
        debug?: (...args: unknown[]) => void;
        log?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
        error?: (...args: unknown[]) => void;
    };
    coalescingThreshold?: number;
    size?: {
        cols: number;
        rows: number;
    };
    autoFit?: boolean;
};
export declare function XtermJsWebView({ ref, style, webViewOptions, xtermOptions, onInitialized, onData, coalescingThreshold, logger, size, autoFit, }: XtermJsWebViewProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=index.d.ts.map