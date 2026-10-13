import { describe, expect, it, vi } from 'vitest';
import { createZmodemController } from './zmodem-controller';

// 실제 라이브러리(nora-zmodemjs)를 컨트롤러에 그대로 물려 본다 — zmodem-controller.test.ts 는 가짜
// Sentry 를 쓴다.
//
// 컨트롤러는 전송이 시작될 수 없는 조각('*'·ZDLE 가 없다)은 감지기를 건너뛴다. 그 빠른 길이 실제 `sz` 의
// 시작을 놓치면 안 된다. 시작 신호가 조각 경계 어디에서 쪼개져도 — 뒷조각에 '*'·ZDLE 가 하나도 없어도 —
// 감지돼야 하고, 신호 자체는 화면에 새지 않아야 한다.
describe('ZMODEM 시작 감지 (실제 라이브러리)', () => {
  it('시작 신호가 어디서 쪼개져도 감지하고, 화면에는 앞의 출력만 남긴다', () => {
    const header = new TextEncoder().encode('**\x18B00000000000000\r\n\x11');
    for (let split = 0; split <= header.length; split += 1) {
      const output: number[] = [];
      const sendToRemote = vi.fn();
      const controller = createZmodemController({
        sessionId: 's1',
        hostLabel: 'host',
        writeToTerminal: (bytes) => output.push(...bytes),
        sendToRemote,
        saveDownload: vi.fn(),
        upsertJob: vi.fn(),
        registerAbort: vi.fn(),
        clearAbort: vi.fn(),
      });

      controller.consume(new TextEncoder().encode('before\r\n'));
      controller.consume(header.slice(0, split));
      controller.consume(header.slice(split));

      // 수신 세션이 시작되면 상대에게 응답(ZRINIT)을 보낸다 — 감지됐다는 뜻이다.
      expect(sendToRemote, `split ${split}`).toHaveBeenCalled();
      expect(new TextDecoder().decode(Uint8Array.from(output)), `split ${split}`).toBe('before\r\n');
      controller.dispose();
    }
  });

  // '*' 가 든 앞 출력은 감지기를 건너뛰고 바로 화면으로 간다. 그래도 뒤이어 오는 시작 신호는 놓치면 안 된다.
  it("'*' 가 든 출력 뒤에 오는 시작 신호도 감지한다", () => {
    const header = new TextEncoder().encode('**\x18B00000000000000\r\n\x11');
    const preamble = 'sz *.log\r\n/* a */ *b\r\n';
    for (let split = 0; split <= header.length; split += 1) {
      const output: number[] = [];
      const sendToRemote = vi.fn();
      const controller = createZmodemController({
        sessionId: 's1',
        hostLabel: 'host',
        writeToTerminal: (bytes) => output.push(...bytes),
        sendToRemote,
        saveDownload: vi.fn(),
        upsertJob: vi.fn(),
        registerAbort: vi.fn(),
        clearAbort: vi.fn(),
      });

      controller.consume(new TextEncoder().encode(preamble));
      controller.consume(header.slice(0, split));
      controller.consume(header.slice(split));

      expect(sendToRemote, `split ${split}`).toHaveBeenCalled();
      expect(new TextDecoder().decode(Uint8Array.from(output)), `split ${split}`).toBe(preamble);
      controller.dispose();
    }
  });
});
