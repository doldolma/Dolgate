type ITerminalOptions = import('@xterm/xterm').ITerminalOptions;
type ITerminalInitOnlyOptions = import('@xterm/xterm').ITerminalInitOnlyOptions;
export type BridgeInboundMessage = {
    type: 'initialized';
} | {
    type: 'input';
    str: string;
} | {
    type: 'debug';
    message: string;
};
export type BridgeOutboundMessage = {
    type: 'write';
    bStr: string;
} | {
    type: 'writeMany';
    chunks: string[];
} | {
    type: 'resize';
    cols: number;
    rows: number;
} | {
    type: 'fit';
} | {
    type: 'setOptions';
    opts: Partial<Omit<ITerminalOptions, keyof ITerminalInitOnlyOptions>>;
} | {
    type: 'clear';
} | {
    type: 'focus';
};
export declare const binaryToBStr: (binary: Uint8Array) => string;
export declare const bStrToBinary: (bStr: string) => Uint8Array;
export {};
//# sourceMappingURL=bridge.d.ts.map