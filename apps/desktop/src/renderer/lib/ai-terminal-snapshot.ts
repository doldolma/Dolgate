import type {
  AiTerminalOutputRequest,
  AiTerminalOutputResponse,
  AiTerminalSnapshotRef,
} from '@shared';
import { redactAiContext } from './ai-context-redact';
import { captureTerminalTextSnapshot } from './terminal-write-registry';

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 30;
const DEFAULT_LINES = 200;
const MAX_LINES = 500;
const DEFAULT_BEFORE_RECENT_LINES = 100;
const MAX_BEFORE_RECENT_LINES = 100_000;

interface TerminalSnapshot {
  lines: string[];
  createdAt: number;
  recentOutputLines: number;
}

interface ReadRange {
  beforeRecentLines: number;
  lines: number;
  rangeLabel: string;
  text: string;
  reachedStart: boolean;
  returnedLines: number;
}

const snapshotsById = new Map<string, TerminalSnapshot>();
let fallbackSnapshotSeq = 0;

function now(): number {
  return Date.now();
}

function makeSnapshotId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return cryptoLike?.randomUUID?.() ?? `terminal-snapshot-${now()}-${(fallbackSnapshotSeq += 1)}`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function cleanupSnapshots(currentTime = now()): void {
  for (const [snapshotId, snapshot] of snapshotsById) {
    if (currentTime - snapshot.createdAt > SNAPSHOT_TTL_MS) {
      snapshotsById.delete(snapshotId);
    }
  }

  while (snapshotsById.size > MAX_SNAPSHOTS) {
    const oldest = snapshotsById.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    snapshotsById.delete(oldest);
  }
}

export function readTerminalSnapshotLines({
  snapshotLines,
  recentOutputLines = DEFAULT_BEFORE_RECENT_LINES,
  beforeRecentLines,
  lines,
}: {
  snapshotLines: string[];
  recentOutputLines?: number;
  beforeRecentLines?: number;
  lines?: number;
}): ReadRange {
  const before = clampInteger(
    beforeRecentLines,
    recentOutputLines,
    0,
    MAX_BEFORE_RECENT_LINES,
  );
  const lineCount = clampInteger(lines, DEFAULT_LINES, 1, MAX_LINES);
  const endExclusive = Math.max(0, snapshotLines.length - before);
  const start = Math.max(0, endExclusive - lineCount);
  const selected = snapshotLines.slice(start, endExclusive);
  const firstLineAgo = before + 1;
  const lastLineAgo = before + lineCount;

  return {
    beforeRecentLines: before,
    lines: lineCount,
    rangeLabel: `${firstLineAgo}~${lastLineAgo}줄 전`,
    text: redactAiContext(selected.join('\n')).trim(),
    reachedStart: start === 0 && selected.length < lineCount,
    returnedLines: selected.length,
  };
}

export function createAiTerminalSnapshot(
  stableId: string,
  recentOutputLines: number,
): { snapshotRef: AiTerminalSnapshotRef; recentText: string } | null {
  const snapshotLines = captureTerminalTextSnapshot(stableId);
  if (!snapshotLines || snapshotLines.length === 0) {
    return null;
  }

  cleanupSnapshots();

  const snapshotId = makeSnapshotId();
  const normalizedRecentLines = clampInteger(
    recentOutputLines,
    DEFAULT_BEFORE_RECENT_LINES,
    1,
    MAX_LINES,
  );
  snapshotsById.set(snapshotId, {
    lines: snapshotLines.slice(),
    createdAt: now(),
    recentOutputLines: normalizedRecentLines,
  });
  cleanupSnapshots();

  const recentText = snapshotLines.slice(-normalizedRecentLines).join('\n');
  return {
    snapshotRef: { snapshotId, recentOutputLines: normalizedRecentLines },
    recentText,
  };
}

export function readAiTerminalSnapshot(
  request: AiTerminalOutputRequest,
): AiTerminalOutputResponse {
  cleanupSnapshots();
  const snapshot = snapshotsById.get(request.snapshotId);
  if (!snapshot) {
    return {
      clientRequestId: request.clientRequestId,
      error: 'terminal snapshot is no longer available',
    };
  }

  const range = readTerminalSnapshotLines({
    snapshotLines: snapshot.lines,
    recentOutputLines: snapshot.recentOutputLines,
    beforeRecentLines: request.beforeRecentLines,
    lines: request.lines,
  });
  return {
    clientRequestId: request.clientRequestId,
    text: range.text,
    rangeLabel: range.rangeLabel,
    reachedStart: range.reachedStart,
    returnedLines: range.returnedLines,
  };
}

export function releaseAiTerminalSnapshot(snapshotId: string | null | undefined): void {
  if (!snapshotId) {
    return;
  }
  snapshotsById.delete(snapshotId);
}

export function clearAiTerminalSnapshotsForTest(): void {
  snapshotsById.clear();
  fallbackSnapshotSeq = 0;
}
