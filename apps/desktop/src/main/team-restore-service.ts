import { isDeepStrictEqual } from "node:util";
import {
  canManageTeam,
  isKnownHostKind,
  normalizeSavedWorkspaceRecord,
  type DnsOverrideRecord,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type ManagedAwsProfilePayload,
  type ManagedSecretPayload,
  type PortForwardRuleRecord,
  type SavedWorkspaceNode,
  type SavedWorkspaceRecord,
  type SnippetRecord,
  type TailnetPayload,
  type TeamChangeItem,
  type TeamChangeRef,
  type TeamChangeSet,
  type TeamChangesPage,
  type TeamRecordKind,
  type TeamRestoreOutcome,
  type TeamRestoreOverwrite,
  type TeamRestoreSkipped,
  type TeamRestoredRecord,
} from "@shared";
import { t } from "./i18n";
import { getDesktopStateStorage } from "./state-storage";
import { decodeEncryptedPayload } from "./sync-service";
import type { RawTeamRecordVersion, TeamApi } from "./team-api";
import type { TeamAccess } from "./team-history-service";
import { stripHostMemberPrefs, stripWorkspaceMemberPrefs } from "./team-member-prefs";
import { forEachTeamRecord, toStoredTeamRecords, type TeamRecordSet } from "./team-sync-service";
import { createTeamVaultScope } from "./team-vault-scope";
import type { VaultScope } from "./vault-catalog";
import { listHostReferences, type VaultReferenceKind } from "./vault-references";

/*
 * 팀 볼트의 바뀐 것과 복원. 서버는 팀 레코드가 덮어쓰이거나 지워질 때 이전 판을 암호문 그대로 남긴다(90일). 그 판을
 * 팀 키로 풀어 "한 번에 올라간 변경"으로 묶어 보이고, 복원은 그 판들을 지금 시각의 새 판으로 팀 볼트에 다시 써서
 * 보통 올리기로 올린다 — 서버에 따로 되살리는 길은 없다.
 *
 * - 묶음: 같은 사람·같은 시각(밀어낸 올리기)의 판들. 한 올리기는 팀 행을 잠그고 쓰므로 순번이 이어진다.
 * - 지웠는지 고쳤는지는 서버가 판마다 적는다(deleted). 지운 표시는 빈 암호문이라 판으로 남지 않는다.
 * - 딸린 것: 복원하는 것이 가리키는데 지워진 것(비밀번호·점프 호스트·tailnet·AWS 프로필·시작 스니펫, 포워딩의
 *   호스트, DNS 의 포워딩, Workspace 의 호스트)은 그 마지막 판을 함께 되살린다. 앱의 지우기가 호스트와 비밀번호를
 *   두 번에 나눠 올려도 일부만 돌아오지 않게 하려는 것이다. 그룹은 경로로 이어지므로 호스트가 돌아오면 따라온다.
 * - 덮기: 그 뒤에 다시 바뀐 레코드를 복원하면 그 변경을 덮는다 — 그때만 화면이 묻는다(needs-confirm).
 */

/** 한 번에 받는 판 수(서버 상한). */
const VERSION_PAGE = 500;
/** 목록 한 번에 채우려는 묶음 수. */
const SETS_PER_PAGE = 30;
/** 한 번에 받는 쪽 수의 상한 — 큰 묶음 하나가 여러 쪽에 걸쳐도 끝까지 받되, 끝없이 돌지는 않는다. */
const MAX_PAGES = 100;

const RECORD_KINDS: ReadonlySet<string> = new Set<TeamRecordKind>([
  "groups",
  "hosts",
  "knownHosts",
  "portForwards",
  "dnsOverrides",
  "snippets",
  "workspaces",
  "tailnets",
  "awsProfiles",
  "secrets",
]);

/** 견줄 때 빼는 칸 — 내용이 아니라 쓴 때다. */
const VOLATILE_FIELDS = new Set(["updatedAt", "lastSeenAt"]);

type DesktopStateStorage = ReturnType<typeof getDesktopStateStorage>;
type RecordValue = Record<string, unknown>;

