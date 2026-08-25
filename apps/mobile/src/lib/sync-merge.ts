import type {
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
} from '@dolssh/shared-core';
import type { SyncOutboxKind } from './sync-outbox';

/**
 * 원격 스냅샷을 로컬에 적용하는 **단 하나의 입구**.
 *
 * 예전에는 종류마다 따로 덮어썼다(`set({hosts: 서버것})`, `updateSecretsState(서버것)` …).
 * 그래서 아직 서버에 못 올린 로컬 변경이 조용히 사라질 수 있었고, 실제로 secrets 에서
 * 그렇게 잃었다 — 큐는 값을 안 들고 포인터만 들기 때문에, 가리키던 레코드가 사라지면
 * 밀 것을 못 찾아 항목째 버려진다. 흔적도 남지 않는다.
 *
 * 조심해서 막는 대신 **규칙 하나로 못 일어나게** 한다: 레코드마다 더 최신인 쪽이 남는다.
 * 못 올린 로컬 변경은 정의상 서버 것보다 최신이라 자동으로 살아남는다. 서버도 같은 규칙
 * (updated_at 마지막 쓰기 승리)이라 양쪽이 어긋나지 않는다.
 */

/** 서버가 준 한 종류의 스냅샷. 삭제는 tombstone 으로 따로 온다(디코드가 걸러 내므로). */
export interface RemoteCollection<T> {
  live: T[];
  tombstones: Array<{ id: string; deletedAt: string }>;
}

export interface MergeableCollection<T> {
  local: T[];
  remote: RemoteCollection<T>;
}

/**
 * 병합에 넣어야 하는 종류들. **큐가 다루는 종류와 같아야 한다** — 로컬 우선 쓰기가 있는
 * 것이 곧 pull 에 지워질 수 있는 것이다. 아래 타입 검사가 둘이 어긋나면 컴파일을 막는다.
 */
export interface SyncMergeInput {
  hosts: MergeableCollection<HostRecord>;
  groups: MergeableCollection<GroupRecord>;
  knownHosts: MergeableCollection<KnownHostRecord>;
  secrets: MergeableCollection<LoadedManagedSecretPayload>;
}

// 큐에 종류를 하나 더 넣고 여기를 안 고치면 여기서 컴파일이 깨진다.
type MissingMergeKind = Exclude<SyncOutboxKind, keyof SyncMergeInput>;
const _allOutboxKindsAreMerged: MissingMergeKind extends never ? true : never =
  true as MissingMergeKind extends never ? true : never;
void _allOutboxKindsAreMerged;

export interface SyncMergeResult {
  hosts: HostRecord[];
  groups: GroupRecord[];
  knownHosts: KnownHostRecord[];
  secrets: LoadedManagedSecretPayload[];
  /**
   * 서버에 없고 삭제된 적도 없는 로컬 레코드 = **아직 안 올라간 것.**
   *
   * 큐에 다시 넣어 다음 기회에 올린다. 큐 항목이 어쩌다 사라져도(로컬 저장 직후 앱이 죽는
   * 등) 스스로 회복하고, 올라가지도 지워지지도 않는 유령 레코드가 남지 않는다.
   */
  unpushed: Array<{ kind: keyof SyncMergeInput; id: string }>;
}

function isAfter(left: string | undefined, right: string | undefined): boolean {
  // 값이 없으면 "모르는 것" 이라 최신이라고 주장하지 않는다.
  if (!left) {
    return false;
  }
  if (!right) {
    return true;
  }
  // **문자열로 견주지 않는다.** 소수점 자릿수가 다르면 순서가 뒤집힌다 — `.` 는 `Z` 보다
  // 작아서 `…05.950Z` 가 `…05Z` 보다 작은 것으로 나온다. 우리 레코드의 시각은 전부
  // `toISOString()`(밀리초 3자리)이지만 tombstone 의 시각은 서버가 찍어 주는 값이고,
  // 밀리초를 깎아 돌려주는 서버(옛 버전)가 있다. 그러면 지운 직후 같은 초에 고친 레코드가
  // "삭제보다 오래된 것" 이 되어 그 편집이 조용히 사라진다.
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
    // 시각으로 못 읽는 값이면 예전처럼 글자로 견준다 — 아무 판단도 못 하는 것보다 낫다.
    return left > right;
  }
  return leftMs > rightMs;
}

