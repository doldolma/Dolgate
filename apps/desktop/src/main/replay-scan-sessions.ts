import type { SessionReplaySegment } from "@shared";
import { ReplayCommandScanner, type ReplayScanStep } from "../common/replay/replay-command-scan";

/** 팀 녹화 훑기의 스냅샷 간격(출력 양). 재생 창의 기본 간격과 같다. */
export const TEAM_REPLAY_SNAPSHOT_SPACING_BYTES = 8 * 1024 * 1024;
/** 스냅샷에 담는 스크롤백 줄 수. 보는 쪽의 재생 터미널 설정은 모르므로 기본값을 쓴다. */
const SNAPSHOT_SCROLLBACK_LINES = 1000;

export interface ReplayScanInput {
  initialCols: number;
  initialRows: number;
  /** 첫 구간의 시작 시각. 모르면 null — 첫 구간을 먹일 때 그 첫 항목의 시각으로 맞춘다. */
  firstStartAtMs: number | null;
}

export interface ReplayScanFeedResult {
  step: ReplayScanStep;
  /** 지금까지 셸 통합 마커를 본 적이 있는가. */
  shellIntegration: boolean;
}

interface ScanEntry {
  scanner: ReplayCommandScanner;
  tail: Promise<unknown>;
}

/**
 * 녹화마다 훑기 하나. 구간을 차례로 먹이면 그 구간의 명령과 스냅샷을 돌려준다. 메인의 작업 스레드(또는 그것을
 * 못 띄웠을 때 메인 스레드)가 쓴다.
 */
export class ReplayScanSessions {
  private readonly entries = new Map<string, ScanEntry>();

  open(key: string, input: ReplayScanInput): void {
    this.close(key);
    const scanner = new ReplayCommandScanner({
      initialCols: input.initialCols,
      initialRows: input.initialRows,
      snapshots: { spacingBytes: TEAM_REPLAY_SNAPSHOT_SPACING_BYTES },
      snapshotScrollback: () => SNAPSHOT_SCROLLBACK_LINES,
    });
    this.entries.set(key, { scanner, tail: scanner.open(input.firstStartAtMs) });
  }

  /** 구간 하나를 먹인다. 같은 녹화의 먹이기는 차례대로 돈다. */
  feed(key: string, index: number, segment: SessionReplaySegment): Promise<ReplayScanFeedResult> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.reject(new Error(`replay scan ${key} is not open`));
    }
    const run = entry.tail.then(async () => {
      // 녹화 중에는 다음 구간의 시작을 모른다 — 이 구간을 다 반영한 뒤 돌아온다. 다음 구간이 있다고 보고
      // 스냅샷을 뜬다(녹화가 여기서 끝나면 그 스냅샷은 쓰이지 않는다).
      const step = await entry.scanner.feed(segment, index, { startAtMs: null, exists: true });
      if (!step) {
        throw new Error("replay scan was cancelled");
      }
      return { step, shellIntegration: entry.scanner.detectedShellIntegration };
    });
    entry.tail = run.catch(() => undefined);
    return run;
  }

  close(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    void entry.tail.finally(() => entry.scanner.dispose());
  }

  closeAll(): void {
    for (const key of [...this.entries.keys()]) {
      this.close(key);
    }
  }
}
