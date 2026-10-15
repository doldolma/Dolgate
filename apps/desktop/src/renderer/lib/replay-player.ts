// 세션 리플레이 재생기: 녹화를 구간 단위로 받아 재생 터미널에 그린다.
//
// 녹화 전체를 받지 않는다. 그릴 위치의 구간과 그 앞 몇 구간만 받아 두고, 지나간 구간은 버린다. 예전에는
// 녹화 전체를 한 번에 받아서, 출력이 493MB 인 녹화는 메인 프로세스가 풀다가 문자열 한도를 넘어 빈 화면으로
// 재생됐다(실측).
//
// 터미널은 앞에서부터 차례로 그려야 그 시점의 화면이 나온다. 되감거나 멀리 건너뛸 때는 명령 스캔이 미리 떠 둔
// 화면(스냅샷)에서 시작해 거기서부터 그린다. 그보다 앞이면 처음부터 그린다.

import type { SessionReplaySegment, SessionReplaySegmentInfo } from '@shared';

/** 그릴 위치보다 앞서 받아 둘 구간 수. */
const PREFETCH_SEGMENTS = 3;
/** 그릴 위치 뒤로 남겨 둘 구간 수. 구간 하나짜리 녹화(대부분)는 되감아도 다시 받지 않는다. */
const KEEP_BEHIND_SEGMENTS = 1;
/** 앞으로 이만큼 넘게 건너뛰면, 그 사이를 다 그리는 대신 가까운 스냅샷부터 그린다. */
const SNAPSHOT_SEEK_MIN_BYTES = 4 * 1024 * 1024;
/**
 * 재생 터미널이 그리지 못하고 쌓아 둘 수 있는 출력. 넘으면 더 넘기지 않는다(재생 창은 그동안 재생 시계를
 * 세운다) — 출력이 많은 녹화를 빨리 틀면 그리는 속도보다 빨리 써서, 그리지 못한 출력이 끝없이 쌓였다.
 */
export const REPLAY_PENDING_LIMIT_BYTES = 1024 * 1024;
/** 스냅샷 사이의 최소 출력량. 이보다 작은 녹화는 스냅샷 없이 늘 처음부터 그린다. */
const SNAPSHOT_SPACING_BYTES = 8 * 1024 * 1024;
/** 스냅샷이 차지할 수 있는 양(글자 수). 넘으면 하나 걸러 버리고 간격을 두 배로 벌린다. */
const SNAPSHOT_BUDGET_CHARS = 48 * 1024 * 1024;

const EMPTY_SEGMENT: SessionReplaySegment = {
  atMs: new Float64Array(0),
  dataEnd: new Uint32Array(0),
  cols: new Uint16Array(0),
  rows: new Uint16Array(0),
  data: new Uint8Array(0),
};

/** 구간 경계에서 떠 둔 화면. */
export interface ReplaySnapshot {
  /** 이 구간의 첫 항목부터 이어 그린다 — 앞 구간은 모두 반영된 화면이다. */
  segment: number;
  /** 반영된 마지막 항목의 시각. */
  atMs: number;
  cols: number;
  rows: number;
  /** 이 화면을 다시 그리는 출력(직렬화한 터미널). */
  data: string;
}

/**
 * 같은 내용의 문자열을 한 덩어리로 새로 만든다. 터미널 직렬화 결과는 조각 수십만 개를 이어 붙인 문자열이라
 * 그대로 두면 조각마다 메모리를 따로 잡는다(실측: 스냅샷 62개·1,850만 자가 278MB, 새로 만들면 18.5MB).
 */
function compactString(value: string): string {
  return JSON.parse(JSON.stringify(value)) as string;
}

/**
 * 스냅샷을 모아 둔다. 녹화가 커도 메모리가 늘지 않도록 전체 양을 SNAPSHOT_BUDGET_CHARS 로 묶는다 — 넘으면
 * 하나 걸러 버리고, 다음부터는 두 배 간격으로 뜨게 한다.
 */
export class ReplaySnapshotStore {
  private snapshots: ReplaySnapshot[] = [];
  private totalChars = 0;
  private spacing: number;

  constructor(
    private readonly budgetChars = SNAPSHOT_BUDGET_CHARS,
    spacingBytes = SNAPSHOT_SPACING_BYTES,
  ) {
    this.spacing = spacingBytes;
  }

  /** 앞 스냅샷 뒤로 이만큼 출력이 쌓이면 다음 스냅샷을 뜬다. */
  get spacingBytes(): number {
    return this.spacing;
  }

  get size(): number {
    return this.snapshots.length;
  }

  add(snapshot: ReplaySnapshot): void {
    this.snapshots.push({ ...snapshot, data: compactString(snapshot.data) });
    this.totalChars += snapshot.data.length;
    while (this.totalChars > this.budgetChars && this.snapshots.length > 0) {
      this.snapshots =
        this.snapshots.length === 1
          ? []
          : this.snapshots.filter((_, index) => index % 2 === 1);
      this.totalChars = this.snapshots.reduce(
        (sum, kept) => sum + kept.data.length,
        0,
      );
      this.spacing *= 2;
    }
  }