export interface TeamRestoreServiceOptions {
  api: Pick<TeamApi, "listRecordVersions">;
  /** 그 팀이 열려 있으면 키와 요청 권한(팀 동기화의 openTeamAccess). */
  openTeamAccess(teamId: string): TeamAccess | null;
  /** 되살린 레코드에 붙일 시각(팀 동기화의 writeTimeAfterServer). */
  writeTime(teamId: string, records: ReadonlyArray<{ kind: string; id: string }>): string;
  /**
   * 다 쓴 뒤 — 기록을 남기고 팀에 올린다. 올리기를 기다린 뒤 돌아가야 화면이 다시 받은 목록에 덮인 판(새 묶음)이
   * 보인다.
   */
  onRestored(teamId: string, outcome: Extract<TeamRestoreOutcome, { status: "restored" }>): void | Promise<void>;
  storage?: DesktopStateStorage;
  /** 시험용. */
  createScope?: (teamId: string) => Omit<VaultScope, "id">;
}

/** 판 하나 — 풀었으면 값이 있다. */
interface Version {
  raw: RawTeamRecordVersion;
  kind: TeamRecordKind;
  value: RecordValue | null;
}

function recordKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

function isRecordKind(kind: string): kind is TeamRecordKind {
  return RECORD_KINDS.has(kind);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** 그 판의 이름 — 화면이 종류와 함께 보인다. */
export function labelOfTeamRecord(kind: TeamRecordKind, value: RecordValue | null): string | null {
  if (!value) {
    return null;
  }
  switch (kind) {
    case "groups":
      return text(value.path) ?? text(value.name);
    case "knownHosts":
      return text(value.host) ? `${String(value.host)}:${String(value.port ?? 22)}` : null;
    case "dnsOverrides":
      return text(value.hostname);
    case "workspaces":
    case "awsProfiles":
      return text(value.name);
    default:
      return text(value.label);
  }
}

/** 견줄 모양 — 쓴 때를 빼고, 비운 칸(null·undefined)은 없는 것으로 본다(앱 판마다 비운 칸을 싣기도 안 싣기도 한다). */
function comparable(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const plain = withoutEmptyFields(JSON.parse(JSON.stringify(value))) as RecordValue;
  for (const field of VOLATILE_FIELDS) {
    delete plain[field];
  }
  return plain;
}

function withoutEmptyFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutEmptyFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, withoutEmptyFields(field)]),
  );
}

export function sameTeamRecordContent(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(comparable(left), comparable(right));
}

/** 같은 사람·같은 시각으로 이어진 판들을 묶는다(최신부터). */
function groupRuns(versions: readonly Version[]): Version[][] {
  const runs: Version[][] = [];
  for (const version of versions) {
    const last = runs[runs.length - 1];
    if (last && last[0].raw.changedBy === version.raw.changedBy && last[0].raw.changedAt === version.raw.changedAt) {
      last.push(version);
    } else {
      runs.push([version]);
    }
  }
  return runs;
}

/** 레코드가 가리키는 다른 팀 레코드 — 복원할 때 지워져 있으면 함께 되살린다. 그룹은 경로로 이어져 빠진다. */
export function teamRecordReferences(kind: TeamRecordKind, value: RecordValue): Array<{ kind: TeamRecordKind; id: string }> {
  const references: Array<{ kind: TeamRecordKind; id: string }> = [];
  const add = (target: TeamRecordKind, id: unknown) => {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed) {
      references.push({ kind: target, id: trimmed });
    }
  };
  if (kind === "hosts") {
    const kindOf: Record<VaultReferenceKind, TeamRecordKind> = {
      jumpHost: "hosts",
      tunnelHost: "hosts",
      tailnet: "tailnets",
      awsProfile: "awsProfiles",
      snippet: "snippets",
      secret: "secrets",
    };
    for (const reference of listHostReferences(value as unknown as HostRecord)) {
      add(kindOf[reference.kind], reference.id);
    }
  } else if (kind === "portForwards") {
    add("hosts", value.hostId);
  } else if (kind === "dnsOverrides" && value.type === "linked") {
    add("portForwards", value.portForwardRuleId);
  } else if (kind === "workspaces") {
    const walk = (node: SavedWorkspaceNode | undefined) => {
      if (!node) {
        return;
      }
      if (node.kind === "leaf") {
        if (node.target.kind === "host") {
          add("hosts", node.target.hostId);
        }
        return;
      }
      walk(node.first);
      walk(node.second);
    };
    walk((value as unknown as SavedWorkspaceRecord).root);
  }
  return references;
}

