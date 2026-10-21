// 녹화 파일 형식.
//
// 녹화는 항목(SessionReplayEntry)을 JSON 한 줄씩 gzip 파일(.events.jsonl.gz)에 이어 쓴다. 압축 전 양이
// REPLAY_SEGMENT_BYTES 를 넘을 때마다 gzip 멤버를 새로 시작하고, 끝난 멤버마다 파일 위치와 담은 항목을 색인
// 파일(.index.jsonl)에 한 줄씩 적는다. 멤버를 이어 붙인 파일도 그대로 gzip 이라 통째로 풀 수 있고, 색인이
// 있으면 원하는 구간만 따로 푼다.
//
// 예전에는 재생할 때 녹화 전체를 문자열 하나로 풀었다. 출력이 493MB 인 녹화는 문자열 한도(512MB)를 넘어
// 빈 화면으로 재생됐고, 그 사이 메인 프로세스 메모리가 2GB 를 넘었다(실측).
//
// 색인이 없는 녹화(이 형식 전에 쓴 것, 평문 .events.jsonl)는 처음 열 때 한 번 이 형식으로 바꿔 쓴다.

import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type ReadStream,
  type WriteStream,
} from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  constants as zlibConstants,
  createGunzip,
  createGzip,
  gunzip,
  type Gzip,
} from "node:zlib";
import type {
  SessionReplayEntry,
  SessionReplaySegment,
  SessionReplaySegmentInfo,
} from "@shared";

/**
 * gzip 수준. 실제 녹화 226MB 를 수준 1로 압축하면 84.3MB·초당 160MB, 수준 6이면 80.0MB·초당 112MB 였다
 * (실측). 크기 차이는 5% 남짓이고 CPU 는 30% 덜 쓴다. 녹화로 들어오는 양은 흐름 제어로 초당 35MB 안팎이다.
 */
const EVENTS_GZIP_LEVEL = zlibConstants.Z_BEST_SPEED;
/** 구간 하나에 담는 JSON 줄의 양(압축 전). 재생 창이 한 번에 받아 가는 단위다. */
export const REPLAY_SEGMENT_BYTES = 1024 * 1024;
/** 압축기에 한 번에 넘기는 양. 항목마다 넘기면 짧은 항목이 쏟아질 때 압축기 왕복이 항목 수만큼 생긴다. */
const WRITE_BATCH_BYTES = 64 * 1024;
/**
 * 색인 뒤에 남은 부분(비정상 종료로 색인에 오르지 못한 마지막 멤버)을 구간 하나로 읽어 줄 수 있는
 * 크기(압축된 크기). 이보다 크면 녹화 전체를 다시 써서 색인을 만든다.
 */
const TAIL_SEGMENT_MAX_BYTES = 1024 * 1024;
/** 바꿔 쓰는 중인 파일에 붙는 꼬리. 다 쓰면 이름을 바꿔 원래 파일을 대신한다. */
export const REPLAY_TEMP_SUFFIX = ".tmp";
const MAX_TERMINAL_DIMENSION = 0xffff;
const gunzipAsync = promisify(gunzip);

/** 색인 파일의 한 줄: 구간이 파일의 어디에 있고 무엇을 담았는지. */
export interface ReplaySegmentRecord extends SessionReplaySegmentInfo {
  /** 구간(gzip 멤버)이 시작하는 파일 위치. */
  offset: number;
  /** 압축된 길이. */
  length: number;
  /**
   * 색인에 오르지 못한 끝부분(비정상 종료로 마무리 없이 끊겼을 수 있다). 이것만 마지막으로 비운 지점까지
   * 읽는다. 색인에 오른 구간은 다 쓰인 멤버라 끝까지 검사해서 읽는다 — 깨진 멤버를 끊긴 것으로 보고 읽으면
   * 가짜 출력이 나온다.
   */
  cutOff?: boolean;
  /**
   * 압축하지 않은 옛 녹화(.events.jsonl)의 범위다. 옛 녹화를 바꿔 쓰지 못했을 때(쓰기 권한·디스크 공간)
   * 그 파일을 그대로 읽는다. offset·length 는 그 파일의 줄 경계다.
   */
  plain?: boolean;
}

