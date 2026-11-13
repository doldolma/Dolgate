// 동기화 올리기를 작은 묶음으로 나눠 보낸다 — 데스크톱(개인·팀)·모바일 공용.
//
// 서버의 올리기(개인 /sync, 팀 /sync, 팀 개인 칸 /me)는 받은 레코드만 넣거나 고친다. 레코드마다 시각이 늦은 쪽이
// 이기고, 요청 하나가 트랜잭션 하나다. 그래서 여러 요청으로 나눠 보내도 결과가 같다.
//
// 나누는 까닭은 서버 앞의 리버스 프록시다. nginx 는 기본으로 본문을 1MB 까지만 받고, 넘으면 서버에 닿기도 전에
// 413 을 준다. 서버에는 본문 한도가 없으므로 이것은 앞단 설정에 따라 갈린다 — 어떤 설정이어도 올라가게 한다.
//
// React Native 에서도 돌아야 하므로 Node·브라우저 전용 API 를 쓰지 않는다.

import type { SyncRecord } from "./api";

/**
 * 묶음 하나의 처음 크기(바이트). nginx 기본 본문 한도(1MB)의 1/4 이다 — 처음부터 413 이 드물게 한다. 앞단이
 * 413 을 주면서 연결을 먼저 끊으면 앱에는 413 대신 네트워크 오류로 보일 수 있어서, 413 에 기대는 길은 드물수록 좋다.
 */
export const SYNC_PUSH_BATCH_BYTES = 256 * 1024;

/**
 * 묶음에 싣는 순서. 가리킴을 받는 것을 먼저, 가리키는 것을 나중에 — 묶음 사이에 다른 기기가 받아 가도 없는
 * 비밀값·프로필을 가리키는 호스트, 없는 호스트를 가리키는 포트 포워딩·워크스페이스를 보지 않게 한다. 지움은
 * 거꾸로(가리키는 것부터) 싣고, 올리기 뒤에 둔다. 여기 없는 종류(팀 개인 칸 등)는 끝에 들어온 순서대로.
 */
const KIND_ORDER = [
  "secrets",
  "tailnets",
  "awsProfiles",
  "knownHosts",
  "groups",
  "snippets",
  "preferences",
  "hosts",
  "portForwards",
  "dnsOverrides",
  "workspaces",
] as const;

export type SyncPushPayload = Record<string, SyncRecord[] | undefined>;

export interface SyncPushEntry {
  kind: string;
  record: SyncRecord;
  /** 이 레코드가 본문에서 차지하는 바이트(UTF-8). */
  bytes: number;
}

/** 묶음 하나를 보낸 결과. 앞단이 본문이 크다고 거절했으면(413) "too-large". 그 밖의 실패는 던진다. */
export type SyncPushSendOutcome = "sent" | "too-large";

export interface SyncPushInBatchesOptions {
  /** 이 서버에서 줄인 묶음 크기를 기억할 열쇠 — 서버 주소. */
  serverKey: string;
  /** 묶음 하나를 보낸다. */
  send: (payload: Record<string, SyncRecord[]>) => Promise<SyncPushSendOutcome>;
  /** 묶음 하나가 서버에 들어갈 때마다 — 부른 쪽은 리비전을 이어 받고, 보낸 것을 적는다. 다음 묶음은 이것이 끝난 뒤에 간다. */
  onSent?: (entries: SyncPushEntry[]) => void | Promise<void>;
}

export interface SyncPushInBatchesResult {
  /** 보낸 묶음 수. */
  batches: number;
  /** 그것 하나만 보내도 앞단이 413 을 준 레코드 — 나머지는 다 보냈다. */
  tooLarge: SyncPushEntry[];
}

/** 413 을 받아 줄인 묶음 크기 — 앱이 켜져 있는 동안 서버마다 기억한다(개인·팀이 같은 앞단을 지난다). */
const learnedBatchBytes = new Map<string, number>();

/** 이 서버로 보낼 묶음 크기. */
export function syncPushBatchBytes(serverKey: string): number {
  return learnedBatchBytes.get(serverKey) ?? SYNC_PUSH_BATCH_BYTES;
}

/** 시험용 — 기억한 묶음 크기를 지운다. */
export function resetSyncPushBatchBytes(): void {
  learnedBatchBytes.clear();
}

/** 문자열이 UTF-8 로 몇 바이트인가(TextEncoder 없이 — RN 에서도 돈다). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // 서로게이트 짝 하나가 4바이트다.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function kindRank(kind: string): number {
  const index = (KIND_ORDER as readonly string[]).indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/** 실을 순서대로 편다 — 올리기(종류 순서), 그다음 지움(종류 역순). 같은 종류 안에서는 받은 순서 그대로. */
