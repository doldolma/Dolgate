import {
  normalizeJumpHostIds,
  type HostRecord,
  type SshHostRecord,
} from "@shared";
import { t } from './i18n';

export interface OpenSshExportBuild {
  content: string;
  selectedHostCount: number;
  exportedRootCount: number;
  dependencyCount: number;
  skippedCount: number;
  warnings: string[];
}

function sanitizeAlias(label: string, id: string): string {
  const sanitized = label
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return sanitized || `host-${id.replace(/-/g, "").slice(0, 8)}`;
}

function buildAliases(hosts: HostRecord[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const host of hosts) {
    const base = sanitizeAlias(host.label, host.id);
    let alias = base;
    if (used.has(alias.toLocaleLowerCase())) {
      const suffix = host.id.replace(/-/g, "").slice(0, 8) || "host";
      alias = `${base}-${suffix}`;
      let counter = 2;
      while (used.has(alias.toLocaleLowerCase())) {
        alias = `${base}-${suffix}-${counter}`;
        counter += 1;
      }
    }
    used.add(alias.toLocaleLowerCase());
    result.set(host.id, alias);
  }
  return result;
}

function formatOpenSshValue(value: string): string {
  if (/^[A-Za-z0-9._:@%+/=-]+$/.test(value)) {
    return value;
  }
  return `"${value
    .replace(/[\r\n\u0000]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function renderSshHost(host: SshHostRecord, aliases: Map<string, string>): string[] {
  const alias = aliases.get(host.id);
  if (!alias) {
    return [];
  }
  const lines = [
    `Host ${alias}`,
    `  HostName ${formatOpenSshValue(host.hostname)}`,
    `  Port ${host.port}`,
  ];
  if (host.username.trim()) {
    lines.push(`  User ${formatOpenSshValue(host.username.trim())}`);
  }
  const jumpAliases = normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)
    .map((id) => aliases.get(id))
    .filter((value): value is string => Boolean(value));
  if (jumpAliases.length > 0) {
    lines.push(`  ProxyJump ${jumpAliases.join(",")}`);
  }
  if (host.agentForwarding === true) {
    lines.push("  ForwardAgent yes");
  }
  return lines;
}

export function buildOpenSshConfig(
  allHosts: HostRecord[],
  requestedHostIds: string[],
): OpenSshExportBuild {
  const hostsById = new Map(allHosts.map((host) => [host.id, host]));
  const selectedIds = [...new Set(requestedHostIds)];
  const acceptedRootIds: string[] = [];
  const includedIds = new Set<string>();
  const warnings: string[] = [];

  const collectSshDependencies = (
    host: SshHostRecord,
    collected: Set<string>,
    visiting: Set<string>,
  ): string | null => {
    if (visiting.has(host.id)) {
      return t('opensshExport.jumpCycle', { label: host.label });
    }
    visiting.add(host.id);
    for (const jumpHostId of normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)) {
      const jumpHost = hostsById.get(jumpHostId);
      if (!jumpHost) {
        return t('opensshExport.jumpMissing', { label: host.label });
      }
      if (jumpHost.kind !== "ssh") {
        return t('opensshExport.jumpUnsupported', { label: host.label });
      }
      const nestedError = collectSshDependencies(jumpHost, collected, visiting);
      if (nestedError) {
        return nestedError;
      }
      collected.add(jumpHost.id);
    }
    visiting.delete(host.id);
    collected.add(host.id);
    return null;
  };

  for (const hostId of selectedIds) {
    const host = hostsById.get(hostId);
    if (!host) {
      warnings.push(t('opensshExport.hostMissing', { id: hostId }));
      continue;
    }
    if (host.kind !== "ssh" && host.kind !== "warpgate-ssh") {
      warnings.push(t('opensshExport.kindUnsupported', { label: host.label, kind: host.kind }));
      continue;
    }
    const collected = new Set<string>();
    const error =
      host.kind === "ssh"
        ? collectSshDependencies(host, collected, new Set<string>())
        : null;
    if (error) {
      warnings.push(error);
      continue;
    }
    if (host.kind === "warpgate-ssh") {
      collected.add(host.id);
    }
    acceptedRootIds.push(host.id);
    for (const id of collected) {
      includedIds.add(id);
    }
  }

  const acceptedRootIdSet = new Set(acceptedRootIds);
  const includedHosts = [...includedIds]
    .map((id) => hostsById.get(id))
    .filter((host): host is HostRecord => Boolean(host))
    .sort((left, right) => {
      const leftRoot = acceptedRootIdSet.has(left.id) ? 1 : 0;
      const rightRoot = acceptedRootIdSet.has(right.id) ? 1 : 0;
      return leftRoot - rightRoot || left.label.localeCompare(right.label);
    });
  const aliases = buildAliases(includedHosts);
  const blocks = includedHosts.map((host) => {
    if (host.kind === "ssh") {
      return renderSshHost(host, aliases).join("\n");
    }
    if (host.kind === "warpgate-ssh") {
      const alias = aliases.get(host.id) ?? sanitizeAlias(host.label, host.id);
      return [
        `Host ${alias}`,
        `  HostName ${formatOpenSshValue(host.warpgateSshHost)}`,
        `  Port ${host.warpgateSshPort}`,
        `  User ${formatOpenSshValue(`${host.warpgateUsername}:${host.warpgateTargetName}`)}`,
        "  PreferredAuthentications keyboard-interactive",
      ].join("\n");
    }
    return "";
  });

  return {
    content: blocks.filter(Boolean).join("\n\n") + (blocks.length > 0 ? "\n" : ""),
    selectedHostCount: selectedIds.length,
    exportedRootCount: acceptedRootIds.length,
    dependencyCount: [...includedIds].filter((id) => !acceptedRootIdSet.has(id)).length,
    skippedCount: selectedIds.length - acceptedRootIds.length,
    warnings,
  };
}