export interface ReplayEventFiles {
  /** .events.jsonl.gz */
  events: string;
  /** 이 형식 전, 압축하지 않고 쓰던 녹화(.events.jsonl). */
  legacyEvents: string;
  /** .index.jsonl */
  index: string;
}

function isTerminalDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TERMINAL_DIMENSION
  );
}

/** 녹화 파일의 한 줄을 읽는다. 깨졌거나 모르는 줄이면 null. */
export function parseReplayEntry(line: string): SessionReplayEntry | null {
  if (!line.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (typeof entry.atMs !== "number" || !Number.isFinite(entry.atMs)) {
    return null;
  }
  if (entry.type === "output" && typeof entry.dataBase64 === "string") {
    return entry as unknown as SessionReplayEntry;
  }
  if (
    entry.type === "resize" &&
    isTerminalDimension(entry.cols) &&
    isTerminalDimension(entry.rows)
  ) {
    return entry as unknown as SessionReplayEntry;
  }
  return null;
}

function outputBytesOf(entry: SessionReplayEntry): number {
  return entry.type === "output"
    ? Buffer.byteLength(entry.dataBase64, "base64")
    : 0;
}

/**
 * 한 구간의 JSON 줄들을 재생 창에 넘길 꼴로 바꾼다. 시각은 앞 항목보다 작아지지 않게 한다 — 녹화 중에
 * 시스템 시계가 뒤로 가면 시각이 줄어드는데, 재생은 항목이 시각 순서라고 믿는다.
 */
export function decodeReplaySegment(
  text: string,
  startAtMs: number,
): SessionReplaySegment {
  const atMs: number[] = [];
  const dataEnd: number[] = [];
  const cols: number[] = [];
  const rows: number[] = [];
  const chunks: Buffer[] = [];
  let size = 0;
  let clock = startAtMs;
  for (const line of text.split("\n")) {
    const entry = parseReplayEntry(line);
    if (!entry) {
      continue;
    }
    clock = Math.max(clock, entry.atMs);
    if (entry.type === "output") {
      const bytes = Buffer.from(entry.dataBase64, "base64");
      chunks.push(bytes);
      size += bytes.length;
      cols.push(0);
      rows.push(0);
    } else {
      cols.push(entry.cols);
      rows.push(entry.rows);
    }
    atMs.push(clock);
    dataEnd.push(size);
  }
  // Buffer.concat 은 작은 결과를 공용 풀에서 잘라 준다. 그대로 IPC 로 넘기면 풀 전체가 복사되므로 딱 맞게 만든다.
  const data = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    data.set(chunk, position);
    position += chunk.length;
  }
  return {
    atMs: Float64Array.from(atMs),
    dataEnd: Uint32Array.from(dataEnd),
    cols: Uint16Array.from(cols),
    rows: Uint16Array.from(rows),
    data,
  };
}

interface Member {
  gzip: Gzip;
  /** 앞 멤버가 아직 파일에 다 쓰이지 않아 기다리는 압축 결과. 맨 앞이 되면 파일에 쓰고 null 이 된다. */
  waiting: Buffer[] | null;
  /** 지금까지 나온 압축 결과의 길이. */
  length: number;
  ended: boolean;
  startAtMs: number;
  endAtMs: number;
  entryCount: number;
  outputBytes: number;
  /** 담은 JSON 줄의 양(압축 전). */
  textBytes: number;
  /** 첫 항목을 받은 벽시계 시각(segmentMaxAgeMs 를 잰다). */
  startedAtWallMs: number;
  /** onSegment 가 있으면 이 멤버의 압축 결과를 모은다 — 파일이 다 쓰이기를 기다리지 않고 넘긴다. */
  collected: Buffer[] | null;
}

