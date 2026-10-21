// 세션 리플레이 녹화를 훑어 "명령 블록" 목록을 만든다.
//
// 라이브와 달리 리플레이는 재생을 해야 OSC 133 이 흐르는데, 오른쪽 명령 목록과 재생바 마커는
// 재생 전에 전체 목록이 있어야 성립한다. 그래서 화면 없는 터미널(xterm-headless)에 녹화
// 스트림을 그대로 먹여 라이브와 동일한 방식으로 경계를 잡고, 각 경계에 녹화 시각(atMs)을
// 붙인다. 녹화는 구간 하나씩 받아 훑고 버린다 — 녹화 전체를 메모리에 올리지 않는다.
//
// 훑는 김에 출력이 쌓일 때마다 구간 경계에서 화면을 떠 둔다(스냅샷). 재생 창이 되감거나 멀리
// 건너뛸 때 처음부터 다시 그리지 않고 가까운 스냅샷부터 그린다(replay-player).
//
// 두 곳에서 쓴다. 재생 창은 열 때 녹화를 처음부터 끝까지 훑고(scanReplayCommands), 메인은 팀 호스트
// 세션 동안 구간이 끝날 때마다 이어 먹여(ReplayCommandScanner) 그 구간의 명령과 스냅샷을 팀 녹화에 덧붙인다 —
// 보는 쪽이 녹화를 다 받지 않고도 명령 목록을 보이고 멀리 건너뛰게.
//
// 명령 텍스트는 라이브와 같은 순서로 정한다 — 셸이 알려 준 원문(133;E, zsh)이 있으면 그것을,
// 없으면(bash 등) 화면에 그려진 결과를 읽는다.
//
// atMs 귀속: xterm 의 write 콜백은 "그 청크를 파싱한 직후, 다음 청크 파싱 전" 에 불린다.
// 그래서 각 청크의 콜백에서 *다음* 청크의 atMs 를 넣어 두면, OSC 핸들러가 불릴 때 항상 그
// 청크의 시각을 보게 된다 — 청크마다 await 할 필요가 없다. (예전엔 OSC 가 든 청크만 await
// 했는데, 마커가 청크 경계로 쪼개지면 시각이 녹화 끝으로 튀는 버그가 있었다.)

