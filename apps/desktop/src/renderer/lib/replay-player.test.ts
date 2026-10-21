import type { SessionReplayEntry, SessionReplaySegment } from '@shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REPLAY_PENDING_LIMIT_BYTES,
  ReplayPlayer,
  ReplaySnapshotRefs,
  ReplaySnapshotStore,
  type ReplaySnapshot,
  type ReplaySnapshotIndex,
  type ReplaySnapshotRef,
} from './replay-player';
import { segmentReplayEntries } from './replay-segments.test-support';

function output(atMs: number, text: string): SessionReplayEntry {
  return { type: 'output', atMs, dataBase64: btoa(text) };
}

function snapshotAt(segment: number, atMs: number, data: string): ReplaySnapshot {
  return { segment, atMs, cols: 90, rows: 20, data };
}

/** 그린 순서를 문자열로 남기는 가짜 재생 터미널. */
function createTerminal() {
  const events: string[] = [];
  let pending = 0;
  const terminal = {
    write: vi.fn((data: Uint8Array | string) => {
      events.push(`write:${typeof data === 'string' ? data : new TextDecoder().decode(data)}`);
    }),
    resize: vi.fn((cols: number, rows: number) => {
      events.push(`resize:${cols}x${rows}`);
    }),
    reset: vi.fn(() => {
      events.push('reset');
    }),
    pendingOutputSize: vi.fn(() => pending),
  };
  return {
    terminal,
    events,
    setPending: (bytes: number) => {
      pending = bytes;
    },
  };
}