export interface ReplayEventsWriterOptions {
  /** 구간 하나에 담을 JSON 줄의 양(압축 전). 넘으면 구간을 끊는다. */
  segmentBytes?: number;
  /**
   * 구간이 이만큼 오래되면(첫 항목부터 잰 시간) 다음 flush 에서 끊는다. 팀 호스트 녹화는 구간을 끝나는 대로 팀에
   * 보내므로, 출력이 적은 세션도 몇 초마다 구간이 끝나야 한다. 0 이면 양으로만 끊는다.
   */
  segmentMaxAgeMs?: number;
  /** 구간 하나가 끝나 색인에 오를 때마다 그 구간의 압축 바이트와 함께 불린다(파일에 다 쓰이기 전일 수 있다). */
  onSegment?: (record: ReplaySegmentRecord, index: number, data: Buffer) => void;
  /** 쓰기에 실패하면 한 번 불린다. 그 뒤로 받는 항목은 버린다. */
  onError?: (error: Error) => void;
}

/**
 * 녹화 파일과 색인을 쓴다(파일 형식은 이 모듈 머리말). 압축은 백그라운드 스레드에서 돈다. 구간을 끊으면
 * 앞 멤버가 마무리되는 동안 다음 멤버가 먼저 압축 결과를 낼 수 있어서, 맨 앞 멤버만 파일에 바로 쓰고 뒤
 * 멤버의 결과는 차례가 올 때까지 모아 둔다.
 */
export class ReplayEventsWriter {
  /** 파일이 다 쓰이고 닫혔을 때(실패했을 때도) 풀린다. */
  readonly done: Promise<void>;
  /** 색인에 적은 구간. */
  readonly segments: ReplaySegmentRecord[] = [];
  private readonly file: WriteStream;
  private readonly indexFd: number;
  private readonly segmentBytes: number;
  private readonly segmentMaxAgeMs: number;
  private readonly onSegment: ReplayEventsWriterOptions["onSegment"];
  private readonly onError: ((error: Error) => void) | undefined;
  /** 압축 중이거나 파일에 쓰이기를 기다리는 멤버. 맨 앞 멤버만 파일에 바로 쓴다. */
  private readonly members: Member[] = [];
  /** 지금 항목을 받는 멤버. 끊은 뒤에는 다음 항목이 올 때 새로 만든다. */
  private current: Member | null = null;
  private batch: string[] = [];
  private batchBytes = 0;
  /** 마지막으로 압축기를 비운 뒤 받은 것이 있는가. */
  private dirty = false;
  /** 맨 앞 멤버가 시작하는 파일 위치. */
  private nextOffset = 0;
  private ending = false;
  private failedError: Error | null = null;

  constructor(
    eventsPath: string,
    indexPath: string,
    options: ReplayEventsWriterOptions = {},
  ) {
    this.segmentBytes = options.segmentBytes ?? REPLAY_SEGMENT_BYTES;
    this.segmentMaxAgeMs = options.segmentMaxAgeMs ?? 0;
    this.onSegment = options.onSegment;
    this.onError = options.onError;
    // 파일은 지금 연다. 스트림에 경로만 주면 다음 틱에야 열려서, 녹화가 시작된 직후에는 파일이 없고 그
    // 사이 폴더가 지워지면 늦게 실패한다.
    const eventsFd = openSync(eventsPath, "w");
    try {
      this.indexFd = openSync(indexPath, "w");
    } catch (error) {
      closeSync(eventsFd);
      throw error;
    }
    this.file = createWriteStream(eventsPath, { fd: eventsFd });
    this.done = new Promise<void>((resolve) => {
      this.file.once("close", () => {
        try {
          closeSync(this.indexFd);
        } catch {
          // 이미 닫혔다.
        }
        resolve();
      });
    });
    this.file.on("error", (error) => this.fail(error));
  }

  get failed(): boolean {
    return this.failedError !== null;
  }

