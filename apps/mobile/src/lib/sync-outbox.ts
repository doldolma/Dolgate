import type {
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  ManagedSecretPayload,
} from '@dolssh/shared-core';

// 아직 서버에 밀지 못한 변경.
//
// **페이로드를 담지 않는다.** 밀 때 로컬 상태에서 다시 만든다 — 같은 레코드를 열 번 고쳐도
// 항목 하나로 접히고, 큐에 오래 남아 있던 옛 값이 나중에 밀려 나가는 일이 없다. 삭제만
// 시각을 들고 있는데, 그때는 로컬에 그 레코드가 이미 없어 다시 만들 근거가 없기 때문이다.

export type SyncOutboxKind = 'hosts' | 'groups' | 'knownHosts' | 'secrets';

/**
 * 삭제를 서버로 실제 보낼 수 있는 종류.
 *
 * 페이로드에 tombstone 자리가 있는 것이 호스트와 그룹뿐이다. 나머지 종류의 삭제를 큐에
 * 넣을 수 있게 두면, 그 항목은 **보내지지도 않고 큐에서 빠져** 모바일에서만 지워지고
 * 서버에는 남는다 — 오류도 안 나고 알 방법도 없다. 그런 항목을 아예 만들 수 없게 한다.
 */
export type SyncOutboxDeletableKind = Extract<
  SyncOutboxKind,
  'hosts' | 'groups'
>;

export type SyncOutboxEntry =
  | { kind: SyncOutboxKind; id: string; op: 'upsert' }
  | {
      kind: SyncOutboxDeletableKind;
      id: string;
      op: 'delete';
      /** 툼스톤의 시각. 로컬에 레코드가 이미 없어 다시 만들 근거가 없기 때문에 들고 간다. */
      /**
       * 언제 지웠는가. **필수다** — 서버·다른 기기의 병합이 이 값을 `updatedAt` 과 견주므로,
       * 빠지면 그 삭제는 어떤 레코드보다도 오래된 것이 되어 진다(= 지운 것이 되살아난다).
       */
      deletedAt: string;
    };

/**
 * 항목을 큐에 넣는다. 같은 (kind, id) 는 하나만 남는다.
 *
 * 삭제가 수정을 이긴다 — 고쳤다가 지웠으면 지운 것만 밀어야 한다. 반대로 지웠다가 같은 id 로
 * 다시 만드는 일은 없다(id 는 새로 생성된다).
 */
export function enqueueSyncOutbox(
  queue: SyncOutboxEntry[],
  entry: SyncOutboxEntry
): SyncOutboxEntry[] {
  const rest = queue.filter(
    (item) => !(item.kind === entry.kind && item.id === entry.id)
  );
  return [...rest, entry];
}

export function enqueueManySyncOutbox(
  queue: SyncOutboxEntry[],
  entries: SyncOutboxEntry[]
): SyncOutboxEntry[] {
  return entries.reduce(enqueueSyncOutbox, queue);
}

/**
 * 방금 민 항목들을 큐에서 뺀다. 미는 동안 새로 들어온 것은 남는다.
 *
 * **키(`kind:id`)가 아니라 항목 자체로 지운다.** 키로 지우면 미는 동안 같은 레코드를 다시
 * 고친 경우 그 새 항목까지 지워진다 — 보낸 적이 없는데 큐에서 사라지므로 그 편집은 이 기기에만
 * 남는다. `enqueueSyncOutbox` 가 고칠 때마다 새 객체를 붙이므로, 밀고 있던 옛 항목과 그 사이
 * 들어온 새 항목은 이것으로 갈린다.
 */
export function removeSyncOutbox(
  queue: SyncOutboxEntry[],
  pushed: SyncOutboxEntry[]
): SyncOutboxEntry[] {
  const pushedEntries = new Set<SyncOutboxEntry>(pushed);
  return queue.filter((entry) => !pushedEntries.has(entry));
}

export interface SyncOutboxPayloadInput {
  hosts: HostRecord[];
  deletedHosts: Array<{ id: string; deletedAt: string }>;
  groups: GroupRecord[];
  deletedGroups: Array<{ id: string; deletedAt: string }>;
  knownHosts: KnownHostRecord[];
  /** 자격증명은 `secretRef` 로 식별한다(레코드 id 가 아니다). */
  secrets: ManagedSecretPayload[];
}

/**
 * 큐를 지금 로컬 상태와 맞춰 실제로 보낼 레코드로 편다.
 *
 * upsert 인데 로컬에 그 레코드가 없으면 **버린다** — 큐에 들어간 뒤 지워진 것이고, 삭제
 * 항목이 따로 들어와 있다.
 */
export function buildSyncOutboxPayload(
  queue: SyncOutboxEntry[],
  local: {
    hosts: HostRecord[];
    groups: GroupRecord[];
    knownHosts: KnownHostRecord[];
    secretsByRef: Record<string, ManagedSecretPayload>;
  }
): { payload: SyncOutboxPayloadInput; drained: SyncOutboxEntry[] } {
  const hostById = new Map(local.hosts.map((record) => [record.id, record]));
  const groupById = new Map(local.groups.map((record) => [record.id, record]));
  const knownHostById = new Map(
    local.knownHosts.map((record) => [record.id, record])
  );

  const payload: SyncOutboxPayloadInput = {
    hosts: [],
    deletedHosts: [],
    groups: [],
    deletedGroups: [],
    knownHosts: [],
    secrets: [],
  };
  const drained: SyncOutboxEntry[] = [];

  for (const entry of queue) {
    if (entry.op === 'delete') {
      // 타입이 요구하므로 여기 오는 것은 전부 값이 있다. 그래도 남겨 두는 이유는 저장소에서
      // 되살아난 옛 큐처럼 타입이 닿지 않는 경로가 생길 수 있어서다 — 그때 epoch 을 쓰면
      // 삭제가 병합에서 항상 져서 조용히 되살아난다. 늦은 시각이 잃는 것보다 낫다.
      const deletedAt = entry.deletedAt ?? new Date().toISOString();
      // 종류는 타입이 이미 호스트·그룹으로 좁혀 놨다 — 보낼 자리가 없는 삭제는 큐에
      // 들어올 수 없다.
      if (entry.kind === 'hosts') {
        payload.deletedHosts.push({ id: entry.id, deletedAt });
      } else {
        payload.deletedGroups.push({ id: entry.id, deletedAt });
      }
      drained.push(entry);
      continue;
    }

    const record =
      entry.kind === 'hosts'
        ? hostById.get(entry.id)
        : entry.kind === 'groups'
          ? groupById.get(entry.id)
          : entry.kind === 'secrets'
            ? local.secretsByRef[entry.id]
            : knownHostById.get(entry.id);
    if (!record) {
      // 큐에 들어간 뒤 지워졌다. 삭제 항목이 따로 있으므로 여기서는 버린다.
      drained.push(entry);
      continue;
    }

    if (entry.kind === 'hosts') {
      payload.hosts.push(record as HostRecord);
    } else if (entry.kind === 'groups') {
      payload.groups.push(record as GroupRecord);
    } else if (entry.kind === 'secrets') {
      payload.secrets.push(record as ManagedSecretPayload);
    } else {
      payload.knownHosts.push(record as KnownHostRecord);
    }
    drained.push(entry);
  }

  return { payload, drained };
}