/** 구간을 받는 약속들이 풀리게 한다. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}

function createPlayer(
  entries: SessionReplayEntry[],
  options: {
    entriesPerSegment?: number;
    snapshots?: ReplaySnapshotIndex;
    loadSnapshot?: (ref: ReplaySnapshotRef) => Promise<ReplaySnapshot | null>;
    outputBytesPerSegment?: number;
  } = {},
) {
  const { segments, readSegment } = segmentReplayEntries(entries, options.entriesPerSegment);
  const fake = createTerminal();
  const onViewport = vi.fn();
  const player = new ReplayPlayer({
    segments:
      options.outputBytesPerSegment === undefined
        ? segments
        : segments.map((segment) => ({
            ...segment,
            outputBytes: options.outputBytesPerSegment!,
          })),
    readSegment,
    snapshots: options.snapshots ?? new ReplaySnapshotStore(),
    loadSnapshot: options.loadSnapshot,
    terminal: fake.terminal,
    onViewport,
  });
  return { player, readSegment, onViewport, ...fake };
}

describe('ReplayPlayer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws entries up to the target, merging output and splitting it at resizes', async () => {
    const { player, events, onViewport } = createPlayer([
      output(0, 'a'),
      output(5, 'b'),
      { type: 'resize', atMs: 10, cols: 100, rows: 30 },
      output(20, 'c'),
      output(30, 'd'),
    ]);
    await player.whenReady();

    expect(player.advance(25)).toBe(true);
    expect(events).toEqual(['reset', 'write:ab', 'resize:100x30', 'write:c']);
    expect(onViewport).toHaveBeenCalledWith(100, 30);

    expect(player.advance(25)).toBe(true);
    expect(player.advance(30)).toBe(true);
    expect(events).toEqual(['reset', 'write:ab', 'resize:100x30', 'write:c', 'write:d']);
  });

  // 녹화 전체를 받지 않는다 — 출력이 수백 MB 인 녹화도 메모리에 그 근처 몇 구간만 둔다.
  it('fetches only the segments near the playback position', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => output(index * 10, `${index};`));
    const { player, readSegment, events } = createPlayer(entries, { entriesPerSegment: 1 });
    await player.whenReady();
    expect(readSegment.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);

    for (let target = 0; target <= 100; target += 10) {
      player.advance(target);
      await settle();
    }

    expect(events.join('')).toContain('write:10;');
    const requested = readSegment.mock.calls.map(([index]) => index);
    expect(Math.max(...requested)).toBeLessThanOrEqual(14);
    expect(new Set(requested).size).toBe(requested.length);
  });

  it('waits for a segment that is still loading, then continues where it stopped', async () => {
    const { segments, readSegment: readPacked } = segmentReplayEntries(
      [output(0, 'a'), output(10, 'b'), output(20, 'c')],
      1,
    );
    const resolvers = new Map<number, () => void>();
    const readSegment = vi.fn(
      (index: number) =>
        new Promise<SessionReplaySegment>((resolve) => {
          resolvers.set(index, () => {
            void readPacked(index).then(resolve);
          });
        }),
    );
    const fake = createTerminal();
    const player = new ReplayPlayer({
      segments,
      readSegment,
      snapshots: new ReplaySnapshotStore(),
      terminal: fake.terminal,
      onViewport: vi.fn(),
    });

    expect(player.advance(20)).toBe(false);
    expect(fake.events).toEqual([]);

    resolvers.get(0)?.();
    await settle();
    expect(player.advance(20)).toBe(false);
    expect(fake.events).toEqual(['reset', 'write:a']);

    resolvers.get(1)?.();
    resolvers.get(2)?.();
    await settle();
    expect(player.advance(20)).toBe(true);
    expect(fake.events).toEqual(['reset', 'write:a', 'write:b', 'write:c']);
  });

  it('stops handing output to the terminal while it has a backlog to draw', async () => {
    const { player, events, setPending } = createPlayer([output(0, 'a'), output(10, 'b')]);
    await player.whenReady();
    expect(player.advance(0)).toBe(true);

    setPending(REPLAY_PENDING_LIMIT_BYTES + 1);
    expect(player.advance(10)).toBe(false);
    expect(events).toEqual(['reset', 'write:a']);

    setPending(0);
    expect(player.advance(10)).toBe(true);
    expect(events).toEqual(['reset', 'write:a', 'write:b']);
  });

  // 터미널을 지워도 밀린 출력은 버려지지 않는다. 먼저 지우면 지운 화면 위에 옛 출력이 그려진다.
  it('clears the screen for a rewind only after the backlog has been drawn', async () => {
    const { player, events, setPending } = createPlayer([
      output(0, 'a'),
      output(10, 'b'),
      output(20, 'c'),
    ]);
    await player.whenReady();
    expect(player.advance(20)).toBe(true);
    events.length = 0;

    setPending(10);
    player.seek(5);
    expect(player.advance(5)).toBe(false);
    expect(events).toEqual([]);

    setPending(0);
    await settle();
    expect(player.advance(5)).toBe(true);
    expect(events).toEqual(['reset', 'write:a']);
  });

  it('continues without clearing when moving back to a point it has not drawn past', async () => {
    const { player, events } = createPlayer([output(0, 'a'), output(10, 'b'), output(20, 'c')]);
    await player.whenReady();
    expect(player.advance(15)).toBe(true);
    events.length = 0;

    // 15 까지 왔지만 마지막으로 그린 항목은 10 이다. 12 로 가도 다시 그릴 것이 없다.
    player.seek(12);
    expect(player.advance(12)).toBe(true);
    expect(player.advance(20)).toBe(true);
    expect(events).toEqual(['write:c']);
  });

  it('rewinds from the latest snapshot before the target instead of the start', async () => {
    const snapshots = new ReplaySnapshotStore();
    const { player, events, onViewport } = createPlayer(
      [output(0, 'a'), output(10, 'b'), output(20, 'c'), output(30, 'd')],
      { entriesPerSegment: 1, snapshots },
    );
    await player.whenReady();
    for (let target = 0; target <= 30; target += 10) {
      player.advance(target);
      await settle();
    }
    expect(player.advance(30)).toBe(true);
    snapshots.add(snapshotAt(2, 10, 'SNAP'));
    events.length = 0;

    player.seek(25);
    player.advance(25);
    await settle();
    expect(player.advance(25)).toBe(true);

    expect(events).toEqual(['reset', 'resize:90x20', 'write:SNAP', 'write:c']);
    expect(onViewport).toHaveBeenLastCalledWith(90, 20);
  });

  it('rewinds to the start when no snapshot is early enough', async () => {
    const snapshots = new ReplaySnapshotStore();
    const { player, events } = createPlayer([output(0, 'a'), output(10, 'b'), output(20, 'c')], {
      entriesPerSegment: 1,
      snapshots,
    });
    await player.whenReady();
    for (let target = 0; target <= 20; target += 10) {
      player.advance(target);
      await settle();
    }
    expect(player.advance(20)).toBe(true);
    snapshots.add(snapshotAt(2, 10, 'SNAP'));
    events.length = 0;

    // 지나간 구간은 버렸다. 다시 받을 때까지 지우지 않는다 — 빈 화면을 거치지 않는다.
    player.seek(5);
    expect(player.advance(5)).toBe(false);
    expect(events).toEqual([]);
    await settle();
    expect(player.advance(5)).toBe(true);
    expect(events).toEqual(['reset', 'write:a']);
  });

  it('keeps the segment it just finished so a small recording rewinds at once', async () => {
    const { player, events, readSegment } = createPlayer([output(0, 'a'), output(10, 'b')]);
    await player.whenReady();
    expect(player.advance(10)).toBe(true);
    events.length = 0;

    player.seek(0);
    expect(player.advance(0)).toBe(true);
    expect(events).toEqual(['reset', 'write:a']);
    expect(readSegment).toHaveBeenCalledTimes(1);
  });

  it('jumps forward to a snapshot only when the gap is large', async () => {
    const entries = Array.from({ length: 6 }, (_, index) => output(index * 10, `${index};`));

    // 구간마다 출력 3MB 로 친다. 스냅샷까지 3MB 면 이어 그리고, 6MB 면 스냅샷에서 시작한다.
    const near = new ReplaySnapshotStore();
    const nearPlayer = createPlayer(entries, {
      entriesPerSegment: 1,
      snapshots: near,
      outputBytesPerSegment: 3 * 1024 * 1024,
    });
    await nearPlayer.player.whenReady();
    nearPlayer.player.advance(0);
    near.add(snapshotAt(2, 10, 'NEAR'));
    nearPlayer.player.seek(15);
    nearPlayer.player.advance(15);
    await settle();
    nearPlayer.player.advance(15);
    expect(nearPlayer.events).toEqual(['reset', 'write:0;', 'write:1;']);

    const far = new ReplaySnapshotStore();
    const farPlayer = createPlayer(entries, {
      entriesPerSegment: 1,
      snapshots: far,
      outputBytesPerSegment: 3 * 1024 * 1024,
    });
    await farPlayer.player.whenReady();
    farPlayer.player.advance(0);
    far.add(snapshotAt(3, 20, 'FAR'));
    farPlayer.player.seek(35);
    farPlayer.player.advance(35);
    await settle();
    expect(farPlayer.player.advance(35)).toBe(true);
    expect(farPlayer.events).toEqual([
      'reset',
      'write:0;',
      'reset',
      'resize:90x20',
      'write:FAR',
      'write:3;',
    ]);
  });

  // 팀 녹화는 스냅샷의 자리만 알고 화면은 그때 받는다 — 그 앞 구간은 받지 않는다.
  it('jumps far to a snapshot it only knows the place of, fetching its screen first', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => output(index * 10, `${index};`));
    const loadSnapshot = vi.fn(async (ref: ReplaySnapshotRef) => snapshotAt(ref.segment, ref.atMs, 'FAR'));
    const { player, events, readSegment } = createPlayer(entries, {
      entriesPerSegment: 1,
      snapshots: new ReplaySnapshotRefs([{ segment: 9, atMs: 80 }]),
      loadSnapshot,
      outputBytesPerSegment: 3 * 1024 * 1024,
    });
    await player.whenReady();
    player.advance(0);
    events.length = 0;

    player.seek(95);
    expect(player.advance(95)).toBe(false);
    await settle();
    expect(player.advance(95)).toBe(true);
    expect(events).toEqual(['reset', 'resize:90x20', 'write:FAR', 'write:9;']);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledWith({ segment: 9, atMs: 80 });
    // 처음 재생하며 앞서 받아 둔 0~4 다음으로는 스냅샷 뒤 구간만 받았다 — 그 사이(5~8)는 받지 않는다.
    expect(readSegment.mock.calls.map(([index]) => index).sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3, 4, 9, 10, 11,
    ]);
  });

  it('draws from the start when a snapshot screen cannot be had, and does not try it again', async () => {
    const entries = Array.from({ length: 6 }, (_, index) => output(index * 10, `${index};`));
    const loadSnapshot = vi.fn(async () => null);
    const { player, events } = createPlayer(entries, {
      entriesPerSegment: 1,
      snapshots: new ReplaySnapshotRefs([{ segment: 4, atMs: 30 }]),
      loadSnapshot,
      outputBytesPerSegment: 3 * 1024 * 1024,
    });
    await player.whenReady();
    player.advance(0);
    events.length = 0;

    player.seek(45);
    for (let round = 0; round < 10 && !player.advance(45); round += 1) {
      await settle();
    }
    expect(events).toEqual(['reset', 'write:0;', 'write:1;', 'write:2;', 'write:3;', 'write:4;']);
    player.seek(5);
    for (let round = 0; round < 10 && !player.advance(5); round += 1) {
      await settle();
    }
    player.seek(45);
    for (let round = 0; round < 10 && !player.advance(45); round += 1) {
      await settle();
    }
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it('waits for a snapshot screen even when the segments after it are already here', async () => {
    const entries = Array.from({ length: 6 }, (_, index) => output(index * 10, `${index};`));
    let resolveScreen!: (snapshot: ReplaySnapshot | null) => void;
    const loadSnapshot = vi.fn(
      () =>
        new Promise<ReplaySnapshot | null>((resolve) => {
          resolveScreen = resolve;
        }),
    );
    const { player, events } = createPlayer(entries, {
      entriesPerSegment: 1,
      snapshots: new ReplaySnapshotRefs([{ segment: 3, atMs: 20 }]),
      loadSnapshot,
      outputBytesPerSegment: 3 * 1024 * 1024,
    });
    await player.whenReady();
    player.advance(0);
    await settle();
    events.length = 0;

    player.seek(35);
    // 구간 3·4 는 이미 받아 두었지만 스냅샷 화면은 오는 중이다 — 지우지도 그리지도 않는다.
    expect(player.advance(35)).toBe(false);
    expect(events).toEqual([]);
    resolveScreen(snapshotAt(3, 20, 'FAR'));
    await settle();
    expect(player.advance(35)).toBe(true);
    expect(events).toEqual(['reset', 'resize:90x20', 'write:FAR', 'write:3;']);
  });

  it('does not ask again for a snapshot it could not get, even after using another one', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => output(index * 10, `${index};`));
    const loadSnapshot = vi.fn(async (ref: ReplaySnapshotRef) =>
      ref.segment === 4 ? null : snapshotAt(ref.segment, ref.atMs, 'SNAP9'),
    );
    const { player } = createPlayer(entries, {
      entriesPerSegment: 1,
      snapshots: new ReplaySnapshotRefs([
        { segment: 4, atMs: 30 },
        { segment: 9, atMs: 80 },
      ]),
      loadSnapshot,
      outputBytesPerSegment: 3 * 1024 * 1024,
    });
    const reach = async (target: number) => {
      player.seek(target);
      for (let round = 0; round < 20 && !player.advance(target); round += 1) {
        await settle();
      }
    };
    await player.whenReady();
    player.advance(0);
    await reach(45);
    await reach(95);
    // 되감기 — 받지 못한 4 번 스냅샷은 다시 묻지 않고 처음부터 그린다.
    await reach(45);
    expect(loadSnapshot.mock.calls.map(([ref]) => ref.segment)).toEqual([4, 9]);
  });

  it('treats a segment it cannot read as empty and keeps playing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { segments, readSegment: readPacked } = segmentReplayEntries(
      [output(0, 'a'), output(10, 'b'), output(20, 'c')],
      1,
    );
    const fake = createTerminal();
    const player = new ReplayPlayer({
      segments,
      readSegment: (index) =>
        index === 1 ? Promise.reject(new Error('broken')) : readPacked(index),
      snapshots: new ReplaySnapshotStore(),
      terminal: fake.terminal,
      onViewport: vi.fn(),
    });
    await player.whenReady();
    await settle();

    expect(player.advance(20)).toBe(true);
    expect(fake.events).toEqual(['reset', 'write:a', 'write:c']);
    expect(consoleError).toHaveBeenCalled();
  });

  // 크기는 앞 출력이 다 그려진 뒤에 바꾼다. write 는 큐에 넣기만 해서 바로 바꾸면 앞 출력이 바뀐 크기로
  // 그려졌다(실측: 120→60칸 녹화를 건너뛰면 8~31줄이 다름). 다 그려지면 프레임을 기다리지 않고 잇는다.
  it('applies a resize only after the output before it has been drawn', async () => {
    const { segments, readSegment } = segmentReplayEntries([
      output(0, 'a'),
      { type: 'resize', atMs: 10, cols: 100, rows: 30 },
      output(20, 'b'),
    ]);
    const fake = createTerminal();
    let drained: (() => void) | null = null;
    const onWritesDrained = vi.fn();
    const onViewport = vi.fn();
    const player = new ReplayPlayer({
      segments,
      readSegment,
      snapshots: new ReplaySnapshotStore(),
      terminal: {
        ...fake.terminal,
        write: (data) => {
          fake.terminal.write(data);
          fake.setPending(1);
        },
        afterWrites: (callback) => {
          drained = callback;
        },
      },
      onViewport,
      onWritesDrained,
    });
    await player.whenReady();

    expect(player.advance(25)).toBe(false);
    expect(fake.events).toEqual(['reset', 'write:a']);
    expect(onViewport).not.toHaveBeenCalled();

    fake.setPending(0);
    drained!();
    expect(onWritesDrained).toHaveBeenCalledTimes(1);
    expect(player.advance(25)).toBe(true);
    expect(fake.events).toEqual(['reset', 'write:a', 'resize:100x30', 'write:b']);
    expect(onViewport).toHaveBeenCalledWith(100, 30);
  });

  it('ignores segments that arrive after it was disposed', async () => {
    const { player, events } = createPlayer([output(0, 'a')]);
    player.dispose();
    await settle();
    expect(player.advance(10)).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('ReplaySnapshotStore', () => {
  it('keeps snapshots within the budget by dropping every other one and spacing the rest', () => {
    const store = new ReplaySnapshotStore(10, 1);
    store.add(snapshotAt(1, 10, 'aaa'));
    store.add(snapshotAt(2, 20, 'bbb'));
    store.add(snapshotAt(3, 30, 'ccc'));
    expect(store.size).toBe(3);
    expect(store.spacingBytes).toBe(1);

    store.add(snapshotAt(4, 40, 'ddd'));
    expect(store.size).toBe(2);
    expect(store.spacingBytes).toBe(2);
    expect(store.latest(35)?.segment).toBe(2);
    expect(store.latest(45)?.segment).toBe(4);
    expect(store.latest(15)).toBeNull();
  });

  it('drops a snapshot that alone exceeds the budget', () => {
    const store = new ReplaySnapshotStore(2, 1);
    store.add(snapshotAt(1, 10, 'toolong'));
    expect(store.size).toBe(0);
    expect(store.latest(100)).toBeNull();
  });
});