import { Terminal } from '@xterm/headless';
import type { IMarker, ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { SessionReplaySegment, SessionReplaySegmentInfo } from '@shared';
import { classifyCommandExit } from '@shared';
import {
  buildCharsetDesignators,
  isAtRestBoundary,
  serializeHiddenState,
} from './replay-terminal-state';
import { readCommandTextFromBuffer, unescapeReportedCommand } from './command-text';

export type ReplayCommandState = 'ok' | 'interrupted' | 'failed' | 'running';

export interface ReplayCommandBlock {
  /** 녹화 내 증가 시퀀스. */
  id: number;
  /** 명령 실행 시작(OSC 133;C) 시각 — 녹화 시작 기준 ms. */
  atMs: number;
  /** 명령 종료(OSC 133;D) 시각. 녹화가 명령 도중 끝났으면 null. */
  endAtMs: number | null;
  durationMs: number | null;
  command: string | null;
  exitCode: number | null;
  cwd: string | null;
  /** 녹화가 명령 도중 끝나 D 를 못 받은 마지막 명령만 running 으로 남는다. */
  state: ReplayCommandState;
}

/** 명령이 하나도 없을 때와 스캔이 불가능했을 때를 구분한다(UI 안내 문구가 달라진다). */
export interface ReplayCommandScanResult {
  blocks: ReplayCommandBlock[];
  /** 셸 통합 마커를 하나도 못 찾았으면 false — "이 녹화엔 셸 통합이 없었다"는 뜻. */
  shellIntegrationDetected: boolean;
}

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

/** 스냅샷을 받는 곳. 앞 스냅샷 뒤로 출력이 spacingBytes 쌓이면 다음 스냅샷을 뜬다. */
export interface ReplaySnapshotSink {
  readonly spacingBytes: number;
  add(snapshot: ReplaySnapshot): void;
}

/** 스캔할 녹화. 구간을 하나씩 받아 훑는다. */
export interface ReplayScanSource {
  initialCols: number;
  initialRows: number;
  segments: readonly SessionReplaySegmentInfo[];
  readSegment: (segmentIndex: number) => Promise<SessionReplaySegment>;
}

export interface ReplayScanOptions {
  isCancelled?: () => boolean;
  /** 주면 앞 스냅샷 뒤로 출력이 snapshots.spacingBytes 쌓일 때마다 구간 경계에서 화면을 떠 넣는다. */
  snapshots?: ReplaySnapshotSink;
  /** 스냅샷에 담을 스크롤백 줄 수. 재생 터미널 설정을 따른다. */
  snapshotScrollback?: () => number;
}

export interface ReplayCommandScannerOptions {
  initialCols: number;
  initialRows: number;
  /** 스냅샷 간격을 정하는 곳. 없으면 스냅샷을 뜨지 않는다. 뜬 스냅샷은 feed 가 돌려준다. */
  snapshots?: Pick<ReplaySnapshotSink, 'spacingBytes'> | null;
  snapshotScrollback?: () => number;
}

/** 구간 하나를 먹인 결과. */
export interface ReplayScanStep {
  /** 이 구간에서 새로 생기거나 끝난 명령(지금 모양). 같은 id 의 나중 것이 앞의 것을 대신한다. */
  changed: ReplayCommandBlock[];
  /** 이 구간까지 반영한 화면. 다음 구간(snapshot.segment)의 첫 항목부터 이어 그린다. */
  snapshot: ReplaySnapshot | null;
}

/** 다음 구간에 대해 아는 것. 이어 먹이는 쪽(녹화 중)은 아직 모른다. */
export interface ReplayScanNext {
  /** 다음 구간의 시작 시각. 모르면 null — 그러면 이 구간을 다 반영할 때까지 기다린다. */
  startAtMs: number | null;
  /** 다음 구간이 있는가(있을 때만 스냅샷을 뜬다). */
  exists: boolean;
}

function parseExitCode(data: string): number | null {
  const parts = data.split(';');
  if (parts.length < 2) {
    return 0;
  }
  const parsed = Number(parts[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCwdFromOsc7(data: string): string | null {
  try {
    const url = new URL(data);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : null;
  } catch {
    return null;
  }
}

/** 큐에 쌓인 바이트가 이만큼을 넘으면 한 번 비운다(전부 큐에 올리면 수십 MB 를 물고 있게 된다). */
const DRAIN_THRESHOLD_BYTES = 512 * 1024;
/** 스캔 터미널의 스크롤백. 긴 세션에서도 명령 줄이 버퍼에서 밀려나지 않도록 넉넉히. */
const SCAN_SCROLLBACK_LINES = 10000;
/** 재생 터미널 설정을 모를 때 스냅샷에 담을 스크롤백 줄 수. */
const DEFAULT_SNAPSHOT_SCROLLBACK_LINES = 1000;

function writeAsync(terminal: Terminal, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, () => resolve());
  });
}

/**
 * 녹화를 구간 단위로 이어 훑는다. 재생 창은 녹화를 한 번에 훑고(scanReplayCommands), 메인은 녹화하는 동안 구간이
 * 끝날 때마다 먹인다. 같은 입력이면 명령 id·시각·스냅샷이 같다 — 이어 훑은 결과를 한 번에 훑은 것과 바꿔 쓸 수 있다.
 */
export class ReplayCommandScanner {
  private terminal: Terminal | null = null;
  private serializer: SerializeAddon | null = null;
  private charsetDesignators: Awaited<ReturnType<typeof buildCharsetDesignators>> | null = null;
  private readonly blocks: ReplayCommandBlock[] = [];
  private readonly changedIds = new Set<number>();
  private sequence = 0;
  private currentAtMs = 0;
  private shellIntegrationDetected = false;
  // 프롬프트 위치는 raw 행 번호가 아니라 마커로 잡는다 — 스크롤백이 절삭되면 절대 행 번호가
  // 어긋나 명령 텍스트를 못 읽는다(라이브가 registerMarker 를 쓰는 이유와 같다).
  private pendingPrompt: {
    marker: IMarker;
    promptEndX: number;
    // 이어지는 줄(PS2)의 텍스트 시작 열 — 라이브와 같은 규칙.
    continuationEndX: Map<number, number>;
  } | null = null;
  private currentCwd: string | null = null;
  // 셸이 알려 준 명령 원문. C 보다 먼저 오고, 한 번 쓰면 버린다(라이브와 같은 규칙).
  private reportedCommand: string | null = null;
  private queuedBytes = 0;
  private bytesSinceSnapshot = 0;
  /** 앞 구간을 다 반영해 시각을 이 구간의 시작으로 맞춰야 한다(다음 구간의 시작을 모른 채 먹였다). */
  private resyncAtSegmentStart = false;

  constructor(private readonly options: ReplayCommandScannerOptions) {}

  /** 스캔 터미널을 만든다. firstStartAtMs 는 첫 구간의 시작 시각이다(모르면 null — 첫 구간의 첫 항목으로 맞춘다). */
  async open(firstStartAtMs: number | null): Promise<void> {
    const terminal = new Terminal({
      cols: this.options.initialCols > 0 ? this.options.initialCols : 80,
      rows: this.options.initialRows > 0 ? this.options.initialRows : 24,
      allowProposedApi: true,
      scrollback: SCAN_SCROLLBACK_LINES,
    });
    this.terminal = terminal;
    // 글자 폭은 재생 터미널(terminal-runtime)과 같게 센다 — 다르면 넓은 글자가 있는 줄에서 스냅샷이 어긋난다.
    // 애드온 타입은 화면 있는 xterm 기준이라 headless 에 맞춰 넘긴다(쓰는 API 는 같다).
    terminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    terminal.unicode.activeVersion = '11';
    this.serializer = this.options.snapshots ? new SerializeAddon() : null;
    if (this.serializer) {
      terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
    }

    terminal.parser.registerOscHandler(7, (data) => {
      this.currentCwd = parseCwdFromOsc7(data);
      return true;
    });

    terminal.parser.registerOscHandler(133, (data) => this.handleOsc133(terminal, data));

    // 스냅샷에 문자셋을 되살릴 때 쓰는 표. 못 만들면 스냅샷을 뜨지 않는다(처음부터 그려 맞는다).
    this.charsetDesignators =
      this.options.snapshots && this.serializer ? await buildCharsetDesignators() : null;
    this.currentAtMs = firstStartAtMs ?? 0;
    this.resyncAtSegmentStart = firstStartAtMs === null;
  }

  private handleOsc133(terminal: Terminal, data: string): boolean {
    this.shellIntegrationDetected = true;
    const buffer = terminal.buffer.active;
    const kind = data.charAt(0);
    // 대체화면(vim 등)에서는 행 좌표가 의미를 잃는다 — 라이브와 같게 기록하지 않는다.
    if (buffer.type !== 'normal') {
      return true;
    }

    if (kind === 'E') {
      this.reportedCommand = unescapeReportedCommand(data.slice(2));
      return true;
    }

    if (data.startsWith('B;2')) {
      // 이어지는 줄(PS2)의 프롬프트 폭. 첫 프롬프트가 없으면 기준이 없어 버린다.
      this.pendingPrompt?.continuationEndX.set(buffer.baseY + buffer.cursorY, buffer.cursorX);
      return true;
    }

    if (kind === 'B') {
      // 실제 명령이 실행될지는 아직 모르므로 위치만 기억하고 C 에서 승격한다.
      // 새 프롬프트가 떴으면 직전 명령의 E 는 쓸 데가 없다.
      this.reportedCommand = null;
      this.pendingPrompt?.marker.dispose();
      const marker = terminal.registerMarker(0);
      this.pendingPrompt = marker
        ? { marker, promptEndX: buffer.cursorX, continuationEndX: new Map() }
        : null;
      return true;
    }

    if (kind === 'C') {
      const outputStartLine = buffer.baseY + buffer.cursorY;
      const pendingPrompt = this.pendingPrompt;
      this.sequence += 1;
      this.blocks.push({
        id: this.sequence,
        atMs: this.currentAtMs,
        endAtMs: null,
        durationMs: null,
        command:
          this.reportedCommand ??
          ((pendingPrompt && pendingPrompt.marker.line >= 0
            ? readCommandTextFromBuffer(
                buffer,
                pendingPrompt.marker.line,
                pendingPrompt.promptEndX,
                outputStartLine,
                pendingPrompt.continuationEndX,
              )
            : null
          )?.text ??
            null),
        exitCode: null,
        cwd: this.currentCwd,
        state: 'running',
      });
      this.changedIds.add(this.sequence);
      this.reportedCommand = null;
      pendingPrompt?.marker.dispose();
      this.pendingPrompt = null;
      return true;
    }

    if (kind === 'D') {
      // bash/zsh 는 D 다음 A 를 같은 훅에서 내보내므로 시간차를 가정하지 않고
      // 뒤에서 running 블록을 찾아 닫는다.
      const exitCode = parseExitCode(data);
      for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
        const block = this.blocks[index];
        if (block.state !== 'running') {
          continue;
        }
        block.endAtMs = this.currentAtMs;
        block.durationMs = Math.max(0, this.currentAtMs - block.atMs);
        block.exitCode = exitCode;
        block.state = classifyCommandExit(exitCode);
        this.changedIds.add(block.id);
        break;
      }
      return true;
    }

    return true;
  }

  /**
   * 구간 하나를 먹인다. 취소되면 null 이다. 다음 구간의 시작을 모르면(녹화 중) 이 구간을 다 반영한 뒤에
   * 돌아온다 — 그래야 돌려주는 명령이 이 구간까지의 것이다.
   */
  async feed(
    segment: SessionReplaySegment,
    segmentIndex: number,
    next: ReplayScanNext,
    isCancelled?: () => boolean,
  ): Promise<ReplayScanStep | null> {
    const terminal = this.terminal;
    if (!terminal) {
      throw new Error('replay scanner is not open');
    }
    const count = segment.atMs.length;
    if (this.resyncAtSegmentStart && count > 0) {
      this.currentAtMs = segment.atMs[0];
    }
    for (let index = 0; index < count; index += 1) {
      if (isCancelled?.()) {
        return null;
      }
      if (segment.cols[index] > 0) {
        // resize 는 즉시 적용되므로, 큐에 남은 데이터를 먼저 파싱시켜야 순서가 맞는다.
        await writeAsync(terminal, new Uint8Array());
        this.queuedBytes = 0;
        this.currentAtMs = segment.atMs[index];
        terminal.resize(segment.cols[index], segment.rows[index]);
        continue;
      }
      const bytes = segment.data.subarray(
        index === 0 ? 0 : segment.dataEnd[index - 1],
        segment.dataEnd[index],
      );
      // 콜백은 이 청크를 파싱한 "직후" 불리므로, 여기서 다음 청크의 시각을 미리 넣어 둔다.
      const nextAtMs =
        index + 1 < count ? segment.atMs[index + 1] : next.startAtMs ?? segment.atMs[index];
      terminal.write(bytes, () => {
        this.currentAtMs = nextAtMs;
      });
      this.queuedBytes += bytes.length;
      this.bytesSinceSnapshot += bytes.length;
      if (this.queuedBytes >= DRAIN_THRESHOLD_BYTES) {
        await writeAsync(terminal, new Uint8Array());
        this.queuedBytes = 0;
      }
    }

    let snapshot: ReplaySnapshot | null = null;
    const snapshots = this.options.snapshots;
    if (
      snapshots &&
      this.serializer &&
      this.charsetDesignators &&
      count > 0 &&
      next.exists &&
      this.bytesSinceSnapshot >= snapshots.spacingBytes
    ) {
      // 이 구간까지 다 반영된 화면을 뜬다. 재생기는 다음 구간의 첫 항목부터 이어 그린다.
      await writeAsync(terminal, new Uint8Array());
      this.queuedBytes = 0;
      // 이스케이프·글자 중간이나 줄 끝 줄바꿈 대기에서는 뜨지 않고 다음 구간 끝에서 다시 본다.
      // SerializeAddon 이 잃는 상태(스크롤 영역·문자셋·저장 커서 등)는 덧붙인다.
      const hiddenState = isAtRestBoundary(terminal)
        ? serializeHiddenState(terminal, this.charsetDesignators)
        : null;
      if (hiddenState !== null) {
        this.bytesSinceSnapshot = 0;
        snapshot = {
          segment: segmentIndex + 1,
          atMs: segment.atMs[count - 1],
          cols: terminal.cols,
          rows: terminal.rows,
          data:
            this.serializer.serialize({
              scrollback: Math.max(
                0,
                this.options.snapshotScrollback?.() ?? DEFAULT_SNAPSHOT_SCROLLBACK_LINES,
              ),
            }) + hiddenState,
        };
      }
    }

    // 다음 구간의 시작을 모르면 이 구간을 다 반영해 둔다 — 마지막 청크의 콜백이 시각을 이 구간의 끝으로
    // 둔 채 다음 구간을 맞게 되므로, 다음 feed 가 시각을 그 구간의 시작으로 다시 맞춘다.
    this.resyncAtSegmentStart = next.startAtMs === null;
    if (this.resyncAtSegmentStart) {
      await writeAsync(terminal, new Uint8Array());
      this.queuedBytes = 0;
    }
    return { changed: this.takeChanged(), snapshot };
  }

  /** 남은 큐를 비워 마지막 마커까지 반영한다. */
  async drain(): Promise<ReplayScanStep> {
    if (this.terminal) {
      await writeAsync(this.terminal, new Uint8Array());
      this.queuedBytes = 0;
    }
    return { changed: this.takeChanged(), snapshot: null };
  }

  get result(): ReplayCommandScanResult {
    return { blocks: this.blocks, shellIntegrationDetected: this.shellIntegrationDetected };
  }

  get detectedShellIntegration(): boolean {
    return this.shellIntegrationDetected;
  }

  dispose(): void {
    // 남은 pendingPrompt 마커는 terminal.dispose() 가 함께 정리한다.
    this.terminal?.dispose();
    this.terminal = null;
  }

  private takeChanged(): ReplayCommandBlock[] {
    if (this.changedIds.size === 0) {
      return [];
    }
    const changed = this.blocks.filter((block) => this.changedIds.has(block.id)).map((block) => ({ ...block }));
    this.changedIds.clear();
    return changed;
  }
}

