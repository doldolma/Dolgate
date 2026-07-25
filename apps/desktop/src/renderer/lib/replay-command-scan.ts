// 세션 리플레이 녹화를 로드 시 한 번 훑어 "명령 블록" 목록을 만든다.
//
// 라이브와 달리 리플레이는 재생을 해야 OSC 133 이 흐르는데, 오른쪽 명령 목록과 재생바 마커는
// 재생 전에 전체 목록이 있어야 성립한다. 그래서 화면 없는 터미널(xterm-headless)에 녹화
// 스트림을 그대로 먹여 라이브와 동일한 방식으로 경계를 잡고, 각 경계에 녹화 시각(atMs)을
// 붙인다.
//
// 명령 텍스트를 버퍼에서 읽는 이유는 라이브와 같다 — 셸 통합은 명령 텍스트를 보고하지 않아
// (133;E 없음) 원시 바이트만으로는 알 수 없고, 화면에 그려진 결과가 가장 정확하다.
//
// atMs 귀속: xterm 의 write 콜백은 "그 청크를 파싱한 직후, 다음 청크 파싱 전" 에 불린다.
// 그래서 각 청크의 콜백에서 *다음* 청크의 atMs 를 넣어 두면, OSC 핸들러가 불릴 때 항상 그
// 청크의 시각을 보게 된다 — 청크마다 await 할 필요가 없다. (예전엔 OSC 가 든 청크만 await
// 했는데, 마커가 청크 경계로 쪼개지면 시각이 녹화 끝으로 튀는 버그가 있었다.)

import { Terminal } from 'xterm-headless';
import type { IMarker } from 'xterm-headless';
import type { SessionReplayRecording } from '@shared';
import { readCommandTextFromBuffer } from './terminal-command-blocks';

export type ReplayCommandState = 'ok' | 'failed' | 'running';

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

function decodeBase64Chunk(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

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
  recording: SessionReplayRecording,
  options: { isCancelled?: () => boolean } = {},
): Promise<ReplayCommandScanResult> {
  let terminal: Terminal | null = null;
  const blocks: ReplayCommandBlock[] = [];
  let sequence = 0;
  let currentAtMs = 0;
  let shellIntegrationDetected = false;
  // 프롬프트 위치는 raw 행 번호가 아니라 마커로 잡는다 — 스크롤백이 절삭되면 절대 행 번호가
  // 어긋나 명령 텍스트를 못 읽는다(라이브가 registerMarker 를 쓰는 이유와 같다).
  let pendingPrompt: { marker: IMarker; promptEndX: number } | null = null;
  let currentCwd: string | null = null;

  try {
    terminal = new Terminal({
      cols: recording.initialCols > 0 ? recording.initialCols : 80,
      rows: recording.initialRows > 0 ? recording.initialRows : 24,
      allowProposedApi: true,
      // 긴 세션에서도 명령 줄이 버퍼에서 밀려나지 않도록 넉넉히.
      scrollback: 10000,
    });
    const activeTerminal = terminal;

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

      if (kind === 'B') {
        // 실제 명령이 실행될지는 아직 모르므로 위치만 기억하고 C 에서 승격한다.
        pendingPrompt?.marker.dispose();
        const marker = activeTerminal.registerMarker(0);
        pendingPrompt = marker
          ? { marker, promptEndX: buffer.cursorX }
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
            (pendingPrompt && pendingPrompt.marker.line >= 0
              ? readCommandTextFromBuffer(
                  buffer,
                  pendingPrompt.marker.line,
                  pendingPrompt.promptEndX,
                  outputStartLine,
                )
              : null
            )?.text ?? null,
          exitCode: null,
          cwd: currentCwd,
          state: 'running',
        });
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
          block.state = exitCode === null || exitCode === 0 ? 'ok' : 'failed';
          break;
        }
        return true;
      }

      return true;
    });

    const entries = recording.entries;
    currentAtMs = entries[0]?.atMs ?? 0;
    let queuedBytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      if (options.isCancelled?.()) {
        return { blocks: [], shellIntegrationDetected: false };
      }
      const entry = entries[index];
      if (entry.type === 'resize') {
        // resize 는 즉시 적용되므로, 큐에 남은 데이터를 먼저 파싱시켜야 순서가 맞는다.
        await writeAsync(activeTerminal, new Uint8Array());
        queuedBytes = 0;
        currentAtMs = entry.atMs;
        activeTerminal.resize(Math.max(1, entry.cols), Math.max(1, entry.rows));
        continue;
      }
      const bytes = decodeBase64Chunk(entry.dataBase64);
      // 콜백은 이 청크를 파싱한 "직후" 불리므로, 여기서 다음 청크의 시각을 미리 넣어 둔다.
      const nextAtMs = entries[index + 1]?.atMs ?? entry.atMs;
      activeTerminal.write(bytes, () => {
        currentAtMs = nextAtMs;
      });
      queuedBytes += bytes.length;
      if (queuedBytes >= DRAIN_THRESHOLD_BYTES) {
        await writeAsync(activeTerminal, new Uint8Array());
        queuedBytes = 0;
      }
    }

    // 남은 큐를 비워 마지막 마커까지 반영한다.
    // 남은 pendingPrompt 마커는 아래 finally 의 terminal.dispose() 가 함께 정리한다.
    await writeAsync(activeTerminal, new Uint8Array());
  } catch (error) {
    console.error('[replay-scan] 명령 스캔 실패 — 목록 없이 재생만 가능합니다', error);
    return { blocks: [], shellIntegrationDetected: false };
  } finally {
    terminal?.dispose();
  }

  return { blocks, shellIntegrationDetected };
}