  /** atMs 까지만 반영된 스냅샷 가운데 가장 늦은 것. */
  latest(atMs: number): ReplaySnapshot | null {
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      if (this.snapshots[index].atMs <= atMs) {
        return this.snapshots[index];
      }
    }
    return null;
  }
}

export interface ReplayTerminal {
  write: (data: Uint8Array | string) => void;
  resize: (cols: number, rows: number) => void;
  /** 녹화를 시작할 때의 빈 화면으로 되돌린다. */
  reset: () => void;
  /** 넘겼지만 아직 그리지 못한 출력. */
  pendingOutputSize: () => number;
  /** 넘긴 출력을 다 그리면 callback 을 부른다(크기 바꿈을 그 뒤로 미룰 때 프레임을 기다리지 않으려고). */
  afterWrites?: (callback: () => void) => void;
}

export interface ReplayPlayerOptions {
  segments: readonly SessionReplaySegmentInfo[];
  readSegment: (segmentIndex: number) => Promise<SessionReplaySegment>;
  snapshots: ReplaySnapshotStore;
  terminal: ReplayTerminal;
  /** 크기 바꿈 항목이나 스냅샷으로 터미널 크기가 바뀌었다. */
  onViewport: (cols: number, rows: number) => void;
  /** 크기 바꿈 앞에서 멈췄다가 앞 출력이 다 그려졌다. advance 를 다시 부르면 이어 간다. */
  onWritesDrained?: () => void;
}

type RestartPoint = ReplaySnapshot | 'start';

export class ReplayPlayer {
  private readonly cache = new Map<number, SessionReplaySegment>();
  private readonly loading = new Map<number, Promise<void>>();
  /** 다음에 그릴 항목. */
  private segment = 0;
  private entry = 0;
  /** 마지막으로 그린 항목의 시각. 이보다 앞으로 가려면 지우고 다시 그려야 한다. */
  private drawnAtMs = Number.NEGATIVE_INFINITY;
  /**
   * 터미널을 지우고 이 지점부터 다시 그려야 한다. 밀린 출력이 다 그려진 뒤에 한다 — 터미널을 지워도 밀린
   * 출력은 버려지지 않아서, 먼저 지우면 지운 화면 위에 옛 출력이 그려진다. 다시 그릴 첫 구간도 받은 뒤에
   * 지운다 — 그래야 빈 화면을 거치지 않고 한 번에 바뀐다.
   */
  private restartPoint: RestartPoint | null = 'start';
  private disposed = false;

  constructor(private readonly options: ReplayPlayerOptions) {
    this.prefetch();
  }

  /** 그릴 위치의 구간을 받으면 풀린다. */
  whenReady(): Promise<void> {
    if (this.segment >= this.options.segments.length || this.cache.has(this.segment)) {
      return Promise.resolve();
    }
    this.request(this.segment);
    return this.loading.get(this.segment) ?? Promise.resolve();
  }