  /** JSON 한 줄(줄바꿈 없이)을 덧붙인다. atMs 는 앞 항목보다 작지 않아야 한다. */
  append(line: string, atMs: number, outputBytes: number): void {
    if (this.failedError || this.ending) {
      return;
    }
    const member = this.current ?? (this.current = this.startMember(atMs));
    member.endAtMs = atMs;
    member.entryCount += 1;
    member.outputBytes += outputBytes;
    member.textBytes += line.length + 1;
    this.batch.push(line, "\n");
    this.batchBytes += line.length + 1;
    this.dirty = true;
    if (member.textBytes >= this.segmentBytes) {
      this.writeBatch();
      this.endCurrent();
      return;
    }
    if (this.batchBytes >= WRITE_BATCH_BYTES) {
      this.writeBatch();
    }
  }

  /**
   * 받은 것을 압축기에 넘기고 압축기를 비운다. 비운 지점까지는 마무리 없이 끊긴 파일(비정상 종료)에서도
   * 읽힌다.
   */
  flush(): void {
    if (this.failedError) {
      return;
    }
    const aging = this.current;
    if (
      aging &&
      this.segmentMaxAgeMs > 0 &&
      aging.entryCount > 0 &&
      Date.now() - aging.startedAtWallMs >= this.segmentMaxAgeMs
    ) {
      // 오래된 구간은 끊는다 — 끝난 구간만 색인에 오르고 팀으로 간다. 새 출력이 없어도 끊어야 마지막 몇 줄이
      // 다음 출력이 올 때까지 기다리지 않는다.
      this.dirty = false;
      this.writeBatch();
      this.endCurrent();
      return;
    }
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.writeBatch();
    const member = this.current;
    if (member && !member.gzip.destroyed) {
      member.gzip.flush(zlibConstants.Z_SYNC_FLUSH);
    }
  }

  /** 남은 것을 압축해 쓰고 닫는다. */
  end(): Promise<void> {
    if (!this.ending) {
      this.ending = true;
      if (!this.failedError) {
        this.writeBatch();
        this.endCurrent();
        this.drain();
      }
    }
    return this.done;
  }

  private startMember(atMs: number): Member {
    const gzip = createGzip({ level: EVENTS_GZIP_LEVEL });
    const member: Member = {
      gzip,
      waiting: this.members.length === 0 ? null : [],
      length: 0,
      ended: false,
      startAtMs: atMs,
      endAtMs: atMs,
      entryCount: 0,
      outputBytes: 0,
      textBytes: 0,
      startedAtWallMs: Date.now(),
      collected: this.onSegment ? [] : null,
    };
    gzip.on("data", (chunk: Buffer) => {
      if (this.failedError) {
        return;
      }
      member.length += chunk.length;
      member.collected?.push(chunk);
      if (member.waiting) {
        member.waiting.push(chunk);
      } else {
        this.file.write(chunk);
      }
    });
    gzip.once("end", () => {
      member.ended = true;
      this.drain();
    });
    gzip.once("error", (error) => this.fail(error));
    this.members.push(member);
    return member;
  }

  private writeBatch(): void {
    const member = this.current;
    if (!member || this.batch.length === 0) {
      return;
    }
    member.gzip.write(this.batch.join(""));
    this.batch = [];
    this.batchBytes = 0;
  }

  private endCurrent(): void {
    const member = this.current;
    this.current = null;
    member?.gzip.end();
  }

  /** 다 압축된 앞쪽 멤버를 색인에 적고, 그 다음 멤버가 모아 둔 것을 파일에 쓴다. */
  private drain(): void {
    if (this.failedError) {
      return;
    }
    while (this.members[0]?.ended) {
      const member = this.members.shift()!;
      const record: ReplaySegmentRecord = {
        offset: this.nextOffset,
        length: member.length,
        startAtMs: member.startAtMs,
        endAtMs: member.endAtMs,
        entryCount: member.entryCount,
        outputBytes: member.outputBytes,
      };
      this.nextOffset += member.length;
      if (member.entryCount > 0) {
        try {
          writeSync(this.indexFd, `${JSON.stringify(record)}\n`);
        } catch (error) {
          this.fail(error as Error);
          return;
        }
        this.segments.push(record);
        if (this.onSegment) {
          const data = Buffer.concat(member.collected ?? []);
          member.collected = null;
          try {
            this.onSegment(record, this.segments.length - 1, data);
          } catch (error) {
            // 받는 쪽의 실패가 녹화를 멈추지 않는다.
            console.warn("[session-replay] a segment listener failed", error);
          }
        }
      }
      const next = this.members[0];
      if (next?.waiting) {
        for (const chunk of next.waiting) {
          this.file.write(chunk);
        }
        next.waiting = null;
      }
    }
    if (this.ending && this.members.length === 0 && !this.file.writableEnded) {
      this.file.end();
    }
  }

