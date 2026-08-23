import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAiTerminalSnapshotsForTest,
  createAiTerminalSnapshot,
  readAiTerminalSnapshot,
  readTerminalSnapshotLines,
  releaseAiTerminalSnapshot,
} from './ai-terminal-snapshot';
import { registerTerminalHooks, unregisterTerminalHooks, type TerminalHooks } from './terminal-write-registry';

function lines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`);
}

function fakeHooks(snapshotLines: string[]): TerminalHooks {
  return {
    write: vi.fn(),
    refresh: vi.fn(),
    serialize: vi.fn(() => ''),
    getSessionId: vi.fn(() => 'session-1'),
    getCellSize: vi.fn(() => null),
    getSelection: vi.fn(() => ''),
    captureRecentText: vi.fn((maxLines: number) => snapshotLines.slice(-maxLines).join('\n')),
    captureTextSnapshot: vi.fn(() => snapshotLines.slice()),
    sendInput: vi.fn(),
    isBracketedPasteEnabled: vi.fn(() => false),
    scrollToLine: vi.fn(),
  };
}

describe('ai terminal snapshot ranges', () => {
  afterEach(() => {
    clearAiTerminalSnapshotsForTest();
  });

  it('returns the exact 101~300 lines before the question snapshot', () => {
    const range = readTerminalSnapshotLines({
      snapshotLines: lines(350),
      recentOutputLines: 100,
      beforeRecentLines: 100,
      lines: 200,
    });

    expect(range.rangeLabel).toBe('101~300줄 전');
    expect(range.returnedLines).toBe(200);
    expect(range.text.split('\n')[0]).toBe('line-51');
    expect(range.text.split('\n').at(-1)).toBe('line-250');
    expect(range.reachedStart).toBe(false);
  });

  it('keeps reads anchored even if the terminal later receives more output', () => {
    const stableId = 'stable-ai-snapshot';
    const buffer = lines(320);
    const hooks = fakeHooks(buffer);
    registerTerminalHooks(stableId, hooks);
    const snapshot = createAiTerminalSnapshot(stableId, 100);
    buffer.push(...lines(50).map((line) => `new-${line}`));

    const response = readAiTerminalSnapshot({
      requestId: 'request-1',
      clientRequestId: 'client-1',
      snapshotId: snapshot!.snapshotRef.snapshotId,
      beforeRecentLines: 100,
      lines: 200,
    });

    unregisterTerminalHooks(stableId, hooks);
    expect(snapshot?.recentText.split('\n')[0]).toBe('line-221');
    expect(response.rangeLabel).toBe('101~300줄 전');
    expect(response.returnedLines).toBe(200);
    expect(response.text?.split('\n')[0]).toBe('line-21');
    expect(response.text?.split('\n').at(-1)).toBe('line-220');
    expect(response.text).not.toContain('new-line');
  });

  it('marks when the requested range reaches the start of the snapshot', () => {
    const range = readTerminalSnapshotLines({
      snapshotLines: lines(120),
      recentOutputLines: 100,
      beforeRecentLines: 100,
      lines: 200,
    });

    expect(range.text.split('\n')[0]).toBe('line-1');
    expect(range.returnedLines).toBe(20);
    expect(range.reachedStart).toBe(true);
  });

  it('redacts secrets in terminal output read results', () => {
    const range = readTerminalSnapshotLines({
      snapshotLines: ['password=super-secret', 'AKIA1234567890ABCDEF'],
      beforeRecentLines: 0,
      lines: 2,
    });

    expect(range.text).toContain('password=***');
    expect(range.text).toContain('AWS_ACCESS_KEY_***');
    expect(range.text).not.toContain('super-secret');
  });

  it('returns an error after a snapshot is released', () => {
    const stableId = 'stable-release';
    const hooks = fakeHooks(lines(150));
    registerTerminalHooks(stableId, hooks);
    const snapshot = createAiTerminalSnapshot(stableId, 100)!;
    unregisterTerminalHooks(stableId, hooks);

    releaseAiTerminalSnapshot(snapshot.snapshotRef.snapshotId);
    const response = readAiTerminalSnapshot({
      requestId: 'request-1',
      clientRequestId: 'client-1',
      snapshotId: snapshot.snapshotRef.snapshotId,
      beforeRecentLines: 100,
      lines: 200,
    });

    expect(response.error).toContain('no longer available');
  });
});
