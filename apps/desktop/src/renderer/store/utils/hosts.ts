import {
  getParentGroupPath,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isGroupWithinPath,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  normalizeGroupPath,
  rebaseGroupPath,
  stripRemovedGroupSegment,
} from "@shared";
import type { GroupRemoveMode, HostDraft, HostRecord, HostSecretInput } from "@shared";

export function toHostDraft(record: HostRecord, label: string): HostDraft {
  if (isAwsEc2HostRecord(record)) {
    return {
      kind: "aws-ec2",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      awsProfileId: record.awsProfileId ?? null,
      awsProfileName: record.awsProfileName,
      awsRegion: record.awsRegion,
      awsInstanceId: record.awsInstanceId,
      awsAvailabilityZone: record.awsAvailabilityZone ?? null,
      awsInstanceName: record.awsInstanceName ?? null,
      awsPlatform: record.awsPlatform ?? null,
      awsPrivateIp: record.awsPrivateIp ?? null,
      awsState: record.awsState ?? null,
      awsSshUsername: record.awsSshUsername ?? null,
      awsSshPort: record.awsSshPort ?? null,
      awsSshMetadataStatus: record.awsSshMetadataStatus ?? null,
      awsSshMetadataError: record.awsSshMetadataError ?? null,
    };
  }

  if (isWarpgateSshHostRecord(record)) {
    return {
      kind: "warpgate-ssh",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      warpgateBaseUrl: record.warpgateBaseUrl,
      warpgateSshHost: record.warpgateSshHost,
      warpgateSshPort: record.warpgateSshPort,
      warpgateTargetId: record.warpgateTargetId,
      warpgateTargetName: record.warpgateTargetName,
      warpgateUsername: record.warpgateUsername,
    };
  }

  if (isAwsEcsHostRecord(record)) {
    return {
      kind: "aws-ecs",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      awsProfileId: record.awsProfileId ?? null,
      awsProfileName: record.awsProfileName,
      awsRegion: record.awsRegion,
      awsEcsClusterArn: record.awsEcsClusterArn,
      awsEcsClusterName: record.awsEcsClusterName,
    };
  }

  if (record.kind === "serial") {
    return {
      kind: "serial",
      label,
      groupName: record.groupName ?? null,
      tags: record.tags ?? [],
      terminalThemeId: record.terminalThemeId ?? null,
      transport: record.transport,
      devicePath: record.devicePath ?? null,
      host: record.host ?? null,
      port: record.port ?? null,
      baudRate: record.baudRate,
      dataBits: record.dataBits,
      parity: record.parity,
      stopBits: record.stopBits,
      flowControl: record.flowControl,
      transmitLineEnding: record.transmitLineEnding,
      localEcho: record.localEcho,
      localLineEditing: record.localLineEditing,
    };
  }

  return {
    kind: "ssh",
    label,
    hostname: record.hostname,
    port: record.port,
    username: record.username,
    authType: record.authType,
    privateKeyPath: null,
    certificatePath: null,
    secretRef: record.secretRef ?? null,
    jumpHostId: record.jumpHostId ?? null,
    groupName: record.groupName ?? null,
    tags: record.tags ?? [],
    terminalThemeId: record.terminalThemeId ?? null,
    startupCommand: record.startupCommand ?? null,
    useMosh: record.useMosh ?? null,
    agentForwarding: record.agentForwarding ?? null,
  };
}

export function findSshHostMissingUsername(
  hosts: HostRecord[],
  hostId: string,
): Extract<HostRecord, { kind: "ssh" }> | null {
  const host = hosts.find((item) => item.id === hostId);
  return host && isSshHostRecord(host) && !host.username.trim() ? host : null;
}

export function getDuplicateHostBaseLabel(label: string): string {
  const match = label.match(/^(.*?)(?: Copy(?: (\d+))?)?$/);
  const base = match?.[1]?.trim();
  return base && base.length > 0 ? base : label;
}

export function buildDuplicateHostLabel(
  record: HostRecord,
  hosts: HostRecord[],
): string {
  const baseLabel = getDuplicateHostBaseLabel(record.label);
  const groupPath = normalizeGroupPath(record.groupName);
  const labelsInGroup = new Set(
    hosts
      .filter((host) => normalizeGroupPath(host.groupName) === groupPath)
      .map((host) => host.label),
  );

  const firstCopyLabel = `${baseLabel} Copy`;
  if (!labelsInGroup.has(firstCopyLabel)) {
    return firstCopyLabel;
  }

  let suffix = 2;
  while (labelsInGroup.has(`${baseLabel} Copy ${suffix}`)) {
    suffix += 1;
  }
  return `${baseLabel} Copy ${suffix}`;
}

export function normalizeTagValue(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

export function matchesSelectedTags(
  host: HostRecord,
  selectedTags: string[],
): boolean {
  if (selectedTags.length === 0) {
    return true;
  }
  const hostTags = host.tags ?? [];
  if (hostTags.length === 0) {
    return false;
  }
  const normalizedHostTags = new Set(hostTags.map(normalizeTagValue));
  return selectedTags.some((tag) =>
    normalizedHostTags.has(normalizeTagValue(tag)),
  );
}

export function hasProvidedSecrets(secrets?: HostSecretInput): boolean {
  return Boolean(
    secrets?.password || secrets?.passphrase || secrets?.privateKeyPem,
  );
}

export function parentPath(targetPath: string): string {
  if (!targetPath || targetPath === "/") {
    return targetPath || "/";
  }
  const normalized =
    targetPath.length > 1 && targetPath.endsWith("/")
      ? targetPath.slice(0, -1)
      : targetPath;
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index) || "/";
}

export function resolveCurrentGroupPathAfterGroupRemoval(
  currentGroupPath: string | null,
  removedGroupPath: string,
  mode: GroupRemoveMode,
): string | null {
  const normalizedCurrentPath = normalizeGroupPath(currentGroupPath);
  const normalizedRemovedPath = normalizeGroupPath(removedGroupPath);
  if (
    !normalizedCurrentPath ||
    !normalizedRemovedPath ||
    !isGroupWithinPath(normalizedCurrentPath, normalizedRemovedPath)
  ) {
    return normalizedCurrentPath;
  }

  if (mode === "delete-subtree") {
    return getParentGroupPath(normalizedRemovedPath);
  }

  return stripRemovedGroupSegment(normalizedCurrentPath, normalizedRemovedPath);
}

export function resolveCurrentGroupPathAfterGroupMutation(
  currentGroupPath: string | null,
  previousGroupPath: string,
  nextGroupPath: string,
): string | null {
  return rebaseGroupPath(currentGroupPath, previousGroupPath, nextGroupPath);
}
