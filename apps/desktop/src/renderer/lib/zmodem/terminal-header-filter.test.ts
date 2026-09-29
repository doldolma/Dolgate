import { describe, expect, it, vi } from 'vitest';
import Zmodem from 'nora-zmodemjs/index.js';
import { createTerminalHeaderFilter } from './terminal-header-filter';

describe('real ZMODEM startup output', () => {
  it('never flushes control bytes when the remaining header arrives late', async () => {
    vi.useFakeTimers();
    try {
      const header = new TextEncoder().encode('**\x18B00000000000000\r\n\x11');
      for (let split = 1; split < header.length; split++) {
        const output: number[] = [];
        const filter = createTerminalHeaderFilter(bytes => output.push(...bytes));
        filter.consume(header.slice(0, split));
        await vi.advanceTimersByTimeAsync(2_000);
        filter.consume(header.slice(split));
        filter.consume(new TextEncoder().encode('$ ready'));
        expect(new TextDecoder().decode(Uint8Array.from(output))).toBe(
          (split < 3 ? '*'.repeat(split) : '') + '$ ready',
        );
        filter.dispose();
      }
    } finally { vi.useRealTimers(); }
  });

  it('shows ordinary asterisks without duplicating them after a delay', async () => {
    vi.useFakeTimers();
    const output: number[] = [];
    const filter = createTerminalHeaderFilter(bytes => output.push(...bytes));
    try {
      filter.consume(Uint8Array.of(42));
      await vi.advanceTimersByTimeAsync(300);
      expect(output).toEqual([42]);
      filter.consume(new TextEncoder().encode(' hello'));
      expect(new TextDecoder().decode(Uint8Array.from(output))).toBe('* hello');
    } finally { filter.dispose(); vi.useRealTimers(); }
  });
  it('hides the real Sentry startup header at every chunk boundary', () => {
    const header = new TextEncoder().encode('**\x18B00000000000000\r\n\x11');
    for (let split = 0; split <= header.length; split++) {
      const output: number[] = [];
      const filter = createTerminalHeaderFilter(bytes => output.push(...bytes));
      let detected = false;
      const sentry = new Zmodem.Sentry({
        to_terminal: bytes => filter.consume(Uint8Array.from(bytes)),
        sender: () => {},
        on_retract: () => {},
        on_detect: detection => { detected = true; detection.confirm().start(); },
      });
      sentry.consume(new TextEncoder().encode('before\r\n'));
      sentry.consume(header.slice(0, split));
      sentry.consume(header.slice(split));
      expect(detected).toBe(true);
      expect(new TextDecoder().decode(Uint8Array.from(output))).toBe('before\r\n');
      filter.dispose();
    }
  });

  it('preserves ordinary text and invalid header candidates', () => {
    const output: number[] = [];
    const filter = createTerminalHeaderFilter(bytes => output.push(...bytes));
    const text = 'hello **not a header\r\n$ ';
    for (const byte of new TextEncoder().encode(text)) filter.consume(Uint8Array.of(byte));
    expect(new TextDecoder().decode(Uint8Array.from(output))).toBe(text);
    filter.dispose();
  });
});
