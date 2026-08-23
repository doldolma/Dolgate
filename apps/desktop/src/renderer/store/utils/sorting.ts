import { compareGroupSiblings } from "@shared";
import type {
  ActivityLogRecord,
  DnsOverrideResolvedRecord,
  GroupRecord,
  HostRecord,
  KnownHostRecord,
  PortForwardRuleRecord,
  SecretMetadataRecord,
} from "@shared";

export function sortHosts(hosts: HostRecord[]): HostRecord[] {
  return [...hosts].sort((a, b) => {
    const groupCompare = (a.groupName ?? "").localeCompare(b.groupName ?? "");
    if (groupCompare !== 0) {
      return groupCompare;
    }
    return a.label.localeCompare(b.label);
  });
}

export function sortGroups(groups: GroupRecord[]): GroupRecord[] {
  // 형제끼리는 직접 순서(없으면 이름), 부모가 다르면 경로로 가른다 — 이 배열은 트리가 아니라
  // 저장용 평면 목록이라 부모별로 묶어 두기만 하면 된다. 화면 순서는 collectGroupPaths 가 정한다.
  return [...groups].sort((a, b) => {
    const parentCompare = (a.parentPath ?? "").localeCompare(b.parentPath ?? "");
    if (parentCompare !== 0) {
      return parentCompare;
    }
    return compareGroupSiblings(a, b);
  });
}

export function sortPortForwards(
  rules: PortForwardRuleRecord[],
): PortForwardRuleRecord[] {
  return [...rules].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
      a.label.localeCompare(b.label),
  );
}

export function sortDnsOverrides(
  overrides: DnsOverrideResolvedRecord[],
): DnsOverrideResolvedRecord[] {
  return [...overrides].sort(
    (a, b) =>
      a.hostname.localeCompare(b.hostname) ||
      (
        a.type === "linked"
          ? `linked:${a.portForwardRuleId}`
          : `static:${a.address}`
      ).localeCompare(
        b.type === "linked"
          ? `linked:${b.portForwardRuleId}`
          : `static:${b.address}`,
      ),
  );
}

export function sortKnownHosts(records: KnownHostRecord[]): KnownHostRecord[] {
  return [...records].sort(
    (a, b) => a.host.localeCompare(b.host) || a.port - b.port,
  );
}

export function sortLogs(records: ActivityLogRecord[]): ActivityLogRecord[] {
  return [...records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function sortKeychainEntries(
  entries: SecretMetadataRecord[],
): SecretMetadataRecord[] {
  return [...entries].sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.secretRef.localeCompare(b.secretRef),
  );
}
