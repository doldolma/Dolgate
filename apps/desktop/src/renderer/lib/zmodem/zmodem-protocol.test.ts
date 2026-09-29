import { expect, it, vi } from 'vitest';
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
      await vi.advanceTimersByTimeAsync(10_001);
      expect(upsertJob.mock.lastCall?.[0].status).toBe('failed');
      expect(upsertJob.mock.lastCall?.[0].errorMessage).toContain('다시 연결');
      expect(output).toEqual([]);
      expect(saveDownload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }
  packet([4, 5, 6], 'end_no_ack');
  header('ZEOF', 6);
  header('ZFIN');
  controller.consume(new TextEncoder().encode('OO'));
  controller.consume(new TextEncoder().encode('$ echo ready\r\nready\r\n'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(saveDownload).not.toHaveBeenCalled();
  expect(upsertJob.mock.lastCall?.[0].status).toBe(unresponsive ? 'failed' : 'cancelled');
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
