import type { DesktopVaultData } from "./state-storage";

/*
 * 팀 볼트에 쓰는 시각.
 *
 * 팀 레코드는 레코드마다 "나중에 쓴 쪽"이 이긴다 — 올리기는 서버 사본보다 늦은 것만 보내고 서버도 늦은 것만 받는다. 그런데
 * 시각은 쓴 사람 기기의 시계다. 다른 팀원 기기의 시계가 빠르면 그 사람이 막 고친 레코드의 시각이 내 '지금'보다 뒤라서, 내가
 * 고치거나 지운 것이 "옛것"이 되어 올라가지 않고 다음 받기에서 덮였다(2026-11-02 리뷰). 그래서 팀 볼트에 쓸 때는 시각을
 * "지금, 단 내가 본 그 레코드의 시각보다 뒤"로 적는다. 모바일의 개인 칸(nextUpdatedAt)·되살리기(writeTimeAfterServer)와 같은
 * 규칙이다. 개인 볼트는 손대지 않는다.
 *
 * 레코드 쓰기는 모두 팀 볼트 뿌리의 edit() 를 거친다(vault-root-boundary.test.ts). edit 가 한 쓰기(updateState)에서 처음 불릴
 * 때 그 팀 레코드들의 시각을 적어 두고, 쓰기가 끝날 때 시각이 바뀌었는데 앞서지 못한 레코드를 1ms 뒤로 민다. 받은 팀 데이터를
 * 담는 길(replaceTeamVault)은 edit 를 거치지 않아 그대로다. 비밀값·AWS 프로필은 올리는 시각이 잠근 값 안에 있어 그것을 쓰는
 * 곳(TeamSecretStore.save·AwsProfileRepository.upsert)이 따로 맞춘다.
 */

/** 시각을 견주는 레코드 칸과 그 동기화 종류(지움 기록의 kind). 비밀값 메타데이터는 아래에서 따로 본다. */
const TIMED_FIELDS = [
  ["groups", "groups"],
  ["hosts", "hosts"],
  ["knownHosts", "knownHosts"],
  ["portForwards", "portForwards"],
  ["dnsOverrides", "dnsOverrides"],
  ["snippets", "snippets"],
  ["savedWorkspaces", "workspaces"],
  ["tailnets", "tailnets"],
  ["awsProfiles", "awsProfiles"],
] as const satisfies ReadonlyArray<readonly [keyof DesktopVaultData, string]>;

/** 지운 레코드의 마지막 시각을 얼마나 기억하나. 지움 기록은 지운 바로 뒤에 남기므로 많을 일이 없다. */
const REMOVED_LIMIT = 2000;

type Times = Map<string, Map<string, string>>;

let depth = 0;
const pending = new Map<string, Times>();
const removed = new Map<string, string>();

/**
 * 그 레코드에 쓸 시각 — candidate, 단 last 보다 늦지 않으면 last 의 1ms 뒤. last 가 없거나 읽을 수 없으면 candidate 그대로다.
 */
export function writeTimeAfter(candidate: string, last: string | null | undefined): string {
  const lastMs = last ? Date.parse(last) : Number.NaN;
  if (!Number.isFinite(lastMs)) {
    return candidate;
  }
  const candidateMs = Date.parse(candidate);
  return Number.isFinite(candidateMs) && candidateMs > lastMs ? candidate : new Date(lastMs + 1).toISOString();
}

/** updateState 가 mutator 를 부르기 전에. 바깥 쓰기가 연 것이면(중첩) 그대로 둔다. */
export function beginTeamWrites(): void {
  if (depth === 0) {
    pending.clear();
  }
  depth += 1;
}

/**
 * updateState 가 mutator 를 마친 뒤(그 팀 볼트를 찾는 함수) 또는 mutator 가 던졌을 때(null). 바깥 쓰기가 끝날 때만 맞춘다.
 * 팀 볼트의 로컬 사본은 상태 저장소가 건넨다 — 여기서 state.teams 를 만지지 않는다(vault-catalog-boundary.test.ts).
 */