/**
 * 한 종류를 병합한다.
 *
 *  - 서버가 지웠다고 하면(tombstone) 지운다. 단 로컬이 **그 삭제보다 뒤에** 고쳐졌으면
 *    로컬이 이긴다 — 지운 뒤 다시 만든 경우다.
 *  - 양쪽에 다 있으면 `updatedAt` 이 더 최신인 쪽.
 *  - 로컬에만 있으면 **남긴다.** 아직 안 올렸거나 서버가 잃은 것이고, 둘 다 지울 이유가 아니다.
 */
export function mergeSyncedRecords<T>(
  { local, remote }: MergeableCollection<T>,
  idOf: (record: T) => string,
  updatedAtOf: (record: T) => string | undefined,
): { merged: T[]; unpushedIds: string[] } {
  const deletedAtById = new Map(
    remote.tombstones.map(entry => [entry.id, entry.deletedAt]),
  );
  const localById = new Map(local.map(record => [idOf(record), record]));
  const merged: T[] = [];
  const unpushedIds: string[] = [];
  const taken = new Set<string>();

  for (const remoteRecord of remote.live) {
    const id = idOf(remoteRecord);
    taken.add(id);
    const localRecord = localById.get(id);
    const localWins =
      localRecord !== undefined &&
      isAfter(updatedAtOf(localRecord), updatedAtOf(remoteRecord));
    merged.push(localWins ? (localRecord as T) : remoteRecord);
    if (localWins) {
      // **안 올라간 편집이다.** 서버가 이 레코드를 알고 있는데 우리 것이 더 최신이라면 밀기가
      // 아직 안 됐거나 도중에 잃은 것이다 — 큐에 다시 올려 다음 기회에 나른다.
      //
      // 이것이 없으면 어떤 이유로든 큐에서 빠진 편집은 영영 그 기기에만 남는다(자가치유가
      // 서버에 아예 없는 레코드만 보고 있었다). 성공적으로 민 뒤에는 두 시각이 같아져
      // 여기 걸리지 않으므로 같은 것을 계속 다시 밀지도 않는다.
      unpushedIds.push(id);
    }
  }

  for (const localRecord of local) {
    const id = idOf(localRecord);
    if (taken.has(id)) {
      continue;
    }
    const deletedAt = deletedAtById.get(id);
    if (deletedAt && !isAfter(updatedAtOf(localRecord), deletedAt)) {
      continue;
    }
    merged.push(localRecord);
    unpushedIds.push(id);
  }

  return { merged, unpushedIds };
}

export function mergeSyncedState(input: SyncMergeInput): SyncMergeResult {
  const hosts = mergeSyncedRecords(
    input.hosts,
    record => record.id,
    record => record.updatedAt,
  );
  const groups = mergeSyncedRecords(
    input.groups,
    record => record.id,
    record => record.updatedAt,
  );
  const knownHosts = mergeSyncedRecords(
    input.knownHosts,
    record => record.id,
    record => record.updatedAt,
  );
  const secrets = mergeSyncedRecords(
    input.secrets,
    record => record.secretRef,
    record => record.updatedAt,
  );

  const unpushed: SyncMergeResult['unpushed'] = [];
  for (const [kind, ids] of [
    ['hosts', hosts.unpushedIds],
    ['groups', groups.unpushedIds],
    ['knownHosts', knownHosts.unpushedIds],
    ['secrets', secrets.unpushedIds],
  ] as Array<[keyof SyncMergeInput, string[]]>) {
    for (const id of ids) {
      unpushed.push({ kind, id });
    }
  }

  return {
    hosts: hosts.merged,
    groups: groups.merged,
    knownHosts: knownHosts.merged,
    secrets: secrets.merged,
    unpushed,
  };
}
