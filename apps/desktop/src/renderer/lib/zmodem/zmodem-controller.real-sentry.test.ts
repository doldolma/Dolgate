import { describe, expect, it, vi } from 'vitest';
import { createZmodemController } from './zmodem-controller';
import {
  fromBase64,
  LRZSZ_FILE_A,
  LRZSZ_FILE_B,
  LRZSZ_SZ_A_PTY,
  LRZSZ_SZ_B,
} from './lrzsz-capture.test-support';

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

// 실제 lrzsz(0.12.21) 가 보낸 바이트로 돌린다(lrzsz-capture.test-support).
describe('실제 lrzsz 전송', () => {
  function receiver() {
    const output: number[] = [];
    const replies: number[][] = [];
    const saved: Array<{ name: string; bytes: Uint8Array }> = [];
    const upsertJob = vi.fn();
    const controller = createZmodemController({
      sessionId: 's1',
      hostLabel: 'host',
      writeToTerminal: (bytes) => output.push(...bytes),
      sendToRemote: (bytes) => replies.push(Array.from(bytes)),
      saveDownload: vi.fn(async (input: { name: string; bytes: Uint8Array }) => {
        saved.push(input);
        return { savedPath: `/dl/${input.name}` };
      }),
      upsertJob,
      registerAbort: vi.fn(),
      clearAbort: vi.fn(),
    });
    return { controller, output, replies, saved, upsertJob };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const text = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes));

  // PTY 로 돈 lrzsz 는 "OO" 없이 끝나고 곧바로 셸 프롬프트가 온다. 라이브러리가 지운 0x93 까지 되살려야
  // '드'(EB 93 9C)가 깨지지 않는다(실측: `~/다운로$`).
  it('OO 없이 끝난 sz 뒤의 한글 프롬프트를 깨뜨리지 않는다', async () => {
    const receive = receiver();
    for (const chunk of LRZSZ_SZ_A_PTY) {
      receive.controller.consume(fromBase64(chunk));
    }
    receive.controller.consume(new TextEncoder().encode('tester@host:~/다운로드$ '));
    await flush();

    expect(receive.saved).toEqual([{ name: 'a.bin', bytes: fromBase64(LRZSZ_FILE_A) }]);
    expect(receive.upsertJob.mock.lastCall?.[0].status).toBe('completed');
    // sz 가 시작할 때 찍는 "rz\r", 끝날 때 stderr 로 찍는 "\r"(PTY 라 같이 온다), 그 뒤에 프롬프트가 그대로.
    expect(text(receive.output)).toBe('rz\r\rtester@host:~/다운로드$ ');
    receive.controller.dispose();
  });

  // `sz a.bin; sz b.bin`: 첫 sz 가 OO 없이 끝난 바로 뒤에 둘째 sz 의 시작 신호가 온다. 그것을 바로 감지해야
  // 한다 — 화면으로 보내 둘째 sz 가 다시 알릴 때까지 약 10초씩 기다렸다(실측: 둘째 파일 20초).
  it('잇달아 실행한 sz 의 둘째 전송을 바로 시작한다', async () => {
    const receive = receiver();
    for (const chunk of LRZSZ_SZ_A_PTY) {
      receive.controller.consume(fromBase64(chunk));
    }
    const repliesAfterFirst = receive.replies.length;
    const [startOfSecond, ...restOfSecond] = LRZSZ_SZ_B;
    receive.controller.consume(fromBase64(startOfSecond!));
    // 둘째 sz 의 시작 신호에 곧바로 답했다.
    expect(receive.replies.length).toBeGreaterThan(repliesAfterFirst);
    for (const chunk of restOfSecond) {
      receive.controller.consume(fromBase64(chunk));
    }
    await flush();

    expect(receive.saved.map((file) => file.name)).toEqual(['a.bin', 'b.bin']);
    expect(receive.saved[1]!.bytes).toEqual(fromBase64(LRZSZ_FILE_B));
    receive.controller.dispose();
  });
});