  private fail(error: Error): void {
    if (this.failedError) {
      return;
    }
    this.failedError = error;
    for (const member of this.members) {
      member.gzip.destroy();
    }
    this.members.length = 0;
    this.current = null;
    this.batch = [];
    this.file.destroy();
    this.onError?.(error);
  }
}

async function readSegmentText(
  eventsPath: string,
  offset: number,
  length: number,
  cutOff: boolean,
  compressed = true,
): Promise<string> {
  const handle = await open(eventsPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        offset + filled,
      );
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    if (!compressed) {
      return buffer.subarray(0, filled).toString("utf8");
    }
    // 비정상 종료로 마무리 없이 끊긴 끝부분은 마지막으로 비운 지점까지 읽는다.
    const content = await gunzipAsync(
      buffer.subarray(0, filled),
      cutOff ? { finishFlush: zlibConstants.Z_SYNC_FLUSH } : {},
    );
    return content.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** 한 구간을 읽어 재생 창에 넘길 꼴로 만든다. */
export async function readReplaySegment(
  eventsPath: string,
  record: ReplaySegmentRecord,
): Promise<SessionReplaySegment> {
  return decodeReplaySegment(
    await readSegmentText(
      eventsPath,
      record.offset,
      record.length,
      record.cutOff === true,
      record.plain !== true,
    ),
    record.startAtMs,
  );
}

function isSegmentRecord(value: unknown): value is ReplaySegmentRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const fields = [
    record.offset,
    record.length,
    record.startAtMs,
    record.endAtMs,
    record.entryCount,
    record.outputBytes,
  ];
  return (
    fields.every(
      (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
    ) &&
    (record.length as number) > 0 &&
    (record.entryCount as number) > 0 &&
    (record.endAtMs as number) >= (record.startAtMs as number)
  );
}

/**
 * 색인 파일을 읽는다. 앞 구간과 겹치거나 파일 끝을 넘는 줄부터는 버린다 — 비정상 종료로 색인만 먼저
 * 쓰이고 그 구간의 압축 결과는 파일에 닿지 못했을 수 있다.
 */
export function parseReplayIndex(
  text: string,
  eventsSize: number,
): ReplaySegmentRecord[] {
  const records: ReplaySegmentRecord[] = [];
  let indexedEnd = 0;
  let clock = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      break;
    }
    if (
      !isSegmentRecord(parsed) ||
      parsed.offset < indexedEnd ||
      parsed.offset + parsed.length > eventsSize ||
      parsed.startAtMs < clock
    ) {
      break;
    }
    records.push({
      offset: parsed.offset,
      length: parsed.length,
      startAtMs: parsed.startAtMs,
      endAtMs: parsed.endAtMs,
      entryCount: parsed.entryCount,
      outputBytes: parsed.outputBytes,
    });
    indexedEnd = parsed.offset + parsed.length;
    clock = parsed.endAtMs;
  }
  return records;
}

/** 색인 뒤에 남은 부분을 구간 하나로 본다. 읽을 항목이 없으면 null. */
async function summarizeReplayTail(
  eventsPath: string,
  offset: number,
  length: number,
  previousEndAtMs: number,
): Promise<ReplaySegmentRecord | null> {
  let text: string;
  try {
    text = await readSegmentText(eventsPath, offset, length, true);
  } catch (error) {
    console.warn("[session-replay] could not read the end of a recording", error);
    return null;
  }
  let entryCount = 0;
  let outputBytes = 0;
  let startAtMs = previousEndAtMs;
  let clock = previousEndAtMs;
  for (const line of text.split("\n")) {
    const entry = parseReplayEntry(line);
    if (!entry) {
      continue;
    }
    clock = Math.max(clock, entry.atMs);
    if (entryCount === 0) {
      startAtMs = clock;
    }
    entryCount += 1;
    outputBytes += outputBytesOf(entry);
  }
  return entryCount > 0
    ? { offset, length, startAtMs, endAtMs: clock, entryCount, outputBytes, cutOff: true }
    : null;
}

