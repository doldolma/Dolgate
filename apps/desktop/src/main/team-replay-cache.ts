import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/*
 * 팀 녹화 캐시. 받은 구간·덧붙임을 받은 그대로(잠긴 채) 둔다 — 다시 열거나 되감을 때 또 받지 않는다.
 *
 * - 자리: 팀 기록 폴더 아래 replay-cache/<팀>/<녹화>/<이름>. 이름은 segment-<n>·commands-<n>·snapshot-<n>.
 * - 한도를 넘으면 오래 안 쓴 것(파일 시각)부터 지운다. 읽을 때마다 시각을 새로 한다.
 * - 팀을 잃으면 그 팀 폴더를, 계정을 지우면 전부 지운다.
 */

const CACHE_DIRECTORY = "replay-cache";
const DEFAULT_LIMIT_BYTES = 1024 * 1024 * 1024;
/** 한도를 넘으면 이만큼까지 줄인다 — 한 번 넘을 때마다 폴더를 훑지 않게. */
const EVICT_TO_RATIO = 0.9;
/** 팀·녹화 ID 는 경로가 된다 — 이 꼴만 받는다. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type TeamReplayCacheName = `segment-${number}` | `commands-${number}` | `snapshot-${number}`;

interface CachedFile {
  filePath: string;
  size: number;
  usedAtMs: number;
}

function isSafeName(value: string): boolean {
  return SAFE_NAME.test(value) && !value.includes("..");
}

export class TeamReplayCache {
  private root: string | null = null;
  /** 지금 쓰는 양. 처음 쓸 때 폴더를 훑어 잰다. */
  private usageBytes: number | null = null;

  constructor(private readonly limitBytes = DEFAULT_LIMIT_BYTES) {}

  /** 팀 기록 폴더(team-history)를 연다. */
  activate(stateDirectoryPath: string): void {
    this.root = path.join(stateDirectoryPath, CACHE_DIRECTORY);
    this.usageBytes = null;
  }

  deactivate(): void {
    this.root = null;
    this.usageBytes = null;
  }

  read(teamId: string, recordingId: string, name: TeamReplayCacheName): Uint8Array | null {
    const filePath = this.filePath(teamId, recordingId, name);
    if (!filePath) {
      return null;
    }
    try {
      const data = readFileSync(filePath);
      const now = new Date();
      utimesSync(filePath, now, now);
      return data;
    } catch {
      return null;
    }
  }

  write(teamId: string, recordingId: string, name: TeamReplayCacheName, data: Uint8Array): void {
    const filePath = this.filePath(teamId, recordingId, name);
    if (!filePath) {
      return;
    }
    try {
      const previous = this.sizeOf(filePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, data);
      renameSync(temporaryPath, filePath);
      const usage = this.currentUsage() - previous + data.length;
      this.usageBytes = usage;
      if (usage > this.limitBytes) {
        this.evict();
      }
    } catch (error) {
      // 캐시는 없어도 된다 — 다음에 다시 받는다.
      console.warn("[team-replay] could not cache a recording piece", error);
    }
  }

  /** 풀리지 않는 조각(디스크에서 바뀜) — 지우고 다시 받는다. */
  remove(teamId: string, recordingId: string, name: TeamReplayCacheName): void {
    const filePath = this.filePath(teamId, recordingId, name);
    if (!filePath) {
      return;
    }
    const size = this.sizeOf(filePath);
    rmSync(filePath, { force: true });
    if (this.usageBytes !== null) {
      this.usageBytes = Math.max(0, this.usageBytes - size);
    }
  }

  /** 서버에서 지워진 녹화. */
  forgetRecording(teamId: string, recordingId: string): void {
    const directory = this.recordingDirectory(teamId, recordingId);
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      this.usageBytes = null;
    }
  }

  forgetTeam(teamId: string): void {
    if (!this.root || !isSafeName(teamId)) {
      return;
    }
    rmSync(path.join(this.root, teamId), { recursive: true, force: true });
    this.usageBytes = null;
  }

  purgeAll(): void {
    if (this.root) {
      rmSync(this.root, { recursive: true, force: true });
      this.usageBytes = 0;
    }
  }

  private recordingDirectory(teamId: string, recordingId: string): string | null {
    if (!this.root || !isSafeName(teamId) || !isSafeName(recordingId)) {
      return null;
    }
    return path.join(this.root, teamId, recordingId);
  }

  private filePath(teamId: string, recordingId: string, name: TeamReplayCacheName): string | null {
    const directory = this.recordingDirectory(teamId, recordingId);
    return directory ? path.join(directory, name) : null;
  }

  private sizeOf(filePath: string): number {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private currentUsage(): number {
    if (this.usageBytes === null) {
      this.usageBytes = this.listFiles().reduce((sum, file) => sum + file.size, 0);
    }
    return this.usageBytes;
  }

  private listFiles(): CachedFile[] {
    const files: CachedFile[] = [];
    if (!this.root) {
      return files;
    }
    const readDirectory = (directory: string): string[] => {
      try {
        return readdirSync(directory);
      } catch {
        return [];
      }
    };
    for (const team of readDirectory(this.root)) {
      for (const recording of readDirectory(path.join(this.root, team))) {
        const directory = path.join(this.root, team, recording);
        for (const name of readDirectory(directory)) {
          const filePath = path.join(directory, name);
          try {
            const stat = statSync(filePath);
            if (stat.isFile()) {
              files.push({ filePath, size: stat.size, usedAtMs: stat.mtimeMs });
            }
          } catch {
            // 그새 지워졌다.
          }
        }
      }
    }
    return files;
  }

  /** 오래 안 쓴 것부터 지워 한도의 90% 아래로 줄인다. 빈 녹화 폴더도 지운다. */
  private evict(): void {
    const files = this.listFiles().sort((left, right) => left.usedAtMs - right.usedAtMs);
    let usage = files.reduce((sum, file) => sum + file.size, 0);
    const target = this.limitBytes * EVICT_TO_RATIO;
    const touched = new Set<string>();
    for (const file of files) {
      if (usage <= target) {
        break;
      }
      rmSync(file.filePath, { force: true });
      usage -= file.size;
      touched.add(path.dirname(file.filePath));
    }
    for (const directory of touched) {
      try {
        if (readdirSync(directory).length === 0) {
          rmSync(directory, { recursive: true, force: true });
        }
      } catch {
        // 이미 없다.
      }
    }
    this.usageBytes = usage;
  }
}