/**
 * 녹화 전체를 훑어 명령 블록을 뽑는다. 실패해도 리플레이 자체는 계속 볼 수 있어야 하므로
 * 예외를 밖으로 던지지 않고 빈 결과를 돌려준다.
 */
export async function scanReplayCommands(
  source: ReplayScanSource,
  options: ReplayScanOptions = {},
): Promise<ReplayCommandScanResult> {
  const scanner = new ReplayCommandScanner({
    initialCols: source.initialCols,
    initialRows: source.initialRows,
    snapshots: options.snapshots ?? null,
    snapshotScrollback: options.snapshotScrollback,
  });
  try {
    const { segments } = source;
    await scanner.open(segments[0]?.startAtMs ?? 0);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (options.isCancelled?.()) {
        return { blocks: [], shellIntegrationDetected: false };
      }
      let segment: SessionReplaySegment;
      try {
        segment = await source.readSegment(segmentIndex);
      } catch (error) {
        // 구간 하나를 못 읽어도 나머지는 훑는다. 재생기도 그 구간을 빈 것으로 보고 그리므로 그 뒤 스냅샷도
        // 같은 화면이다. 예전에는 스캔 전체가 실패해 명령 목록이 통째로 사라졌다(실측).
        console.warn('[replay-scan] could not read a recording segment', segmentIndex, error);
        continue;
      }
      const step = await scanner.feed(
        segment,
        segmentIndex,
        {
          startAtMs: segments[segmentIndex + 1]?.startAtMs ?? null,
          exists: segmentIndex + 1 < segments.length,
        },
        options.isCancelled,
      );
      if (!step) {
        return { blocks: [], shellIntegrationDetected: false };
      }
      if (step.snapshot) {
        options.snapshots?.add(step.snapshot);
      }
    }
    await scanner.drain();
    return scanner.result;
  } catch (error) {
    console.error('[replay-scan] command scan failed — playback works without the list', error);
    return { blocks: [], shellIntegrationDetected: false };
  } finally {
    scanner.dispose();
  }
}
