import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Zmodem from 'nora-zmodemjs/index.js';
import { createZmodemController } from './zmodem-controller';

// Generate genuine frames with the installed library, without mocking Sentry.
const protocol = Zmodem as any;
it.each(['cancel', 'late', 'remote'])('handles real cancellation (%s)', async (mode) => {
  const unresponsive = mode === 'late';
  let cancel = () => {};
  const output: number[] = [];
  const saveDownload = vi.fn().mockResolvedValue({ savedPath: '/downloads/retry.bin' });
  const upsertJob = vi.fn();
  const controller = createZmodemController({
    sessionId: 'real-protocol', hostLabel: 'SSH',
    writeToTerminal: bytes => output.push(...bytes),
    sendToRemote: () => {}, saveDownload, upsertJob,
    registerAbort: (_, abort) => { cancel = abort; }, clearAbort: () => {},
  });
  const header = (name: string, ...args: unknown[]) =>
    controller.consume(Uint8Array.from(protocol.Header.build(name, ...args).to_hex()));
  const encoder = new protocol.ZDLE();
  encoder.set_escape_ctrl_chars(true);
  const packet = (bytes: number[], end: string) => controller.consume(Uint8Array.from(
    protocol.Subpacket.build(bytes, end).encode16(encoder),
  ));
  header('ZRQINIT');
  header('ZFILE');
  packet(Array.from(new TextEncoder().encode('file.bin\0' + '104857600 0 0 0\0')), 'end_ack');
  header('ZDATA', 0);
  packet([1, 2, 3], 'no_end_no_ack');
  if (unresponsive) vi.useFakeTimers();
  if (mode === 'remote') {
    controller.consume(Uint8Array.of(24, 24, 24, 24, 24));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upsertJob.mock.lastCall?.[0].status).toBe('failed');
    expect(upsertJob.mock.lastCall?.[0].errorMessage).toContain('원격');
    controller.consume(new TextEncoder().encode('$ ready\r\n'));
    expect(new TextDecoder().decode(Uint8Array.from(output))).toBe('$ ready\r\n');
    expect(saveDownload).not.toHaveBeenCalled();
    controller.dispose();
    return;
  }
  cancel();
  if (unresponsive) {
    try {
      // 원격이 취소에 3초 안에 답하지 않으면(sz 가 이미 없을 수 있다) 이쪽에서만 끝낸다. 사용자가 취소했으니
      // '취소'다 — 예전에는 세션을 그대로 둬 탭이 풀리지 않았고 "다시 연결하세요"로 실패했다.
      await vi.advanceTimersByTimeAsync(3_001);
      expect(upsertJob.mock.lastCall?.[0].status).toBe('cancelled');
      expect(output).toEqual([]);
      expect(saveDownload).not.toHaveBeenCalled();
      // 원격 sz 는 없고 셸 출력만 온다. 남은 전송 바이트가 아닌지 잠깐 본 뒤 화면에 보낸다.
      controller.consume(new TextEncoder().encode('$ echo ready\r\nready\r\n'));
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
  } else {
    packet([4, 5, 6], 'end_no_ack');
    header('ZEOF', 6);
    header('ZFIN');
    controller.consume(new TextEncoder().encode('OO'));
    controller.consume(new TextEncoder().encode('$ echo ready\r\nready\r\n'));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(saveDownload).not.toHaveBeenCalled();
  expect(upsertJob.mock.lastCall?.[0].status).toBe('cancelled');
  expect(new TextDecoder().decode(Uint8Array.from(output))).toBe('$ echo ready\r\nready\r\n');
  // A second transfer on the same controller must still work after cancellation.
  header('ZRQINIT');
  header('ZFILE');
  packet(Array.from(new TextEncoder().encode('retry.bin\0' + '4 0 0 0\0')), 'end_ack');
  header('ZDATA', 0);
  packet([0, 24, 255, 13], 'end_no_ack');
  header('ZEOF', 4);
  header('ZFIN');
  controller.consume(new TextEncoder().encode('OO'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(saveDownload).toHaveBeenCalledWith({ name: 'retry.bin', bytes: Uint8Array.of(0, 24, 255, 13) });
  expect(upsertJob.mock.lastCall?.[0].status).toBe('completed');
  controller.dispose();
});

// sz 가 취소 신호 없이 죽으면(SIGKILL) 받기 세션이 다음 프레임을 영영 기다리며 셸 출력을 삼켰다(실측: 3분 넘게).
// 10초 동안 진행이 없으면 이쪽에서만 끝내고 화면을 돌려준다. 진행이 이어지는 느린 전송은 끊지 않는다.
it.each(['stalled', 'slow'])('stops a receive session whose sender went silent (%s)', async (mode) => {
  vi.useFakeTimers();
  try {
    const output: number[] = [];
    const sent: number[][] = [];
    const saveDownload = vi.fn().mockResolvedValue({ savedPath: '/downloads/x.bin' });
    const upsertJob = vi.fn();
    const controller = createZmodemController({
      sessionId: 'stall', hostLabel: 'SSH',
      writeToTerminal: bytes => output.push(...bytes),
      sendToRemote: bytes => sent.push(Array.from(bytes)), saveDownload, upsertJob,
      registerAbort: () => {}, clearAbort: () => {},
    });
    const header = (name: string, ...args: unknown[]) =>
      controller.consume(Uint8Array.from(protocol.Header.build(name, ...args).to_hex()));
    const encoder = new protocol.ZDLE();
    encoder.set_escape_ctrl_chars(true);
    const packet = (bytes: number[], end: string) => controller.consume(Uint8Array.from(
      protocol.Subpacket.build(bytes, end).encode16(encoder),
    ));
    header('ZRQINIT');
    header('ZFILE');
    packet(Array.from(new TextEncoder().encode('x.bin\0' + '9 0 0 0\0')), 'end_ack');
    header('ZDATA', 0);
    packet([1, 2, 3], 'no_end_no_ack');

    if (mode === 'slow') {
      await vi.advanceTimersByTimeAsync(9_000);
      packet([4, 5, 6], 'no_end_no_ack');
      await vi.advanceTimersByTimeAsync(9_000);
      packet([7, 8, 9], 'end_no_ack');
      header('ZEOF', 9);
      header('ZFIN');
      controller.consume(new TextEncoder().encode('OO'));
      await vi.advanceTimersByTimeAsync(0);
      expect(saveDownload).toHaveBeenCalledWith({ name: 'x.bin', bytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9) });
      expect(upsertJob.mock.lastCall?.[0].status).toBe('completed');
      controller.dispose();
      return;
    }

    const sentBeforeStall = sent.length;
    await vi.advanceTimersByTimeAsync(10_500);
    expect(upsertJob.mock.lastCall?.[0].status).toBe('failed');
    expect(upsertJob.mock.lastCall?.[0].errorMessage).toContain('응답하지 않아');
    // 원격 sz 가 살아서 멈춰 있을 수 있으니 취소 신호를 보낸다(SIGINT 를 받은 lrzsz 는 끝나지 않고 기다린다).
    // CAN 은 lrzsz 의 canit() 처럼 10개다 — 데이터를 보내던 sz 는 첫 CAN 을 읽고 나서 5개를 더 센다.
    expect(sent.slice(sentBeforeStall).flat()).toEqual([...Array(10).fill(24), 8, 8, 8, 8, 8]);
    expect(saveDownload).not.toHaveBeenCalled();

    controller.consume(new TextEncoder().encode('$ ls\r\n'));
    await vi.advanceTimersByTimeAsync(300);
    expect(new TextDecoder().decode(Uint8Array.from(output))).toBe('$ ls\r\n');
    controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

// sz 가 전송 중에 죽으면(SIGKILL) 셸 출력을 받기 세션이 삼켰다(실측: 10초 뒤 입력은 되는데 프롬프트가 안 보였다).
// 그 안에 셸 통합의 "명령 끝" 표시가 있으면 sz 는 이미 없다 — 취소 신호를 보내지 않고 표시부터 돌려준다. 한글
// (라이브러리가 0x93 을 지운다)과 잘게 온 메아리도 그대로여야 한다. 프레임을 끝낸 뒤 헤더를 기다리던 세션은 셸 출력을
// 버리며 감지기가 화면에 보내므로, 그때는 두 번 보내지 않고 취소 신호만 보내지 않는다(살아 있는 셸에 ^X·BS 가 들어간다).
it.each(['mid-packet', 'between-frames'])('lets the shell back after a killed sender (%s)', async (mode) => {
  vi.useFakeTimers();
  try {
    const output: number[] = [];
    const sent: number[][] = [];
    const upsertJob = vi.fn();
    const controller = createZmodemController({
      sessionId: 'killed', hostLabel: 'SSH',
      writeToTerminal: bytes => output.push(...bytes),
      sendToRemote: bytes => sent.push(Array.from(bytes)), saveDownload: vi.fn(), upsertJob,
      registerAbort: () => {}, clearAbort: () => {},
    });
    const header = (name: string, ...args: unknown[]) =>
      controller.consume(Uint8Array.from(protocol.Header.build(name, ...args).to_hex()));
    const encoder = new protocol.ZDLE();
    encoder.set_escape_ctrl_chars(true);
    const packet = (bytes: number[], end: string) => controller.consume(Uint8Array.from(
      protocol.Subpacket.build(bytes, end).encode16(encoder),
    ));
    const encode = (text: string) => new TextEncoder().encode(text);
    const screen = () => new TextDecoder().decode(Uint8Array.from(output));
    header('ZRQINIT');
    header('ZFILE');
    packet(Array.from(encode('x.bin\0' + '100 0 0 0\0')), 'end_ack');
    header('ZDATA', 0);
    if (mode === 'mid-packet') {
      packet([1, 2, 3], 'no_end_no_ack');
      controller.consume(Uint8Array.of(4, 5, 6));
    } else {
      packet([1, 2, 3], 'end_no_ack');
    }
    const prompt = '\x1b]133;D;137\x07\x1b]133;A\x07~/다운로드$ ';
    controller.consume(encode('Killed\r\n' + prompt));
    // 프롬프트가 안 보여 엔터를 몇 번 눌렀다.
    for (let count = 0; count < 3; count += 1) {
      controller.consume(encode('\r\n'));
      controller.consume(encode(prompt));
    }
    const sentBeforeStall = sent.length;
    const screenBeforeStall = screen();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(upsertJob.mock.lastCall?.[0].status).toBe('failed');
    expect(sent.slice(sentBeforeStall)).toEqual([]);
    if (mode === 'mid-packet') {
      expect(screenBeforeStall).toBe('');
      expect(screen()).toBe(prompt + ('\r\n' + prompt).repeat(3));
    } else {
      expect(screenBeforeStall.split('133;A').length - 1).toBe(4);
      expect(screen()).toBe(screenBeforeStall);
    }

    controller.consume(encode('ls\r\n'));
    expect(screen().endsWith('$ ls\r\n')).toBe(true);
    controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

// sz 에게 제어 문자를 모두 이스케이프해 달라고 한다(첫 인사 ZRINIT 의 ESCCTL). 세션을 시작할 때와 파일을 하나
// 받은 뒤 다시 보내는 첫 인사 모두에 걸려야 한다.
it('asks sz to escape control characters in every receiver init', () => {
  const sent: Uint8Array[] = [];
  const controller = createZmodemController({
    sessionId: 'escctl', hostLabel: 'SSH',
    writeToTerminal: () => {}, sendToRemote: bytes => sent.push(bytes),
    saveDownload: vi.fn().mockResolvedValue({ savedPath: '/downloads/x.bin' }), upsertJob: vi.fn(),
    registerAbort: () => {}, clearAbort: () => {},
  });
  const header = (name: string, ...args: unknown[]) =>
    controller.consume(Uint8Array.from(protocol.Header.build(name, ...args).to_hex()));
  const encoder = new protocol.ZDLE();
  encoder.set_escape_ctrl_chars(true);
  const packet = (bytes: number[], end: string) => controller.consume(Uint8Array.from(
    protocol.Subpacket.build(bytes, end).encode16(encoder),
  ));
  const receiverInits = () => sent
    .map((bytes) => protocol.Header.parse(Array.from(bytes))?.[0])
    .filter((parsed) => parsed?.NAME === 'ZRINIT')
    .map((parsed) => parsed.escape_ctrl_chars());
  header('ZRQINIT');
  expect(receiverInits()).toEqual([true]);
  header('ZFILE');
  packet(Array.from(new TextEncoder().encode('x.bin\0' + '3 0 0 0\0')), 'end_ack');
  header('ZDATA', 0);
  packet([1, 2, 3], 'end_no_ack');
  header('ZEOF', 3);
  expect(receiverInits()).toEqual([true, true]);
  controller.dispose();
});

// sz 가 그 요청을 따르면 전송이 비정상으로 끝난 뒤 남은 데이터를 셸 출력과 가를 수 있다. 날것의 ESC 는 셸에서만
// 온다. 이스케이프가 없을 때는 아래 경우마다 파일 내용이 화면에 새거나, 셸 통합 표시가 든 파일을 셸 출력으로
// 착각했다(재현).
describe('when sz escapes control characters', () => {
  const TERMINAL_LOG = 'user@host:~$ \x1b]133;D;0\x07\x1b]133;A\x07$ cat notes.txt\r\nsecret notes\r\n';
  const CANCEL_SIGNAL = Uint8Array.from([...Array(10).fill(0x18), ...Array(10).fill(0x08)]);
  const PROMPT = '\x1b]133;D;130\x07$ ';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 받기 세션을 열고 파일 하나를 받기 시작한 상태.
  function startTransfer(name: string) {
    const output: number[] = [];
    const sent: number[] = [];
    const upsertJob = vi.fn();
    let cancel = () => {};
    const controller = createZmodemController({
      sessionId: 'escaped', hostLabel: 'SSH',
      writeToTerminal: bytes => output.push(...bytes), sendToRemote: bytes => sent.push(...bytes),
      saveDownload: vi.fn().mockResolvedValue({ savedPath: '/downloads/x' }), upsertJob,
      registerAbort: (_, abort) => { cancel = abort; }, clearAbort: () => {},
    });
    const encoder = new protocol.ZDLE();
    encoder.set_escape_ctrl_chars(true);
    const packet = (data: string | number[], end = 'no_end_no_ack') => Uint8Array.from(protocol.Subpacket.build(
      typeof data === 'string' ? Array.from(new TextEncoder().encode(data)) : data, end,
    ).encode16(encoder));
    const header = (headerName: string, ...args: unknown[]) =>
      controller.consume(Uint8Array.from(protocol.Header.build(headerName, ...args).to_hex()));
    header('ZRQINIT');
    header('ZFILE');
    controller.consume(packet(name + '\0' + '100000 0 0 0\0', 'end_ack'));
    header('ZDATA', 0);
    controller.consume(packet('first block\r\n'));
    const corrupt = () => {
      const broken = packet('second block\r\n');
      broken[3] ^= 0x5a;
      controller.consume(broken);
    };
    const cans = () => sent.filter((byte) => byte === 0x18).length;
    const screen = () => new TextDecoder().decode(Uint8Array.from(output));
    return { controller, output, upsertJob, packet, corrupt, cans, screen, cancel: () => cancel() };
  }

  it('cancels a terminal log whose sender is slow to answer, without showing it', async () => {
    const transfer = startTransfer('session.log');
    transfer.cancel();
    const inflight = transfer.packet(TERMINAL_LOG);
    transfer.controller.consume(inflight.slice(0, inflight.length - 4));
    const cansBefore = transfer.cans();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(transfer.cans() - cansBefore).toBe(10);
    transfer.controller.consume(inflight.slice(inflight.length - 4));
    transfer.controller.consume(transfer.packet('rest of the log\r\n'.repeat(3)));
    transfer.controller.consume(CANCEL_SIGNAL);
    transfer.controller.consume(new TextEncoder().encode(PROMPT));
    await vi.advanceTimersByTimeAsync(400);
    expect(transfer.upsertJob.mock.lastCall?.[0].status).toBe('cancelled');
    expect(transfer.screen()).toBe(PROMPT);
    transfer.controller.dispose();
  });

  it('cancels a terminal log whose sender stalled, and drops what it sends after', async () => {
    const transfer = startTransfer('session.log');
    const inflight = transfer.packet(TERMINAL_LOG);
    transfer.controller.consume(inflight.slice(0, inflight.length - 4));
    const cansBefore = transfer.cans();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(transfer.upsertJob.mock.lastCall?.[0].status).toBe('failed');
    expect(transfer.cans() - cansBefore).toBe(10);
    transfer.controller.consume(inflight.slice(inflight.length - 4));
    transfer.controller.consume(transfer.packet('more of the log\r\n'));
    await vi.advanceTimersByTimeAsync(400);
    expect(transfer.screen()).toBe('');
    transfer.controller.dispose();
  });

  it('keeps a broken terminal log off the screen until the shell answers', async () => {
    const transfer = startTransfer('session.log');
    transfer.corrupt();
    transfer.controller.consume(transfer.packet(TERMINAL_LOG));
    transfer.controller.consume(transfer.packet('more log lines\r\n'.repeat(4)));
    transfer.controller.consume(CANCEL_SIGNAL);
    transfer.controller.consume(new TextEncoder().encode(PROMPT));
    await vi.advanceTimersByTimeAsync(400);
    expect(transfer.screen()).toBe(PROMPT);
    transfer.controller.dispose();
  });

  it('keeps a broken text file off the screen when the rest trickles in slowly', async () => {
    const transfer = startTransfer('notes.txt');
    transfer.corrupt();
    const leftover = transfer.packet('ordinary text line number one\r\nordinary text line number two\r\n'.repeat(4));
    for (let at = 0; at < leftover.length; at += 120) {
      transfer.controller.consume(leftover.slice(at, at + 120));
      await vi.advanceTimersByTimeAsync(400);
    }
    transfer.controller.consume(CANCEL_SIGNAL);
    transfer.controller.consume(new TextEncoder().encode('$ '));
    await vi.advanceTimersByTimeAsync(400);
    expect(transfer.screen()).toBe('$ ');
    transfer.controller.dispose();
  });

  // 제어 문자가 하나도 없는 긴 줄(한 줄짜리 JSON)은 느린 회선에서 글자로 샐 수 있다 — 막지 않기로 했다. 다만 파일
  // 안의 제어 문자는 모두 이스케이프돼 오므로 새는 것에 ESC·C1·제어 문자가 없고, 화면 상태는 바뀌지 않는다.
  it('lets only plain characters through when a line without control characters trickles in', async () => {
    const transfer = startTransfer('data.json');
    transfer.corrupt();
    const json = new TextEncoder().encode('{"items":[' + Array.from({ length: 40 }, (_, i) => `{"id":${i},"name":"item-${i}"}`).join(',') + ']}');
    const leftover = transfer.packet([...json, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x1b, 0x28, 0x30, 0x9b, 0x07, ...json.slice(0, 200)]);
    for (let at = 0; at < leftover.length; at += 120) {
      transfer.controller.consume(leftover.slice(at, at + 120));
      await vi.advanceTimersByTimeAsync(400);
    }
    transfer.controller.consume(CANCEL_SIGNAL);
    transfer.controller.consume(new TextEncoder().encode('$ '));
    await vi.advanceTimersByTimeAsync(400);
    const controls = transfer.output.filter((byte) =>
      byte === 0x1b || (byte >= 0x80 && byte <= 0x9f) || (byte < 0x20 && ![0x08, 0x0a, 0x0d, 0x18].includes(byte)));
    expect(controls).toEqual([]);
    transfer.controller.dispose();
  });
});