export class TeamRestoreService {
  private readonly api: TeamRestoreServiceOptions["api"];
  private readonly openTeamAccess: TeamRestoreServiceOptions["openTeamAccess"];
  private readonly writeTime: TeamRestoreServiceOptions["writeTime"];
  private readonly onRestored: TeamRestoreServiceOptions["onRestored"];
  private readonly storage: DesktopStateStorage;
  private readonly createScope: (teamId: string) => Omit<VaultScope, "id">;
  /**
   * 목록을 위에서부터 받는 동안 이미 본(더 새) 레코드 — 더 보기로 받은 오래된 묶음의 "그 뒤에 다시 바뀜"을 가른다.
   * 처음부터 다시 받으면 비운다. 복원은 이것을 믿지 않고 서버에서 다시 본다.
   */
  private readonly newerSeen = new Map<string, Set<string>>();

  constructor(options: TeamRestoreServiceOptions) {
    this.api = options.api;
    this.openTeamAccess = options.openTeamAccess;
    this.writeTime = options.writeTime;
    this.onRestored = options.onRestored;
    this.storage = options.storage ?? getDesktopStateStorage();
    this.createScope = options.createScope ?? createTeamVaultScope;
  }

  /** 관리자 이상. 바뀐 것을 한 번에 올라간 묶음으로, 최신부터. */
  async listChanges(teamId: string, query: { before?: number } = {}): Promise<TeamChangesPage> {
    const access = this.requireAccess(teamId);
    const fetched: RawTeamRecordVersion[] = [];
    let before = query.before && query.before > 0 ? query.before : undefined;
    let exhausted = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const versions = await this.api.listRecordVersions(access.lease, teamId, { before, limit: VERSION_PAGE });
      fetched.push(...versions);
      if (versions.length < VERSION_PAGE) {
        exhausted = true;
        break;
      }
      before = versions[versions.length - 1].seq;
      // 끝 묶음은 다음 쪽에 이어질 수 있다 — 그것을 빼고도 채웠으면 그친다.
      if (groupRuns(fetched.map((raw) => ({ raw }) as Version)).length > SETS_PER_PAGE) {
        break;
      }
    }
    const runs = groupRuns(fetched.filter((raw) => isRecordKind(raw.kind)).map((raw) => this.decode(raw, access)));
    if (!exhausted && runs.length > 1) {
      runs.pop();
    }
    // 묶음 안은 그 올리기가 쓴 순서로(그룹이 호스트보다 먼저 온다).
    for (const run of runs) {
      run.reverse();
    }

    const current = await this.currentRecords(teamId);
    let seen = this.newerSeen.get(teamId);
    if (!query.before || !seen) {
      seen = new Set();
      this.newerSeen.set(teamId, seen);
    }