  /** 재생 위치를 옮긴다. 실제로 그리는 것은 advance 다. */
  seek(targetMs: number): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.options.snapshots.latest(targetMs);
    if (targetMs < this.drawnAtMs) {
      this.scheduleRestart(snapshot ?? 'start');
      return;
    }
    // 앞으로 가면 이어 그린다. 다만 그 사이가 크면 가까운 스냅샷부터 그린다.
    if (
      snapshot &&
      snapshot.segment > this.segment &&
      this.outputBytesBetween(this.segment, snapshot.segment) >= SNAPSHOT_SEEK_MIN_BYTES
    ) {
      this.scheduleRestart(snapshot);
    }
  }

  /**
   * targetMs 까지의 항목을 터미널에 넘긴다. 다 넘겼으면 true. 구간을 받는 중이거나 터미널에 밀린 출력이
   * 많으면 거기서 멈추고 false 를 돌려준다 — 재생 창은 다음 프레임에 다시 부른다.
   */
  advance(targetMs: number): boolean {
    if (this.disposed) {
      return true;
    }
    const { segments, terminal } = this.options;
    if (this.restartPoint) {
      if (terminal.pendingOutputSize() > 0) {
        return false;
      }
      const first = segments[this.segment];
      if (first && first.startAtMs <= targetMs && !this.cache.has(this.segment)) {
        this.request(this.segment);
        return false;
      }
      this.restart(this.restartPoint);
      this.restartPoint = null;
    }
    let viewport: { cols: number; rows: number } | null = null;
    let caughtUp = false;
    for (;;) {
      if (terminal.pendingOutputSize() > REPLAY_PENDING_LIMIT_BYTES) {
        break;
      }
      const info = segments[this.segment];
      if (!info || (this.entry === 0 && info.startAtMs > targetMs)) {
        caughtUp = true;
        break;
      }
      const segment = this.cache.get(this.segment);
      if (!segment) {
        this.request(this.segment);
        break;
      }
      // 이어지는 출력 항목은 한 번에 넘긴다. 크기 바꿈 항목에서만 끊는다.
      const count = segment.atMs.length;
      let index = this.entry;
      let runStart = index === 0 ? 0 : segment.dataEnd[index - 1];
      let waitingForWrites = false;
      for (; index < count && segment.atMs[index] <= targetMs; index += 1) {
        if (segment.cols[index] === 0) {
          continue;
        }
        const runEnd = index === 0 ? 0 : segment.dataEnd[index - 1];
        if (runEnd > runStart) {
          terminal.write(segment.data.subarray(runStart, runEnd));
          runStart = runEnd;
        }
        // 크기는 앞 출력이 다 그려진 뒤에 바꾼다. write 는 큐에 넣기만 해서 바로 바꾸면 앞 출력이 바뀐 크기로
        // 그려졌다(실측: 120→60칸 녹화를 건너뛰면 8~31줄이 다름). 다 그려지면 이 항목부터 잇는다.
        if (terminal.pendingOutputSize() > 0) {
          waitingForWrites = true;
          break;
        }
        terminal.resize(segment.cols[index], segment.rows[index]);
        viewport = { cols: segment.cols[index], rows: segment.rows[index] };
        runStart = segment.dataEnd[index];
      }
      if (!waitingForWrites) {
        const runEnd = index === 0 ? 0 : segment.dataEnd[index - 1];
        if (runEnd > runStart) {
          terminal.write(segment.data.subarray(runStart, runEnd));
        }
      }
      if (index > this.entry) {
        this.drawnAtMs = segment.atMs[index - 1];
      }
      this.entry = index;
      if (waitingForWrites) {
        // 프레임을 기다리지 않고, 다 그리는 대로 다시 불리게 한다. 크기 바꿈이 수백 개인 구간(창을 끌어 크기를
        // 바꾼 곳)도 한 번에 건너뛸 수 있게.
        terminal.afterWrites?.(() => {
          if (!this.disposed) {
            this.options.onWritesDrained?.();
          }
        });
        break;
      }
      if (index < count) {
        caughtUp = true;
        break;
      }
      this.segment += 1;
      this.entry = 0;
      this.evict();
    }
    if (viewport) {
      this.options.onViewport(viewport.cols, viewport.rows);
    }
    this.prefetch();
    return caughtUp;
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
  }

  private scheduleRestart(point: RestartPoint): void {
    this.restartPoint = point;
    this.segment = point === 'start' ? 0 : point.segment;
    this.entry = 0;
    this.drawnAtMs = point === 'start' ? Number.NEGATIVE_INFINITY : point.atMs;
    this.evict();
    this.prefetch();
  }

  private restart(point: RestartPoint): void {
    const { terminal } = this.options;
    terminal.reset();
    if (point !== 'start') {
      terminal.resize(point.cols, point.rows);
      terminal.write(point.data);
      this.options.onViewport(point.cols, point.rows);
    }
  }

  private outputBytesBetween(fromSegment: number, toSegment: number): number {
    let bytes = 0;
    for (let index = fromSegment; index < toSegment; index += 1) {
      bytes += this.options.segments[index]?.outputBytes ?? 0;
    }
    return bytes;
  }

  private isWanted(segmentIndex: number): boolean {
    return (
      segmentIndex >= this.segment - KEEP_BEHIND_SEGMENTS &&
      segmentIndex <= this.segment + PREFETCH_SEGMENTS
    );
  }

  private request(segmentIndex: number): void {
    if (
      this.disposed ||
      segmentIndex >= this.options.segments.length ||
      this.cache.has(segmentIndex) ||
      this.loading.has(segmentIndex)
    ) {
      return;
    }
    const pending = this.options
      .readSegment(segmentIndex)
      .catch((error: unknown) => {
        // 구간 하나를 못 읽어도 나머지는 재생한다(그 구간은 빈 것으로 본다).
        console.error('[replay] could not read a recording segment', segmentIndex, error);
        return EMPTY_SEGMENT;
      })
      .then((segment) => {
        this.loading.delete(segmentIndex);
        if (!this.disposed && this.isWanted(segmentIndex)) {
          this.cache.set(segmentIndex, segment);
        }
      });
    this.loading.set(segmentIndex, pending);
  }

  private evict(): void {
    for (const segmentIndex of this.cache.keys()) {
      if (!this.isWanted(segmentIndex)) {
        this.cache.delete(segmentIndex);
      }
    }
  }

  private prefetch(): void {
    for (
      let segmentIndex = this.segment;
      segmentIndex <= this.segment + PREFETCH_SEGMENTS;
      segmentIndex += 1
    ) {
      this.request(segmentIndex);
    }
  }
}
