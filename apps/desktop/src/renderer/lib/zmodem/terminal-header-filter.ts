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
    consume(input: Uint8Array) {
      clearTimeout(timer);
      let bytes = input;
      // 붙잡은 바이트가 없으면 첫 '*' 앞까지는 헤더일 수 없다 — 바이트마다 보지 않고 통째로 내보낸다.
      // 아래 루프는 바이트마다 배열에 넣고 검사하고 빼서, 출력이 쏟아지면 메인 스레드의 22% 를 먹었다(실측).
      if (pending.length === 0 && !optionalXon) {
        const star = bytes.indexOf(42);
        if (star === -1) {
          if (bytes.length) write(bytes);
          return;
        }
        if (star > 0) {
          write(bytes.subarray(0, star));
          bytes = bytes.subarray(star);
        }
      }
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
    /** 붙잡고 있는 바이트가 없다 — 이 필터를 건너뛰고 바로 써도 출력 순서가 바뀌지 않는다. */
    isIdle: () => pending.length === 0 && !optionalXon,
    dispose() { clearTimeout(timer); pending = []; },
  };
}