    const sets = runs.map((run): TeamChangeSet => {
      const items = run.map((version): TeamChangeItem => {
        const now = current.get(recordKey(version.kind, version.raw.recordId));
        const label = labelOfTeamRecord(version.kind, version.value);
        const currentLabel = now ? labelOfTeamRecord(version.kind, now as RecordValue) : null;
        return {
          kind: version.kind,
          recordId: version.raw.recordId,
          label,
          deleted: version.raw.deleted === true,
          currentLabel: version.raw.deleted !== true && currentLabel && currentLabel !== label ? currentLabel : null,
        };
      });
      const changedLater = run.some((version) => {
        const key = recordKey(version.kind, version.raw.recordId);
        const now = current.get(key);
        return (
          seen.has(key) ||
          (version.raw.deleted === true && now !== undefined && !sameTeamRecordContent(version.value, now))
        );
      });
      const restored = run.every((version) => {
        const now = current.get(recordKey(version.kind, version.raw.recordId));
        return version.value !== null && now !== undefined && sameTeamRecordContent(version.value, now);
      });
      for (const version of run) {
        seen.add(recordKey(version.kind, version.raw.recordId));
      }
      return {
        firstSeq: run[0].raw.seq,
        lastSeq: run[run.length - 1].raw.seq,
        changedBy: run[0].raw.changedBy,
        changedByEmail: run[0].raw.changedByEmail,
        changedAt: run[0].raw.changedAt,
        items,
        changedLater,
        restored,
      };
    });
    if (exhausted) {
      return { sets, nextBefore: null };
    }
    // 다음은 남긴 묶음 바로 아래부터 — 빼낸 끝 묶음을 통째로 다시 받는다.
    return { sets, nextBefore: sets[sets.length - 1]?.firstSeq ?? before ?? null };
  }

  /**
   * 관리자 이상. 그 묶음의 판들(과 딸린 것)을 지금 것으로 다시 쓴다. 남이 그 뒤에 바꾼 것을 덮게 되면 overwrite 없이는
   * 쓰지 않고 그 목록을 돌려준다.
   */
  async restoreChange(teamId: string, ref: TeamChangeRef, options: { overwrite?: boolean } = {}): Promise<TeamRestoreOutcome> {
    const access = this.requireAccess(teamId);
    const versions = await this.fetchChange(access, teamId, ref);
    const current = await this.currentRecords(teamId);

    const skipped: TeamRestoreSkipped[] = [];
    const wanted: Version[] = [];
    for (const version of versions) {
      if (!version.value) {
        skipped.push({ ...this.describe(version), reason: "unreadable" });
        continue;
      }
      const now = current.get(recordKey(version.kind, version.raw.recordId));
      // 이미 지금과 같은 것은 쓸 것이 없다.
      if (now === undefined || !sameTeamRecordContent(version.value, now)) {
        wanted.push(version);
      }
    }

    if (!options.overwrite) {
      const overwrites = await this.findOverwrites(access, teamId, ref, wanted, current);
      if (overwrites.length > 0) {
        return { status: "needs-confirm", overwrites };
      }
    }

    const dependencies = await this.collectDependencies(access, teamId, wanted, current);
    const taken = this.storage.collectRecordIdsOutsideTeam(teamId);
    const isTaken = (version: Version) => {
      const sets: Partial<Record<TeamRecordKind, Set<string>>> = {
        groups: taken.groups,
        hosts: taken.hosts,
        knownHosts: taken.knownHosts,
        portForwards: taken.portForwards,
        dnsOverrides: taken.dnsOverrides,
        snippets: taken.snippets,
        workspaces: taken.savedWorkspaces,
        tailnets: taken.tailnets,
        awsProfiles: taken.awsProfiles,
        secrets: taken.secretMetadata,
      };
      return sets[version.kind]?.has(version.raw.recordId) ?? false;
    };
    // 이 빌드가 모르는 호스트 종류는 담지 않는다(받을 때와 같은 이유).
    const skipReason = (version: Version): TeamRestoreSkipped["reason"] | null =>
      isTaken(version)
        ? "other-vault"
        : version.kind === "hosts" && !isKnownHostKind((version.value as RecordValue).kind)
          ? "unreadable"
          : null;
    const restored = wanted.filter((version) => skipReason(version) === null);
    const withDependencies = dependencies.filter((version) => skipReason(version) === null);
    for (const version of [...wanted, ...dependencies]) {
      const reason = skipReason(version);
      if (reason) {
        skipped.push({ ...this.describe(version), reason });
      }
    }

    const writes = [...restored, ...withDependencies];
    if (writes.length > 0) {
      this.write(teamId, writes);
    }
    const outcome = {
      status: "restored" as const,
      restored: restored.map((version) => this.describe(version)),
      dependencies: withDependencies.map((version) => this.describe(version)),
      skipped,
    };
    if (writes.length > 0) {
      await this.onRestored(teamId, outcome);
    }
    return outcome;
  }

  /** 팀이 열려 있고 관리자 이상인지. 아니면 던진다(서버도 막는다). */
  private requireAccess(teamId: string): TeamAccess {
    const role = this.storage.getTeamState(teamId)?.info.role;
    if (!role || !canManageTeam(role)) {
      throw new Error(t("teams.api.adminOnly"));
    }
    const access = this.openTeamAccess(teamId);
    if (!access) {
      throw new Error(t("teams.needsUnlockedVault"));
    }
    return access;
  }

  private decode(raw: RawTeamRecordVersion, access: TeamAccess): Version {
    const kind = raw.kind as TeamRecordKind;
    try {
      const value = decodeEncryptedPayload<RecordValue>(raw.encryptedPayload, access.teamKeyBase64);
      return { raw, kind, value: value && typeof value === "object" ? value : null };
    } catch {
      return { raw, kind, value: null };
    }
  }

  private describe(version: Version): TeamRestoredRecord {
    return { kind: version.kind, recordId: version.raw.recordId, label: labelOfTeamRecord(version.kind, version.value) };
  }

  /** 그 묶음의 판들. 보존 기간이 지나 없어졌으면 던진다. */
  private async fetchChange(access: TeamAccess, teamId: string, ref: TeamChangeRef): Promise<Version[]> {
    const found: RawTeamRecordVersion[] = [];
    let before = ref.lastSeq + 1;
    for (let page = 0; page < MAX_PAGES && before > ref.firstSeq; page += 1) {
      const limit = Math.min(VERSION_PAGE, before - ref.firstSeq);
      const versions = await this.api.listRecordVersions(access.lease, teamId, { before, limit });
      for (const raw of versions) {
        if (raw.seq >= ref.firstSeq && raw.changedBy === ref.changedBy && raw.changedAt === ref.changedAt) {
          found.push(raw);
        }
      }
      if (versions.length < limit) {
        break;
      }
      before = versions[versions.length - 1].seq;
    }
    const known = found.filter((raw) => isRecordKind(raw.kind)).sort((left, right) => left.seq - right.seq);
    if (known.length === 0) {
      throw new Error(t("teams.restoreGone"));
    }
    return known.map((raw) => this.decode(raw, access));
  }

  /**
   * 복원하면 덮게 되는 그 뒤의 변경. 그 묶음보다 새 판이 있는 레코드(누가 그 뒤에 고치거나 지웠다)와, 지운 것인데 그 뒤
   * 다시 만들어진 레코드다. 새 판은 위에서부터 그 묶음까지 훑어 찾는다 — 목록 화면이 본 것은 믿지 않는다.
   */
  private async findOverwrites(
    access: TeamAccess,
    teamId: string,
    ref: TeamChangeRef,
    wanted: readonly Version[],
    current: ReadonlyMap<string, unknown>,
  ): Promise<TeamRestoreOverwrite[]> {
    if (wanted.length === 0) {
      return [];
    }
    const keys = new Set(wanted.map((version) => recordKey(version.kind, version.raw.recordId)));
    const latestLater = new Map<string, RawTeamRecordVersion>();
    let before: number | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const versions = await this.api.listRecordVersions(access.lease, teamId, { before, limit: VERSION_PAGE });
      for (const raw of versions) {
        const key = recordKey(raw.kind, raw.recordId);
        if (raw.seq > ref.lastSeq && keys.has(key) && !latestLater.has(key)) {
          latestLater.set(key, raw);
        }
      }
      const oldest = versions[versions.length - 1]?.seq;
      if (versions.length < VERSION_PAGE || oldest === undefined || oldest <= ref.lastSeq) {
        break;
      }
      before = oldest;
    }
    const overwrites: TeamRestoreOverwrite[] = [];
    for (const version of wanted) {
      const key = recordKey(version.kind, version.raw.recordId);
      const later = latestLater.get(key);
      const recreated = version.raw.deleted === true && current.has(key);
      if (later || recreated) {
        overwrites.push({
          ...this.describe(version),
          byEmail: later?.changedByEmail ?? null,
          at: later?.changedAt ?? null,
        });
      }
    }
    return overwrites;
  }

  /** 복원하는 것이 가리키는데 지금 없는 것 — 그 마지막 판을 함께 되살린다(그것이 가리키는 것까지). */
  private async collectDependencies(
    access: TeamAccess,
    teamId: string,
    wanted: readonly Version[],
    current: ReadonlyMap<string, unknown>,
  ): Promise<Version[]> {
    const planned = new Set(wanted.map((version) => recordKey(version.kind, version.raw.recordId)));
    const dependencies: Version[] = [];
    const queue = [...wanted];
    while (queue.length > 0) {
      const version = queue.shift() as Version;
      if (!version.value) {
        continue;
      }
      for (const reference of teamRecordReferences(version.kind, version.value)) {
        const key = recordKey(reference.kind, reference.id);
        if (planned.has(key) || current.has(key)) {
          continue;
        }
        planned.add(key);
        const [latest] = await this.api.listRecordVersions(access.lease, teamId, {
          kind: reference.kind,
          recordId: reference.id,
          limit: 1,
        });
        if (!latest) {
          // 판이 없다 — 팀에 있던 적이 없거나 보존 기간이 지났다. 가리키는 것은 지금처럼 비어 있다.
          continue;
        }
        const dependency = this.decode(latest, access);
        if (dependency.value) {
          dependencies.push(dependency);
          queue.push(dependency);
        }
      }
    }
    return dependencies;
  }

  /** 팀 볼트의 지금 레코드(올리는 모양). */
  private async currentRecords(teamId: string): Promise<Map<string, unknown>> {
    const current = new Map<string, unknown>();
    await forEachTeamRecord(this.createScope(teamId), (kind, id, _updatedAt, value) => {
      current.set(recordKey(kind, id), value);
    });
    return current;
  }

  /** 판들을 지금 시각의 새 판으로 팀 볼트에 쓴다. 올리기는 onRestored 가 건다. */
  private write(teamId: string, versions: readonly Version[]): void {
    const updatedAt = this.writeTime(
      teamId,
      versions.map((version) => ({ kind: version.kind, id: version.raw.recordId })),
    );
    const set: TeamRecordSet = {
      groups: [],
      hosts: [],
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      snippets: [],
      savedWorkspaces: [],
      tailnets: [],
      awsProfiles: [],
      secrets: [],
    };
    for (const version of versions) {
      const value = { ...(version.value as RecordValue), updatedAt };
      switch (version.kind) {
        case "groups":
          set.groups.push(value as unknown as GroupRecord);
          break;
        case "hosts":
          set.hosts.push(stripHostMemberPrefs(value as unknown as HostRecord));
          break;
        case "knownHosts":
          set.knownHosts.push(value as unknown as KnownHostRecord);
          break;
        case "portForwards":
          set.portForwards.push(value as unknown as PortForwardRuleRecord);
          break;
        case "dnsOverrides":
          set.dnsOverrides.push(value as unknown as DnsOverrideRecord);
          break;
        case "snippets":
          set.snippets.push(value as unknown as SnippetRecord);
          break;
        case "workspaces": {
          const workspace = normalizeSavedWorkspaceRecord(value);
          if (workspace) {
            set.savedWorkspaces.push(stripWorkspaceMemberPrefs(workspace));
          }
          break;
        }
        case "tailnets":
          set.tailnets.push(value as unknown as TailnetPayload);
          break;
        case "awsProfiles":
          set.awsProfiles.push(value as unknown as ManagedAwsProfilePayload);
          break;
        case "secrets":
          set.secrets.push(value as unknown as ManagedSecretPayload);
          break;
      }
    }
    this.storage.restoreTeamRecords(
      teamId,
      toStoredTeamRecords(set, this.storage.getTeamState(teamId)?.secure),
      versions.map((version) => ({ kind: version.kind, recordId: version.raw.recordId })),
    );
  }
}