/** 압축 데이터가 깨져 풀리지 않는 경우(zlib 오류). 파일을 읽지 못한 것과 구별한다. */
export function isReplayDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

/**
 * 색인이 없는 녹화를 이 형식으로 다시 쓴다. 다른 이름에 다 쓴 뒤 이름을 바꿔 원래 파일을 대신하므로, 도중에
 * 멈춰도 원래 녹화는 그대로 남는다.
 *
 * 푸는 중에 압축 오류가 나면 바꿔 쓰지 않고 실패한다. 오류 전까지 풀린 것만 살리려 해도 gzip 은 멤버
 * 끝에서야 검사하므로, 깨진 데이터가 앞 출력을 되풀이한 가짜 줄로 풀려 나온다(실측: 2,000줄 녹화에서
 * 7,785줄) — 녹화에 없던 출력을 보여 주느니 열지 않는다. 다만 이 형식 전의 녹화는 끝이 잘린 것(비정상
 * 종료)도 읽어야 해서, 깨진 곳이 잘린 끝처럼 보이면 가려내지 못한다(예전에 읽던 방식과 같다).
 */
async function convertReplayEvents(
  sourcePath: string,
  gzipped: boolean,
  files: ReplayEventFiles,
): Promise<ReplaySegmentRecord[]> {
  const temporaryEvents = `${files.events}${REPLAY_TEMP_SUFFIX}`;
  const temporaryIndex = `${files.index}${REPLAY_TEMP_SUFFIX}`;
  let writeError: Error | null = null;
  const writer = new ReplayEventsWriter(temporaryEvents, temporaryIndex, {
    onError: (error) => {
      writeError = error;
    },
  });
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let clock = 0;
  const take = (line: string) => {
    const entry = parseReplayEntry(line);
    if (!entry) {
      return;
    }
    clock = Math.max(clock, entry.atMs);
    writer.append(
      entry.atMs === clock ? line.trim() : JSON.stringify({ ...entry, atMs: clock }),
      clock,
      outputBytesOf(entry),
    );
  };
  const consume = async (chunks: AsyncIterable<Buffer>) => {
    for await (const chunk of chunks) {
      const lines = (carry + decoder.write(chunk)).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        take(line);
      }
    }
  };

  const source: ReadStream = createReadStream(sourcePath);
  let readError: unknown = null;
  try {
    if (gzipped) {
      // 비정상 종료로 마무리 없이 끊긴 녹화도 마지막으로 비운 지점까지는 읽는다.
      await pipeline(
        source,
        createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH }),
        consume,
      );
    } else {
      await pipeline(source, consume);
    }
  } catch (error) {
    readError = error;
  }
  if (!source.closed) {
    // Windows 는 열린 파일의 이름을 바꾸지 못한다. 원래 파일을 대신하기 전에 닫힌 것을 확인한다.
    await once(source, "close");
  }
  if (readError) {
    await writer.end();
    rmSync(temporaryEvents, { force: true });
    rmSync(temporaryIndex, { force: true });
    throw readError;
  }
  take(carry + decoder.end());
  await writer.end();
  if (writeError) {
    rmSync(temporaryEvents, { force: true });
    rmSync(temporaryIndex, { force: true });
    throw writeError;
  }
  renameSync(temporaryEvents, files.events);
  renameSync(temporaryIndex, files.index);
  return writer.segments;
}

/**
 * 녹화의 구간 목록을 만든다. 색인이 있으면 그것을 읽고, 색인 뒤에 남은 것(비정상 종료)은 구간 하나로
 * 붙인다. 색인이 없거나 남은 것이 크면 녹화를 이 형식으로 다시 쓴다.
 */
