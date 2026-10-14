// 세션 리플레이 녹화를 로드 시 한 번 훑어 "명령 블록" 목록을 만든다.
//
// 라이브와 달리 리플레이는 재생을 해야 OSC 133 이 흐르는데, 오른쪽 명령 목록과 재생바 마커는
// 재생 전에 전체 목록이 있어야 성립한다. 그래서 화면 없는 터미널(xterm-headless)에 녹화
// 스트림을 그대로 먹여 라이브와 동일한 방식으로 경계를 잡고, 각 경계에 녹화 시각(atMs)을
// 붙인다. 녹화는 구간 하나씩 받아 훑고 버린다 — 녹화 전체를 메모리에 올리지 않는다.
//
// 훑는 김에 출력이 쌓일 때마다 구간 경계에서 화면을 떠 둔다(스냅샷). 재생 창이 되감거나 멀리
// 건너뛸 때 처음부터 다시 그리지 않고 가까운 스냅샷부터 그린다(replay-player).
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
import type { ReplaySnapshotStore } from './replay-player';
import {
  readCommandTextFromBuffer,
  unescapeReportedCommand,
} from './terminal-command-blocks';

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
  snapshots?: ReplaySnapshotStore;
  /** 스냅샷에 담을 스크롤백 줄 수. 재생 터미널 설정을 따른다. */
  snapshotScrollback?: () => number;
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
 * 녹화 전체를 훑어 명령 블록을 뽑는다. 실패해도 리플레이 자체는 계속 볼 수 있어야 하므로
 * 예외를 밖으로 던지지 않고 빈 결과를 돌려준다.
 */