export function endTeamWrites(teamData: ((teamId: string) => DesktopVaultData | undefined) | null): void {
  depth = Math.max(0, depth - 1);
  if (depth > 0) {
    return;
  }
  if (teamData) {
    for (const [teamId, before] of pending) {
      const data = teamData(teamId);
      if (data) {
        settle(teamId, before, data);
      }
    }
  }
  pending.clear();
}

/** 팀 볼트 뿌리의 edit() 가 부른다 — 이번 쓰기에서 그 팀을 처음 고치기 직전의 시각을 적어 둔다. */
export function noteTeamWrite(teamId: string, data: DesktopVaultData): void {
  if (depth === 0 || pending.has(teamId)) {
    return;
  }
  const times: Times = new Map();
  for (const [field, kind] of TIMED_FIELDS) {
    times.set(kind, new Map((data[field] as ReadonlyArray<TimedRecord>).map((record) => [record.id, record.updatedAt])));
  }
  times.set("secrets", new Map(data.secretMetadata.map((record) => [record.secretRef, record.updatedAt])));
  pending.set(teamId, times);
}

/** 팀 볼트에 남아 있는 그 레코드의 시각(동기화 종류로 찾는다). 비밀값은 잠근 값 안의 시각이라 부르는 쪽이 본다. */
export function teamRecordWriteTime(data: DesktopVaultData, kind: string, recordId: string): string | null {
  const field = TIMED_FIELDS.find(([, candidate]) => candidate === kind)?.[0];
  if (!field) {
    return null;
  }
  return (data[field] as TimedRecord[]).find((record) => record.id === recordId)?.updatedAt ?? null;
}

/**
 * 앞선 쓰기에서 지운 그 레코드의 마지막 시각(한 번만 준다). 지움 기록을 레코드를 지운 뒤에 남기는 곳이 쓴다 — 그때는 레코드가
 * 이미 없다.
 */
export function takeRemovedTeamWriteTime(teamId: string, kind: string, recordId: string): string | null {
  const key = removedKey(teamId, kind, recordId);
  const time = removed.get(key) ?? null;
  removed.delete(key);
  return time;
}

interface TimedRecord {
  id: string;
  updatedAt: string;
}

function settle(teamId: string, before: Times, data: DesktopVaultData): void {
  for (const [field, kind] of TIMED_FIELDS) {
    const last = before.get(kind) ?? new Map<string, string>();
    const present = new Set<string>();
    for (const record of data[field] as TimedRecord[]) {
      present.add(record.id);
      const seen = last.get(record.id);
      // 시각을 바꾼 쓰기만 — 시각을 그대로 둔 쓰기(꾸밈 정보 등)는 올릴 뜻이 없다. 저장소가 돌려준 레코드와 같은 객체라 그
      // 자리에서 고친다.
      if (seen !== undefined && record.updatedAt !== seen) {
        record.updatedAt = writeTimeAfter(record.updatedAt, seen);
      }
    }
    rememberRemoved(teamId, kind, last, present);
  }
  rememberRemoved(
    teamId,
    "secrets",
    before.get("secrets") ?? new Map<string, string>(),
    new Set(data.secretMetadata.map((record) => record.secretRef)),
  );
}

function rememberRemoved(teamId: string, kind: string, last: Map<string, string>, present: ReadonlySet<string>): void {
  for (const [recordId, time] of last) {
    if (present.has(recordId)) {
      continue;
    }
    const key = removedKey(teamId, kind, recordId);
    removed.delete(key);
    removed.set(key, time);
    if (removed.size > REMOVED_LIMIT) {
      removed.delete(removed.keys().next().value as string);
    }
  }
}

function removedKey(teamId: string, kind: string, recordId: string): string {
  return `${teamId}\u0000${kind}\u0000${recordId}`;
}
