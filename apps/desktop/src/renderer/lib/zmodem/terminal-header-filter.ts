// Sentry intentionally echoes its initial hex header, including fragmented headers.
// Hold only possible header bytes; preserve all other terminal output in order.
export function createTerminalHeaderFilter(write: (bytes: Uint8Array) => void) {
  let pending: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let optionalXon = false;
  let displayedPrefix = 0;
  const prefix = [42, 42, 24, 66];
  const flush = () => {
    // A lone '*' is ordinary terminal text. Show printable prefixes without
    // forgetting them, so a delayed ZDLE still cannot leak protocol bytes.
    if (pending.length < 3 && pending.length > displayedPrefix) {
      write(Uint8Array.from(pending.slice(displayedPrefix)));
      displayedPrefix = pending.length;
    }
  };
  return {
    consume(bytes: Uint8Array) {
      clearTimeout(timer);
      const output: number[] = [];
      for (const byte of bytes) {
        if (optionalXon) {
          optionalXon = false;
          if (byte === 17) continue;
        }
        pending.push(byte);
        while (pending.length) {
          const valid = pending.every((value, index) => {
            if (index < 4) return value === prefix[index];
            if (index < 18) return (value >= 48 && value <= 57) || (value >= 97 && value <= 102);
            if (index === 18) return value === 13;
            return index === 19 && (value === 10 || value === 138);
          });
          if (!valid) {
            const first = pending.shift()!;
            if (displayedPrefix) displayedPrefix--; else output.push(first);
            continue;
          }
          if (pending.length === 20) {
            // Only startup headers (ZRQINIT=00 / ZRINIT=01).
            if (pending[4] === 48 && (pending[5] === 48 || pending[5] === 49)) {
              pending = [];
              displayedPrefix = 0;
              optionalXon = true;
            } else { output.push(...pending.slice(displayedPrefix)); pending = []; displayedPrefix = 0; }
          }
          break;
        }
      }
      if (output.length) write(Uint8Array.from(output));
      if (pending.length && pending.length < 3) timer = setTimeout(flush, 250);
    },
    dispose() { clearTimeout(timer); pending = []; },
  };
}