export function orderSyncPushEntries(payload: SyncPushPayload): SyncPushEntry[] {
  const kinds = Object.keys(payload).filter((kind) => (payload[kind]?.length ?? 0) > 0);
  // 같은 순위(모르는 종류)끼리는 들어온 순서를 지킨다.
  const ranked = kinds
    .map((kind, position) => ({ kind, position, rank: kindRank(kind) }))
    .sort((left, right) => left.rank - right.rank || left.position - right.position);
  const toEntry = (kind: string, record: SyncRecord): SyncPushEntry => ({
    kind,
    record,
    // 레코드 하나와 그 뒤 쉼표.
    bytes: utf8ByteLength(JSON.stringify(record)) + 1,
  });
  const upserts: SyncPushEntry[] = [];
  const deletions: SyncPushEntry[] = [];
  for (const { kind } of ranked) {
    for (const record of payload[kind] ?? []) {
      if (record.deleted_at) {
        continue;
      }
      upserts.push(toEntry(kind, record));
    }
  }
  for (const { kind } of [...ranked].reverse()) {
    for (const record of payload[kind] ?? []) {
      if (record.deleted_at) {
        deletions.push(toEntry(kind, record));
      }
    }
  }
  return [...upserts, ...deletions];
}

/** 묶음의 본문 크기 — 레코드들에 종류 이름과 괄호를 더한다. */
function batchBytes(entries: readonly SyncPushEntry[]): number {
  const kinds = new Set(entries.map((entry) => entry.kind));
  let bytes = 2;
  for (const kind of kinds) {
    // "kind":[ ... ], — 레코드 몫의 쉼표가 닫는 괄호 자리를 메운다.
    bytes += utf8ByteLength(JSON.stringify(kind)) + 4;
  }
  for (const entry of entries) {
    bytes += entry.bytes;
  }
  return bytes;
}

/** 앞에서부터 한 묶음을 뗀다. 레코드 하나가 그 자체로 크면 그것 혼자 한 묶음이다(앞단 한도가 더 클 수 있다). */
function takeBatch(entries: readonly SyncPushEntry[], maxBytes: number): SyncPushEntry[] {
  const batch: SyncPushEntry[] = [];
  for (const entry of entries) {
    if (batch.length > 0 && batchBytes([...batch, entry]) > maxBytes) {
      break;
    }
    batch.push(entry);
  }
  return batch;
}

/** 나눠 볼 묶음들 — 시험과 크기 가늠용. 실제로 보낼 때는 413 에 따라 다시 나눈다. */
export function planSyncPushBatches(payload: SyncPushPayload, maxBytes = SYNC_PUSH_BATCH_BYTES): SyncPushEntry[][] {
  let rest = orderSyncPushEntries(payload);
  const batches: SyncPushEntry[][] = [];
  while (rest.length > 0) {
    const batch = takeBatch(rest, maxBytes);
    batches.push(batch);
    rest = rest.slice(batch.length);
  }
  return batches;
}

/**
 * 묶음의 본문. 원래 페이로드에 있던 종류 칸은 비었어도 모두 싣는다 — 보내는 모양을 나누기 전과 같게 둔다(서버는
 * 빠진 종류를 건드리지 않지만, 옛 서버·옛 시험이 기대한 모양을 바꾸지 않는다).
 */
function toPayload(entries: readonly SyncPushEntry[], kinds: readonly string[]): Record<string, SyncRecord[]> {
  const payload: Record<string, SyncRecord[]> = {};
  for (const kind of kinds) {
    payload[kind] = [];
  }
  for (const entry of entries) {
    (payload[entry.kind] ??= []).push(entry.record);
  }
  return payload;
}

/**
 * 레코드를 묶음으로 나눠 차례로 보낸다.
 *
 * - 413 이면 그 묶음 크기의 반으로 줄여 남은 것을 다시 묶는다. 줄인 크기는 서버마다 기억한다.
 * - 레코드 하나만 든 묶음이 413 이면 그 레코드는 너무 크다 — 빼고 나머지를 보낸다(결과의 tooLarge).
 * - 그 밖의 실패(연결·5xx·409 등)는 그대로 던진다. 그때까지 들어간 묶음은 onSent 로 이미 알렸다.
 */
export async function pushSyncRecordsInBatches(
  payload: SyncPushPayload,
  options: SyncPushInBatchesOptions,
): Promise<SyncPushInBatchesResult> {
  let maxBytes = syncPushBatchBytes(options.serverKey);
  let rest = orderSyncPushEntries(payload);
  const kinds = Object.keys(payload).filter((kind) => Array.isArray(payload[kind]));
  const tooLarge: SyncPushEntry[] = [];
  let batches = 0;
  while (rest.length > 0) {
    const batch = takeBatch(rest, maxBytes);
    const outcome = await options.send(toPayload(batch, kinds));
    if (outcome === "sent") {
      rest = rest.slice(batch.length);
      batches += 1;
      await options.onSent?.(batch);
      continue;
    }
    if (batch.length === 1) {
      tooLarge.push(batch[0]);
      rest = rest.slice(1);
      continue;
    }
    // 앞단 한도가 이 묶음보다 작다. 반으로 줄인다 — 여러 개 든 묶음은 늘 maxBytes 안이라 매번 줄어 끝이 난다.
    maxBytes = Math.max(1, Math.floor(batchBytes(batch) / 2));
    learnedBatchBytes.set(options.serverKey, maxBytes);
  }
  return { batches, tooLarge };
}