export async function loadReplaySegments(
  files: ReplayEventFiles,
): Promise<ReplaySegmentRecord[]> {
  if (existsSync(files.events) && existsSync(files.index)) {
    const eventsSize = statSync(files.events).size;
    const records = parseReplayIndex(readFileSync(files.index, "utf8"), eventsSize);
    const last = records[records.length - 1];
    const indexedEnd = last ? last.offset + last.length : 0;
    const tailLength = eventsSize - indexedEnd;
    if (tailLength <= 0) {
      return records;
    }
    if (tailLength <= TAIL_SEGMENT_MAX_BYTES) {
      const tail = await summarizeReplayTail(
        files.events,
        indexedEnd,
        tailLength,
        last?.endAtMs ?? 0,
      );
      return tail ? [...records, tail] : records;
    }
  }
  if (existsSync(files.events)) {
    return convertReplayEvents(files.events, true, files);
  }
  if (existsSync(files.legacyEvents)) {
    let records: ReplaySegmentRecord[];
    try {
      records = await convertReplayEvents(files.legacyEvents, false, files);
    } catch (error) {
      if (!isWriteFailure(error)) {
        throw error;
      }
      // 폴더에 쓸 수 없으면(권한·디스크 공간) 바꿔 쓰지 않고 원래 파일을 그대로 읽는다. 바꿔 써야만 열게
      // 되면서 원문 오류(EACCES·ENOSPC)로 열리지 않았다(실측). 다음에 열 때 쓸 수 있으면 그때 바꿔 쓴다.
      console.warn("[session-replay] could not rewrite an old recording, reading it in place", error);
      return indexPlainReplayEvents(files.legacyEvents);
    }
    rmSync(files.legacyEvents, { force: true });
    return records;
  }
  return [];
}

/** 녹화 폴더에 쓰지 못한 경우(권한·디스크 공간)인가. */
function isWriteFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "ENOSPC" ||
    code === "EDQUOT"
  );
}

/**
 * 압축하지 않은 옛 녹화를 바꿔 쓰지 않고 읽을 수 있게, 구간 표만 만든다. 파일을 한 번 훑어 줄 경계 위치로
 * 구간을 나눈다(나누는 기준은 새 녹화와 같다). 쓰는 파일은 없고 메모리에는 표만 남는다.
 */
export async function indexPlainReplayEvents(
  sourcePath: string,
  segmentBytes = REPLAY_SEGMENT_BYTES,
): Promise<ReplaySegmentRecord[]> {
  const records: ReplaySegmentRecord[] = [];
  let current: ReplaySegmentRecord | null = null;
  let currentTextBytes = 0;
  let clock = 0;
  // 줄 하나: [start, end) 는 줄바꿈까지 포함한 파일 위치.
  const take = (line: Buffer, start: number, end: number) => {
    const entry = parseReplayEntry(line.toString("utf8"));
    if (!entry) {
      return;
    }
    clock = Math.max(clock, entry.atMs);
    current ??= {
      offset: start,
      length: 0,
      startAtMs: clock,
      endAtMs: clock,
      entryCount: 0,
      outputBytes: 0,
      plain: true,
    };
    current.length = end - current.offset;
    current.endAtMs = clock;
    current.entryCount += 1;
    current.outputBytes += outputBytesOf(entry);
    currentTextBytes += end - start;
    if (currentTextBytes >= segmentBytes) {
      records.push(current);
      current = null;
      currentTextBytes = 0;
    }
  };

  let position = 0;
  let lineStart = 0;
  let carry: Buffer[] = [];
  for await (const chunk of createReadStream(sourcePath) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, from)) {
      const piece = chunk.subarray(from, newline);
      const end = position + newline + 1;
      take(carry.length > 0 ? Buffer.concat([...carry, piece]) : piece, lineStart, end);
      carry = [];
      lineStart = end;
      from = newline + 1;
    }
    if (from < chunk.length) {
      carry.push(chunk.subarray(from));
    }
    position += chunk.length;
  }
  if (carry.length > 0) {
    take(Buffer.concat(carry), lineStart, position);
  }
  if (current) {
    records.push(current);
  }
  return records;
}