export async function scanReplayCommands(
  source: ReplayScanSource,
  options: ReplayScanOptions = {},
): Promise<ReplayCommandScanResult> {
  let terminal: Terminal | null = null;
  const blocks: ReplayCommandBlock[] = [];
  let sequence = 0;
  let currentAtMs = 0;
  let shellIntegrationDetected = false;
  // 프롬프트 위치는 raw 행 번호가 아니라 마커로 잡는다 — 스크롤백이 절삭되면 절대 행 번호가
  // 어긋나 명령 텍스트를 못 읽는다(라이브가 registerMarker 를 쓰는 이유와 같다).
  let pendingPrompt: {
    marker: IMarker;
    promptEndX: number;
    // 이어지는 줄(PS2)의 텍스트 시작 열 — 라이브와 같은 규칙.
    continuationEndX: Map<number, number>;
  } | null = null;
  let currentCwd: string | null = null;
  // 셸이 알려 준 명령 원문. C 보다 먼저 오고, 한 번 쓰면 버린다(라이브와 같은 규칙).
  let reportedCommand: string | null = null;

  try {
    terminal = new Terminal({
      cols: source.initialCols > 0 ? source.initialCols : 80,
      rows: source.initialRows > 0 ? source.initialRows : 24,
      allowProposedApi: true,
      scrollback: SCAN_SCROLLBACK_LINES,
    });
    const activeTerminal = terminal;
    // 글자 폭은 재생 터미널(terminal-runtime)과 같게 센다 — 다르면 넓은 글자가 있는 줄에서 스냅샷이 어긋난다.
    // 애드온 타입은 화면 있는 xterm 기준이라 headless 에 맞춰 넘긴다(쓰는 API 는 같다).
    activeTerminal.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    activeTerminal.unicode.activeVersion = '11';
    const serializer = options.snapshots ? new SerializeAddon() : null;
    if (serializer) {
      activeTerminal.loadAddon(serializer as unknown as ITerminalAddon);
    }

    activeTerminal.parser.registerOscHandler(7, (data) => {
      currentCwd = parseCwdFromOsc7(data);
      return true;
    });

    activeTerminal.parser.registerOscHandler(133, (data) => {
      shellIntegrationDetected = true;
      const buffer = activeTerminal.buffer.active;
      const kind = data.charAt(0);
      // 대체화면(vim 등)에서는 행 좌표가 의미를 잃는다 — 라이브와 같게 기록하지 않는다.
      if (buffer.type !== 'normal') {
        return true;
      }

      if (kind === 'E') {
        reportedCommand = unescapeReportedCommand(data.slice(2));
        return true;
      }

      if (data.startsWith('B;2')) {
        // 이어지는 줄(PS2)의 프롬프트 폭. 첫 프롬프트가 없으면 기준이 없어 버린다.
        pendingPrompt?.continuationEndX.set(
          buffer.baseY + buffer.cursorY,
          buffer.cursorX,
        );
        return true;
      }

      if (kind === 'B') {
        // 실제 명령이 실행될지는 아직 모르므로 위치만 기억하고 C 에서 승격한다.
        // 새 프롬프트가 떴으면 직전 명령의 E 는 쓸 데가 없다.
        reportedCommand = null;
        pendingPrompt?.marker.dispose();
        const marker = activeTerminal.registerMarker(0);
        pendingPrompt = marker
          ? { marker, promptEndX: buffer.cursorX, continuationEndX: new Map() }
          : null;
        return true;
      }

      if (kind === 'C') {
        const outputStartLine = buffer.baseY + buffer.cursorY;
        sequence += 1;
        blocks.push({
          id: sequence,
          atMs: currentAtMs,
          endAtMs: null,
          durationMs: null,
          command:
            reportedCommand ??
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
          cwd: currentCwd,
          state: 'running',
        });
        reportedCommand = null;
        pendingPrompt?.marker.dispose();
        pendingPrompt = null;
        return true;
      }

      if (kind === 'D') {
        // bash/zsh 는 D 다음 A 를 같은 훅에서 내보내므로 시간차를 가정하지 않고
        // 뒤에서 running 블록을 찾아 닫는다.
        const exitCode = parseExitCode(data);
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
          const block = blocks[index];
          if (block.state !== 'running') {
            continue;
          }
          block.endAtMs = currentAtMs;
          block.durationMs = Math.max(0, currentAtMs - block.atMs);
          block.exitCode = exitCode;
          block.state = classifyCommandExit(exitCode);
          break;
        }
        return true;
      }

      return true;
    });

    const { segments } = source;
    const snapshots = options.snapshots;
    currentAtMs = segments[0]?.startAtMs ?? 0;
    let queuedBytes = 0;
    let bytesSinceSnapshot = 0;
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (options.isCancelled?.()) {
        return { blocks: [], shellIntegrationDetected: false };
      }
      const segment = await source.readSegment(segmentIndex);
      const count = segment.atMs.length;
      for (let index = 0; index < count; index += 1) {
        if (options.isCancelled?.()) {
          return { blocks: [], shellIntegrationDetected: false };
        }
        if (segment.cols[index] > 0) {
          // resize 는 즉시 적용되므로, 큐에 남은 데이터를 먼저 파싱시켜야 순서가 맞는다.
          await writeAsync(activeTerminal, new Uint8Array());
          queuedBytes = 0;
          currentAtMs = segment.atMs[index];
          activeTerminal.resize(segment.cols[index], segment.rows[index]);
          continue;
        }
        const bytes = segment.data.subarray(
          index === 0 ? 0 : segment.dataEnd[index - 1],
          segment.dataEnd[index],
        );
        // 콜백은 이 청크를 파싱한 "직후" 불리므로, 여기서 다음 청크의 시각을 미리 넣어 둔다.
        const nextAtMs =
          index + 1 < count
            ? segment.atMs[index + 1]
            : segments[segmentIndex + 1]?.startAtMs ?? segment.atMs[index];
        activeTerminal.write(bytes, () => {
          currentAtMs = nextAtMs;
        });
        queuedBytes += bytes.length;
        bytesSinceSnapshot += bytes.length;
        if (queuedBytes >= DRAIN_THRESHOLD_BYTES) {
          await writeAsync(activeTerminal, new Uint8Array());
          queuedBytes = 0;
        }
      }

      if (
        snapshots &&
        serializer &&
        count > 0 &&
        segmentIndex + 1 < segments.length &&
        bytesSinceSnapshot >= snapshots.spacingBytes
      ) {
        // 이 구간까지 다 반영된 화면을 뜬다. 재생기는 다음 구간의 첫 항목부터 이어 그린다.
        await writeAsync(activeTerminal, new Uint8Array());
        queuedBytes = 0;
        bytesSinceSnapshot = 0;
        snapshots.add({
          segment: segmentIndex + 1,
          atMs: segment.atMs[count - 1],
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          data: serializer.serialize({
            scrollback: Math.max(
              0,
              options.snapshotScrollback?.() ?? DEFAULT_SNAPSHOT_SCROLLBACK_LINES,
            ),
          }),
        });
      }
    }

    // 남은 큐를 비워 마지막 마커까지 반영한다.
    // 남은 pendingPrompt 마커는 아래 finally 의 terminal.dispose() 가 함께 정리한다.
    await writeAsync(activeTerminal, new Uint8Array());
  } catch (error) {
    console.error('[replay-scan] command scan failed — playback works without the list', error);
    return { blocks: [], shellIntegrationDetected: false };
  } finally {
    terminal?.dispose();
  }

  return { blocks, shellIntegrationDetected };
}
