import { randomUUID } from 'node:crypto';
import { getGroupLabel, getParentGroupPath, normalizeGroupPath } from '@shared';
import type { HostSecretInput, TermiusImportResult, TermiusImportSelectionInput, TermiusImportWarning } from '@shared';
import type { ActivityLogRepository, GroupRepository, HostRepository, SecretMetadataRepository } from './database';
import {
  buildTermiusEntityKey,
  buildTermiusGroupAncestorPaths,
  collectSelectedTermiusGroupPaths,
  collectSelectedTermiusHosts,
  resolveTermiusCredential,
  resolveTermiusHostPort,
  resolveTermiusHostUsername,
  type TermiusSnapshot,
} from './termius-import-service';

export interface TermiusImportExecutorContext {
  groups: GroupRepository;
  hosts: HostRepository;
  activityLogs: ActivityLogRepository;
  secretMetadata: SecretMetadataRepository;
  persistSecret: (label: string, secrets: HostSecretInput) => Promise<string | null>;
  queueSync: () => void;
}

export async function importTermiusSelection(
  snapshot: TermiusSnapshot,
  input: TermiusImportSelectionInput,
  context: TermiusImportExecutorContext,
): Promise<TermiusImportResult> {
  const selectedHosts = collectSelectedTermiusHosts(snapshot, input);
  const selectedGroupPaths = collectSelectedTermiusGroupPaths(snapshot, input);
  const existingGroupPaths = new Set(context.groups.list().map((group) => group.path));
  const sharedSecretRefs = new Map<string, string>();
  const warnings: TermiusImportWarning[] = [
    ...(snapshot.bundle.meta?.warnings ?? []).map((message) => ({
      message,
    })),
  ];

  let createdGroupCount = 0;
  let createdHostCount = 0;
  let createdSecretCount = 0;
  let skippedHostCount = 0;

  for (const groupPath of selectedGroupPaths) {
    for (const candidatePath of buildTermiusGroupAncestorPaths(groupPath)) {
      if (existingGroupPaths.has(candidatePath)) {
        continue;
      }
      const group = context.groups.create(
        randomUUID(),
        getGroupLabel(candidatePath),
        getParentGroupPath(candidatePath),
      );
      existingGroupPaths.add(group.path);
      createdGroupCount += 1;
    }
  }

  for (const host of selectedHosts) {
    const label = host.name?.trim() || host.address?.trim() || 'Imported Host';
    const hostname = host.address?.trim();
    const port = resolveTermiusHostPort(host);
    const username = resolveTermiusHostUsername(host);
    const groupPath = normalizeGroupPath(host.groupPath);
    const hostKey = buildTermiusEntityKey(
      host.id,
      host.localId,
      `${label}|${host.address ?? ''}|${host.groupPath ?? ''}`,
    );

    if (!hostname || !port) {
      warnings.push({
        code: 'missing-required-fields',
        message: `${label}: address 또는 port가 없어 건너뛰었습니다.`,
      });
      skippedHostCount += 1;
      continue;
    }

    if (!username) {
      warnings.push({
        code: 'missing-username',
        message: `${label}: 사용자명이 없어 가져왔지만, 첫 연결 전에 입력이 필요합니다.`,
      });
    }

    for (const candidatePath of buildTermiusGroupAncestorPaths(groupPath)) {
      if (existingGroupPaths.has(candidatePath)) {
        continue;
      }
      context.groups.create(
        randomUUID(),
        getGroupLabel(candidatePath),
        getParentGroupPath(candidatePath),
      );
      existingGroupPaths.add(candidatePath);
      createdGroupCount += 1;
    }

    const credential = resolveTermiusCredential(host);
    let secretRef: string | null = null;

    if (credential.hasCredential) {
      const sharedSecretKey = credential.sharedSecretKey ?? `host:${hostKey}`;
      const cachedSecretRef = sharedSecretRefs.get(sharedSecretKey);
      if (cachedSecretRef) {
        secretRef = cachedSecretRef;
      } else {
        secretRef = await context.persistSecret(
          credential.sharedSecretLabel,
          credential.secrets,
        );
        if (secretRef) {
          sharedSecretRefs.set(sharedSecretKey, secretRef);
          createdSecretCount += 1;
        }
      }
    } else {
      warnings.push({
        code: 'missing-credentials',
        message: `${label}: 저장 가능한 credential이 없어 비밀번호 없이 호스트만 가져왔습니다.`,
      });
    }

    context.hosts.create(
      randomUUID(),
      {
        kind: 'ssh',
        label,
        groupName: groupPath,
        tags: [],
        terminalThemeId: null,
        hostname,
        port,
        username: username ?? '',
        authType: credential.authType,
        privateKeyPath: null,
      },
      secretRef,
    );
    createdHostCount += 1;
  }

  if (createdGroupCount > 0 || createdHostCount > 0 || createdSecretCount > 0) {
    context.activityLogs.append('info', 'audit', 'Termius 로컬 데이터를 가져왔습니다.', {
      createdGroupCount,
      createdHostCount,
      createdSecretCount,
      skippedHostCount,
      termiusDataDir: snapshot.bundle.meta?.termiusDataDir ?? null,
    });
    context.queueSync();
  }

  return {
    createdGroupCount,
    createdHostCount,
    createdSecretCount,
    skippedHostCount,
    warnings,
  };
}
