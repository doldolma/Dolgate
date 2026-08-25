import {
  buildSyncOutboxPayload,
  enqueueManySyncOutbox,
  enqueueSyncOutbox,
  removeSyncOutbox,
  type SyncOutboxEntry,
} from "../src/lib/sync-outbox";
import type { GroupRecord, HostRecord } from "@dolssh/shared-core";

function host(id: string, label = id): HostRecord {
  return {
    id,
    kind: "ssh",
    label,
    hostname: "example.com",
    port: 22,
    username: "root",
    authType: "password",
    groupName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as HostRecord;
}

function group(id: string): GroupRecord {
  return {
    id,
    name: id,
    path: id,
    parentPath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const empty = { hosts: [], groups: [], knownHosts: [], secretsByRef: {} };

describe("enqueueSyncOutbox", () => {
  // 같은 레코드를 열 번 고쳐도 한 번만 밀려야 한다. 항목마다 쌓이면 오프라인에서 편집할수록
  // 큐가 커지고 같은 값을 여러 번 보낸다.
  it("collapses repeated edits of the same record", () => {
    let queue: SyncOutboxEntry[] = [];
    for (let index = 0; index < 5; index += 1) {
      queue = enqueueSyncOutbox(queue, { kind: "hosts", id: "h1", op: "upsert" });
    }

    expect(queue).toHaveLength(1);
  });

  // 고쳤다가 지웠으면 지운 것만 밀어야 한다. 수정이 뒤에 남으면 서버가 되살린다.
  it("lets a delete replace an earlier upsert", () => {
    const queue = enqueueManySyncOutbox(
      [],
      [
        { kind: "hosts", id: "h1", op: "upsert" },
        { kind: "hosts", id: "h1", op: "delete", deletedAt: "2026-08-23T00:00:00.000Z" },
      ],
    );

    expect(queue).toEqual([
      { kind: "hosts", id: "h1", op: "delete", deletedAt: "2026-08-23T00:00:00.000Z" },
    ]);
  });

  it("keeps different kinds with the same id apart", () => {
    const queue = enqueueManySyncOutbox(
      [],
      [
        { kind: "hosts", id: "x", op: "upsert" },
        { kind: "groups", id: "x", op: "upsert" },
      ],
    );

    expect(queue).toHaveLength(2);
  });
});

describe("buildSyncOutboxPayload", () => {
  // 큐가 값을 들고 있지 않다는 것이 요점이다 — 미는 시점의 로컬 값이 나간다.
  it("rebuilds records from local state at push time", () => {
    const queue: SyncOutboxEntry[] = [{ kind: "hosts", id: "h1", op: "upsert" }];
    const { payload } = buildSyncOutboxPayload(queue, {
      ...empty,
      hosts: [host("h1", "renamed")],
    });

    expect(payload.hosts).toHaveLength(1);
    expect(payload.hosts[0]?.label).toBe("renamed");
  });

  // 큐에 들어간 뒤 지워진 레코드는 보낼 값이 없다. 삭제 항목이 따로 들어와 있다.
  it("drops an upsert whose record is gone locally", () => {
    const queue: SyncOutboxEntry[] = [{ kind: "hosts", id: "gone", op: "upsert" }];
    const { payload, drained } = buildSyncOutboxPayload(queue, empty);

    expect(payload.hosts).toHaveLength(0);
    expect(drained).toHaveLength(1);
  });

  it("carries deletions with their tombstone time", () => {
    const queue: SyncOutboxEntry[] = [
      { kind: "groups", id: "g1", op: "delete", deletedAt: "2026-08-23T01:00:00.000Z" },
    ];
    const { payload } = buildSyncOutboxPayload(queue, { ...empty, groups: [group("g2")] });

    expect(payload.deletedGroups).toEqual([
      { id: "g1", deletedAt: "2026-08-23T01:00:00.000Z" },
    ]);
  });
});

describe("secrets in the outbox", () => {
  // 자격증명은 secretRef 로 식별한다(레코드 id 가 아니다). 연결에 성공한 뒤 저장할 때
  // 호스트 레코드와 함께 큐에 실린다.
  it("rebuilds a secret from secretsByRef", () => {
    const { payload } = buildSyncOutboxPayload(
      [{ kind: "secrets", id: "secret-1", op: "upsert" }],
      {
        ...empty,
        secretsByRef: {
          "secret-1": {
            secretRef: "secret-1",
            label: "creds",
            password: "hunter2",
            updatedAt: "2026-08-23T00:00:00.000Z",
          },
        },
      },
    );

    expect(payload.secrets).toHaveLength(1);
    expect(payload.secrets[0]?.secretRef).toBe("secret-1");
  });
});

describe("removeSyncOutbox", () => {
  // 미는 동안 사용자가 또 고칠 수 있다. 그 항목까지 지우면 그 변경이 영영 안 밀린다.
  it("keeps entries queued after the push started", () => {
    const drained: SyncOutboxEntry[] = [{ kind: "hosts", id: "h1", op: "upsert" }];
    const queue = enqueueManySyncOutbox(drained, [
      { kind: "hosts", id: "h2", op: "upsert" },
    ]);

    expect(removeSyncOutbox(queue, drained)).toEqual([
      { kind: "hosts", id: "h2", op: "upsert" },
    ]);
  });
});

// 보낼 자리가 없는 삭제는 **큐에 넣을 수조차 없어야 한다.** 예전에는 넣을 수 있었고, 그
// 항목은 서버로 가지도 않은 채 큐에서 빠졌다 — 모바일에서만 지워지고 서버에는 남는다.
// 아래 줄의 주석을 풀면 컴파일이 깨진다(그게 이 시험의 내용이다).
describe('sync outbox delete safety', () => {
  it('삭제는 서버가 tombstone 을 받는 종류에만 허용된다', () => {
    const allowed: SyncOutboxEntry[] = [
      { kind: 'hosts', id: 'h1', op: 'delete', deletedAt: '2026-08-01T00:00:00.000Z' },
      { kind: 'groups', id: 'g1', op: 'delete', deletedAt: '2026-08-01T00:00:00.000Z' },
    ];
    expect(allowed).toHaveLength(2);

    // @ts-expect-error 자격증명 삭제는 보낼 자리가 없어 큐에 넣을 수 없다.
    const rejected: SyncOutboxEntry = { kind: 'secrets', id: 's1', op: 'delete' };
    // @ts-expect-error 호스트키 삭제도 마찬가지다.
    const rejectedKnownHost: SyncOutboxEntry = { kind: 'knownHosts', id: 'k1', op: 'delete' };
    expect([rejected, rejectedKnownHost]).toHaveLength(2);
  });

  // 키(`kind:id`)로 지우면 미는 동안 같은 레코드를 다시 고친 항목까지 함께 지워진다 —
  // 보낸 적이 없는데 큐에서 사라지므로 그 편집은 이 기기에만 남는다.
  it("미는 동안 다시 고친 항목은 큐에 남는다", () => {
    const first: SyncOutboxEntry = { kind: "hosts", id: "h-1", op: "upsert" };
    let queue = enqueueSyncOutbox([], first);

    // 밀기 시작(첫 항목을 들고 나간다) → 그 사이 같은 호스트를 또 고친다.
    const second: SyncOutboxEntry = { kind: "hosts", id: "h-1", op: "upsert" };
    queue = enqueueSyncOutbox(queue, second);

    // 밀기가 끝나 첫 항목만 뺀다.
    const remaining = removeSyncOutbox(queue, [first]);
    expect(remaining).toEqual([second]);
  });

  it("민 항목은 큐에서 빠진다", () => {
    const entry: SyncOutboxEntry = { kind: "hosts", id: "h-1", op: "upsert" };
    const queue = enqueueSyncOutbox([], entry);
    expect(removeSyncOutbox(queue, [entry])).toEqual([]);
  });
});
